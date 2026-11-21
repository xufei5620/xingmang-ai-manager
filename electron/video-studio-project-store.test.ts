import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { VideoStudioProjectsWrite } from './ipc-contract'
import {
  createVideoStudioProjectStore,
  MAX_VIDEO_STUDIO_PROJECT_FILE_BYTES,
  MAX_VIDEO_STUDIO_PROJECT_SCOPES,
  MAX_VIDEO_STUDIO_PROJECTS,
  parseVideoStudioProjectsScope,
  parseVideoStudioProjectsWrite,
  videoStudioProjectsDirectoryName,
} from './video-studio-project-store'

const scope = 'xm-account:7'
const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-projects-'))
  temporaryRoots.push(directory)
  return path.join(directory, 'video-projects')
}

function write(patch: Partial<VideoStudioProjectsWrite> = {}): VideoStudioProjectsWrite {
  return { scope, put: [{ key: 'a', content: '{"project":"a"}' }], remove: [], ...patch }
}

function sorted<T extends { key: string }>(files: readonly T[]): T[] {
  return [...files].sort((left, right) => left.key.localeCompare(right.key))
}

// 测 200 条上限的用例把文件直接写进目录，只让要测的那一次保存经过 store：一次经 store 存满 200 条就是
// 200 次带路径检查和刷盘的原子写，Windows CI 上慢的时候会撞超时（同 ai-chat-history-store.test.ts）。
function seedProjects(root: string, keys: readonly string[]): string {
  const directory = path.join(root, videoStudioProjectsDirectoryName(scope))
  fs.mkdirSync(directory, { recursive: true })
  for (const key of keys) fs.writeFileSync(path.join(directory, `p-${key}.json`), `{"project":"${key}"}`, 'utf8')
  return directory
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('video studio project store', () => {
  it('reports nothing before anything was saved, without creating a directory', async () => {
    const root = temporaryRoot()
    const store = createVideoStudioProjectStore({ root })
    await expect(store.read(scope)).resolves.toEqual({ index: null, projects: [] })
    expect(fs.existsSync(root)).toBe(false)
  })

  it('keeps each account under a hashed directory and reads back exactly what was written', async () => {
    const root = temporaryRoot()
    const store = createVideoStudioProjectStore({ root })
    await store.write(write({ index: '{"version":1}', put: [{ key: 'a', content: '甲' }, { key: 'b', content: '乙' }] }))
    expect(fs.readdirSync(root)).toEqual([videoStudioProjectsDirectoryName(scope)])
    expect(videoStudioProjectsDirectoryName(scope)).toMatch(/^[0-9a-f]{32}$/)
    const snapshot = await store.read(scope)
    expect(snapshot.index).toBe('{"version":1}')
    expect(sorted(snapshot.projects)).toEqual([{ key: 'a', content: '甲' }, { key: 'b', content: '乙' }])
    await expect(store.read('xm-account:8')).resolves.toEqual({ index: null, projects: [] })
  })

  it('rewrites only the projects a save names and leaves the index alone when it carries none', async () => {
    const root = temporaryRoot()
    const store = createVideoStudioProjectStore({ root })
    await store.write(write({ index: '{"version":1}', put: [{ key: 'a', content: '甲' }, { key: 'b', content: '乙' }] }))
    await store.write(write({ put: [{ key: 'b', content: '乙二' }] }))
    const snapshot = await store.read(scope)
    expect(snapshot.index).toBe('{"version":1}')
    expect(sorted(snapshot.projects)).toEqual([{ key: 'a', content: '甲' }, { key: 'b', content: '乙二' }])
  })

  it('returns the projects without an index when the copy from the old storage never finished', async () => {
    const root = temporaryRoot()
    const store = createVideoStudioProjectStore({ root })
    await store.write(write({ put: [{ key: 'a', content: '甲' }] }))
    await expect(store.read(scope)).resolves.toEqual({ index: null, projects: [{ key: 'a', content: '甲' }] })
  })

  it('deletes only the projects a save names, and never a file it does not recognise', async () => {
    const root = temporaryRoot()
    const store = createVideoStudioProjectStore({ root })
    await store.write(write({ put: [{ key: 'a', content: '甲' }, { key: 'b', content: '乙' }, { key: 'c', content: '丙' }] }))
    const directory = path.join(root, videoStudioProjectsDirectoryName(scope))
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'kept', 'utf8')
    await store.write(write({ put: [], remove: ['b', 'missing'] }))
    expect(sorted((await store.read(scope)).projects).map((file) => file.key)).toEqual(['a', 'c'])
    expect(fs.readdirSync(directory).sort()).toEqual(['notes.txt', 'p-a.json', 'p-c.json'])
  })

  it('writes the index after the projects it vouches for', async () => {
    const root = temporaryRoot()
    const store = createVideoStudioProjectStore({ root })
    // A single oversized total makes the save fail before anything lands: no index without its projects.
    const limited = createVideoStudioProjectStore({ root, maxTotalBytes: 16 })
    await expect(limited.write(write({ index: '{"version":1}', put: [{ key: 'a', content: 'x'.repeat(64) }] }))).rejects.toThrow('安全上限')
    await expect(store.read(scope)).resolves.toEqual({ index: null, projects: [] })
  })

  it('runs the saves of one account strictly in order and lets a read see the last one', async () => {
    const store = createVideoStudioProjectStore({ root: temporaryRoot() })
    const saves = Array.from({ length: 6 }, (_, index) => store.write(write({ put: [{ key: 'a', content: `第 ${index} 版` }] })))
    const snapshot = await store.read(scope)
    await Promise.all(saves)
    expect(snapshot.projects).toEqual([{ key: 'a', content: '第 5 版' }])
  })

  it('settles idle() once every accepted save has landed, even after one failed', async () => {
    const root = temporaryRoot()
    const store = createVideoStudioProjectStore({ root, maxTotalBytes: 64 })
    const failed = store.write(write({ put: [{ key: 'a', content: 'x'.repeat(128) }] }))
    const landed = store.write(write({ put: [{ key: 'b', content: '乙' }] }))
    await store.idle()
    await expect(failed).rejects.toThrow('安全上限')
    await landed
    expect((await store.read(scope)).projects).toEqual([{ key: 'b', content: '乙' }])
  })

  it('refuses a save that would leave more projects than the bound, counting the ones already there', async () => {
    const root = temporaryRoot()
    seedProjects(root, Array.from({ length: MAX_VIDEO_STUDIO_PROJECTS }, (_, index) => `k${index}`))
    const store = createVideoStudioProjectStore({ root })
    await expect(store.write(write({ put: [{ key: 'one-more', content: '新' }] }))).rejects.toThrow(`视频草稿最多 ${MAX_VIDEO_STUDIO_PROJECTS} 条`)
    // Rewriting one that exists, or swapping one out for a new one, still fits.
    await store.write(write({ put: [{ key: 'k0', content: '改' }] }))
    await store.write(write({ put: [{ key: 'one-more', content: '新' }], remove: ['k1'] }))
    const keys = (await store.read(scope)).projects.map((file) => file.key)
    expect(keys).toHaveLength(MAX_VIDEO_STUDIO_PROJECTS)
    expect(keys).toContain('one-more')
    expect(keys).not.toContain('k1')
  })

  it('refuses a read that goes over the total bound and keeps the files', async () => {
    const root = temporaryRoot()
    const directory = seedProjects(root, ['a', 'b'])
    const store = createVideoStudioProjectStore({ root, maxTotalBytes: 8 })
    await expect(store.read(scope)).rejects.toThrow('原始文件已保留')
    expect(fs.readdirSync(directory).sort()).toEqual(['p-a.json', 'p-b.json'])
  })

  it('refuses a new account once the bound of accounts is reached', async () => {
    const root = temporaryRoot()
    fs.mkdirSync(root, { recursive: true })
    for (let index = 0; index < MAX_VIDEO_STUDIO_PROJECT_SCOPES; index += 1) fs.mkdirSync(path.join(root, `scope-${index}`))
    const store = createVideoStudioProjectStore({ root })
    await expect(store.write(write())).rejects.toThrow('账号过多')
  })

  it.runIf(process.platform !== 'win32')('never follows a project file that is a link, reading or writing', async () => {
    const root = temporaryRoot()
    const directory = seedProjects(root, [])
    const outside = path.join(path.dirname(root), 'outside.json')
    fs.writeFileSync(outside, 'secret', 'utf8')
    fs.symlinkSync(outside, path.join(directory, 'p-a.json'))
    const store = createVideoStudioProjectStore({ root })
    // A link is not a project file: the read leaves it out instead of handing back what it points at.
    await expect(store.read(scope)).resolves.toEqual({ index: null, projects: [] })
    await expect(store.write(write({ put: [{ key: 'a', content: '甲' }] }))).rejects.toThrow()
    await expect(store.write(write({ put: [], remove: ['a'] }))).rejects.toThrow()
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret')
    expect(fs.lstatSync(path.join(directory, 'p-a.json')).isSymbolicLink()).toBe(true)
  })
})

describe('video studio project requests', () => {
  it('accepts a plain save and drops nothing from it', () => {
    expect(parseVideoStudioProjectsWrite({ scope, index: '{}', put: [{ key: 'a-1_B', content: 'x' }], remove: ['c'] }))
      .toEqual({ scope, index: '{}', put: [{ key: 'a-1_B', content: 'x' }], remove: ['c'] })
    expect(parseVideoStudioProjectsWrite({ scope, put: [], remove: [] })).toEqual({ scope, put: [], remove: [] })
  })

  it('rejects a scope that is empty, too long or carries control characters', () => {
    for (const value of ['', 'a'.repeat(257), 'a\u0000b', 'a\nb', 7, null, undefined]) expect(() => parseVideoStudioProjectsScope(value)).toThrow('视频草稿归属无效')
  })

  it('rejects keys that could name anything but a project file', () => {
    for (const key of ['', '../a', 'a/b', 'a\\b', 'a.b', 'a b', 'x'.repeat(65), 7]) {
      expect(() => parseVideoStudioProjectsWrite({ scope, put: [{ key, content: 'x' }], remove: [] })).toThrow('视频草稿写入列表无效')
      expect(() => parseVideoStudioProjectsWrite({ scope, put: [], remove: [key] })).toThrow('视频草稿删除列表无效')
    }
  })

  it('rejects malformed, repeated, conflicting and oversized entries', () => {
    expect(() => parseVideoStudioProjectsWrite(null)).toThrow('视频草稿保存请求格式无效')
    expect(() => parseVideoStudioProjectsWrite({ scope, put: 'a', remove: [] })).toThrow('视频草稿写入列表无效')
    expect(() => parseVideoStudioProjectsWrite({ scope, put: [], remove: 'a' })).toThrow('视频草稿删除列表无效')
    expect(() => parseVideoStudioProjectsWrite({ scope, put: [{ key: 'a', content: 7 }], remove: [] })).toThrow('单条视频草稿格式无效')
    expect(() => parseVideoStudioProjectsWrite({ scope, put: [{ key: 'a', content: 'x' }, { key: 'a', content: 'y' }], remove: [] })).toThrow('视频草稿写入列表重复')
    expect(() => parseVideoStudioProjectsWrite({ scope, put: [], remove: ['a', 'a'] })).toThrow('视频草稿删除列表重复')
    expect(() => parseVideoStudioProjectsWrite({ scope, put: [{ key: 'a', content: 'x' }], remove: ['a'] })).toThrow('视频草稿写入和删除列表冲突')
    expect(() => parseVideoStudioProjectsWrite({ scope, index: 7, put: [], remove: [] })).toThrow('视频草稿索引格式无效')
    const oversized = 'x'.repeat(MAX_VIDEO_STUDIO_PROJECT_FILE_BYTES + 1)
    expect(() => parseVideoStudioProjectsWrite({ scope, put: [{ key: 'a', content: oversized }], remove: [] })).toThrow('无法保存')
    expect(() => parseVideoStudioProjectsWrite({ scope, put: Array.from({ length: MAX_VIDEO_STUDIO_PROJECTS + 1 }, (_, index) => ({ key: `k${index}`, content: 'x' })), remove: [] })).toThrow('视频草稿写入列表无效')
  })
})

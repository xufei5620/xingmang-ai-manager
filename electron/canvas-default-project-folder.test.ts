import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCanvasProjectFolderName,
  claimCanvasDefaultProjectFolder,
  describeCanvasDefaultProjectFolderFailure,
  releaseCanvasDefaultProjectFolder,
} from './canvas-default-project-folder'

// 新建画布项目默认放进「文档 › 星芒画布 › 项目名」：文件夹名能在三个系统上建出来，已经在的文件夹绝不复用。

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function defaultRoot(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-default-folder-'))
  roots.push(parent)
  return path.join(parent, '星芒画布')
}

describe('canvas default project folder', () => {
  it('turns a project name into a folder name every system accepts', () => {
    expect(buildCanvasProjectFolderName('春季海报')).toBe('春季海报')
    expect(buildCanvasProjectFolderName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
    expect(buildCanvasProjectFolderName('  ..隐藏的项目.. ')).toBe('隐藏的项目')
    expect(buildCanvasProjectFolderName('换行\n和\t制表')).toBe('换行 和 制表')
    expect(buildCanvasProjectFolderName('CON')).toBe('CON_')
    expect(buildCanvasProjectFolderName('lpt1.final')).toBe('lpt1.final_')
    expect(buildCanvasProjectFolderName('console')).toBe('console')
    expect(buildCanvasProjectFolderName('...')).toBe('未命名项目')
    expect(buildCanvasProjectFolderName('???')).toBe('未命名项目')
    const long = buildCanvasProjectFolderName('图'.repeat(40) + '😀'.repeat(40))
    expect(Array.from(long)).toHaveLength(64)
    expect(long.endsWith('😀')).toBe(true)
  })

  it('makes a new empty folder each time and never reuses one that is already there', () => {
    const root = defaultRoot()
    const first = claimCanvasDefaultProjectFolder(root, '海报')
    expect(first).toBe(path.join(root, '海报'))
    expect(fs.readdirSync(first)).toEqual([])
    expect(claimCanvasDefaultProjectFolder(root, '海报')).toBe(path.join(root, '海报 (2)'))
    // A folder of the user's own with that name, empty or not, is skipped too.
    fs.mkdirSync(path.join(root, '照片'))
    fs.writeFileSync(path.join(root, '照片', '我的.jpg'), 'mine')
    fs.writeFileSync(path.join(root, '照片 (2)'), 'a file')
    expect(claimCanvasDefaultProjectFolder(root, '照片')).toBe(path.join(root, '照片 (3)'))
    expect(fs.readFileSync(path.join(root, '照片', '我的.jpg'), 'utf8')).toBe('mine')
  })

  it('gives up after a hundred taken names', () => {
    const root = defaultRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(path.join(root, '海报'))
    for (let index = 2; index <= 100; index += 1) fs.mkdirSync(path.join(root, `海报 (${index})`))
    expect(() => claimCanvasDefaultProjectFolder(root, '海报')).toThrow('同名的项目太多')
  })

  it.runIf(process.platform !== 'win32')('refuses a default folder reached through a symbolic link', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-default-folder-link-'))
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-default-folder-target-'))
    roots.push(parent, target)
    fs.symlinkSync(target, path.join(parent, '星芒画布'))
    expect(() => claimCanvasDefaultProjectFolder(path.join(parent, '星芒画布'), '海报')).toThrow()
    expect(fs.readdirSync(target)).toEqual([])
  })

  it('removes only a claimed folder that stayed empty', () => {
    const root = defaultRoot()
    const empty = claimCanvasDefaultProjectFolder(root, '空的')
    fs.mkdirSync(path.join(empty, 'assets'))
    releaseCanvasDefaultProjectFolder(empty)
    expect(fs.existsSync(empty)).toBe(false)
    const used = claimCanvasDefaultProjectFolder(root, '用过的')
    fs.mkdirSync(path.join(used, 'assets'))
    fs.writeFileSync(path.join(used, 'assets', 'image.png'), 'png')
    releaseCanvasDefaultProjectFolder(used)
    expect(fs.readFileSync(path.join(used, 'assets', 'image.png'), 'utf8')).toBe('png')
    expect(() => releaseCanvasDefaultProjectFolder(path.join(root, 'gone'))).not.toThrow()
  })

  it('describes failures without the system message or the path', () => {
    function systemError(code: string): Error {
      return Object.assign(new Error(`${code}: operation failed, mkdir '/Users/someone/Documents/星芒画布'`), { code })
    }
    expect(describeCanvasDefaultProjectFolderFailure(systemError('EPERM'))).toBe('没有权限写入')
    expect(describeCanvasDefaultProjectFolderFailure(systemError('EACCES'))).toBe('没有权限写入')
    expect(describeCanvasDefaultProjectFolderFailure(systemError('ENOSPC'))).toBe('磁盘空间不够')
    expect(describeCanvasDefaultProjectFolderFailure(systemError('EROFS'))).toBe('磁盘是只读的')
    expect(describeCanvasDefaultProjectFolderFailure(systemError('ENOTDIR'))).toBe('文件夹建不出来')
    expect(describeCanvasDefaultProjectFolderFailure(new Error('「星芒画布」文件夹必须是普通目录'))).toBe('「星芒画布」文件夹必须是普通目录')
    expect(describeCanvasDefaultProjectFolderFailure('boom')).toBe('文件夹建不出来')
  })
})

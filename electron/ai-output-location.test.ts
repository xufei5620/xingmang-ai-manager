import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  aiOutputFolderName,
  migrateLegacyAiOutput,
  resolveAiOutputRoot,
  resolveLegacyAiOutputRoot,
} from './ai-output-location'
import type { StarterWorkspaceLocationContext } from './starter-workspace'
import { AiAssetMetadataStore } from './ai-asset-metadata-store'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ai-output-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

const assetA = 'a'.repeat(43)
const assetB = 'b'.repeat(43)
const assetC = 'c'.repeat(43)
const assetD = 'd'.repeat(43)

function writeMetadata(filePath: string, userId: number, items: unknown[]): void {
  writeFile(filePath, JSON.stringify({ version: 4, userId, items }))
}

function readMetadata(filePath: string): unknown[] {
  return (JSON.parse(fs.readFileSync(filePath, 'utf8')) as { items: unknown[] }).items
}

function exdev(): Promise<void> {
  const error = new Error('cross-device link not permitted') as NodeJS.ErrnoException
  error.code = 'EXDEV'
  return Promise.reject(error)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('resolveAiOutputRoot', () => {
  function windows(overrides: Partial<StarterWorkspaceLocationContext> = {}): StarterWorkspaceLocationContext {
    return { platform: 'win32', home: 'C:\\Users\\peaker', env: {}, directoryExists: () => true, ...overrides }
  }

  it('keeps the project output folder in development', () => {
    expect(resolveAiOutputRoot({ isPackaged: false, projectRoot: '/work/manager', documentsDirectory: '/Users/alex/Documents', location: windows() }))
      .toBe(path.join(path.resolve('/work/manager'), 'output'))
  })

  it('puts packaged output in the documents folder, never next to the executable', () => {
    expect(aiOutputFolderName).toMatch(/^[A-Za-z0-9-]+$/)
    expect(resolveAiOutputRoot({ isPackaged: true, documentsDirectory: 'C:\\Users\\peaker\\Documents', location: windows() }))
      .toBe('C:\\Users\\peaker\\Documents\\XingmangAI')
    expect(resolveAiOutputRoot({
      isPackaged: true,
      documentsDirectory: '/Users/alex/Documents',
      location: { platform: 'darwin', home: '/Users/alex', env: {}, directoryExists: (directory) => directory === '/Users/alex/Documents' },
    })).toBe('/Users/alex/Documents/XingmangAI')
  })

  it('falls back to the home folder when documents is synced or unknown', () => {
    expect(resolveAiOutputRoot({ isPackaged: true, documentsDirectory: 'C:\\Users\\peaker\\OneDrive\\Documents', location: windows() }))
      .toBe('C:\\Users\\peaker\\XingmangAI')
    expect(resolveAiOutputRoot({ isPackaged: true, documentsDirectory: null, location: windows() }))
      .toBe('C:\\Users\\peaker\\XingmangAI')
    expect(resolveAiOutputRoot({
      isPackaged: true,
      documentsDirectory: '/Users/alex/Documents',
      location: { platform: 'darwin', home: '/Users/alex', env: {}, directoryExists: () => true },
    })).toBe('/Users/alex/XingmangAI')
  })
})

describe('resolveLegacyAiOutputRoot', () => {
  it('names the folder next to the packaged executable and nothing in development', () => {
    expect(resolveLegacyAiOutputRoot({ isPackaged: false, execPath: '/work/electron' })).toBeNull()
    const execPath = '/Applications/Xingmang.app/Contents/MacOS/Xingmang'
    expect(resolveLegacyAiOutputRoot({ isPackaged: true, execPath }))
      .toBe(path.join(path.dirname(path.resolve(execPath)), 'output'))
  })
})

describe('migrateLegacyAiOutput', () => {
  it('moves every account folder with its layout intact and removes the emptied old folder', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'install', 'output')
    const to = path.join(root, 'Documents', 'XingmangAI')
    writeFile(path.join(from, 'user-7', '2026-09-01', 'xingmang-a.png'), 'a')
    writeFile(path.join(from, 'user-7', 'asset-metadata.json'), '{}')
    writeFile(path.join(from, 'user-9', '2026-09-02', 'xingmang-b.mp4'), 'b')

    const result = await migrateLegacyAiOutput(from, to)

    expect(result).toEqual({ moved: 2, kept: 0, failed: 0 })
    expect(listFiles(to)).toEqual([
      'user-7/2026-09-01/xingmang-a.png',
      'user-7/asset-metadata.json',
      'user-9/2026-09-02/xingmang-b.mp4',
    ])
    expect(fs.existsSync(from)).toBe(false)
  })

  it('leaves anything that is not an account folder where it was', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    writeFile(path.join(from, 'user-1', 'x.png'), 'x')
    writeFile(path.join(from, 'realms', 'api-account', 'user-1', 'y.png'), 'y')
    writeFile(path.join(from, 'notes.txt'), 'n')
    writeFile(path.join(from, 'user-abc', 'z.png'), 'z')

    await migrateLegacyAiOutput(from, to)

    expect(listFiles(to)).toEqual(['user-1/x.png'])
    expect(listFiles(from)).toEqual(['notes.txt', 'realms/api-account/user-1/y.png', 'user-abc/z.png'])
  })

  it('merges into a folder that already exists without replacing any file there', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    writeFile(path.join(from, 'user-1', '2026-09-01', 'old.png'), 'old')
    writeFile(path.join(from, 'user-1', '2026-09-23', 'new.png'), 'stale copy')
    writeFile(path.join(to, 'user-1', '2026-09-23', 'new.png'), 'new')

    const result = await migrateLegacyAiOutput(from, to)

    expect(result).toEqual({ moved: 1, kept: 1, failed: 0 })
    expect(fs.readFileSync(path.join(to, 'user-1', '2026-09-23', 'new.png'), 'utf8')).toBe('new')
    expect(fs.readFileSync(path.join(to, 'user-1', '2026-09-01', 'old.png'), 'utf8')).toBe('old')
    expect(listFiles(from)).toEqual(['user-1/2026-09-23/new.png'])
  })

  it('merges the metadata of both folders so favorites, tags, prompts and the recycle bin survive', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    writeFile(path.join(from, 'user-1', '2026-09-01', 'old.png'), 'old')
    writeMetadata(path.join(from, 'user-1', 'asset-metadata.json'), 1, [
      { assetId: assetA, favorite: true, tags: ['海报'], prompt: '一只猫', source: 'generated', updatedAt: '2026-09-01T08:00:00.000Z' },
      { assetId: assetB, deletedAt: '2026-09-02T08:00:00.000Z', updatedAt: '2026-09-02T08:00:00.000Z' },
      { assetId: assetC, displayName: '旧名字', favorite: true, updatedAt: '2026-09-01T08:00:00.000Z' },
    ])
    writeFile(path.join(to, 'user-1', '2026-09-23', 'new.png'), 'new')
    writeMetadata(path.join(to, 'user-1', 'asset-metadata.json'), 1, [
      { assetId: assetD, source: 'generated', prompt: '一条狗', updatedAt: '2026-09-23T08:00:00.000Z' },
      // Touched again after the upgrade: the newer toggle wins, the name is kept.
      { assetId: assetC, tags: ['新'], updatedAt: '2026-09-23T09:00:00.000Z' },
    ])

    const result = await migrateLegacyAiOutput(from, to)

    expect(result).toEqual({ moved: 2, kept: 0, failed: 0 })
    expect(listFiles(from)).toEqual([])
    const items = readMetadata(path.join(to, 'user-1', 'asset-metadata.json'))
    expect(items).toEqual([
      { assetId: assetD, source: 'generated', prompt: '一条狗', updatedAt: '2026-09-23T08:00:00.000Z' },
      { assetId: assetC, displayName: '旧名字', tags: ['新'], updatedAt: '2026-09-23T09:00:00.000Z' },
      { assetId: assetA, favorite: true, tags: ['海报'], source: 'generated', prompt: '一只猫', updatedAt: '2026-09-01T08:00:00.000Z' },
      { assetId: assetB, deletedAt: '2026-09-02T08:00:00.000Z', updatedAt: '2026-09-02T08:00:00.000Z' },
    ])
  })

  it('hands the metadata to the live store so writes made during the move are kept', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    writeFile(path.join(from, 'user-1', '2026-09-01', 'old.png'), 'old')
    writeMetadata(path.join(from, 'user-1', 'asset-metadata.json'), 1, [
      { assetId: assetA, favorite: true, updatedAt: '2026-09-01T08:00:00.000Z' },
    ])
    writeFile(path.join(to, 'user-1', 'placeholder.txt'), '')
    const store = new AiAssetMetadataStore({ outputRoot: to, now: () => new Date('2026-09-24T08:00:00.000Z') })
    // A new asset generated while the old folder is still being walked.
    const generating = store.setSource(1, assetD, 'generated', '一条狗')

    const result = await migrateLegacyAiOutput(from, to, { mergeMetadata: (userId, content) => store.mergeLegacy(userId, content) })
    await generating

    expect(result.failed).toBe(0)
    const all = await store.getAll(1)
    expect(all[assetA]).toMatchObject({ favorite: true })
    expect(all[assetD]).toMatchObject({ source: 'generated', prompt: '一条狗' })
  })

  it('keeps an old metadata file that cannot be read or merged', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    writeFile(path.join(from, 'user-1', 'asset-metadata.json'), 'not json')
    writeMetadata(path.join(to, 'user-1', 'asset-metadata.json'), 1, [
      { assetId: assetD, favorite: true, updatedAt: '2026-09-23T08:00:00.000Z' },
    ])

    const result = await migrateLegacyAiOutput(from, to)

    expect(result).toEqual({ moved: 0, kept: 0, failed: 1 })
    expect(fs.readFileSync(path.join(from, 'user-1', 'asset-metadata.json'), 'utf8')).toBe('not json')
    expect(readMetadata(path.join(to, 'user-1', 'asset-metadata.json'))).toEqual([
      { assetId: assetD, favorite: true, updatedAt: '2026-09-23T08:00:00.000Z' },
    ])
  })

  it('keeps the old metadata when the merged state cannot be written', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    writeMetadata(path.join(from, 'user-1', 'asset-metadata.json'), 1, [
      { assetId: assetA, favorite: true, updatedAt: '2026-09-01T08:00:00.000Z' },
    ])
    fs.mkdirSync(path.join(to, 'user-1'), { recursive: true })

    const result = await migrateLegacyAiOutput(from, to, { mergeMetadata: () => Promise.reject(new Error('disk full')) })

    expect(result).toEqual({ moved: 0, kept: 0, failed: 1 })
    expect(readMetadata(path.join(from, 'user-1', 'asset-metadata.json'))).toHaveLength(1)
  })

  it('copies across volumes, keeps the modification time and leaves no partial file', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    const source = path.join(from, 'user-1', '2026-09-01', 'xingmang-a.png')
    writeFile(source, 'bytes')
    const modified = new Date('2026-09-01T08:00:00Z')
    fs.utimesSync(source, modified, modified)

    const result = await migrateLegacyAiOutput(from, to, { rename: exdev })

    expect(result).toEqual({ moved: 1, kept: 0, failed: 0 })
    const target = path.join(to, 'user-1', '2026-09-01', 'xingmang-a.png')
    expect(fs.readFileSync(target, 'utf8')).toBe('bytes')
    expect(fs.statSync(target).mtime.getTime()).toBe(modified.getTime())
    expect(listFiles(to)).toEqual(['user-1/2026-09-01/xingmang-a.png'])
    expect(fs.existsSync(from)).toBe(false)
  })

  it('keeps the source when a move fails for any reason other than another volume', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    writeFile(path.join(from, 'user-1', 'a.png'), 'a')
    const locked = () => {
      const error = new Error('busy') as NodeJS.ErrnoException
      error.code = 'EBUSY'
      return Promise.reject(error)
    }

    const result = await migrateLegacyAiOutput(from, to, { rename: locked })

    expect(result).toEqual({ moved: 0, kept: 0, failed: 1 })
    expect(listFiles(from)).toEqual(['user-1/a.png'])
    expect(listFiles(to)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('never follows links planted in the old folder', async () => {
    const root = temporaryDirectory()
    const from = path.join(root, 'output')
    const to = path.join(root, 'XingmangAI')
    const outside = path.join(root, 'outside')
    writeFile(path.join(outside, 'secret.txt'), 'secret')
    writeFile(path.join(from, 'user-1', 'real.png'), 'real')
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(from, 'user-1', 'link.png'))
    fs.symlinkSync(outside, path.join(from, 'user-2'))

    const result = await migrateLegacyAiOutput(from, to, { rename: exdev })

    expect(listFiles(to)).toEqual(['user-1/real.png'])
    expect(result.kept).toBe(1)
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    expect(fs.lstatSync(path.join(from, 'user-2')).isSymbolicLink()).toBe(true)
  })

  it('does nothing when there is no old folder, when the roots overlap, or on a second run', async () => {
    const root = temporaryDirectory()
    const to = path.join(root, 'XingmangAI')
    const empty = { moved: 0, kept: 0, failed: 0 }
    expect(await migrateLegacyAiOutput(path.join(root, 'missing'), to)).toEqual(empty)

    writeFile(path.join(to, 'user-1', 'a.png'), 'a')
    expect(await migrateLegacyAiOutput(to, path.join(to, 'nested'))).toEqual(empty)
    expect(await migrateLegacyAiOutput(path.join(root), to)).toEqual(empty)

    const from = path.join(root, 'output')
    writeFile(path.join(from, 'user-2', 'b.png'), 'b')
    await migrateLegacyAiOutput(from, to)
    expect(await migrateLegacyAiOutput(from, to)).toEqual(empty)
    expect(listFiles(to)).toEqual(['user-1/a.png', 'user-2/b.png'])
  })
})

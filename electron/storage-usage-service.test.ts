import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigBackupSummary } from './backups'
import { createStorageUsageService, RETAINED_BACKUPS_AFTER_CLEANUP, type StorageUsageServiceDependencies } from './storage-usage-service'

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-storage-service-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writeFile(relative: string, size: number): void {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(size))
}

function summary(id: string, provider: ConfigBackupSummary['provider']): ConfigBackupSummary {
  return { id, provider, reason: provider ? 'pre-save' : null, createdAt: null, fileCount: 1, existingFileCount: 1, totalSize: 10, valid: provider !== null, error: null }
}

function fixture(overrides: Partial<StorageUsageServiceDependencies> = {}) {
  const log = vi.fn()
  const backups = {
    list: vi.fn(() => [summary('c1', 'codex'), summary('c2', 'claude'), summary('g1', 'gemini'), summary('bad', null)]),
    rootDirectory: () => path.join(root, 'backups'),
    removeAllButNewest: vi.fn(async () => ({ removed: 3, failed: 0, freedBytes: 12_000 })),
  }
  const downloads = {
    measure: vi.fn(async () => 300 * 1024 * 1024),
    clean: vi.fn(async () => ({ removed: 1, freedBytes: 80 * 1024 * 1024, failed: 2 })),
    installing: vi.fn(() => false),
  }
  const dependencies: StorageUsageServiceDependencies = {
    worksDirectory: () => path.join(root, 'XingmangAI'),
    thumbnailDirectories: () => [path.join(root, 'data', 'asset-thumbnails'), path.join(root, 'data', 'realms', 'api-account', 'asset-thumbnails')],
    chatHistoryDirectory: path.join(root, 'data', 'chat-history'),
    logDirectory: path.join(root, 'data', 'logs'),
    backups,
    downloads,
    log: { log },
    ...overrides,
  }
  return { service: createStorageUsageService(dependencies), log, backups, downloads }
}

const assetId = 'Z'.repeat(43)

describe('createStorageUsageService', () => {
  it('measures each row from the folder the main process chose', async () => {
    writeFile('XingmangAI/user-7/2026-11-11/a.mp4', 5000)
    writeFile(`data/asset-thumbnails/user-7/v2/${assetId}.png`, 300)
    writeFile(`data/realms/api-account/asset-thumbnails/user-3/v2/${assetId}.png`, 200)
    writeFile('data/chat-history/index.json', 40)
    writeFile('data/logs/runtime.jsonl', 60)
    writeFile('backups/20261111000000000-x/manifest.json', 70)
    const { service } = fixture()

    await expect(service.inspect('works')).resolves.toEqual({ bytes: 5000 })
    await expect(service.inspect('thumbnails')).resolves.toEqual({ bytes: 500 })
    await expect(service.inspect('chat-history')).resolves.toEqual({ bytes: 40 })
    await expect(service.inspect('logs')).resolves.toEqual({ bytes: 60 })
    // Only the backups the card above shows are counted: not the retired tool's, not the broken one.
    await expect(service.inspect('backups')).resolves.toEqual({ bytes: 70, backupCount: 2 })
    await expect(service.inspect('downloads')).resolves.toEqual({ bytes: 300 * 1024 * 1024, installing: false })
  })

  it('says a row could not be worked out, logging the error code but never the path', async () => {
    const failure = Object.assign(new Error(`EACCES: permission denied, scandir '${path.join(root, 'secret-user')}'`), { code: 'EACCES' })
    const { service, log } = fixture({ worksDirectory: () => { throw failure } })
    const downloads = { measure: vi.fn(async () => { throw failure }), clean: vi.fn(), installing: vi.fn(() => true) }
    const withDownloads = fixture({ downloads })

    await expect(service.inspect('works')).resolves.toEqual({ bytes: null })
    expect(log).toHaveBeenCalledWith('warn', 'storage', 'storage.measure.failed', expect.any(String), { part: 'works', code: 'EACCES' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-user')
    // The button still has to know an install is running even when the size is unknown.
    await expect(withDownloads.service.inspect('downloads')).resolves.toEqual({ bytes: null, installing: true })
  })

  it('cleans the thumbnails of both account sites', async () => {
    writeFile(`data/asset-thumbnails/user-7/v2/${assetId}.png`, 300)
    writeFile(`data/realms/api-account/asset-thumbnails/user-3/v2/${assetId}.jpg`, 200)
    writeFile('data/asset-thumbnails/user-7/v2/keep.txt', 1)
    const { service, log } = fixture()

    await expect(service.clean('thumbnails')).resolves.toEqual({ freedBytes: 500, kept: 0 })
    expect(fs.existsSync(path.join(root, 'data', 'asset-thumbnails', 'user-7', 'v2', 'keep.txt'))).toBe(true)
    expect(log).toHaveBeenCalledWith('info', 'storage', 'storage.cleaned', expect.any(String), { target: 'thumbnails', freedBytes: 500, kept: 0 })
  })

  it('keeps the newest ten of the backups the card shows', async () => {
    const { service, backups } = fixture()

    await expect(service.clean('backups')).resolves.toEqual({ freedBytes: 12_000, kept: 0 })

    expect(RETAINED_BACKUPS_AFTER_CLEANUP).toBe(10)
    const [keep, include] = backups.removeAllButNewest.mock.calls[0] as unknown as [number, (backup: ConfigBackupSummary) => boolean]
    expect(keep).toBe(10)
    expect([summary('a', 'codex'), summary('b', 'gemini'), summary('c', null)].map(include)).toEqual([true, false, false])
  })

  it('reports downloads it could not remove and logs only the numbers', async () => {
    const { service, log, downloads } = fixture()

    await expect(service.clean('downloads')).resolves.toEqual({ freedBytes: 80 * 1024 * 1024, kept: 2 })
    expect(downloads.clean).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('warn', 'storage', 'storage.cleaned', expect.any(String), { target: 'downloads', freedBytes: 80 * 1024 * 1024, kept: 2 })
  })
})

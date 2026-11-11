import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearThumbnailCache,
  createConcurrencyGate,
  isStorageCleanTarget,
  isStorageUsagePart,
  measureDirectoryBytes,
} from './storage-usage'

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-storage-usage-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writeFile(relative: string, size: number): string {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.alloc(size))
  return target
}

const assetId = 'A'.repeat(43)
const otherAssetId = 'b'.repeat(42) + '_'

describe('storage card rows and targets', () => {
  it('knows the six rows and only the three that can be cleaned', () => {
    for (const part of ['works', 'thumbnails', 'chat-history', 'logs', 'backups', 'downloads']) expect(isStorageUsagePart(part)).toBe(true)
    for (const value of ['../works', 'Works', '', null, 1, { part: 'works' }]) expect(isStorageUsagePart(value)).toBe(false)
    expect(['thumbnails', 'backups', 'downloads'].every(isStorageCleanTarget)).toBe(true)
    for (const value of ['works', 'chat-history', 'logs', 'thumbnails ', null]) expect(isStorageCleanTarget(value)).toBe(false)
  })
})

describe('measureDirectoryBytes', () => {
  it('adds up every regular file below the folder', async () => {
    writeFile('works/user-7/2026-11-11/a.png', 1000)
    writeFile('works/user-7/2026-11-11/b.mp4', 4000)
    writeFile('works/user-7/asset-metadata/shard-0.json', 24)
    await expect(measureDirectoryBytes(path.join(root, 'works'))).resolves.toBe(5024)
  })

  it('uses nothing for a folder that is not there yet', async () => {
    await expect(measureDirectoryBytes(path.join(root, 'missing'))).resolves.toBe(0)
  })

  it('stops counting after the entry budget instead of walking forever', async () => {
    for (let index = 0; index < 5; index += 1) writeFile(`many/file-${index}`, 100)
    const counted = await measureDirectoryBytes(path.join(root, 'many'), { maximumEntries: 3 })
    expect(counted).toBe(300)
  })

  // Real symbolic links need the privilege Windows does not grant by default; the walk itself is the same.
  it.runIf(process.platform !== 'win32')('neither follows nor counts a link inside the folder', async () => {
    writeFile('elsewhere/huge.bin', 50_000)
    writeFile('logs/runtime.jsonl', 10)
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'logs', 'linked-folder'), 'dir')
    fs.symlinkSync(path.join(root, 'elsewhere', 'huge.bin'), path.join(root, 'logs', 'linked-file'))
    await expect(measureDirectoryBytes(path.join(root, 'logs'))).resolves.toBe(10)
  })

  it.runIf(process.platform !== 'win32')('still measures a folder reached through a link, as a moved profile is', async () => {
    writeFile('real-chat/conversation.json', 77)
    fs.symlinkSync(path.join(root, 'real-chat'), path.join(root, 'chat-history'), 'dir')
    await expect(measureDirectoryBytes(path.join(root, 'chat-history'))).resolves.toBe(77)
  })
})

describe('createConcurrencyGate', () => {
  it('never lets more than the limit run at once, across every caller', async () => {
    const gate = createConcurrencyGate(2)
    let running = 0
    let peak = 0
    const task = () => gate.run(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 2))
      running -= 1
      return running
    })
    await Promise.all(Array.from({ length: 10 }, task))
    expect(peak).toBe(2)
    expect(() => createConcurrencyGate(0)).toThrow('并发上限无效')
  })

  it('frees its place when a task fails', async () => {
    const gate = createConcurrencyGate(1)
    await expect(gate.run(async () => { throw new Error('locked') })).rejects.toThrow('locked')
    await expect(gate.run(async () => 'next')).resolves.toBe('next')
  })
})

describe('clearThumbnailCache', () => {
  it('removes the thumbnails of every account and version and reports what that freed', async () => {
    writeFile(`asset-thumbnails/user-7/v2/${assetId}.png`, 3000)
    writeFile(`asset-thumbnails/user-7/v2/${otherAssetId}.jpg`, 2000)
    // A generation the pipeline no longer serves.
    writeFile(`asset-thumbnails/user-9/v1/${assetId}.png`, 500)

    const result = await clearThumbnailCache(path.join(root, 'asset-thumbnails'))

    expect(result).toEqual({ freedBytes: 5500, kept: 0 })
    // The emptied folders go too; the root itself stays for the store to write into.
    expect(fs.readdirSync(path.join(root, 'asset-thumbnails'))).toEqual([])
  })

  it('leaves anything it does not recognise exactly where it is', async () => {
    const unknownFile = writeFile('asset-thumbnails/user-7/v2/notes.txt', 10)
    const halfWritten = writeFile(`asset-thumbnails/user-7/v2/.${assetId}.png.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`, 10)
    const strayAccount = writeFile(`asset-thumbnails/someone/v2/${assetId}.png`, 10)
    const strayVersion = writeFile(`asset-thumbnails/user-7/latest/${assetId}.png`, 10)
    const rootFile = writeFile(`asset-thumbnails/${assetId}.png`, 10)
    writeFile(`asset-thumbnails/user-7/v2/${assetId}.png`, 100)

    const result = await clearThumbnailCache(path.join(root, 'asset-thumbnails'))

    expect(result).toEqual({ freedBytes: 100, kept: 0 })
    for (const kept of [unknownFile, halfWritten, strayAccount, strayVersion, rootFile]) expect(fs.existsSync(kept)).toBe(true)
  })

  it('keeps a thumbnail that has a second hard link, counting it as not removed', async () => {
    const outside = writeFile('my-picture.png', 400)
    const linked = path.join(root, 'asset-thumbnails', 'user-7', 'v2', `${assetId}.png`)
    fs.mkdirSync(path.dirname(linked), { recursive: true })
    fs.linkSync(outside, linked)

    const result = await clearThumbnailCache(path.join(root, 'asset-thumbnails'))

    expect(result).toEqual({ freedBytes: 0, kept: 1 })
    expect(fs.existsSync(linked)).toBe(true)
    expect(fs.readFileSync(outside).length).toBe(400)
  })

  it.runIf(process.platform !== 'win32')('does not walk into an account or version folder that is a link', async () => {
    const elsewhere = writeFile(`elsewhere/v2/${assetId}.png`, 900)
    const otherVersion = writeFile(`other/${assetId}.png`, 900)
    fs.mkdirSync(path.join(root, 'asset-thumbnails', 'user-8'), { recursive: true })
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'asset-thumbnails', 'user-7'), 'dir')
    fs.symlinkSync(path.join(root, 'other'), path.join(root, 'asset-thumbnails', 'user-8', 'v2'), 'dir')

    const result = await clearThumbnailCache(path.join(root, 'asset-thumbnails'))

    expect(result.freedBytes).toBe(0)
    expect(fs.existsSync(elsewhere)).toBe(true)
    expect(fs.existsSync(otherVersion)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('refuses a cache folder that is itself a link and deletes nothing', async () => {
    const elsewhere = writeFile(`elsewhere/user-7/v2/${assetId}.png`, 900)
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'asset-thumbnails'), 'dir')

    const result = await clearThumbnailCache(path.join(root, 'asset-thumbnails'))

    expect(result).toEqual({ freedBytes: 0, kept: 1 })
    expect(fs.existsSync(elsewhere)).toBe(true)
  })

  it('has nothing to do when there is no cache yet', async () => {
    await expect(clearThumbnailCache(path.join(root, 'asset-thumbnails'))).resolves.toEqual({ freedBytes: 0, kept: 0 })
  })
})

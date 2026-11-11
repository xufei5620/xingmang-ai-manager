import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiVideoAssetStore, inspectMp4Video, inspectMp4VideoMetadata } from './ai-video-asset-store'
import { setRelocatedFolderPolicy } from './relocated-folders'
import { classifyStorageFailure } from './startup-failure'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

/** Lets the atomic writer's temporary file take a few bytes, then fails the way a full disk does. */
function failTemporaryFileWrites(): void {
  const open = fs.promises.open
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (String(args[0]).endsWith('.tmp')) {
      handle.writeFile = async () => {
        await handle.write(Buffer.from('half'))
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
    }
    return handle
  })
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(header.length + payload.length, 0)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function mp4(): Buffer {
  const movieHeader = Buffer.alloc(20)
  movieHeader.writeUInt32BE(1_000, 12)
  movieHeader.writeUInt32BE(5_250, 16)
  const trackHeader = Buffer.alloc(84)
  trackHeader.writeUInt32BE(1_920 * 65_536, 76)
  trackHeader.writeUInt32BE(1_080 * 65_536, 80)
  const handler = Buffer.alloc(12)
  handler.write('vide', 8, 4, 'ascii')
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isom', 'binary')),
    box('moov', Buffer.concat([
      box('mvhd', movieHeader),
      box('trak', Buffer.concat([box('tkhd', trackHeader), box('mdia', box('hdlr', handler))])),
    ])),
    box('mdat', Buffer.from('video')),
  ])
}

describe('AiVideoAssetStore', () => {
  it('validates MP4 signatures instead of trusting Content-Type', () => {
    expect(inspectMp4Video(mp4(), 'video/mp4')).toEqual({ mimeType: 'video/mp4', extension: 'mp4' })
    expect(inspectMp4VideoMetadata(mp4())).toEqual({ width: 1920, height: 1080, durationSeconds: 5.25 })
    expect(inspectMp4VideoMetadata(Buffer.concat([
      Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4),
    ]))).toEqual({})
    expect(() => inspectMp4Video(Buffer.from('<html>bad</html>'), 'video/mp4')).toThrow('MP4')
    expect(() => inspectMp4Video(mp4(), 'text/html')).toThrow('MIME')
  })

  it('writes videos to the owned output tree and restores them after restart', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-assets-'))
    roots.push(outputRoot)
    const store = new AiVideoAssetStore({ outputRoot, now: () => new Date('2026-08-14T12:00:00.000Z') })
    const asset = await store.storeMp4(7, mp4(), { taskId: 'video_123' })
    expect(asset).toMatchObject({
      mimeType: 'video/mp4', taskId: 'video_123', width: 1920, height: 1080, durationSeconds: 5.25,
    })
    expect(asset.localUrl).toBe(`xingmang-asset://video/${asset.assetId}`)
    await expect(new AiVideoAssetStore({ outputRoot }).readOwned(7, asset.assetId)).resolves.toMatchObject({
      asset: expect.objectContaining({ mimeType: 'video/mp4', width: 1920, height: 1080, durationSeconds: 5.25 }),
      bytes: mp4(),
    })
    await expect(store.readOwned(8, asset.assetId)).rejects.toThrow('这段视频已经不在电脑上了')
    await expect(store.listOwned(7)).resolves.toEqual([
      expect.objectContaining({
        assetId: asset.assetId, mediaType: 'video', mimeType: 'video/mp4',
        width: 1920, height: 1080, durationSeconds: 5.25,
      }),
    ])
  })

  it('reads only the asked-for range of an owned video, under the same checks as a whole read', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-range-'))
    roots.push(outputRoot)
    const store = new AiVideoAssetStore({ outputRoot, now: () => new Date('2026-08-14T12:00:00.000Z') })
    const asset = await store.storeMp4(7, mp4(), { taskId: 'video_range' })
    const whole = mp4()
    const sizes: number[] = []
    await expect(store.readOwnedRange(7, asset.assetId, (total) => { sizes.push(total); return { start: 4, end: 11 } })).resolves.toEqual({
      asset: { mimeType: 'video/mp4' }, totalBytes: whole.length, bytes: whole.subarray(4, 12),
    })
    expect(sizes).toEqual([whole.length])
    // Selecting nothing (HEAD, an unsatisfiable range) reads nothing past the signature.
    await expect(store.readOwnedRange(7, asset.assetId, () => null)).resolves.toEqual({ asset: { mimeType: 'video/mp4' }, totalBytes: whole.length, bytes: Buffer.alloc(0) })
    await expect(store.readOwnedRange(8, asset.assetId, () => null)).rejects.toThrow('这段视频已经不在电脑上了')
    await expect(store.readOwnedRange(7, asset.assetId, (total) => ({ start: 0, end: total }))).rejects.toThrow('读取范围无效')

    // A second hard link, or bytes that are not an MP4 any more, are refused exactly like a whole read.
    const filePath = await store.resolveOwnedFilePath(7, asset.assetId)
    fs.linkSync(filePath, `${filePath}.link`)
    await expect(store.readOwnedRange(7, asset.assetId, () => null)).rejects.toThrow('无效或超过安全上限')
    fs.rmSync(`${filePath}.link`)
    fs.writeFileSync(filePath, Buffer.from('<html>not a video</html>'))
    await expect(store.readOwnedRange(7, asset.assetId, () => ({ start: 0, end: 3 }))).rejects.toThrow('MP4')
  })

  it('stores a film composed on this computer like a generated clip, without a task id', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-composed-'))
    roots.push(outputRoot)
    const store = new AiVideoAssetStore({ outputRoot })
    const first = await store.storeComposed(7, mp4())
    const second = await store.storeComposed(7, mp4())
    expect(first).toMatchObject({ mimeType: 'video/mp4', width: 1920, height: 1080, durationSeconds: 5.25 })
    expect(first).not.toHaveProperty('taskId')
    // Each export is its own work, even when two exports happen to be identical.
    expect(second.assetId).not.toBe(first.assetId)
    await expect(store.readOwned(7, first.assetId)).resolves.toMatchObject({ bytes: mp4() })
    await expect(store.resolveOwnedFilePath(7, first.assetId)).resolves.toMatch(new RegExp(`xingmang-${first.assetId}\\.mp4$`))
    await expect(store.storeComposed(7, Buffer.from('<html>not a film</html>'))).rejects.toThrow('仅支持 MP4')
    await expect(store.storeComposed(0, mp4())).rejects.toThrow('AI 视频账号标识格式错误')
    const small = new AiVideoAssetStore({ outputRoot, maximumVideoBytes: 16 })
    await expect(small.storeComposed(7, mp4())).rejects.toThrow('视频超过 512 MB 安全上限')
  })

  it('keeps the full-disk reason on a failed save so a paid clip can say it is charged (D38)', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-full-'))
    roots.push(outputRoot)
    const store = new AiVideoAssetStore({ outputRoot, now: () => new Date('2026-08-14T12:00:00.000Z') })

    failTemporaryFileWrites()
    const error = await store.storeMp4(7, mp4(), { taskId: 'video_full' }).then(() => null, (reason: unknown) => reason)

    expect((error as Error).message).toBe('作品没能存进保存位置，请稍后重试；一直不行请联系客服')
    expect(classifyStorageFailure(error)).toBe('disk-full')
    vi.restoreAllMocks()
    // Nothing half-written is left in the dated folder, and the clip lists as not stored.
    const accountRoot = path.join(outputRoot, 'user-7')
    for (const day of fs.readdirSync(accountRoot)) expect(fs.readdirSync(path.join(accountRoot, day))).toEqual([])
    await expect(store.listOwned(7)).resolves.toEqual([])
  })

  it('imports an MP4 file idempotently without changing the source', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-import-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-source-'))
    roots.push(outputRoot, sourceRoot)
    const sourcePath = path.join(sourceRoot, 'reference.mp4')
    fs.writeFileSync(sourcePath, mp4())
    const store = new AiVideoAssetStore({ outputRoot, now: () => new Date('2026-08-14T12:00:00.000Z') })

    const first = await store.storeLocalFile(7, sourcePath)
    const second = await store.storeLocalFile(7, sourcePath)
    const assetDirectory = path.join(outputRoot, 'user-7', '2026-08-14')
    fs.copyFileSync(
      path.join(assetDirectory, first.fileName),
      path.join(assetDirectory, `xingmang-${'L'.repeat(43)}.mp4`),
    )

    expect(second.assetId).toBe(first.assetId)
    expect(fs.readFileSync(sourcePath)).toEqual(mp4())
    await expect(store.listOwned(7)).resolves.toEqual([expect.objectContaining({ assetId: first.assetId, mediaType: 'video' })])
  })

  it('offers save and reveal commands without an invalid copy-video action', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-actions-'))
    roots.push(outputRoot)
    const target = path.join(outputRoot, 'saved.mp4')
    let menuItems: ReadonlyArray<{ id: string; label: string; run(): Promise<void> }> = []
    const revealInFolder = vi.fn()
    const store = new AiVideoAssetStore({
      outputRoot,
      nativeOperations: {
        selectSavePath: async () => target,
        revealInFolder,
        showContextMenu: (items) => { menuItems = items },
      },
    })
    const asset = await store.storeMp4(7, mp4(), { taskId: 'video_123' })
    await store.contextMenu(7, asset.assetId)
    expect(menuItems.map(({ id }) => id)).toEqual(['save-as', 'reveal-in-folder'])
    await menuItems[0].run()
    await menuItems[1].run()
    expect(fs.readFileSync(target)).toEqual(mp4())
    expect(revealInFolder).toHaveBeenCalledOnce()
  })

  it('leaves no half-written film behind when a save fails part-way', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-save-'))
    const saveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-save-target-'))
    roots.push(outputRoot, saveRoot)
    const target = path.join(saveRoot, 'saved.mp4')
    let currentUserId = 7
    const store = new AiVideoAssetStore({
      outputRoot,
      nativeOperations: { selectSavePath: async () => target, revealInFolder: vi.fn(), showContextMenu: vi.fn() },
    })
    const asset = await store.storeComposed(7, mp4())
    const authorize = () => { if (currentUserId !== 7) throw new Error('账号已切换，请重新另存') }

    failTemporaryFileWrites()
    await expect(store.saveAs(7, asset.assetId, authorize)).rejects.toThrow('视频另存失败，请检查目标目录写入权限')
    expect(fs.readdirSync(saveRoot)).toEqual([])

    vi.restoreAllMocks()
    currentUserId = 8
    await expect(store.saveAs(7, asset.assetId, authorize)).rejects.toThrow('账号已切换，请重新另存')
    expect(fs.readdirSync(saveRoot)).toEqual([])

    currentUserId = 7
    await expect(store.saveAs(7, asset.assetId, authorize)).resolves.toBe(true)
    expect(fs.readFileSync(target)).toEqual(mp4())
    expect(fs.readdirSync(saveRoot)).toEqual(['saved.mp4'])
  })

  it('offers the suggested file name in the save dialog, and the stored name without one', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-save-'))
    roots.push(outputRoot)
    const selectSavePath = vi.fn(async () => null)
    const store = new AiVideoAssetStore({ outputRoot, nativeOperations: { selectSavePath, revealInFolder: vi.fn(), showContextMenu: vi.fn() } })
    const asset = await store.storeComposed(7, mp4())
    await expect(store.saveAs(7, asset.assetId, undefined, '回家的猫.mp4')).resolves.toBe(false)
    expect(selectSavePath).toHaveBeenLastCalledWith('回家的猫.mp4')
    await expect(store.saveAs(7, asset.assetId)).resolves.toBe(false)
    expect(selectSavePath).toHaveBeenLastCalledWith(asset.fileName)
  })
})

describe('AiVideoAssetStore lookup by identifier', () => {
  function dayName(index: number): string {
    return new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10)
  }

  function accountWithDays(days: number): string {
    const outputRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-lookup-')))
    roots.push(outputRoot)
    for (let day = 0; day < days; day += 1) {
      const directory = path.join(outputRoot, 'user-7', dayName(day))
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, `xingmang-${String(day).padStart(2, '0').padEnd(43, 'x')}.mp4`), mp4())
    }
    return outputRoot
  }

  async function syncLstatsToMiss(outputRoot: string): Promise<number> {
    const lstatSync = vi.spyOn(fs, 'lstatSync')
    try {
      const store = new AiVideoAssetStore({ outputRoot })
      await expect(store.readOwned(7, 'M'.repeat(43))).rejects.toThrow(/^这段视频已经不在电脑上了，可能被移走或删掉了。$/)
      await expect(store.resolveOwnedFilePath(7, 'M'.repeat(43))).rejects.toThrow(/^这段视频已经不在电脑上了，可能被移走或删掉了。$/)
      return lstatSync.mock.calls.length
    } finally {
      lstatSync.mockRestore()
    }
  }

  it('misses at the same synchronous cost however many days the account has', async () => {
    expect(await syncLstatsToMiss(accountWithDays(40))).toBe(await syncLstatsToMiss(accountWithDays(1)))
  })

  it('reads a video removed outside the app as missing and reveals the located file', async () => {
    const outputRoot = accountWithDays(3)
    const revealInFolder = vi.fn()
    const store = new AiVideoAssetStore({
      outputRoot,
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      nativeOperations: { selectSavePath: async () => null, revealInFolder, showContextMenu: vi.fn() },
    })
    const kept = await store.storeComposed(7, mp4())
    const gone = await store.storeComposed(7, mp4())
    await store.revealInFolder(7, kept.assetId)
    expect(revealInFolder).toHaveBeenCalledWith(await store.resolveOwnedFilePath(7, kept.assetId))
    fs.rmSync(await store.resolveOwnedFilePath(7, gone.assetId))

    // Not a raw ENOENT carrying the file's path.
    await expect(store.readOwned(7, gone.assetId)).rejects.toThrow(/^这段视频已经不在电脑上了，可能被移走或删掉了。$/)
    await expect(store.resolveOwnedFilePath(7, gone.assetId)).rejects.toThrow(/^这段视频已经不在电脑上了，可能被移走或删掉了。$/)
  })

  it.runIf(process.platform !== 'win32')('still runs the full file checks on a remembered location', async () => {
    const outputRoot = accountWithDays(1)
    const store = new AiVideoAssetStore({ outputRoot })
    const asset = await store.storeComposed(7, mp4())
    const filePath = await store.resolveOwnedFilePath(7, asset.assetId)
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-outside-')), 'outside.mp4')
    roots.push(path.dirname(outside))
    fs.writeFileSync(outside, mp4())
    fs.rmSync(filePath)
    fs.symlinkSync(outside, filePath)

    await expect(store.readOwned(7, asset.assetId)).rejects.toThrow('不能经过符号链接或目录联接')
    await expect(store.resolveOwnedFilePath(7, asset.assetId)).rejects.toThrow('单链接普通文件')
  })
})

/** A profile whose 文档 was moved to "another disk" and left a junction behind (「C 盘搬家」). */
function relocatedDocuments(root: string): { home: string; documents: string } {
  const home = path.join(root, 'Users', 'alice')
  const moved = path.join(root, 'D', 'Documents')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(moved, { recursive: true })
  const documents = path.join(home, 'Documents')
  // Junctions need no privilege on Windows; POSIX ignores the type argument.
  fs.symlinkSync(moved, documents, 'junction')
  return { home, documents }
}

describe('AiVideoAssetStore on a relocated documents folder', () => {
  afterEach(() => setRelocatedFolderPolicy(null))

  it('stores, reads back and removes videos after 文档 was moved to another disk', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-relocated-')))
    roots.push(root)
    const { home, documents } = relocatedDocuments(root)
    setRelocatedFolderPolicy({ homeDirectories: [home], acceptsTarget: () => true })
    const outputRoot = path.join(documents, 'XingmangAI')
    const asset = await new AiVideoAssetStore({ outputRoot, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .storeMp4(7, mp4(), { taskId: 'video_123' })
    const restarted = new AiVideoAssetStore({ outputRoot })

    await expect(restarted.readOwned(7, asset.assetId)).resolves.toMatchObject({ bytes: mp4() })
    await expect(restarted.resolveOwnedFilePath(7, asset.assetId)).resolves.toContain(`xingmang-${asset.assetId}.mp4`)
    await restarted.removeOwned(7, asset.assetId)
    await expect(restarted.readOwned(7, asset.assetId)).rejects.toThrow('这段视频已经不在电脑上了')
  })

  it('keeps refusing the relocated folder while no policy accepts it', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-relocated-')))
    roots.push(root)
    const { documents } = relocatedDocuments(root)

    await expect(new AiVideoAssetStore({ outputRoot: path.join(documents, 'XingmangAI') }).storeMp4(7, mp4(), { taskId: 'video_123' }))
      .rejects.toThrow()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiVideoAssetStore, inspectMp4Video, inspectMp4VideoMetadata } from './ai-video-asset-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

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
    const store = new AiVideoAssetStore({ outputRoot, now: () => new Date('2026-08-14T00:00:00.000Z') })
    const asset = await store.storeMp4(7, mp4(), { taskId: 'video_123' })
    expect(asset).toMatchObject({
      mimeType: 'video/mp4', taskId: 'video_123', width: 1920, height: 1080, durationSeconds: 5.25,
    })
    expect(asset.localUrl).toBe(`xingmang-asset://video/${asset.assetId}`)
    await expect(new AiVideoAssetStore({ outputRoot }).readOwned(7, asset.assetId)).resolves.toMatchObject({
      asset: expect.objectContaining({ mimeType: 'video/mp4', width: 1920, height: 1080, durationSeconds: 5.25 }),
      bytes: mp4(),
    })
    await expect(store.readOwned(8, asset.assetId)).rejects.toThrow('不存在或无权访问')
    await expect(store.listOwned(7)).resolves.toEqual([
      expect.objectContaining({
        assetId: asset.assetId, mediaType: 'video', mimeType: 'video/mp4',
        width: 1920, height: 1080, durationSeconds: 5.25,
      }),
    ])
  })

  it('imports an MP4 file idempotently without changing the source', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-import-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-video-source-'))
    roots.push(outputRoot, sourceRoot)
    const sourcePath = path.join(sourceRoot, 'reference.mp4')
    fs.writeFileSync(sourcePath, mp4())
    const store = new AiVideoAssetStore({ outputRoot, now: () => new Date('2026-08-14T00:00:00.000Z') })

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
})

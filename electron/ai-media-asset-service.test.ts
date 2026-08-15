import { describe, expect, it, vi } from 'vitest'
import { createAiMediaAssetService } from './ai-media-asset-service'

describe('createAiMediaAssetService', () => {
  it('combines images, videos and audio while preserving media filters and ownership resolution', async () => {
    const images = {
      listOwned: vi.fn(async () => [{
        assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
        mimeType: 'image/png' as const, fileName: 'image.png', createdAt: '2026-08-14T00:00:00.000Z',
      }]),
      readOwned: vi.fn(async () => { throw new Error('missing image') }),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const videos = {
      listOwned: vi.fn(async () => [{
        assetId: 'b'.repeat(43), localUrl: `xingmang-asset://video/${'b'.repeat(43)}`,
        mimeType: 'video/mp4' as const, fileName: 'video.mp4', createdAt: '2026-08-14T00:01:00.000Z',
        mediaType: 'video' as const, thumbnailUrl: `xingmang-asset://video/${'b'.repeat(43)}`,
        width: 1920, height: 1080, durationSeconds: 5.25,
      }]),
      readOwned: vi.fn(async () => ({ asset: { assetId: 'b'.repeat(43) }, bytes: Buffer.from('video') })),
      saveAs: vi.fn(async () => true), contextMenu: vi.fn(async () => undefined),
    }
    const audios = {
      listOwned: vi.fn(async () => [{
        assetId: 'c'.repeat(43), localUrl: `xingmang-asset://audio/${'c'.repeat(43)}`,
        mimeType: 'audio/wav' as const, fileName: 'audio.wav', createdAt: '2026-08-14T00:02:00.000Z',
        mediaType: 'audio' as const, thumbnailUrl: `xingmang-asset://audio/${'c'.repeat(43)}`,
        durationSeconds: 1,
      }]),
      readOwned: vi.fn(async () => ({ asset: { assetId: 'c'.repeat(43) }, bytes: Buffer.from('audio') })),
      saveAs: vi.fn(async () => true), contextMenu: vi.fn(async () => undefined),
    }
    const metadata = { getMany: vi.fn(async () => ({})), rename: vi.fn() }
    const service = createAiMediaAssetService({ images: images as never, videos: videos as never, audios: audios as never, metadata })
    const page = await service.listOwnedPage(7)
    expect(page.items.map(({ mediaType }) => mediaType)).toEqual(['audio', 'video', 'image'])
    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ mediaType: 'video', width: 1920, height: 1080, durationSeconds: 5.25 }),
      expect.objectContaining({ mediaType: 'audio', durationSeconds: 1 }),
    ]))
    await expect(service.listOwnedPage(7, { mediaType: 'video' })).resolves.toMatchObject({ total: 1 })
    await expect(service.listOwnedPage(7, { mediaType: 'audio' })).resolves.toMatchObject({ total: 1 })
    await expect(service.readOwned(7, 'b'.repeat(43))).resolves.toMatchObject({ bytes: Buffer.from('video') })
    await expect(service.readOwned(7, 'c'.repeat(43), 'audio')).resolves.toMatchObject({ bytes: Buffer.from('audio') })
  })

  it('merges logical names, searches them and renames without changing physical asset identity', async () => {
    const id = 'a'.repeat(43)
    const physical = {
      assetId: id,
      localUrl: `xingmang-asset://image/${id}`,
      mimeType: 'image/png' as const,
      fileName: `xingmang-${id}.png`,
      createdAt: '2026-08-14T00:00:00.000Z',
    }
    const images = {
      listOwned: vi.fn(async () => [physical]),
      readOwned: vi.fn(async () => ({ asset: physical, bytes: Buffer.from('image') })),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const videos = {
      listOwned: vi.fn(async () => []),
      readOwned: vi.fn(async () => { throw new Error('missing video') }),
      saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const metadata = {
      getMany: vi.fn(async () => ({ [id]: { displayName: '夏季新品主视觉', updatedAt: '2026-08-14T01:00:00.000Z' } })),
      rename: vi.fn(async (_userId: number, assetId: string, displayName: string) => ({
        assetId, displayName, updatedAt: '2026-08-14T02:00:00.000Z',
      })),
    }
    const service = createAiMediaAssetService({ images: images as never, videos: videos as never, metadata })

    await expect(service.listOwnedPage(7, { search: '新品' })).resolves.toMatchObject({
      total: 1,
      items: [{
        assetId: id,
        displayName: '夏季新品主视觉',
        fileName: physical.fileName,
        localUrl: physical.localUrl,
      }],
    })
    await expect(service.rename(7, id, '秋季主视觉')).resolves.toEqual({ assetId: id, displayName: '秋季主视觉' })
    expect(images.readOwned).toHaveBeenCalledWith(7, id)
    expect(metadata.rename).toHaveBeenCalledWith(7, id, '秋季主视觉')
    expect(physical).toMatchObject({ assetId: id, fileName: `xingmang-${id}.png`, localUrl: `xingmang-asset://image/${id}` })
  })

  it('falls back to the physical file name and refuses to rename a missing asset', async () => {
    const id = 'a'.repeat(43)
    const images = {
      listOwned: vi.fn(async () => [{
        assetId: id, localUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png' as const,
        fileName: 'physical.png', createdAt: '2026-08-14T00:00:00.000Z',
      }]),
      readOwned: vi.fn(async () => { throw new Error('missing image') }),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const videos = {
      listOwned: vi.fn(async () => []),
      readOwned: vi.fn(async () => { throw new Error('missing video') }),
      saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const metadata = { getMany: vi.fn(async () => ({})), rename: vi.fn() }
    const service = createAiMediaAssetService({ images: images as never, videos: videos as never, metadata })

    await expect(service.listOwnedPage(7)).resolves.toMatchObject({ items: [{ displayName: 'physical.png' }] })
    await expect(service.rename(7, id, '不存在')).rejects.toThrow('不存在或无权访问')
    expect(metadata.rename).not.toHaveBeenCalled()
  })
})

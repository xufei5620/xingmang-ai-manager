import { describe, expect, it, vi } from 'vitest'
import { createAiMediaAssetService } from './ai-media-asset-service'

function metadataStore(overrides: Record<string, unknown> = {}) {
  return {
    getAll: vi.fn(async () => ({})),
    rename: vi.fn(),
    updatePreferences: vi.fn(),
    markUsed: vi.fn(),
    setSource: vi.fn(),
    softDelete: vi.fn(),
    restore: vi.fn(),
    forget: vi.fn(),
    ...overrides,
  }
}

const trashItem = vi.fn(async () => undefined)

function indexEntry(assetId: string, fileName: string, createdAt: string, mediaType: 'image' | 'video' | 'audio') {
  return { assetId, fileName, extension: fileName.split('.').pop() as string, createdAt, mediaType }
}

function emptyVideos() {
  return {
    listOwnedIndex: vi.fn(async () => []),
    readOwned: vi.fn(async () => { throw new Error('missing video') }),
    saveAs: vi.fn(), contextMenu: vi.fn(),
  }
}

describe('createAiMediaAssetService', () => {
  it('combines images, videos and audio while preserving media filters and ownership resolution', async () => {
    const imageId = 'a'.repeat(43)
    const videoId = 'b'.repeat(43)
    const audioId = 'c'.repeat(43)
    const images = {
      listOwnedIndex: vi.fn(async () => [indexEntry(imageId, 'image.png', '2026-08-14T00:00:00.000Z', 'image' as const)]),
      readOwned: vi.fn(async (_userId: number, assetId: string) => {
        // The real store resolves by identifier, so the double must too:
        // `readOwned` without a kind hint probes images before video and audio.
        if (assetId !== imageId) throw new Error('missing image')
        return {
          asset: { assetId: imageId, localUrl: `xingmang-asset://image/${imageId}`, mimeType: 'image/png' as const, fileName: 'image.png' },
          bytes: Buffer.from('image'),
        }
      }),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const videos = {
      listOwnedIndex: vi.fn(async () => [indexEntry(videoId, 'video.mp4', '2026-08-14T00:01:00.000Z', 'video' as const)]),
      readOwned: vi.fn(async () => ({
        asset: {
          assetId: videoId, localUrl: `xingmang-asset://video/${videoId}`, mimeType: 'video/mp4' as const,
          fileName: 'video.mp4', width: 1920, height: 1080, durationSeconds: 5.25,
        },
        bytes: Buffer.from('video'),
      })),
      saveAs: vi.fn(async () => true), contextMenu: vi.fn(async () => undefined),
    }
    const audios = {
      listOwnedIndex: vi.fn(async () => [indexEntry(audioId, 'audio.wav', '2026-08-14T00:02:00.000Z', 'audio' as const)]),
      readOwned: vi.fn(async () => ({
        asset: {
          assetId: audioId, localUrl: `xingmang-asset://audio/${audioId}`, mimeType: 'audio/wav' as const,
          fileName: 'audio.wav', durationSeconds: 1,
        },
        bytes: Buffer.from('audio'),
      })),
      saveAs: vi.fn(async () => true), contextMenu: vi.fn(async () => undefined),
    }
    const metadata = metadataStore()
    const service = createAiMediaAssetService({ images: images as never, videos: videos as never, audios: audios as never, metadata, trashItem })
    const page = await service.listOwnedPage(7)
    expect(page.items.map(({ mediaType }) => mediaType)).toEqual(['audio', 'video', 'image'])
    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ mediaType: 'video', width: 1920, height: 1080, durationSeconds: 5.25 }),
      expect.objectContaining({ mediaType: 'audio', durationSeconds: 1 }),
    ]))
    expect(page.items.map(({ createdAt }) => createdAt)).toEqual([
      '2026-08-14T00:02:00.000Z', '2026-08-14T00:01:00.000Z', '2026-08-14T00:00:00.000Z',
    ])
    await expect(service.listOwnedPage(7, { mediaType: 'video' })).resolves.toMatchObject({ total: 1 })
    await expect(service.listOwnedPage(7, { mediaType: 'audio' })).resolves.toMatchObject({ total: 1 })
    await expect(service.readOwned(7, videoId)).resolves.toMatchObject({ bytes: Buffer.from('video') })
    await expect(service.readOwned(7, audioId, 'audio')).resolves.toMatchObject({ bytes: Buffer.from('audio') })
  })

  it('searches, sorts and counts across the whole library instead of an arbitrary prefix', async () => {
    // The library used to be truncated to 500 fully decoded assets before any
    // filter ran, so a match past that point was invisible and `total` reported
    // the size of the truncated slice as if it were the real count.
    const total = 640
    const entries = Array.from({ length: total }, (_, position) => {
      const assetId = `${String(position).padStart(3, '0')}${'z'.repeat(40)}`
      const minute = String(position % 60).padStart(2, '0')
      const hour = String(Math.floor(position / 60)).padStart(2, '0')
      return indexEntry(assetId, `asset-${position}.png`, `2026-08-14T${hour}:${minute}:00.000Z`, 'image' as const)
    })
    const needle = entries[600]
    const images = {
      listOwnedIndex: vi.fn(async () => entries),
      readOwned: vi.fn(async (_userId: number, assetId: string) => ({
        asset: { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' as const, fileName: `xingmang-${assetId}.png` },
        bytes: Buffer.from('image'),
      })),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const metadata = metadataStore({
      getAll: vi.fn(async () => ({ [needle.assetId]: { displayName: '罕见的锦鲤海报', updatedAt: '2026-08-14T02:00:00.000Z' } })),
    })
    const service = createAiMediaAssetService({ images: images as never, videos: emptyVideos() as never, metadata, trashItem })

    await expect(service.listOwnedPage(7)).resolves.toMatchObject({ total })
    await expect(service.listOwnedPage(7, { search: '锦鲤' })).resolves.toMatchObject({
      total: 1,
      hasMore: false,
      items: [{ assetId: needle.assetId, displayName: '罕见的锦鲤海报' }],
    })
    // Only the requested page is decoded; indexing itself reads no media.
    expect(images.readOwned).toHaveBeenCalledTimes(24 + 1)

    const deepPage = await service.listOwnedPage(7, { offset: 600, limit: 24, sort: 'created-asc' })
    expect(deepPage).toMatchObject({ total, offset: 600, hasMore: true })
    expect(deepPage.items).toHaveLength(24)
    expect(deepPage.items[0]?.assetId).toBe(entries[600]?.assetId)
  })

  it('merges logical names, searches them and renames without changing physical asset identity', async () => {
    const id = 'a'.repeat(43)
    const physical = {
      assetId: id,
      localUrl: `xingmang-asset://image/${id}`,
      mimeType: 'image/png' as const,
      fileName: `xingmang-${id}.png`,
    }
    const images = {
      listOwnedIndex: vi.fn(async () => [indexEntry(id, physical.fileName, '2026-08-14T00:00:00.000Z', 'image' as const)]),
      readOwned: vi.fn(async () => ({ asset: physical, bytes: Buffer.from('image') })),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const metadata = metadataStore({
      getAll: vi.fn(async () => ({ [id]: { displayName: '夏季新品主视觉', updatedAt: '2026-08-14T01:00:00.000Z' } })),
      rename: vi.fn(async (_userId: number, assetId: string, displayName: string) => ({
        assetId, displayName, updatedAt: '2026-08-14T02:00:00.000Z',
      })),
    })
    const service = createAiMediaAssetService({ images: images as never, videos: emptyVideos() as never, metadata, trashItem })

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

  it('falls back to the physical file name, drops unreadable files and refuses to rename a missing asset', async () => {
    const id = 'a'.repeat(43)
    const images = {
      listOwnedIndex: vi.fn(async () => [indexEntry(id, 'physical.png', '2026-08-14T00:00:00.000Z', 'image' as const)]),
      readOwned: vi.fn(async () => ({
        asset: { assetId: id, localUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png' as const, fileName: 'physical.png' },
        bytes: Buffer.from('image'),
      })),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const metadata = metadataStore()
    const service = createAiMediaAssetService({ images: images as never, videos: emptyVideos() as never, metadata, trashItem })

    await expect(service.listOwnedPage(7)).resolves.toMatchObject({ items: [{ displayName: 'physical.png' }] })

    // A file removed between indexing and hydration leaves the page rather than
    // failing it, but it is still counted by the index that produced the page.
    images.readOwned.mockRejectedValueOnce(new Error('missing image'))
    await expect(service.listOwnedPage(7)).resolves.toMatchObject({ total: 1, items: [] })

    images.readOwned.mockRejectedValue(new Error('missing image'))
    await expect(service.rename(7, id, '不存在')).rejects.toThrow('不存在或无权访问')
    expect(metadata.rename).not.toHaveBeenCalled()
  })

  it('filters and stably sorts organization metadata while validating ownership before mutations', async () => {
    const firstId = 'a'.repeat(43)
    const secondId = 'b'.repeat(43)
    const physical = (assetId: string) => ({
      assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' as const,
      fileName: `${assetId}.png`,
    })
    const images = {
      listOwnedIndex: vi.fn(async () => [
        indexEntry(firstId, `${firstId}.png`, '2026-08-14T00:00:00.000Z', 'image' as const),
        indexEntry(secondId, `${secondId}.png`, '2026-08-14T00:00:00.000Z', 'image' as const),
      ]),
      readOwned: vi.fn(async (_userId: number, assetId: string) => ({ asset: physical(assetId), bytes: Buffer.from('image') })),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const metadata = metadataStore({
      getAll: vi.fn(async () => ({
        [firstId]: { displayName: '同名', favorite: true, tags: ['角色'], source: 'imported', lastUsedAt: '2026-08-14T02:00:00.000Z', updatedAt: '2026-08-14T02:00:00.000Z' },
        [secondId]: { displayName: '同名', favorite: true, tags: ['场景'], source: 'generated', lastUsedAt: '2026-08-14T01:00:00.000Z', updatedAt: '2026-08-14T01:00:00.000Z' },
      })),
      updatePreferences: vi.fn(async (_userId: number, assetId: string, input: { favorite?: boolean; tags?: string[] }) => ({ assetId, ...input, updatedAt: '2026-08-14T03:00:00.000Z' })),
      markUsed: vi.fn(async (_userId: number, assetId: string) => ({ assetId, lastUsedAt: '2026-08-14T03:00:00.000Z', updatedAt: '2026-08-14T03:00:00.000Z' })),
      setSource: vi.fn(async (_userId: number, assetId: string, source: string) => ({ assetId, source, updatedAt: '2026-08-14T03:00:00.000Z' })),
    })
    const service = createAiMediaAssetService({
      images: images as never,
      videos: emptyVideos() as never,
      metadata: metadata as never,
      trashItem,
    })

    await expect(service.listOwnedPage(7, { view: 'favorites', source: 'imported', tag: '角色' })).resolves.toMatchObject({
      total: 1, items: [{ assetId: firstId, favorite: true, tags: ['角色'], source: 'imported' }],
    })
    await expect(service.listOwnedPage(7, { view: 'recent' })).resolves.toMatchObject({
      items: [{ assetId: firstId }, { assetId: secondId }],
    })
    await expect(service.listOwnedPage(7, { sort: 'name-asc' })).resolves.toMatchObject({
      items: [{ assetId: secondId }, { assetId: firstId }],
    })
    await expect(service.updateMetadata(7, firstId, { favorite: false, tags: [] })).resolves.toEqual({ assetId: firstId, favorite: false, tags: [] })
    await expect(service.markUsed(7, firstId)).resolves.toEqual({ assetId: firstId, lastUsedAt: '2026-08-14T03:00:00.000Z' })
    await expect(service.setSource(7, firstId, 'generated')).resolves.toEqual({ assetId: firstId, source: 'generated' })
    expect(images.readOwned).toHaveBeenCalledBefore(metadata.updatePreferences)
    expect(images.readOwned).toHaveBeenCalledBefore(metadata.markUsed)
    expect(images.readOwned).toHaveBeenCalledBefore(metadata.setSource)

    images.readOwned.mockRejectedValueOnce(new Error('missing image'))
    await expect(service.updateMetadata(7, firstId, { favorite: true })).rejects.toThrow('不存在或无权访问')
    expect(metadata.updatePreferences).toHaveBeenCalledTimes(1)
  })

  it('counts tag facets over the whole library rather than the current page', async () => {
    // The tray derived its tag chips from page.items, so the filter panel
    // changed every time the user turned a page.
    const ids = ['a', 'b', 'c'].map((letter) => letter.repeat(43))
    const images = {
      listOwnedIndex: vi.fn(async () => ids.map((assetId, position) => (
        indexEntry(assetId, `${assetId}.png`, `2026-08-14T00:0${position}:00.000Z`, 'image' as const)
      ))),
      readOwned: vi.fn(async (_userId: number, assetId: string) => ({
        asset: { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' as const, fileName: `${assetId}.png` },
        bytes: Buffer.from('image'),
      })),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const metadata = metadataStore({
      getAll: vi.fn(async () => ({
        [ids[0] as string]: { tags: ['角色', '海报'], updatedAt: '2026-08-14T02:00:00.000Z' },
        [ids[1] as string]: { tags: ['角色'], updatedAt: '2026-08-14T02:00:00.000Z' },
        [ids[2] as string]: { tags: ['场景'], updatedAt: '2026-08-14T02:00:00.000Z' },
      })),
    })
    const service = createAiMediaAssetService({ images: images as never, videos: emptyVideos() as never, metadata, trashItem })

    const firstPage = await service.listOwnedPage(7, { limit: 1 })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.facets.tags).toEqual([
      { tag: '角色', count: 2 }, { tag: '场景', count: 1 }, { tag: '海报', count: 1 },
    ])
    const secondPage = await service.listOwnedPage(7, { limit: 1, offset: 1 })
    expect(secondPage.facets.tags).toEqual(firstPage.facets.tags)

    // Selecting a tag must not erase its siblings from the panel.
    const filtered = await service.listOwnedPage(7, { tag: '角色' })
    expect(filtered.total).toBe(2)
    expect(filtered.facets.tags).toEqual(firstPage.facets.tags)

    // Other filters do narrow the facet counts, so the panel stays truthful.
    const searched = await service.listOwnedPage(7, { search: ids[2] as string })
    expect(searched.facets.tags).toEqual([{ tag: '场景', count: 1 }])
  })

  it('rejects paging positions beyond the indexed ceiling', async () => {
    const service = createAiMediaAssetService({
      images: { listOwnedIndex: vi.fn(async () => []), readOwned: vi.fn(), copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn() } as never,
      videos: emptyVideos() as never,
      metadata: metadataStore() as never,
      trashItem,
    })
    await expect(service.listOwnedPage(7, { offset: 20_001 })).rejects.toThrow('AI 素材分页位置无效')
    await expect(service.listOwnedPage(7, { offset: 20_000 })).resolves.toMatchObject({ total: 0 })
  })

  it('moves assets to the recycle bin, restores them and only purges unreferenced files', async () => {
    const assetId = 'd'.repeat(43)
    const entry = indexEntry(assetId, 'image.png', '2026-08-14T00:00:00.000Z', 'image' as const)
    const images = {
      listOwnedIndex: vi.fn(async () => [entry]),
      readOwned: vi.fn(async (_userId: number, id: string) => ({
        asset: { assetId: id, localUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png' as const, fileName: 'image.png' },
        bytes: Buffer.from('image'),
      })),
      resolveOwnedFilePath: vi.fn(async () => 'C:/store/image.png'),
      forgetOwned: vi.fn(),
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(),
    }
    const metadata = metadataStore({
      getAll: vi.fn(async () => ({})),
      softDelete: vi.fn(async (_userId: number, id: string) => ({ assetId: id, deletedAt: '2026-08-14T04:00:00.000Z', updatedAt: '2026-08-14T04:00:00.000Z' })),
      restore: vi.fn(async (_userId: number, id: string) => ({ assetId: id, updatedAt: '2026-08-14T05:00:00.000Z' })),
      forget: vi.fn(),
    })
    const trash = vi.fn(async () => undefined)
    const service = createAiMediaAssetService({ images: images as never, videos: emptyVideos() as never, metadata: metadata as never, trashItem: trash })

    await expect(service.softDelete(7, assetId)).resolves.toEqual({ assetId, deletedAt: '2026-08-14T04:00:00.000Z' })
    // Ownership is proven by reading the asset before any metadata is written.
    expect(images.readOwned).toHaveBeenCalledBefore(metadata.softDelete)
    await expect(service.restore(7, assetId)).resolves.toEqual({ assetId })

    // Purging is the only destructive step, so it hands the file to the OS
    // recycle bin rather than unlinking it, and forgets the metadata after.
    await expect(service.purge(7, assetId)).resolves.toEqual({ assetId })
    expect(trash).toHaveBeenCalledWith('C:/store/image.png')
    expect(metadata.forget).toHaveBeenCalledWith(7, assetId)

    images.readOwned.mockRejectedValueOnce(new Error('missing image'))
    await expect(service.purge(7, assetId)).rejects.toThrow('不存在或无权访问')
  })
})

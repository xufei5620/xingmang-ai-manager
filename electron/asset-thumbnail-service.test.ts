import { describe, expect, it, vi } from 'vitest'
import { createAssetThumbnailService } from './asset-thumbnail-service'

const imageId = 'a'.repeat(43)
const videoId = 'b'.repeat(43)

function fixture(overrides: {
  cached?: Map<string, { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' }>
} = {}) {
  const cached = overrides.cached ?? new Map<string, { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' }>()
  const store = {
    read: vi.fn(async (userId: number, assetId: string) => cached.get(`${userId}:${assetId}`) ?? null),
    write: vi.fn(async (userId: number, assetId: string, thumbnail: { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' }) => {
      cached.set(`${userId}:${assetId}`, thumbnail)
    }),
    clear: vi.fn(async () => { cached.clear() }),
  }
  const sources = {
    readImage: vi.fn(async () => ({ bytes: Buffer.from('original-image'), mimeType: 'image/jpeg' })),
    resolveVideoPath: vi.fn(async () => 'C:/library/2026-08-14/clip.mp4'),
  }
  const renderer = {
    fromImageBytes: vi.fn(async (): Promise<Buffer | null> => Buffer.from('derived')),
    fromMediaFile: vi.fn(async (): Promise<Buffer | null> => Buffer.from('cover-frame')),
  }
  const onFailure = vi.fn()
  const service = createAssetThumbnailService({ store, sources, renderer, onFailure })
  return { service, store, sources, renderer, onFailure, cached }
}

describe('createAssetThumbnailService', () => {
  it('derives a still image once and serves the cached copy afterwards', async () => {
    const { service, renderer, store } = fixture()
    await expect(service.resolve(7, imageId, 'image')).resolves.toEqual({ bytes: Buffer.from('derived'), mimeType: 'image/jpeg' })
    await expect(service.resolve(7, imageId, 'image')).resolves.toEqual({ bytes: Buffer.from('derived'), mimeType: 'image/jpeg' })
    expect(renderer.fromImageBytes).toHaveBeenCalledTimes(1)
    expect(store.write).toHaveBeenCalledTimes(1)
  })

  it('keeps PNG for sources that may carry transparency', async () => {
    const { service, sources, renderer } = fixture()
    sources.readImage.mockResolvedValue({ bytes: Buffer.from('original-image'), mimeType: 'image/webp' })
    await expect(service.resolve(7, imageId, 'image')).resolves.toMatchObject({ mimeType: 'image/png' })
    expect(renderer.fromImageBytes).toHaveBeenCalledWith(Buffer.from('original-image'), 'image/png')
  })

  it('takes a video cover frame from the file rather than decoding the container', async () => {
    const { service, sources, renderer } = fixture()
    await expect(service.resolve(7, videoId, 'video')).resolves.toEqual({ bytes: Buffer.from('cover-frame'), mimeType: 'image/png' })
    expect(sources.resolveVideoPath).toHaveBeenCalledWith(7, videoId)
    expect(renderer.fromMediaFile).toHaveBeenCalledWith('C:/library/2026-08-14/clip.mp4')
    expect(renderer.fromImageBytes).not.toHaveBeenCalled()
  })

  it('has nothing visual to derive for audio', async () => {
    const { service, store, renderer } = fixture()
    await expect(service.resolve(7, imageId, 'audio')).resolves.toBeNull()
    expect(store.read).not.toHaveBeenCalled()
    expect(renderer.fromImageBytes).not.toHaveBeenCalled()
  })

  it('generates once when a whole grid asks for the same asset at the same time', async () => {
    const { service, renderer } = fixture()
    const results = await Promise.all(Array.from({ length: 8 }, () => service.resolve(7, imageId, 'image')))
    expect(renderer.fromImageBytes).toHaveBeenCalledTimes(1)
    expect(results.every((result) => result?.bytes.equals(Buffer.from('derived')))).toBe(true)
  })

  it('serializes generation so a full page cannot stall on parallel decodes', async () => {
    const { service, renderer } = fixture()
    let active = 0
    let peak = 0
    renderer.fromImageBytes.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return Buffer.from('derived')
    })
    const ids = Array.from({ length: 6 }, (_, position) => `${position}${'c'.repeat(42)}`)
    await Promise.all(ids.map((assetId) => service.resolve(7, assetId, 'image')))
    expect(renderer.fromImageBytes).toHaveBeenCalledTimes(6)
    expect(peak).toBe(1)
  })

  it('keeps the queue alive after one asset fails to render', async () => {
    const { service, renderer, onFailure } = fixture()
    renderer.fromImageBytes.mockRejectedValueOnce(new Error('解码失败'))
    await expect(service.resolve(7, imageId, 'image')).resolves.toBeNull()
    expect(onFailure).toHaveBeenCalledWith(imageId, '解码失败')
    const secondId = 'd'.repeat(43)
    await expect(service.resolve(7, secondId, 'image')).resolves.toMatchObject({ bytes: Buffer.from('derived') })
  })

  it('returns the derived image even when the cache cannot be written', async () => {
    const { service, store, onFailure } = fixture()
    store.write.mockRejectedValueOnce(new Error('磁盘已满'))
    await expect(service.resolve(7, imageId, 'image')).resolves.toMatchObject({ bytes: Buffer.from('derived') })
    expect(onFailure).toHaveBeenCalledWith(imageId, '磁盘已满')
  })

  it('reports nothing rather than a broken image when the platform has no frame extractor', async () => {
    const { service, renderer, store } = fixture()
    renderer.fromMediaFile.mockResolvedValue(null)
    await expect(service.resolve(7, videoId, 'video')).resolves.toBeNull()
    expect(store.write).not.toHaveBeenCalled()
  })

  it('drops every derived image for an account that signs out', async () => {
    const { service, store, renderer } = fixture()
    await service.resolve(7, imageId, 'image')
    await service.clear(7)
    await service.resolve(7, imageId, 'image')
    expect(store.clear).toHaveBeenCalledWith(7)
    expect(renderer.fromImageBytes).toHaveBeenCalledTimes(2)
  })
})

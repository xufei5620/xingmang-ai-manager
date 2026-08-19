import type { AssetThumbnailStore, StoredAssetThumbnail } from './asset-thumbnail-store'
import { assetThumbnailMimeType, type AssetThumbnailMimeType } from './asset-thumbnail'

export interface AssetThumbnailSource {
  /** Original media bytes, already ownership checked by the owning store. */
  bytes: Buffer
  mimeType: string
}

/**
 * Produces the derived image. Kept as an injected function so the whole service
 * is unit testable: the real implementation is backed by Electron's bundled
 * Skia encoder and cannot run under vitest.
 */
export interface AssetThumbnailRenderer {
  /** Decodes and contains still image bytes. Returns null when the source is undecodable. */
  fromImageBytes(bytes: Buffer, mimeType: AssetThumbnailMimeType): Promise<Buffer | null>
  /**
   * Extracts a cover frame from a media file on disk. Returns null when the
   * platform has no thumbnail provider, which is every platform except Windows
   * and macOS.
   */
  fromMediaFile(filePath: string): Promise<Buffer | null>
}

export interface AssetThumbnailSources {
  /** Resolves original still image bytes for an owned asset. */
  readImage(userId: number, assetId: string): Promise<AssetThumbnailSource>
  /** Resolves the absolute path of an owned video file. Never leaves the main process. */
  resolveVideoPath(userId: number, assetId: string): Promise<string>
}

export type AssetThumbnailMediaType = 'image' | 'video' | 'audio'

export function createAssetThumbnailService(options: {
  store: Pick<AssetThumbnailStore, 'read' | 'write' | 'clear'>
  sources: AssetThumbnailSources
  renderer: AssetThumbnailRenderer
  onFailure?(assetId: string, reason: string): void
}) {
  // Generation decodes a full resolution image on the main thread. Serializing
  // it means a grid that asks for two dozen thumbnails at once costs one decode
  // at a time with the event loop free in between, instead of a single long
  // stall. In-flight requests for the same asset share one generation so a
  // re-render cannot double the work.
  const inFlight = new Map<string, Promise<StoredAssetThumbnail | null>>()
  let queue: Promise<unknown> = Promise.resolve()

  async function resolve(userId: number, assetId: string, mediaType: AssetThumbnailMediaType): Promise<StoredAssetThumbnail | null> {
    // Audio has no visual frame to derive; the tray draws its own placeholder.
    if (mediaType === 'audio') return null
    const cached = await options.store.read(userId, assetId)
    if (cached) return cached
    const key = `${userId}:${assetId}`
    const existing = inFlight.get(key)
    if (existing) return existing
    const pending = enqueue(() => generate(userId, assetId, mediaType)).finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
    return pending
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work)
    queue = result.catch(() => undefined)
    return result
  }

  async function generate(userId: number, assetId: string, mediaType: AssetThumbnailMediaType): Promise<StoredAssetThumbnail | null> {
    try {
      // Another request may have finished while this one waited its turn.
      const cached = await options.store.read(userId, assetId)
      if (cached) return cached
      const thumbnail = mediaType === 'video'
        ? await renderVideo(userId, assetId)
        : await renderImage(userId, assetId)
      if (!thumbnail) return null
      // A cache write failure must not fail the request: the caller still has a
      // perfectly good thumbnail, it will just be regenerated next time.
      await options.store.write(userId, assetId, thumbnail).catch((error) => {
        options.onFailure?.(assetId, error instanceof Error ? error.message : String(error))
      })
      return thumbnail
    } catch (error) {
      options.onFailure?.(assetId, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async function renderImage(userId: number, assetId: string): Promise<StoredAssetThumbnail | null> {
    const source = await options.sources.readImage(userId, assetId)
    const mimeType = assetThumbnailMimeType(source.mimeType)
    const bytes = await options.renderer.fromImageBytes(source.bytes, mimeType)
    return bytes && bytes.byteLength > 0 ? { bytes, mimeType } : null
  }

  async function renderVideo(userId: number, assetId: string): Promise<StoredAssetThumbnail | null> {
    const filePath = await options.sources.resolveVideoPath(userId, assetId)
    const bytes = await options.renderer.fromMediaFile(filePath)
    // PNG keeps the frame exactly as the platform decoder produced it.
    return bytes && bytes.byteLength > 0 ? { bytes, mimeType: 'image/png' as const } : null
  }

  async function clear(userId: number): Promise<void> {
    inFlight.clear()
    await options.store.clear(userId)
  }

  return { resolve, clear }
}

export type AssetThumbnailService = ReturnType<typeof createAssetThumbnailService>

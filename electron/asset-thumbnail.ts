const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * Bump when the derived image itself changes shape — a different edge length,
 * encoder or cropping rule. The version is part of the URL, so a bump
 * invalidates every cached thumbnail in one step even though the responses are
 * served as immutable.
 */
export const assetThumbnailVersion = 'v1'

/**
 * 320 CSS pixels covers the largest tile at the densest supported display
 * without ever handing the grid a full resolution bitmap.
 */
export const assetThumbnailMaxEdge = 320

export type AssetThumbnailMimeType = 'image/png' | 'image/jpeg'

export type AssetThumbnailMediaKind = 'image' | 'video'

export interface AssetThumbnailRequest {
  version: string
  mediaKind: AssetThumbnailMediaKind
  assetId: string
}

export function assetThumbnailUrl(assetId: string, mediaKind: AssetThumbnailMediaKind): string {
  return `xingmang-asset://thumb/${assetThumbnailVersion}/${mediaKind}/${assetId}`
}

/**
 * Parses the path of a thumbnail request. Returns null for anything that is not
 * exactly `<version>/<mediaKind>/<assetId>`, which keeps traversal, empty
 * segments and malformed identifiers out of the store lookup entirely.
 *
 * The media kind only selects which store is asked; that store still proves
 * ownership, so a request naming the wrong kind resolves to nothing rather
 * than to someone else's asset.
 */
export function parseAssetThumbnailPath(pathname: string): AssetThumbnailRequest | null {
  const segments = pathname.replace(/^\//, '').split('/')
  if (segments.length !== 3) return null
  const [version, mediaKind, assetId] = segments
  if (!/^v[0-9]+$/.test(version ?? '')) return null
  if (mediaKind !== 'image' && mediaKind !== 'video') return null
  if (!ASSET_ID_PATTERN.test(assetId ?? '')) return null
  return { version: version as string, mediaKind, assetId: assetId as string }
}

/**
 * JPEG is a large win for photographic sources, but it cannot carry the alpha
 * channel that PNG and WebP sources may rely on, and a generated cutout losing
 * its transparency is immediately visible in the grid.
 */
export function assetThumbnailMimeType(sourceMimeType: string): AssetThumbnailMimeType {
  return sourceMimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
}

export function assetThumbnailFileName(assetId: string, mimeType: AssetThumbnailMimeType): string {
  return `${assetId}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`
}

/**
 * Contains the derived image inside a square box while preserving the aspect
 * ratio. Sources already smaller than the box are left alone: upscaling costs
 * bytes and adds nothing.
 */
export function assetThumbnailSize(width: number, height: number, maxEdge = assetThumbnailMaxEdge): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: maxEdge, height: maxEdge }
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

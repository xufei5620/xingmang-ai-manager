// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * Bump for representation or ownership/cache-policy changes. v2 stops reuse
 * of the old, publicly cacheable v1 responses after an account transition.
 * The protocol now rechecks identity and serves no-store; the disk thumbnail
 * store still avoids decoding the same owned asset on every request.
 */
export const assetThumbnailVersion = 'v2'

/**
 * 320 CSS pixels covers the largest tile at the densest supported display
 * without ever handing the grid a full resolution bitmap.
 */
export const assetThumbnailMaxEdge = 320

/**
 * The chat shows an image in a box up to 300 CSS pixels on its long edge. At
 * a 2x display and the largest automatic zoom (1.25) that is 750 device
 * pixels, so the grid's 320 pixel tile would visibly blur there; 768 stays
 * sharp while still decoding to a fraction of a 2048 or 4096 pixel original
 * (总单 78 R-2). Only still images get this size: nothing shows a video
 * cover that large.
 */
export const assetThumbnailLargeMaxEdge = 768

export type AssetThumbnailMimeType = 'image/png' | 'image/jpeg'

export type AssetThumbnailMediaKind = 'image' | 'video'

/** `tile` is the grid's 320 pixel thumbnail; `large` is the 768 pixel still image the chat shows. */
export type AssetThumbnailSizeName = 'tile' | 'large'

export interface AssetThumbnailRequest {
  version: string
  mediaKind: AssetThumbnailMediaKind
  size: AssetThumbnailSizeName
  assetId: string
}

export function assetThumbnailMaxEdgeFor(size: AssetThumbnailSizeName): number {
  return size === 'large' ? assetThumbnailLargeMaxEdge : assetThumbnailMaxEdge
}

export function assetThumbnailUrl(assetId: string, mediaKind: AssetThumbnailMediaKind): string {
  return `xingmang-asset://thumb/${assetThumbnailVersion}/${mediaKind}/${assetId}`
}

export function assetLargeImageThumbnailUrl(assetId: string): string {
  return `xingmang-asset://thumb/${assetThumbnailVersion}/image-large/${assetId}`
}

/**
 * Parses the path of a thumbnail request. Returns null for anything that is not
 * exactly `<version>/<kind>/<assetId>`, which keeps traversal, empty segments
 * and malformed identifiers out of the store lookup entirely. The kind is
 * `image`, `video` or `image-large`; there is no large video cover.
 *
 * The media kind only selects which store is asked; that store still proves
 * ownership, so a request naming the wrong kind resolves to nothing rather
 * than to someone else's asset.
 */
export function parseAssetThumbnailPath(pathname: string): AssetThumbnailRequest | null {
  const segments = pathname.replace(/^\//, '').split('/')
  if (segments.length !== 3) return null
  const [version, kind, assetId] = segments
  if (!/^v[0-9]+$/.test(version ?? '')) return null
  const parsed = parseThumbnailKind(kind)
  if (!parsed) return null
  if (!ASSET_ID_PATTERN.test(assetId ?? '')) return null
  return { version: version as string, ...parsed, assetId: assetId as string }
}

// A switch rather than a lookup object: `constructor` or `__proto__` must not
// read as a kind.
function parseThumbnailKind(kind: string | undefined): Pick<AssetThumbnailRequest, 'mediaKind' | 'size'> | null {
  switch (kind) {
    case 'image': return { mediaKind: 'image', size: 'tile' }
    case 'video': return { mediaKind: 'video', size: 'tile' }
    case 'image-large': return { mediaKind: 'image', size: 'large' }
    default: return null
  }
}

/**
 * JPEG is a large win for photographic sources, but it cannot carry the alpha
 * channel that PNG and WebP sources may rely on, and a generated cutout losing
 * its transparency is immediately visible in the grid.
 */
export function assetThumbnailMimeType(sourceMimeType: string): AssetThumbnailMimeType {
  return sourceMimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
}

export function assetThumbnailFileName(assetId: string, mimeType: AssetThumbnailMimeType, size: AssetThumbnailSizeName = 'tile'): string {
  return `${assetId}${size === 'large' ? '.large' : ''}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`
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

import type { CanvasAssetSummary, CanvasGeneratedAsset } from '../host'
import type { AssetRef } from '../model'

export function assetInputNodeKind(asset: CanvasAssetSummary): 'image-input' | 'video-input' | 'audio-input' {
  return asset.mediaType === 'video' ? 'video-input' : asset.mediaType === 'audio' ? 'audio-input' : 'image-input'
}

export function imageAssetForBinding(asset: CanvasAssetSummary | undefined): CanvasGeneratedAsset | null {
  return asset?.mediaType === 'image' ? asset : null
}

export interface MediaNodeDimensions {
  width: number
  height: number
}

function validRatioPart(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Resolve the ratio selected on a video node before the downloaded MP4 has
 * been inspected.  This keeps a portrait request from briefly rendering in
 * the generic 16:9 placeholder.
 */
export function videoAspectRatioForSize(size: string | undefined): string | undefined {
  if (typeof size !== 'string') return undefined
  const match = /^(\d+)x(\d+)$/.exec(size.trim())
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  return validRatioPart(width) && validRatioPart(height) ? `${width} / ${height}` : undefined
}

export function mediaAssetAspectRatio(asset: CanvasAssetSummary | AssetRef, fallbackSize?: string): string {
  const kind = mediaKind(asset)
  const width = 'width' in asset ? asset.width : undefined
  const height = 'height' in asset ? asset.height : undefined
  if (validRatioPart(width) && validRatioPart(height)) return `${width} / ${height}`
  if (kind === 'video') return videoAspectRatioForSize(fallbackSize) ?? '16 / 9'
  return '1 / 1'
}

function mediaKind(asset: CanvasAssetSummary | AssetRef): AssetRef['kind'] {
  return 'mediaType' in asset ? asset.mediaType : asset.kind
}

/**
 * Pixel size of the asset itself, for the hover readout.
 *
 * Returns null whenever the record does not carry both numbers. The node box
 * and the fallback aspect ratios above are always available and always look
 * like an answer, which is exactly why they must not be substituted here: a
 * made-up resolution is worse than no line at all.
 */
export function mediaAssetSizeLabel(asset: CanvasAssetSummary | AssetRef | undefined | null): string | null {
  const width = asset && 'width' in asset ? asset.width : undefined
  const height = asset && 'height' in asset ? asset.height : undefined
  return validRatioPart(width) && validRatioPart(height) ? `${width} × ${height}` : null
}

export function formatMediaDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const seconds = Math.floor(value)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const tail = `${String(minutes % 60).padStart(hours ? 2 : 1, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return hours ? `${hours}:${tail}` : tail
}

/** Duration line for the hover readout; absent metadata omits the line. */
export function mediaDurationLabel(value: number | undefined | null): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? formatMediaDuration(value) : null
}

/** Joins the readout lines that exist. Nothing to say means no tooltip at all. */
export function mediaHoverTitle(lines: readonly (string | null | undefined)[]): string | undefined {
  const present = lines.filter((line): line is string => typeof line === 'string' && line.length > 0)
  return present.length > 0 ? present.join('\n') : undefined
}

export function mediaAssetNodeDimensions(asset: CanvasAssetSummary | AssetRef): MediaNodeDimensions {
  const kind = mediaKind(asset)
  if (kind === 'audio') return { width: 360, height: 104 }

  const fallback = kind === 'video' ? { width: 320, height: 180 } : { width: 280, height: 280 }
  const sourceWidth = 'width' in asset ? asset.width : undefined
  const sourceHeight = 'height' in asset ? asset.height : undefined
  if (!sourceWidth || !sourceHeight || sourceWidth <= 0 || sourceHeight <= 0) return fallback

  const ratio = sourceWidth / sourceHeight
  let width = kind === 'video' ? 320 : 280
  let height = Math.round(width / ratio)
  if (height > 480) {
    height = 480
    width = Math.round(height * ratio)
  } else if (height < 140) {
    height = 140
    width = Math.round(height * ratio)
    if (width > 480) {
      width = 480
      height = Math.round(width / ratio)
    }
  }
  return { width: Math.max(96, width), height: Math.max(80, height) }
}

/** React Flow 的外层节点也必须为竖屏结果预留真实高度，否则内部 video 会被裁切。 */
export function mediaResultNodeDimensions(
  nodeKind: string,
  asset: CanvasAssetSummary | AssetRef | undefined,
  baseWidth: number,
  baseHeight: number,
  fallbackSize?: string,
): MediaNodeDimensions | null {
  if (!asset || mediaKind(asset) !== 'video' || !Number.isFinite(baseWidth) || !Number.isFinite(baseHeight)) return null
  const sourceWidth = 'width' in asset ? asset.width : undefined
  const sourceHeight = 'height' in asset ? asset.height : undefined
  let ratio: number
  if (validRatioPart(sourceWidth) && validRatioPart(sourceHeight)) {
    ratio = sourceWidth / sourceHeight
  } else {
    const fallback = videoAspectRatioForSize(fallbackSize)
    if (!fallback) return null
    const [width, height] = fallback.split('/').map(Number)
    if (!validRatioPart(width) || !validRatioPart(height)) return null
    ratio = width / height
  }
  const previewWidth = Math.max(160, Math.round(baseWidth - 20))
  const previewHeight = Math.round(previewWidth / ratio)
  const chromeHeight = nodeKind === 'video' || nodeKind === 'video-generate' ? 246 : 0
  return { width: Math.round(baseWidth), height: Math.max(Math.round(baseHeight), previewHeight + chromeHeight) }
}

import type { AssetRef } from '../model'
import type { ImageTransformSize } from './geometry'

export function imagePreviewSourceKey(asset: AssetRef): string {
  // Asset IDs are immutable; a new local URL is also a new preview version.
  return JSON.stringify([asset.assetId ?? null, asset.localUrl ?? null])
}

function validSize(width: number | undefined, height: number | undefined): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width! > 0 && height! > 0
}

export function resolveImagePreviewSize(asset: AssetRef | undefined, measured: ReadonlyMap<string, ImageTransformSize>): ImageTransformSize {
  const natural = asset && measured.get(imagePreviewSourceKey(asset))
  if (natural) return natural
  return asset && validSize(asset.width, asset.height) ? { width: asset.width!, height: asset.height! } : { width: 1024, height: 1024 }
}

export function recordImagePreviewSize(current: ReadonlyMap<string, ImageTransformSize>, activeSources: ReadonlySet<string>, source: string, naturalWidth: number, naturalHeight: number): ReadonlyMap<string, ImageTransformSize> {
  // HTMLImageElement natural dimensions include EXIF orientation, matching
  // createImageBitmap(..., { imageOrientation: 'from-image' }) in the processor.
  if (!activeSources.has(source) || !validSize(naturalWidth, naturalHeight)) return current
  const previous = current.get(source)
  if (previous?.width === naturalWidth && previous.height === naturalHeight) return current
  const next = new Map([...current].filter(([key]) => activeSources.has(key)))
  next.set(source, { width: naturalWidth, height: naturalHeight })
  return next
}

export function imagePreviewOriginalOutputSize(size: ImageTransformSize): ImageTransformSize {
  const scale = Math.min(1, 4096 / Math.max(size.width, size.height))
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

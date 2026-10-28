import type { AssetRef } from '../model'
import { finiteMediaDurationSeconds } from './media-assets'

/** Candidate identity is transient; the owned media identity survives reopening. */
export function sameCanvasMediaAsset(left: AssetRef | undefined, right: AssetRef | undefined): boolean {
  return Boolean(left && right && typeof left.assetId === 'string' && left.assetId.trim()
    && left.kind === right.kind && left.assetId === right.assetId)
}

function validPixelDimension(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Keep decoded facts only for the same asset, never its old URLs or task metadata. */
export function mergeKnownCanvasMediaMetadata<T extends AssetRef>(incoming: T, known: readonly (AssetRef | undefined)[]): T {
  const matching = known.filter((asset) => sameCanvasMediaAsset(incoming, asset))
  const width = validPixelDimension(incoming.width) ?? matching.map((asset) => validPixelDimension(asset?.width)).find((value) => value !== undefined)
  const height = validPixelDimension(incoming.height) ?? matching.map((asset) => validPixelDimension(asset?.height)).find((value) => value !== undefined)
  const duration = incoming.kind === 'image' ? undefined
    : finiteMediaDurationSeconds(incoming.durationSeconds) ?? matching.map((asset) => finiteMediaDurationSeconds(asset?.durationSeconds)).find((value) => value !== undefined)
  const result = { ...incoming }
  if (width !== undefined) result.width = width
  else delete result.width
  if (height !== undefined) result.height = height
  else delete result.height
  if (duration !== undefined) result.durationSeconds = duration
  else delete result.durationSeconds
  return result
}

/**
 * Tile density of the asset library grid.
 *
 * The grid was fixed at two columns, which is one decision imposed on two
 * different jobs: scanning a large library for the right frame wants many small
 * tiles, judging a render wants few large ones.
 *
 * Stored globally rather than per project, unlike the panel layout in
 * canvas-ui-preferences: the library is the same library in every project, so a
 * density chosen while working on one should hold when the next one opens.
 */

export const assetDensityVersion = 1 as const

export type AssetDensity = 'compact' | 'cozy' | 'roomy'

export const defaultAssetDensity: AssetDensity = 'cozy'

/** Minimum tile edge in CSS pixels; the grid auto-fills as many as fit. */
export const assetDensityTileSize: Record<AssetDensity, number> = {
  compact: 72,
  cozy: 96,
  roomy: 132,
}

export const assetDensityLabel: Record<AssetDensity, string> = {
  compact: '紧凑',
  cozy: '标准',
  roomy: '宽松',
}

export const assetDensityOrder: readonly AssetDensity[] = ['compact', 'cozy', 'roomy']

export interface AssetDensityStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const storageKey = 'xingmang.canvas.assets.density'

function storageOrNull(storage?: AssetDensityStorage): AssetDensityStorage | null {
  if (storage) return storage
  try {
    return typeof window === 'undefined' || !window.localStorage ? null : window.localStorage
  } catch {
    return null
  }
}

function isAssetDensity(value: unknown): value is AssetDensity {
  return value === 'compact' || value === 'cozy' || value === 'roomy'
}

export function readAssetDensity(storage?: AssetDensityStorage): AssetDensity {
  const target = storageOrNull(storage)
  if (!target) return defaultAssetDensity
  try {
    const content = target.getItem(storageKey)
    if (!content) return defaultAssetDensity
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultAssetDensity
    const record = parsed as { version?: unknown; density?: unknown }
    // An unrecognized version means another build wrote this, so the meaning of
    // its fields cannot be assumed.
    if (record.version !== assetDensityVersion) return defaultAssetDensity
    return isAssetDensity(record.density) ? record.density : defaultAssetDensity
  } catch {
    return defaultAssetDensity
  }
}

export function writeAssetDensity(density: AssetDensity, storage?: AssetDensityStorage): void {
  const target = storageOrNull(storage)
  if (!target) return
  try {
    target.setItem(storageKey, JSON.stringify({
      version: assetDensityVersion,
      density: isAssetDensity(density) ? density : defaultAssetDensity,
    }))
  } catch {
    // A density preference is an enhancement. Quota and private-window failures
    // must never break the library.
  }
}

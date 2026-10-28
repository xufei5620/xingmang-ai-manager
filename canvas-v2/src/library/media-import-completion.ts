import type { CanvasAssetSummary, CanvasGeneratedAsset } from '../host'

export type CanvasMediaImportCompletion = 'applied' | 'cancelled' | 'stale'

/** A same-ID cloud reload is a new editing session, not an ordinary edit. */
export async function completeCanvasMediaImport(
  pending: Promise<CanvasAssetSummary | CanvasGeneratedAsset | null>,
  projectEpoch: number,
  currentProjectEpoch: () => number,
  apply: (asset: CanvasAssetSummary | CanvasGeneratedAsset) => void,
): Promise<CanvasMediaImportCompletion> {
  const asset = await pending
  if (!asset) return 'cancelled'
  if (currentProjectEpoch() !== projectEpoch) return 'stale'
  // Apply in the same synchronous turn as the epoch check. Returning an asset
  // for another awaited continuation would reopen the session-change race.
  apply(asset)
  return 'applied'
}

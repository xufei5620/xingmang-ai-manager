import type { CanvasAssetSummary } from '../host'

export async function updateAssetFavorite(
  asset: Pick<CanvasAssetSummary, 'assetId' | 'favorite'>,
  update: (assetId: string, input: { favorite: boolean }) => void | Promise<void>,
): Promise<string | null> {
  try {
    await update(asset.assetId, { favorite: !asset.favorite })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

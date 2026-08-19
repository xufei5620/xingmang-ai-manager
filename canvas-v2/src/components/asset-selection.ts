/**
 * Selection transitions for the asset library grid.
 *
 * Selection used to be an implicit hover state: pointing at a tile expanded it
 * and moving the pointer away collapsed it again and called `blur()` on
 * whatever inside it happened to hold focus. That stole the keyboard focus of
 * anyone operating a tile without a mouse the moment an unrelated pointer
 * crossed the grid. Selection is now explicit — a deliberate activation opens
 * a tile and only another deliberate action closes it — so no pointer movement
 * can ever move focus.
 */

export type AssetSelectionKey = 'Enter' | ' ' | 'Escape' | (string & {})

/** Activating the open tile closes it, so a keyboard user can always get out. */
export function toggleAssetSelection(current: string | null, assetId: string): string | null {
  return current === assetId ? null : assetId
}

/**
 * Returns the next selection for a key press, or `undefined` when the key is
 * not a selection key and the caller should let the event through untouched.
 */
export function assetSelectionAfterKey(key: AssetSelectionKey, current: string | null, assetId: string): string | null | undefined {
  if (key === 'Enter' || key === ' ') return toggleAssetSelection(current, assetId)
  if (key === 'Escape') return current === null ? undefined : null
  return undefined
}

/** Selection survives everything except the asset leaving the current page. */
export function retainedAssetSelection(current: string | null, visibleAssetIds: readonly string[]): string | null {
  if (current === null) return null
  return visibleAssetIds.includes(current) ? current : null
}

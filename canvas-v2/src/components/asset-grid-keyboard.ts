/**
 * Keyboard model for the asset library grid.
 *
 * Every tile used to be its own tab stop, so reaching the pagination controls
 * past a full page meant twenty-four presses of Tab. The grid is one stop now
 * (roving tabindex) and movement inside it happens with the arrow keys, which
 * is what a grid of tiles reads as to a screen reader and what every file
 * browser already does.
 */

export type AssetGridKeyAction =
  | { kind: 'focus'; index: number }
  | { kind: 'favorite' }
  | { kind: 'search' }

/**
 * Returns what a key press means inside the grid, or `undefined` when the key
 * belongs to someone else and the event must be left alone.
 *
 * Movement clamps at the edges rather than wrapping: wrapping from the last
 * tile back to the first reads as a jump with no cause when you cannot see the
 * whole grid at once.
 */
export function assetGridKeyAction(
  key: string,
  index: number,
  count: number,
  columns: number,
): AssetGridKeyAction | undefined {
  if (key === '.') return { kind: 'favorite' }
  if (key === '/') return { kind: 'search' }
  if (count <= 0) return undefined
  // A grid whose columns cannot be measured still has to move by something.
  const stride = Number.isFinite(columns) ? Math.max(1, Math.trunc(columns)) : 1
  const clamp = (value: number) => Math.min(count - 1, Math.max(0, value))
  switch (key) {
    case 'ArrowLeft': return { kind: 'focus', index: clamp(index - 1) }
    case 'ArrowRight': return { kind: 'focus', index: clamp(index + 1) }
    case 'ArrowUp': return { kind: 'focus', index: clamp(index - stride) }
    case 'ArrowDown': return { kind: 'focus', index: clamp(index + stride) }
    case 'Home': return { kind: 'focus', index: 0 }
    case 'End': return { kind: 'focus', index: count - 1 }
    default: return undefined
  }
}

/**
 * The single tab stop of the grid. Focus follows the user, falls back to the
 * lone selected tile so returning to the grid resumes where they left off, and
 * clamps when the page shrinks under it.
 */
export function rovingTabIndex(focusIndex: number, selectedIndex: number, count: number): number {
  if (count <= 0) return -1
  if (focusIndex >= 0 && focusIndex < count) return focusIndex
  if (selectedIndex >= 0 && selectedIndex < count) return selectedIndex
  return 0
}

/**
 * How many placeholder tiles to draw while a query is in flight.
 *
 * The tray used to push a one-line "loading" paragraph above the results and
 * then drop it again, so every filter change nudged the whole grid up and down.
 *
 * Tiles already on screen are the best placeholder there is: they hold exactly
 * the right space and, unlike a skeleton, they do not destroy the focus of
 * someone operating one by keyboard. So skeletons only appear when there is
 * nothing to hold the space -- the first load, or a page that came back empty.
 */
export function skeletonTileCount(loading: boolean, renderedCount: number, limit: number): number {
  if (!loading || renderedCount > 0) return 0
  return Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 1))
}

/** Steps the lightbox through the current page, clamping at both ends. */
export function adjacentAssetId(
  orderedIds: readonly string[],
  assetId: string | null,
  step: -1 | 1,
): string | null {
  if (assetId === null) return null
  const index = orderedIds.indexOf(assetId)
  if (index === -1) return null
  const next = index + step
  if (next < 0 || next >= orderedIds.length) return null
  return orderedIds[next] as string
}

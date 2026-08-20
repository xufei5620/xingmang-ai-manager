/**
 * Selection state for the asset library grid.
 *
 * Selection used to be an implicit hover state: pointing at a tile expanded it
 * and moving the pointer away collapsed it again and called `blur()` on
 * whatever inside it held focus. That stole the keyboard focus of anyone
 * operating a tile without a mouse the moment an unrelated pointer crossed the
 * grid. Selection is now explicit — a deliberate activation changes it and no
 * pointer movement ever does — and it holds a set rather than a single
 * identifier so the grid behaves like every other file browser.
 */

export interface AssetSelection {
  /** Identifiers in selection order-independent form. */
  ids: ReadonlySet<string>
  /** The tile a Shift range extends from, and the one detail is shown for. */
  anchor: string | null
}

export interface AssetSelectionModifiers {
  /** Ctrl on Windows, Command on macOS: toggle one tile without losing the rest. */
  toggle?: boolean
  /** Shift: extend from the anchor to the clicked tile. */
  range?: boolean
}

export const emptyAssetSelection: AssetSelection = { ids: new Set(), anchor: null }

export function isAssetSelected(selection: AssetSelection, assetId: string): boolean {
  return selection.ids.has(assetId)
}

/** Detail is only meaningful for a single tile, so it follows the lone selection. */
export function assetSelectionDetailId(selection: AssetSelection): string | null {
  return selection.ids.size === 1 ? (selection.anchor ?? [...selection.ids][0] ?? null) : null
}

function selectOnly(assetId: string): AssetSelection {
  return { ids: new Set([assetId]), anchor: assetId }
}

export function assetSelectionForActivation(
  current: AssetSelection,
  assetId: string,
  orderedIds: readonly string[],
  modifiers: AssetSelectionModifiers = {},
): AssetSelection {
  if (modifiers.range && current.anchor !== null) {
    const from = orderedIds.indexOf(current.anchor)
    const to = orderedIds.indexOf(assetId)
    if (from !== -1 && to !== -1) {
      const [start, end] = from <= to ? [from, to] : [to, from]
      // The anchor stays put so dragging the range back and forth keeps working.
      return { ids: new Set(orderedIds.slice(start, end + 1)), anchor: current.anchor }
    }
  }
  if (modifiers.toggle) {
    const ids = new Set(current.ids)
    if (ids.delete(assetId)) return { ids, anchor: ids.size > 0 ? current.anchor : null }
    ids.add(assetId)
    return { ids, anchor: assetId }
  }
  // Activating the only selected tile closes it, so a keyboard user can always
  // get back out without reaching for another key.
  if (current.ids.size === 1 && current.ids.has(assetId)) return emptyAssetSelection
  return selectOnly(assetId)
}

export function assetSelectionSelectAll(orderedIds: readonly string[]): AssetSelection {
  if (orderedIds.length === 0) return emptyAssetSelection
  return { ids: new Set(orderedIds), anchor: orderedIds[0] as string }
}

/**
 * A context menu acts on the whole selection when the target is part of it, and
 * otherwise moves the selection to the target first. Right-clicking one of
 * several selected tiles must not silently discard the rest.
 */
export function assetSelectionForContextMenu(current: AssetSelection, assetId: string): AssetSelection {
  return current.ids.has(assetId) ? current : selectOnly(assetId)
}

/**
 * Returns the next selection for a key press, or `undefined` when the key is
 * not a selection key and the caller should let the event through untouched.
 */
export function assetSelectionAfterKey(
  key: string,
  current: AssetSelection,
  assetId: string,
  orderedIds: readonly string[],
  modifiers: AssetSelectionModifiers = {},
): AssetSelection | undefined {
  if (key === 'Enter' || key === ' ') return assetSelectionForActivation(current, assetId, orderedIds, modifiers)
  if (key === 'Escape') return current.ids.size === 0 ? undefined : emptyAssetSelection
  return undefined
}

/** Selection survives everything except its assets leaving the current page. */
export function retainedAssetSelection(current: AssetSelection, visibleAssetIds: readonly string[]): AssetSelection {
  if (current.ids.size === 0) return current
  const visible = new Set(visibleAssetIds)
  const ids = new Set([...current.ids].filter((assetId) => visible.has(assetId)))
  if (ids.size === current.ids.size) return current
  if (ids.size === 0) return emptyAssetSelection
  return { ids, anchor: current.anchor !== null && ids.has(current.anchor) ? current.anchor : ([...ids][0] as string) }
}

import { describe, expect, it } from 'vitest'
import {
  assetSelectionAfterKey,
  assetSelectionDetailId,
  assetSelectionForActivation,
  assetSelectionForContextMenu,
  assetSelectionSelectAll,
  emptyAssetSelection,
  isAssetSelected,
  retainedAssetSelection,
  type AssetSelection,
} from './asset-selection'

const order = ['a', 'b', 'c', 'd', 'e']

function selection(ids: string[], anchor: string | null = ids[0] ?? null): AssetSelection {
  return { ids: new Set(ids), anchor }
}

function idsOf(value: AssetSelection): string[] {
  return [...value.ids].sort()
}

describe('assetSelectionForActivation', () => {
  it('replaces the selection on a plain activation', () => {
    expect(idsOf(assetSelectionForActivation(selection(['a', 'b']), 'd', order))).toEqual(['d'])
  })

  it('closes the only selected tile when it is activated again', () => {
    expect(assetSelectionForActivation(selection(['a']), 'a', order)).toEqual(emptyAssetSelection)
  })

  it('narrows a multiple selection to the activated tile rather than closing it', () => {
    expect(idsOf(assetSelectionForActivation(selection(['a', 'b']), 'a', order))).toEqual(['a'])
  })

  it('toggles one tile without losing the rest', () => {
    const added = assetSelectionForActivation(selection(['a']), 'c', order, { toggle: true })
    expect(idsOf(added)).toEqual(['a', 'c'])
    expect(added.anchor).toBe('c')
    expect(idsOf(assetSelectionForActivation(added, 'a', order, { toggle: true }))).toEqual(['c'])
  })

  it('forgets the anchor once a toggle empties the selection', () => {
    expect(assetSelectionForActivation(selection(['a']), 'a', order, { toggle: true })).toEqual(emptyAssetSelection)
  })

  it('extends a range from the anchor in either direction', () => {
    expect(idsOf(assetSelectionForActivation(selection(['b']), 'd', order, { range: true }))).toEqual(['b', 'c', 'd'])
    expect(idsOf(assetSelectionForActivation(selection(['d']), 'b', order, { range: true }))).toEqual(['b', 'c', 'd'])
  })

  it('keeps the anchor so a range can be redrawn', () => {
    const wide = assetSelectionForActivation(selection(['b']), 'e', order, { range: true })
    expect(wide.anchor).toBe('b')
    expect(idsOf(assetSelectionForActivation(wide, 'c', order, { range: true }))).toEqual(['b', 'c'])
  })

  it('falls back to a plain activation when there is no anchor to extend from', () => {
    expect(idsOf(assetSelectionForActivation(emptyAssetSelection, 'c', order, { range: true }))).toEqual(['c'])
  })

  it('falls back to a plain activation when the anchor left the page', () => {
    expect(idsOf(assetSelectionForActivation(selection([], 'z'), 'c', order, { range: true }))).toEqual(['c'])
  })
})

describe('assetSelectionSelectAll', () => {
  it('selects the whole page and anchors on the first tile', () => {
    expect(assetSelectionSelectAll(order)).toEqual({ ids: new Set(order), anchor: 'a' })
  })

  it('stays empty for an empty page', () => {
    expect(assetSelectionSelectAll([])).toEqual(emptyAssetSelection)
  })
})

describe('assetSelectionForContextMenu', () => {
  it('keeps a multiple selection when the target is part of it', () => {
    const current = selection(['a', 'b', 'c'])
    expect(assetSelectionForContextMenu(current, 'b')).toBe(current)
  })

  it('moves the selection to a target outside it', () => {
    expect(idsOf(assetSelectionForContextMenu(selection(['a', 'b']), 'd'))).toEqual(['d'])
  })
})

describe('assetSelectionAfterKey', () => {
  it('treats Enter and Space as activation and honours modifiers', () => {
    expect(idsOf(assetSelectionAfterKey('Enter', emptyAssetSelection, 'a', order) as AssetSelection)).toEqual(['a'])
    expect(idsOf(assetSelectionAfterKey(' ', selection(['a']), 'c', order, { toggle: true }) as AssetSelection)).toEqual(['a', 'c'])
  })

  it('clears the selection on Escape', () => {
    expect(assetSelectionAfterKey('Escape', selection(['a', 'b']), 'a', order)).toEqual(emptyAssetSelection)
  })

  it('leaves Escape to the surrounding dialog when nothing is selected', () => {
    expect(assetSelectionAfterKey('Escape', emptyAssetSelection, 'a', order)).toBeUndefined()
  })

  it('ignores keys that are not selection keys', () => {
    expect(assetSelectionAfterKey('Tab', selection(['a']), 'a', order)).toBeUndefined()
    expect(assetSelectionAfterKey('ArrowDown', emptyAssetSelection, 'a', order)).toBeUndefined()
  })
})

describe('assetSelectionDetailId', () => {
  it('reports the lone selection', () => {
    expect(assetSelectionDetailId(selection(['b']))).toBe('b')
  })

  it('reports nothing for an empty or multiple selection', () => {
    expect(assetSelectionDetailId(emptyAssetSelection)).toBeNull()
    expect(assetSelectionDetailId(selection(['a', 'b']))).toBeNull()
  })
})

describe('retainedAssetSelection', () => {
  it('keeps the selection while its assets are on the page', () => {
    const current = selection(['a', 'b'])
    expect(retainedAssetSelection(current, order)).toBe(current)
  })

  it('drops only the assets that left the page', () => {
    expect(idsOf(retainedAssetSelection(selection(['a', 'b']), ['b', 'c']))).toEqual(['b'])
  })

  it('re-anchors when the anchor itself left the page', () => {
    expect(retainedAssetSelection(selection(['a', 'b'], 'a'), ['b'])).toEqual({ ids: new Set(['b']), anchor: 'b' })
  })

  it('empties out when nothing survives', () => {
    expect(retainedAssetSelection(selection(['a']), ['z'])).toEqual(emptyAssetSelection)
  })
})

describe('isAssetSelected', () => {
  it('answers membership', () => {
    expect(isAssetSelected(selection(['a', 'b']), 'b')).toBe(true)
    expect(isAssetSelected(selection(['a']), 'b')).toBe(false)
  })
})

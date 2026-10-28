import { describe, expect, it } from 'vitest'
import { parseNodeTileInput, parseTileInput, remapTileInputSettings, resolveTileInputSlots, selectTileInputEdge, type TileInputReference } from './tile-input'

function reference(edgeId: string, outputIndex = 0, status = 'ready', batch = false): TileInputReference {
  return { edgeId, outputIndex, status, batch, kind: 'image' }
}

describe('stable tile input selection', () => {
  it('normalizes an omitted batch index and preserves explicit portable tombstones', () => {
    expect(parseTileInput({ edgeId: 'edge-a' })).toEqual({ edgeId: 'edge-a', outputIndex: 0 })
    expect(parseNodeTileInput('image-tile', { missing: true })).toEqual({ missing: true })
    expect(parseNodeTileInput('image-tile', undefined)).toBeUndefined()
    expect(() => parseNodeTileInput('image-collage', { edgeId: 'edge-a' })).toThrow('只有平铺')
  })
  it.each([null, [], {}, { edgeId: '' }, { edgeId: 'edge\0a' }, { edgeId: 'e'.repeat(257) }, { edgeId: 'e', outputIndex: -1 }, { edgeId: 'e', outputIndex: 20 }, { edgeId: 'e', outputIndex: 0.5 }, { edgeId: 'e', outputIndex: NaN }, { edgeId: 'e', outputIndex: '1' }, { missing: false }, { missing: true, edgeId: 'e' }, { edgeId: 'e', assetId: 'private-asset' }])('rejects malformed selection %j without silently resetting it', (value) => {
    expect(() => parseTileInput(value)).toThrow('平铺')
  })
  it('defaults to the first stable occurrence even while it is waiting', () => {
    const first = reference('edge-a', 0, 'waiting'), second = reference('edge-b')
    const resolved = resolveTileInputSlots([first, second])
    expect(resolved).toMatchObject({ selectedIndex: 0, explicit: false, selected: { edgeId: 'edge-a', outputIndex: 0, pending: true, missing: false, reference: first } })
    expect(resolveTileInputSlots([])).toEqual({ slots: [], selectedIndex: -1, selected: null, explicit: false })
  })
  it('selects an edge occurrence across reorder and duplicate asset connections', () => {
    const references = [reference('edge-a'), reference('edge-b', 0, 'ready', true), reference('edge-b', 1, 'ready', true)]
    const selection = { edgeId: 'edge-b', outputIndex: 1 }
    expect(resolveTileInputSlots(references, selection)).toMatchObject({ selectedIndex: 2, selected: { edgeId: 'edge-b', outputIndex: 1 }, explicit: true })
    expect(resolveTileInputSlots([...references].reverse(), selection)).toMatchObject({ selectedIndex: 0, selected: { edgeId: 'edge-b', outputIndex: 1 } })
    expect(resolveTileInputSlots([reference('edge-a'), reference('edge-b')]).slots).toHaveLength(2)
  })
  it('uses provided output indices rather than filtered array ranks', () => {
    const resolved = resolveTileInputSlots([reference('edge-b', 0, 'ready', true), reference('edge-b', 2, 'ready', true)], { edgeId: 'edge-b', outputIndex: 2 })
    expect(resolved.selected).toMatchObject({ outputIndex: 2, pending: false, missing: false })
    expect(resolved.slots.map((slot) => slot.outputIndex)).toEqual([0, 2])
  })
  it('retains a selected unresolved batch position and never borrows another ready image', () => {
    const selection = { edgeId: 'batch', outputIndex: 3 }
    const pending = resolveTileInputSlots([reference('batch', 0, 'waiting', true), reference('other')], selection)
    expect(pending.selected).toMatchObject({ edgeId: 'batch', outputIndex: 3, pending: true, missing: false, reference: { status: 'waiting' } })
    expect(pending.selectedIndex).toBe(1)
    const shrunk = resolveTileInputSlots([reference('batch', 0, 'ready', true), reference('batch', 1, 'ready', true), reference('other')], selection)
    expect(shrunk.selected).toEqual({ edgeId: 'batch', outputIndex: 3, pending: false, missing: true })
    expect(shrunk.selected?.reference).toBeUndefined()
  })
  it('keeps deleted selections unavailable and restores them when the edge returns', () => {
    const selection = { edgeId: 'deleted', outputIndex: 0 }
    expect(resolveTileInputSlots([reference('other')], selection).selected).toEqual({ ...selection, pending: false, missing: true })
    expect(resolveTileInputSlots([reference('other'), reference('deleted')], selection).selected).toMatchObject({ ...selection, pending: false, missing: false })
    expect(resolveTileInputSlots([reference('other')], { missing: true }).selected).toEqual({ outputIndex: 0, pending: false, missing: true })
  })
  it('resolves execution from incoming edge identity and blocks explicit missing choices', () => {
    const edges = [{ id: 'first' }, { id: 'second' }]
    expect(selectTileInputEdge(undefined, edges)).toEqual({ edge: edges[0], outputIndex: 0 })
    expect(selectTileInputEdge(undefined, [])).toBeNull()
    expect(selectTileInputEdge({ edgeId: 'second', outputIndex: 2 }, edges)).toEqual({ edge: edges[1], outputIndex: 2 })
    expect(() => selectTileInputEdge({ edgeId: 'gone' }, edges)).toThrow('已移除')
    expect(() => selectTileInputEdge({ missing: true }, edges)).toThrow('已移除')
  })
  it('remaps internal choices and tombstones omitted external choices without retaining private identities', () => {
    const settings = { title: 'Tile', tileInput: { edgeId: 'private-edge', outputIndex: 2 } }
    expect(remapTileInputSettings(settings, new Map([['private-edge', 'new-edge']]))).toEqual({ title: 'Tile', tileInput: { edgeId: 'new-edge', outputIndex: 2 } })
    expect(remapTileInputSettings(settings, new Map())).toEqual({ title: 'Tile', tileInput: { missing: true } })
    expect(settings.tileInput).toEqual({ edgeId: 'private-edge', outputIndex: 2 })
    expect(remapTileInputSettings(undefined, new Map())).toBeUndefined()
    expect(remapTileInputSettings({}, new Map(), 'omitted-default')).toEqual({ tileInput: { missing: true } })
    expect(remapTileInputSettings({}, new Map([['default', 'fresh']]), 'default')).toEqual({})
  })
})

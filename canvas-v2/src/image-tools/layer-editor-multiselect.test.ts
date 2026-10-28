import { describe, expect, it } from 'vitest'
import { addEditorLayer, beginLayerEditorTransaction, createLayerEditorState, defaultEditorImageLayer, deleteEditorLayer, deleteEditorLayers, duplicateEditorLayer, duplicateEditorLayers, finishLayerEditorTransaction, moveEditorLayers, moveSelectedEditorLayers, patchEditorLayer, patchEditorLayers, redoLayerEditor, reorderEditorLayers, selectedEditorLayerIds, selectEditorLayer, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import type { ImageLayerRecipe } from './recipe'

function initial(count = 5): LayerEditorState {
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 1000, outputHeight: 800, explicitLayers: true, background: 'transparent', layers: Array.from({ length: count }, (_, index) => ({ ...defaultEditorImageLayer(index), name: `${index + 1}`, x: index / 10 })) }
  return createLayerEditorState(recipe, count)
}
function choose(state: LayerEditorState, ...ids: string[]): LayerEditorState {
  let next = selectEditorLayer(state, ids[0] ?? null)
  for (const id of ids.slice(1)) next = selectEditorLayer(next, id, { toggle: true })
  return next
}

describe('session-only editor multi-selection', () => {
  it('retains legacy single snapshots and orders toggles by document order', () => {
    const state = initial(), { selectedIds: _selected, anchorId: _anchor, ...legacy } = state.present
    expect(selectedEditorLayerIds(legacy)).toEqual(['layer-5'])
    const selected = choose(state, 'layer-4', 'layer-2', 'layer-1')
    expect(selectedEditorLayerIds(selected.present)).toEqual(['layer-1', 'layer-2', 'layer-4'])
    expect(selected.present.selectedId).toBe('layer-1')
    expect(selected.past).toEqual([])
    expect(selected.present.recipe).toBe(state.present.recipe)
  })
  it('selects a reversible Shift range around the stable anchor and supports additive ranges', () => {
    let state = selectEditorLayer(initial(), 'layer-4')
    state = selectEditorLayer(state, 'layer-2', { range: true })
    expect(selectedEditorLayerIds(state.present)).toEqual(['layer-2', 'layer-3', 'layer-4'])
    expect(state.present).toMatchObject({ selectedId: 'layer-2', anchorId: 'layer-4' })
    state = selectEditorLayer(state, 'layer-5', { range: true })
    expect(selectedEditorLayerIds(state.present)).toEqual(['layer-4', 'layer-5'])
    state = selectEditorLayer(state, 'layer-1', { toggle: true })
    state = selectEditorLayer(state, 'layer-3', { toggle: true, range: true })
    expect(selectedEditorLayerIds(state.present)).toEqual(['layer-1', 'layer-2', 'layer-3', 'layer-4', 'layer-5'])
  })
  it('updates primary selection predictably and permits clearing the final item', () => {
    let state = choose(initial(), 'layer-1', 'layer-3')
    state = selectEditorLayer(state, 'layer-3', { toggle: true })
    expect(state.present.selectedId).toBe('layer-1')
    state = selectEditorLayer(state, 'layer-1', { toggle: true })
    expect(state.present.selectedId).toBeNull()
    expect(selectedEditorLayerIds(state.present)).toEqual([])
    expect(selectEditorLayer(state, null).past).toHaveLength(0)
  })
  it('keeps existing redo history when selection changes and normalizes old creation helpers', () => {
    let state = undoLayerEditor(patchEditorLayer(initial(3), 'layer-1', { x: .75 }))
    state = choose(state, 'layer-1', 'layer-2')
    expect(state.future).toHaveLength(1)
    const duplicate = duplicateEditorLayer(state, 'layer-1')
    expect(selectedEditorLayerIds(duplicate.present)).toEqual([duplicate.present.selectedId])
    expect(duplicate.present.anchorId).toBe(duplicate.present.selectedId)
    const added = addEditorLayer(state, 'text')
    expect(selectedEditorLayerIds(added.present)).toEqual([added.present.selectedId])
    expect(deleteEditorLayer(state, 'layer-2').present.selectedIds).not.toContain('layer-2')
  })
})

describe('atomic editor layer batches', () => {
  it('updates visibility and locks in one history entry while leaving all other layers untouched', () => {
    const state = choose(initial(), 'layer-1', 'layer-3'), before = state.present.recipe.layers
    const next = patchEditorLayers(state, selectedEditorLayerIds(state.present), { visible: false, locked: true })
    expect(next.past).toHaveLength(1)
    expect(next.present.recipe.layers[0]).toMatchObject({ visible: false, locked: true })
    expect(next.present.recipe.layers[2]).toMatchObject({ visible: false, locked: true })
    expect(next.present.recipe.layers[1]).toBe(before[1])
    expect(undoLayerEditor(next).present).toEqual(state.present)
    expect(redoLayerEditor(undoLayerEditor(next)).present).toEqual(next.present)
    expect(patchEditorLayers(next, ['layer-1', 'layer-3'], { visible: true }).present.recipe.layers[0].visible).toBe(true)
  })
  it.each(['delete', 'move', 'reorder'] as const)('rejects the entire %s batch when any selected member is locked', (operation) => {
    const state = choose(patchEditorLayer(initial(), 'layer-3', { locked: true }), 'layer-1', 'layer-3'), before = structuredClone(state)
    const ids = selectedEditorLayerIds(state.present)
    expect(() => operation === 'delete' ? deleteEditorLayers(state, ids) : operation === 'move' ? moveEditorLayers(state, ids, 50, 40) : reorderEditorLayers(state, ids, 1)).toThrow('锁定')
    expect(state).toEqual(before)
  })
  it('deletes all chosen layers once, restores their selection and never resumes automatic sources', () => {
    const state = choose(initial(3), 'layer-1', 'layer-3'), next = deleteEditorLayers(state, ['layer-1', 'layer-3'])
    expect(next.present.ids).toEqual(['layer-2'])
    expect(next.present.selectedId).toBe('layer-2')
    expect(next.past).toHaveLength(1)
    expect(undoLayerEditor(next).present).toEqual(state.present)
    const empty = deleteEditorLayers(choose(initial(2), 'layer-1', 'layer-2'), ['layer-1', 'layer-2'])
    expect(empty.present).toMatchObject({ ids: [], selectedIds: [], selectedId: null, recipe: { layers: [], explicitLayers: true } })
  })
  it('duplicates selected layers immediately above each original with independent content and unlocked copies', () => {
    let state = addEditorLayer(initial(2), 'text')
    state = choose(patchEditorLayer(state, state.present.selectedId!, { locked: true }), 'layer-1', 'layer-3')
    const next = duplicateEditorLayers(state, selectedEditorLayerIds(state.present))
    expect(next.present.ids).toEqual(['layer-1', 'layer-4', 'layer-2', 'layer-3', 'layer-5'])
    expect(selectedEditorLayerIds(next.present)).toEqual(['layer-4', 'layer-5'])
    expect(next.present.selectedId).toBe('layer-5')
    expect(next.present.recipe.layers[4].content).toEqual(state.present.recipe.layers[2].content)
    expect(next.present.recipe.layers[4].content).not.toBe(state.present.recipe.layers[2].content)
    expect(next.present.recipe.layers[4].locked).toBe(false)
    expect(next.past.length - state.past.length).toBe(1)
    expect(undoLayerEditor(next).present).toEqual(state.present)
  })
  it('rejects partial duplication at the twenty-layer cap and stale IDs without changing sequence', () => {
    const state = initial(19), before = structuredClone(state)
    expect(() => duplicateEditorLayers(state, ['layer-1', 'layer-2'])).toThrow('20')
    expect(() => deleteEditorLayers(state, ['layer-1', 'gone'])).toThrow('已变化')
    expect(duplicateEditorLayers(state, ['layer-1']).present.ids).toHaveLength(20)
    expect(state).toEqual(before)
  })
  it('moves disjoint selected runs one stack slot while preserving both relative orders and primary selection', () => {
    const state = choose(initial(6), 'layer-1', 'layer-2', 'layer-4')
    const next = reorderEditorLayers(state, selectedEditorLayerIds(state.present), 1)
    expect(next.present.ids).toEqual(['layer-3', 'layer-1', 'layer-2', 'layer-5', 'layer-4', 'layer-6'])
    expect(selectedEditorLayerIds(next.present)).toEqual(['layer-1', 'layer-2', 'layer-4'])
    expect(next.present.selectedId).toBe('layer-4')
    expect(reorderEditorLayers(next, selectedEditorLayerIds(next.present), -1).present.ids).toEqual(state.present.ids)
    expect(next.past).toHaveLength(1)
    for (const id of state.present.ids) expect(next.present.recipe.layers[next.present.ids.indexOf(id)]).toBe(state.present.recipe.layers[state.present.ids.indexOf(id)])
  })
  it('blocks the entire reorder at an edge or locked neighbour', () => {
    const state = choose(initial(), 'layer-2', 'layer-5')
    expect(reorderEditorLayers(state, ['layer-2', 'layer-5'], 1)).toBe(state)
    const locked = patchEditorLayer(initial(), 'layer-3', { locked: true })
    expect(() => reorderEditorLayers(locked, ['layer-1', 'layer-2'], 1)).toThrow('经过锁定')
  })
  it('keeps geometry fixed under group clamping and coalesces pointer updates into one outer transaction', () => {
    const state = choose(initial(3), 'layer-1', 'layer-3'), selected = selectedEditorLayerIds(state.present)
    let next = beginLayerEditorTransaction(state)
    next = moveEditorLayers(next, selected, 10, -8)
    next = moveSelectedEditorLayers(next, 10, -8)
    expect(next.past).toHaveLength(0)
    expect(next.transaction).toBe(state.present)
    expect(next.present.recipe.layers[0]).toMatchObject({ x: .02, y: -.02 })
    expect(next.present.recipe.layers[1]).toBe(state.present.recipe.layers[1])
    next = finishLayerEditorTransaction(next)
    expect(next.past).toHaveLength(1)
    expect(undoLayerEditor(next).present).toEqual(state.present)
    const far = moveEditorLayers(state, selected, 1e10, 1e10)
    expect(far.present.recipe.layers[2].x).toBeCloseTo(8192 / 1000)
    expect(far.present.recipe.layers[2].x - far.present.recipe.layers[0].x).toBeCloseTo(.2)
    expect(() => moveEditorLayers(state, selected, NaN, 1)).toThrow('无效')
  })
})

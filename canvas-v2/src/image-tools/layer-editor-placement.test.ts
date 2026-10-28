import { describe, expect, it } from 'vitest'
import { addEditorLayer, beginLayerEditorTransaction, createLayerEditorState, defaultEditorImageLayer, finishLayerEditorTransaction, groupEditorLayers, moveEditorLayerNodes, patchEditorGroup, patchEditorLayer, redoLayerEditor, selectEditorGroup, selectEditorLayer, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { buildEditorLayerNodeMove } from './layer-editor-placement'
import { parseImageTransformRecipe } from './recipe'

function initial(count = 6): LayerEditorState { return createLayerEditorState({ kind: 'layer', outputWidth: 64, outputHeight: 48, background: 'transparent', explicitLayers: true, layers: Array.from({ length: count }, (_, sourceIndex) => ({ ...defaultEditorImageLayer(sourceIndex), x: sourceIndex / 100, opacity: .5, blend: sourceIndex % 2 ? 'multiply' : 'source-over', name: `Leaf ${sourceIndex + 1}` })) }, count) }
function choose(state: LayerEditorState, ...ids: string[]): LayerEditorState { let next = selectEditorLayer(state, null); for (const id of ids) next = selectEditorLayer(next, id, { toggle: true }); return next }
function grouped(): LayerEditorState { let state = groupEditorLayers(choose(initial(), 'layer-1', 'layer-2'), 'Low'); state = groupEditorLayers(choose(state, 'layer-4', 'layer-5'), 'High'); return state }
function unchangedLeaves(before: LayerEditorState, after: LayerEditorState): void { for (const id of before.present.ids) expect(after.present.recipe.layers[after.present.ids.indexOf(id)]).toBe(before.present.recipe.layers[before.present.ids.indexOf(id)]) }

describe('atomic persistent layer tree placement', () => {
  it('moves selected sibling leaves before and after array targets with one reversible edit', () => {
    const state = choose(initial(), 'layer-2', 'layer-4'), next = moveEditorLayerNodes(state, 'layer-6', 'after')
    expect(next.present.ids).toEqual(['layer-1', 'layer-3', 'layer-5', 'layer-6', 'layer-2', 'layer-4'])
    expect(next.past).toHaveLength(1); unchangedLeaves(state, next)
    expect(undoLayerEditor(next).present).toEqual(state.present); expect(redoLayerEditor(undoLayerEditor(next)).present).toEqual(next.present)
    expect(moveEditorLayerNodes(state, 'layer-1', 'before').present.ids).toEqual(['layer-2', 'layer-4', 'layer-1', 'layer-3', 'layer-5', 'layer-6'])
  })
  it('moves a partial folder leaf into another folder without reparenting any other member', () => {
    const state = choose(grouped(), 'layer-2'), next = moveEditorLayerNodes(state, 'group-2', 'inside')
    expect(next.present.ids).toEqual(['layer-1', 'layer-3', 'layer-4', 'layer-5', 'layer-2', 'layer-6'])
    expect(next.present.recipe.layerGroups!.groups.map((group) => [group.id, group.children])).toEqual([['group-1', ['layer-1']], ['group-2', ['layer-4', 'layer-5', 'layer-2']]])
    unchangedLeaves(state, next); expect(parseImageTransformRecipe(next.present.recipe)).toEqual(next.present.recipe)
  })
  it('lets a directly selected single leaf escape a single-leaf wrapper and prunes only empty folders', () => {
    const wrapped = groupEditorLayers(selectEditorLayer(initial(), 'layer-2'), 'Single'), state = selectEditorLayer(wrapped, 'layer-2'), next = moveEditorLayerNodes(state, null, 'inside')
    expect(next.present.ids).toEqual(['layer-1', 'layer-3', 'layer-4', 'layer-5', 'layer-6', 'layer-2'])
    expect(next.present.recipe).not.toHaveProperty('layerGroups'); expect(next.present.selectedGroupId).toBeNull(); unchangedLeaves(state, next)
  })
  it('retains an explicit nested folder subtree and stable identities when moving into another group', () => {
    const state = groupEditorLayers(selectEditorGroup(grouped(), 'group-1'), 'Outer'), next = moveEditorLayerNodes(state, 'group-2', 'inside')
    expect(next.present.ids).toEqual(['layer-3', 'layer-4', 'layer-5', 'layer-1', 'layer-2', 'layer-6'])
    expect(next.present.recipe.layerGroups!.groups.find((group) => group.id === 'group-2')!.children).toEqual(['layer-4', 'layer-5', 'group-3'])
    expect(next.present.recipe.layerGroups!.groups.find((group) => group.id === 'group-3')!.children).toEqual(['group-1'])
    expect(next.present.selectedGroupId).toBe('group-3'); unchangedLeaves(state, next)
  })
  it('normalizes complete branches in a mixed selection without moving an ancestor twice', () => {
    const state = choose(grouped(), 'layer-1', 'layer-2', 'layer-4'), next = moveEditorLayerNodes(state, 'layer-6', 'after')
    expect(next.present.ids).toEqual(['layer-3', 'layer-5', 'layer-6', 'layer-1', 'layer-2', 'layer-4'])
    expect(next.present.recipe.layerGroups!.groups.find((group) => group.id === 'group-1')!.children).toEqual(['layer-1', 'layer-2'])
    expect(next.present.recipe.layerGroups!.groups.find((group) => group.id === 'group-2')!.children).toEqual(['layer-5'])
    unchangedLeaves(state, next)
  })
  it('uses whole sibling block targets rather than inserting into an unrelated folder interval', () => {
    const state = choose(grouped(), 'layer-3'), before = moveEditorLayerNodes(state, 'group-2', 'before'), after = moveEditorLayerNodes(state, 'group-2', 'after')
    expect(before).toBe(state)
    expect(after.present.ids).toEqual(['layer-1', 'layer-2', 'layer-4', 'layer-5', 'layer-3', 'layer-6'])
    expect(after.present.recipe.layerGroups!.groups[1].children).toEqual(['layer-4', 'layer-5'])
  })
  it.each(['self', 'descendant', 'descendant-before', 'descendant-after'] as const)('rejects %s cycles atomically', (kind) => {
    const state = groupEditorLayers(selectEditorGroup(grouped(), 'group-1'), 'Outer'), before = structuredClone(state)
    const target = kind === 'self' ? 'group-3' : 'layer-1', position = kind === 'descendant-before' ? 'before' : kind === 'descendant-after' ? 'after' : 'inside'
    expect(() => moveEditorLayerNodes(state, target, position)).toThrow('自身'); expect(state).toEqual(before)
  })
  it.each(['selected-own', 'selected-ancestor', 'selected-descendant', 'destination', 'crossed-locked'] as const)('preserves %s protection', (kind) => {
    let state = grouped(), target: string | null = null
    if (kind === 'selected-own') state = choose(patchEditorLayer(state, 'layer-2', { locked: true }), 'layer-2')
    if (kind === 'selected-ancestor') state = choose(patchEditorGroup(state, 'group-1', { locked: true }), 'layer-2')
    if (kind === 'selected-descendant') state = selectEditorGroup(patchEditorLayer(state, 'layer-2', { locked: true }), 'group-1')
    if (kind === 'destination') { state = choose(patchEditorGroup(state, 'group-2', { locked: true }), 'layer-2'); target = 'group-2' }
    if (kind === 'crossed-locked') state = choose(patchEditorLayer(state, 'layer-3', { locked: true }), 'layer-2')
    const before = structuredClone(state)
    expect(() => moveEditorLayerNodes(state, target, 'inside')).toThrow('锁定'); expect(state).toEqual(before)
  })
  it('preserves own visibility flags and source identities when inheritance changes at the destination', () => {
    const state = choose(patchEditorGroup(grouped(), 'group-2', { visible: false }), 'layer-2'), next = moveEditorLayerNodes(state, 'group-2', 'inside')
    unchangedLeaves(state, next); expect(next.present.recipe.layers[next.present.ids.indexOf('layer-2')].visible).toBe(true)
    expect(next.present.recipe.layerGroups!.groups.find((group) => group.id === 'group-2')!.visible).toBe(false)
  })
  it('rejects nesting overflow without losing any moved or unselected content', () => {
    let state = groupEditorLayers(selectEditorLayer(initial(), 'layer-1'), 'Depth one')
    for (let depth = 0; depth < 3; depth++) state = groupEditorLayers(state)
    state = groupEditorLayers(selectEditorLayer(state, 'layer-2'), 'Moving folder')
    const before = structuredClone(state)
    expect(() => moveEditorLayerNodes(state, 'group-1', 'inside')).toThrow('4 层'); expect(state).toEqual(before)
    const valid = moveEditorLayerNodes(state, 'group-2', 'inside'); expect(parseImageTransformRecipe(valid.present.recipe)).toEqual(valid.present.recipe)
  })
  it.each(['same-end', 'same-neighbour', 'selected-target', 'empty-selection'] as const)('does not allocate history or a source for %s no-op', (kind) => {
    const base = initial(), state = kind === 'empty-selection' ? selectEditorLayer(base, null) : selectEditorLayer(base, kind === 'same-neighbour' ? 'layer-2' : 'layer-6')
    const next = moveEditorLayerNodes(state, kind === 'same-end' || kind === 'empty-selection' ? null : kind === 'same-neighbour' ? 'layer-3' : 'layer-6', kind === 'same-end' || kind === 'empty-selection' ? 'inside' : 'before')
    expect(next).toBe(state)
  })
  it.each(['unknown-target', 'leaf-inside', 'root-before', 'duplicate-source'] as const)('rejects %s before any persistent change', (kind) => {
    const state = selectEditorLayer(grouped(), 'layer-2'), before = structuredClone(state)
    expect(() => kind === 'duplicate-source' ? buildEditorLayerNodeMove(state.present, ['group-1', 'layer-1'], null, 'inside') : moveEditorLayerNodes(state, kind === 'unknown-target' ? 'missing' : kind === 'root-before' ? null : 'layer-3', kind === 'root-before' ? 'before' : 'inside')).toThrow()
    expect(state).toEqual(before)
  })
  it('coalesces within an explicitly open transaction and keeps existing undo boundaries', () => {
    const state = selectEditorLayer(initial(), 'layer-2'), pending = beginLayerEditorTransaction(state), moved = moveEditorLayerNodes(pending, null, 'inside')
    expect(moved.past).toHaveLength(0); expect(moved.transaction).toBe(state.present)
    expect(finishLayerEditorTransaction(moved).past).toEqual([state.present])
  })
  it('reparents within the existing 20-leaf and source bounds without allocating new identities', () => {
    const state = selectEditorLayer(groupEditorLayers(choose(initial(20), 'layer-1', 'layer-2')), 'layer-3'), next = moveEditorLayerNodes(state, 'group-1', 'inside')
    expect(next.present.ids).toHaveLength(20); expect(next.sequence).toBe(state.sequence); expect(next.present.recipe.layers.map((layer) => layer.sourceIndex).sort((a, b) => a - b)).toEqual([...Array(20).keys()])
    expect(addEditorLayer(next, 'image', 0)).toBe(next)
  })
  it('preserves all unselected mutual order and leaf objects across every leaf-to-sibling target', () => {
    const base = grouped()
    let changes = 0
    for (const sourceId of base.present.ids) for (const targetId of [...base.present.ids, 'group-1', 'group-2']) for (const position of ['before', 'after'] as const) {
      const state = selectEditorLayer(base, sourceId), next = moveEditorLayerNodes(state, targetId, position)
      if (next === state) continue
      expect(next.present.ids.filter((id) => id !== sourceId)).toEqual(base.present.ids.filter((id) => id !== sourceId))
      unchangedLeaves(state, next); expect(parseImageTransformRecipe(next.present.recipe)).toEqual(next.present.recipe)
      expect(undoLayerEditor(next).present).toEqual(state.present); changes++
    }
    expect(changes).toBeGreaterThan(60)
  })
})

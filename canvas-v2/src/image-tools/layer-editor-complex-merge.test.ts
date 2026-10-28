import { describe, expect, it } from 'vitest'
import { buildEditorLayerMergeCandidate, buildEditorLayerMergePlan, commitEditorLayerMerge } from './layer-editor-merge'
import { createLayerEditorState, defaultEditorImageLayer, groupEditorLayers, nextEditorLayerIdentity, patchEditorGroup, patchEditorLayer, redoLayerEditor, selectEditorGroup, selectEditorLayer, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { parseImageTransformRecipe } from './recipe'

function initial(): LayerEditorState { return createLayerEditorState({ kind: 'layer', outputWidth: 40, outputHeight: 30, background: '#102030', explicitLayers: true, layers: Array.from({ length: 6 }, (_, sourceIndex) => ({ ...defaultEditorImageLayer(sourceIndex), name: String(sourceIndex) })) }, 6) }
function choose(state: LayerEditorState, ...ids: string[]): LayerEditorState { let next = selectEditorLayer(state, null); for (const id of ids) next = selectEditorLayer(next, id, { toggle: true }); return next }
function twoGroups(): LayerEditorState { let state = groupEditorLayers(choose(initial(), 'layer-1', 'layer-2'), 'Low'); state = groupEditorLayers(choose(state, 'layer-4', 'layer-5'), 'High'); return state }
function candidate(state: LayerEditorState, placement: 'upper' | 'lower' = 'upper') { const plan = buildEditorLayerMergePlan(state.present, { placement }); return { plan, value: buildEditorLayerMergeCandidate(plan, { sourceIndex: 6, replacementId: nextEditorLayerIdentity(state).id }) } }

describe('explicit complex selected-layer merge candidates', () => {
  it('offers distinct upper and lower candidates around an untouched interleaving layer', () => {
    const state = choose(initial(), 'layer-2', 'layer-4'), before = structuredClone(state), upper = candidate(state), lower = candidate(state, 'lower')
    expect(upper.plan.placement).toBe('upper'); expect(lower.plan.placement).toBe('lower')
    expect(upper.value.ids).toEqual(['layer-1', 'layer-3', 'layer-7', 'layer-5', 'layer-6'])
    expect(lower.value.ids).toEqual(['layer-1', 'layer-7', 'layer-3', 'layer-5', 'layer-6'])
    expect(upper.value.insertionIndex).toBe(2); expect(lower.value.insertionIndex).toBe(1)
    expect(upper.plan.rasterRecipe.layers).toEqual([state.present.recipe.layers[1], state.present.recipe.layers[3]])
    expect(state).toEqual(before)
  })
  it.each(['multiply', 'screen', 'overlay'] as const)('retains the selected %s blend in its transparent raster without baking unselected backdrop', (blend) => {
    const state = patchEditorLayer(choose(initial(), 'layer-2', 'layer-4'), 'layer-2', { blend }), { plan, value } = candidate(state)
    expect(plan.rasterRecipe.layers[0].blend).toBe(blend); expect(plan.rasterRecipe.background).toBe('transparent')
    expect(value.recipe.layers.find((layer) => layer.sourceIndex === 6)).toMatchObject({ blend: 'source-over', opacity: 1 })
    for (const id of ['layer-1', 'layer-3', 'layer-5', 'layer-6']) expect(value.recipe.layers[value.ids.indexOf(id)]).toBe(state.present.recipe.layers[state.present.ids.indexOf(id)])
  })
  it('uses whole LCA child block boundaries for partially selected cross-parent groups', () => {
    const state = choose(twoGroups(), 'layer-2', 'layer-4'), upper = candidate(state), lower = candidate(state, 'lower')
    expect(upper.value.groupParentId).toBeNull(); expect(lower.value.groupParentId).toBeNull()
    expect(upper.value.ids).toEqual(['layer-1', 'layer-3', 'layer-5', 'layer-7', 'layer-6'])
    expect(lower.value.ids).toEqual(['layer-7', 'layer-1', 'layer-3', 'layer-5', 'layer-6'])
    for (const value of [upper.value, lower.value]) {
      expect(value.recipe.layerGroups!.groups.map((group) => [group.id, group.children])).toEqual([['group-1', ['layer-1']], ['group-2', ['layer-5']]])
      expect(value.removedGroupIds).toEqual([]); expect(parseImageTransformRecipe(value.recipe)).toEqual(value.recipe)
    }
  })
  it('retains an inner common ancestor without moving any unaffected outside branch', () => {
    let state = groupEditorLayers(selectEditorGroup(twoGroups(), 'group-1'), 'Outer low')
    state = groupEditorLayers(choose(state, 'layer-1', 'layer-2', 'layer-3', 'layer-4', 'layer-5'), 'Outer all')
    const selected = choose(state, 'layer-2', 'layer-4'), value = candidate(selected).value
    expect(value.groupParentId).toBe('group-4')
    expect(value.recipe.layerGroups!.groups.find((group) => group.id === 'group-4')!.children).toEqual(['group-3', 'layer-3', 'group-2', 'layer-7'])
    expect(value.recipe.layers.at(-1)).toBe(state.present.recipe.layers.at(-1))
  })
  it('preserves directly selected leaf folders and consumes an explicitly selected whole folder', () => {
    const grouped = groupEditorLayers(choose(initial(), 'layer-1', 'layer-2'), 'Folder')
    const direct = candidate(choose(grouped, 'layer-1', 'layer-2')).value, whole = candidate(grouped).value
    expect(direct.groupParentId).toBe('group-1'); expect(direct.recipe.layerGroups!.groups[0].children).toEqual(['layer-7']); expect(direct.removedGroupIds).toEqual([])
    expect(whole.groupParentId).toBeNull(); expect(whole.recipe).not.toHaveProperty('layerGroups'); expect(whole.removedGroupIds).toEqual(['group-1'])
  })
  it('commits the exact candidate with a single undo/redo while preserving all unselected identities and objects', () => {
    const state = choose(twoGroups(), 'layer-2', 'layer-4'), { plan, value } = candidate(state), next = commitEditorLayerMerge(state, plan, 6, value)
    expect(next.present.ids).toEqual(value.ids); expect(next.present.recipe).toEqual(value.recipe); expect(next.past).toHaveLength(state.past.length + 1)
    expect(undoLayerEditor(next).present).toEqual(state.present); expect(redoLayerEditor(undoLayerEditor(next)).present).toEqual(next.present)
  })
  it.each(['placement', 'index', 'parent', 'recipe', 'id', 'source', 'candidate-order'] as const)('rejects changed %s without consuming history or identity', (change) => {
    const state = choose(twoGroups(), 'layer-2', 'layer-4'), { plan, value } = candidate(state), before = structuredClone(state)
    if (change === 'placement') plan.placement = 'lower'
    if (change === 'index') plan.insertionIndex++
    if (change === 'parent') plan.groupParentId = 'group-1'
    if (change === 'recipe') plan.rasterRecipe = { ...plan.rasterRecipe, background: '#ffffff' }
    if (change === 'id') value.replacementId = 'already-wrong'
    if (change === 'source') value.sourceIndex = 7
    if (change === 'candidate-order') value.ids.reverse()
    expect(() => commitEditorLayerMerge(state, plan, 6, value)).toThrow(); expect(state).toEqual(before)
  })
  it.each(['hidden', 'locked', 'inherited-hidden', 'inherited-locked'] as const)('keeps %s content protected before candidate creation', (kind) => {
    let state = choose(twoGroups(), 'layer-2', 'layer-4')
    if (kind === 'hidden' || kind === 'locked') state = patchEditorLayer(state, 'layer-2', kind === 'hidden' ? { visible: false } : { locked: true })
    else state = patchEditorGroup(state, 'group-1', kind === 'inherited-hidden' ? { visible: false } : { locked: true })
    expect(() => candidate(state)).toThrow(kind.includes('hidden') ? '隐藏' : '锁定')
  })
  it('rejects colliding replacement identities and source overflow before changing a document', () => {
    const state = choose(twoGroups(), 'layer-2', 'layer-4'), { plan } = candidate(state)
    for (const replacementId of ['layer-1', 'layer-2', 'group-1', '../invalid', '']) expect(() => buildEditorLayerMergeCandidate(plan, { sourceIndex: 6, replacementId })).toThrow()
    expect(() => buildEditorLayerMergeCandidate(plan, { sourceIndex: 20, replacementId: 'fresh' })).toThrow('20')
  })
  it('keeps every unselected leaf and retained folder valid for all multi-leaf subsets across nested parents', () => {
    const base = groupEditorLayers(selectEditorGroup(twoGroups(), 'group-1'), 'Nested low')
    let checked = 0
    for (let bits = 1; bits < 64; bits++) {
      const ids = base.present.ids.filter((_, index) => bits & 1 << index)
      if (ids.length < 2) continue
      const state = choose(base, ...ids), untouched = base.present.ids.filter((id) => !ids.includes(id))
      for (const placement of ['upper', 'lower'] as const) {
        const { plan, value } = candidate(state, placement)
        expect(value.ids.filter((id) => id !== value.replacementId)).toEqual(untouched)
        expect(value.ids).toHaveLength(base.present.ids.length - ids.length + 1)
        for (const id of untouched) expect(value.recipe.layers[value.ids.indexOf(id)]).toBe(base.present.recipe.layers[base.present.ids.indexOf(id)])
        expect(parseImageTransformRecipe(value.recipe)).toEqual(value.recipe)
        const next = commitEditorLayerMerge(state, plan, 6, value)
        expect(undoLayerEditor(next).present).toEqual(state.present)
        checked++
      }
    }
    expect(checked).toBe(114)
  })
})

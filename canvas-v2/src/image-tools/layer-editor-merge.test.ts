import { describe, expect, it } from 'vitest'
import { buildEditorLayerMergePlan, commitEditorLayerMerge, isCurrentEditorLayerMergePlan } from './layer-editor-merge'
import { createLayerEditorState, defaultEditorImageLayer, patchEditorLayer, redoLayerEditor, selectEditorLayer, undoLayerEditor } from './layer-editor-state'
import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

function initial() {
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 1000, outputHeight: 800, explicitLayers: true, background: '#abcdef', layers: Array.from({ length: 5 }, (_, sourceIndex) => ({ ...defaultEditorImageLayer(sourceIndex), opacity: .5, name: `${sourceIndex}` })) }
  return selectEditorLayer(selectEditorLayer(createLayerEditorState(recipe, 5), 'layer-2'), 'layer-3', { range: true })
}

describe('contiguous layer merge plan and protected content', () => {
  it('renders only chosen layers in original bottom-to-top order without baking the background', () => {
    const state = initial(), plan = buildEditorLayerMergePlan(state.present)
    expect(plan.selectedIds).toEqual(['layer-2', 'layer-3'])
    expect(plan.insertionIndex).toBe(1)
    expect(plan.rasterRecipe.background).toBe('transparent')
    expect(plan.rasterRecipe.layers).toEqual(state.present.recipe.layers.slice(1, 3))
    expect(plan.rasterRecipe.layers.map((layer) => layer.opacity)).toEqual([.5, .5])
    expect([plan.width, plan.height]).toEqual([1000, 800])
    expect(plan.replacement).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
  it('replaces the run at its bottom stack position, keeps unselected objects and records exactly one reversible step', () => {
    const state = initial(), plan = buildEditorLayerMergePlan(state.present), next = commitEditorLayerMerge(state, plan, 5)
    expect(next.present.ids).toEqual(['layer-1', 'layer-6', 'layer-4', 'layer-5'])
    expect(next.present.recipe.layers[1]).toMatchObject({ sourceIndex: 5, x: 0, y: 0, width: 1, height: 1, opacity: 1, rotation: 0, visible: true, locked: false, blend: 'source-over' })
    expect(next.present.recipe.background).toBe('#abcdef')
    expect(next.present.recipe.layers[0]).toBe(state.present.recipe.layers[0])
    expect(next.present.recipe.layers[2]).toBe(state.present.recipe.layers[3])
    expect(next.present.recipe.layers[3]).toBe(state.present.recipe.layers[4])
    expect(next.present).toMatchObject({ selectedId: 'layer-6', selectedIds: ['layer-6'], anchorId: 'layer-6' })
    expect(next.past).toHaveLength(1)
    expect(undoLayerEditor(next).present).toEqual(state.present)
    expect(redoLayerEditor(undoLayerEditor(next)).present).toEqual(next.present)
    expect(parseImageTransformRecipe(next.present.recipe)).toEqual(next.present.recipe)
    expect(next.present.recipe).not.toHaveProperty('selectedIds')
  })
  it('retains the complete original replay frame and exact crop offset instead of clipping preserved pixels', () => {
    const state = initial()
    state.present.recipe.outputWidth = 400; state.present.recipe.outputHeight = 300
    state.present.recipe.documentFrame = { version: 1, width: 1000, height: 800, offsetX: 200, offsetY: 250 }
    const plan = buildEditorLayerMergePlan(state.present)
    expect([plan.width, plan.height]).toEqual([1000, 800])
    expect(plan.rasterRecipe.documentFrame).toBeUndefined()
    expect(plan.rasterRecipe.layers[0]).toMatchObject({ x: .2, y: 250 / 800, width: .4, height: 300 / 800 })
    expect(plan.replacement).toEqual({ x: -.5, y: -250 / 300, width: 2.5, height: 800 / 300 })
    const next = commitEditorLayerMerge(state, plan, 5)
    expect(next.present.recipe.documentFrame).toEqual(state.present.recipe.documentFrame)
    expect(parseImageTransformRecipe(next.present.recipe)).toEqual(next.present.recipe)
  })
  it.each(['locked', 'hidden', 'single'] as const)('refuses %s without dropping or modifying any layer', (reason) => {
    let state = initial()
    if (reason === 'locked') state = patchEditorLayer(state, 'layer-2', { locked: true })
    if (reason === 'hidden') state = patchEditorLayer(state, 'layer-2', { visible: false })
    if (reason === 'single') state = selectEditorLayer(state, 'layer-2')
    const before = structuredClone(state)
    expect(() => buildEditorLayerMergePlan(state.present)).toThrow()
    expect(state).toEqual(before)
  })
  it.each(['selection', 'primary', 'recipe', 'ids', 'document', 'undo'] as const)('rejects a late result after %s changes', (reason) => {
    const state = initial(), plan = buildEditorLayerMergePlan(state.present)
    let next = state
    if (reason === 'selection') next = selectEditorLayer(state, 'layer-1', { toggle: true })
    if (reason === 'primary') next = selectEditorLayer(state, 'layer-2', { range: true })
    if (reason === 'recipe') next = patchEditorLayer(state, 'layer-5', { name: 'changed' })
    if (reason === 'ids') next = { ...state, present: { ...state.present, ids: [...state.present.ids] } }
    if (reason === 'document') next = { ...state, present: { ...state.present } }
    if (reason === 'undo') next = undoLayerEditor(patchEditorLayer(state, 'layer-5', { name: 'changed' }))
    // Undo can intentionally restore the exact immutable snapshot; UI epoch /
    // AbortSignal cancels a job that crosses that history roundtrip.
    if (reason === 'undo') { expect(isCurrentEditorLayerMergePlan(next.present, plan)).toBe(true); return }
    expect(isCurrentEditorLayerMergePlan(next.present, plan)).toBe(false)
    expect(() => commitEditorLayerMerge(next, plan, 5)).toThrow('已变化')
  })
  it('rejects stale capacity and altered prepared geometry before replacing any layer', () => {
    const state = initial(), plan = buildEditorLayerMergePlan(state.present)
    expect(() => commitEditorLayerMerge(state, plan, 20)).toThrow('20')
    plan.replacement.x = .5
    expect(() => commitEditorLayerMerge(state, plan, 5)).toThrow('参数已变化')
    expect(state.present.recipe.layers).toHaveLength(5)
  })
})

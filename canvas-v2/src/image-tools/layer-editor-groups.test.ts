import { describe, expect, it } from 'vitest'
import { addEditorLayer, appendEditorCustomLayer, beginLayerEditorTransaction, createLayerEditorState, defaultEditorImageLayer, deleteEditorGroup, deleteEditorLayer, deleteEditorLayers, duplicateEditorGroup, duplicateEditorLayer, duplicateEditorLayers, editorLayerEffectiveState, editorLayerTreeRows, finishLayerEditorTransaction, groupEditorLayers, moveEditorGroup, moveEditorLayers, patchEditorGroup, patchEditorLayer, patchEditorLayers, redoLayerEditor, reorderEditorGroup, reorderEditorLayers, selectEditorGroup, selectEditorLayer, selectedEditorGroup, undoLayerEditor, ungroupEditorGroup, type LayerEditorState } from './layer-editor-state'
import { buildEditorLayerMergePlan, commitEditorLayerMerge } from './layer-editor-merge'
import { cropLayerDocumentRecipe } from './layer-document-crop'
import { materializeImageLayerGroups } from './layer-group-model'
import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

function initial(count = 4): LayerEditorState {
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 1000, outputHeight: 800, explicitLayers: true, background: 'transparent', layers: Array.from({ length: count }, (_, index) => ({ ...defaultEditorImageLayer(index), name: `叶 ${index + 1}`, x: index / 10 })) }
  return createLayerEditorState(recipe, count)
}
function choose(state: LayerEditorState, ...ids: string[]): LayerEditorState {
  let next = selectEditorLayer(state, ids[0] ?? null)
  for (const id of ids.slice(1)) next = selectEditorLayer(next, id, { toggle: true })
  return next
}
function grouped(): LayerEditorState { return groupEditorLayers(choose(initial(), 'layer-1', 'layer-2'), '产品') }

describe('persistent layer group editing', () => {
  it('groups without changing any leaf identity, object, geometry, content, blend or order and reopens persistently', () => {
    const before = choose(initial(), 'layer-1', 'layer-2'), grouped = groupEditorLayers(before, '产品')
    expect(grouped.present.ids).toEqual(before.present.ids)
    grouped.present.recipe.layers.forEach((layer, index) => expect(layer).toBe(before.present.recipe.layers[index]))
    expect(grouped.present).toMatchObject({ selectedId: null, selectedGroupId: 'group-1', selectedIds: ['layer-1', 'layer-2'] })
    expect(grouped.past).toHaveLength(1)
    expect(undoLayerEditor(grouped).present).toEqual(before.present)
    expect(redoLayerEditor(undoLayerEditor(grouped)).present).toEqual(grouped.present)
    const reopened = createLayerEditorState(parseImageTransformRecipe(grouped.present.recipe) as ImageLayerRecipe, 4)
    expect(reopened.present.ids).toEqual(grouped.present.ids)
    expect(reopened.present.recipe).toEqual(grouped.present.recipe)
  })
  it('returns top-to-bottom hierarchical rows while group selection is outside leaf parameter identity', () => {
    const state = grouped(), group = selectedEditorGroup(state.present)!
    expect(editorLayerTreeRows(state.present).map((row) => [row.id, row.depth])).toEqual([['layer-4', 0], ['layer-3', 0], [group.id, 0], ['layer-2', 1], ['layer-1', 1]])
    const leaf = selectEditorLayer(state, 'layer-1')
    expect(leaf.present.selectedId).toBe('layer-1')
    expect(selectedEditorGroup(leaf.present)).toBeNull()
    expect(selectEditorGroup(leaf, group.id).past).toHaveLength(1)
  })
  it('rejects disjoint or cross-parent grouping atomically and permits a single leaf or folder wrapper', () => {
    const state = initial(), before = structuredClone(state)
    expect(() => groupEditorLayers(choose(state, 'layer-1', 'layer-3'))).toThrow('连续')
    const group = grouped()
    expect(() => groupEditorLayers(choose(group, 'layer-2', 'layer-3'))).toThrow('同一父级')
    expect(groupEditorLayers(selectEditorLayer(state, 'layer-2')).present.recipe.layerGroups!.groups[0].children).toEqual(['layer-2'])
    const nested = groupEditorLayers(group)
    expect(nested.present.recipe.layerGroups!.groups.at(-1)!.children).toEqual(['group-1'])
    expect(state).toEqual(before)
  })
  it('retains child flags through hide/show and lock/unlock, with inherited lock enforced at leaf mutation boundary', () => {
    let state = grouped()
    state = patchEditorLayer(state, 'layer-1', { visible: false })
    const own = structuredClone(state.present.recipe.layers)
    state = patchEditorGroup(state, 'group-1', { visible: false, locked: true })
    expect(editorLayerEffectiveState(state.present, 'layer-2')).toMatchObject({ visible: false, locked: true, ownVisible: true, ownLocked: false })
    expect(patchEditorLayer(state, 'layer-2', { x: .8 })).toBe(state)
    const ownToggle = patchEditorLayer(state, 'layer-2', { visible: false, locked: true })
    expect(ownToggle.present.recipe.layers[1]).toMatchObject({ visible: false, locked: true })
    expect(editorLayerEffectiveState(ownToggle.present, 'layer-2').locked).toBe(true)
    expect(() => moveEditorLayers(state, ['layer-1'], 20, 0)).toThrow('锁定')
    expect(() => deleteEditorLayer(state, 'layer-2')).not.toThrow()
    expect(deleteEditorLayer(state, 'layer-2')).toBe(state)
    state = patchEditorGroup(state, 'group-1', { visible: true, locked: false })
    expect(state.present.recipe.layers).toEqual(own)
    expect(editorLayerEffectiveState(state.present, 'layer-1').visible).toBe(false)
  })
  it('ungroups hidden locked folders by preserving effective flags at direct children in one undo', () => {
    let state = groupEditorLayers(grouped(), '外组')
    state = patchEditorGroup(state, 'group-2', { visible: false, locked: true })
    const next = ungroupEditorGroup(state, 'group-2')
    expect(next.present.recipe.layerGroups!.groups[0]).toMatchObject({ id: 'group-1', visible: false, locked: true })
    expect(next.present.recipe.layers).toEqual(state.present.recipe.layers)
    expect(undoLayerEditor(next).present).toEqual(state.present)
    const flat = ungroupEditorGroup(next, 'group-1')
    expect(flat.present.recipe).not.toHaveProperty('layerGroups')
    expect(flat.present.recipe.layers.slice(0, 2).map((layer) => [layer.visible, layer.locked])).toEqual([[false, true], [false, true]])
    expect(flat.present.ids).toEqual(state.present.ids)
  })
  it('moves every group member with one common clamped delta and coalesces the outer drag transaction', () => {
    const state = grouped(), other = state.present.recipe.layers[3]
    let next = beginLayerEditorTransaction(state)
    next = moveEditorGroup(next, 'group-1', 10, -8)
    next = moveEditorGroup(next, 'group-1', 10, -8)
    expect(next.past).toHaveLength(1)
    next = finishLayerEditorTransaction(next)
    expect(next.past).toHaveLength(2)
    expect(next.present.recipe.layers[0].x).toBeCloseTo(.02)
    expect(next.present.recipe.layers[1].x).toBeCloseTo(.12)
    expect(next.present.recipe.layers[3]).toBe(other)
    expect(undoLayerEditor(next).present).toEqual(state.present)
  })
  it('keeps groups intact under root additions, leaf duplication, partial deletion and document crop', () => {
    let state = grouped()
    state = addEditorLayer(state, 'text')
    state = appendEditorCustomLayer(state, defaultEditorImageLayer(0))
    expect(state.present.recipe.layerGroups!.groups[0].children).toEqual(['layer-1', 'layer-2'])
    state = duplicateEditorLayer(state, 'layer-1')
    expect(state.present.recipe.layerGroups!.groups[0].children).toEqual(['layer-1', 'layer-7', 'layer-2'])
    state = deleteEditorLayer(state, 'layer-1')
    expect(state.present.recipe.layerGroups!.groups[0].children).toEqual(['layer-7', 'layer-2'])
    const cropped = cropLayerDocumentRecipe(state.present.recipe, { x: 10, y: 10, width: 800, height: 600 })
    expect(cropped.layerGroups).toEqual(state.present.recipe.layerGroups)
    expect(parseImageTransformRecipe(cropped).kind).toBe('layer')
  })
  it('duplicates the folder tree as independent unlocked editable leaves above its original span', () => {
    let state = groupEditorLayers(grouped(), '外组')
    state = patchEditorGroup(state, 'group-1', { locked: true })
    const next = duplicateEditorGroup(state, 'group-2'), group = selectedEditorGroup(next.present)!
    expect(next.present.ids).toEqual(['layer-1', 'layer-2', 'layer-5', 'layer-6', 'layer-3', 'layer-4'])
    expect(group.name).toBe('外组 副本')
    expect(next.present.recipe.layerGroups!.groups).toHaveLength(4)
    expect(editorLayerEffectiveState(next.present, 'layer-5').locked).toBe(false)
    expect(next.present.recipe.layers[2].x - next.present.recipe.layers[0].x).toBeCloseTo(.025)
    expect(next.present.recipe.layers[3].x - next.present.recipe.layers[1].x).toBeCloseTo(.025)
    expect(undoLayerEditor(next).present).toEqual(state.present)
  })
  it('normalizes mixed group and leaf batches without overwriting child flags or copying only half a folder', () => {
    let state = grouped()
    state = patchEditorLayer(state, 'layer-1', { visible: false })
    state = selectEditorLayer(state, 'layer-3', { toggle: true })
    const hidden = patchEditorLayers(state, ['layer-1', 'layer-2', 'layer-3'], { visible: false })
    expect(hidden.present.recipe.layers[1].visible).toBe(true)
    expect(hidden.present.recipe.layerGroups!.groups[0].visible).toBe(false)
    const copied = duplicateEditorLayers(state, ['layer-1', 'layer-2', 'layer-3'])
    expect(copied.present.recipe.layerGroups!.groups).toHaveLength(2)
    expect(copied.present.ids).toHaveLength(7)
    expect(parseImageTransformRecipe(copied.present.recipe).kind).toBe('layer')
    const deleted = deleteEditorLayers(state, ['layer-1', 'layer-2', 'layer-3'])
    expect(deleted.present.ids).toEqual(['layer-4'])
    expect(deleted.present.recipe).not.toHaveProperty('layerGroups')
  })
  it('reorders complete groups as sibling blocks and refuses cross-parent leaf batches', () => {
    const state = grouped(), next = reorderEditorGroup(state, 'group-1', 1)
    expect(next.present.ids).toEqual(['layer-3', 'layer-1', 'layer-2', 'layer-4'])
    expect(next.present.recipe.layerGroups!.groups[0].children).toEqual(['layer-1', 'layer-2'])
    expect(reorderEditorLayers(state, ['layer-1', 'layer-2'], 1).present.ids).toEqual(next.present.ids)
    expect(reorderEditorLayers(state, ['layer-1'], 1).present.ids).toEqual(['layer-2', 'layer-1', 'layer-3', 'layer-4'])
    expect(() => reorderEditorLayers(state, ['layer-2', 'layer-3'], 1)).toThrow('同一父级')
    expect(state.present.recipe.layers[0]).toBe(next.present.recipe.layers[1])
  })
  it('refuses locked moves, deletion and sorting as a whole but permits duplication with unlocked copies', () => {
    const state = patchEditorGroup(grouped(), 'group-1', { locked: true })
    expect(() => moveEditorGroup(state, 'group-1', 1, 1)).toThrow('锁定')
    expect(() => deleteEditorGroup(state, 'group-1')).toThrow('锁定')
    expect(() => reorderEditorGroup(state, 'group-1', 1)).toThrow('锁定')
    expect(editorLayerEffectiveState(duplicateEditorGroup(state, 'group-1').present, 'layer-5').locked).toBe(false)
  })
  it('enforces leaf, group and nesting bounds atomically without consuming source slots for group metadata', () => {
    const twenty = groupEditorLayers(choose(initial(20), 'layer-1', 'layer-2'))
    expect(twenty.present.recipe.layers).toHaveLength(20)
    expect(() => duplicateEditorGroup(twenty, 'group-1')).toThrow('20 个图层')
    let nested = grouped()
    for (let index = 0; index < 3; index++) nested = groupEditorLayers(nested)
    expect(nested.present.recipe.layerGroups!.groups).toHaveLength(4)
    const before = structuredClone(nested)
    expect(() => groupEditorLayers(nested)).toThrow('4 层')
    expect(nested).toEqual(before)
  })
  it('rejects group-count overflow before duplication and preserves nested inherited locking during ungroup', () => {
    let state = initial(5)
    for (const leaf of state.present.ids.slice()) {
      state = selectEditorLayer(state, leaf)
      for (let depth = 0; depth < 4; depth++) state = groupEditorLayers(state)
    }
    expect(state.present.recipe.layerGroups!.groups).toHaveLength(20)
    expect(() => duplicateEditorGroup(state, state.present.selectedGroupId!)).toThrow('20 个组')
    expect(() => groupEditorLayers(state)).toThrow('20 个图层组')
    let nested = groupEditorLayers(grouped())
    nested = patchEditorGroup(nested, 'group-2', { locked: true })
    expect(() => ungroupEditorGroup(nested, 'group-1')).toThrow('父组已锁定')
    expect(ungroupEditorGroup(nested, 'group-2').present.recipe.layerGroups!.groups[0].locked).toBe(true)
  })
  it('allocates bounded fresh identities around legal imported IDs without colliding with groups', () => {
    const before = grouped().present.recipe
    const imported: ImageLayerRecipe = { ...before, layerGroups: { ...before.layerGroups!, layerIds: ['layer-900719925474099199999', 'b', 'c', 'd'], groups: [{ id: 'layer-5', name: '导入组', children: ['layer-900719925474099199999', 'b'], visible: true, locked: false }] } }
    const state = createLayerEditorState(imported, 4), added = addEditorLayer(state, 'text')
    expect(added.present.ids.at(-1)).toBe('layer-6')
    expect(parseImageTransformRecipe(added.present.recipe).kind).toBe('layer')
    expect(duplicateEditorGroup(state, 'layer-5').present.ids).toHaveLength(6)
  })
})

describe('group-aware raster merge plans', () => {
  it('merges a complete selected group into one leaf at its former parent and undoes the tree', () => {
    const state = groupEditorLayers(grouped(), '外组'), plan = buildEditorLayerMergePlan(state.present)
    expect(plan.rasterRecipe).not.toHaveProperty('layerGroups')
    const next = commitEditorLayerMerge(state, plan, 4)
    expect(next.present.recipe).not.toHaveProperty('layerGroups')
    expect(next.present.recipe.layers[1]).toBe(state.present.recipe.layers[2])
    expect(undoLayerEditor(next).present).toEqual(state.present)
  })
  it('retains the parent when merging a proper sibling subset inside a folder', () => {
    const state = groupEditorLayers(choose(initial(), 'layer-1', 'layer-2', 'layer-3'))
    const selected = choose(state, 'layer-1', 'layer-2'), plan = buildEditorLayerMergePlan(selected.present)
    expect(plan.groupParentId).toBe('group-1')
    const next = commitEditorLayerMerge(selected, plan, 4)
    expect(next.present.recipe.layerGroups!.groups[0].children).toEqual(['layer-5', 'layer-3'])
    expect(materializeImageLayerGroups(next.present.recipe).layers).toHaveLength(3)
  })
  it('retains a folder when its leaves are selected directly, while explicit folder selection may rasterize it', () => {
    const state = grouped(), leaves = choose(state, 'layer-1', 'layer-2')
    const plan = buildEditorLayerMergePlan(leaves.present)
    expect(plan.groupParentId).toBe('group-1')
    expect(commitEditorLayerMerge(leaves, plan, 4).present.recipe.layerGroups!.groups[0].children).toEqual(['layer-5'])
    expect(buildEditorLayerMergePlan(state.present).groupParentId).toBeNull()
  })
  it('rejects inherited hidden or locked content and stale groups while preparing cross-parent candidates', () => {
    const state = grouped()
    expect(() => buildEditorLayerMergePlan(patchEditorGroup(state, 'group-1', { visible: false }).present)).toThrow('隐藏')
    expect(() => buildEditorLayerMergePlan(patchEditorGroup(state, 'group-1', { locked: true }).present)).toThrow('锁定')
    const cross = buildEditorLayerMergePlan(choose(state, 'layer-2', 'layer-3').present)
    expect(cross.groupParentId).toBeNull()
    expect(cross.selectedIds).toEqual(['layer-2', 'layer-3'])
    const plan = buildEditorLayerMergePlan(state.present)
    expect(() => commitEditorLayerMerge(patchEditorGroup(state, 'group-1', { name: '改变' }), plan, 4)).toThrow('已变化')
  })
})

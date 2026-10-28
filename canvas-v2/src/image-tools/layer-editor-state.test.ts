import { describe, expect, it } from 'vitest'
import { defaultImageTransformRecipe, parseImageTransformRecipe, type ImageLayer, type ImageLayerRecipe } from './recipe'
import { addEditorLayer, alignEditorLayer, beginLayerEditorTransaction, createLayerEditorState, defaultEditorImageLayer, deleteEditorLayer, duplicateEditorLayer, finishLayerEditorTransaction, moveEditorLayer, patchEditorLayer, patchEditorRecipe, redoLayerEditor, reorderEditorLayer, resizeEditorLayer, selectEditorLayer, undoLayerEditor, type LayerResizeHandle } from './layer-editor-state'

function recipe(): ImageLayerRecipe { return defaultImageTransformRecipe('layer') as ImageLayerRecipe }
function initial(count = 1) { return createLayerEditorState(recipe(), count) }

describe('layer editor document history', () => {
  it('materializes legacy automatic inputs in order and marks the edit as explicit', () => {
    const input = recipe(), state = createLayerEditorState(input, 3)
    expect(state.present.recipe).toMatchObject({ explicitLayers: true, layers: [{ sourceIndex: 0 }, { sourceIndex: 1 }, { sourceIndex: 2 }] })
    expect(state.present.selectedId).toBe('layer-3')
    expect(input.layers).toEqual([])
  })

  it('preserves intentionally empty recipes even when upstream images are connected', () => {
    expect(createLayerEditorState({ ...recipe(), explicitLayers: true }, 3).present.recipe.layers).toEqual([])
  })

  it('deep clones initial content and adjustment objects before any edit', () => {
    const contentState = addEditorLayer(initial(0), 'text'), input = contentState.present.recipe
    const state = createLayerEditorState(input, 0)
    expect(state.present.recipe.layers[0].content).not.toBe(input.layers[0].content)
    if (state.present.recipe.layers[0].content?.kind === 'text') state.present.recipe.layers[0].content.text = 'changed'
    expect(input.layers[0].content).toMatchObject({ text: '输入文字' })
  })

  it('records a full pointer drag as one undo step and restores it with redo', () => {
    let state = beginLayerEditorTransaction(initial())
    for (let step = 1; step <= 100; step++) state = patchEditorLayer(state, 'layer-1', { x: step / 1000 })
    expect(state.past).toHaveLength(0)
    state = finishLayerEditorTransaction(state)
    expect(state.past).toHaveLength(1)
    expect(undoLayerEditor(state).present.recipe.layers[0].x).toBe(0)
    expect(redoLayerEditor(undoLayerEditor(state)).present.recipe.layers[0].x).toBe(0.1)
  })

  it('cancels an in-progress edit without losing an existing redo branch', () => {
    const changed = patchEditorLayer(initial(), 'layer-1', { x: 0.2 })
    let state = beginLayerEditorTransaction(undoLayerEditor(changed))
    state = patchEditorLayer(state, 'layer-1', { x: 0.6 })
    state = finishLayerEditorTransaction(state, true)
    expect(state.present.recipe.layers[0].x).toBe(0)
    expect(state.past).toHaveLength(0)
    expect(redoLayerEditor(state).present.recipe.layers[0].x).toBe(0.2)
  })

  it('does not create history for selection or an unchanged transaction', () => {
    const original = initial(2)
    const selected = selectEditorLayer(original, 'layer-1')
    expect(selected.past).toHaveLength(0)
    expect(patchEditorLayer(selected, 'layer-1', { x: 0 })).toBe(selected)
    expect(finishLayerEditorTransaction(beginLayerEditorTransaction(selected)).past).toHaveLength(0)
  })

  it('can delete the final layer without returning to automatic input rendering', () => {
    const state = deleteEditorLayer(initial(), 'layer-1')
    expect(parseImageTransformRecipe(state.present.recipe)).toMatchObject({ explicitLayers: true, layers: [] })
    expect(state.present.selectedId).toBeNull()
    expect(undoLayerEditor(state).present.recipe.layers).toHaveLength(1)
  })

  it('keeps stable layer identity and selection while reordering pixels', () => {
    const state = reorderEditorLayer(selectEditorLayer(initial(3), 'layer-1'), 'layer-1', 1)
    expect(state.present.ids).toEqual(['layer-2', 'layer-1', 'layer-3'])
    expect(state.present.recipe.layers.map((layer) => layer.sourceIndex)).toEqual([1, 0, 2])
    expect(state.present.selectedId).toBe('layer-1')
  })

  it('duplicates nested content independently and bounds all creation at twenty layers', () => {
    let state = addEditorLayer(initial(0), 'text')
    state = duplicateEditorLayer(state, 'layer-1')
    expect(state.present.recipe.layers[0].content).not.toBe(state.present.recipe.layers[1].content)
    expect(state.present.recipe.layers[1]).toMatchObject({ name: '文字 1 副本', locked: false })
    while (state.present.recipe.layers.length < 20) state = addEditorLayer(state, 'ellipse')
    expect(addEditorLayer(state, 'rectangle')).toBe(state)
    expect(duplicateEditorLayer(state, 'layer-1')).toBe(state)
    expect(parseImageTransformRecipe(state.present.recipe)).toMatchObject({ layers: expect.any(Array) })
  })

  it('locks content and geometry while preserving visibility, rename, and unlock controls', () => {
    const state = patchEditorLayer(initial(2), 'layer-1', { locked: true })
    expect(patchEditorLayer(state, 'layer-1', { x: 0.4 })).toBe(state)
    expect(deleteEditorLayer(state, 'layer-1')).toBe(state)
    expect(reorderEditorLayer(state, 'layer-1', 1)).toBe(state)
    const next = patchEditorLayer(state, 'layer-1', { visible: false, name: '保留', locked: false })
    expect(next.present.recipe.layers[0]).toMatchObject({ name: '保留', visible: false, locked: false })
  })

  it('supports text and shape-only documents without an image source', () => {
    let state = addEditorLayer(initial(0), 'text')
    state = addEditorLayer(state, 'rectangle')
    state = addEditorLayer(state, 'ellipse')
    const parsed = parseImageTransformRecipe(state.present.recipe) as ImageLayerRecipe
    expect(parsed.layers.map((layer) => layer.content?.kind)).toEqual(['text', 'shape', 'shape'])
    expect(parsed.layers.map((layer) => layer.sourceIndex)).toEqual([0, 0, 0])
  })

  it('retains only a bounded sixty-step undo history and keeps recipe changes explicit', () => {
    let state = initial()
    for (let step = 1; step <= 80; step++) state = patchEditorRecipe(state, { outputWidth: 1000 + step })
    expect(state.past).toHaveLength(60)
    expect(state.present.recipe.explicitLayers).toBe(true)
  })
})

function corner(layer: ImageLayer, right: boolean, bottom: boolean, width = 1000, height = 800) {
  const w = layer.width * width, h = layer.height * height, x = (right ? 0.5 : -0.5) * w, y = (bottom ? 0.5 : -0.5) * h, radians = layer.rotation * Math.PI / 180
  return { x: layer.x * width + w / 2 + (layer.flipX ? -1 : 1) * (Math.cos(radians) * x - Math.sin(radians) * y), y: layer.y * height + h / 2 + (layer.flipY ? -1 : 1) * (Math.sin(radians) * x + Math.cos(radians) * y) }
}

describe('layer editor direct manipulation', () => {
  const output = { outputWidth: 1000, outputHeight: 800 }
  const layer = { ...defaultEditorImageLayer(0), x: 0.2, y: 0.15, width: 0.3, height: 0.4 }

  it('moves in output pixel coordinates and clamps supported off-canvas positions', () => {
    const moved = moveEditorLayer(layer, 10, -8, output)
    expect(moved.x).toBeCloseTo(0.21, 10)
    expect(moved.y).toBeCloseTo(0.14, 10)
    expect(moveEditorLayer(layer, 1e9, -1e9, output)).toEqual({ x: 8192 / 1000, y: -8192 / 800 })
    expect(moveEditorLayer({ ...layer, locked: true }, 10, 8, output)).toEqual({})
  })

  it.each(['nw', 'ne', 'sw', 'se'] as LayerResizeHandle[])('keeps the opposite corner fixed during rotated and flipped %s resizing', (handle) => {
    const before = { ...layer, rotation: 32, flipX: true, flipY: true }
    const oppositeRight = !handle.endsWith('e'), oppositeBottom = !handle.startsWith('s')
    const expected = corner(before, oppositeRight, oppositeBottom)
    const after = { ...before, ...resizeEditorLayer(before, handle, 55, -21, output) }
    const actual = corner(after, oppositeRight, oppositeBottom)
    expect(actual.x).toBeCloseTo(expected.x, 8)
    expect(actual.y).toBeCloseTo(expected.y, 8)
  })

  it('maintains the original aspect ratio with Shift and bounds extreme resizes', () => {
    const resized = { ...layer, ...resizeEditorLayer(layer, 'se', 240, 10, output, true) }
    expect(resized.width / resized.height).toBeCloseTo(layer.width / layer.height, 8)
    expect(resizeEditorLayer(layer, 'se', 1e9, -1e9, output)).toMatchObject({ width: 16384 / 1000, height: .001 / 800 })
  })

  it('aligns rotated visible bounds to the left and centers the logical layer', () => {
    let state = patchEditorLayer(initial(), 'layer-1', { ...layer, rotation: 90 })
    state = patchEditorRecipe(state, output)
    const left = alignEditorLayer(state, 'layer-1', 'left').present.recipe.layers[0]
    const corners = [corner(left, false, false), corner(left, true, false), corner(left, false, true), corner(left, true, true)]
    expect(Math.min(...corners.map((point) => point.x))).toBeCloseTo(0, 8)
    expect(alignEditorLayer(state, 'layer-1', 'center-x').present.recipe.layers[0].x).toBeCloseTo(0.35, 8)
  })
})

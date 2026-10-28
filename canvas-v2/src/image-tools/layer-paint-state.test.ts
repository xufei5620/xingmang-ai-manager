import { describe, expect, it } from 'vitest'
import { addEditorLayer, createLayerEditorState, defaultEditorImageLayer, patchEditorLayer, redoLayerEditor, undoLayerEditor } from './layer-editor-state'
import { addEditorPathLayer, adjustCanvasSelection, appendEditorLayerFill, appendEditorLayerOperation, appendEditorLayerOutline, appendEditorPaintStroke, buildCanvasSelection, createLayerGradient, createLayerPaintStroke, isCurrentLayerColorSample, isLayerGesturePointer, layerPaintTargetError, layerRasterPreviewSize, layerSelectionSnapshot, outputPointToLayerPoint, remainingLayerPaintBudget, shouldAppendPaintPoint, type LayerCanvasSelection } from './layer-paint-state'
import { imageLayerPointScale, parseImageTransformRecipe, type ImageLayer, type ImageLayerRecipe, type ImageLayerStroke } from './recipe'

function recipe(layer: ImageLayer = { ...defaultEditorImageLayer(0), content: { kind: 'paint' } }): ImageLayerRecipe {
  return { kind: 'layer', explicitLayers: true, outputWidth: 1000, outputHeight: 500, background: 'transparent', layers: [layer] }
}
function stroke(layer = recipe().layers[0], value = recipe(layer)): ImageLayerStroke {
  return createLayerPaintStroke(layer, value, { size: 32, hardness: 0.6, opacity: 0.7, color: '#ff00ff80' }, 'paint', { x: 500, y: 250 }, null)
}
function outputPoint(layer: ImageLayer, x: number, y: number) {
  const width = layer.width * 1000, height = layer.height * 500, angle = layer.rotation * Math.PI / 180
  const localX = (x - 0.5) * width, localY = (y - 0.5) * height
  return { x: (layer.x + layer.width / 2) * 1000 + (Math.cos(angle) * localX - Math.sin(angle) * localY) * (layer.flipX ? -1 : 1), y: (layer.y + layer.height / 2) * 500 + (Math.sin(angle) * localX + Math.cos(angle) * localY) * (layer.flipY ? -1 : 1) }
}

describe('layer painting coordinates and selections', () => {
  it('maps gradient endpoints through rotation and flips and commits the selected operation once', () => {
    const layer = { ...recipe().layers[0], x: 0.1, y: 0.2, width: 0.3, height: 0.8, rotation: 37, flipX: true, flipY: true }
    const value = recipe(layer), initial = createLayerEditorState(value, 0), selection = buildCanvasSelection({ x: 150, y: 100 }, { x: 300, y: 250 }, 'ellipse', { width: 1000, height: 500 })!
    const gradient = createLayerGradient(layer, value, { startColor: '#ff000080', endColor: '#0000ff00', opacity: 0.6 }, outputPoint(layer, 0.1, 0.2), outputPoint(layer, 0.7, 0.9), selection)
    expect(gradient).toMatchObject({ from: [1000, 2000], to: [7000, 9000], space: { width: 300, height: 400 } })
    expect(gradient.selection).toEqual(layerSelectionSnapshot(layer, value, selection))
    const committed = appendEditorLayerOperation(initial, initial.present.ids[0], gradient)
    expect(committed.past).toHaveLength(1)
    expect(remainingLayerPaintBudget(committed.present.recipe)).toEqual({ operations: 255, points: 4094 })
    expect(undoLayerEditor(committed).present.recipe).toEqual(initial.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(committed)).present.recipe).toEqual(committed.present.recipe)
    expect(() => createLayerGradient(layer, value, { startColor: '#ffffff', endColor: '#000000', opacity: 1 }, { x: 100, y: 100 }, { x: 100, y: 100 })).toThrow('渐变距离')
    expect(() => createLayerGradient(layer, value, { startColor: '#ffffff', endColor: '#000000', opacity: 1 }, { x: NaN, y: 100 }, { x: 200, y: 200 })).toThrow('端点坐标无效')
  })

  it('creates a bounded independent cubic layer with its selection mask in one undo transaction', () => {
    const initial = createLayerEditorState(recipe(), 0), selection: LayerCanvasSelection = { kind: 'rectangle', x: 0.1, y: 0.2, width: 0.6, height: 0.5, inverted: true, featherRadius: 5 }
    const anchors = [{ x: 600, y: 200 }, { x: 500, y: 300, in: { x: 600, y: 300 }, out: { x: 400, y: 300 } }, { x: 380, y: 120 }]
    const next = addEditorPathLayer(initial, anchors, { fill: '#ffaa55', stroke: '#ffffff', strokeWidth: 4 }, selection)
    const path = next.present.recipe.layers.at(-1)!
    expect(path).toMatchObject({ x: 0.377, y: 0.234, width: 0.226, height: 0.372, name: '钢笔 2', content: { kind: 'path', space: { width: 226, height: 186 } } })
    expect(path.mask).toEqual(JSON.parse(JSON.stringify(layerSelectionSnapshot(path, next.present.recipe, selection))))
    if (path.content?.kind !== 'path') throw new Error('expected path')
    expect(path.content.handles).toHaveLength(3)
    const handle = path.content.handles![1].out!
    expect(path.x * 1000 + handle[0] / imageLayerPointScale * path.width * 1000).toBeCloseTo(400, 1)
    expect(path.y * 500 + handle[1] / imageLayerPointScale * path.height * 500).toBeCloseTo(300, 1)
    expect(next.past).toHaveLength(1)
    expect(remainingLayerPaintBudget(next.present.recipe)).toEqual({ operations: 255, points: 4091 })
    expect(undoLayerEditor(next).present).toEqual(initial.present)
    expect(redoLayerEditor(undoLayerEditor(next)).present).toEqual(next.present)
    anchors[1].out!.x = 900
    expect(path.content.handles![1].out).toEqual(handle)
  })

  it('does not silently truncate invalid paths or exceed layer and shared drawing budgets', () => {
    const initial = createLayerEditorState(recipe(), 0), style = { fill: '#ffffff', stroke: 'transparent', strokeWidth: 0 }, triangle = [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 50, y: 100 }]
    for (const points of [triangle.slice(0, 2), [{ x: NaN, y: 10 }, ...triangle], [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], [{ x: 10, y: 10, out: { x: 4000, y: 10 } }, ...triangle.slice(1)], Array.from({ length: 1025 }, (_, index) => ({ x: index % 1000, y: index % 500 }))]) expect(() => addEditorPathLayer(initial, points, style)).toThrow()
    const full = createLayerEditorState({ ...recipe(), layers: Array.from({ length: 20 }, () => recipe().layers[0]) }, 0)
    expect(() => addEditorPathLayer(full, triangle, style)).toThrow('20')
    const closed = addEditorPathLayer(initial, [...triangle, triangle[0]], style)
    expect(closed.present.recipe.layers.at(-1)?.content).toMatchObject({ kind: 'path', points: expect.any(Array) })
    expect(closed.present.recipe.layers.at(-1)?.content).not.toHaveProperty('handles')
    expect(initial.present.recipe.layers).toHaveLength(1)
  })
  it.each([0, 30, 90, -120])('inverts rotation %s with all flips and nonuniform layer scales', (rotation) => {
    for (const flipX of [true, false]) for (const flipY of [true, false]) {
      const layer = { ...recipe().layers[0], x: 0.1, y: 0.2, width: 0.3, height: 0.8, rotation, flipX, flipY }
      for (const [x, y] of [[0, 0], [0.2, 0.8], [0.5, 0.5], [1, 1]]) expect(outputPointToLayerPoint(layer, { width: 1000, height: 500 }, outputPoint(layer, x, y))).toEqual([Math.round(x * imageLayerPointScale), Math.round(y * imageLayerPointScale)])
    }
  })

  it('keeps nearby outside points and bounds distant points to the serialized range', () => {
    const layer = recipe().layers[0]
    expect(outputPointToLayerPoint(layer, { width: 1000, height: 500 }, { x: -100, y: 600 })).toEqual([-1000, 12000])
    expect(outputPointToLayerPoint(layer, { width: 1000, height: 500 }, { x: -1e6, y: 1e6 })).toEqual([-20000, 30000])
  })

  it('supports reverse drags, canvas clipping and output-pixel square constraints', () => {
    const output = { width: 1000, height: 500 }
    expect(buildCanvasSelection({ x: 700, y: 400 }, { x: 100, y: 100 }, 'rectangle', output)).toEqual({ kind: 'rectangle', x: 0.1, y: 0.2, width: 0.6, height: 0.6, inverted: false })
    const equal = buildCanvasSelection({ x: 100, y: 100 }, { x: 300, y: 180 }, 'ellipse', output, true)!
    expect(equal.width * output.width).toBe(equal.height * output.height)
    expect(buildCanvasSelection({ x: -20, y: -10 }, { x: 1300, y: 600 }, 'rectangle', output)).toMatchObject({ x: 0, y: 0, width: 1, height: 1 })
    expect(buildCanvasSelection({ x: 1, y: 1 }, { x: 1.1, y: 1.2 }, 'rectangle', output)).toBeNull()
  })

  it('snapshots world-axis selections on rotated layers without retaining the mutable UI selection', () => {
    const layer = { ...recipe().layers[0], rotation: 40, flipX: true, width: 0.5 }, value = recipe(layer)
    const selection: LayerCanvasSelection = { kind: 'ellipse', x: 0.1, y: 0.2, width: 0.3, height: 0.4, inverted: true }
    const result = createLayerPaintStroke(layer, value, { size: 25, hardness: 1, opacity: 1, color: '#00ff00' }, 'erase', { x: 20, y: 30 }, selection)
    const expected = layerSelectionSnapshot(layer, value, selection)
    selection.x = 0.9; selection.inverted = false
    expect(result.selection).toEqual(expected)
    const [a, b, c, d, e, f] = expected.transform
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const point = outputPoint(layer, a * u + c * v + e, b * u + d * v + f)
      expect(point.x).toBeCloseTo(100 + 300 * u)
      expect(point.y).toBeCloseTo(100 + 200 * v)
    }
    expect(result.space).toEqual({ width: 500, height: 500 })
  })

  it('filters duplicate and subpixel samples while always accepting a distinct final endpoint', () => {
    const value = stroke()
    expect(shouldAppendPaintPoint(value, [5000, 5000])).toBe(false)
    expect(shouldAppendPaintPoint(value, [5001, 5000])).toBe(false)
    expect(shouldAppendPaintPoint(value, [5001, 5000], true)).toBe(true)
    expect(shouldAppendPaintPoint(value, [5100, 5000])).toBe(true)
  })
})

describe('layer painting history and limits', () => {
  it('accepts move end and cancellation events only from the gesture owner', () => {
    const brush = { pointerId: 1 }, selection = { pointerId: 3 }, move = { pointerId: 5 }
    for (const active of [brush, selection, move]) {
      expect(isLayerGesturePointer(active, active.pointerId)).toBe(true)
      expect(isLayerGesturePointer(active, 2)).toBe(false)
    }
    expect(isLayerGesturePointer(null, 1)).toBe(false)
    expect([brush, null, null].some((active) => isLayerGesturePointer(active, 2))).toBe(false)
    expect([null, null, move].some((active) => isLayerGesturePointer(active, 5))).toBe(true)
  })

  it('creates an explicit transparent painting layer without adding an image dependency', () => {
    const state = createLayerEditorState({ ...recipe(), layers: [] }, 0)
    const next = addEditorLayer(state, 'paint')
    expect(next.present.recipe.layers[0]).toMatchObject({ content: { kind: 'paint' }, width: 1, height: 1, sourceIndex: 0 })
    expect(next.present.recipe.explicitLayers).toBe(true)
    expect(parseImageTransformRecipe(next.present.recipe)).toEqual(next.present.recipe)
  })

  it('keeps transient samples out of document history and commits the whole stroke as one undo step', () => {
    const state = createLayerEditorState(recipe(), 0), operation = stroke()
    operation.points.push([6000, 5000], [7000, 5500])
    expect(state.past).toHaveLength(0)
    expect(state.present.recipe.layers[0].edits).toBeUndefined()
    const next = appendEditorPaintStroke(state, state.present.ids[0], operation)
    expect(next.past).toHaveLength(1)
    operation.points.push([9000, 9000])
    const committedOperation = next.present.recipe.layers[0].edits?.operations[0]
    expect(committedOperation && 'points' in committedOperation && committedOperation.points).toHaveLength(3)
    expect(undoLayerEditor(next).present.recipe).toEqual(state.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(next)).present.recipe).toEqual(next.present.recipe)
  })

  it('preserves redo when an uncommitted stroke is discarded', () => {
    const initial = createLayerEditorState(recipe(), 0), committed = appendEditorPaintStroke(initial, initial.present.ids[0], stroke())
    const undone = undoLayerEditor(committed), transient = stroke()
    transient.points.push([6000, 6000])
    expect(undone.future).toHaveLength(1)
    expect(redoLayerEditor(undone).present.recipe).toEqual(committed.present.recipe)
  })

  it('rejects drawing without a selected visible unlocked layer', () => {
    expect(layerPaintTargetError(undefined)).toContain('新建空白')
    for (const patch of [{ locked: true }, { visible: false }]) {
      const state = createLayerEditorState(recipe({ ...recipe().layers[0], ...patch }), 0)
      expect(() => appendEditorPaintStroke(state, state.present.ids[0], stroke())).toThrow(/锁定|隐藏/)
      expect(state.past).toHaveLength(0)
    }
  })

  it('enforces operation and point limits across all layers before committing', () => {
    const operation = stroke(), layer = recipe().layers[0]
    const limited = recipe({ ...layer, edits: { version: 1, operations: Array.from({ length: 256 }, () => operation) } })
    expect(remainingLayerPaintBudget(limited)).toEqual({ operations: 0, points: 3840 })
    const state = createLayerEditorState(limited, 0)
    expect(() => appendEditorPaintStroke(state, state.present.ids[0], operation)).toThrow()
    const manyPoints = createLayerEditorState(recipe({ ...layer, edits: { version: 1, operations: [{ ...operation, points: Array.from({ length: 4096 }, () => [1, 1] as [number, number]) }] } }), 0)
    expect(() => appendEditorPaintStroke(manyPoints, manyPoints.present.ids[0], operation)).toThrow(/容量/)
    expect(manyPoints.past).toHaveLength(0)
  })

  it('rejects the shared UTF-8 edit budget even below point and operation counts', () => {
    const operation = { ...stroke(), points: Array.from({ length: 16 }, (_, index) => [10000 + index, 10000 + index] as [number, number]), selection: { kind: 'rectangle' as const, inverted: false, transform: [0.123456789, 0, 0, 0.987654321, 0.123456789, 0.987654321] as [number, number, number, number, number, number] } }
    const state = createLayerEditorState(recipe({ ...recipe().layers[0], edits: { version: 1, operations: Array.from({ length: 179 }, () => operation) } }), 0)
    expect(remainingLayerPaintBudget(state.present.recipe).points).toBeGreaterThan(0)
    expect(remainingLayerPaintBudget(state.present.recipe).operations).toBeGreaterThan(0)
    expect(() => appendEditorPaintStroke(state, state.present.ids[0], operation)).toThrow(/容量/)
    expect(state.past).toHaveLength(0)
  })

  it('keeps masks independently reversible without deleting the original content or strokes', () => {
    const state = createLayerEditorState(recipe(), 0), id = state.present.ids[0]
    const drawn = appendEditorPaintStroke(state, id, stroke())
    const mask = layerSelectionSnapshot(drawn.present.recipe.layers[0], drawn.present.recipe, { kind: 'rectangle', x: 0.2, y: 0.1, width: 0.4, height: 0.5, inverted: false })
    const masked = patchEditorLayer(drawn, id, { mask }), removed = patchEditorLayer(masked, id, { mask: undefined })
    expect(parseImageTransformRecipe(removed.present.recipe)).toEqual(drawn.present.recipe)
    expect(undoLayerEditor(removed).present.recipe).toEqual(masked.present.recipe)
    expect(undoLayerEditor(masked).present.recipe).toEqual(drawn.present.recipe)
  })

  it('bounds all simultaneous display and cache surfaces including oversized local layers', () => {
    for (const count of [1, 2, 20]) for (const [width, height] of [[16384, 16384], [16384, 1], [1, 16384], [100, 200], [0.001, 0.001]]) {
      const size = layerRasterPreviewSize(width, height, count * 2)
      expect(size.width).toBeGreaterThanOrEqual(1)
      expect(size.height).toBeGreaterThanOrEqual(1)
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1024)
      expect(size.width * size.height * count * 2).toBeLessThanOrEqual(2097152)
    }
  })
})


describe('advanced layer selection and foreground tools', () => {
  it('snapshots native pixel selections on rotated flipped layers without aliasing runs', () => {
    const layer = { ...recipe().layers[0], rotation: 45, flipX: true, x: 0.1, y: 0.2, width: 0.4, height: 0.6 }, value = recipe(layer)
    const selection: LayerCanvasSelection = { kind: 'raster', inverted: true, featherRadius: 5, raster: { width: 1000, height: 500, runs: [0, 100, 1000, 100] } }
    const snapshot = layerSelectionSnapshot(layer, value, selection)
    expect(snapshot).toMatchObject({ kind: 'raster', inverted: true, feather: { radius: 5, space: { width: 400, height: 300 } } })
    const [a, b, c, d, e, f] = snapshot.transform
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const point = outputPoint(layer, a * u + c * v + e, b * u + d * v + f)
      expect(point.x).toBeCloseTo(1000 * u, 5)
      expect(point.y).toBeCloseTo(500 * v, 5)
    }
    selection.raster.runs[1] = 1
    expect(snapshot.kind === 'raster' && snapshot.raster.runs).toEqual([0, 100, 1000, 100])
    expect(() => layerSelectionSnapshot(layer, { ...value, outputWidth: 900 }, selection)).toThrow('画布尺寸已变化')
  })

  it('persists fill outline brush and mask snapshots with one undo step for each operation', () => {
    const state = createLayerEditorState(recipe(), 0), id = state.present.ids[0]
    const selection: LayerCanvasSelection = { kind: 'raster', inverted: false, raster: { width: 1000, height: 500, runs: [0, 100] } }
    const filled = appendEditorLayerFill(state, id, '#ff000080', 0.5, selection)
    const outlined = appendEditorLayerOutline(filled, id, { color: '#000000', opacity: 1, width: 5, position: 'center' }, selection)
    const painted = appendEditorPaintStroke(outlined, id, createLayerPaintStroke(outlined.present.recipe.layers[0], outlined.present.recipe, { color: '#ffffff', size: 5, hardness: 1, opacity: 1 }, 'paint', { x: 10, y: 0 }, selection))
    const masked = patchEditorLayer(painted, id, { mask: layerSelectionSnapshot(painted.present.recipe.layers[0], painted.present.recipe, selection) })
    expect(parseImageTransformRecipe(masked.present.recipe)).toEqual(masked.present.recipe)
    expect(remainingLayerPaintBudget(outlined.present.recipe)).toEqual({ points: 4096, operations: 254 })
    for (const [before, after] of [[state, filled], [filled, outlined], [outlined, painted], [painted, masked]]) {
      expect(after.past).toHaveLength(before.past.length + 1)
      expect(undoLayerEditor(after).present.recipe).toEqual(before.present.recipe)
      expect(redoLayerEditor(undoLayerEditor(after)).present.recipe).toEqual(after.present.recipe)
    }
    for (const patch of [{ locked: true }, { visible: false }]) {
      const blocked = patchEditorLayer(state, id, patch)
      expect(() => appendEditorLayerOutline(blocked, id, { color: '#000000', opacity: 1, width: 2, position: 'inside' }, selection)).toThrow(/锁定|隐藏/)
    }
  })

  it('expands and contracts in output pixels and reverses the direction for inverted selections', () => {
    const selection: LayerCanvasSelection = { kind: 'ellipse', x: 0.2, y: 0.2, width: 0.4, height: 0.4, inverted: false, featherRadius: 5 }
    const output = { width: 1000, height: 500 }
    expect(adjustCanvasSelection(selection, output, 10)).toEqual({ ...selection, x: 0.19, y: 0.18, width: expect.closeTo(0.42, 12), height: expect.closeTo(0.44, 12) })
    expect(adjustCanvasSelection({ ...selection, inverted: true }, output, 10)).toEqual({ ...selection, inverted: true, x: 0.21, y: 0.22, width: expect.closeTo(0.38, 12), height: expect.closeTo(0.36, 12) })
    expect(adjustCanvasSelection(selection, output, 4096)).toMatchObject({ x: 0, y: 0, width: 1, height: 1 })
    expect(() => adjustCanvasSelection(selection, output, -300)).toThrow(/保留原选区/)
    expect(selection.width).toBe(0.4)
  })

  it('captures feather radius and logical layer dimensions without changing older snapshots', () => {
    const layer = { ...recipe().layers[0], width: 0.6, height: 0.5 }, value = recipe(layer)
    const selection: LayerCanvasSelection = { kind: 'rectangle', x: 0.1, y: 0.2, width: 0.3, height: 0.4, inverted: false, featherRadius: 5 }
    expect(layerSelectionSnapshot(layer, value, selection).feather).toEqual({ radius: 5, space: { width: 600, height: 250 } })
    expect(layerSelectionSnapshot(layer, value, { ...selection, featherRadius: 0 }).feather).toBeUndefined()
  })

  it('fills only the selected layer and captures selection as one reversible operation', () => {
    const state = createLayerEditorState({ ...recipe(), layers: [recipe().layers[0], recipe().layers[0]] }, 0), id = state.present.ids[1]
    const selection: LayerCanvasSelection = { kind: 'ellipse', x: 0.2, y: 0.2, width: 0.4, height: 0.4, inverted: true, featherRadius: 5 }
    const next = appendEditorLayerFill(state, id, '#00ff0080', 0.5, selection)
    selection.x = 0.7
    expect(next.present.recipe.layers[0].edits).toBeUndefined()
    const operation = next.present.recipe.layers[1].edits?.operations[0]
    expect(operation).toMatchObject({ mode: 'fill', color: '#00ff0080', opacity: 0.5, selection: { kind: 'ellipse', inverted: true, feather: { radius: 5 } } })
    expect(remainingLayerPaintBudget(next.present.recipe)).toEqual({ operations: 255, points: 4096 })
    expect(next.past).toHaveLength(1)
    expect(undoLayerEditor(next).present.recipe).toEqual(state.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(next)).present.recipe).toEqual(next.present.recipe)
  })

  it('rejects fills on locked and hidden layers without changing history', () => {
    for (const patch of [{ locked: true }, { visible: false }]) {
      const state = createLayerEditorState(recipe({ ...recipe().layers[0], ...patch }), 0)
      expect(() => appendEditorLayerFill(state, state.present.ids[0], '#ff0000', 1, null)).toThrow(/锁定|隐藏/)
      expect(state.past).toHaveLength(0)
    }
  })

  it('rejects late color samples after cancellation, selection, document or source changes', () => {
    const value = recipe(), request = { controller: new AbortController(), recipe: value, selectedId: 'layer-1', sourcesKey: 'image-v1' }
    const present = { recipe: value, selectedId: 'layer-1' }
    expect(isCurrentLayerColorSample(request, request, present, 'image-v1')).toBe(true)
    expect(isCurrentLayerColorSample(request, null, present, 'image-v1')).toBe(false)
    expect(isCurrentLayerColorSample(request, { ...request }, present, 'image-v1')).toBe(false)
    expect(isCurrentLayerColorSample(request, request, { ...present, recipe: structuredClone(value) }, 'image-v1')).toBe(false)
    expect(isCurrentLayerColorSample(request, request, { ...present, selectedId: 'layer-2' }, 'image-v1')).toBe(false)
    expect(isCurrentLayerColorSample(request, request, present, 'image-v2')).toBe(false)
    request.controller.abort()
    expect(isCurrentLayerColorSample(request, request, present, 'image-v1')).toBe(false)
  })
})

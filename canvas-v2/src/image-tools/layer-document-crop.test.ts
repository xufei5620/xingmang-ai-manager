import { describe, expect, it } from 'vitest'
import { buildLayerDocumentCrop, cropLayerDocumentRecipe, moveLayerDocumentCrop, normalizeLayerDocumentCrop, resizeLayerDocumentCrop, type LayerDocumentCropHandle } from './layer-document-crop'
import { buildLayerDocumentReplayRecipe } from './layer-document-geometry'
import { addEditorLayer, applyEditorDocumentCrop, createLayerEditorState, defaultEditorImageLayer, duplicateEditorLayer, moveEditorLayer, patchEditorRecipe, redoLayerEditor, resizeEditorLayer, undoLayerEditor } from './layer-editor-state'
import { defaultImageLayerColorGrade } from './layer-color-grade'
import { outputPointToLayerPoint, layerSelectionSnapshot } from './layer-paint-state'
import { parseImageTransformRecipe, type ImageLayer, type ImageLayerRecipe } from './recipe'

function recipe(): ImageLayerRecipe {
  const base = defaultEditorImageLayer(0)
  return { kind: 'layer', outputWidth: 640, outputHeight: 480, background: '#ffffff', explicitLayers: true, layers: [
    { ...base, name: 'Image', x: -.2, y: .1, width: 1.7, height: .8, rotation: 37, flipX: true, locked: true },
    { ...base, name: 'Text', x: .2, y: .3, width: .5, height: .2, content: { kind: 'text', text: 'Hello\nWorld', fontSize: 36, fontFamily: 'sans-serif', fontWeight: 700, align: 'left', color: '#ff0000' } },
    { ...base, name: 'Path', content: { kind: 'path', points: [[0, 0], [10000, 0], [5000, 10000]], fill: '#ff0000', stroke: '#000000', strokeWidth: 5, space: { width: 640, height: 480 } } },
    { ...base, name: 'Paint', visible: false, content: { kind: 'paint' }, edits: { version: 1, operations: [{ mode: 'paint', points: [[2000, 3000], [5000, 6000]], size: 16, hardness: 1, opacity: .8, color: '#00ff00', space: { width: 640, height: 480 } }] } },
    { ...base, name: 'Mask', mask: { kind: 'rectangle', transform: [.5, 0, 0, .8, .1, .2], inverted: false, feather: { radius: 4, space: { width: 640, height: 480 } } } },
    { ...base, name: 'Liquify', x: 2, y: -2, width: 4, height: .001, colorGrade: { ...defaultImageLayerColorGrade(), exposure: 1, grain: 10 }, edits: { version: 1, operations: [{ mode: 'liquify', version: 1, space: { width: 2560, height: 1 }, strokes: [{ tool: 'push', radius: 10, strength: .5, points: [[3000, 5000], [6000, 5000]] }] }] } },
  ] }
}
function world(layer: ImageLayer, value: ImageLayerRecipe, u: number, v: number) {
  const width = layer.width * value.outputWidth, height = layer.height * value.outputHeight, angle = layer.rotation * Math.PI / 180
  const x = (u - .5) * width, y = (v - .5) * height
  return { x: (layer.x * value.outputWidth + width / 2) + (Math.cos(angle) * x - Math.sin(angle) * y) * (layer.flipX ? -1 : 1), y: (layer.y * value.outputHeight + height / 2) + (Math.sin(angle) * x + Math.cos(angle) * y) * (layer.flipY ? -1 : 1) }
}

describe('layer document crop drafts', () => {
  it('builds integer output-pixel rectangles in either drag direction', () => {
    const output = { width: 640, height: 480 }
    expect(buildLayerDocumentCrop({ x: 520, y: 380 }, { x: 120, y: 100 }, output)).toEqual({ x: 120, y: 100, width: 400, height: 280 })
    expect(buildLayerDocumentCrop({ x: -100, y: -5 }, { x: 900, y: 600 }, output)).toEqual({ x: 0, y: 0, ...output })
    expect(buildLayerDocumentCrop({ x: 1.1, y: 1.1 }, { x: 1.2, y: 8 }, output)).toBeNull()
    expect(buildLayerDocumentCrop({ x: 0, y: 0 }, { x: 1, y: 1 }, output)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(() => buildLayerDocumentCrop({ x: NaN, y: 0 }, { x: 1, y: 1 }, output)).toThrow()
  })
  it('clamps draft movement while preserving the exact rectangle dimensions', () => {
    const output = { width: 640, height: 480 }, rect = { x: 120, y: 100, width: 400, height: 280 }
    expect(moveLayerDocumentCrop(rect, { x: 900, y: -900 }, output)).toEqual({ ...rect, x: 240, y: 0 })
    expect(normalizeLayerDocumentCrop({ x: 639.9, y: 479.7, width: 0, height: 1000 }, output)).toEqual({ x: 639, y: 479, width: 1, height: 1 })
    expect(() => moveLayerDocumentCrop(rect, { x: Infinity, y: 0 }, output)).toThrow()
  })
  it.each(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as LayerDocumentCropHandle[])('keeps the opposite edges stable for handle %s without allowing an empty crop', (handle) => {
    const rect = { x: 10, y: 20, width: 100, height: 80 }, output = { width: 640, height: 480 }, next = resizeLayerDocumentCrop(rect, handle, { x: 200, y: 200 }, output)
    expect(next.width).toBeGreaterThanOrEqual(1); expect(next.height).toBeGreaterThanOrEqual(1)
    if (handle.includes('w')) expect(next.x + next.width).toBe(110)
    else expect(next.x).toBe(10)
    if (handle.includes('n')) expect(next.y + next.height).toBe(100)
    else expect(next.y).toBe(20)
    if (!handle.includes('e') && !handle.includes('w')) expect(next.width).toBe(100)
    if (!handle.includes('s') && !handle.includes('n')) expect(next.height).toBe(80)
  })
})

describe('non-destructive layer document crops', () => {
  it('preserves all physical layer geometry and local content bytes for a 640 by 480 to 400 by 280 crop', () => {
    const initial = recipe(), frozen = JSON.stringify(initial), rect = { x: 120, y: 100, width: 400, height: 280 }, cropped = cropLayerDocumentRecipe(initial, rect)
    expect(cropped.documentFrame).toEqual({ version: 1, width: 640, height: 480, offsetX: 120, offsetY: 100 })
    expect(cropped.layers).toHaveLength(initial.layers.length)
    for (const [index, before] of initial.layers.entries()) {
      const after = cropped.layers[index]
      expect(after.width * cropped.outputWidth).toBeCloseTo(before.width * initial.outputWidth)
      expect(after.height * cropped.outputHeight).toBeCloseTo(before.height * initial.outputHeight)
      for (const key of ['name', 'sourceIndex', 'rotation', 'flipX', 'locked', 'visible', 'content', 'edits', 'mask', 'colorGrade'] as const) expect(JSON.stringify(after[key])).toBe(JSON.stringify(before[key]))
      for (const [u, v] of [[0, 0], [1, 1], [.2, .8]]) {
        const oldPoint = world(before, initial, u, v), nextPoint = world(after, cropped, u, v)
        expect(nextPoint.x).toBeCloseTo(oldPoint.x - rect.x, 9); expect(nextPoint.y).toBeCloseTo(oldPoint.y - rect.y, 9)
      }
    }
    expect(JSON.stringify(initial)).toBe(frozen)
  })
  it('accumulates repeated crops without losing any hidden, locked or off-canvas layer', () => {
    const initial = recipe(), first = cropLayerDocumentRecipe(initial, { x: 120, y: 100, width: 400, height: 280 })
    const second = cropLayerDocumentRecipe(first, { x: 10, y: 20, width: 1, height: 1 }), direct = cropLayerDocumentRecipe(initial, { x: 130, y: 120, width: 1, height: 1 })
    expect(second.documentFrame).toEqual(direct.documentFrame)
    expect(second.layers).toHaveLength(6)
    second.layers.forEach((layer, i) => { for (const key of ['x', 'y', 'width', 'height'] as const) expect(layer[key]).toBeCloseTo(direct.layers[i][key], 9) })
    const replay = buildLayerDocumentReplayRecipe(second)
    replay.layers.forEach((layer, i) => { for (const key of ['x', 'y', 'width', 'height'] as const) expect(layer[key]).toBeCloseTo(initial.layers[i][key], 10) })
    expect(parseImageTransformRecipe(replay)).toEqual(replay)
  })
  it('maps new local paint points and masks identically after a translated crop', () => {
    const initial = recipe(), rect = { x: 120, y: 100, width: 400, height: 280 }, cropped = cropLayerDocumentRecipe(initial, rect)
    const point = { x: 230, y: 190 }, nextPoint = { x: point.x - rect.x, y: point.y - rect.y }
    expect(outputPointToLayerPoint(cropped.layers[0], { width: 400, height: 280 }, nextPoint)).toEqual(outputPointToLayerPoint(initial.layers[0], { width: 640, height: 480 }, point))
    const before = layerSelectionSnapshot(initial.layers[0], initial, { kind: 'ellipse', x: 140 / 640, y: 120 / 480, width: 100 / 640, height: 80 / 480, inverted: true, featherRadius: 4 })
    const after = layerSelectionSnapshot(cropped.layers[0], cropped, { kind: 'ellipse', x: 20 / 400, y: 20 / 280, width: 100 / 400, height: 80 / 280, inverted: true, featherRadius: 4 })
    after.transform.forEach((value, index) => expect(value).toBeCloseTo(before.transform[index], 12))
    expect(after.feather).toEqual(before.feather)
  })
  it('allows a normal new layer inside a one-pixel crop to replay in the original large frame', () => {
    const initial: ImageLayerRecipe = { kind: 'layer', outputWidth: 4096, outputHeight: 4096, background: 'transparent', explicitLayers: true, layers: [] }
    const cropped = applyEditorDocumentCrop(createLayerEditorState(initial, 0), { x: 4095, y: 4095, width: 1, height: 1 })
    const added = addEditorLayer(cropped, 'paint'), replay = buildLayerDocumentReplayRecipe(added.present.recipe)
    expect(replay.layers[0].width * replay.outputWidth).toBe(1)
    expect(replay.layers[0].height * replay.outputHeight).toBe(1)
    expect(parseImageTransformRecipe(replay)).toEqual(replay)
  })
  it('keeps the old extreme physical layer at a rightmost one-pixel crop without clamping', () => {
    const initial: ImageLayerRecipe = { kind: 'layer', outputWidth: 4096, outputHeight: 4096, background: 'transparent', explicitLayers: true, layers: [{ ...defaultEditorImageLayer(0), x: -2, y: -2, width: 4, height: 4 }] }
    const cropped = cropLayerDocumentRecipe(initial, { x: 4095, y: 4095, width: 1, height: 1 })
    expect(cropped.layers[0]).toMatchObject({ x: -12287, y: -12287, width: 16384, height: 16384 })
    expect(moveEditorLayer(cropped.layers[0], 0, 0, cropped)).toEqual({ x: -12287, y: -12287 })
    expect(resizeEditorLayer(cropped.layers[0], 'se', 0, 0, cropped)).toMatchObject({ x: -12287, y: -12287, width: 16384, height: 16384 })
    const state = createLayerEditorState(cropped, 1), copy = duplicateEditorLayer(state, state.present.ids[0])
    expect(copy.present.recipe.layers[1].x).toBe(-12286.975)
    expect(parseImageTransformRecipe(copy.present.recipe)).toEqual(copy.present.recipe)
  })
  it('commits dimensions, positions and cleared session selection as one undoable operation', () => {
    const state = createLayerEditorState(recipe(), 1)
    state.present.canvasSelection = { kind: 'rectangle', x: .1, y: .2, width: .3, height: .4, inverted: false }
    const crop = applyEditorDocumentCrop(state, { x: 120, y: 100, width: 400, height: 280 })
    expect(crop.past).toHaveLength(1); expect(crop.present.canvasSelection).toBeNull()
    expect(crop.present.ids).toEqual(state.present.ids); expect(crop.present.selectedId).toBe(state.present.selectedId); expect(crop.sequence).toBe(state.sequence)
    const undo = undoLayerEditor(crop)
    expect(undo.present).toEqual(state.present); expect(undo.past).toHaveLength(0)
    expect(redoLayerEditor(undo).present).toEqual(crop.present)
  })
  it('leaves no-op and invalid crop states untouched and rejects stale fractional payloads', () => {
    const state = createLayerEditorState(recipe(), 1), before = JSON.stringify(state)
    expect(applyEditorDocumentCrop(state, { x: 0, y: 0, width: 640, height: 480 })).toBe(state)
    for (const rect of [{ x: .1, y: 0, width: 100, height: 100 }, { x: 600, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 10 }, { x: NaN, y: 0, width: 1, height: 1 }]) expect(() => applyEditorDocumentCrop(state, rect)).toThrow()
    expect(JSON.stringify(state)).toBe(before)
  })
  it('requires implicit source layers to be materialized before a destructive window change', () => {
    const implicit: ImageLayerRecipe = { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', layers: [] }
    expect(() => cropLayerDocumentRecipe(implicit, { x: 120, y: 100, width: 400, height: 280 })).toThrow(/确认全部来源/)
    const state = createLayerEditorState(implicit, 2), crop = applyEditorDocumentCrop(state, { x: 120, y: 100, width: 400, height: 280 })
    expect(crop.present.recipe.explicitLayers).toBe(true)
    expect(crop.present.recipe.layers).toHaveLength(2)
    expect(crop.present.recipe.layers.every((layer) => layer.width * 400 === 640 && layer.height * 280 === 480)).toBe(true)
  })
  it('keeps existing manual normalized resize semantics while retaining and bounding the frame union', () => {
    const state = applyEditorDocumentCrop(createLayerEditorState(recipe(), 1), { x: 120, y: 100, width: 400, height: 280 })
    const resized = patchEditorRecipe(state, { outputWidth: 800, outputHeight: 500 })
    expect(resized.present.recipe.layers).toEqual(state.present.recipe.layers)
    expect(resized.present.recipe.documentFrame).toEqual({ version: 1, width: 920, height: 600, offsetX: 120, offsetY: 100 })
    const before = JSON.stringify(state)
    expect(() => patchEditorRecipe(state, { outputWidth: 4096 })).toThrow(/4096/)
    expect(JSON.stringify(state)).toBe(before)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { layerFilterRecipeFixture } from './layer-filter.test-fixture'
import { createLayerFilterStroke, appendEditorPaintStroke, layerSelectionSnapshot, remainingLayerPaintBudget, type LayerCanvasSelection } from './layer-paint-state'
import { createLayerEditorState, undoLayerEditor, redoLayerEditor } from './layer-editor-state'
import { imageLayerEditUsage, parseImageTransformRecipe, type ImageLayerRecipe, type ImageLayerFilterStroke } from './recipe'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile } from '../model'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { createBrowserLayerPsdExporter, inspectLayerPsdRecipe } from '../library/browser-layer-psd'

function workflow(recipe = layerFilterRecipeFixture()): WorkflowFile {
  return { ...createEmptyWorkflow('局部修图'), nodes: [{ id: 'layer', kind: 'image-layer', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: recipe }, result: { kind: 'image', assetId: 'a'.repeat(43) } } }], edges: [] }
}

describe('local filter recipe and workflow roundtrips', () => {
  it('commits a transformed stroke with a frozen selection as one reversible edit', () => {
    const recipe = layerFilterRecipeFixture(); delete recipe.layers[0].edits
    const layer = recipe.layers[0]; Object.assign(layer, { rotation: 90, flipX: true, width: .5, height: .5 })
    const initial = createLayerEditorState(recipe, 1), selected: LayerCanvasSelection = { kind: 'rectangle', x: .2, y: .1, width: .4, height: .7, inverted: true, featherRadius: 3 }
    const stroke = createLayerFilterStroke(layer, recipe, { size: 121, strength: .65 }, 'sharpen', { x: 160, y: 120 }, selected)
    expect(stroke.points).toEqual([[5000, 5000]])
    expect(stroke.selection).toEqual(layerSelectionSnapshot(layer, recipe, selected))
    const next = appendEditorPaintStroke(initial, initial.present.ids[0], stroke)
    stroke.points.push([6000, 5000]); selected.x = .8
    expect(next.past).toHaveLength(1)
    expect(remainingLayerPaintBudget(next.present.recipe)).toEqual({ points: 4095, operations: 255 })
    expect(undoLayerEditor(next).present.recipe).toEqual(initial.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(next)).present.recipe).toEqual(next.present.recipe)
    expect((next.present.recipe.layers[0].edits!.operations[0] as ImageLayerFilterStroke).points).toHaveLength(1)
  })
  it('strictly validates new filter fields while preserving old recipe bytes', () => {
    const recipe = layerFilterRecipeFixture(), value = parseImageTransformRecipe(recipe)
    expect(value).toEqual(recipe)
    const old = structuredClone(recipe); delete old.layers[0].edits
    expect(parseImageTransformRecipe(old)).toEqual(old)
    for (const patch of [{ size: 513 }, { strength: 1.1 }, { strength: NaN }, { mode: 'smudge' }, { color: '#ffffff' }, { points: [] }, { points: [[.5, 0]] }, { points: [[40000, 0]] }]) {
      const malformed = structuredClone(recipe); Object.assign(malformed.layers[0].edits!.operations[0], patch)
      expect(() => parseImageTransformRecipe(malformed)).toThrow()
      expect(sanitizeWorkflowV2(workflow(malformed))).toBeNull()
      expect(() => sanitizeWorkshopWorkflow(workflow(malformed), 'node', '坏配方')).toThrow()
    }
    const repeated = structuredClone(recipe); repeated.layers[0].edits!.operations = Array.from({ length: 256 }, () => ({ ...recipe.layers[0].edits!.operations[0], points: Array.from({ length: 17 }, () => [5000, 5000]) }) as ImageLayerFilterStroke)
    expect(imageLayerEditUsage(repeated.layers).points).toBe(4352)
    expect(() => parseImageTransformRecipe(repeated)).toThrow('容量')
  })
  it('supports 4K outputs and scaled layers while retaining the existing output budget', () => {
    const value = { ...layerFilterRecipeFixture(), outputWidth: 3840, outputHeight: 2160 }
    expect(() => parseImageTransformRecipe(value)).not.toThrow()
    value.layers[0].width = 2
    expect(() => parseImageTransformRecipe(value)).not.toThrow()
    expect(() => parseImageTransformRecipe({ ...value, outputWidth: 4097 })).toThrow()
    delete value.layers[0].edits
    expect(() => parseImageTransformRecipe(value)).not.toThrow()
  })
  it('keeps both modes and selection geometry through refresh, sanitizer and private-asset-free workshop reuse', () => {
    const source = workflow(), restored = parseWorkflowFile(serializeWorkflow(source))!
    expect(restored.nodes[0].data.settings?.imageTransform).toEqual(source.nodes[0].data.settings?.imageTransform)
    expect(sanitizeWorkflowV2(source)?.workflow.nodes[0].data.settings?.imageTransform).toEqual(source.nodes[0].data.settings?.imageTransform)
    const portable = sanitizeWorkshopWorkflow(restored, 'node', '模糊和锐化'), copy = instantiateWorkshopGraph(portable, () => 'copy')
    expect(JSON.stringify(portable)).not.toContain('a'.repeat(43))
    expect(copy.nodes[0].data.settings?.imageTransform).toEqual(source.nodes[0].data.settings?.imageTransform)
    const copied = copy.nodes[0].data.settings!.imageTransform as ImageLayerRecipe
    copied.layers[0].edits!.operations.splice(0, 1)
    expect((portable.nodes[0].data.settings!.imageTransform as ImageLayerRecipe).layers[0].edits!.operations).toHaveLength(2)
  })
  it('preserves ordered filters in PSD layer and composite rendering without changing the editable recipe', async () => {
    const recipe = layerFilterRecipeFixture(); recipe.layers[0].content = { kind: 'shape', shape: 'rectangle', fill: '#ffffff', stroke: '#000000', strokeWidth: 1 }
    recipe.outputWidth = 64; recipe.outputHeight = 48
    const sample = vi.fn(async () => ({ width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4) }))
    const before = structuredClone(recipe)
    expect(inspectLayerPsdRecipe(recipe, 0).recipe).toEqual(recipe)
    const exported = await createBrowserLayerPsdExporter({ decode: vi.fn(), sample })({ recipe, sources: [] })
    expect(exported.blob.type).toBe('image/vnd.adobe.photoshop')
    expect(sample).toHaveBeenCalledTimes(2)
    for (const call of sample.mock.calls as unknown as Array<[{ recipe: ImageLayerRecipe }]>) expect(call[0].recipe.layers[0].edits).toEqual(before.layers[0].edits)
    expect(recipe).toEqual(before)
  })
})

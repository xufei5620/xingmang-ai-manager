import { describe, expect, it } from 'vitest'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { defaultWholeLayerFilter, wholeLayerFilterDefinitions } from './layer-whole-filter'
import { appendLayerFilterRecipe, buildLayerFilterOperation, buildLayerFilterPreview, previewLayerFilterRecipe } from './layer-filter-editor-state'
import { createLayerEditorState } from './layer-editor-state'

function fixture() {
  return createLayerEditorState(defaultImageTransformRecipe('layer') as ImageLayerRecipe, 2).present.recipe
}
describe('whole layer filter draft and preview recipes', () => {
  it.each(wholeLayerFilterDefinitions.map((definition) => definition.type))('builds a strict %s draft without mutating the parent recipe', (type) => {
    const recipe = fixture(), before = structuredClone(recipe), operation = buildLayerFilterOperation(recipe, 0, defaultWholeLayerFilter(type)), next = appendLayerFilterRecipe(recipe, 0, operation)
    expect(recipe).toEqual(before); expect(next.layers[0].edits?.operations).toEqual([operation]); expect(next.layers[1]).toEqual(recipe.layers[1]); expect(operation.space).toEqual({ width: recipe.outputWidth, height: recipe.outputHeight })
  })
  it('keeps original output axes, crop replay domain, source binding and ordered edits for isolated preview', () => {
    const recipe = fixture(); recipe.outputWidth = 320; recipe.outputHeight = 240; recipe.documentFrame = { version: 1, width: 640, height: 480, offsetX: 120, offsetY: 90 }
    recipe.layers[1] = { ...recipe.layers[1], x: -.25, y: -.2, width: 2, height: 2, rotation: 45, flipX: true, opacity: .6, adjustments: { brightness: 1.1, contrast: 1, saturation: 1, grayscale: 0, blur: 2 }, edits: { version: 1, operations: [{ mode: 'fill', color: '#ff0000', opacity: .5 }] } }
    const before = structuredClone(recipe), operation = buildLayerFilterOperation(recipe, 1, defaultWholeLayerFilter('mosaic')), preview = previewLayerFilterRecipe(recipe, 1, operation)
    expect(preview.layers).toHaveLength(1); expect(preview.layers[0]).toEqual({ ...recipe.layers[1], edits: { version: 1, operations: [...recipe.layers[1].edits!.operations, operation] } }); expect(preview.documentFrame).toEqual(recipe.documentFrame); expect(preview.outputWidth).toBe(320); expect(preview.outputHeight).toBe(240); expect(preview.background).toBe('transparent'); expect(operation.space).toEqual({ width: 640, height: 480 }); expect(recipe).toEqual(before)
    expect(previewLayerFilterRecipe(recipe, 1, null).layers[0]).toEqual(recipe.layers[1])
  })
  it('rejects unsupported dimensions and aggregate limits before a draft can be committed', () => {
    const recipe = fixture(); recipe.layers[0].width = 20
    expect(() => buildLayerFilterOperation(recipe, 0, defaultWholeLayerFilter('gaussian'))).toThrow('4096')
    recipe.layers[0].width = 1; recipe.layers[0].edits = { version: 1, operations: Array.from({ length: 256 }, () => ({ mode: 'fill' as const, color: '#ff0000', opacity: 1 })) }
    expect(() => buildLayerFilterOperation(recipe, 0, defaultWholeLayerFilter('gaussian'))).toThrow()
  })
  it.each([false, true])('keeps the identical recipe for neutral comparison with existing edits=%s', (edited) => {
    const recipe = fixture(), layer = recipe.layers[0]
    layer.width = .75; layer.height = .625; layer.rotation = 30
    if (edited) layer.edits = { version: 1, operations: [{ mode: 'fill', color: '#123456', opacity: .25 }] }
    const saved = structuredClone(recipe), filter = defaultWholeLayerFilter('gaussian'); filter.parameters.radius = 0
    const operation = buildLayerFilterOperation(recipe, 0, filter), preview = buildLayerFilterPreview(recipe, 0, operation)
    expect(layer.content).toBeUndefined(); expect(preview.error).toBe(''); expect(preview.recipe).toBe(recipe); expect(preview.recipe.layers[0]).toBe(layer)
    expect(preview.recipe.layers[0].edits).toBe(layer.edits); expect(recipe).toEqual(saved)
    expect(preview.frame).toMatchObject({ width: Math.round(recipe.outputWidth * .75), height: Math.round(recipe.outputHeight * .625) })
    const ordered = appendLayerFilterRecipe(recipe, 0, operation)
    expect(ordered).not.toBe(recipe); expect(ordered.layers[0].edits?.operations).toEqual([...(layer.edits?.operations ?? []), operation])
  })
  it('does not treat malformed neutral parameters as a successful comparison', () => {
    const recipe = fixture(), filter = defaultWholeLayerFilter('gaussian'); filter.parameters.radius = 0
    const operation = buildLayerFilterOperation(recipe, 0, filter)
    const preview = buildLayerFilterPreview(recipe, 0, { ...operation, filter: { ...filter, parameters: { radius: 0, unexpected: 1 } } })
    expect(preview.frame).toBeNull(); expect(preview.error).not.toBe('')
  })
})

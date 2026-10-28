import { describe, expect, it } from 'vitest'
import { defaultWholeLayerFilter, isNeutralWholeLayerFilter, layerWholeFilterSpace, parseImageLayerWholeFilterOperation, parseWholeLayerFilter, wholeLayerFilterDefinitions } from './layer-whole-filter'
import { createLayerEditorState, redoLayerEditor, undoLayerEditor } from './layer-editor-state'
import { appendEditorLayerOperation } from './layer-paint-state'
import { imageLayerEditUsage, parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

function recipe(): ImageLayerRecipe { return { kind: 'layer', outputWidth: 320, outputHeight: 180, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: -.1, y: .2, width: 2, height: 480 / 180, opacity: 1, visible: true, rotation: 37, blend: 'source-over' }] } }

describe('whole layer filter persistent domain', () => {
  it('defines all 17 observed filter families with independent default parameters', () => {
    expect(wholeLayerFilterDefinitions).toHaveLength(17)
    expect(new Set(wholeLayerFilterDefinitions.map((item) => item.type)).size).toBe(17)
    for (const definition of wholeLayerFilterDefinitions) {
      const filter = defaultWholeLayerFilter(definition.type)
      expect(parseWholeLayerFilter(filter)).toEqual(filter)
      for (const parameter of definition.parameters) {
        expect(filter.parameters[parameter.key]).toBe(parameter.default)
        filter.parameters[parameter.key] = parameter.max + 1
        expect(() => parseWholeLayerFilter(filter)).toThrow()
        expect(defaultWholeLayerFilter(definition.type).parameters[parameter.key]).toBe(parameter.default)
        filter.parameters[parameter.key] = parameter.default
      }
    }
  })

  it('uses the full native layer size rather than the smaller document or crop window', () => {
    const value = recipe()
    expect(layerWholeFilterSpace(value, 0)).toEqual({ width: 640, height: 480 })
    value.outputWidth = 40; value.outputHeight = 28; value.layers[0].width = 16; value.layers[0].height = 480 / 28
    value.documentFrame = { version: 1, width: 320, height: 180, offsetX: 200, offsetY: 140 }
    expect(layerWholeFilterSpace(value, 0)).toEqual({ width: 640, height: 480 })
    value.layers[0].width = 200
    expect(() => layerWholeFilterSpace(value, 0)).toThrow('4096')
  })

  it.each(wholeLayerFilterDefinitions.map((item) => item.type))('preserves %s through strict recipe parsing and one reversible history commit', (type) => {
    const original = recipe(), before = JSON.stringify(parseImageTransformRecipe(original))
    const operation = { mode: 'whole-filter' as const, version: 1 as const, filter: defaultWholeLayerFilter(type), space: { width: 640, height: 480 } }
    expect(parseImageLayerWholeFilterOperation(operation)).toEqual(operation)
    const state = createLayerEditorState(original, 1), result = appendEditorLayerOperation(state, state.present.ids[0], operation)
    expect(result.past).toHaveLength(1)
    expect(parseImageTransformRecipe(result.present.recipe)).toEqual(result.present.recipe)
    expect(imageLayerEditUsage(result.present.recipe.layers)).toMatchObject({ points: 0, operations: 1 })
    expect(undoLayerEditor(result).present.recipe).toEqual(state.present.recipe)
    expect(redoLayerEditor(undoLayerEditor(result)).present.recipe).toEqual(result.present.recipe)
    operation.filter.parameters.untrusted = 1
    expect(result.present.recipe.layers[0].edits?.operations[0]).not.toEqual(operation)
    expect(JSON.stringify(parseImageTransformRecipe(original))).toBe(before)
  })

  it('rejects missing parameters, future versions, selection injection and invalid reference spaces', () => {
    const valid = { mode: 'whole-filter', version: 1, filter: defaultWholeLayerFilter('mosaic'), space: { width: 640, height: 480 } }
    for (const patch of [{ version: 2 }, { mode: 'blur' }, { selection: {} }, { filter: { type: 'unknown', parameters: {} } }, { filter: { type: 'mosaic', parameters: {} } }, { filter: { type: 'mosaic', parameters: { size: 4, url: 'https://invalid/' } } }, { space: { width: '640', height: 480 } }, { space: { width: 4097, height: 1 } }, { space: { width: 0, height: 480 } }]) expect(() => parseImageLayerWholeFilterOperation({ ...valid, ...patch })).toThrow()
    expect(() => parseWholeLayerFilter({ type: 'median', parameters: { radius: 1.5 } })).toThrow()
    expect(() => parseWholeLayerFilter({ type: 'gaussian', parameters: { radius: NaN } })).toThrow()
  })

  it('identifies only genuine neutral parameter states', () => {
    expect(isNeutralWholeLayerFilter(defaultWholeLayerFilter('lens-correction'))).toBe(true)
    expect(isNeutralWholeLayerFilter({ type: 'usm', parameters: { amount: 0, radius: 1, threshold: 0 } })).toBe(true)
    expect(isNeutralWholeLayerFilter({ type: 'gaussian', parameters: { radius: 0 } })).toBe(true)
    for (const type of ['median', 'mosaic', 'sharpen', 'edges', 'emboss'] as const) expect(isNeutralWholeLayerFilter(defaultWholeLayerFilter(type))).toBe(false)
  })
})

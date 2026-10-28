import { describe, expect, it } from 'vitest'
import { canvasRasterSelectionCount, combineCanvasSelections, isCurrentLayerPixelRequest, layerSelectionCombination, rasterizeCanvasSelection, resizeCanvasRasterSelection, type LayerPixelRequest } from './layer-canvas-selection'
import type { LayerCanvasSelection } from './layer-paint-state'
import type { ImageLayerRecipe } from './recipe'

const output = { width: 4, height: 2 }
function raster(runs: number[], inverted = false): Extract<LayerCanvasSelection, { kind: 'raster' }> { return { kind: 'raster', raster: { ...output, runs }, inverted } }

describe('canvas raster selection integration', () => {
  it('rasterizes normalized geometric selections at original output pixel centers', async () => {
    const selection: LayerCanvasSelection = { kind: 'rectangle', x: 0.25, y: 0, width: 0.5, height: 1, inverted: false }
    expect(await rasterizeCanvasSelection(selection, output)).toEqual({ ...output, runs: [1, 2, 5, 2] })
    expect(await rasterizeCanvasSelection({ ...selection, inverted: true }, output)).toEqual({ ...output, runs: [0, 1, 3, 1, 4, 1, 7, 1] })
  })

  it('combines both geometric and raster selections and retains an explicit empty result', async () => {
    const previous = { ...raster([0, 2, 4, 2]), featherRadius: 5 }, next = raster([1, 2, 5, 2])
    expect(await combineCanvasSelections(previous, next, 'add', output)).toEqual({ ...raster([0, 3, 4, 3]), featherRadius: 5 })
    expect(await combineCanvasSelections(previous, next, 'intersect', output)).toEqual({ ...raster([1, 1, 5, 1]), featherRadius: 5 })
    expect(await combineCanvasSelections(previous, previous, 'subtract', output)).toEqual({ ...raster([]), featherRadius: 5 })
    expect(await combineCanvasSelections(null, next, 'replace', output)).toBe(next)
    await expect(combineCanvasSelections(null, next, 'subtract', output)).rejects.toThrow('请先创建选区')
  })

  it('preserves inverted semantics and rejects resizing a stale native grid', async () => {
    const value = { ...raster([1, 1], true), featherRadius: 3 }
    expect(canvasRasterSelectionCount(value)).toBe(7)
    expect(await rasterizeCanvasSelection(value, output)).toEqual({ ...output, runs: [0, 1, 2, 2, 4, 4] })
    expect(await resizeCanvasRasterSelection(value, 0)).toEqual({ ...raster([0, 1, 2, 2, 4, 4]), featherRadius: 3 })
    await expect(rasterizeCanvasSelection(value, { width: 8, height: 2 })).rejects.toThrow('画布尺寸已变化')
    const controller = new AbortController(); controller.abort()
    await expect(resizeCanvasRasterSelection(value, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('maps modifier combinations without losing the explicit toolbar mode', () => {
    expect(layerSelectionCombination('subtract', { shiftKey: false, altKey: false })).toBe('subtract')
    expect(layerSelectionCombination('replace', { shiftKey: true, altKey: false })).toBe('add')
    expect(layerSelectionCombination('replace', { shiftKey: false, altKey: true })).toBe('subtract')
    expect(layerSelectionCombination('replace', { shiftKey: true, altKey: true })).toBe('intersect')
  })

  it('fences recipe layer source selection tool cancellation and request identity changes', () => {
    const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 4, outputHeight: 2, background: 'transparent', layers: [] }
    const selection = raster([0, 1]), present = { recipe, selectedId: 'one' }
    const request: LayerPixelRequest = { ...present, sourcesKey: 'v1', selection, tool: 'select-wand', controller: new AbortController() }
    expect(isCurrentLayerPixelRequest(request, request, present, 'v1', selection, 'select-wand')).toBe(true)
    expect(isCurrentLayerPixelRequest(request, null, present, 'v1', selection, 'select-wand')).toBe(false)
    expect(isCurrentLayerPixelRequest(request, request, { ...present, recipe: { ...recipe } }, 'v1', selection, 'select-wand')).toBe(false)
    expect(isCurrentLayerPixelRequest(request, request, { ...present, selectedId: 'two' }, 'v1', selection, 'select-wand')).toBe(false)
    expect(isCurrentLayerPixelRequest(request, request, present, 'v2', selection, 'select-wand')).toBe(false)
    expect(isCurrentLayerPixelRequest(request, request, present, 'v1', { ...selection }, 'select-wand')).toBe(false)
    expect(isCurrentLayerPixelRequest(request, request, present, 'v1', selection, 'bucket')).toBe(false)
    request.controller.abort()
    expect(isCurrentLayerPixelRequest(request, request, present, 'v1', selection, 'select-wand')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { createLayerEditorState, defaultEditorImageLayer, undoLayerEditor, redoLayerEditor } from './layer-editor-state'
import { appendLayerQuickPoint, appendLayerQuickStroke, clampLayerQuickPoint, layerQuickRegion, layerQuickSessionCurrent, type LayerQuickPixels, type LayerQuickSelectionSession } from './layer-quick-selection-state'
import { updateEditorCanvasSelection } from './layer-selection-history'
import type { LayerCanvasSelection } from './layer-paint-state'
import type { ImageLayerRecipe } from './recipe'

function fixture() {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 32, outputHeight: 24, background: 'transparent', layers: [defaultEditorImageLayer(0)] }
  const pixels: LayerQuickPixels = { recipe, selectedId: 'layer-1', sourcesKey: 'one', source: 'composite', width: 32, height: 24, data: new Uint8Array(32 * 24 * 4) }
  const session: LayerQuickSelectionSession = { pixels, region: { x: 2, y: 2, width: 28, height: 20 }, strokes: [], baseSelection: null, combination: 'replace' }
  return { recipe, pixels, session }
}

describe('quick selection interaction geometry and sessions', () => {
  it('maps reverse drags to native integer bounds and clamps captured pointers to the canvas', () => {
    expect(layerQuickRegion({ x: 10.2, y: 12.8 }, { x: 2.6, y: 3.2 }, { width: 32, height: 24 })).toEqual({ x: 2, y: 3, width: 9, height: 10 })
    expect(layerQuickRegion({ x: 10, y: 12 }, { x: -20, y: 40 }, { width: 32, height: 24 })).toEqual({ x: 0, y: 12, width: 10, height: 12 })
    expect(() => layerQuickRegion({ x: 2, y: 2 }, { x: 2, y: 2 }, { width: 32, height: 24 })).toThrow()
    expect(() => layerQuickRegion({ x: 0, y: 0 }, { x: 1001, y: 1000 }, { width: 4096, height: 4096 })).toThrow('100 万')
    expect(() => clampLayerQuickPoint({ x: NaN, y: 0 }, { x: 0, y: 0, width: 3, height: 3 })).toThrow('坐标')
  })

  it('retains sparse continuous brush capsules without overflowing the shared point budget', () => {
    const bounds = { x: 2, y: 2, width: 28, height: 20 }, start = [{ x: 5, y: 5 }]
    expect(appendLayerQuickPoint(start, { x: 5.1, y: 5.1 }, 24, 0, bounds)).toBe(start)
    expect(appendLayerQuickPoint(start, { x: 5.1, y: 5.1 }, 24, 0, bounds, true)).toHaveLength(2)
    expect(appendLayerQuickPoint(start, { x: 90, y: -5 }, 24, 0, bounds)).toEqual([...start, { x: 30, y: 2 }])
    expect(() => appendLayerQuickPoint(start, { x: 9, y: 9 }, 24, 4095, bounds)).toThrow('4096')
    expect(() => appendLayerQuickPoint(start, { x: 9, y: 9 }, 513, 0, bounds)).toThrow('笔径')
  })

  it('keeps foreground and background corrections immutable and bounded', () => {
    const { session } = fixture(), points = [{ x: 5, y: 8 }, { x: 9, y: 8 }]
    const strokes = appendLayerQuickStroke(session, 'foreground', 8, points)
    points[0].x = 20
    expect(strokes[0]).toEqual({ mode: 'foreground', diameter: 8, points: [{ x: 5, y: 8 }, { x: 9, y: 8 }] })
    expect(session.strokes).toHaveLength(0)
    expect(appendLayerQuickStroke({ ...session, strokes }, 'background', 12, [{ x: 2, y: 5 }])).toHaveLength(2)
    expect(() => appendLayerQuickStroke({ ...session, strokes: Array.from({ length: 128 }, () => strokes[0]) }, 'foreground', 8, [{ x: 5, y: 8 }])).toThrow('128')
    expect(() => appendLayerQuickStroke({ ...session, strokes: [{ ...strokes[0], points: Array.from({ length: 4096 }, () => ({ x: 5, y: 8 })) }] }, 'foreground', 8, [{ x: 5, y: 8 }])).toThrow('4096')
  })

  it.each(['recipe', 'selectedId', 'sourcesKey', 'source', 'pixels'] as const)('does not reuse frozen pixels after changing %s', (key) => {
    const { recipe, pixels, session } = fixture()
    const present = { recipe, selectedId: 'layer-1' }
    expect(layerQuickSessionCurrent(session, pixels, present, 'one', 'composite')).toBe(true)
    expect(layerQuickSessionCurrent(session, key === 'pixels' ? { ...pixels } : pixels, key === 'recipe' ? { ...present, recipe: structuredClone(recipe) } : key === 'selectedId' ? { ...present, selectedId: null } : present, key === 'sourcesKey' ? 'two' : 'one', key === 'source' ? 'current' : 'composite')).toBe(false)
  })

  it('remembers constraint-changing strokes even when two segmentation masks happen to be equal', () => {
    const { recipe } = fixture(), initial = createLayerEditorState(recipe, 1)
    const selection: LayerCanvasSelection = { kind: 'raster', inverted: false, raster: { width: 32, height: 24, runs: [35, 3] } }
    const first = updateEditorCanvasSelection(initial, selection, true, true)
    const sameMask = structuredClone(selection), second = updateEditorCanvasSelection(first, sameMask, true, true)
    expect(second.past).toHaveLength(2)
    expect(undoLayerEditor(second).present.canvasSelection).toBe(selection)
    expect(redoLayerEditor(undoLayerEditor(second)).present.canvasSelection).toBe(sameMask)
    expect(second.present.recipe).toBe(initial.present.recipe)
  })
})

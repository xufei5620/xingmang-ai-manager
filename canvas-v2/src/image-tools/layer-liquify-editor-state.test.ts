import { describe, expect, it } from 'vitest'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { defaultEditorImageLayer } from './layer-editor-state'
import type { ImageLayerLiquifyStroke } from './layer-liquify'
import { appendLiquifyPoint, appendLiquifyRecipe, buildLiquifyOperation, hasLiquifyStroke, layerLiquifySpace, liquifyHistoryChange, liquifyHistoryStep, liquifyPoint, zoomLiquifyView, type LiquifyHistory } from './layer-liquify-editor-state'

function recipe(): ImageLayerRecipe { return { ...defaultImageTransformRecipe('layer') as ImageLayerRecipe, outputWidth: 1000, outputHeight: 500, layers: [defaultEditorImageLayer(0)] } }
function stroke(): ImageLayerLiquifyStroke { return { tool: 'push', radius: 50, strength: .5, points: [[2000, 2000], [4000, 4000]] } }

describe('liquify editing coordinates and bounded draft history', () => {
  it('uses selected layer local pixels and rejects unsupported sizes without silently rescaling', () => {
    const value = recipe(); value.layers[0] = { ...value.layers[0], width: .5, height: .25, rotation: 90, flipX: true }
    expect(layerLiquifySpace(value, 0)).toEqual({ width: 500, height: 125 })
    value.layers[0].width = 5; expect(() => layerLiquifySpace(value, 0)).toThrow('4096')
    value.layers[0].width = 1; value.layers[0].locked = true; expect(() => layerLiquifySpace(value, 0)).toThrow('未锁定')
  })
  it('maps local pixel coordinates without aspect distortion and refuses off-image pointer samples', () => {
    const space = { width: 1200, height: 300 }
    expect(liquifyPoint({ x: 600, y: 75 }, space)).toEqual([5000, 2500])
    expect(liquifyPoint({ x: 1200, y: 300 }, space)).toEqual([10000, 10000])
    for (const point of [{ x: -1, y: 0 }, { x: 1201, y: 1 }, { x: 1, y: 301 }, { x: NaN, y: 2 }]) expect(liquifyPoint(point, space)).toBeNull()
  })
  it('samples by original pixel distance and retains a short final push without duplicating taps', () => {
    const value = { ...stroke(), points: [[1000, 1000]] as Array<[number, number]> }, space = { width: 1000, height: 500 }
    expect(appendLiquifyPoint(value, [1001, 1001], space)).toBe(value)
    expect(appendLiquifyPoint(value, [1001, 1001], space, true).points).toHaveLength(2)
    expect(appendLiquifyPoint(value, [1000, 1000], space, true)).toBe(value)
    const full = { ...value, points: Array.from({ length: 256 }, (): [number, number] => [0, 0]) }
    expect(() => appendLiquifyPoint(full, [10000, 10000], space)).toThrow('256')
  })
  it('does not record zero-strength strokes or immobile push taps but supports single-point radial tools', () => {
    expect(hasLiquifyStroke({ ...stroke(), strength: 0 })).toBe(false)
    expect(hasLiquifyStroke({ ...stroke(), points: [[1, 1], [1, 1]] })).toBe(false)
    expect(buildLiquifyOperation({ width: 100, height: 100 }, [{ ...stroke(), points: [[1, 1]] }])).toBeNull()
    for (const tool of ['bulge', 'pinch', 'twirl-cw', 'twirl-ccw'] as const) expect(hasLiquifyStroke({ ...stroke(), tool, points: [[1, 1]] })).toBe(true)
  })
  it('validates the cumulative recipe and appends after earlier drawing without touching other layers', () => {
    const value = recipe(); value.layers.push({ ...defaultEditorImageLayer(1), opacity: .4 }); value.layers[0].edits = { version: 1, operations: [{ mode: 'fill', color: '#ff0000', opacity: 1 }] }
    const previous = structuredClone(value), operation = buildLiquifyOperation({ width: 1000, height: 500 }, [stroke()])!
    const next = appendLiquifyRecipe(value, 0, operation)
    expect(value).toEqual(previous); expect(next.layers[0].edits?.operations.map((entry) => entry.mode)).toEqual(['fill', 'liquify']); expect(next.layers[1]).toEqual(value.layers[1])
    value.layers[0].edits.operations = Array.from({ length: 256 }, () => ({ mode: 'fill', color: '#ffffff', opacity: 1 }))
    expect(() => appendLiquifyRecipe(value, 0, operation)).toThrow()
  })
  it('does not allow an otherwise valid new draft to bypass prior point budgets', () => {
    const value = recipe(), points = Array.from({ length: 256 }, (_, index): [number, number] => [index, index])
    value.layers[0].edits = { version: 1, operations: [buildLiquifyOperation({ width: 1000, height: 500 }, Array.from({ length: 16 }, () => ({ ...stroke(), points })))!] }
    expect(() => appendLiquifyRecipe(value, 0, buildLiquifyOperation({ width: 1000, height: 500 }, [stroke()]))).toThrow()
  })
  it('keeps resets undoable and discards redo only after a new committed stroke', () => {
    const initial: LiquifyHistory = { past: [], strokes: [], future: [] }, first = liquifyHistoryChange(initial, [stroke()]), reset = liquifyHistoryChange(first, [])
    expect(liquifyHistoryStep(reset).strokes).toEqual(first.strokes)
    expect(liquifyHistoryStep(liquifyHistoryStep(reset), true).strokes).toEqual([])
    const undo = liquifyHistoryStep(first), next = liquifyHistoryChange(undo, [{ ...stroke(), tool: 'pinch' }])
    expect(next.future).toEqual([]); expect(initial.strokes).toEqual([])
    expect(liquifyHistoryStep(initial)).toBe(initial); expect(liquifyHistoryChange(initial, [])).toBe(initial)
  })
  it('holds the cursor anchor stable while scaling and clamps excessive zoom', () => {
    const view = { zoom: 1, x: 20, y: 30 }, anchor = { x: 120, y: 80 }, next = zoomLiquifyView(view, 2, anchor)
    expect((anchor.x - next.x) / next.zoom).toBe((anchor.x - view.x) / view.zoom)
    expect((anchor.y - next.y) / next.zoom).toBe((anchor.y - view.y) / view.zoom)
    expect(zoomLiquifyView(view, 100).zoom).toBe(8); expect(zoomLiquifyView(view, 0).zoom).toBe(.25); expect(zoomLiquifyView(view, NaN)).toEqual(view)
  })
})

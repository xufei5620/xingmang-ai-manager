import { describe, expect, it } from 'vitest'
import { appendLayerPenAnchor, dragLayerPenHandles, hasLayerGradientDistance, isCurrentLayerVectorScope, layerPenGuidePath } from './layer-vector-gesture'
import type { ImageLayerRecipe } from './recipe'

describe('layer vector gesture drafts', () => {
  it('preserves anchors until completion and ignores double-click duplicates', () => {
    const first = [{ x: 10, y: 20 }], output = { width: 100, height: 100 }
    const second = appendLayerPenAnchor(first, { x: 70, y: 30 }, output, 1024)
    expect(first).toEqual([{ x: 10, y: 20 }])
    expect(second).toEqual([{ x: 10, y: 20 }, { x: 70, y: 30 }])
    expect(appendLayerPenAnchor(second, { x: 70.1, y: 30.1 }, output, 1024)).toEqual(second)
    expect(() => appendLayerPenAnchor(second, { x: 110, y: 20 }, output, 1024)).toThrow('画布内')
    expect(() => appendLayerPenAnchor(second, { x: 30, y: 70 }, output, 2)).toThrow('最多 2')
  })

  it('rejects zero-length and invalid gradient gestures before creating an operation', () => {
    expect(hasLayerGradientDistance({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(false)
    expect(hasLayerGradientDistance({ x: 1, y: 2 }, { x: 1.1, y: 2.1 })).toBe(false)
    expect(hasLayerGradientDistance({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(true)
    expect(hasLayerGradientDistance({ x: 1, y: 2 }, { x: NaN, y: 3 })).toBe(false)
  })

  it('builds symmetric cubic handles and keeps the closing segment consistent with open segments', () => {
    const anchor = { x: 20, y: 30 }, curved = dragLayerPenHandles(anchor, { x: 30, y: 50 }, { width: 100, height: 100 })
    expect(curved).toEqual({ ...anchor, in: { x: 10, y: 10 }, out: { x: 30, y: 50 } })
    expect(anchor).toEqual({ x: 20, y: 30 })
    expect(dragLayerPenHandles(anchor, anchor, { width: 100, height: 100 })).toEqual(anchor)
    expect(layerPenGuidePath([curved, { x: 70, y: 30 }, { x: 50, y: 70 }], true)).toBe('M 20 30 C 30 50 70 30 70 30 L 50 70 C 50 70 10 10 20 30 Z')
    const bounded = dragLayerPenHandles(anchor, { x: 99999, y: -99999 }, { width: 100, height: 100 })
    expect(bounded.out).toEqual({ x: 220, y: -170 })
    expect(bounded.in).toEqual({ x: -180, y: 230 })
  })

  it('invalidates pending paths and gradients on document layer source or selection changes', () => {
    const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 100, outputHeight: 100, background: 'transparent', layers: [] }
    const present = { recipe, selectedId: null }, scope = { ...present, sourcesKey: 'source-v1', selection: null }
    expect(isCurrentLayerVectorScope(scope, present, 'source-v1', null)).toBe(true)
    expect(isCurrentLayerVectorScope(scope, { ...present, recipe: { ...recipe } }, 'source-v1', null)).toBe(false)
    expect(isCurrentLayerVectorScope(scope, { ...present, selectedId: 'other' }, 'source-v1', null)).toBe(false)
    expect(isCurrentLayerVectorScope(scope, present, 'source-v2', null)).toBe(false)
    expect(isCurrentLayerVectorScope(scope, present, 'source-v1', { kind: 'rectangle', x: 0, y: 0, width: 1, height: 1, inverted: false })).toBe(false)
  })
})

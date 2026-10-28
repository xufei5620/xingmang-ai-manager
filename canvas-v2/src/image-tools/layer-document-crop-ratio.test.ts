import { describe, expect, it } from 'vitest'
import { buildLayerDocumentCropRatio, fitLayerDocumentCropRatio, resizeLayerDocumentCropRatio, type LayerDocumentCropRatio } from './layer-document-crop-ratio'
import type { LayerDocumentCropHandle } from './layer-document-crop'
const output = { width: 640, height: 480 }

describe('integer document crop ratios', () => {
  it.each<LayerDocumentCropRatio>([[1, 1], [4, 3], [3, 2], [16, 9], [9, 16]])('fits an exact %i:%i crop around the old center', (p, q) => {
    const rect = fitLayerDocumentCropRatio({ x: 0, y: 0, ...output }, [p, q], output)!
    expect(rect.width * q).toBe(rect.height * p); expect(rect.x + rect.width).toBeLessThanOrEqual(640); expect(rect.y + rect.height).toBeLessThanOrEqual(480)
    expect(Math.abs(rect.x + rect.width / 2 - 320)).toBeLessThanOrEqual(.5); expect(Math.abs(rect.y + rect.height / 2 - 240)).toBeLessThanOrEqual(.5)
  })
  it('draws a real 320 by 180 box and handles reverse-direction drags', () => {
    expect(buildLayerDocumentCropRatio({ x: 80, y: 70 }, { x: 400, y: 250 }, [16, 9], output)).toEqual({ x: 80, y: 70, width: 320, height: 180 })
    expect(buildLayerDocumentCropRatio({ x: 400, y: 250 }, { x: 80, y: 70 }, [16, 9], output)).toEqual({ x: 80, y: 70, width: 320, height: 180 })
  })
  it.each<LayerDocumentCropHandle>(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'])('keeps the ratio and document bounds when resizing %s', (handle) => {
    const rect = resizeLayerDocumentCropRatio({ x: 160, y: 150, width: 320, height: 180 }, handle, { x: 117, y: -43 }, [16, 9], output)!
    expect(rect.width * 9).toBe(rect.height * 16); expect(rect.width).toBeGreaterThanOrEqual(16); expect(rect.height).toBeGreaterThanOrEqual(9); expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(640); expect(rect.y + rect.height).toBeLessThanOrEqual(480)
  })
  it('preserves the opposite corner or edge center while changing dimensions', () => {
    const rect = { x: 160, y: 150, width: 320, height: 180 }
    expect(resizeLayerDocumentCropRatio(rect, 'nw', { x: 16, y: 9 }, [16, 9], output)).toEqual({ x: 176, y: 159, width: 304, height: 171 })
    expect(resizeLayerDocumentCropRatio(rect, 'e', { x: 32, y: 0 }, [16, 9], output)).toEqual({ x: 160, y: 141, width: 352, height: 198 })
  })
  it('refuses ratios that cannot fit one full pixel block and keeps 1:1 available', () => {
    expect(fitLayerDocumentCropRatio({ x: 0, y: 0, width: 1, height: 1 }, [16, 9], { width: 8, height: 8 })).toBeNull()
    expect(buildLayerDocumentCropRatio({ x: 0, y: 0 }, { x: 8, y: 8 }, [16, 9], { width: 8, height: 8 })).toBeNull()
    expect(fitLayerDocumentCropRatio({ x: 0, y: 0, width: 1, height: 1 }, [1, 1], { width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
  it('keeps exact integer geometry for boundary and extreme resize deltas', () => {
    const handles: LayerDocumentCropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
    for (const handle of handles) for (const x of [-10000, -200, -1, 0, 1, 200, 10000]) for (const y of [-10000, -200, -1, 0, 1, 200, 10000]) {
      const rect = resizeLayerDocumentCropRatio({ x: 3, y: 2, width: 48, height: 27 }, handle, { x, y }, [16, 9], { width: 60, height: 40 })!
      expect(Object.values(rect).every(Number.isInteger)).toBe(true); expect(rect.width * 9).toBe(rect.height * 16)
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(60); expect(rect.y + rect.height).toBeLessThanOrEqual(40)
    }
  })
  it('does not invent a box for an unmoved pointer or allow invalid ratios', () => {
    expect(buildLayerDocumentCropRatio({ x: 10, y: 10 }, { x: 10, y: 10 }, [4, 3], output)).toBeNull()
    expect(() => fitLayerDocumentCropRatio({ x: 0, y: 0, ...output }, [0, 3], output)).toThrow('比例无效')
    expect(() => resizeLayerDocumentCropRatio({ x: 0, y: 0, width: 10, height: 10 }, 'se', { x: 10, y: 10 }, [4, 3], output)).toThrow('比例不一致')
  })
})

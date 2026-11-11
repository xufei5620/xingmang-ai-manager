import { describe, expect, it } from 'vitest'
import {
  canvasImageTransformKindForNode,
  orderCanvasCollageSources,
  parseCanvasImageTransformRecipe,
  selectCanvasTileSource,
} from './canvas-image-tools'

function sources(...edges: string[]) {
  return edges.map((edgeId) => ({ edgeId, outputIndex: 0, asset: edgeId }))
}

describe('canvas image tools', () => {
  it('names the five kinds the page makes pictures for and nothing else', () => {
    expect(canvasImageTransformKindForNode('image-crop')).toBe('crop')
    expect(canvasImageTransformKindForNode('image-collage')).toBe('collage')
    expect(canvasImageTransformKindForNode('image-grid-split')).toBe('grid-split')
    expect(canvasImageTransformKindForNode('image-tile')).toBe('tile')
    expect(canvasImageTransformKindForNode('image-layer')).toBe('layer')
    for (const kind of ['image-compare', 'image-panorama', 'image', 'text'] as const) {
      expect(canvasImageTransformKindForNode(kind)).toBeNull()
    }
  })

  it('keeps the recipe as it came and reads only the size to check against', () => {
    const recipe = { kind: 'crop', x: 0, y: 0, width: 0.5, height: 0.5, outputWidth: 640, outputHeight: 480, rotation: 90, flipX: false, flipY: true }
    const parsed = parseCanvasImageTransformRecipe('image-crop', recipe, { remaining: 10_000 })
    expect(parsed).toEqual({ recipe, expectation: { count: 1, size: { width: 640, height: 480 } }, layerGroups: false })
    expect(parsed.recipe).not.toBe(recipe)
    // Only a horizontal or vertical strip sized to its pictures leaves the size to the page.
    expect(parseCanvasImageTransformRecipe('image-collage', { kind: 'collage', outputWidth: 800, outputHeight: 600, layout: 'vertical', autoSize: true }, { remaining: 10_000 }).expectation)
      .toEqual({ count: 1 })
    expect(parseCanvasImageTransformRecipe('image-collage', { kind: 'collage', outputWidth: 800, outputHeight: 600, layout: 'grid', autoSize: true }, { remaining: 10_000 }).expectation)
      .toEqual({ count: 1, size: { width: 800, height: 600 } })
    expect(parseCanvasImageTransformRecipe('image-layer', { kind: 'layer', outputWidth: 8, outputHeight: 8, layers: [{ group: { layerGroups: [] } }] }, { remaining: 10_000 }).layerGroups).toBe(true)
  })

  // A grid split makes one slice per cell, each as large as the page's decoded
  // picture makes it, so only the count is checked (as on the web host).
  it('expects one slice per grid cell and no size from a grid split', () => {
    const recipe = { kind: 'grid-split', rows: 3, columns: 4, gap: 2, padding: 0 }
    expect(parseCanvasImageTransformRecipe('image-grid-split', recipe, { remaining: 10_000 }))
      .toEqual({ recipe, expectation: { count: 12 }, layerGroups: false })
    expect(parseCanvasImageTransformRecipe('image-grid-split', { kind: 'grid-split', rows: 4, columns: 4 }, { remaining: 10_000 }).expectation).toEqual({ count: 16 })
    for (const [rows, columns, message] of [[0, 2, '行数'], [5, 2, '行数'], [1.5, 2, '行数'], ['2', 2, '行数'], [2, 0, '列数'], [2, 5, '列数'], [2, null, '列数']] as const) {
      expect(() => parseCanvasImageTransformRecipe('image-grid-split', { kind: 'grid-split', rows, columns }, { remaining: 10_000 })).toThrow(`画布图片处理${message}格式错误`)
    }
    expect(() => parseCanvasImageTransformRecipe('image-grid-split', { kind: 'crop', outputWidth: 8, outputHeight: 8 }, { remaining: 10_000 })).toThrow('图片处理参数与节点类型不匹配')
  })

  it('spends the shared budget and refuses a recipe past it', () => {
    const budget = { remaining: 20 }
    expect(() => parseCanvasImageTransformRecipe('image-crop', { kind: 'crop', outputWidth: 8, outputHeight: 8, note: 'x'.repeat(64) }, budget)).toThrow('工作流规模超过安全上限')
  })

  it('puts arranged collage pictures first and keeps the rest in their place after them', () => {
    const order = { version: 1 as const, slots: [{ edgeId: 'c', outputIndex: 0 }, { edgeId: 'gone', outputIndex: 0 }, { edgeId: 'a', outputIndex: 0 }] }
    expect(orderCanvasCollageSources(sources('a', 'b', 'c', 'd'), order).map((source) => source.edgeId)).toEqual(['c', 'a', 'b', 'd'])
    expect(orderCanvasCollageSources(sources('a', 'b'), undefined).map((source) => source.edgeId)).toEqual(['a', 'b'])
  })

  it('takes the first tile picture without a choice and exactly the chosen one with it', () => {
    expect(selectCanvasTileSource(sources('a', 'b'), undefined)?.edgeId).toBe('a')
    expect(selectCanvasTileSource([], undefined)).toBeNull()
    expect(selectCanvasTileSource(sources('a', 'b'), { edgeId: 'b', outputIndex: 0 })?.edgeId).toBe('b')
    // A later output of a connection that carries one picture is simply not there.
    expect(selectCanvasTileSource(sources('a', 'b'), { edgeId: 'b', outputIndex: 3 })).toBeNull()
    expect(() => selectCanvasTileSource(sources('a'), { edgeId: 'b', outputIndex: 0 })).toThrow('已选平铺贴图的连线已移除，请重新选择贴图')
    expect(() => selectCanvasTileSource(sources('a'), { missing: true })).toThrow('已选平铺贴图已移除，请重新选择贴图')
  })
})

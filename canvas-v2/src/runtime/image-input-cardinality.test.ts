import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from '../image-tools/recipe'
import { canvasImageInputCardinality, canvasImageTransformInputErrors } from './image-input-cardinality'
import { imageCollageTemplates } from '../image-tools/collage-templates'

function source(kind = 'image-grid-split', recipe: unknown = { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 }): CanvasRunGraph['nodes'][number] {
  return { id: 'source', kind, definitionVersion: 1, data: { prompt: '', model: '', imageTransform: recipe as CanvasRunGraph['nodes'][number]['data']['imageTransform'] } }
}
function count(handles: string[], node = source()) { return canvasImageInputCardinality(handles.map((sourceHandle) => ({ source: node.id, sourceHandle })), new Map([[node.id, node]])) }

describe('ordered image input cardinality', () => {
  it.each(imageCollageTemplates)('checks exact $title inputs while allowing unresolved batch cardinality', (template) => {
    const base = defaultImageTransformRecipe('collage')
    if (base.kind !== 'collage') throw new Error('bad fixture')
    const recipe = { ...base, layout: template.layout }
    expect(canvasImageTransformInputErrors(recipe, count(Array(template.inputCount).fill('out:image')))).toEqual([])
    expect(canvasImageTransformInputErrors(recipe, count(['out:images'], source('gallery')))).toEqual([])
    expect(canvasImageTransformInputErrors(recipe, count(['out:images'], source('image-grid-split', { kind: 'grid-split', rows: 1, columns: template.inputCount, padding: 0, gap: 0 })))).toEqual([])
    for (const invalid of [1, template.inputCount + 1]) expect(canvasImageTransformInputErrors(recipe, count(Array(invalid).fill('out:image')))).toEqual([expect.stringContaining(`恰好 ${template.inputCount} 张`)])
    expect(canvasImageTransformInputErrors(recipe, count(['out:images']))).toEqual([expect.stringContaining('不会自动丢弃图片')])
    expect(canvasImageTransformInputErrors(recipe, count(Array(template.inputCount + 1).fill('out:images'), source('gallery')))).toEqual([`${template.title}模板需要恰好 ${template.inputCount} 张输入图片，当前至少 ${template.inputCount + 1} 张；请调整来源或改用其他布局，不会自动丢弃图片`])
  })
  it('distinguishes one selected image from the complete grid and preserves repeated bindings', () => {
    expect(count(['out:image'])).toEqual({ connections: 1, minimum: 1, exact: true, hasBatch: false })
    expect(count(['out:images'])).toEqual({ connections: 1, minimum: 9, exact: true, hasBatch: true })
    expect(count(['out:images', 'out:image', 'out:images'])).toEqual({ connections: 3, minimum: 19, exact: true, hasBatch: true })
  })

  it('keeps invalid or unknown batches uncertain instead of treating the lower bound as their exact count', () => {
    for (const node of [source('gallery', undefined), source('image-grid-split', { kind: 'grid-split', rows: 0, columns: 3 })]) {
      const value = count(['out:images'], node)
      expect(value).toMatchObject({ minimum: 1, exact: false })
      const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
      recipe.layers = [{ sourceIndex: 8, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: false }]
      expect(canvasImageTransformInputErrors(recipe, value)).toEqual([])
      expect(canvasImageTransformInputErrors(recipe, count(['out:image'], node))).toEqual([expect.stringContaining('至少 9 张图片，并按原图层引用顺序对应')])
    }
  })

  it('uses an exact nine-image capacity check and discloses lower-bound errors as at least', () => {
    const recipe = defaultImageTransformRecipe('collage')
    if (recipe.kind !== 'collage') throw new Error('bad fixture')
    expect(canvasImageTransformInputErrors(recipe, count(['out:images']))).toEqual(['9 张输入需至少 9 格，当前 2×2=4 格，请调整拼图行列'])
    expect(canvasImageTransformInputErrors({ ...recipe, rows: 3, columns: 3 }, count(['out:images']))).toEqual([])
    expect(canvasImageTransformInputErrors(recipe, count(Array(5).fill('out:images'), source('gallery')))).toEqual(['至少 5 张输入需至少 5 格，当前 2×2=4 格，请调整拼图行列'])
  })

  it('uses strip and hero capacities for known batches without rejecting an unknown single batch as one image', () => {
    const base = defaultImageTransformRecipe('collage')
    if (base.kind !== 'collage') throw new Error('bad fixture')
    for (const layout of ['horizontal', 'vertical'] as const) {
      expect(canvasImageTransformInputErrors({ ...base, layout }, count(['out:images', 'out:images']))).toEqual([])
      expect(canvasImageTransformInputErrors({ ...base, layout }, count(Array(20).fill('out:image')))).toEqual([])
      expect(canvasImageTransformInputErrors({ ...base, layout }, count(['out:images', 'out:images', 'out:images']))).toContain('整组输出展开后有 27 张输入图片，超过 20 张上限，请减少来源')
    }
    for (const layout of ['hero-left', 'hero-top'] as const) {
      const recipe = { ...base, layout }
      expect(canvasImageTransformInputErrors(recipe, count(['out:images'], source('gallery')))).toEqual([])
      expect(canvasImageTransformInputErrors(recipe, count(['out:image']))).toEqual(['主辅图拼图需要 2–3 张输入图片，请调整来源；不会自动丢弃图片'])
      expect(canvasImageTransformInputErrors(recipe, count(['out:image', 'out:image', 'out:image']))).toEqual([])
      expect(canvasImageTransformInputErrors(recipe, count(['out:images']))).toEqual(['主辅图拼图需要 2–3 张输入图片，请调整来源；不会自动丢弃图片'])
    }
  })

  it('checks expanded global limits and known bitmap positions without inventing source availability', () => {
    const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    recipe.layers = [{ sourceIndex: 8, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: false }]
    expect(canvasImageTransformInputErrors(recipe, count(['out:images']))).toEqual([])
    recipe.layers[0].sourceIndex = 9
    expect(canvasImageTransformInputErrors(recipe, count(['out:images']))).toEqual([expect.stringContaining('至少 10 张图片，并按原图层引用顺序对应')])
    expect(canvasImageTransformInputErrors(recipe, count(['out:images', 'out:images', 'out:images']))).toContain('整组输出展开后有 27 张输入图片，超过 20 张上限，请减少来源')
    expect(canvasImageTransformInputErrors(recipe, count([]))).toEqual([expect.stringContaining('至少 10 张图片，并按原图层引用顺序对应')])
  })

  it('requires the highest ordered bitmap slot for zero one or four sources without counting content or deduplicating repeated references', () => {
    const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    const leaf = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over' as const, visible: true }
    recipe.explicitLayers = true
    recipe.layers = [leaf, { ...leaf, sourceIndex: 3 }, { ...leaf, sourceIndex: 3 }, { ...leaf, sourceIndex: 19, content: { kind: 'shape', shape: 'rectangle', fill: '#ffffff', stroke: 'transparent', strokeWidth: 0 } }]
    for (const length of [0, 1, 4]) expect(canvasImageTransformInputErrors(recipe, count(Array(length).fill('out:image')))).toEqual(length === 4 ? [] : [expect.stringContaining('至少 4 张图片，并按原图层引用顺序对应')])
    expect(canvasImageTransformInputErrors(recipe, count(['out:images'], source('gallery')))).toEqual([])
    expect(canvasImageTransformInputErrors(recipe, count(Array(21).fill('out:image')))).toEqual(['图片处理需要连接 1–20 个图片来源'])
  })

  it('permits bounded tile source pools for separate slot validation and retains source-free layers', () => {
    const tile = defaultImageTransformRecipe('tile')
    expect(canvasImageTransformInputErrors(tile, count(['out:image']))).toEqual([])
    for (const handles of [['out:image', 'out:image'], ['out:images']]) expect(canvasImageTransformInputErrors(tile, count(handles))).toEqual([])
    const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    expect(canvasImageTransformInputErrors({ ...recipe, explicitLayers: true }, count([]))).toEqual([])
  })
})

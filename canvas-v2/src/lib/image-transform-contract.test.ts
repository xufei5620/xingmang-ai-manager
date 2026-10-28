import { describe, expect, it } from 'vitest'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { imageTransformProcessorRevision, parseImagePreparation, parseImageTransformManifestForPreparation } from './image-transform-contract'
import { imageCollageTemplates } from '../image-tools/collage-templates'

function preparation(recipe: unknown, count = 3) {
  return parseImagePreparation({ operationId: 'attempt', attemptId: 'attempt', runId: 'run', projectId: '569d5c2e-5e9c-446b-8a2e-cf12357179a3', nodeId: 'collage', sourceAssetIds: Array(count).fill('s'.repeat(43)), recipe, processorRevision: imageTransformProcessorRevision })
}

const output = { index: 0, pngDigest: 'a'.repeat(64), byteSize: 100, width: 3253, height: 640 }

describe('collage preparation manifests', () => {
  it.each(imageCollageTemplates)('validates $title source cardinality and exact output dimensions', (template) => {
    const recipe = { ...defaultImageTransformRecipe('collage'), layout: template.layout, outputWidth: 800, outputHeight: 600 }
    const input = preparation(recipe, template.inputCount)
    expect(input.recipe).toMatchObject(recipe)
    expect(parseImageTransformManifestForPreparation([{ ...output, width: 800, height: 600 }], input)).toHaveLength(1)
    expect(() => parseImageTransformManifestForPreparation([output], input)).toThrow('尺寸')
    for (const count of [1, template.inputCount + 1]) expect(() => preparation(recipe, count)).toThrow(`恰好 ${template.inputCount} 张`)
    expect(() => preparation({ ...recipe, autoSize: true }, template.inputCount)).toThrow('参数无效')
  })
  it.each(['horizontal', 'vertical'] as const)('accepts one bounded dynamic %s output only when auto sizing is explicitly enabled', (layout) => {
    const recipe = { ...defaultImageTransformRecipe('collage'), layout, autoSize: true }
    const input = preparation(recipe)
    expect(parseImageTransformManifestForPreparation([output], input)).toEqual([output])
    for (const autoSize of [undefined, false]) expect(() => parseImageTransformManifestForPreparation([output], preparation({ ...recipe, autoSize }))).toThrow('尺寸')
    expect(() => parseImageTransformManifestForPreparation([output, { ...output, index: 1 }], input)).toThrow('数量')
    for (const changed of [{ width: 4097 }, { height: 0 }, { width: Infinity }, { byteSize: 20 * 1024 * 1024 + 1 }, { pngDigest: 'wrong' }]) expect(() => parseImageTransformManifestForPreparation([{ ...output, ...changed }], input)).toThrow()
  })

  it('keeps fixed grid and hero dimensions exact and prevents auto sizing on all other kinds', () => {
    const base = defaultImageTransformRecipe('collage')
    for (const layout of [undefined, 'grid', 'hero-left', 'hero-top']) {
      expect(() => parseImageTransformManifestForPreparation([output], preparation({ ...base, layout }))).toThrow('尺寸')
      expect(() => preparation({ ...base, layout, autoSize: true })).toThrow('参数无效')
    }
    for (const kind of ['crop', 'grid-split', 'tile', 'layer'] as const) expect(() => preparation({ ...defaultImageTransformRecipe(kind), autoSize: true }, 1)).toThrow('参数无效')
  })

  it('accepts ordered duplicate inputs up to strip capacity and enforces actual hero input bounds', () => {
    const base = defaultImageTransformRecipe('collage')
    expect(preparation({ ...base, layout: 'horizontal' }, 20).sourceAssetIds).toEqual(Array(20).fill('s'.repeat(43)))
    expect(() => preparation({ ...base, layout: 'horizontal' }, 21)).toThrow('20')
    for (const layout of ['hero-left', 'hero-top']) {
      expect(() => preparation({ ...base, layout }, 1)).toThrow('2–3')
      expect(() => preparation({ ...base, layout }, 4)).toThrow('2–3')
      expect(preparation({ ...base, layout }, 2).sourceAssetIds).toHaveLength(2)
      expect(preparation({ ...base, layout }, 3).sourceAssetIds).toHaveLength(3)
    }
  })
})

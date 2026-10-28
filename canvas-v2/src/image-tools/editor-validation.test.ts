import { describe, expect, it } from 'vitest'
import { validateImageToolDraft } from './editor-validation'
import { defaultImageTransformRecipe, type ImageCollageRecipe } from './recipe'

function collage(patch: Partial<ImageCollageRecipe> = {}): ImageCollageRecipe {
  return { ...defaultImageTransformRecipe('collage') as ImageCollageRecipe, ...patch }
}
function images(count: number, dimensionsReady = true) {
  return Array.from({ length: count }, () => ({ dimensions: { width: 640, height: 480 }, dimensionsReady }))
}

describe('image tool draft validation', () => {
  it('rejects a fixed strip whose spacing consumes its output before applying', () => {
    expect(() => validateImageToolDraft(collage({ layout: 'horizontal', autoSize: false, outputWidth: 40, outputHeight: 40, gap: 50, padding: 0 }), images(2))).toThrow('图片尺寸不足')
  })
  it('rejects grid overflow even while source dimensions load', () => {
    expect(() => validateImageToolDraft(collage({ rows: 1, columns: 2 }), images(3, false))).toThrow()
  })
  it('rejects an undersized hero sidebar without silently dropping its final source', () => {
    expect(() => validateImageToolDraft(collage({ layout: 'hero-left', outputWidth: 60, outputHeight: 40, gap: 50, padding: 0 }), images(3))).toThrow('图片尺寸不足')
  })
  it('allows empty templates and valid automatic strips without mutating their recipe', () => {
    const recipe = collage({ layout: 'horizontal', autoSize: true, gap: 0, padding: 0 })
    expect(validateImageToolDraft(recipe, [])).toEqual(recipe)
    expect(validateImageToolDraft(recipe, images(3))).toEqual(recipe)
  })
})

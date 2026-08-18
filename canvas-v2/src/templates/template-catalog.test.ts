import { describe, expect, it } from 'vitest'
import { builtinCanvasTemplates } from './builtin-templates'
import { canvasTemplateCompatibility, estimateCanvasTemplate, searchCanvasTemplates } from './template-catalog'

describe('industry template catalog', () => {
  it('derives paid request estimates from explicit topology', () => {
    const expected: Record<string, [number, number]> = {
      'xingmang-ec-white-bg': [4, 0],
      'xingmang-media-xhs-cover': [4, 0],
      'xingmang-home-rough-6': [12, 0],
      'xingmang-comic-lineart-color': [4, 0],
      'xingmang-drama-episode-6': [24, 6],
      'xingmang-picturebook-12': [24, 0],
      'xingmang-media-broll-3': [3, 3],
      'xingmang-ad-ab-pair': [2, 2],
    }
    for (const [id, [images, videos]] of Object.entries(expected)) {
      const estimate = estimateCanvasTemplate(builtinCanvasTemplates.find((template) => template.id === id)!)
      expect(estimate).toEqual({ imageRequests: images, videoRequests: videos, paidRequests: images + videos })
    }
  })

  it('searches names, deliverables, industries and tags', () => {
    expect(searchCanvasTemplates(builtinCanvasTemplates, '白底').map((template) => template.id)).toContain('xingmang-ec-white-bg')
    expect(searchCanvasTemplates(builtinCanvasTemplates, '建筑家装').some((template) => template.industry === 'architecture')).toBe(true)
    expect(searchCanvasTemplates(builtinCanvasTemplates, '十二张家装概念效果图').map((template) => template.id)).toContain('xingmang-home-rough-6')
  })

  it('reports model compatibility before insertion', () => {
    const edit = builtinCanvasTemplates.find((template) => template.id === 'xingmang-ec-white-bg')!
    expect(canvasTemplateCompatibility(edit, ['jimeng_high_aes_general_v21_L'], []).available).toBe(false)
    expect(canvasTemplateCompatibility(edit, ['gpt-image-2'], []).available).toBe(true)
    const video = builtinCanvasTemplates.find((template) => template.id === 'xingmang-film-animatic')!
    expect(canvasTemplateCompatibility(video, ['gpt-image-2'], []).available).toBe(false)
    expect(canvasTemplateCompatibility(video, ['gpt-image-2'], ['grok-imagine-video']).available).toBe(true)
  })
})

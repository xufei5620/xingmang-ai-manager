import { describe, expect, it } from 'vitest'
import {
  imageSizeLabel,
  imageModelPreset,
  normalizeVideoSeconds,
  validateImageModelOptions,
  validateVideoModelOptions,
  videoModelPresets,
} from './models'

describe('canvas media model capabilities', () => {
  it('does not send unsupported image options to Grok models', () => {
    const preset = imageModelPreset('grok-imagine-image-2.0')
    expect(preset).toMatchObject({ supportsSize: false, supportsQuality: false, supportsEdits: true })
    expect(validateImageModelOptions({
      model: preset.id,
      operation: 'generate',
      size: '1024x1024',
      quality: 'low',
    })).toEqual([
      '模型「Grok Imagine 2.0」不接受尺寸参数',
      '模型「Grok Imagine 2.0」不接受画质参数',
    ])
  })

  it('rejects invalid GPT Image 2 dimensions before a paid request', () => {
    expect(validateImageModelOptions({
      model: 'gpt-image-2',
      operation: 'generate',
      size: '1023x1024',
      quality: 'low',
    })).toContain('GPT Image 2 的宽高必须都是 16 的倍数')
  })

  it('validates image edit capability and reference count', () => {
    expect(validateImageModelOptions({
      model: 'jimeng_high_aes_general_v21_L',
      operation: 'edit',
      referenceImageCount: 0,
    })).toEqual([
      '模型「即梦(快·中文强)」不支持图片编辑',
      '图片编辑至少需要 1 张参考图',
    ])
  })

  it('exposes the production Grok video models and rejects ambiguous duration', () => {
    expect(videoModelPresets.map((preset) => preset.id)).toEqual([
      'grok-imagine-video',
      'grok-imagine-video-1.5',
    ])
    expect(normalizeVideoSeconds(15, 'grok-imagine-video')).toBe('15')
    expect(normalizeVideoSeconds('5', 'grok-imagine-video')).toBe('5')
    expect(normalizeVideoSeconds(18, 'grok-imagine-video')).toBeNull()
    expect(normalizeVideoSeconds('5.5', 'grok-imagine-video')).toBeNull()
    expect(validateVideoModelOptions({ model: 'grok-imagine-video', seconds: 16 })).toEqual([
      '视频时长必须在 1-15 秒之间',
    ])
    expect(validateVideoModelOptions({ model: 'grok-imagine-video', seconds: 5, size: '1280x720' })).toEqual([])
    expect(validateVideoModelOptions({ model: 'grok-imagine-video', seconds: 5, size: '111x222' }))
      .toEqual(['模型「Grok Imagine Video」不支持这个视频比例'])
  })

  it('labels common image dimensions with user-facing aspect ratios', () => {
    expect(imageSizeLabel('1024x1024')).toBe('1:1 · 1024x1024')
    expect(imageSizeLabel('1792x768')).toBe('21:9 · 1792x768')
  })
})

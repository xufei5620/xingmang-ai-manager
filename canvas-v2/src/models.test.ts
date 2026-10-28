import { describe, expect, it } from 'vitest'
import { availableImageModelPresets, knownNonTextModel, knownVideoModel, imageModelPreset, imageModelPresets, videoModelPreset, validateVideoModelOptions } from './models'
import { imageRequestModelControls, supportedImageRequestResolutions } from './runtime/image-request-parameters'

describe('image resolution capabilities', () => {
  it('filters known text and video models from mixed image catalogs while keeping custom IDs', () => {
    expect(availableImageModelPresets(['gpt-image-2', 'gpt-4o-mini', 'grok-imagine-video', 'proxy/MINIMAX-H3-FAST', 'gemini-3.1-flash-image', 'custom-paint-model'], true).map((preset) => preset.id))
      .toEqual(['gpt-image-2', 'gemini-3.1-flash-image', 'custom-paint-model'])
  })
  it('keeps Sora video families out of text and image selectors without guessing unknown aliases', () => {
    expect(knownVideoModel('proxy/SORA-2-PRO')).toBe(true)
    expect(knownNonTextModel('sora-2')).toBe(true)
    expect(availableImageModelPresets(['sora-2', 'proxy/SORA-2-PRO', 'custom-paint-model'], true).map((preset) => preset.id)).toEqual(['custom-paint-model'])
    expect(knownVideoModel('soramic-image')).toBe(false)
  })

  it('advertises only resolution tiers implemented by the shared request builder', () => {
    for (const preset of imageModelPresets) {
      expect(preset.resolutions).toEqual(supportedImageRequestResolutions(preset.id))
      expect(imageRequestModelControls(preset.id)).toMatchObject({ supportsSize: preset.supportsSize, supportsQuality: preset.supportsQuality })
    }
    expect(imageModelPreset('custom-image').resolutions).toEqual(['1K'])
    expect(imageModelPreset('proxy-gpt-image-2').resolutions).toEqual(['1K'])
  })

  it.each(['gpt-image-2-2026-04-21', 'GPT-IMAGE-2'])('retains supported dimensions and explicit quality for known alias %s', (model) => {
    const preset = imageModelPreset(model)
    expect(preset.id).toBe(model)
    expect(preset.sizes).toContain('1280x720')
    expect(preset.resolutions).toEqual(['1K', '2K', '4K'])
    expect(preset.supportsQuality).toBe(true)
    expect(preset.resolutionNote).toContain('实验性')
  })

  it('distinguishes an unimplemented Gemini adapter from the native model capabilities', () => {
    const preset = imageModelPreset('gemini-3.1-flash-image')
    expect(preset.resolutions).toEqual(['1K'])
    expect(preset.resolutionNote).toContain('支持原生 2K/4K')
    expect(preset.resolutionNote).toContain('当前接入通道尚未实现')
  })
})


describe('Seedance exact model catalog', () => {
  it('exposes only the integrated native model and does not infer compatibility from aliases', () => {
    const id = 'doubao-seedance-2-0-mini-260615'
    expect(videoModelPreset(id)).toMatchObject({ provider: 'ark-seedance', minimumSeconds: 4, maximumSeconds: 15, defaultSeconds: 5, defaultSize: 'auto', supportsVideo: true, supportsAudio: true })
    expect(videoModelPreset('seedance-2-mini')).toMatchObject({ provider: 'unknown', supportsVideo: false, sizes: [] })
    expect(validateVideoModelOptions({ model: id, seconds: '5', size: 'auto' }).join()).toContain('完整运行服务')
    expect(validateVideoModelOptions({ model: 'seedance-2-mini', seconds: '5', size: 'auto' }).join()).toContain('协议尚未确认')
  })
  it('keeps native video models out of image and text catalogs without hiding custom image IDs', () => {
    const models = ['doubao-seedance-2-0-mini-260615', 'seedance-2-mini', 'gpt-4o-mini', 'custom-paint-model']
    expect(availableImageModelPresets(models, true).map((item) => item.id)).toEqual(['custom-paint-model'])
    expect(knownNonTextModel('doubao-seedance-2-0-mini-260615')).toBe(true)
    expect(knownNonTextModel('seedance-2-mini')).toBe(true)
  })
})

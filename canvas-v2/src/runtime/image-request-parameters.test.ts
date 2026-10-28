import { describe, expect, it } from 'vitest'
import { buildImageRequestParameters, ImageRequestParameterError, imageRequestProtocolRevision, supportedImageRequestResolutions, type ImageRequestParametersInput, type ImageRequestResolution } from './image-request-parameters'

const supportedPresets = [
  ['1024x1024', '2048x2048', null],
  ['1536x1152', '2048x1536', null],
  ['1152x1536', '1536x2048', null],
  ['1280x720', '1920x1088', '3840x2160'],
  ['720x1280', '1088x1920', '2160x3840'],
  ['1536x1024', '2048x1360', null],
  ['1024x1536', '1360x2048', null],
  ['1280x1024', '2048x1648', null],
  ['1024x1280', '1648x2048', null],
  ['1792x768', '2048x880', '3840x1648'],
] as const

function input(patch: Partial<ImageRequestParametersInput> = {}): ImageRequestParametersInput {
  return { model: 'gpt-image-2', prompt: ' 保留主体 ', size: '1024x1024', quality: 'low', ...patch }
}

describe('shared image request parameters', () => {
  it.each(supportedPresets)('uses valid dimensions or rejects an oversized tier for %s', (size, twoK, fourK) => {
    expect(buildImageRequestParameters(input({ size, imageResolution: '1K' }))).toMatchObject({ size })
    expect(buildImageRequestParameters(input({ size, imageResolution: '2K' }))).toMatchObject({ size: twoK })
    if (fourK) expect(buildImageRequestParameters(input({ size, imageResolution: '4K' }))).toMatchObject({ size: fourK })
    else expect(() => buildImageRequestParameters(input({ size, imageResolution: '4K' }))).toThrow('在此比例下的 4K 尺寸超过')
  })

  it('uses explicit native square dimensions when GPT Image 2 has no size setting', () => {
    expect(buildImageRequestParameters(input({ size: undefined }))).toEqual({ model: 'gpt-image-2', prompt: '保留主体', n: 1, size: '1024x1024', quality: 'low' })
    expect(buildImageRequestParameters(input({ size: undefined, imageResolution: '2K' }))).toMatchObject({ size: '2048x2048' })
    expect(() => buildImageRequestParameters(input({ size: undefined, imageResolution: '4K' }))).toThrow('在此比例下的 4K 尺寸超过')
  })

  it.each(['gpt-image-2', 'gpt-image-2-2026-04-21', 'GPT-IMAGE-2'])('supports the explicitly known GPT Image 2 model %s', (model) => {
    expect(supportedImageRequestResolutions(model)).toEqual(['1K', '2K', '4K'])
    expect(buildImageRequestParameters(input({ model, size: '1280x720', imageResolution: '4K' }))).toMatchObject({ model, size: '3840x2160' })
  })

  it.each([
    ['1600x1200', '2K', '2048x1536'],
    ['1200x1600', '2K', '1536x2048'],
    ['1584x1056', '2K', '2048x1360'],
    ['1536x768', '4K', '3840x1920'],
    ['768x1536', '4K', '1920x3840'],
  ] as const)('scales custom %s at %s within native pixel bounds', (size, imageResolution, expected) => {
    const body = buildImageRequestParameters(input({ size, imageResolution }))
    expect(body.size).toBe(expected)
    const [width, height] = String(body.size).split('x').map(Number)
    expect(width % 16).toBe(0)
    expect(height % 16).toBe(0)
    expect(Math.max(width, height)).toBeLessThanOrEqual(3840)
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3)
    expect(width * height).toBeGreaterThanOrEqual(655_360)
    expect(width * height).toBeLessThanOrEqual(8_294_400)
  })

  it.each(['auto', '1025x1024', '128x1024', '4096x4096', '3840x3840', '4096x1024', '3072x512', '512x512', '8192x8192', '99999x99999', '1024X1024'])('rejects invalid native GPT Image 2 dimensions %s before submission', (size) => {
    for (const imageResolution of ['1K', '2K', '4K'] as const) expect(() => buildImageRequestParameters(input({ size, imageResolution }))).toThrow(ImageRequestParameterError)
  })

  it.each(['custom-image', 'gpt-image-1', 'gpt-image-1.5', 'gemini-3.1-flash-image', 'gpt-image-2-unknown', 'proxy-gpt-image-2'])('rejects unimplemented higher resolution for %s instead of silently ignoring it', (model) => {
    expect(supportedImageRequestResolutions(model)).toEqual(['1K'])
    for (const imageResolution of ['2K', '4K'] as const) expect(() => buildImageRequestParameters(input({ model, imageResolution }))).toThrow('尚未接入 2K/4K')
  })

  it.each(['1024x640', '640x1024', '3840x2160', '2160x3840', '1536x512'])('accepts documented pixel, edge and ratio boundaries at %s', (size) => {
    expect(buildImageRequestParameters(input({ size }))).toMatchObject({ size })
  })

  it.each(['gpt-image-1', 'custom-image'])('keeps 1K and missing resolution backward compatible for %s', (model) => {
    const base = { model, prompt: '保留主体', n: 1 }
    expect(buildImageRequestParameters({ model, prompt: '保留主体' })).toEqual(base)
    expect(buildImageRequestParameters({ model, prompt: '保留主体', imageResolution: '1K' })).toEqual(base)
    expect(buildImageRequestParameters({ model, prompt: '保留主体', imageResolution: '1K', size: 'auto', quality: 'low' })).toEqual({ ...base, size: 'auto', quality: 'low' })
    expect(buildImageRequestParameters({ model, prompt: '保留主体', size: '1536x1024', quality: 'low' })).toEqual({ ...base, size: '1536x1024', quality: 'low' })
  })

  it.each(['1280x720', '2048x2048', '3840x2160'])('rejects unsupported fixed GPT Image 1 size %s before submission', (size) => {
    expect(() => buildImageRequestParameters(input({ model: 'gpt-image-1', size }))).toThrow('GPT Image 1 仅支持')
  })

  it.each(['jimeng_high_aes_general_v21_L', 'grok-imagine-image', 'grok-imagine-image-2.0', 'grok-imagine-image-quality'])('omits stale size and quality controls for provider-sized model %s without changing the draft', (model) => {
    const draft = input({ model, size: '1280x720', quality: 'high', imageResolution: '1K' })
    const before = structuredClone(draft)
    expect(buildImageRequestParameters(draft)).toEqual({ model, prompt: '保留主体', n: 1 })
    expect(draft).toEqual(before)
    expect(() => buildImageRequestParameters({ ...draft, imageResolution: '4K' })).toThrow('尚未接入 2K/4K')
  })

  it('omits unsupported Gemini quality while retaining its compatible size', () => {
    expect(buildImageRequestParameters(input({ model: 'gemini-3.1-flash-image', size: '1280x720' }))).toEqual({ model: 'gemini-3.1-flash-image', prompt: '保留主体', n: 1, size: '1280x720' })
  })

  it.each(['gpt-image-1', 'gpt-image-2', 'gpt-image-2-2026-04-21'])('rejects retired quality fields for known GPT model %s', (model) => {
    for (const quality of ['standard', 'hd']) expect(() => buildImageRequestParameters(input({ model, quality }))).toThrow('图像质量参数不受支持')
  })

  it('retains unknown-model legacy size and quality compatibility without inventing higher resolution tiers', () => {
    expect(buildImageRequestParameters(input({ model: 'custom-image', size: '2048x2048', quality: 'standard' }))).toMatchObject({ size: '2048x2048', quality: 'standard' })
    expect(() => buildImageRequestParameters(input({ model: 'custom-image', imageResolution: '4K' }))).toThrow('尚未接入 2K/4K')
  })

  it('rejects hostile runtime field shapes with controlled Chinese errors', () => {
    for (const value of ['8K', null, 2048, {}, ['2K']]) {
      expect(() => buildImageRequestParameters({ ...input(), imageResolution: value as ImageRequestResolution })).toThrow(ImageRequestParameterError)
    }
    for (const value of [null, 1024, {}, ['1024x1024']]) {
      expect(() => buildImageRequestParameters({ ...input(), size: value as string })).toThrow('尺寸')
    }
    expect(() => buildImageRequestParameters(input({ model: '' }))).toThrow('模型名称')
    expect(() => buildImageRequestParameters(input({ prompt: ' ' }))).toThrow('图像提示词')
    expect(() => buildImageRequestParameters(input({ prompt: 'x'.repeat(32_001) }))).toThrow('图像提示词')
    expect(() => buildImageRequestParameters(input({ quality: 'ultra' }))).toThrow('质量')
  })

  it('keeps protocol revision in cache metadata and never sends UI clarity fields to the provider', () => {
    const original = input({ size: '1792x768', imageResolution: '4K' })
    const before = structuredClone(original)
    const body = buildImageRequestParameters(original)
    expect(imageRequestProtocolRevision).toBe(3)
    expect(body).toEqual({ model: 'gpt-image-2', prompt: '保留主体', n: 1, size: '3840x1648', quality: 'low' })
    expect(body).not.toHaveProperty('imageResolution')
    expect(body).not.toHaveProperty('protocolRevision')
    expect(original).toEqual(before)
    const cacheMetadata = { protocolRevision: imageRequestProtocolRevision, parameters: body }
    expect(cacheMetadata).not.toEqual({ protocolRevision: 2, parameters: { ...body, size: '4096x1760' } })
  })
})

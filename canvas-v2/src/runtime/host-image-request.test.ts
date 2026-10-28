import { describe, expect, it } from 'vitest'
import { v2EquivalentCapabilities } from '../host-capabilities'
import { assertHostImageRequest } from './host-image-request'
import { buildImageRequestParameters } from './image-request-parameters'

describe('image requests checked for the host', () => {
  it('is the kernel request builder when no host profile is given', () => {
    expect(assertHostImageRequest({ model: 'gpt-image-2', prompt: '猫', size: '1280x720', imageResolution: '4K' })).toEqual({ size: buildImageRequestParameters({ model: 'gpt-image-2', prompt: '猫', size: '1280x720', imageResolution: '4K' }).size })
    expect(assertHostImageRequest({ model: 'grok-imagine-image', prompt: '猫', size: '1280x720' })).toEqual({})
    expect(() => assertHostImageRequest({ model: 'gemini-3.1-flash-image', prompt: '猫', imageResolution: '2K' })).toThrow('当前模型的接入通道尚未接入 2K/4K 分辨率转换')
  })

  it('leaves 2K and 4K pixels to a host that works them out itself, after checking what 1K sends', () => {
    expect(assertHostImageRequest({ model: 'gemini-3.1-flash-image', prompt: '猫', size: '1280x720', imageResolution: '4K' }, v2EquivalentCapabilities)).toEqual({ hostSized: true })
    expect(assertHostImageRequest({ model: 'gemini-3.1-flash-image', prompt: '猫', size: '1280x720' }, v2EquivalentCapabilities)).toEqual({ size: '1280x720' })
    expect(() => assertHostImageRequest({ model: 'gpt-image-1', prompt: '猫', size: '1280x720', imageResolution: '1K' }, v2EquivalentCapabilities)).toThrow('GPT Image 1 仅支持')
    expect(() => assertHostImageRequest({ model: 'gpt-image-1', prompt: '猫', size: '1024x1024', imageResolution: '2K' }, v2EquivalentCapabilities)).toThrow('模型「GPT Image 1」不支持 2K 清晰度')
    expect(() => assertHostImageRequest({ model: 'gpt-image-2', prompt: ' ', imageResolution: '2K' }, v2EquivalentCapabilities)).toThrow('图像提示词不能为空')
  })
})

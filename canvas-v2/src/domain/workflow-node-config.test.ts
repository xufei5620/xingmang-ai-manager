import { describe, expect, it } from 'vitest'
import { operationDefaultsForTemplateNode } from './workflow-node-config'
import { buildImageRequestParameters } from '../runtime/image-request-parameters'

describe('template image resolution defaults', () => {
  it('reports an unsupported explicit 4K request as unavailable without rewriting it', () => {
    const preferred = { model: 'gemini-3.1-flash-image', size: '1280x720', imageResolution: '4K' }
    const result = operationDefaultsForTemplateNode('image-generate', [preferred.model], [], preferred)
    expect(result.available).toBe(false)
    expect(result.config).toMatchObject(preferred)
    expect(result.reason).toContain('尚未接入 2K/4K')
    expect(() => buildImageRequestParameters({ model: preferred.model, prompt: 'test', size: preferred.size, imageResolution: '4K' })).toThrow('尚未接入 2K/4K')
  })

  it('defaults only a missing resolution to 1K', () => {
    const result = operationDefaultsForTemplateNode('image-generate', ['gpt-image-1'], [], {})
    expect(result.available).toBe(true)
    expect(result.config.imageResolution).toBe('1K')
  })

  it.each(['8K', null])('keeps an invalid explicit resolution %s unavailable instead of downgrading it', (imageResolution) => {
    const result = operationDefaultsForTemplateNode('image-generate', ['gpt-image-1'], [], { model: 'gpt-image-1', imageResolution })
    expect(result.available).toBe(false)
    expect(result.config.imageResolution).toBe(imageResolution)
    expect(result.reason).toContain('清晰度不受支持')
  })
})

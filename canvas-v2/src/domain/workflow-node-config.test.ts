import { describe, expect, it } from 'vitest'
import { operationDefaultsForTemplateNode } from './workflow-node-config'

describe('operationDefaultsForTemplateNode', () => {
  it('skips generation-only models for edit templates', () => {
    const result = operationDefaultsForTemplateNode('image-edit', ['jimeng_high_aes_general_v21_L', 'gpt-image-2'], [], {})
    expect(result).toMatchObject({ available: true, config: { model: 'gpt-image-2' } })
  })

  it('drops unsupported image options and normalizes video seconds', () => {
    const grok = operationDefaultsForTemplateNode('image-generate', ['grok-imagine-image'], [], {})
    expect(grok.config).not.toHaveProperty('quality')
    expect(grok.config).not.toHaveProperty('size')
    const video = operationDefaultsForTemplateNode('video-generate', [], ['grok-imagine-video'], { seconds: '8' })
    expect(video.config).toMatchObject({ model: 'grok-imagine-video', seconds: '8' })
  })

  it('returns a structured unavailable result when no compatible edit model exists', () => {
    expect(operationDefaultsForTemplateNode('image-edit', ['jimeng_high_aes_general_v21_L'], [], {}).available).toBe(false)
  })
})

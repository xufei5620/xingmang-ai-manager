import { describe, expect, it } from 'vitest'
import {
  AI_CHAT_LIMITS,
  AiChatProtocolError,
  buildChatCompletionsRequest,
  buildImageGenerationRequest,
  buildVideoGenerationRequest,
  getKnownImageModelPresets,
  isImageModel,
  resolveAiModelCapability,
  selectAiChatModelsForGroup,
  validateAiChatGroup,
} from './ai-chat-protocol'

describe('AI model capabilities', () => {
  it('uses explicit presets for verified image models', () => {
    for (const model of [
      'gpt-image-1',
      'gpt-image-2',
      'gpt-image-2-2026-04-21',
      'jimeng_high_aes_general_v21_L',
      'grok-imagine-image',
      'grok-imagine-image-2.0',
      'grok-imagine-image-quality',
    ]) {
      expect(resolveAiModelCapability(model)).toMatchObject({
        kind: 'image',
        model,
        available: true,
        source: 'preset',
      })
    }
  })

  it('recognizes the two verified Grok video models without treating them as chat', () => {
    for (const model of ['grok-imagine-video', 'grok-imagine-video-1.5']) {
      expect(resolveAiModelCapability(model)).toMatchObject({
        kind: 'video', model, available: true, source: 'preset', maximumSeconds: 15,
      })
      expect(() => buildChatCompletionsRequest({
        model, messages: [{ role: 'user', content: '海浪' }],
      })).toThrowError(expect.objectContaining({ code: 'invalid-model' }))
    }
  })

  it('marks gpt-image-1.5 and its snapshots unavailable and hidden', () => {
    expect(resolveAiModelCapability('gpt-image-1.5')).toMatchObject({
      kind: 'image',
      available: false,
      hidden: true,
      source: 'preset',
    })
    expect(resolveAiModelCapability('gpt-image-1.5-2026-01-01')).toMatchObject({
      kind: 'image',
      available: false,
      hidden: true,
      source: 'fallback',
    })
    expect(getKnownImageModelPresets().map(({ model }) => model)).not.toContain('gpt-image-1.5')
    expect(getKnownImageModelPresets({ includeHidden: true }).map(({ model }) => model)).toContain('gpt-image-1.5')
  })

  it('keeps only production-verified models in the image group and puts GPT Image 2 first', () => {
    expect(selectAiChatModelsForGroup('生图分组', [
      'gpt-image-1',
      'gpt-image-1.5',
      'gpt-image-2-2026-04-21',
      'jimeng_high_aes_general_v21_L',
      'gpt-image-2',
      'gpt-4o',
    ])).toEqual([
      'gpt-image-2',
      'gpt-image-1',
      'jimeng_high_aes_general_v21_L',
    ])
  })

  it('retains verified video models for the image group only when the server returns them', () => {
    expect(selectAiChatModelsForGroup('生图分组', [
      'grok-imagine-video',
      'gpt-image-2',
      'grok-imagine-video-1.5',
    ])).toEqual([
      'gpt-image-2',
      'grok-imagine-video-1.5',
      'grok-imagine-video',
    ])
  })

  it('hides unavailable image entries without changing ordinary model order', () => {
    expect(selectAiChatModelsForGroup('openai', [
      'gpt-4o',
      'gpt-image-1.5',
      'gpt-image-2-2026-04-21',
      'gpt-image-1',
    ])).toEqual(['gpt-4o', 'gpt-image-1'])
  })

  it('uses restricted prefixes as image fallbacks without matching embedded names', () => {
    expect(resolveAiModelCapability('gpt-image-3-preview')).toMatchObject({
      kind: 'image',
      provider: 'gpt-image',
      source: 'fallback',
    })
    expect(resolveAiModelCapability('jimeng_future_v1')).toMatchObject({
      kind: 'image',
      provider: 'jimeng',
      source: 'fallback',
    })
    expect(resolveAiModelCapability('proxy-gpt-image-2')).toMatchObject({ kind: 'chat' })
    expect(resolveAiModelCapability('jimeng/bad')).toMatchObject({ kind: 'chat' })
    expect(isImageModel('gpt-4o')).toBe(false)
  })
})

describe('chat completion protocol', () => {
  it('builds an OpenAI-compatible bounded chat body', () => {
    expect(buildChatCompletionsRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
      parameters: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 4096,
        frequencyPenalty: -0.5,
        presencePenalty: 0.5,
        seed: 7,
      },
    })).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 4096,
      frequency_penalty: -0.5,
      presence_penalty: 0.5,
      seed: 7,
    })
  })

  it('never constructs a messages body for an image model', () => {
    expect(() => buildChatCompletionsRequest({
      model: 'gpt-image-2',
      messages: [{ role: 'user', content: '画一只猫' }],
    })).toThrowError(AiChatProtocolError)
  })

  it('rejects message and numeric parameter limits', () => {
    expect(() => buildChatCompletionsRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x'.repeat(AI_CHAT_LIMITS.messageLength + 1) }],
    })).toThrowError(expect.objectContaining({ code: 'input-limit-exceeded' }))
    expect(() => buildChatCompletionsRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'ok' }],
      parameters: { temperature: Number.NaN },
    })).toThrowError(expect.objectContaining({ code: 'invalid-parameter' }))
    expect(() => buildChatCompletionsRequest({
      model: 'gpt-4o',
      messages: Array.from({ length: AI_CHAT_LIMITS.messageCount + 1 }, () => ({
        role: 'user' as const,
        content: 'x',
      })),
    })).toThrowError(expect.objectContaining({ code: 'input-limit-exceeded' }))
  })
})

describe('image generation protocol', () => {
  it('uses low quality and base64 by default for GPT Image', () => {
    const body = buildImageGenerationRequest({
      model: 'gpt-image-2',
      prompt: '画一张中文海报',
      size: '1536x1152',
    })

    expect(body).toEqual({
      model: 'gpt-image-2',
      prompt: '画一张中文海报',
      n: 1,
      size: '1536x1152',
      quality: 'low',
    })
    expect(body).not.toHaveProperty('response_format')
    expect(body).not.toHaveProperty('messages')
  })

  it('supports all valid GPT quality levels and rejects unsupported values', () => {
    expect(buildImageGenerationRequest({
      model: 'gpt-image-2',
      prompt: 'cat',
      quality: 'high',
    }).quality).toBe('high')
    expect(() => buildImageGenerationRequest({
      model: 'gpt-image-2',
      prompt: 'cat',
      quality: 'ultra' as never,
    })).toThrowError(expect.objectContaining({ code: 'invalid-image-quality' }))
  })

  it('enforces model-specific GPT image sizes', () => {
    expect(() => buildImageGenerationRequest({
      model: 'gpt-image-1',
      prompt: 'cat',
      size: '1536x1152',
    })).toThrowError(expect.objectContaining({ code: 'invalid-image-size' }))
    expect(buildImageGenerationRequest({
      model: 'gpt-image-1',
      prompt: 'cat',
      size: 'auto',
    }).size).toBe('auto')
    expect(() => buildImageGenerationRequest({
      model: 'gpt-image-2',
      prompt: 'cat',
      size: '1025x1024',
    })).toThrowError(expect.objectContaining({ code: 'invalid-image-size' }))
    expect(() => buildImageGenerationRequest({
      model: 'gpt-image-2',
      prompt: 'cat',
      size: '8192x8192',
    })).toThrowError(expect.objectContaining({ code: 'invalid-image-size' }))
  })

  it('maps Jimeng dimensions to extra_fields and never sends quality', () => {
    const body = buildImageGenerationRequest({
      model: 'jimeng_high_aes_general_v21_L',
      prompt: '水墨山水',
      size: '768x512',
      quality: 'high',
    })

    expect(body).toEqual({
      model: 'jimeng_high_aes_general_v21_L',
      prompt: '水墨山水',
      n: 1,
      extra_fields: { width: 768, height: 512 },
    })
    expect(body).not.toHaveProperty('response_format')
    expect(body).not.toHaveProperty('quality')
    expect(body).not.toHaveProperty('size')
    expect(body).not.toHaveProperty('messages')
    expect(buildImageGenerationRequest({
      model: 'jimeng_high_aes_general_v21_L',
      prompt: '方形插画',
    }).extra_fields).toEqual({ width: 1024, height: 1024 })
  })

  it('rejects unavailable, chat, oversized prompt, and invalid Jimeng requests', () => {
    expect(() => buildImageGenerationRequest({ model: 'gpt-image-1.5', prompt: 'cat' }))
      .toThrowError(expect.objectContaining({ code: 'model-unavailable' }))
    expect(() => buildImageGenerationRequest({ model: 'gpt-4o', prompt: 'cat' }))
      .toThrowError(expect.objectContaining({ code: 'model-not-image' }))
    expect(() => buildImageGenerationRequest({
      model: 'gpt-image-2',
      prompt: 'x'.repeat(AI_CHAT_LIMITS.promptLength + 1),
    })).toThrowError(expect.objectContaining({ code: 'input-limit-exceeded' }))
    expect(() => buildImageGenerationRequest({
      model: 'jimeng_high_aes_general_v21_L',
      prompt: 'cat',
      size: '1280x720',
    })).toThrowError(expect.objectContaining({ code: 'invalid-image-size' }))
  })

  it('omits unsupported size and quality fields and requests inline output for Grok image models', () => {
    expect(buildImageGenerationRequest({
      model: 'grok-imagine-image-2.0', prompt: '电影感海岸', size: '1024x1024', quality: 'high',
    })).toEqual({
      model: 'grok-imagine-image-2.0', prompt: '电影感海岸', n: 1, response_format: 'b64_json',
    })
    expect(resolveAiModelCapability('grok-imagine-image-quality')).toMatchObject({
      kind: 'image', provider: 'grok-image', supportsEdits: true,
    })
  })
})

describe('video generation protocol', () => {
  it('builds an exact bounded OpenAI video request', () => {
    expect(buildVideoGenerationRequest({
      model: 'grok-imagine-video-1.5', prompt: '海浪拍打礁石', seconds: '15',
      image: 'data:image/png;base64,aGVsbG8=', width: 1280, height: 720,
    })).toEqual({
      model: 'grok-imagine-video-1.5', prompt: '海浪拍打礁石', seconds: '15',
      image: 'data:image/png;base64,aGVsbG8=', width: 1280, height: 720,
    })
  })

  it('rejects invalid models, durations and oversized image inputs before dispatch', () => {
    expect(() => buildVideoGenerationRequest({ model: 'gpt-4o', prompt: 'p', seconds: '5' }))
      .toThrowError(expect.objectContaining({ code: 'model-not-video' }))
    for (const seconds of ['0', '16', '5.5', '05', 'bad']) {
      expect(() => buildVideoGenerationRequest({ model: 'grok-imagine-video', prompt: 'p', seconds }))
        .toThrowError(expect.objectContaining({ code: 'invalid-video-seconds' }))
    }
    expect(() => buildVideoGenerationRequest({
      model: 'grok-imagine-video', prompt: 'p', seconds: '5', image: `data:image/png;base64,${'a'.repeat(13 * 1024 * 1024)}`,
    })).toThrowError(expect.objectContaining({ code: 'input-limit-exceeded' }))
    expect(() => buildVideoGenerationRequest({
      model: 'grok-imagine-video', prompt: 'p', seconds: '5', width: 1920, height: 1080,
    })).toThrowError(expect.objectContaining({ code: 'invalid-parameter' }))
  })
})

describe('shared input validation', () => {
  it('bounds model and group identifiers', () => {
    expect(() => resolveAiModelCapability('x'.repeat(AI_CHAT_LIMITS.modelLength + 1)))
      .toThrowError(expect.objectContaining({ code: 'invalid-model' }))
    expect(validateAiChatGroup({ id: '生图分组', label: '生图分组', ratio: 1 })).toEqual({
      id: '生图分组',
      label: '生图分组',
      ratio: 1,
    })
    expect(() => validateAiChatGroup({ id: 'bad\nname', label: 'bad' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-group' }))
  })
})

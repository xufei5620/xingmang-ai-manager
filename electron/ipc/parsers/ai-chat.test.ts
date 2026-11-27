import { describe, expect, it } from 'vitest'
import { parseAiChatStartInput, parseAiChatUpscaleInput } from './ai-chat'

const assetId = 'A'.repeat(43)
const base = { requestId: 'request-1', group: 'default', model: 'gpt-6-astra' }

describe('parseAiChatStartInput', () => {
  it('accepts a user message that carries only images', () => {
    expect(parseAiChatStartInput({ ...base, messages: [{ role: 'user', content: '', images: [assetId] }] }))
      .toEqual({ ...base, messages: [{ role: 'user', content: '', images: [assetId] }] })
  })

  it('rejects image ids that are not bare asset ids, so no path reaches the asset store', () => {
    for (const image of ['../'.repeat(14) + 'a', `${'A'.repeat(42)}/`, 'A'.repeat(44), 42]) {
      expect(() => parseAiChatStartInput({ ...base, messages: [{ role: 'user', content: 'hi', images: [image] }] }))
        .toThrow('AI聊天图片格式错误')
    }
  })

  it('rejects images on a non-user message, duplicates and more than four', () => {
    const cases = [
      { role: 'assistant', content: 'hi', images: [assetId] },
      { role: 'user', content: 'hi', images: [assetId, assetId] },
      { role: 'user', content: 'hi', images: ['A', 'B', 'C', 'D', 'E'].map((letter) => letter.repeat(43)) },
    ]
    for (const message of cases) {
      expect(() => parseAiChatStartInput({ ...base, messages: [message] })).toThrow('AI聊天图片格式错误')
    }
  })

  it('keeps only finite numeric parameters', () => {
    expect(parseAiChatStartInput({ ...base, messages: [{ role: 'user', content: 'hi' }], parameters: { temperature: 0.2, unknown: 1 } }))
      .toMatchObject({ parameters: { temperature: 0.2 } })
    expect(() => parseAiChatStartInput({ ...base, messages: [{ role: 'user', content: 'hi' }], parameters: { topP: Number.POSITIVE_INFINITY } }))
      .toThrow('AI聊天参数格式错误')
  })

  it('rejects an unknown role and an empty conversation', () => {
    expect(() => parseAiChatStartInput({ ...base, messages: [{ role: 'tool', content: 'hi' }] })).toThrow('AI聊天消息格式错误')
    expect(() => parseAiChatStartInput({ ...base, messages: [] })).toThrow('AI聊天消息格式错误')
  })
})

describe('parseAiChatUpscaleInput', () => {
  it('accepts a bare asset id, 2x or 4x and an optional description', () => {
    expect(parseAiChatUpscaleInput({ assetId, scale: 2 })).toEqual({ assetId, scale: 2 })
    expect(parseAiChatUpscaleInput({ assetId, scale: 4, prompt: '一只猫' })).toEqual({ assetId, scale: 4, prompt: '一只猫' })
    expect(parseAiChatUpscaleInput({ assetId, scale: 4, prompt: '' })).toEqual({ assetId, scale: 4 })
  })

  it('rejects anything that could name a file or another size, and fields it does not know', () => {
    for (const id of ['../'.repeat(14) + 'a', `${'A'.repeat(42)}/`, 'A'.repeat(44), 42, undefined]) {
      expect(() => parseAiChatUpscaleInput({ assetId: id, scale: 2 })).toThrow('变清晰图片格式错误')
    }
    for (const scale of [1, 3, 8, '2', 2.5, undefined]) {
      expect(() => parseAiChatUpscaleInput({ assetId, scale })).toThrow('放大倍数格式错误')
    }
    expect(() => parseAiChatUpscaleInput({ assetId, scale: 2, path: 'C:\\a.png' })).toThrow('变清晰请求格式错误')
    expect(() => parseAiChatUpscaleInput(null)).toThrow('变清晰请求格式错误')
    expect(() => parseAiChatUpscaleInput({ assetId, scale: 2, prompt: 42 })).toThrow()
    expect(() => parseAiChatUpscaleInput({ assetId, scale: 2, prompt: 'x'.repeat(100_000) })).toThrow()
  })
})

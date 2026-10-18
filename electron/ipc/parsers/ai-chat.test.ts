import { describe, expect, it } from 'vitest'
import { parseAiChatStartInput } from './ai-chat'

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

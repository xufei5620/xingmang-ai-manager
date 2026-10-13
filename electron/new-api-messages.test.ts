import { describe, expect, it } from 'vitest'
import { chineseServerMessages, resolveChineseServerMessage } from './new-api-messages'

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort()
}

describe('resolveChineseServerMessage', () => {
  it('turns an rc.43+ message key into upstream\'s own Chinese sentence', () => {
    expect(resolveChineseServerMessage({
      success: false,
      message: 'Invalid top-up amount',
      message_key: 'Invalid top-up amount',
    })).toBe('充值数量无效')
  })

  it('fills the placeholders from message_params', () => {
    expect(resolveChineseServerMessage({
      message: 'Top-up amount cannot exceed 10000',
      message_key: 'Top-up amount cannot exceed {{max}}',
      message_params: { max: 10000 },
    })).toBe('充值数量不能大于 10000')
    expect(resolveChineseServerMessage({
      message_key: 'Auto group {{group}} is unavailable or unauthorized',
      message_params: { group: 'GPT-中转/订阅' },
    })).toBe('Auto 分组 GPT-中转/订阅 不可用或无权访问')
  })

  it('does not expand a placeholder that arrives inside a param', () => {
    expect(resolveChineseServerMessage({
      message_key: 'Transfer failed {{error}}',
      message_params: { error: '{{error}}' },
    })).toBe('划转失败 {{error}}')
  })

  it('keeps the server\'s English when the envelope is from an older server or names a key it does not know', () => {
    expect(resolveChineseServerMessage({ success: false, message: '用户名已存在，或已注销' })).toBeNull()
    expect(resolveChineseServerMessage({ message: 'Something new', message_key: 'Something new' })).toBeNull()
    expect(resolveChineseServerMessage({ message_key: 42 })).toBeNull()
    expect(resolveChineseServerMessage({ message_key: '' })).toBeNull()
  })

  it('keeps the server\'s English rather than show a sentence with a hole in it', () => {
    const key = 'Top-up amount cannot exceed {{max}}'
    expect(resolveChineseServerMessage({ message_key: key })).toBeNull()
    expect(resolveChineseServerMessage({ message_key: key, message_params: { other: 1 } })).toBeNull()
    expect(resolveChineseServerMessage({ message_key: key, message_params: { max: { nested: 1 } } })).toBeNull()
    expect(resolveChineseServerMessage({ message_key: key, message_params: { max: Number.NaN } })).toBeNull()
    expect(resolveChineseServerMessage({ message_key: key, message_params: { max: 'x'.repeat(201) } })).toBeNull()
    expect(resolveChineseServerMessage({ message_key: key, message_params: [10000] })).toBeNull()
  })

  it('ignores a key inherited from Object.prototype', () => {
    expect(resolveChineseServerMessage({ message_key: 'constructor' })).toBeNull()
    expect(resolveChineseServerMessage({
      message_key: 'Top-up amount cannot exceed {{max}}',
      message_params: Object.create({ max: 1 }),
    })).toBeNull()
  })
})

describe('chineseServerMessages', () => {
  it('only uses placeholders the English key provides', () => {
    for (const [english, chinese] of chineseServerMessages) {
      expect(placeholders(chinese), english).toEqual(placeholders(english))
    }
  })

  it('maps every key to a Chinese sentence', () => {
    for (const [english, chinese] of chineseServerMessages) {
      expect(chinese, english).toMatch(/[一-鿿]/)
      expect(chinese).not.toBe(english)
    }
  })
})

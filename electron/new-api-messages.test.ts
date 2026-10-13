import { describe, expect, it } from 'vitest'
import { chineseServerMessages, keylessChineseServerMessages, resolveChineseServerMessage } from './new-api-messages'

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

  it('leaves alone the sentences rc.40 already answered in English, so they read as they do today', () => {
    expect(resolveChineseServerMessage({
      message: 'Current password is incorrect.',
      message_key: 'Current password is incorrect.',
    })).toBeNull()
    expect(resolveChineseServerMessage({
      message: 'This email address is already in use.',
      message_key: 'This email address is already in use.',
    })).toBeNull()
  })

  it('says the send-code rate limit the way rc.40 did, so the login box still reads it as a rate limit', () => {
    expect(resolveChineseServerMessage({
      message: 'Please wait before requesting another verification code.',
      message_key: 'Please wait before requesting another verification code.',
    })).toBe('发送过于频繁，请稍后再试')
  })

  it('translates the keyless security-proof sentences only when no key is present', () => {
    expect(resolveChineseServerMessage({
      success: false,
      code: 'SECURITY_PROOF_REQUIRED',
      message: 'Additional verification required',
    })).toBe('需要进一步验证')
    expect(resolveChineseServerMessage({ message: '需要安全验证', code: 'SECURITY_PROOF_REQUIRED' })).toBeNull()
    expect(resolveChineseServerMessage({ message: 'constructor' })).toBeNull()
    expect(resolveChineseServerMessage({
      message: 'Additional verification required',
      message_key: 'Something else',
    })).toBeNull()
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
    for (const [english, chinese] of [...chineseServerMessages, ...keylessChineseServerMessages]) {
      expect(chinese, english).toMatch(/[一-鿿]/)
      expect(chinese).not.toBe(english)
    }
  })
})

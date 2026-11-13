import { describe, expect, it } from 'vitest'
import { normalizeEmailVerificationCode } from './email-verification-code'

describe('normalizeEmailVerificationCode', () => {
  it('leaves a code copied straight from the email untouched', () => {
    expect(normalizeEmailVerificationCode('3fa9c1')).toBe('3fa9c1')
    expect(normalizeEmailVerificationCode('123456')).toBe('123456')
  })

  it('lowercases a code typed with caps lock on, since the service compares it byte for byte', () => {
    expect(normalizeEmailVerificationCode('3FA9C1')).toBe('3fa9c1')
    expect(normalizeEmailVerificationCode('3Fa9c1')).toBe('3fa9c1')
  })

  it('turns full-width letters and digits typed in full-width mode into half-width ones', () => {
    expect(normalizeEmailVerificationCode('３ｆａ９ｃ１')).toBe('3fa9c1')
    expect(normalizeEmailVerificationCode('３ＦＡ９Ｃ１')).toBe('3fa9c1')
  })

  it('drops spaces, full-width spaces and zero-width characters anywhere', () => {
    expect(normalizeEmailVerificationCode(' 3fa 9c1 ')).toBe('3fa9c1')
    expect(normalizeEmailVerificationCode('　3fa　9c1　')).toBe('3fa9c1')
    for (const invisible of ['​', '‌', '‍', '⁠', '﻿', ' ']) {
      expect(normalizeEmailVerificationCode(`${invisible}3fa${invisible}9c1${invisible}`)).toBe('3fa9c1')
    }
  })

  it('keeps the case of anything that is not a six-character hex code, for the service to judge', () => {
    // 账号服务哪天换了验证码的样子：别的写法只去空白、换半角，不改大小写。
    expect(normalizeEmailVerificationCode('ABCDEFG')).toBe('ABCDEFG')
    expect(normalizeEmailVerificationCode('3FA9CZ')).toBe('3FA9CZ')
    expect(normalizeEmailVerificationCode('ＸＹ １２')).toBe('XY12')
  })

  it('returns an empty string when nothing but invisible characters was typed', () => {
    expect(normalizeEmailVerificationCode('​ 　﻿')).toBe('')
    expect(normalizeEmailVerificationCode('')).toBe('')
  })
})

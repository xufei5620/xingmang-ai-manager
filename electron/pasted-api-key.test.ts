import { describe, expect, it } from 'vitest'
import { normalizePastedApiKey } from './pasted-api-key'

const key = 'sk-AbCdEf0123456789xyzW'

describe('normalizePastedApiKey', () => {
  it('leaves a clean key untouched', () => {
    expect(normalizePastedApiKey(key)).toBe(key)
  })

  it('drops the space Chromium leaves where a wrapped key had its line break', () => {
    // 从 PDF、Word、邮件复制、折成两行的密钥，粘进单行框后中间的换行变成了空格（Chromium 153 实测）。
    expect(normalizePastedApiKey('sk-AbCdEf0123 456789xyzW')).toBe(key)
  })

  it('drops zero-width characters at the start, in the middle and at the end', () => {
    for (const invisible of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF']) {
      expect(normalizePastedApiKey(`${invisible}${key}`)).toBe(key)
      expect(normalizePastedApiKey(`sk-AbCdEf${invisible}0123456789xyzW`)).toBe(key)
      expect(normalizePastedApiKey(`${key}${invisible}`)).toBe(key)
    }
  })

  it('drops no-break, full-width and other non-control spaces anywhere', () => {
    for (const space of [' ', '\u00A0', '\u1680', '\u2002', '\u2009', '\u200A', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000']) {
      expect(normalizePastedApiKey(`${space}sk-AbCdEf${space}0123456789xyzW${space}`)).toBe(key)
    }
  })

  it('still trims surrounding line breaks and tabs, as trim() did', () => {
    expect(normalizePastedApiKey(`\t${key}\r\n`)).toBe(key)
    expect(normalizePastedApiKey(`\u200B\n${key}\n\u200B`)).toBe(key)
  })

  it('keeps an embedded control character so the main process still rejects the whole key', () => {
    expect(normalizePastedApiKey('sk-AbCdEf\n0123456789xyzW')).toBe('sk-AbCdEf\n0123456789xyzW')
    expect(normalizePastedApiKey('sk-AbCdEf\t0123456789xyzW')).toBe('sk-AbCdEf\t0123456789xyzW')
    expect(normalizePastedApiKey('sk-AbCdEf\u00000123456789xyzW')).toBe('sk-AbCdEf\u00000123456789xyzW')
  })

  it('returns an empty string when nothing but invisible characters was pasted', () => {
    expect(normalizePastedApiKey('\u200B \u3000\uFEFF')).toBe('')
    expect(normalizePastedApiKey('')).toBe('')
  })
})

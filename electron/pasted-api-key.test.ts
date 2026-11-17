import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isMaskedApiKey, maskedApiKeyMessage, normalizePastedApiKey, pastedApiKeyFormatMessage } from './pasted-api-key'

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

describe('isMaskedApiKey', () => {
  it('recognizes the masks the key list and the local previews draw', () => {
    // new-api 列表：sk-前4位**********后4位（new-api-client.ts parseMaskedTokenKey）。
    expect(isMaskedApiKey('sk-AbCd**********WxYz')).toBe(true)
    // 历史账号的列表、本机配置预览（sub2api-relay-backend.ts、key-secret-summary.ts、config-files.ts）。
    expect(isMaskedApiKey('••••••••')).toBe(true)
    expect(isMaskedApiKey('sk-Ab••••••••WxYz')).toBe(true)
    // 别处常见的画法：全角星号、实心圆点。
    expect(isMaskedApiKey('sk-AbCd＊＊＊＊WxYz')).toBe(true)
    expect(isMaskedApiKey('sk-AbCd●●●●WxYz')).toBe(true)
  })

  it('leaves real keys alone', () => {
    expect(isMaskedApiKey(key)).toBe(false)
    expect(isMaskedApiKey('sk-AbCd-0000_WxYz.9')).toBe(false)
    expect(isMaskedApiKey('')).toBe(false)
  })

  it('says in plain words what to do, without technical terms', () => {
    expect(maskedApiKeyMessage).toBe('这是打码后的密钥，请到「密钥」页点复制按钮，复制完整的那串')
    expect(pastedApiKeyFormatMessage).toBe('密钥格式不对，请重新复制完整的密钥')
    expect(`${maskedApiKeyMessage}${pastedApiKeyFormatMessage}`).not.toMatch(/API|Key|[A-Za-z]/)
  })
})

// Random inputs (fast-check): keys in the alphabet relay keys use, with the
// characters a PDF, a chat app or a web page adds sprinkled anywhere. A failing
// run prints its seed and the smallest paste that did not come back clean.
describe('normalizePastedApiKey with random inputs', () => {
  const invisible = fc.constantFrom('\u0020', '\u00A0', '\u1680', '\u2000', '\u2005', '\u200A', '\u200B', '\u200C', '\u200D', '\u2028', '\u2029', '\u202F', '\u205F', '\u2060', '\u3000', '\uFEFF')
  const keyCharacter = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.split(''))
  const realKey = fc.string({ unit: keyCharacter, minLength: 20, maxLength: 64 }).map((body) => `sk-${body}`)
  const edge = fc.string({ unit: fc.oneof(invisible, fc.constantFrom('\t', '\r', '\n', '\v', '\f')), maxLength: 4 })

  it('gives back the key itself however many invisible characters the paste carried', () => {
    fc.assert(fc.property(realKey, fc.array(fc.tuple(fc.nat(), invisible), { maxLength: 6 }), edge, edge, (key, sprinkles, before, after) => {
      const characters = key.split('')
      for (const [at, character] of sprinkles) characters.splice(at % (characters.length + 1), 0, character)
      expect(normalizePastedApiKey(`${before}${characters.join('')}${after}`)).toBe(key)
    }), { numRuns: 500 })
  })

  it('only ever removes characters, never leaves an invisible one or a blank edge, and is stable on a second pass', () => {
    fc.assert(fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 40 }), fc.string({ unit: fc.oneof(invisible, keyCharacter), maxLength: 40 })), (paste) => {
      const once = normalizePastedApiKey(paste)
      expect(normalizePastedApiKey(once)).toBe(once)
      expect(once).toBe(once.trim())
      expect(once).not.toMatch(/[\u0020\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/)
      let cursor = 0
      for (const character of once) {
        cursor = paste.indexOf(character, cursor)
        expect(cursor).not.toBe(-1)
        cursor += character.length
      }
      expect(isMaskedApiKey(once)).toBe(isMaskedApiKey(paste))
    }), { numRuns: 500 })
  })

  it('keeps a tab or line break inside the key, so the whole key is still rejected later', () => {
    fc.assert(fc.property(realKey, fc.constantFrom('\t', '\n', '\r', '\u0000'), fc.nat(), (key, control, at) => {
      const split = 1 + (at % (key.length - 1))
      expect(normalizePastedApiKey(`${key.slice(0, split)}${control}${key.slice(split)}`)).toContain(control)
    }), { numRuns: 200 })
  })
})

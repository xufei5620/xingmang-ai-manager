import { describe, expect, it } from 'vitest'
import { normalizePastedApiKey, validatePastedApiKey } from './paste-key'

describe('normalizePastedApiKey', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizePastedApiKey('  sk-abc12345  ')).toBe('sk-abc12345')
  })

  it('leaves an already-clean value untouched', () => {
    expect(normalizePastedApiKey('sk-abc12345')).toBe('sk-abc12345')
  })
})

describe('validatePastedApiKey', () => {
  it('rejects an empty value', () => {
    expect(validatePastedApiKey('')).toBe('请输入 Key')
  })

  it('rejects a whitespace-only value', () => {
    expect(validatePastedApiKey('   ')).toBe('请输入 Key')
  })

  it('accepts a plausible key at the minimum length', () => {
    expect(validatePastedApiKey('a'.repeat(8))).toBeNull()
  })

  it('rejects a value shorter than the minimum length', () => {
    expect(validatePastedApiKey('a'.repeat(7))).toBe('Key 长度至少为 8 位')
  })

  it('accepts a value at the maximum length', () => {
    expect(validatePastedApiKey('a'.repeat(512))).toBeNull()
  })

  it('rejects a value longer than the maximum length', () => {
    expect(validatePastedApiKey('a'.repeat(513))).toBe('Key 长度不能超过 512 位')
  })

  it('rejects an interior space even when the trimmed length is otherwise valid', () => {
    expect(validatePastedApiKey('sk-abc 12345')).toBe('Key 不能包含空白或控制字符')
  })

  it('rejects an embedded newline', () => {
    expect(validatePastedApiKey('sk-abc12345\nsk-more')).toBe('Key 不能包含空白或控制字符')
  })

  it('rejects an embedded tab', () => {
    expect(validatePastedApiKey('sk-abc\t12345')).toBe('Key 不能包含空白或控制字符')
  })

  it('rejects an embedded control character outside the \\s class', () => {
    expect(validatePastedApiKey('sk-abc12345\x00tail')).toBe('Key 不能包含空白或控制字符')
  })

  it('trims surrounding whitespace before checking length, so a padded-but-valid key passes', () => {
    expect(validatePastedApiKey('  sk-abc12345  ')).toBeNull()
  })

  it('checks character content before length, giving the more specific error first', () => {
    // A too-short value that also contains a space -- the whitespace error
    // takes priority since it is checked first.
    expect(validatePastedApiKey('a b')).toBe('Key 不能包含空白或控制字符')
  })
})

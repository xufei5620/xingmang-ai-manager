import { describe, expect, it } from 'vitest'
import { middleTruncate } from './identifier-display'

describe('middleTruncate', () => {
  it('leaves identifiers that already fit untouched', () => {
    expect(middleTruncate('gpt-image-2')).toBe('gpt-image-2')
    expect(middleTruncate('', 8)).toBe('')
  })

  it('keeps the distinguishing tail that end-truncation would destroy', () => {
    const preview = middleTruncate('gemini-3-pro-image-preview', 20)
    const fast = middleTruncate('gemini-3-pro-image-fast', 20)
    expect(preview).not.toBe(fast)
    expect(preview.endsWith('preview')).toBe(true)
    expect(fast.endsWith('fast')).toBe(true)
  })

  it('never exceeds the requested length', () => {
    for (const maximum of [5, 8, 12, 20, 33]) {
      expect(middleTruncate('A'.repeat(43), maximum).length).toBeLessThanOrEqual(maximum)
    }
  })

  it('distinguishes two content-addressed ids that share a long prefix', () => {
    const shared = 'Q'.repeat(38)
    expect(middleTruncate(`${shared}aaaaa`, 16)).not.toBe(middleTruncate(`${shared}bbbbb`, 16))
  })

  it('rejects a budget too small to show both ends', () => {
    expect(() => middleTruncate('abcdefgh', 4)).toThrow(/至少为 5/)
  })
})

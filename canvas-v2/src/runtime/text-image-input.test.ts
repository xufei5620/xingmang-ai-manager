import { describe, expect, it } from 'vitest'
import { textImageInputLimits, textImageInputModelSupported, validateTextImageInputConfiguration } from './text-image-input'

describe('text image input capabilities', () => {
  it.each(['gpt-4.1', 'gpt-4.1-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-6-astra', 'gpt-6.1-sol'])('allows the reviewed exact model %s', (model) => {
    expect(textImageInputModelSupported(model)).toBe(true)
    expect(() => validateTextImageInputConfiguration(model, 4)).not.toThrow()
  })
  it.each(['custom', 'prefix/gpt-4.1', 'gpt-4.1-custom', 'gpt-image-2'])('does not infer visual support for %s while preserving text-only use', (model) => {
    expect(textImageInputModelSupported(model)).toBe(false)
    expect(() => validateTextImageInputConfiguration(model, 0)).not.toThrow()
    expect(() => validateTextImageInputConfiguration(model, 1)).toThrow('不会忽略图片')
  })
  it.each([-1, 1.5, 5, NaN, Infinity])('rejects an invalid or excessive count %s', (count) => {
    expect(() => validateTextImageInputConfiguration('gpt-4.1', count)).toThrow('4 张')
  })
  it('publishes bounded image and aggregate budgets', () => {
    expect(textImageInputLimits.images).toBe(4)
    expect(textImageInputLimits.totalBytes).toBe(8 * 1024 * 1024)
  })
})

import { describe, expect, it } from 'vitest'
import { createRendererErrorDeduper } from './renderer-error-report'

describe('renderer error deduper', () => {
  it('claims an error object once and rejects a repeat claim of the same object', () => {
    const deduper = createRendererErrorDeduper()
    const error = new Error('boom')
    expect(deduper.claim(error)).toBe(true)
    expect(deduper.claim(error)).toBe(false)
    expect(deduper.claim(error)).toBe(false)
  })

  it('treats distinct error objects with identical messages as unrelated crashes', () => {
    const deduper = createRendererErrorDeduper()
    expect(deduper.claim(new Error('boom'))).toBe(true)
    expect(deduper.claim(new Error('boom'))).toBe(true)
  })

  it('always reports primitive throw values, which cannot be tracked by identity', () => {
    const deduper = createRendererErrorDeduper()
    expect(deduper.claim('string throw')).toBe(true)
    expect(deduper.claim('string throw')).toBe(true)
    expect(deduper.claim(404)).toBe(true)
    expect(deduper.claim(null)).toBe(true)
    expect(deduper.claim(undefined)).toBe(true)
  })

  it('keeps deduplication state isolated per deduper instance', () => {
    const first = createRendererErrorDeduper()
    const second = createRendererErrorDeduper()
    const error = new Error('boom')
    expect(first.claim(error)).toBe(true)
    // A fresh instance has never seen this object, regardless of what the
    // first deduper already claimed.
    expect(second.claim(error)).toBe(true)
  })
})

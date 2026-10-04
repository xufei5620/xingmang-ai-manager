import { describe, expect, it } from 'vitest'
import { hasRowFocus, requestRowFocus, takeRowFocus } from './row-focus'

describe('row focus intent', () => {
  it('hands the requested row to that page once and then forgets it', () => {
    requestRowFocus('settings', 'auto-update')
    expect(hasRowFocus('settings')).toBe(true)
    expect(takeRowFocus('settings')).toBe('auto-update')
    expect(hasRowFocus('settings')).toBe(false)
    expect(takeRowFocus('settings')).toBeNull()
  })

  it('leaves a row meant for another page where it is', () => {
    requestRowFocus('health', 'CERTIFICATE_TRUST')
    expect(hasRowFocus('settings')).toBe(false)
    expect(takeRowFocus('settings')).toBeNull()
    expect(takeRowFocus('health')).toBe('CERTIFICATE_TRUST')
  })

  it('keeps only the latest request', () => {
    requestRowFocus('settings', 'theme')
    requestRowFocus('settings', 'proxy')
    expect(takeRowFocus('settings')).toBe('proxy')
  })
})

import { describe, expect, it } from 'vitest'
import { providerTabKeyboardTarget } from './ProviderTabs'

describe('provider tab keyboard navigation', () => {
  const unavailable = new Set(['claude', 'grok'] as const)

  it('wraps with ArrowLeft and ArrowRight while skipping unavailable tabs', () => {
    expect(providerTabKeyboardTarget('ArrowRight', 'codex', unavailable)).toBe('gemini')
    expect(providerTabKeyboardTarget('ArrowRight', 'gemini', unavailable)).toBe('codex')
    expect(providerTabKeyboardTarget('ArrowLeft', 'codex', unavailable)).toBe('gemini')
  })

  it('moves Home and End to the first and last available tabs', () => {
    expect(providerTabKeyboardTarget('Home', 'gemini', unavailable)).toBe('codex')
    expect(providerTabKeyboardTarget('End', 'codex', unavailable)).toBe('gemini')
  })

  it('ignores unrelated keys, a disabled control, and an empty tab set', () => {
    expect(providerTabKeyboardTarget('Enter', 'codex', unavailable)).toBeNull()
    expect(providerTabKeyboardTarget('ArrowRight', 'codex', unavailable, true)).toBeNull()
    expect(providerTabKeyboardTarget(
      'ArrowRight',
      'codex',
      new Set(['codex', 'claude', 'gemini', 'grok']),
    )).toBeNull()
  })
})

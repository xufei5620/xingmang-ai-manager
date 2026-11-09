import { describe, expect, it } from 'vitest'
import { initialTheme } from './initial-theme'

describe('initialTheme', () => {
  it('paints the first frame dark when the main process opened the window with the dark theme', () => {
    expect(initialTheme('?theme=dark')).toBe('dark')
    expect(initialTheme('?onboardingPreview=1&theme=dark')).toBe('dark')
  })

  it('paints the first frame light for the light theme', () => {
    expect(initialTheme('?theme=light')).toBe('light')
  })

  it('falls back to light when the address carries no theme or an unknown one', () => {
    expect(initialTheme('')).toBe('light')
    expect(initialTheme('?dashboardPreview=1')).toBe('light')
    expect(initialTheme('?theme=')).toBe('light')
    expect(initialTheme('?theme=system')).toBe('light')
    expect(initialTheme('?theme=DARK')).toBe('light')
    expect(initialTheme('?theme=dark%20')).toBe('light')
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { CanvasHostBridge } from '../host'
import { applyCanvasAppearance, applyCanvasTheme, initialCanvasAppearance, initialCanvasTheme, subscribeCanvasTheme } from './canvas-theme'

describe('canvas theme', () => {
  it('accepts only the two host themes and defaults to dark', () => {
    expect(initialCanvasTheme('?theme=light')).toBe('light')
    expect(initialCanvasTheme('?theme=dark')).toBe('dark')
    expect(initialCanvasTheme('?theme=system')).toBe('dark')
    expect(initialCanvasTheme('?theme=LIGHT')).toBe('dark')
  })

  it('applies the theme atomically to the root and color-scheme metadata', () => {
    const setAttribute = vi.fn()
    const target = {
      documentElement: { dataset: {} as Record<string, string | undefined>, style: { colorScheme: '' } },
      querySelector: vi.fn(() => ({ setAttribute })),
    }

    applyCanvasTheme('light', target)

    expect(target.documentElement.dataset.theme).toBe('light')
    expect(target.documentElement.style.colorScheme).toBe('light')
    expect(setAttribute).toHaveBeenCalledWith('content', 'light')
  })

  it('subscribes through the narrow host event and returns its cleanup', () => {
    const cleanup = vi.fn()
    const onThemeChange = vi.fn(() => cleanup)
    const listener = vi.fn()

    expect(subscribeCanvasTheme({ onThemeChange }, listener)).toBe(cleanup)
    expect(onThemeChange).toHaveBeenCalledWith(listener)
    expect(subscribeCanvasTheme(undefined, listener)).toEqual(expect.any(Function))
    expect(subscribeCanvasTheme({} as Pick<CanvasHostBridge, 'onThemeChange'>, listener)).toEqual(expect.any(Function))
  })

  it('limits initial appearance to known display fields and does not infer success from arbitrary query values', () => {
    expect(initialCanvasAppearance('?theme=light&skin=mist&reducedMotion=1&apiKey=hidden')).toEqual({ theme: 'light', uiSkin: 'mist', reducedMotion: true })
    expect(initialCanvasAppearance('?theme=dark&skin=unknown&reducedMotion=yes')).toEqual({ theme: 'dark', reducedMotion: false })
  })

  it('applies and clears explicit skin and motion choices without changing workflow data', () => {
    const target = { documentElement: { dataset: {} as Record<string, string | undefined>, style: { colorScheme: '' } }, querySelector: () => null }
    applyCanvasAppearance({ theme: 'light', uiSkin: 'aurora', reducedMotion: true }, target)
    expect(target.documentElement.dataset).toEqual({ theme: 'light', skin: 'aurora', reducedMotion: 'true' })
    applyCanvasAppearance({ theme: 'dark' }, target)
    expect(target.documentElement.dataset).toEqual({ theme: 'dark', skin: 'obsidian', reducedMotion: 'false' })
    applyCanvasAppearance({ theme: 'light' }, target)
    expect(target.documentElement.dataset.skin).toBe('dawn')
  })
})

import type { CanvasHostBridge } from '../host'

export type CanvasTheme = 'light' | 'dark'

interface CanvasThemeDocument {
  documentElement: {
    dataset: Record<string, string | undefined>
    style: { colorScheme: string }
  }
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null
}

export function initialCanvasTheme(search = ''): CanvasTheme {
  const requested = new URLSearchParams(search).get('theme')
  return requested === 'light' ? 'light' : 'dark'
}

export function applyCanvasTheme(
  theme: CanvasTheme,
  target: CanvasThemeDocument = document,
): void {
  target.documentElement.dataset.theme = theme
  target.documentElement.style.colorScheme = theme
  target.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
}

export function subscribeCanvasTheme(
  host: Pick<CanvasHostBridge, 'onThemeChange'> | undefined,
  listener: (theme: CanvasTheme) => void,
): () => void {
  return typeof host?.onThemeChange === 'function'
    ? host.onThemeChange(listener)
    : (() => undefined)
}

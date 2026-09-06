import type { CanvasAppearance, CanvasHostBridge } from '../host'

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

export function initialCanvasAppearance(search = ''): CanvasAppearance {
  const params = new URLSearchParams(search)
  const skin = params.get('skin')
  const uiSkin = skin === 'dawn' || skin === 'obsidian' || skin === 'mist' || skin === 'aurora' ? skin : undefined
  return { theme: initialCanvasTheme(search), ...(uiSkin ? { uiSkin } : {}), reducedMotion: params.get('reducedMotion') === '1' }
}

export function applyCanvasAppearance(appearance: CanvasAppearance, target: CanvasThemeDocument = document): void {
  applyCanvasTheme(appearance.theme, target)
  target.documentElement.dataset.skin = appearance.uiSkin ?? (appearance.theme === 'light' ? 'dawn' : 'obsidian')
  target.documentElement.dataset.reducedMotion = String(appearance.reducedMotion === true)
}

export function subscribeCanvasTheme(
  host: Pick<CanvasHostBridge, 'onThemeChange'> | undefined,
  listener: (theme: CanvasTheme) => void,
): () => void {
  return typeof host?.onThemeChange === 'function'
    ? host.onThemeChange(listener)
    : (() => undefined)
}

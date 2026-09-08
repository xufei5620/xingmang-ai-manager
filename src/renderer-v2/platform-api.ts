import type {
  PlatformSystemState,
  XingmangPlatformApi,
} from '../../electron/platform/contract'
import type { V2Bridge } from './types'

declare global {
  interface Window {
    xingmangPlatform?: XingmangPlatformApi
  }
}
export const platformApi = () =>
  typeof window !== 'undefined' ? (window.xingmangPlatform ?? null) : null

export function bindPlatformAppearance(
  platform: XingmangPlatformApi,
  native: Pick<V2Bridge, 'setWindowTheme'>,
  onTheme: (theme: 'light' | 'dark') => void,
  onError: (error: unknown) => void,
): () => void {
  let active = true
  let revision = 0
  let lastTheme: 'light' | 'dark' | null = null
  let queue: Promise<void> = Promise.resolve()
  const apply = (state: PlatformSystemState) => {
    if (!active) return
    document.documentElement.dataset.contrast = state.appearance.highContrast
      ? 'high'
      : 'normal'
    document.documentElement.classList.toggle(
      'hc',
      state.appearance.highContrast,
    )
    if (lastTheme === state.appearance.theme) return
    const theme = state.appearance.theme
    lastTheme = theme
    queue = queue
      .then(async () => {
        if (!active) return
        await native.setWindowTheme(theme)
        if (active) {
          document.documentElement.dataset.theme = theme
          onTheme(theme)
        }
      })
      .catch((error) => {
        lastTheme = null
        if (active) onError(error)
      })
  }
  const stop = platform.onStateChanged((state) => {
    revision++
    apply(state)
  })
  const initial = revision
  void platform
    .getState()
    .then((state) => {
      if (initial === revision) apply(state)
    })
    .catch((error) => {
      if (active) onError(error)
    })
  return () => {
    active = false
    stop()
  }
}

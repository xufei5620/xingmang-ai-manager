import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { AppSettingsV2, XingmangApi } from '../../../../electron/ipc-contract'
import { errorMessage } from '../../business-common'
import { bindPlatformAppearance, platformApi } from '../../platform-api'
import { startupCheckFailure, type StartupNotice } from './startup-notice'
import { nextUiScale, type UiScaleShortcut } from './ui-scale-shortcut'
import type { WindowOs } from './window-os'
import type { AppApi, AppToast, Perform } from './runtime-context'

interface AppearanceOptions {
  native: XingmangApi
  app: AppApi
  boot: 'loading' | 'ready' | 'failed'
  settings: AppSettingsV2 | null
  setSettings: Dispatch<SetStateAction<AppSettingsV2 | null>>
  os: WindowOs
  noteStartupCheck(notice: StartupNotice): void
  perform: Perform
  toast: AppToast
}

/** 深浅色、减少动效、大字、跟随系统外观、界面缩放：都挂在根节点上，整个窗口跟着变。 */
export function useAppearance({ native, app, boot, settings, setSettings, os, noteStartupCheck, perform, toast }: AppearanceOptions) {
  useLayoutEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion === true)
    document.documentElement.dataset.largeText = String(settings.largeText === true)
    document.documentElement.style.colorScheme = settings.theme
  }, [settings])
  useEffect(() => {
    const system = platformApi()
    if (!system || boot !== 'ready') return
    return bindPlatformAppearance(system, native, (theme) => setSettings((current) => current ? { ...current, theme } : current),
      (cause) => noteStartupCheck(startupCheckFailure('appearance', errorMessage(cause, '系统外观没有同步'))))
  }, [boot, native, noteStartupCheck, setSettings])
  useLayoutEffect(() => { document.documentElement.dataset.os = os }, [os])
  // 连按几下 Ctrl 加号时，保存还没回来，下一下要接着上一下算，不能都从旧设置起步。
  const uiScaleRef = useRef<AppSettingsV2['uiScale']>(undefined)
  useEffect(() => { uiScaleRef.current = settings?.uiScale }, [settings?.uiScale])
  const changeUiScale = useCallback((shortcut: UiScaleShortcut) => {
    const step = nextUiScale(uiScaleRef.current, shortcut, os)
    toast.show(step.message)
    const next = step.next
    if (next === null) return
    uiScaleRef.current = next === 'auto' ? undefined : next
    void perform('保存界面缩放', async () => setSettings(await app.savePreferences({ version: 2, uiScale: next })))
  }, [app, os, perform, toast, setSettings])
  // 顶栏和欢迎页窗口条上那颗深浅色切换走同一条保存路径。
  const toggleTheme = settings ? () => {
    const next = settings.theme === 'dark' ? 'light' : 'dark'
    const system = platformApi()
    void perform('保存外观', async () => { if (system) await system.setThemePreference(next); else setSettings(await app.savePreferences({ version: 2, theme: next })) })
  } : undefined
  return { changeUiScale, toggleTheme }
}

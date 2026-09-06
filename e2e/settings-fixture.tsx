import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPage, type SettingsV2 } from '../src/pages/SettingsPage'
import type { AppSettingsV2Update } from '../src/types'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'

const params = new URLSearchParams(location.search)
const initialTheme = params.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.theme = initialTheme
document.documentElement.dataset.skin = params.get('skin') ?? (initialTheme === 'light' ? 'dawn' : 'obsidian')
const pending: Array<{ resolve(): void; reject(error: Error): void }> = []
const requests: AppSettingsV2Update[] = []
declare global {
  interface Window {
    settingsHarness: { requests: AppSettingsV2Update[]; confirmed: SettingsV2 | null; settle(index: number, failure?: string): void }
  }
}
window.settingsHarness = { requests, confirmed: null, settle(index, failure) { if (failure) pending[index].reject(new Error(failure)); else pending[index].resolve() } }

function Fixture() {
  const [value, setValue] = useState<SettingsV2>({ version: 2, workspace: 'C:\\workspace', theme: initialTheme, checkUpdatesOnStartup: true, runDiagnosticsOnStartup: false })
  window.settingsHarness.confirmed = value
  const write = async (patch: AppSettingsV2Update) => {
    requests.push(patch)
    if (params.get('manual') === '1') await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
    const updated = { ...patch } as Record<string, unknown>
    for (const key of ['uiSkin', 'uiScale', 'mirrorPolicy', 'closeBehavior']) {
      if (updated[key] === 'auto' || updated[key] === 'ask') updated[key] = undefined
    }
    setValue((current) => ({ ...current, ...updated }))
  }
  return <main style={{ width: '100%', minHeight: '100vh', padding: 28 }}><SettingsPage value={value} onSave={async (next) => setValue(next)} onSavePatch={write}
    onThemePreview={(theme) => { document.documentElement.dataset.theme = theme }}
    onAppearancePreview={(appearance) => {
      if ('uiSkin' in appearance) document.documentElement.dataset.skin = appearance.uiSkin ?? (value.theme === 'light' ? 'dawn' : 'obsidian')
      if ('reducedMotion' in appearance) document.documentElement.dataset.reducedMotion = String(Boolean(appearance.reducedMotion))
    }} onChooseWorkspace={async () => 'D:\\chosen'} onNavigate={() => {}} onReplayOnboarding={() => {}} appVersion="fixture" trayAvailable={false} desktopNotificationsSupported={params.get('unsupportedNotifications') !== '1'} /></main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

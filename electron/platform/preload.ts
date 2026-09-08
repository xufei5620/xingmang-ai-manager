import { contextBridge, ipcRenderer } from 'electron'
import type { PlatformSystemState, XingmangPlatformApi } from './contract'

// Sandbox preloads cannot require sibling modules; keep literal channels here.
const channels = {
  getState: 'xingmang-platform:get-state',
  setThemePreference: 'xingmang-platform:set-theme-preference',
  setHighContrast: 'xingmang-platform:set-high-contrast',
  setStartup: 'xingmang-platform:set-startup',
  getProxyStatus: 'xingmang-platform:get-proxy-status',
  setNotificationPreference: 'xingmang-platform:set-notification-preference',
  setPrivacyPreference: 'xingmang-platform:set-privacy-preference',
  testNotification: 'xingmang-platform:test-notification',
  notifyActivity: 'xingmang-platform:notify-activity',
  stateChanged: 'xingmang-platform:state-changed',
} as const

if (process.isMainFrame) {
  const api: XingmangPlatformApi = {
    getState: () => ipcRenderer.invoke(channels.getState),
    setThemePreference: (preference) =>
      ipcRenderer.invoke(channels.setThemePreference, preference),
    setHighContrast: (enabled) =>
      ipcRenderer.invoke(channels.setHighContrast, enabled),
    setStartup: (enabled) => ipcRenderer.invoke(channels.setStartup, enabled),
    getProxyStatus: () => ipcRenderer.invoke(channels.getProxyStatus),
    setNotificationPreference: (kind, enabled) =>
      ipcRenderer.invoke(channels.setNotificationPreference, kind, enabled),
    setPrivacyPreference: (kind, enabled) =>
      ipcRenderer.invoke(channels.setPrivacyPreference, kind, enabled),
    testNotification: () => ipcRenderer.invoke(channels.testNotification),
    notifyActivity: (kind, eventKey) =>
      ipcRenderer.invoke(channels.notifyActivity, kind, eventKey),
    onStateChanged: (listener) => {
      const receive = (
        _event: Electron.IpcRendererEvent,
        state: PlatformSystemState,
      ) => listener(state)
      ipcRenderer.on(channels.stateChanged, receive)
      return () => {
        ipcRenderer.removeListener(channels.stateChanged, receive)
      }
    },
  }
  contextBridge.exposeInMainWorld('xingmangPlatform', Object.freeze(api))
}

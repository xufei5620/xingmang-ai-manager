export type PlatformThemePreference = 'system' | 'light' | 'dark'
export type PlatformNotificationKind =
  'install' | 'balance' | 'task' | 'cliUpdate'
// 崩溃上报不再是这里的偏好：它现在是 AppSettings.crashReporting（settings.json），
// 因为主进程要在窗口和这套系统界面服务存在之前就决定上不上报。
export type PlatformPrivacyPreference = 'anonymousUsage'
export interface PlatformNotificationPreferences {
  install: boolean
  balance: boolean
  task: boolean
  cliUpdate: boolean
}
export type PlatformNotificationResult =
  'requested' | 'disabled' | 'unsupported' | 'duplicate'

export interface PlatformPreferences {
  version: 1
  themePreference: PlatformThemePreference
  highContrast: boolean
  notifications?: PlatformNotificationPreferences
  privacy?: Record<PlatformPrivacyPreference, boolean>
}

export interface PlatformSystemState {
  preferences: PlatformPreferences
  appearance: {
    theme: 'light' | 'dark'
    highContrast: boolean
    systemHighContrast: boolean
  }
  startup: {
    supported: boolean
    requested: boolean
    enabled: boolean
    approvalRequired: boolean
    note: string
  }
}

export interface PlatformProxyStatus {
  readOnly: true
  scope: 'electron-session'
  targetOrigin: string
  route: 'direct' | 'proxy' | 'unknown'
  summary: string
  note: string
}

export interface XingmangPlatformApi {
  getState(): Promise<PlatformSystemState>
  setThemePreference(
    preference: PlatformThemePreference,
  ): Promise<PlatformSystemState>
  setHighContrast(enabled: boolean): Promise<PlatformSystemState>
  setStartup(enabled: boolean): Promise<PlatformSystemState>
  getProxyStatus(): Promise<PlatformProxyStatus>
  setNotificationPreference(
    kind: PlatformNotificationKind,
    enabled: boolean,
  ): Promise<PlatformSystemState>
  setPrivacyPreference(
    kind: PlatformPrivacyPreference,
    enabled: boolean,
  ): Promise<PlatformSystemState>
  testNotification(): Promise<PlatformNotificationResult>
  notifyActivity(
    kind: PlatformNotificationKind,
    eventKey: string,
  ): Promise<PlatformNotificationResult>
  onStateChanged(listener: (state: PlatformSystemState) => void): () => void
}

export const platformChannels = {
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

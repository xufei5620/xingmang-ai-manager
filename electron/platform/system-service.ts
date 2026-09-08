import type { App } from 'electron'
import { resolveRelaySite } from '../relay-sites'
import type {
  PlatformNotificationKind,
  PlatformNotificationResult,
  PlatformPrivacyPreference,
  PlatformProxyStatus,
  PlatformSystemState,
  PlatformThemePreference,
} from './contract'
import type { PlatformPreferenceStore } from './settings-store'

export interface PlatformSystemDependencies {
  app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>
  nativeTheme: {
    themeSource: PlatformThemePreference
    readonly shouldUseDarkColors: boolean
    readonly shouldUseHighContrastColors: boolean
    on(event: 'updated', listener: () => void): unknown
    removeListener(event: 'updated', listener: () => void): unknown
  }
  store: PlatformPreferenceStore
  platform: string
  packaged: boolean
  executablePath: string
  resolveProxy(url: string): Promise<string>
  relaySiteId?: () => string | undefined
  onError?: (error: unknown) => void
  notify?: (
    kind: PlatformNotificationKind | 'test',
    eventKey: string,
  ) => PlatformNotificationResult
}

const proxyScopeNote =
  '这里只查看应用窗口如何连接。账号、AI 请求和工具安装继续使用各自原有的连接方式；此处不会更改电脑或工具的代理。'

export function summarizeSessionProxy(
  value: string,
): Pick<PlatformProxyStatus, 'route' | 'summary'> {
  const firstRoute = value.slice(0, 2048).split(';', 1)[0].trim()
  if (firstRoute.toUpperCase() === 'DIRECT')
    return { route: 'direct', summary: '应用窗口当前直接连接' }
  if (/^(?:PROXY|HTTPS?|SOCKS[45]?)\s+[^\s;@]+(?::\d+)?$/i.test(firstRoute))
    return { route: 'proxy', summary: '应用窗口当前使用代理路由' }
  return { route: 'unknown', summary: '暂时无法确认应用窗口的代理路由' }
}

export class PlatformSystemService {
  private readonly listeners = new Set<(state: PlatformSystemState) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly onThemeUpdate = () => {
    try {
      this.emit()
    } catch (error) {
      this.dependencies.onError?.(error)
    }
  }
  constructor(private readonly dependencies: PlatformSystemDependencies) {
    dependencies.nativeTheme.themeSource =
      dependencies.store.read().themePreference
    dependencies.nativeTheme.on('updated', this.onThemeUpdate)
  }

  dispose() {
    this.dependencies.nativeTheme.removeListener('updated', this.onThemeUpdate)
    this.listeners.clear()
  }
  subscribe(listener: (state: PlatformSystemState) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private startup(): PlatformSystemState['startup'] {
    const { app, platform, packaged, executablePath } = this.dependencies
    if ((platform !== 'win32' && platform !== 'darwin') || !packaged)
      return {
        supported: false,
        requested: false,
        enabled: false,
        approvalRequired: false,
        note: !packaged
          ? '开发模式不设置开机自动启动。'
          : '当前系统暂不支持设置开机自动启动。',
      }
    const state = app.getLoginItemSettings(
      platform === 'win32' ? { path: executablePath, args: [] } : undefined,
    )
    const approvalRequired =
      platform === 'darwin' && state.status === 'requires-approval'
    const enabled =
      state.openAtLogin &&
      !approvalRequired &&
      (platform !== 'win32' || state.executableWillLaunchAtLogin)
    return {
      supported: true,
      requested: state.openAtLogin,
      enabled,
      approvalRequired,
      note: approvalRequired
        ? '请在系统设置中允许星芒自动启动。'
        : state.openAtLogin && !enabled
          ? '启动项已登记，但系统尚未允许自动运行。'
          : enabled
            ? '登录电脑后自动启动星芒工具箱。'
            : '不会随电脑登录自动启动。',
    }
  }

  getState(): PlatformSystemState {
    const preferences = this.dependencies.store.read()
    const theme =
      preferences.themePreference === 'system'
        ? this.dependencies.nativeTheme.shouldUseDarkColors
          ? 'dark'
          : 'light'
        : preferences.themePreference
    const systemHighContrast =
      this.dependencies.nativeTheme.shouldUseHighContrastColors
    return {
      preferences,
      appearance: {
        theme,
        highContrast: preferences.highContrast || systemHighContrast,
        systemHighContrast,
      },
      startup: this.startup(),
    }
  }

  private emit() {
    const state = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (error) {
        this.dependencies.onError?.(error)
      }
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => undefined).then(work)
    this.queue = task
    return task
  }

  setThemePreference(themePreference: PlatformThemePreference) {
    return this.serial(async () => {
      const before = this.dependencies.store.read()
      await this.dependencies.store.update({ themePreference })
      try {
        this.dependencies.nativeTheme.themeSource = themePreference
      } catch (error) {
        await this.dependencies.store.update({
          themePreference: before.themePreference,
        })
        throw error
      }
      this.emit()
      return this.getState()
    })
  }

  setHighContrast(highContrast: boolean) {
    return this.serial(async () => {
      await this.dependencies.store.update({ highContrast })
      this.emit()
      return this.getState()
    })
  }

  setStartup(enabled: boolean) {
    return this.serial(async () => {
      if (!this.startup().supported)
        throw new Error('当前运行环境不能设置开机自动启动。')
      const { app, platform, executablePath } = this.dependencies
      app.setLoginItemSettings({
        openAtLogin: enabled,
        ...(platform === 'win32' ? { path: executablePath, args: [] } : {}),
      })
      const state = this.getState()
      if (state.startup.requested !== enabled)
        throw new Error('系统没有保存开机启动设置，请在系统设置中检查。')
      this.emit()
      return state
    })
  }
  setNotificationPreference(kind: PlatformNotificationKind, enabled: boolean) {
    return this.serial(async () => {
      const current = this.dependencies.store.read()
      await this.dependencies.store.update({
        notifications: {
          install: true,
          balance: true,
          task: true,
          ...current.notifications,
          [kind]: enabled,
        },
      })
      this.emit()
      return this.getState()
    })
  }
  setPrivacyPreference(kind: PlatformPrivacyPreference, enabled: boolean) {
    return this.serial(async () => {
      const current = this.dependencies.store.read()
      await this.dependencies.store.update({
        privacy: {
          crashReports: false,
          anonymousUsage: false,
          ...current.privacy,
          [kind]: enabled,
        },
      })
      this.emit()
      return this.getState()
    })
  }
  testNotification() {
    return this.dependencies.notify?.('test', 'test') ?? 'unsupported'
  }
  notifyActivity(kind: PlatformNotificationKind, eventKey: string) {
    return this.dependencies.notify?.(kind, eventKey) ?? 'unsupported'
  }

  async getProxyStatus(): Promise<PlatformProxyStatus> {
    const site = resolveRelaySite(this.dependencies.relaySiteId?.())
    const targetOrigin = new URL(site.accountBaseUrl ?? site.websiteUrl).origin
    return {
      readOnly: true,
      scope: 'electron-session',
      targetOrigin,
      ...summarizeSessionProxy(
        await this.dependencies.resolveProxy(targetOrigin),
      ),
      note: proxyScopeNote,
    }
  }
}

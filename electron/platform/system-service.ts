import type { App } from 'electron'
import { loginLaunchArgument } from '../login-launch'
import { resolveRelaySite } from '../relay-sites'
import type {
  PlatformActivityKind,
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
    kind: PlatformActivityKind | 'test',
    eventKey: string,
  ) => PlatformNotificationResult
}

const proxyScopeNote =
  '这里只查看应用窗口如何连接。账号、AI 请求和工具安装继续使用各自原有的连接方式；此处不会更改电脑或工具的网络设置。'

export function summarizeSessionProxy(
  value: string,
): Pick<PlatformProxyStatus, 'route' | 'summary'> {
  const firstRoute = value.slice(0, 2048).split(';', 1)[0].trim()
  if (firstRoute.toUpperCase() === 'DIRECT')
    return { route: 'direct', summary: '应用窗口当前直接连接' }
  if (/^(?:PROXY|HTTPS?|SOCKS[45]?)\s+[^\s;@]+(?::\d+)?$/i.test(firstRoute))
    return { route: 'proxy', summary: '应用窗口当前通过转发连接' }
  return { route: 'unknown', summary: '暂时无法确认应用窗口的连接路径' }
}

// Windows 的开机项按「程序路径 + 参数」整条比对。0.2.9 之前登记的是不带参数的
// 那一条，查询时要把它也认下来，否则老用户会看到开关是关着的、开机却照样启动。
const legacyWindowsLoginArgs: string[] = []

function windowsLoginItem(executablePath: string) {
  return { path: executablePath, args: [loginLaunchArgument] }
}

// 老版本登记的开机项开机时不带参数，程序分不出是系统拉起的，还会照旧弹窗。
// 同名覆盖写成带参数的那一条；关掉开机启动时 Windows 按名字删，两种写法都能删干净。
// 必须在 setAppUserModelId 之后调用：开机项的名字默认取它，名字不同会留下两条。
export function migrateLegacyWindowsLoginItem(
  dependencies: Pick<
    PlatformSystemDependencies,
    'app' | 'platform' | 'packaged' | 'executablePath'
  >,
): boolean {
  const { app, platform, packaged, executablePath } = dependencies
  if (platform !== 'win32' || !packaged) return false
  const current = windowsLoginItem(executablePath)
  if (app.getLoginItemSettings(current).openAtLogin) return false
  const legacy = app.getLoginItemSettings({
    path: executablePath,
    args: legacyWindowsLoginArgs,
  })
  if (!legacy.openAtLogin) return false
  // 用户在任务管理器里把它禁用过的，迁移后仍然是禁用；不能借迁移替他重新打开。
  app.setLoginItemSettings({
    openAtLogin: true,
    ...current,
    enabled: legacy.executableWillLaunchAtLogin,
  })
  return app.getLoginItemSettings(current).openAtLogin
}

// 卸载时调用。程序文件删掉后，Run 键里那一条每次开机都指着一个不存在的 exe，
// 系统也不会替我们清。和关掉开关走同一个写法：Windows 按名字删，带参数的与
// 0.2.9 之前不带参数的同名，一次删干净。同样必须先 setAppUserModelId。
// 返回删完后两种写法是否都查不到了。
export function removeWindowsLoginItem(
  dependencies: Pick<PlatformSystemDependencies, 'app' | 'executablePath'>,
): boolean {
  const { app, executablePath } = dependencies
  app.setLoginItemSettings({
    openAtLogin: false,
    ...windowsLoginItem(executablePath),
  })
  return (
    !app.getLoginItemSettings(windowsLoginItem(executablePath)).openAtLogin &&
    !app.getLoginItemSettings({
      path: executablePath,
      args: legacyWindowsLoginArgs,
    }).openAtLogin
  )
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
      platform === 'win32' ? windowsLoginItem(executablePath) : undefined,
    )
    const requested =
      state.openAtLogin ||
      (platform === 'win32' &&
        app.getLoginItemSettings({
          path: executablePath,
          args: legacyWindowsLoginArgs,
        }).openAtLogin)
    const approvalRequired =
      platform === 'darwin' && state.status === 'requires-approval'
    const enabled =
      requested &&
      !approvalRequired &&
      (platform !== 'win32' || state.executableWillLaunchAtLogin)
    return {
      supported: true,
      requested,
      enabled,
      approvalRequired,
      note: approvalRequired
        ? '请在系统设置中允许星芒自动启动。'
        : requested && !enabled
          ? '启动项已登记，但系统尚未允许自动运行。'
          : enabled
            ? '开机后在托盘里待命，不弹窗口，要用时点托盘图标。'
            : '打开后，开机时会在托盘里待命，不弹窗口。',
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
        ...(platform === 'win32' ? windowsLoginItem(executablePath) : {}),
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
          cliUpdate: true,
          announcement: true,
          acceleration: true,
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
      const privacy = { anonymousUsage: false, ...current.privacy }
      privacy[kind] = enabled
      await this.dependencies.store.update({ privacy })
      this.emit()
      return this.getState()
    })
  }
  testNotification() {
    return this.dependencies.notify?.('test', 'test') ?? 'unsupported'
  }
  notifyActivity(kind: PlatformActivityKind, eventKey: string) {
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

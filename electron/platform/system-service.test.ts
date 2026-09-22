import { describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import type { PlatformPreferences } from './contract'
import { loginLaunchArgument } from '../login-launch'
import {
  migrateLegacyWindowsLoginItem,
  PlatformSystemService,
  summarizeSessionProxy,
  type PlatformSystemDependencies,
} from './system-service'

function setup(platform = 'win32', packaged = true) {
  let preferences: PlatformPreferences = {
    version: 1,
    themePreference: 'light',
    highContrast: false,
  }
  let login: ReturnType<App['getLoginItemSettings']> = {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    status: 'not-registered',
    executableWillLaunchAtLogin: false,
    launchItems: [],
  }
  // Windows 按「路径 + 参数」整条比对开机项；null 表示没登记。
  let registeredArgs: string[] | null = null
  let registeredEnabled = true
  function sameArgs(left: readonly string[] | undefined, right: readonly string[]) {
    const actual = left ?? []
    return actual.length === right.length && actual.every((value, index) => value === right[index])
  }
  let themeListener: () => void = () => undefined
  const nativeTheme = {
    themeSource: 'light' as PlatformPreferences['themePreference'],
    shouldUseDarkColors: false,
    shouldUseHighContrastColors: false,
    on: vi.fn((_event: 'updated', listener: () => void) => {
      themeListener = listener
    }),
    removeListener: vi.fn(),
  }
  const store = {
    read: () => ({ ...preferences }),
    update: vi.fn(async (patch: Partial<PlatformPreferences>) => {
      preferences = { ...preferences, ...patch }
      return { ...preferences }
    }),
  }
  const app = {
    getLoginItemSettings: vi.fn(
      (options?: Parameters<App['getLoginItemSettings']>[0]) => {
        if (platform !== 'win32' || registeredArgs === null) return { ...login }
        const registered = registeredArgs
        return {
          ...login,
          openAtLogin: sameArgs(options?.args, registered),
          executableWillLaunchAtLogin: registeredEnabled,
        }
      },
    ),
    setLoginItemSettings: vi.fn(
      (value: Parameters<App['setLoginItemSettings']>[0]) => {
        registeredArgs = value.openAtLogin === true ? [...(value.args ?? [])] : null
        registeredEnabled = value.openAtLogin === true && value.enabled !== false
        login = {
          ...login,
          openAtLogin: value.openAtLogin === true,
          executableWillLaunchAtLogin: registeredEnabled,
        }
      },
    ),
  }
  const dependencies: PlatformSystemDependencies = {
    app,
    nativeTheme,
    store,
    platform,
    packaged,
    executablePath: 'C:/Test App/xingmang.exe',
    resolveProxy: vi.fn(async () => 'PROXY localhost:7890; DIRECT'),
  }
  const service = new PlatformSystemService(dependencies)
  return {
    service,
    dependencies,
    app,
    store,
    nativeTheme,
    themeUpdated: () => themeListener(),
    setLogin: (patch: Partial<typeof login>) => {
      login = { ...login, ...patch }
    },
    registerWindowsLoginItem: (args: string[], enabled = true) => {
      registeredArgs = args
      registeredEnabled = enabled
    },
    registeredWindowsLoginArgs: () => registeredArgs,
  }
}

describe('platform system preferences', () => {
  it('follows native theme updates without rewriting unrelated preferences', async () => {
    const state = setup()
    const changed = vi.fn()
    state.service.subscribe(changed)
    await state.service.setThemePreference('system')
    state.nativeTheme.shouldUseDarkColors = true
    state.themeUpdated()
    expect(state.nativeTheme.themeSource).toBe('system')
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appearance: {
          theme: 'dark',
          highContrast: false,
          systemHighContrast: false,
        },
      }),
    )
    expect(state.store.update).toHaveBeenCalledTimes(1)
    await state.service.setHighContrast(true)
    expect(state.service.getState().appearance.highContrast).toBe(true)
    state.service.dispose()
    expect(state.nativeTheme.removeListener).toHaveBeenCalledOnce()
  })
  it('does not change the active theme when storage refuses the update', async () => {
    const state = setup()
    state.store.update.mockRejectedValueOnce(new Error('test disk failure'))
    await expect(state.service.setThemePreference('dark')).rejects.toThrow(
      'disk failure',
    )
    expect(state.nativeTheme.themeSource).toBe('light')
    expect(state.service.getState().preferences.themePreference).toBe('light')
    await expect(state.service.setHighContrast(true)).resolves.toMatchObject({
      preferences: { highContrast: true },
    })
  })
  it('sets only this packaged executable as a login item and verifies the OS result', async () => {
    const state = setup()
    await expect(state.service.setStartup(true)).resolves.toMatchObject({
      startup: { requested: true, enabled: true },
    })
    expect(state.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: 'C:/Test App/xingmang.exe',
      args: [loginLaunchArgument],
    })
    expect(state.service.getState().startup.note).toContain('托盘')
    expect(state.store.update).not.toHaveBeenCalled()
    state.app.setLoginItemSettings.mockImplementationOnce(() => undefined)
    await expect(state.service.setStartup(false)).rejects.toThrow(
      '系统没有保存',
    )
  })
  it('still reports a login item registered by an older version without the login argument', async () => {
    const state = setup()
    state.registerWindowsLoginItem([])
    expect(state.service.getState().startup).toMatchObject({
      requested: true,
      enabled: true,
    })
    await expect(state.service.setStartup(false)).resolves.toMatchObject({
      startup: { requested: false, enabled: false },
    })
    expect(state.registeredWindowsLoginArgs()).toBeNull()
  })
  it('rewrites an older Windows login item so login starts stay in the tray', () => {
    const state = setup()
    state.registerWindowsLoginItem([])
    expect(migrateLegacyWindowsLoginItem(state.dependencies)).toBe(true)
    expect(state.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: 'C:/Test App/xingmang.exe',
      args: [loginLaunchArgument],
      enabled: true,
    })
    expect(state.registeredWindowsLoginArgs()).toEqual([loginLaunchArgument])
    state.app.setLoginItemSettings.mockClear()
    expect(migrateLegacyWindowsLoginItem(state.dependencies)).toBe(false)
    expect(state.app.setLoginItemSettings).not.toHaveBeenCalled()
  })
  it('keeps a login item the user disabled in Task Manager disabled while migrating it', () => {
    const state = setup()
    state.registerWindowsLoginItem([], false)
    expect(migrateLegacyWindowsLoginItem(state.dependencies)).toBe(true)
    expect(state.app.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    )
    expect(state.service.getState().startup).toMatchObject({
      requested: true,
      enabled: false,
    })
  })
  it('does not touch login items that were never registered or outside packaged Windows', () => {
    for (const state of [setup(), setup('win32', false), setup('darwin')]) {
      expect(migrateLegacyWindowsLoginItem(state.dependencies)).toBe(false)
      expect(state.app.setLoginItemSettings).not.toHaveBeenCalled()
    }
  })
  it('keeps macOS approval requirements distinct from enabled startup', async () => {
    const state = setup('darwin')
    state.setLogin({ status: 'requires-approval' })
    await expect(state.service.setStartup(true)).resolves.toMatchObject({
      startup: { requested: true, enabled: false, approvalRequired: true },
    })
    expect(state.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
    })
  })
  it('does not read or mutate native login entries in development or unsupported systems', async () => {
    for (const state of [setup('win32', false), setup('linux')]) {
      expect(state.service.getState().startup.supported).toBe(false)
      await expect(state.service.setStartup(true)).rejects.toThrow('不能设置')
      expect(state.app.getLoginItemSettings).not.toHaveBeenCalled()
      expect(state.app.setLoginItemSettings).not.toHaveBeenCalled()
    }
  })
  it('reads only the fixed application route and never claims Node traffic was changed', async () => {
    const state = setup()
    const proxy = await state.service.getProxyStatus()
    expect(state.dependencies.resolveProxy).toHaveBeenCalledWith(
      'https://xm.solov.cc',
    )
    expect(proxy).toMatchObject({
      readOnly: true,
      scope: 'electron-session',
      route: 'proxy',
    })
    expect(proxy.note).toContain('账号、AI 请求')
    expect(proxy.note).toContain('不会更改电脑或工具的网络设置')
    expect(JSON.stringify(proxy)).not.toContain('localhost')
    expect(summarizeSessionProxy('DIRECT; PROXY localhost:7890').route).toBe(
      'direct',
    )
    expect(summarizeSessionProxy('PROXY user:secret@host:123').route).toBe(
      'unknown',
    )
  })
  it('persists granular notification and privacy preferences without any network or startup mutation', async () => {
    const h = setup()
    await h.service.setNotificationPreference('balance', false)
    await h.service.setPrivacyPreference('anonymousUsage', true)
    expect(h.service.getState().preferences).toMatchObject({
      // 关掉一项不该顺手关掉别的：没被点过的开关一律保持默认开着，
      // 其中 cliUpdate 是 0.2.9 才加的，老文件里根本没有这一项。
      notifications: {
        install: true,
        balance: false,
        task: true,
        cliUpdate: true,
      },
      privacy: { anonymousUsage: true },
    })
    expect(h.dependencies.resolveProxy).not.toHaveBeenCalled()
    expect(h.app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(h.service.testNotification()).toBe('unsupported')
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import type { PlatformPreferences } from './contract'
import {
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
    getLoginItemSettings: vi.fn(() => ({ ...login })),
    setLoginItemSettings: vi.fn(
      (value: Parameters<App['setLoginItemSettings']>[0]) => {
        login = {
          ...login,
          openAtLogin: value.openAtLogin === true,
          executableWillLaunchAtLogin: value.openAtLogin === true,
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
      args: [],
    })
    expect(state.store.update).not.toHaveBeenCalled()
    state.app.setLoginItemSettings.mockImplementationOnce(() => undefined)
    await expect(state.service.setStartup(false)).rejects.toThrow(
      '系统没有保存',
    )
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
    expect(proxy.note).toContain('不会更改电脑或工具的代理')
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
      notifications: { install: true, balance: false, task: true },
      privacy: { crashReports: false, anonymousUsage: true },
    })
    expect(h.dependencies.resolveProxy).not.toHaveBeenCalled()
    expect(h.app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(h.service.testNotification()).toBe('unsupported')
  })
})

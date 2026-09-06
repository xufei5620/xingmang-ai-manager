import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Menu, MenuItemConstructorOptions, NativeImage } from 'electron'
import {
  buildApplicationTrayMenu,
  createApplicationTray,
  trayBalanceLabel,
  type ApplicationTrayOptions,
  type ApplicationTrayRuntime,
  type ApplicationTraySnapshot,
} from './application-tray'

vi.mock('electron', () => ({ Menu: {}, Tray: vi.fn(), nativeImage: {} }))

function fixture(overrides: Partial<ApplicationTrayOptions> = {}, runtimeOverrides: Partial<ApplicationTrayRuntime> = {}) {
  let destroyed = false
  const events = new EventEmitter()
  const handle = Object.assign(events, {
    isDestroyed: vi.fn(() => destroyed),
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(() => { destroyed = true }),
  })
  const options: ApplicationTrayOptions = {
    iconPath: '/assets/tray-16.png', icon2xPath: '/assets/tray-32.png',
    templateIconPath: '/assets/trayTemplate-16.png', templateIcon2xPath: '/assets/trayTemplate-32.png',
    platform: 'win32', getSnapshot: () => ({ installedTools: [] }),
    onOpen: vi.fn(), onLaunchTool: vi.fn(), onNavigate: vi.fn(), onQuit: vi.fn(), onError: vi.fn(), onAvailabilityChange: vi.fn(),
    ...overrides,
  }
  const runtime: ApplicationTrayRuntime = {
    createImage: vi.fn(() => ({ isEmpty: () => false }) as NativeImage),
    createTray: vi.fn(() => handle),
    buildMenu: vi.fn(() => ({}) as Menu),
    ...runtimeOverrides,
  }
  const controller = createApplicationTray(options, runtime)
  return { handle, options, runtime, controller, destroyExternally: () => { destroyed = true } }
}

function click(menu: MenuItemConstructorOptions[], label: string) {
  const item = menu.find((entry) => entry.label === label)
  expect(item?.click).toBeTypeOf('function')
  ;(item!.click as () => void)()
}

describe('tray summary and native menu', () => {
  it('distinguishes an unknown balance from a real zero', () => {
    expect(trayBalanceLabel(undefined)).toBe('\u2014')
    expect(trayBalanceLabel(null)).toBe('\u2014')
    expect(trayBalanceLabel(Number.NaN)).toBe('\u2014')
    expect(trayBalanceLabel(Number.POSITIVE_INFINITY)).toBe('\u2014')
    expect(trayBalanceLabel(0)).toBe('USD 0.00')
    expect(trayBalanceLabel(-2.5)).toBe('USD -2.50')
    expect(trayBalanceLabel(1250.75)).toBe('USD 1,250.75')
  })

  it('builds its labels and enabled tools from the supplied live snapshot', () => {
    const actions = { onOpen: vi.fn(), onNavigate: vi.fn(), onLaunchTool: vi.fn(), onQuit: vi.fn() }
    const menu = buildApplicationTrayMenu({
      accountLabel: 'user@example.com', balanceUsd: 4.25,
      installedTools: [{ id: 'codex', label: 'Codex CLI' }, { id: 'claude', label: 'Claude Code', enabled: false }],
      updateAvailable: true, updateVersion: '0.2.0',
    }, actions, (action) => { void action() })
    expect(menu.map((entry) => entry.label)).toEqual(expect.arrayContaining(['user@example.com', '余额：USD 4.25', '软件更新：0.2.0']))
    const installed = menu.find((entry) => entry.label === '已安装的工具')!.submenu as MenuItemConstructorOptions[]
    expect(installed.map((entry) => [entry.label, entry.enabled])).toEqual([['Codex CLI', true], ['Claude Code', false]])
    click(installed, 'Codex CLI')
    expect(actions.onLaunchTool).toHaveBeenCalledExactlyOnceWith('codex')
    click(menu, '退出')
    expect(actions.onQuit).toHaveBeenCalledOnce()
  })

  it('has an honest empty state and no fabricated account or installed tools', () => {
    const { runtime } = fixture()
    const menu = vi.mocked(runtime.buildMenu).mock.calls[0][0]
    expect(menu.map((entry) => entry.label)).toEqual(expect.arrayContaining(['未登录', '余额：\u2014']))
    expect(menu.find((entry) => entry.label === '已安装的工具')!.submenu).toEqual([{ label: '尚未安装工具', enabled: false }])
  })

  it('shows the main window before navigating from a tray menu action', async () => {
    const order: string[] = []
    const { runtime } = fixture({ onOpen: async () => { order.push('open') }, onNavigate: (target) => { order.push(target) } })
    click(vi.mocked(runtime.buildMenu).mock.calls[0][0], '设置')
    await vi.waitFor(() => expect(order).toEqual(['open', 'settings']))
  })

  it('removes control characters and bounds external text used in native menus', () => {
    const { runtime } = fixture({ getSnapshot: () => ({ installedTools: [], accountLabel: `user\n${'x'.repeat(200)}` }) })
    const account = vi.mocked(runtime.buildMenu).mock.calls[0][0][2].label!
    expect(account).not.toContain('\n')
    expect(account.length).toBe(100)
  })
})

describe('native tray lifecycle', () => {
  it('selects real 16/32px resources and uses macOS template variants', () => {
    const windows = fixture()
    expect(windows.runtime.createImage).toHaveBeenCalledExactlyOnceWith('/assets/tray-16.png', '/assets/tray-32.png', false)
    const mac = fixture({ platform: 'darwin' })
    expect(mac.runtime.createImage).toHaveBeenCalledExactlyOnceWith('/assets/trayTemplate-16.png', '/assets/trayTemplate-32.png', true)
    expect(mac.controller.available).toBe(true)
    mac.handle.emit('click')
    expect(mac.options.onOpen).not.toHaveBeenCalled()
    mac.handle.emit('double-click')
    expect(mac.options.onOpen).toHaveBeenCalledOnce()
  })

  it('keeps a recoverable window when the native tray cannot be created', () => {
    const failure = new Error('No system tray implementation')
    const { controller, options } = fixture({}, { createTray: () => { throw failure } })
    expect(controller.available).toBe(false)
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(options.onOpen).toHaveBeenCalledOnce()
  })

  it('never advertises availability for an empty icon', () => {
    const { controller, options, runtime } = fixture({}, { createImage: () => ({ isEmpty: () => true }) as NativeImage })
    expect(controller.available).toBe(false)
    expect(runtime.createTray).not.toHaveBeenCalled()
    expect(options.onOpen).toHaveBeenCalledOnce()
    expect(options.onError).toHaveBeenCalledOnce()
  })

  it('updates both the native menu and tooltip from new confirmed data', () => {
    const { controller, runtime, handle } = fixture()
    controller.updateSnapshot({ accountLabel: 'new-user', balanceUsd: 8, installedTools: [{ id: 'gemini', label: 'Gemini CLI' }] })
    const menu = vi.mocked(runtime.buildMenu).mock.calls.at(-1)![0]
    expect(menu[2].label).toBe('new-user')
    expect(menu[3].label).toBe('余额：USD 8.00')
    expect(handle.setToolTip).toHaveBeenLastCalledWith('星芒AI管理工具\n余额：USD 8.00')
  })

  it('refreshes a menu-opening snapshot and does not leak mutable snapshot objects', () => {
    let snapshot: ApplicationTraySnapshot = { installedTools: [], balanceUsd: 1 }
    const { controller, handle } = fixture({ getSnapshot: () => snapshot })
    snapshot = { installedTools: [{ id: 'grok', label: 'Grok CLI' }], balanceUsd: 3 }
    handle.emit('right-click')
    expect(controller.getSnapshot().balanceUsd).toBe(3)
    const copy = controller.getSnapshot()
    copy.installedTools[0].label = 'changed'
    expect(controller.getSnapshot().installedTools[0].label).toBe('Grok CLI')
  })

  it('shows the window if a previously created native tray disappears', () => {
    const { controller, destroyExternally, options } = fixture()
    destroyExternally()
    expect(controller.available).toBe(false)
    expect(controller.available).toBe(false)
    expect(options.onOpen).toHaveBeenCalledOnce()
    expect(options.onAvailabilityChange).toHaveBeenLastCalledWith(false)
    expect(options.onError).toHaveBeenCalledOnce()
  })

  it('disables the tray and restores access if native menu updates fail', () => {
    const { controller, handle, options } = fixture()
    handle.setContextMenu.mockImplementationOnce(() => { throw new Error('native menu failed') })
    controller.updateSnapshot({ installedTools: [], balanceUsd: 7 })
    expect(controller.available).toBe(false)
    expect(handle.destroy).toHaveBeenCalledOnce()
    expect(options.onOpen).toHaveBeenCalledOnce()
    expect(options.onError).toHaveBeenCalledOnce()
  })

  it('reports asynchronous menu command failure without an unhandled rejection', async () => {
    const failure = new Error('tool failed to start')
    const { runtime, options } = fixture({ getSnapshot: () => ({ installedTools: [{ id: 'codex', label: 'Codex' }] }), onLaunchTool: async () => { throw failure } })
    const menu = vi.mocked(runtime.buildMenu).mock.calls[0][0]
    click(menu.find((entry) => entry.label === '已安装的工具')!.submenu as MenuItemConstructorOptions[], 'Codex')
    await vi.waitFor(() => expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure))
  })

  it('disposes native listeners and rejects stale commands without reopening during shutdown', () => {
    const { controller, handle, options, runtime } = fixture()
    const menu = vi.mocked(runtime.buildMenu).mock.calls[0][0]
    controller.dispose()
    controller.dispose()
    expect(handle.eventNames()).toEqual([])
    expect(handle.destroy).toHaveBeenCalledOnce()
    expect(controller.available).toBe(false)
    click(menu, '打开星芒AI管理工具')
    controller.updateSnapshot()
    expect(options.onOpen).not.toHaveBeenCalled()
  })
})

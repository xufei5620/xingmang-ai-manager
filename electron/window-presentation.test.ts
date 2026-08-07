import { describe, expect, it, vi } from 'vitest'
import { ipcEventChannels } from './ipc-contract'
import {
  applyWindowTheme,
  buildMacApplicationMenuTemplate,
  platformWindowOptions,
  startupFailureMessage,
} from './window-presentation'

const palette = {
  background: '#17191b',
  titleBar: '#202426',
  symbol: '#eef1f2',
}

describe('platform window presentation', () => {
  it('uses the native inset titlebar and app icon behavior on macOS', () => {
    expect(platformWindowOptions('darwin', palette, '/app/windows-icon.png')).toEqual({
      autoHideMenuBar: false,
      titleBarStyle: 'hiddenInset',
    })
  })

  it('preserves the hidden overlay and explicit icon on Windows', () => {
    expect(platformWindowOptions('win32', palette, '/app/windows-icon.png')).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#202426',
        symbolColor: '#eef1f2',
        height: 38,
      },
      icon: '/app/windows-icon.png',
    })
  })

  it('does not apply a titlebar overlay while changing the macOS window theme', () => {
    const target = {
      setBackgroundColor: vi.fn(),
      setTitleBarOverlay: vi.fn(),
    }

    applyWindowTheme(target, palette, 'darwin')

    expect(target.setBackgroundColor).toHaveBeenCalledWith('#17191b')
    expect(target.setTitleBarOverlay).not.toHaveBeenCalled()
  })
})

describe('macOS application menu', () => {
  it('contains standard App, Edit, View and Window role groups', () => {
    const template = buildMacApplicationMenuTemplate('星芒AI管理工具', vi.fn())

    expect(template.map((item) => item.label)).toEqual([
      '星芒AI管理工具',
      '编辑',
      '显示',
      '窗口',
    ])

    const roles = template.map((item) => (
      Array.isArray(item.submenu)
        ? item.submenu.flatMap((child) => child.role ? [child.role] : [])
        : []
    ))
    expect(roles[0]).toEqual(expect.arrayContaining([
      'about', 'services', 'hide', 'hideOthers', 'unhide', 'quit',
    ]))
    expect(roles[1]).toEqual(expect.arrayContaining([
      'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll',
    ]))
    expect(roles[2]).toEqual(expect.arrayContaining([
      'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen',
    ]))
    expect(roles[3]).toEqual(expect.arrayContaining(['minimize', 'zoom', 'front']))
  })

  it('routes the Settings command through the typed renderer navigation target', () => {
    const send = vi.fn()
    const template = buildMacApplicationMenuTemplate(
      '星芒AI管理工具',
      (target) => send(ipcEventChannels.onNavigate, target),
    )
    const appMenu = template[0].submenu
    const settings = Array.isArray(appMenu)
      ? appMenu.find((item) => item.label === '设置...')
      : undefined

    expect(settings?.accelerator).toBe('CmdOrCtrl+,')
    expect(settings?.click).toBeTypeOf('function')
    ;(settings?.click as (() => void))()
    expect(send).toHaveBeenCalledWith('navigation:open-page', 'settings')
  })
})

describe('startup failure presentation', () => {
  it.each([
    ['win32', '主程序初始化失败，Windows 未返回错误详情'],
    ['darwin', '主程序初始化失败，macOS 未返回错误详情'],
    ['linux', '主程序初始化失败，当前系统未返回错误详情'],
  ] as const)('names the active platform when startup fails without an error message', (platform, expected) => {
    expect(startupFailureMessage(new Error('   '), platform)).toBe(expected)
    expect(startupFailureMessage(null, platform)).toBe(expected)
  })

  it('preserves a non-empty Error message after trimming it', () => {
    expect(startupFailureMessage(new Error('  initialization failed  '), 'darwin'))
      .toBe('initialization failed')
  })
})

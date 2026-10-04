import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ipcEventChannels } from './ipc-contract'
import {
  applyWindowTheme,
  assetMenuFailureDialog,
  buildMacApplicationMenuTemplate,
  platformWindowOptions,
  rendererCrashRecoveryDetail,
  startupFailureMessage,
  windowIconFileName,
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

  it('gives Linux a PNG window icon, because nativeImage cannot decode .ico there', () => {
    expect(windowIconFileName('win32')).toBe('favicon.ico')
    expect(windowIconFileName('darwin')).toBe('favicon.ico')
    expect(windowIconFileName('linux')).toBe('app-icon.png')
    expect(platformWindowOptions('linux', palette, '/app/app-icon.png')).toMatchObject({ titleBarStyle: 'hidden', icon: '/app/app-icon.png' })
  })

  it('tells each system where to quit from after the window kept crashing', () => {
    expect(rendererCrashRecoveryDetail('win32')).toBe('可以再试一次重新加载。如果还是空白，请从任务栏右下角的星芒图标退出软件后重新打开，并在「反馈」页把问题发给我们。正在进行的安装、下载和已保存的设置都不受影响。')
    expect(rendererCrashRecoveryDetail('darwin')).toBe('可以再试一次重新加载。如果还是空白，请从屏幕顶部菜单栏的星芒图标退出软件后重新打开，并在「反馈」页把问题发给我们。正在进行的安装、下载和已保存的设置都不受影响。')
    const linux = rendererCrashRecoveryDetail('linux')
    expect(linux).not.toContain('右下角')
    expect(linux).toContain('从应用菜单重新打开')
    expect(linux).toContain('点「退出」')
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

  it('gives every role item a Chinese label so no built-in English name shows', () => {
    const template = buildMacApplicationMenuTemplate('星芒AI管理工具', vi.fn())
    const roleItems = template.flatMap((item) => (
      Array.isArray(item.submenu) ? item.submenu.filter((child) => child.role) : []
    ))

    expect(roleItems.map((item) => [item.role, item.label])).toEqual([
      ['about', '关于星芒AI管理工具'],
      ['services', '服务'],
      ['hide', '隐藏星芒AI管理工具'],
      ['hideOthers', '隐藏其他'],
      ['unhide', '全部显示'],
      ['quit', '退出星芒AI管理工具'],
      ['undo', '撤销'],
      ['redo', '重做'],
      ['cut', '剪切'],
      ['copy', '复制'],
      ['paste', '粘贴'],
      ['selectAll', '全选'],
      ['resetZoom', '实际大小'],
      ['zoomIn', '放大'],
      ['zoomOut', '缩小'],
      ['togglefullscreen', '切换全屏'],
      ['minimize', '最小化'],
      ['zoom', '缩放'],
      ['front', '前置全部窗口'],
    ])
    for (const item of roleItems) expect(item.accelerator).toBeUndefined()
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

describe('asset menu failure presentation', () => {
  it('does not put an English file error carrying the user name in the dialog', () => {
    // 图片被挪走、删掉以后再点「复制图片」「图片另存为」「在文件夹中显示」，open 抛的就是这句。
    const missing = Object.assign(
      new Error("ENOENT: no such file or directory, open 'C:\\Users\\张三\\Documents\\星芒AI\\output\\user-7\\2026-10-04\\xingmang-1.png'"),
      { code: 'ENOENT' },
    )
    expect(assetMenuFailureDialog('image', missing)).toEqual({ title: '图片操作失败', message: '无法完成图片操作' })
    expect(assetMenuFailureDialog('video', new Error("EBUSY: resource busy or locked, open '/Users/张三/Documents/星芒AI/output/user-7/2026-10-04/xingmang-1.mp4'")))
      .toEqual({ title: '视频操作失败', message: '无法完成视频操作' })
    expect(assetMenuFailureDialog('audio', new Error("EPERM: operation not permitted, open 'C:\\Users\\alice\\Documents\\xingmang-1.mp3'")))
      .toEqual({ title: '音频操作失败', message: '无法完成音频操作' })
  })

  it('keeps the Chinese sentences the main process writes itself', () => {
    for (const message of [
      '账号已切换，请重新打开图片菜单',
      '星芒账号已切换，已停止图片操作',
      '图片另存失败，请检查目标目录写入权限',
      'AI 图片资产文件在读取前发生变化',
    ]) {
      expect(assetMenuFailureDialog('image', new Error(message))).toEqual({ title: '图片操作失败', message })
    }
    expect(assetMenuFailureDialog('video', new Error('AI 视频资产不存在或无权访问')).message).toBe('AI 视频资产不存在或无权访问')
    expect(assetMenuFailureDialog('audio', new Error('音频另存失败，请检查目标目录写入权限')).message).toBe('音频另存失败，请检查目标目录写入权限')
  })

  it('falls back when the failure is not an Error or says nothing', () => {
    expect(assetMenuFailureDialog('image', new Error('   ')).message).toBe('无法完成图片操作')
    expect(assetMenuFailureDialog('video', '无法读取')).toEqual({ title: '视频操作失败', message: '无法完成视频操作' })
    expect(assetMenuFailureDialog('audio', null)).toEqual({ title: '音频操作失败', message: '无法完成音频操作' })
  })

  it('is how main.ts fills every image, video and audio menu error box', () => {
    // 接线一断（哪个菜单又把 error.message 直接塞进错误框），英文原话和用户名就又上屏了。
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
    for (const source of ['ai-chat', 'canvas']) {
      for (const mediaType of ['image', 'video', 'audio']) {
        expect(main).toContain(`item.run().catch((error) => showAssetMenuFailure('${source}', '${mediaType}', item.id, error))`)
      }
    }
    expect(main).not.toMatch(/showErrorBox\([^)]*error\.message/)
  })
})

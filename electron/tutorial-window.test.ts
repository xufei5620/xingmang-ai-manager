import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
}))

import { tutorialDocumentUrl } from './relay-sites'
import {
  createTutorialWindowController,
  isAllowedTutorialNavigationUrl,
  safeTutorialDownloadFilename,
} from './tutorial-window'

interface HarnessOptions {
  loadError?: Error
}

function createHarness(options: HarnessOptions = {}) {
  const windowEvents = new Map<string, (...args: any[]) => void>()
  const webContentsEvents = new Map<string, (...args: any[]) => void>()
  const sessionEvents = new Map<string, (...args: any[]) => void>()
  let destroyed = false
  let minimized = false

  const session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn((name: string, handler: (...args: any[]) => void) => sessionEvents.set(name, handler)),
  }
  const webContents = {
    session,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((name: string, handler: (...args: any[]) => void) => webContentsEvents.set(name, handler)),
  }
  const window = {
    webContents,
    once: vi.fn((name: string, handler: (...args: any[]) => void) => windowEvents.set(name, handler)),
    on: vi.fn((name: string, handler: (...args: any[]) => void) => windowEvents.set(name, handler)),
    loadURL: vi.fn(async () => {
      if (options.loadError) throw options.loadError
      windowEvents.get('ready-to-show')?.()
    }),
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(() => { minimized = false }),
    center: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => {
      destroyed = true
      windowEvents.get('closed')?.()
    }),
    destroy: vi.fn(() => { destroyed = true }),
    setTitle: vi.fn(),
  }
  const createWindow = vi.fn(() => window as never)
  const runtimeLog = { log: vi.fn(), exception: vi.fn() }
  const controller = createTutorialWindowController({
    runtimeLog: runtimeLog as never,
    createWindow,
  })

  return {
    controller,
    createWindow,
    runtimeLog,
    session,
    sessionEvents,
    webContents,
    webContentsEvents,
    window,
    windowEvents,
    setMinimized(value: boolean) { minimized = value },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tutorial navigation policy', () => {
  it('allows only the Feishu document and account hosts over credential-free HTTPS', () => {
    expect(isAllowedTutorialNavigationUrl(tutorialDocumentUrl)).toBe(true)
    expect(isAllowedTutorialNavigationUrl('https://s4621e8xzb.feishu.cn/wiki/another')).toBe(true)
    expect(isAllowedTutorialNavigationUrl('https://accounts.feishu.cn/accounts/page/login')).toBe(true)
    expect(isAllowedTutorialNavigationUrl('http://s4621e8xzb.feishu.cn/wiki/another')).toBe(false)
    expect(isAllowedTutorialNavigationUrl('https://user@s4621e8xzb.feishu.cn/wiki/another')).toBe(false)
    expect(isAllowedTutorialNavigationUrl('https://s4621e8xzb.feishu.cn.evil.example/wiki/another')).toBe(false)
    expect(isAllowedTutorialNavigationUrl('javascript:alert(1)')).toBe(false)
  })

  it('normalizes attachment names without changing normal installer filenames', () => {
    expect(safeTutorialDownloadFilename('XingMang-AI-Manager-0.1.4-Setup.exe')).toBe(
      'XingMang-AI-Manager-0.1.4-Setup.exe',
    )
    expect(safeTutorialDownloadFilename('..\\..\\evil?.exe')).toBe('evil_.exe')
    expect(safeTutorialDownloadFilename('CON.exe')).toBe('_CON.exe')
    expect(safeTutorialDownloadFilename('...')).toBe('教程附件')
  })
})

describe('createTutorialWindowController', () => {
  it('opens the canonical document in a sandboxed, isolated window', async () => {
    const harness = createHarness()
    const parent = {} as never

    await harness.controller.open(parent)

    expect(harness.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      parent,
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      show: false,
      title: '教程文档 - 星芒AI管理工具',
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        partition: 'xingmang-tutorial-docs',
      }),
    }))
    expect(harness.window.loadURL).toHaveBeenCalledWith(tutorialDocumentUrl)
    expect(harness.window.center).toHaveBeenCalledOnce()
    expect(harness.window.show).toHaveBeenCalledOnce()
    expect(harness.window.focus).toHaveBeenCalledOnce()
  })

  it('reuses and focuses the existing document window', async () => {
    const harness = createHarness()
    await harness.controller.open()
    harness.setMinimized(true)

    await harness.controller.open()

    expect(harness.createWindow).toHaveBeenCalledOnce()
    expect(harness.window.restore).toHaveBeenCalledOnce()
    expect(harness.window.show).toHaveBeenCalledTimes(2)
    expect(harness.window.focus).toHaveBeenCalledTimes(2)
  })

  it('denies popups and blocks navigation outside the two Feishu hosts', async () => {
    const harness = createHarness()
    await harness.controller.open()

    const popupHandler = harness.webContents.setWindowOpenHandler.mock.calls[0]?.[0]
    expect(popupHandler({ url: 'https://attacker.example/' })).toEqual({ action: 'deny' })

    const navigationHandler = harness.webContentsEvents.get('will-navigate')!
    const allowedEvent = { preventDefault: vi.fn() }
    navigationHandler(allowedEvent, 'https://s4621e8xzb.feishu.cn/wiki/next')
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()

    const blockedEvent = { preventDefault: vi.fn() }
    navigationHandler(blockedEvent, 'https://attacker.example/')
    expect(blockedEvent.preventDefault).toHaveBeenCalledOnce()
  })

  it('denies permissions and device access in the remote document session', async () => {
    const harness = createHarness()
    await harness.controller.open()

    const permissionCallback = vi.fn()
    harness.session.setPermissionRequestHandler.mock.calls[0]?.[0]({}, 'notifications', permissionCallback)
    expect(permissionCallback).toHaveBeenCalledWith(false)
    expect(harness.session.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false)
    expect(harness.session.setDevicePermissionHandler.mock.calls[0]?.[0]()).toBe(false)
  })

  it('blocks background downloads but gives user-triggered attachments a native save dialog', async () => {
    const harness = createHarness()
    await harness.controller.open()
    const downloadHandler = harness.sessionEvents.get('will-download')!

    const blockedEvent = { preventDefault: vi.fn() }
    const blockedItem = {
      hasUserGesture: vi.fn(() => false),
      getFilename: vi.fn(() => 'background.exe'),
      setSaveDialogOptions: vi.fn(),
      once: vi.fn(),
    }
    downloadHandler(blockedEvent, blockedItem, harness.webContents)
    expect(blockedEvent.preventDefault).toHaveBeenCalledOnce()
    expect(blockedItem.setSaveDialogOptions).not.toHaveBeenCalled()

    const allowedEvent = { preventDefault: vi.fn() }
    const allowedItem = {
      hasUserGesture: vi.fn(() => true),
      getFilename: vi.fn(() => '..\\XingMang-AI-Manager-0.1.4-Setup.exe'),
      setSaveDialogOptions: vi.fn(),
      once: vi.fn(),
    }
    downloadHandler(allowedEvent, allowedItem, harness.webContents)
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()
    expect(allowedItem.setSaveDialogOptions).toHaveBeenCalledWith({
      title: '保存教程附件',
      defaultPath: 'XingMang-AI-Manager-0.1.4-Setup.exe',
      buttonLabel: '保存',
      properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
    })

    const doneHandler = allowedItem.once.mock.calls[0]?.[1]
    doneHandler({}, 'completed')
    expect(harness.runtimeLog.log).toHaveBeenCalledWith(
      'info',
      'tutorial',
      'download.completed',
      '教程附件下载完成',
      { filename: 'XingMang-AI-Manager-0.1.4-Setup.exe' },
    )
  })

  it('destroys a failed window and reports a stable user-facing error', async () => {
    const harness = createHarness({ loadError: new Error('network down') })

    await expect(harness.controller.open()).rejects.toThrow('教程文档加载失败，请检查网络后重试')
    expect(harness.window.destroy).toHaveBeenCalledOnce()
    expect(harness.runtimeLog.exception).toHaveBeenCalledWith(
      'tutorial',
      'window.open.failed',
      expect.any(Error),
    )
  })

  it('closes the document with the main window and can create a fresh one afterwards', async () => {
    const harness = createHarness()
    await harness.controller.open()

    harness.controller.closeIfOpen()

    expect(harness.window.close).toHaveBeenCalledOnce()
    harness.controller.dispose()
    expect(harness.window.close).toHaveBeenCalledOnce()
  })
})

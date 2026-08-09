import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewApiClientService } from './new-api-client'
import type { SystemService } from './system-service'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  browserWindowFromWebContents: vi.fn(() => undefined),
  registerFileProtocol: vi.fn(),
  notificationShow: vi.fn(),
  notificationSupported: vi.fn(() => true),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents: electronMocks.browserWindowFromWebContents }),
  dialog: {
    showSaveDialog: electronMocks.showSaveDialog,
    showOpenDialog: electronMocks.showOpenDialog,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler)
    },
    on: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.onHandlers.set(channel, handler)
    },
    removeHandler: electronMocks.removeHandler,
    removeAllListeners: electronMocks.removeAllListeners,
  },
  Notification: class {
    static isSupported() {
      return electronMocks.notificationSupported()
    }
    constructor(public options: unknown) {}
    show() {
      electronMocks.notificationShow(this.options)
    }
  },
  protocol: { registerFileProtocol: electronMocks.registerFileProtocol },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}))

import {
  canvasHostAuthTokenChannel,
  canvasHostNotifyChannel,
  canvasHostOpenExternalChannel,
  canvasHostPickFileChannel,
  canvasHostSaveFileChannel,
  createCanvasWindowController,
  type CanvasWindowControllerOptions,
} from './canvas-window'

const trustedCanvasUrl = 'xingmang-canvas://app/index.html'
const allowlist = ['https://docs.canvas.best', 'https://github.com/basketikun/infinite-canvas']

function trustedEvent(url = trustedCanvasUrl) {
  return {
    senderFrame: { url },
    sender: { getURL: () => url, isDestroyed: () => false, send: vi.fn() },
  }
}

function syncEvent(url = trustedCanvasUrl) {
  return {
    senderFrame: { url },
    sender: { getURL: () => url, isDestroyed: () => false, send: vi.fn() },
    returnValue: undefined as unknown,
  }
}

function controllerOptions(
  overrides: Partial<CanvasWindowControllerOptions> = {},
): CanvasWindowControllerOptions {
  return {
    canvasDistRoot: 'C:\\app\\dist-canvas',
    externalUrlAllowlist: allowlist,
    systemService: { revealApiKey: vi.fn(() => '') } as unknown as SystemService,
    accountService: {
      getSessionState: vi.fn(() => ({ authenticated: false, account: null })),
      provisionCliKey: vi.fn(),
    } as unknown as NewApiClientService,
    previewOnboarding: false,
    runtimeLog: { log: vi.fn(), exception: vi.fn() } as never,
    externalShell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) },
    ...overrides,
  }
}

beforeEach(() => {
  electronMocks.handlers.clear()
  electronMocks.onHandlers.clear()
  electronMocks.removeHandler.mockClear()
  electronMocks.removeAllListeners.mockClear()
  electronMocks.showSaveDialog.mockClear()
  electronMocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
  electronMocks.showOpenDialog.mockClear()
  electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  electronMocks.registerFileProtocol.mockClear()
  electronMocks.notificationShow.mockClear()
  electronMocks.notificationSupported.mockReset()
  electronMocks.notificationSupported.mockReturnValue(true)
})

describe('createCanvasWindowController', () => {
  it('registers exactly the five documented canvas-host channels -- the entire bridge surface', () => {
    createCanvasWindowController(controllerOptions())

    expect([...electronMocks.handlers.keys()].sort()).toEqual([
      canvasHostNotifyChannel,
      canvasHostOpenExternalChannel,
      canvasHostPickFileChannel,
      canvasHostSaveFileChannel,
    ].sort())
    expect([...electronMocks.onHandlers.keys()]).toEqual([canvasHostAuthTokenChannel])
  })

  it('registers the xingmang-canvas:// protocol handler exactly once', () => {
    createCanvasWindowController(controllerOptions())

    expect(electronMocks.registerFileProtocol).toHaveBeenCalledTimes(1)
    expect(electronMocks.registerFileProtocol).toHaveBeenCalledWith('xingmang-canvas', expect.any(Function))
  })

  it('rejects an invoke handler call from any sender outside the canvas window origin', async () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostOpenExternalChannel)!

    expect(() => handler(trustedEvent('https://attacker.example/'), 'https://docs.canvas.best')).toThrow(
      '已拒绝来自非画布页面的操作请求',
    )
    expect(() => handler(trustedEvent('xingmang://app/index.html'), 'https://docs.canvas.best')).toThrow(
      '已拒绝来自非画布页面的操作请求',
    )
  })

  it('opens an allowlisted external URL via the injected shell launcher, never electron shell directly', async () => {
    const externalShell = { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }
    createCanvasWindowController(controllerOptions({ externalShell }))
    const handler = electronMocks.handlers.get(canvasHostOpenExternalChannel)!

    await expect(handler(trustedEvent(), 'https://docs.canvas.best')).resolves.toBe(true)
    expect(externalShell.openExternal).toHaveBeenCalledWith('https://docs.canvas.best')
  })

  it('rejects a URL that is not an exact allowlist match (I12) -- subdomain and path confusion both fail', async () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostOpenExternalChannel)!

    await expect(handler(trustedEvent(), 'https://docs.canvas.best.evil.example')).rejects.toThrow(
      '不允许打开该链接',
    )
    await expect(handler(trustedEvent(), 'https://github.com/basketikun/infinite-canvas/extra-path')).rejects.toThrow(
      '不允许打开该链接',
    )
    await expect(handler(trustedEvent(), 'http://docs.canvas.best')).rejects.toThrow('不允许打开该链接')
    await expect(handler(trustedEvent(), 42)).rejects.toThrow('不允许打开该链接')
  })

  it('validates notify input before ever constructing a Notification', () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    // The handler itself is synchronous (mirrors ipc.ts's own sync
    // validate-then-throw handlers, e.g. window:set-mode) -- real
    // ipcMain.handle wraps a synchronous throw into a rejected invoke()
    // promise for the renderer, but calling the captured handler directly
    // here (bypassing that wrapping, the same way ipc.test.ts does for its
    // own sync handlers) surfaces it as a plain synchronous throw.
    expect(() => handler(trustedEvent(), '', 'body')).toThrow('通知标题格式错误')
    expect(electronMocks.notificationShow).not.toHaveBeenCalled()
  })

  it('shows a native notification with title/body, defaulting an omitted body to empty', () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    expect(handler(trustedEvent(), '生成完成', undefined)).toBe(true)
    expect(electronMocks.notificationShow).toHaveBeenCalledWith({ title: '生成完成', body: '' })
  })

  it('returns false without throwing when Notification is unsupported on this platform', () => {
    electronMocks.notificationSupported.mockReturnValue(false)
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    expect(handler(trustedEvent(), '生成完成', 'body')).toBe(false)
    expect(electronMocks.notificationShow).not.toHaveBeenCalled()
  })

  it('returns null (not an error) when the save/pick dialog is canceled', async () => {
    createCanvasWindowController(controllerOptions())
    const saveHandler = electronMocks.handlers.get(canvasHostSaveFileChannel)!
    const pickHandler = electronMocks.handlers.get(canvasHostPickFileChannel)!

    await expect(saveHandler(trustedEvent(), 'export.json', '{}')).resolves.toBeNull()
    await expect(pickHandler(trustedEvent())).resolves.toBeNull()
  })

  it('rejects oversized or non-string saveFile input before ever opening a dialog', async () => {
    createCanvasWindowController(controllerOptions())
    const handler = electronMocks.handlers.get(canvasHostSaveFileChannel)!

    await expect(handler(trustedEvent(), 'export.json', 12345)).rejects.toThrow('保存内容格式错误')
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()
  })

  describe('canvas-host:auth-token (synchronous)', () => {
    it('returns a null token and does not write storage for an untrusted sender', () => {
      createCanvasWindowController(controllerOptions())
      const handler = electronMocks.onHandlers.get(canvasHostAuthTokenChannel)!

      const event = syncEvent('https://attacker.example/')
      handler(event, null)

      expect(event.returnValue).toEqual({ token: null, storageValue: null })
    })

    it('returns a null token for a trusted sender when the account is logged out (zero network calls)', () => {
      const accountService = {
        getSessionState: vi.fn(() => ({ authenticated: false, account: null })),
        provisionCliKey: vi.fn(),
      } as unknown as NewApiClientService
      createCanvasWindowController(controllerOptions({ accountService }))
      const handler = electronMocks.onHandlers.get(canvasHostAuthTokenChannel)!

      // No canvas window has been opened (open() was never called), so no
      // entry exists in the controller's token map for this event.sender --
      // this also exercises the "no entry found" branch, which must degrade
      // to null rather than throw.
      const event = syncEvent()
      handler(event, null)

      expect(event.returnValue).toEqual({ token: null, storageValue: null })
      expect(accountService.provisionCliKey).not.toHaveBeenCalled()
    })
  })

  it('dispose() removes every handle channel and the sync listener', () => {
    const controller = createCanvasWindowController(controllerOptions())

    controller.dispose()

    for (const channel of [
      canvasHostSaveFileChannel,
      canvasHostPickFileChannel,
      canvasHostNotifyChannel,
      canvasHostOpenExternalChannel,
    ]) {
      expect(electronMocks.removeHandler).toHaveBeenCalledWith(channel)
    }
    expect(electronMocks.removeAllListeners).toHaveBeenCalledWith(canvasHostAuthTokenChannel)
  })
})

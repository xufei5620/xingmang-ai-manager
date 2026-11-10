import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SaveDialogOptions } from 'electron'
import type { NewApiClientService } from './new-api-client'
import type { SystemService } from './system-service'
import type { CanvasProjectWorkspaceStatus } from './canvas-project-store'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(async () => ({ canceled: true, filePaths: [] })),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>>(async () => ({ response: 1, checkboxChecked: false })),
  browserWindowFromWebContents: vi.fn(() => undefined),
  registerFileProtocol: vi.fn(),
  notificationShow: vi.fn(),
  notificationSupported: vi.fn(() => true),
  browserWindowOptions: [] as unknown[],
  latestBrowserWindow: null as null | Record<string, unknown>,
  latestWebContents: null as null | Record<string, unknown>,
  // The canvas window uses the default session, which the main window shares.
  sessionListeners: new Map<string, Set<(...args: unknown[]) => void>>(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: Object.assign(vi.fn(function BrowserWindowMock(options: unknown) {
    electronMocks.browserWindowOptions.push(options)
    const mainFrame = { url: 'xingmang-canvas://app/index.html' }
    const webContents = {
      id: 41,
      mainFrame,
      getURL: () => mainFrame.url,
      isDestroyed: () => false,
      isCrashed: vi.fn(() => false),
      send: vi.fn(),
      executeJavaScript: vi.fn(async () => true),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: {
        on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
          const listeners = electronMocks.sessionListeners.get(name) ?? new Set()
          listeners.add(listener)
          electronMocks.sessionListeners.set(name, listeners)
        }),
        removeListener: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
          electronMocks.sessionListeners.get(name)?.delete(listener)
        }),
      },
    }
    electronMocks.latestWebContents = webContents
    const events = new Map<string, (...args: unknown[]) => void>()
    let destroyed = false
    const browserWindow = {
      webContents,
      once: vi.fn(),
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => events.set(name, listener)),
      loadURL: vi.fn(async () => undefined),
      setBackgroundColor: vi.fn(),
      center: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
      isMinimized: vi.fn(() => false),
      close: vi.fn(() => {
        const event = { preventDefault: vi.fn() }
        events.get('close')?.(event)
        if (event.preventDefault.mock.calls.length) return
        destroyed = true
        events.get('closed')?.()
      }),
      destroy: vi.fn(() => { destroyed = true; events.get('closed')?.() }),
    }
    electronMocks.latestBrowserWindow = browserWindow
    return browserWindow
  }), { fromWebContents: electronMocks.browserWindowFromWebContents }),
  dialog: {
    showSaveDialog: electronMocks.showSaveDialog,
    showOpenDialog: electronMocks.showOpenDialog,
    showMessageBox: electronMocks.showMessageBox,
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

import { buildCanvasProjectPackage } from './canvas-project-package'
import { canvasHostChannels } from './canvas-contract'
import {
  canvasHostCancelRequestChannel,
  canvasHostCopyAssetChannel,
  canvasHostCreateProjectChannel,
  canvasHostCreateProjectInDefaultFolderChannel,
  canvasHostCreatePromptPresetChannel,
  canvasHostDeletePromptPresetChannel,
  canvasHostDuplicateProjectChannel,
  canvasHostEditImageChannel,
  canvasHostGenerateImageChannel,
  canvasHostGenerateVideoChannel,
  canvasHostResumeVideoTaskChannel,
  canvasHostListGroupsChannel,
  canvasHostListAssetsChannel,
  canvasHostListProjectsChannel,
  canvasHostMarkAssetUsedChannel,
  canvasHostListPromptPresetsChannel,
  canvasHostPickAssetChannel,
  canvasHostImportAssetFileChannel,
  canvasHostImportAssetBytesChannel,
  canvasHostCompleteRunPreparationChannel,
  canvasHostInspectAssetReferencesChannel,
  canvasHostStartRunChannel,
  canvasHostCancelRunChannel,
  canvasHostExportProjectChannel,
  canvasHostImportProjectChannel,
  canvasHostListRunsChannel,
  canvasHostNotifyChannel,
  canvasHostOpenExternalChannel,
  canvasHostOpenProjectChannel,
  canvasHostPickFileChannel,
  canvasHostPrepareGroupChannel,
  canvasHostPreviewProjectChannel,
  canvasHostRenameAssetChannel,
  canvasHostUpdateAssetMetadataChannel,
  canvasHostDeleteAssetChannel,
  canvasHostRestoreAssetChannel,
  canvasHostPurgeAssetChannel,
  canvasHostRelinkProjectFolderChannel,
  canvasHostDeleteProjectChannel,
  canvasHostGetAccountSummaryChannel,
  canvasHostGetPriceSnapshotChannel,
  canvasHostRenameProjectChannel,
  canvasHostRunEventChannel,
  canvasHostAccountChangedChannel,
  canvasHostSaveFileChannel,
  canvasHostSaveAssetChannel,
  canvasHostSaveProjectChannel,
  canvasHostSetProjectArchivedChannel,
  canvasHostShowAssetMenuChannel,
  canvasHostThemeChangedChannel,
  canvasHostUpdatePromptPresetChannel,
  canvasWindowBackgroundColor,
  canvasWindowLightBackgroundColor,
  canvasRendererAnswers,
  canvasProjectDeleteDetail,
  canvasProjectFolderToTrash,
  createCanvasWindowController,
  importedCanvasProjectName,
  type CanvasWindowControllerOptions,
} from './canvas-window'

const trustedCanvasUrl = 'xingmang-canvas://app/index.html'
const allowlist = ['https://docs.canvas.best', 'https://github.com/basketikun/infinite-canvas']
const temporaryDirectories: string[] = []
const projectPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-window-'))
  temporaryDirectories.push(directory)
  return directory
}

function temporaryCanvasDistDirectory(): string {
  const directory = temporaryDirectory()
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>canvas fixture</title>', 'utf8')
  return directory
}

function projectWorkflow(assetIds: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 2,
    name: '可移植项目',
    nodes: assetIds.map((assetId, index) => ({
      id: `image-${index}`,
      kind: 'image-input',
      definitionVersion: 1,
      position: { x: index * 300, y: 0 },
      data: {
        prompt: '', model: '',
        result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' },
      },
    })),
    edges: [],
  })
}

/** The dialog is opened with or without a parent window, so read the last argument. */
function lastSaveDialogPath(): string | undefined {
  const call = electronMocks.showSaveDialog.mock.calls.at(-1)
  return (call?.at(-1) as SaveDialogOptions | undefined)?.defaultPath
}

function trustedEvent(url = trustedCanvasUrl) {
  const sender = electronMocks.latestWebContents!
  const senderFrame = url === trustedCanvasUrl
    ? sender.mainFrame
    : { url }
  return {
    senderFrame,
    sender,
  }
}

function foreignEvent(url = trustedCanvasUrl) {
  const mainFrame = { url }
  return {
    senderFrame: mainFrame,
    sender: { id: 99, mainFrame, getURL: () => url, isDestroyed: () => false, send: vi.fn() },
  }
}

function controllerOptions(
  overrides: Partial<CanvasWindowControllerOptions> = {},
): CanvasWindowControllerOptions {
  return {
    canvasDistRoot: temporaryCanvasDistDirectory(),
    externalUrlAllowlist: allowlist,
    systemService: {
      readStoredConfig: vi.fn(() => ({ theme: 'dark' })),
      revealApiKey: vi.fn(() => ''),
    } as unknown as SystemService,
    accountService: {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 7 } })),
      provisionCliKey: vi.fn(),
    } as unknown as NewApiClientService,
    previewOnboarding: false,
    runtimeLog: { log: vi.fn(), exception: vi.fn() } as never,
    chatCredentials: {
      listGroups: vi.fn(async () => []),
      prepareGroup: vi.fn(async (group: string) => ({ group, models: [], keyCreated: false })),
      resolveCredential: vi.fn(),
    },
    imageService: {
      generate: vi.fn(async () => []),
      edit: vi.fn(async () => []),
      cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
      cancelSender: vi.fn(() => 0),
    } as never,
    videoService: {
      generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
      cancelSender: vi.fn(() => 0), cancelUser: vi.fn(() => 0), resumeUser: vi.fn(async () => []),
      resumeVideoTask: vi.fn(),
    } as never,
    aiAssets: {
      copy: vi.fn(async () => undefined),
      saveAs: vi.fn(async () => false),
      contextMenu: vi.fn(async () => undefined),
      listOwned: vi.fn(async () => []),
      listOwnedPage: vi.fn(async () => ({ items: [], offset: 0, limit: 24, total: 0, hasMore: false })),
      readOwned: vi.fn(),
      storeBase64: vi.fn(),
      removeOwned: vi.fn(async () => undefined),
    } as never,
    mediaAssets: {
      listOwnedPage: vi.fn(async () => ({ items: [], offset: 0, limit: 24, total: 0, hasMore: false })),
      copy: vi.fn(async () => undefined), saveAs: vi.fn(async () => false), contextMenu: vi.fn(async () => undefined),
      rename: vi.fn(),
      updateMetadata: vi.fn(), markUsed: vi.fn(), setSource: vi.fn(async () => undefined),
    } as never,
    promptPresets: {
      list: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as never,
    canvasRuns: {
      start: vi.fn(() => ({ runId: 'run-1', graphRevision: 'revision', promise: Promise.resolve({}), cancel: vi.fn() })),
      cancel: vi.fn(() => false),
      cancelOwner: vi.fn(() => 0),
      listRuns: vi.fn(async () => []),
      getAssetLineage: vi.fn(async () => ({})),
      subscribe: vi.fn((_listener: unknown) => () => undefined),
    } as never,
    externalShell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) },
    // The real probe starts a hidden renderer, which the BrowserWindow mock cannot
    // stand in for; linux-renderer-sandbox.test.ts covers its verdicts.
    inspectRendererSandbox: async () => ({ kind: 'sandboxed' }),
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
  electronMocks.showMessageBox.mockClear()
  electronMocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
  electronMocks.registerFileProtocol.mockClear()
  electronMocks.notificationShow.mockClear()
  electronMocks.notificationSupported.mockReset()
  electronMocks.notificationSupported.mockReturnValue(true)
  electronMocks.browserWindowOptions.length = 0
  electronMocks.latestBrowserWindow = null
  electronMocks.latestWebContents = null
  electronMocks.sessionListeners.clear()
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('createCanvasWindowController', () => {
  it('keeps every sandbox preload channel literal aligned with the main-process contract', () => {
    const preloadSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'canvas-preload.ts'), 'utf8')
    const preloadChannels = [...preloadSource.matchAll(/['"](canvas-host:[^'"]+)['"]/g)]
      .map((match) => match[1])
    expect([...new Set(preloadChannels)].sort()).toEqual([...Object.values(canvasHostChannels)].sort())
  })

  it('registers exactly the documented canvas-host invoke channels with no token channel', () => {
    createCanvasWindowController(controllerOptions())

    expect([...electronMocks.handlers.keys()].sort()).toEqual([
      canvasHostChannels.finishClose,
      canvasHostChannels.cancelCloseTasks,
      canvasHostCancelRequestChannel,
      canvasHostCopyAssetChannel,
      canvasHostCreateProjectChannel,
      canvasHostCreateProjectInDefaultFolderChannel,
      canvasHostCreatePromptPresetChannel,
      canvasHostDeletePromptPresetChannel,
      canvasHostDuplicateProjectChannel,
      canvasHostEditImageChannel,
      canvasHostGenerateImageChannel,
      canvasHostGenerateVideoChannel,
      canvasHostResumeVideoTaskChannel,
      canvasHostListAssetsChannel,
      canvasHostMarkAssetUsedChannel,
      canvasHostListProjectsChannel,
      canvasHostListPromptPresetsChannel,
      canvasHostPickAssetChannel,
      canvasHostImportAssetFileChannel,
      canvasHostImportAssetBytesChannel,
      canvasHostCompleteRunPreparationChannel,
      canvasHostInspectAssetReferencesChannel,
      canvasHostStartRunChannel,
      canvasHostCancelRunChannel,
      canvasHostExportProjectChannel,
      canvasHostImportProjectChannel,
      canvasHostListRunsChannel,
      canvasHostListGroupsChannel,
      canvasHostNotifyChannel,
      canvasHostOpenExternalChannel,
      canvasHostOpenProjectChannel,
      canvasHostPickFileChannel,
      canvasHostPrepareGroupChannel,
      canvasHostPreviewProjectChannel,
      canvasHostRenameAssetChannel,
      canvasHostUpdateAssetMetadataChannel,
      canvasHostDeleteAssetChannel,
      canvasHostRestoreAssetChannel,
      canvasHostPurgeAssetChannel,
      canvasHostRelinkProjectFolderChannel,
      canvasHostDeleteProjectChannel,
      canvasHostGetAccountSummaryChannel,
      canvasHostGetPriceSnapshotChannel,
      canvasHostRenameProjectChannel,
      canvasHostSaveAssetChannel,
      canvasHostSaveProjectChannel,
      canvasHostSetProjectArchivedChannel,
      canvasHostSaveFileChannel,
      canvasHostShowAssetMenuChannel,
      canvasHostUpdatePromptPresetChannel,
    ].sort())
    expect([...electronMocks.onHandlers.keys()]).toEqual([])
  })

  it('registers the xingmang-canvas:// protocol handler exactly once', () => {
    createCanvasWindowController(controllerOptions())

    expect(electronMocks.registerFileProtocol).toHaveBeenCalledTimes(1)
    expect(electronMocks.registerFileProtocol).toHaveBeenCalledWith('xingmang-canvas', expect.any(Function))
  })

  it('defines the dark canvas color used before the renderer becomes visible', () => {
    expect(canvasWindowBackgroundColor).toBe('#0b0c10')
  })

  it('opens with the stored dark theme in both the native background and renderer URL', async () => {
    const controller = createCanvasWindowController(controllerOptions())

    await controller.open()

    expect(electronMocks.browserWindowOptions).toEqual([
      expect.objectContaining({ backgroundColor: canvasWindowBackgroundColor, icon: path.join(process.cwd(), 'assets', 'brand', 'v3', 'app-icon.png') }),
    ])
    expect(electronMocks.latestBrowserWindow?.loadURL).toHaveBeenCalledWith(
      'xingmang-canvas://app/?theme=dark',
    )
  })

  it('refuses to create the canvas window when the renderer sandbox is off', async () => {
    const runtimeLog = { log: vi.fn(), exception: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({
      runtimeLog: runtimeLog as never,
      inspectRendererSandbox: async () => ({ kind: 'disabled', reason: 'no-sandbox' }),
    }))

    await expect(controller.open()).rejects.toThrow('这层保护被关掉了')

    expect(electronMocks.browserWindowOptions).toEqual([])
    expect(runtimeLog.log).toHaveBeenCalledWith('error', 'canvas', 'sandbox.refused', expect.any(String), {
      verdict: 'disabled',
      reason: 'no-sandbox',
    })
  })

  it('asks the sandbox gate again on the next open after a refusal', async () => {
    const inspectRendererSandbox = vi.fn()
      .mockResolvedValueOnce({ kind: 'unverified', reason: 'renderer status unreadable' })
      .mockResolvedValue({ kind: 'sandboxed' })
    const controller = createCanvasWindowController(controllerOptions({ inspectRendererSandbox }))

    await expect(controller.open()).rejects.toThrow('没能确认画布的安全保护')
    await controller.open()

    expect(inspectRendererSandbox).toHaveBeenCalledTimes(2)
    expect(electronMocks.browserWindowOptions).toEqual([
      expect.objectContaining({ webPreferences: expect.objectContaining({ sandbox: true, contextIsolation: true, nodeIntegration: false }) }),
    ])
  })

  it('opens with the stored light theme in both the native background and renderer URL', async () => {
    const systemService = {
      readStoredConfig: vi.fn(() => ({ theme: 'light' })),
      revealApiKey: vi.fn(() => ''),
    } as unknown as SystemService
    const controller = createCanvasWindowController(controllerOptions({ systemService }))

    await controller.open()

    expect(electronMocks.browserWindowOptions).toEqual([
      expect.objectContaining({ backgroundColor: canvasWindowLightBackgroundColor }),
    ])
    expect(electronMocks.latestBrowserWindow?.loadURL).toHaveBeenCalledWith(
      'xingmang-canvas://app/?theme=light',
    )
  })

  it('updates the native canvas background and notifies its renderer when the theme changes', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const send = electronMocks.latestWebContents!.send as ReturnType<typeof vi.fn>

    controller.setTheme('light')

    expect(electronMocks.latestBrowserWindow?.setBackgroundColor).toHaveBeenCalledWith(
      canvasWindowLightBackgroundColor,
    )
    expect(send).toHaveBeenCalledWith(canvasHostThemeChangedChannel, 'light')
  })

  it('rejects calls outside the current canvas main frame', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostOpenExternalChannel)!

    expect(() => handler(trustedEvent('https://attacker.example/'), 'https://docs.canvas.best')).toThrow(
      '已拒绝来自非画布页面的操作请求',
    )
    expect(() => handler(trustedEvent('xingmang://app/index.html'), 'https://docs.canvas.best')).toThrow(
      '已拒绝来自非画布页面的操作请求',
    )
    expect(() => handler(foreignEvent(), 'https://docs.canvas.best')).toThrow(
      '已拒绝来自非画布页面的操作请求',
    )
  })

  it('opens an allowlisted external URL via the injected shell launcher, never electron shell directly', async () => {
    const externalShell = { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }
    const controller = createCanvasWindowController(controllerOptions({ externalShell }))
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostOpenExternalChannel)!

    await expect(handler(trustedEvent(), 'https://docs.canvas.best')).resolves.toBe(true)
    expect(externalShell.openExternal).toHaveBeenCalledWith('https://docs.canvas.best')
  })

  it('logs a failed browser launch from a popup or navigation instead of leaving it unhandled', async () => {
    const failure = new Error('no default browser')
    const externalShell = { openExternal: vi.fn(async () => { throw failure }), openPath: vi.fn(async () => undefined) }
    const runtimeLog = { log: vi.fn(), exception: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ externalShell, runtimeLog: runtimeLog as never }))
    await controller.open()
    const webContents = electronMocks.latestWebContents!
    const openHandler = (webContents.setWindowOpenHandler as ReturnType<typeof vi.fn>).mock.calls[0][0] as (
      details: { url: string },
    ) => { action: string }
    const navigate = (webContents.on as ReturnType<typeof vi.fn>).mock.calls
      .find(([event]) => event === 'will-navigate')![1] as (event: { preventDefault: () => void }, url: string) => void

    expect(openHandler({ url: 'https://docs.canvas.best' })).toEqual({ action: 'deny' })
    navigate({ preventDefault: vi.fn() }, 'https://docs.canvas.best')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(externalShell.openExternal).toHaveBeenCalledTimes(2)
    expect(runtimeLog.exception).toHaveBeenCalledTimes(2)
    expect(runtimeLog.exception).toHaveBeenCalledWith('canvas', 'external.open.failed', failure)
    controller.dispose()
  })

  it('refuses downloads the canvas page starts without touching other windows on the shared session', async () => {
    const runtimeLog = { log: vi.fn(), exception: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ runtimeLog: runtimeLog as never }))
    await controller.open()
    const canvasContents = electronMocks.latestWebContents!
    const listeners = [...electronMocks.sessionListeners.get('will-download') ?? []]
    expect(listeners).toHaveLength(1)
    const [willDownload] = listeners

    const fromCanvas = { preventDefault: vi.fn() }
    willDownload(fromCanvas, { getFilename: () => 'export.png' }, canvasContents)
    expect(fromCanvas.preventDefault).toHaveBeenCalledOnce()
    expect(runtimeLog.log).toHaveBeenCalledWith('warn', 'canvas', 'download.refused', '已拦下画布页面发起的下载')

    const fromMainWindow = { preventDefault: vi.fn() }
    willDownload(fromMainWindow, { getFilename: () => 'report.zip' }, { id: 1 })
    expect(fromMainWindow.preventDefault).not.toHaveBeenCalled()

    const destroyWindow = electronMocks.latestBrowserWindow!.destroy as () => void
    destroyWindow()
    expect(electronMocks.sessionListeners.get('will-download')?.size).toBe(0)
    controller.dispose()
  })

  it('rejects a URL that is not an exact allowlist match (I12) -- subdomain and path confusion both fail', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
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

  it('validates notify input before ever constructing a Notification', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
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

  it('shows a native notification with title/body, defaulting an omitted body to empty', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    expect(handler(trustedEvent(), '生成完成', undefined)).toBe(true)
    expect(electronMocks.notificationShow).toHaveBeenCalledWith({ title: '生成完成', body: '' })
  })

  it('shows at most one canvas notification every five seconds', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const controller = createCanvasWindowController(controllerOptions())
      await controller.open()
      const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

      expect(handler(trustedEvent(), '生成完成', 'a')).toBe(true)
      now.mockReturnValue(1_004_999)
      expect(handler(trustedEvent(), '生成完成', 'b')).toBe(false)
      now.mockReturnValue(1_005_000)
      expect(handler(trustedEvent(), '生成完成', 'c')).toBe(true)
      expect(electronMocks.notificationShow.mock.calls).toEqual([
        [{ title: '生成完成', body: 'a' }],
        [{ title: '生成完成', body: 'c' }],
      ])
    } finally {
      now.mockRestore()
    }
  })

  it('strips links from canvas notifications and drops one whose title was only a link', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    expect(handler(trustedEvent(), 'https://evil.example/login', '余额异常')).toBe(false)
    expect(electronMocks.notificationShow).not.toHaveBeenCalled()
    expect(handler(trustedEvent(), '账号提醒', '请打开 https://evil.example/login 或 www.evil.example 处理')).toBe(true)
    expect(electronMocks.notificationShow).toHaveBeenCalledWith({ title: '账号提醒', body: '请打开  或  处理' })
  })

  it('returns false without throwing when Notification is unsupported on this platform', async () => {
    electronMocks.notificationSupported.mockReturnValue(false)
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostNotifyChannel)!

    expect(handler(trustedEvent(), '生成完成', 'body')).toBe(false)
    expect(electronMocks.notificationShow).not.toHaveBeenCalled()
  })

  it('returns null (not an error) when the save/pick dialog is canceled', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const saveHandler = electronMocks.handlers.get(canvasHostSaveFileChannel)!
    const pickHandler = electronMocks.handlers.get(canvasHostPickFileChannel)!

    await expect(saveHandler(trustedEvent(), 'export.json', '{}')).resolves.toBeNull()
    await expect(pickHandler(trustedEvent())).resolves.toBeNull()
  })

  it('requires a work-folder selection before creating a project and keeps its absolute path out of renderer data', async () => {
    const workspace = temporaryDirectory()
    const projectId = '11111111-1111-4111-8111-111111111111'
    const projects = {
      list: vi.fn(async () => []),
      create: vi.fn(async (_userId: number, name: string, selected: string) => ({
        project: {
          id: projectId, name, createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
          nodeCount: 0, workspaceName: path.basename(selected), workspaceConfigured: true,
        },
        content: JSON.stringify({ schemaVersion: 2, name, nodes: [], edges: [] }),
      })),
      open: vi.fn(), save: vi.fn(),
    }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never }))
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostCreateProjectChannel)!

    await expect(handler(trustedEvent(), '视频项目')).resolves.toBeNull()
    expect(projects.create).not.toHaveBeenCalled()

    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [workspace] })
    const created = await handler(trustedEvent(), '视频项目')
    expect(projects.create).toHaveBeenCalledWith(7, '视频项目', workspace)
    expect(electronMocks.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({
      title: '选择画布项目工作文件夹',
      properties: expect.arrayContaining(['openDirectory', 'createDirectory', 'promptToCreate']),
    }))
    expect(JSON.stringify(created)).not.toContain(workspace)
    expect(created).toMatchObject({ project: { workspaceName: path.basename(workspace), workspaceConfigured: true } })
  })

  it('creates a saved copy from the kernel content after the folder is chosen and checks the request first', async () => {
    const workspace = temporaryDirectory()
    const projectId = '11111111-1111-4111-8111-111111111111'
    const sourceProjectId = '22222222-2222-4222-8222-222222222222'
    const content = JSON.stringify({ schemaVersion: 2, name: '副本', nodes: [], edges: [] })
    const createWithContent = vi.fn(async (_userId: number, name: string, selected: string, _content: string, _source?: string) => ({
      project: {
        id: projectId, name, createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
        nodeCount: 0, workspaceName: path.basename(selected), workspaceConfigured: true,
      },
      content,
    }))
    const projects = { list: vi.fn(async () => []), create: vi.fn(), createWithContent, open: vi.fn(), save: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never }))
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostCreateProjectChannel)!
    electronMocks.showOpenDialog.mockClear()

    // A malformed request fails before the user is asked to pick a folder.
    await expect(handler(trustedEvent(), '副本', content, { sourceProjectId: '../other' })).rejects.toThrow('画布项目标识格式错误')
    await expect(handler(trustedEvent(), '副本', content, { sourceProjectId, workspace: 'C:\\Users' })).rejects.toThrow('包含未知字段')
    await expect(handler(trustedEvent(), '副本', 42)).rejects.toThrow('画布项目内容格式错误')
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled()

    await expect(handler(trustedEvent(), '副本', content, { sourceProjectId })).resolves.toBeNull()
    expect(createWithContent).not.toHaveBeenCalled()

    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [workspace] })
    const created = await handler(trustedEvent(), '副本', content, { sourceProjectId })
    expect(createWithContent).toHaveBeenCalledWith(7, '副本', workspace, content, sourceProjectId)
    expect(projects.create).not.toHaveBeenCalled()
    expect(JSON.stringify(created)).not.toContain(workspace)

    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [workspace] })
    await handler(trustedEvent(), '副本', content)
    expect(createWithContent).toHaveBeenLastCalledWith(7, '副本', workspace, content, undefined)
  })

  it('creates a project in its own new folder under the default folder without a folder dialog', async () => {
    const root = path.join(temporaryDirectory(), '星芒画布')
    const projectId = '11111111-1111-4111-8111-111111111111'
    const create = vi.fn(async (_userId: number, name: string, selected: string) => ({
      project: {
        id: projectId, name, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
        lastOpenedAt: '2026-11-09T00:00:00.000Z', nodeCount: 0, assetCount: 0,
        workspaceName: path.basename(selected), workspaceConfigured: true, workspaceStatus: 'ready' as const,
      },
      content: JSON.stringify({ schemaVersion: 2, name, nodes: [], edges: [] }),
    }))
    const projects = { list: vi.fn(async () => []), create, open: vi.fn(), save: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never, defaultProjectsDirectory: () => root }))
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostCreateProjectInDefaultFolderChannel)!

    const created = await handler(trustedEvent(), '海报/第一版')
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith(7, '海报/第一版', path.join(root, '海报 第一版'))
    expect(JSON.stringify(created)).not.toContain(root)
    // The same name again gets a new folder; the first one is never reused.
    await handler(trustedEvent(), '海报/第一版')
    expect(create).toHaveBeenLastCalledWith(7, '海报/第一版', path.join(root, '海报 第一版 (2)'))
    await expect(handler(trustedEvent(), '')).rejects.toThrow('画布项目名称')
    await expect(handler(trustedEvent(), { name: 'x' })).rejects.toThrow('画布项目名称')
  })

  it('removes the new folder again when the project cannot be created there', async () => {
    const root = path.join(temporaryDirectory(), '星芒画布')
    const projects = { list: vi.fn(async () => []), create: vi.fn(async () => { throw new Error('画布项目已达到数量上限') }), open: vi.fn(), save: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never, defaultProjectsDirectory: () => root }))
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostCreateProjectInDefaultFolderChannel)!

    await expect(handler(trustedEvent(), '海报')).rejects.toThrow('画布项目已达到数量上限')
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('says to choose a folder when the default folder cannot be made or is not configured', async () => {
    const blocked = path.join(temporaryDirectory(), 'blocked')
    fs.writeFileSync(blocked, '')
    const projects = { list: vi.fn(async () => []), create: vi.fn(), open: vi.fn(), save: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never, defaultProjectsDirectory: () => path.join(blocked, '星芒画布') }))
    await controller.open()
    await expect(electronMocks.handlers.get(canvasHostCreateProjectInDefaultFolderChannel)!(trustedEvent(), '海报'))
      .rejects.toThrow(/^没能在「星芒画布」文件夹里建项目（.+），可以点「换个位置创建…」自己选文件夹$/)
    expect(projects.create).not.toHaveBeenCalled()
    controller.dispose()

    const unconfigured = createCanvasWindowController(controllerOptions({ projects: projects as never }))
    await unconfigured.open()
    await expect(electronMocks.handlers.get(canvasHostCreateProjectInDefaultFolderChannel)!(trustedEvent(), '海报'))
      .rejects.toThrow('换个位置创建…')
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled()
  })

  it('asks where a missing project folder is now and only for a project whose folder is missing', async () => {
    const workspace = temporaryDirectory()
    const projectId = '11111111-1111-4111-8111-111111111111'
    const summary = {
      id: projectId, name: '搬走的项目', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
      lastOpenedAt: '2026-11-09T00:00:00.000Z', nodeCount: 1, assetCount: 1,
      workspaceName: 'old', workspaceConfigured: true, workspaceStatus: 'missing' as CanvasProjectWorkspaceStatus,
    }
    const list = vi.fn(async () => [summary])
    const relinkWorkspace = vi.fn(async (_userId: number, _projectId: string, selected: string) => ({ ...summary, workspaceName: path.basename(selected), workspaceStatus: 'ready' as const }))
    const forgetProject = vi.fn()
    const projects = { list, create: vi.fn(), open: vi.fn(), save: vi.fn(), relinkWorkspace }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never, projectAssets: { forgetProject } as never }))
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostRelinkProjectFolderChannel)!

    await expect(handler(trustedEvent(), projectId)).resolves.toBeNull()
    expect(electronMocks.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({
      title: '重新选择「搬走的项目」的工作文件夹',
      properties: ['openDirectory'],
    }))
    expect(relinkWorkspace).not.toHaveBeenCalled()

    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [workspace] })
    const relinked = await handler(trustedEvent(), projectId)
    expect(relinkWorkspace).toHaveBeenCalledWith(7, projectId, workspace)
    expect(forgetProject).toHaveBeenCalledWith(7, projectId)
    expect(JSON.stringify(relinked)).not.toContain(workspace)
    expect(relinked).toMatchObject({ workspaceStatus: 'ready', workspaceName: path.basename(workspace) })

    // A project whose folder is still there, or one this account does not have, never gets the dialog.
    electronMocks.showOpenDialog.mockClear()
    list.mockResolvedValueOnce([{ ...summary, workspaceStatus: 'ready' as const }])
    await expect(handler(trustedEvent(), projectId)).rejects.toThrow('项目的工作文件夹还在')
    await expect(handler(trustedEvent(), '22222222-2222-4222-8222-222222222222')).rejects.toThrow('画布项目不存在')
    await expect(handler(trustedEvent(), 42)).rejects.toThrow('画布项目标识')
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled()
  })

  describe('the balance chip', () => {
    const summary = { siteLabel: '星芒账号', accountLabel: 'yo***3', balanceUsd: 12.4, subscriptionLabel: null, readAt: '2026-11-10T03:00:00.000Z' }

    it('answers with the reader and takes nothing from the page', async () => {
      const readAccountSummary = vi.fn(async () => summary)
      const controller = createCanvasWindowController(controllerOptions({ readAccountSummary }))
      await controller.open()
      const handler = electronMocks.handlers.get(canvasHostGetAccountSummaryChannel)!
      await expect(handler(trustedEvent(), 'https://attacker.example/', { userId: 1 })).resolves.toEqual(summary)
      expect(readAccountSummary).toHaveBeenCalledTimes(1)
      expect(readAccountSummary).toHaveBeenCalledWith()
    })

    it('tells the canvas nobody is signed in when the host has no reader', async () => {
      const controller = createCanvasWindowController(controllerOptions())
      await controller.open()
      await expect(electronMocks.handlers.get(canvasHostGetAccountSummaryChannel)!(trustedEvent())).resolves.toBeNull()
    })

    it('answers only the canvas window', async () => {
      const readAccountSummary = vi.fn(async () => summary)
      const controller = createCanvasWindowController(controllerOptions({ readAccountSummary }))
      await controller.open()
      const handler = electronMocks.handlers.get(canvasHostGetAccountSummaryChannel)!
      // The main window has its own balance; this channel is the canvas's only.
      expect(() => handler(trustedEvent('xingmang://app/index.html'))).toThrow('已拒绝来自非画布页面的操作请求')
      expect(() => handler(foreignEvent())).toThrow('已拒绝来自非画布页面的操作请求')
      expect(readAccountSummary).not.toHaveBeenCalled()
    })
  })

  describe('the run price list', () => {
    const snapshot = { models: { 'gpt-image-2': { usd: 0.06 } }, groupRatios: { default: 1 }, readAt: '2026-11-10T03:00:00.000Z' }

    it('answers with the reader and takes nothing from the page', async () => {
      const readPriceSnapshot = vi.fn(async () => snapshot)
      const controller = createCanvasWindowController(controllerOptions({ readPriceSnapshot }))
      await controller.open()
      const handler = electronMocks.handlers.get(canvasHostGetPriceSnapshotChannel)!
      await expect(handler(trustedEvent(), { model: 'gpt-image-2', usd: 0 })).resolves.toEqual(snapshot)
      expect(readPriceSnapshot).toHaveBeenCalledTimes(1)
      expect(readPriceSnapshot).toHaveBeenCalledWith()
    })

    it('tells the canvas there is no price list when the host has no reader', async () => {
      const controller = createCanvasWindowController(controllerOptions())
      await controller.open()
      await expect(electronMocks.handlers.get(canvasHostGetPriceSnapshotChannel)!(trustedEvent())).resolves.toBeNull()
    })

    it('answers only the canvas window', async () => {
      const readPriceSnapshot = vi.fn(async () => snapshot)
      const controller = createCanvasWindowController(controllerOptions({ readPriceSnapshot }))
      await controller.open()
      const handler = electronMocks.handlers.get(canvasHostGetPriceSnapshotChannel)!
      expect(() => handler(trustedEvent('xingmang://app/index.html'))).toThrow('已拒绝来自非画布页面的操作请求')
      expect(() => handler(foreignEvent())).toThrow('已拒绝来自非画布页面的操作请求')
      expect(readPriceSnapshot).not.toHaveBeenCalled()
    })
  })

  describe('deleting a project', () => {
    const projectId = '11111111-1111-4111-8111-111111111111'

    function deletable(workspaceName: string, archived = true) {
      return {
        id: projectId, name: '旧海报', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
        lastOpenedAt: '2026-11-09T00:00:00.000Z', nodeCount: 1, assetCount: 1,
        workspaceName, workspaceConfigured: true, workspaceStatus: 'ready' as CanvasProjectWorkspaceStatus,
        ...(archived ? { archivedAt: '2026-11-09T01:00:00.000Z' } : {}),
      }
    }

    async function deleteController(workspace: string, root: string, archived = true, trashProjectFolder = vi.fn(async (_directory: string) => undefined)) {
      const list = vi.fn(async () => [deletable(path.basename(workspace), archived)])
      const remove = vi.fn(async () => ({ project: deletable(path.basename(workspace), archived), workspaceDirectory: workspace }))
      const forgetProject = vi.fn()
      const projects = { list, create: vi.fn(), open: vi.fn(), save: vi.fn(), remove, getWorkspaceDirectory: vi.fn(async () => workspace) }
      const controller = createCanvasWindowController(controllerOptions({
        projects: projects as never, projectAssets: { forgetProject } as never, defaultProjectsDirectory: () => root, trashProjectFolder,
      }))
      await controller.open()
      return { handler: electronMocks.handlers.get(canvasHostDeleteProjectChannel)!, remove, forgetProject, trashProjectFolder }
    }

    it('deletes an archived project only after the user says so in the system dialog', async () => {
      const root = path.join(temporaryDirectory(), '星芒画布')
      const workspace = path.join(root, '旧海报')
      fs.mkdirSync(workspace, { recursive: true })
      const { handler, remove, forgetProject, trashProjectFolder } = await deleteController(workspace, root)

      await expect(handler(trustedEvent(), projectId)).resolves.toBeNull()
      expect(electronMocks.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'warning', title: '删除项目', message: '删除「旧海报」？', buttons: ['删除', '取消'], defaultId: 1, cancelId: 1,
        detail: expect.stringContaining('项目文件夹「星芒画布 › 旧海报」连同里面的图片、视频移到'),
      }))
      expect(remove).not.toHaveBeenCalled()
      expect(trashProjectFolder).not.toHaveBeenCalled()

      electronMocks.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      await expect(handler(trustedEvent(), projectId)).resolves.toEqual({ projectId, folderMovedToTrash: true })
      expect(remove).toHaveBeenCalledWith(7, projectId)
      expect(forgetProject).toHaveBeenCalledWith(7, projectId)
      expect(trashProjectFolder).toHaveBeenCalledWith(workspace)
    })

    it('never asks about or deletes a project that is not archived, and refuses a malformed id', async () => {
      const root = path.join(temporaryDirectory(), '星芒画布')
      const { handler, remove } = await deleteController(path.join(root, '旧海报'), root, false)
      electronMocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })

      await expect(handler(trustedEvent(), projectId)).rejects.toThrow('请先归档这个项目再删除')
      await expect(handler(trustedEvent(), '22222222-2222-4222-8222-222222222222')).rejects.toThrow('画布项目不存在')
      await expect(handler(trustedEvent(), 42)).rejects.toThrow('画布项目标识')
      expect(electronMocks.showMessageBox).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    })

    it('leaves a folder the user picked elsewhere where it is', async () => {
      const root = path.join(temporaryDirectory(), '星芒画布')
      const workspace = temporaryDirectory()
      const { handler, remove, trashProjectFolder } = await deleteController(workspace, root)
      electronMocks.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })

      await expect(handler(trustedEvent(), projectId)).resolves.toEqual({ projectId, folderMovedToTrash: false })
      expect(electronMocks.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
        detail: `项目从列表里删掉，删了不能撤销。电脑上的文件一个都不删，项目文件夹「${path.basename(workspace)}」留在原处。`,
      }))
      expect(remove).toHaveBeenCalledWith(7, projectId)
      expect(trashProjectFolder).not.toHaveBeenCalled()
    })

    it('still deletes the project when its folder cannot go to the trash', async () => {
      const root = path.join(temporaryDirectory(), '星芒画布')
      const workspace = path.join(root, '旧海报')
      fs.mkdirSync(workspace, { recursive: true })
      const { handler, remove } = await deleteController(workspace, root, true, vi.fn(async () => { throw new Error('trash unavailable') }))
      electronMocks.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })

      await expect(handler(trustedEvent(), projectId)).resolves.toEqual({ projectId, folderMovedToTrash: false })
      expect(remove).toHaveBeenCalledWith(7, projectId)
      expect(fs.existsSync(workspace)).toBe(true)
    })

    it.runIf(process.platform !== 'win32')('leaves a folder alone that became a link while the dialog was open', async () => {
      const root = path.join(temporaryDirectory(), '星芒画布')
      const workspace = path.join(root, '旧海报')
      fs.mkdirSync(workspace, { recursive: true })
      const elsewhere = temporaryDirectory()
      const { handler, remove, trashProjectFolder } = await deleteController(workspace, root)
      electronMocks.showMessageBox.mockImplementationOnce(async () => {
        fs.rmSync(workspace, { recursive: true })
        fs.symlinkSync(elsewhere, workspace)
        return { response: 0, checkboxChecked: false }
      })

      await expect(handler(trustedEvent(), projectId)).resolves.toEqual({ projectId, folderMovedToTrash: false })
      expect(remove).toHaveBeenCalledWith(7, projectId)
      expect(trashProjectFolder).not.toHaveBeenCalled()
    })

    it('moves only a project folder directly under the default folder to the trash', () => {
      const root = path.join(temporaryDirectory(), '星芒画布')
      const own = path.join(root, '旧海报')
      fs.mkdirSync(path.join(own, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(root, '文件'), '')
      expect(canvasProjectFolderToTrash(own, root)).toBe(own)
      expect(canvasProjectFolderToTrash(path.join(own, 'nested'), root)).toBeNull()
      expect(canvasProjectFolderToTrash(root, root)).toBeNull()
      expect(canvasProjectFolderToTrash(path.join(root, '文件'), root)).toBeNull()
      expect(canvasProjectFolderToTrash(path.join(root, '不在了'), root)).toBeNull()
      expect(canvasProjectFolderToTrash(temporaryDirectory(), root)).toBeNull()
      expect(canvasProjectFolderToTrash(null, root)).toBeNull()
      expect(canvasProjectFolderToTrash(own, undefined)).toBeNull()
      if (process.platform !== 'win32') {
        fs.symlinkSync(temporaryDirectory(), path.join(root, '链接'))
        expect(canvasProjectFolderToTrash(path.join(root, '链接'), root)).toBeNull()
      }
    })

    it('names the trash the way each system does', () => {
      const folder = path.join('/docs', '星芒画布', '旧海报')
      expect(canvasProjectDeleteDetail(folder, '旧海报', 'darwin')).toBe('项目从列表里删掉，删了不能撤销。项目文件夹「星芒画布 › 旧海报」连同里面的图片、视频移到废纸篓，还能从废纸篓里拿回来。')
      expect(canvasProjectDeleteDetail(folder, '旧海报', 'win32')).toBe('项目从列表里删掉，删了不能撤销。项目文件夹「星芒画布 › 旧海报」连同里面的图片、视频移到回收站，还能从回收站里拿回来。')
      expect(canvasProjectDeleteDetail(null, undefined, 'linux')).toBe('项目从列表里删掉，删了不能撤销。电脑上的文件一个都不删。')
    })
  })

  it('accepts pretty-printed project JSON and forwards saved node layout and viewport', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111'
    const summary = {
      id: projectId, name: '布局项目', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
      nodeCount: 1, workspaceName: 'layout-project', workspaceConfigured: true,
    }
    const content = JSON.stringify({
      schemaVersion: 2,
      name: '布局项目',
      viewport: { x: 420, y: -160, zoom: 0.8 },
      nodes: [{
        id: 'image-1', kind: 'image-input', definitionVersion: 1,
        position: { x: 742.5, y: -318.25 }, width: 280, height: 340, locked: true,
        data: { prompt: '', model: '' },
      }],
      edges: [],
    }, null, 2)
    const save = vi.fn(async (_userId: number, _projectId: string, _content: string) => summary)
    const projects = {
      list: vi.fn(async () => [summary]), create: vi.fn(),
      open: vi.fn(async () => ({ project: summary, content })),
      save,
    }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never }))
    await controller.open()

    await electronMocks.handlers.get(canvasHostOpenProjectChannel)!(trustedEvent(), projectId)
    await expect(electronMocks.handlers.get(canvasHostSaveProjectChannel)!(trustedEvent(), projectId, content)).resolves.toEqual(summary)

    expect(save).toHaveBeenCalledWith(7, projectId, content)
    expect(JSON.parse(save.mock.calls[0][2])).toMatchObject({
      viewport: { x: 420, y: -160, zoom: 0.8 },
      nodes: [{ position: { x: 742.5, y: -318.25 }, width: 280, height: 340, locked: true }],
    })
  })

  it('routes project rename, duplicate and archive through account-scoped main-process handlers', async () => {
    const workspace = temporaryDirectory()
    const projectId = '11111111-1111-4111-8111-111111111111'
    const duplicateId = '22222222-2222-4222-8222-222222222222'
    const summary = {
      id: projectId, name: '项目', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
      lastOpenedAt: '2026-08-14T00:00:00.000Z', nodeCount: 1, assetCount: 1,
      workspaceName: 'project', workspaceConfigured: true, workspaceStatus: 'ready' as const,
    }
    const rename = vi.fn(async (_userId: number, _projectId: string, name: string) => ({ ...summary, name }))
    const duplicate = vi.fn(async (_userId: number, _projectId: string, name: string, selected: string) => ({
      project: { ...summary, id: duplicateId, name, workspaceName: path.basename(selected) },
      content: JSON.stringify({ schemaVersion: 2, name, nodes: [], edges: [] }),
    }))
    const setArchived = vi.fn(async (_userId: number, _projectId: string, archived: boolean) => ({
      ...summary,
      ...(archived ? { archivedAt: '2026-08-17T00:00:00.000Z' } : {}),
    }))
    const projects = { list: vi.fn(), create: vi.fn(), open: vi.fn(), save: vi.fn(), rename, duplicate, setArchived }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never }))
    await controller.open()

    await expect(electronMocks.handlers.get(canvasHostRenameProjectChannel)!(trustedEvent(), projectId, '重命名'))
      .resolves.toMatchObject({ name: '重命名' })
    expect(rename).toHaveBeenCalledWith(7, projectId, '重命名')

    await expect(electronMocks.handlers.get(canvasHostDuplicateProjectChannel)!(trustedEvent(), projectId, '项目副本'))
      .resolves.toBeNull()
    expect(duplicate).not.toHaveBeenCalled()
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [workspace] })
    const copied = await electronMocks.handlers.get(canvasHostDuplicateProjectChannel)!(trustedEvent(), projectId, '项目副本')
    expect(duplicate).toHaveBeenCalledWith(7, projectId, '项目副本', workspace)
    expect(JSON.stringify(copied)).not.toContain(workspace)
    expect(copied).toMatchObject({ project: { id: duplicateId, workspaceName: path.basename(workspace) } })

    await expect(electronMocks.handlers.get(canvasHostSetProjectArchivedChannel)!(trustedEvent(), projectId, true))
      .resolves.toMatchObject({ archivedAt: expect.any(String) })
    expect(setArchived).toHaveBeenCalledWith(7, projectId, true)
    await expect(electronMocks.handlers.get(canvasHostSetProjectArchivedChannel)!(trustedEvent(), projectId, 'yes'))
      .rejects.toThrow('归档状态无效')
  })

  it('invalidates the canvas owner state and notifies the renderer on account changes', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111'
    const summary = {
      id: projectId, name: '账号项目', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
      lastOpenedAt: '2026-08-14T00:00:00.000Z', nodeCount: 0, assetCount: 0,
      workspaceName: 'account-project', workspaceConfigured: true, workspaceStatus: 'ready' as const,
    }
    let userId = 7
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId } })),
    }
    const projects = {
      list: vi.fn(async () => [summary]),
      open: vi.fn(async () => ({ project: summary, content: JSON.stringify({ schemaVersion: 2, name: summary.name, nodes: [], edges: [] }) })),
    }
    const imageService = { ...controllerOptions().imageService, cancelSender: vi.fn(() => 0) }
    const videoService = { ...controllerOptions().videoService, cancelSender: vi.fn(() => 0) }
    const canvasRuns = { ...controllerOptions().canvasRuns, cancelOwner: vi.fn(() => 0) }
    const controller = createCanvasWindowController(controllerOptions({
      accountService: accountService as never,
      projects: projects as never,
      imageService: imageService as never,
      videoService: videoService as never,
      canvasRuns: canvasRuns as never,
    }))
    await controller.open()
    const send = electronMocks.latestWebContents!.send as ReturnType<typeof vi.fn>
    send.mockClear()
    controller.setAccountUser(7)
    expect(send).toHaveBeenCalledWith(canvasHostAccountChangedChannel, { userId: 7, previousUserId: null })
    send.mockClear()
    controller.setAccountUser(7)
    expect(send).not.toHaveBeenCalled()

    await electronMocks.handlers.get(canvasHostOpenProjectChannel)!(trustedEvent(), projectId)
    userId = 9
    controller.setAccountUser(9)
    expect(imageService.cancelSender).toHaveBeenCalledWith(41)
    expect(videoService.cancelSender).toHaveBeenCalledWith(41)
    expect(canvasRuns.cancelOwner).toHaveBeenCalledWith(41)
    expect(send).toHaveBeenCalledWith(canvasHostAccountChangedChannel, { userId: 9, previousUserId: 7 })

    // Returning to the old account must still require a fresh project open;
    // the sender-scoped active project is deliberately discarded on switch.
    userId = 7
    controller.setAccountUser(7)
    await expect(electronMocks.handlers.get(canvasHostListRunsChannel)!(trustedEvent())).rejects.toThrow('请先选择或新建')
  })

  it('counts run starts against the same frequency limit as direct generation', async () => {
    const canvasRuns = controllerOptions().canvasRuns as unknown as { start: ReturnType<typeof vi.fn> }
    const controller = createCanvasWindowController(controllerOptions({ canvasRuns: canvasRuns as never }))
    await controller.open()
    const startRun = electronMocks.handlers.get(canvasHostStartRunChannel)!
    const generateImage = electronMocks.handlers.get(canvasHostGenerateImageChannel)!
    const input = { graph: { nodes: [], edges: [] }, scope: { kind: 'all' } }

    // The window allows 80 paid starts a minute per canvas; a poisoned canvas
    // must not get an unlimited lane by submitting runs instead.
    for (let index = 0; index < 79; index += 1) {
      await expect(startRun(trustedEvent(), input)).resolves.toEqual({ runId: 'run-1', graphRevision: 'revision' })
    }
    await expect(generateImage(trustedEvent(), { requestId: 'request-80', prompt: '猫', model: 'image-model', group: 'default' }))
      .resolves.toEqual([])
    await expect(startRun(trustedEvent(), input)).rejects.toThrow('生成请求过于频繁')
    expect(canvasRuns.start).toHaveBeenCalledTimes(79)
  })

  it('binds cancel requests and runs to the currently authenticated canvas account', async () => {
    let userId = 7
    const accountService = { getSessionState: vi.fn(() => ({ authenticated: true, account: { userId } })) }
    const canvasRuns = { ...controllerOptions().canvasRuns, cancel: vi.fn(() => true) }
    const imageCancel = vi.fn(() => ({ canceled: true, mayStillComplete: false }))
    const videoCancel = vi.fn(() => ({ canceled: false, mayStillComplete: false }))
    const controller = createCanvasWindowController(controllerOptions({
      accountService: accountService as never,
      canvasRuns: canvasRuns as never,
      imageService: { ...controllerOptions().imageService, cancel: imageCancel } as never,
      videoService: { ...controllerOptions().videoService, cancel: videoCancel } as never,
    }))
    await controller.open()
    const cancelRequest = electronMocks.handlers.get(canvasHostCancelRequestChannel)!
    const cancelRun = electronMocks.handlers.get(canvasHostCancelRunChannel)!

    expect(cancelRequest(trustedEvent(), 'request-1')).toMatchObject({ canceled: true })
    expect(imageCancel).toHaveBeenCalledWith(41, 'request-1', 7)
    userId = 9
    imageCancel.mockReturnValue({ canceled: false, mayStillComplete: false })
    expect(cancelRequest(trustedEvent(), 'request-1')).toMatchObject({ canceled: false })
    expect(imageCancel).toHaveBeenCalledWith(41, 'request-1', 9)
    expect(cancelRun(trustedEvent(), 'run-1')).toBe(true)
    expect(canvasRuns.cancel).toHaveBeenCalledWith('run-1', 41, 9)

    userId = 7
    expect(cancelRun(trustedEvent(), 'run-1')).toBe(true)
    expect(canvasRuns.cancel).toHaveBeenCalledWith('run-1', 41, 7)
  })

  it('combines current workflow, saved project and run candidate references without deleting assets', async () => {
    const assetId = 'A'.repeat(43)
    const projectId = '11111111-1111-4111-8111-111111111111'
    const content = projectWorkflow([assetId])
    const summary = {
      id: projectId, name: '引用项目', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
      lastOpenedAt: '2026-08-14T00:00:00.000Z', nodeCount: 1, assetCount: 1,
      workspaceName: 'references', workspaceConfigured: true, workspaceStatus: 'ready' as const,
    }
    const findAssetReferences = vi.fn(async () => [{ projectId, projectName: '引用项目', nodeIds: ['image-0'], archived: false }])
    const projects = {
      list: vi.fn(async () => [summary]), create: vi.fn(), save: vi.fn(), rename: vi.fn(), duplicate: vi.fn(), setArchived: vi.fn(),
      open: vi.fn(async () => ({ project: summary, content })),
      findAssetReferences,
    }
    const run = {
      version: 1, userId: 7, ownerId: 41, projectId, runId: 'run-reference', graphRevision: 'revision',
      scope: { kind: 'all' }, status: 'succeeded', createdAt: '2026-08-17T00:00:00.000Z', startedAt: '2026-08-17T00:00:00.000Z', events: [],
      nodes: [{
        nodeId: 'image-generate', kind: 'image-generate', state: 'succeeded',
        attempts: [{
          attemptId: 'attempt-1', fingerprint: 'fingerprint', state: 'succeeded',
          startedAt: '2026-08-17T00:00:00.000Z', completedAt: '2026-08-17T00:00:01.000Z', durationMs: 1_000, cached: false,
          inputAssetIds: [], candidates: [{ candidateId: 'candidate-1', attemptId: 'attempt-1', createdAt: '2026-08-17T00:00:01.000Z', asset: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` } }],
        }],
      }],
    }
    const canvasRuns = {
      start: vi.fn(), cancel: vi.fn(), cancelOwner: vi.fn(), getAssetLineage: vi.fn(), subscribe: vi.fn(() => () => undefined),
      listRuns: vi.fn(async () => [run]),
    }
    const controller = createCanvasWindowController(controllerOptions({ projects: projects as never, canvasRuns: canvasRuns as never }))
    await controller.open()
    await electronMocks.handlers.get(canvasHostOpenProjectChannel)!(trustedEvent(), projectId)

    const report = await electronMocks.handlers.get(canvasHostInspectAssetReferencesChannel)!(trustedEvent(), assetId, content)
    expect(report).toEqual({
      assetId,
      inUse: true,
      // The project's name comes from the store, which is where renaming is
      // recorded, rather than from whatever the canvas put in its payload.
      currentProject: { projectId, projectName: '引用项目', nodeIds: ['image-0'] },
      projects: [{ projectId, projectName: '引用项目', nodeIds: ['image-0'], archived: false }],
      runs: [{
        runId: 'run-reference', projectId, createdAt: '2026-08-17T00:00:00.000Z', status: 'succeeded',
        nodeIds: ['image-generate'], inputReferenceCount: 0, candidateReferenceCount: 1,
      }],
    })
    expect(findAssetReferences).toHaveBeenCalledWith(7, assetId)
  })

  it('blocks a purge on the stored project even when the canvas reports no references', async () => {
    // The active project's references used to be read only from the payload the
    // renderer sent. A canvas that under-reports its own content could then walk
    // an asset it is still wired to into the bin, and a purge does not undo.
    const assetId = 'A'.repeat(43)
    const projectId = '22222222-2222-4222-8222-222222222222'
    const summary = {
      id: projectId, name: '在用项目', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
      lastOpenedAt: '2026-08-14T00:00:00.000Z', nodeCount: 1, assetCount: 1,
      workspaceConfigured: false, workspaceStatus: 'ready' as const,
    }
    const projects = {
      list: vi.fn(async () => [summary]), create: vi.fn(), save: vi.fn(), rename: vi.fn(), duplicate: vi.fn(), setArchived: vi.fn(),
      open: vi.fn(async () => ({ project: summary, content: projectWorkflow([assetId]) })),
      findAssetReferences: vi.fn(async () => [{ projectId, projectName: '在用项目', nodeIds: ['image-0'], archived: false }]),
    }
    const canvasRuns = {
      start: vi.fn(), cancel: vi.fn(), cancelOwner: vi.fn(), getAssetLineage: vi.fn(), subscribe: vi.fn(() => () => undefined),
      listRuns: vi.fn(async () => []),
    }
    const purge = vi.fn(async (_userId: number, _assetId: string, references: () => Promise<{ inUse: boolean }>) => {
      const report = await references()
      if (report.inUse) throw new Error('素材仍在使用中')
      return { assetId: _assetId }
    })
    const controller = createCanvasWindowController(controllerOptions({
      projects: projects as never,
      canvasRuns: canvasRuns as never,
      mediaAssets: { purge } as never,
    }))
    await controller.open()
    await electronMocks.handlers.get(canvasHostOpenProjectChannel)!(trustedEvent(), projectId)

    // An empty workflow: the canvas claiming it uses nothing at all.
    const emptyClaim = projectWorkflow([])
    await expect(electronMocks.handlers.get(canvasHostPurgeAssetChannel)!(trustedEvent(), assetId, emptyClaim))
      .rejects.toThrow('素材仍在使用中')
    await expect(electronMocks.handlers.get(canvasHostInspectAssetReferencesChannel)!(trustedEvent(), assetId, emptyClaim))
      .resolves.toMatchObject({ inUse: true, currentProject: { projectId, nodeIds: ['image-0'] } })
  })

  it('imports a validated local image through the native picker without exposing its path', async () => {
    const directory = temporaryDirectory()
    const imagePath = path.join(directory, 'reference.png')
    fs.writeFileSync(imagePath, projectPng)
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [imagePath] })
    const imported = { assetId: 'I'.repeat(43), localUrl: `xingmang-asset://image/${'I'.repeat(43)}`, mimeType: 'image/png', fileName: 'reference.png' }
    const aiAssets = {
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), listOwnedPage: vi.fn(),
      storeLocalFile: vi.fn(async () => imported), removeOwned: vi.fn(async () => undefined),
    }
    const setSource = vi.fn(async () => ({ assetId: imported.assetId, source: 'imported' as const }))
    const controller = createCanvasWindowController(controllerOptions({
      aiAssets: aiAssets as never,
      mediaAssets: {
        listOwnedPage: vi.fn(), copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), rename: vi.fn(),
        updateMetadata: vi.fn(), markUsed: vi.fn(), setSource,
      } as never,
    }))
    await controller.open()

    await expect(electronMocks.handlers.get(canvasHostPickAssetChannel)!(trustedEvent())).resolves.toEqual(imported)
    expect(aiAssets.storeLocalFile).toHaveBeenCalledWith(7, imagePath)
    expect(setSource).toHaveBeenCalledWith(7, imported.assetId, 'imported')
  })

  it('routes a dragged local MP4 to the video asset store', async () => {
    const directory = temporaryDirectory()
    const videoPath = path.join(directory, 'reference.mp4')
    fs.writeFileSync(videoPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]))
    const imported = { assetId: 'V'.repeat(43), localUrl: `xingmang-asset://video/${'V'.repeat(43)}`, mimeType: 'video/mp4', fileName: 'reference.mp4' }
    const videoAssets = { storeLocalFile: vi.fn(async () => imported) }
    const aiAssets = { storeLocalFile: vi.fn(), removeOwned: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ videoAssets: videoAssets as never, aiAssets: aiAssets as never }))
    await controller.open()

    await expect(electronMocks.handlers.get(canvasHostImportAssetFileChannel)!(trustedEvent(), videoPath))
      .resolves.toEqual({ ...imported, mediaType: 'video' })
    expect(videoAssets.storeLocalFile).toHaveBeenCalledWith(7, videoPath)
    expect(aiAssets.storeLocalFile).not.toHaveBeenCalled()
  })

  it('rolls back a video asset when the account changes during local import', async () => {
    const directory = temporaryDirectory()
    const videoPath = path.join(directory, 'account-switch.mp4')
    fs.writeFileSync(videoPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]))
    const imported = { assetId: 'W'.repeat(43), localUrl: `xingmang-asset://video/${'W'.repeat(43)}`, mimeType: 'video/mp4', fileName: 'account-switch.mp4' }
    let userId = 7
    const removeOwned = vi.fn(async () => undefined)
    const videoAssets = {
      storeLocalFile: vi.fn(async () => { userId = 9; return imported }),
      removeOwned,
    }
    const controller = createCanvasWindowController(controllerOptions({
      accountService: { getSessionState: vi.fn(() => ({ authenticated: true, account: { userId } })) } as never,
      videoAssets: videoAssets as never,
    }))
    await controller.open()

    await expect(electronMocks.handlers.get(canvasHostImportAssetFileChannel)!(trustedEvent(), videoPath))
      .rejects.toThrow('账号已切换')
    expect(removeOwned).toHaveBeenCalledWith(7, imported.assetId)
  })

  it('rejects a hard-linked dragged file before any asset store can read it', async () => {
    const directory = temporaryDirectory()
    const videoPath = path.join(directory, 'reference.mp4')
    const hardLinkPath = path.join(directory, 'reference-copy.mp4')
    fs.writeFileSync(videoPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]))
    fs.linkSync(videoPath, hardLinkPath)
    const videoAssets = { storeLocalFile: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ videoAssets: videoAssets as never }))
    await controller.open()

    await expect(electronMocks.handlers.get(canvasHostImportAssetFileChannel)!(trustedEvent(), videoPath))
      .rejects.toThrow('本地媒体文件不安全')
    expect(videoAssets.storeLocalFile).not.toHaveBeenCalled()
  })

  it('saves a picture the page drew into the open project library from its bytes alone', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111'
    const project = { id: projectId, name: '蒙版项目', createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z' }
    const stored = { assetId: 'M'.repeat(43), localUrl: `xingmang-asset://image/${'M'.repeat(43)}`, mimeType: 'image/png', width: 1, height: 1, fileName: `xingmang-${'M'.repeat(43)}.png` }
    const folder = { images: { storeLocalBytes: vi.fn(async () => stored) }, media: { setSource: vi.fn(async () => undefined) } }
    const aiAssets = { copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), listOwnedPage: vi.fn(), storeLocalBytes: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({
      projects: { list: vi.fn(async () => [project]), create: vi.fn(), open: vi.fn(async () => ({ project, content: '{}' })), save: vi.fn() } as never,
      projectAssets: { forProject: vi.fn(async () => folder), forNewWorkspace: vi.fn(), forgetProject: vi.fn() } as never,
      aiAssets: aiAssets as never,
    }))
    await controller.open()
    const importBytes = electronMocks.handlers.get(canvasHostImportAssetBytesChannel)!

    await expect(importBytes(trustedEvent(), new Uint8Array(projectPng))).rejects.toThrow('请先选择或新建一个画布项目')
    expect(folder.images.storeLocalBytes).not.toHaveBeenCalled()

    await electronMocks.handlers.get(canvasHostOpenProjectChannel)!(trustedEvent(), projectId)
    await expect(importBytes(trustedEvent(), new Uint8Array(projectPng))).resolves.toEqual(stored)
    expect(folder.images.storeLocalBytes).toHaveBeenCalledTimes(1)
    const [userId, bytes] = folder.images.storeLocalBytes.mock.calls[0] as unknown as [number, Buffer]
    expect(userId).toBe(7)
    expect(Buffer.isBuffer(bytes) && bytes.equals(projectPng)).toBe(true)
    expect(folder.media.setSource).toHaveBeenCalledWith(7, stored.assetId, 'imported')
    expect(aiAssets.storeLocalBytes).not.toHaveBeenCalled()
  })

  it('refuses paths, non-pictures, oversized sides and a canvas that saves too often on the byte channel', async () => {
    const stored = { assetId: 'N'.repeat(43), localUrl: `xingmang-asset://image/${'N'.repeat(43)}`, mimeType: 'image/png', fileName: `xingmang-${'N'.repeat(43)}.png` }
    const aiAssets = { copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), listOwnedPage: vi.fn(), storeLocalBytes: vi.fn(async () => stored) }
    const controller = createCanvasWindowController(controllerOptions({ aiAssets: aiAssets as never }))
    await controller.open()
    const importBytes = electronMocks.handlers.get(canvasHostImportAssetBytesChannel)!
    const huge = Buffer.from(projectPng)
    huge.writeUInt32BE(9000, 16)

    await expect(importBytes(trustedEvent(), path.join(temporaryDirectory(), 'mask.png'))).rejects.toThrow('画布图片内容格式错误')
    await expect(importBytes(trustedEvent(), new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).rejects.toThrow('仅支持 PNG、JPEG 或 WebP')
    await expect(importBytes(trustedEvent(), new Uint8Array(huge))).rejects.toThrow('画布图片边长超过 8192')
    expect(aiAssets.storeLocalBytes).not.toHaveBeenCalled()

    // The two refused pictures above already used two of the twenty saves.
    for (let index = 0; index < 18; index += 1) await importBytes(trustedEvent(), new Uint8Array(projectPng))
    await expect(importBytes(trustedEvent(), new Uint8Array(projectPng))).rejects.toThrow('保存图片太频繁')
    expect(aiAssets.storeLocalBytes).toHaveBeenCalledTimes(18)
  })

  it('hands a decoded frame to the run service for this window and account only, after parsing it', async () => {
    const completePreparation = vi.fn(async () => undefined)
    const canvasRuns = { ...controllerOptions().canvasRuns, completePreparation }
    const controller = createCanvasWindowController(controllerOptions({ canvasRuns: canvasRuns as never }))
    await controller.open()
    const complete = electronMocks.handlers.get(canvasHostCompleteRunPreparationChannel)!

    await expect(complete(trustedEvent(), { runId: 'run-1', operationId: 'op-1', kind: 'frame', outcome: 'completed', png: new Uint8Array(projectPng), decodedTimestampSeconds: 1.5 })).resolves.toBeUndefined()
    const [userId, ownerId, completion] = completePreparation.mock.calls[0] as unknown as [number, number, { png: Buffer; decodedTimestampSeconds: number }]
    expect(userId).toBe(7)
    expect(ownerId).toBe(electronMocks.latestWebContents!.id)
    expect(Buffer.isBuffer(completion.png) && completion.png.equals(projectPng)).toBe(true)
    expect(completion.decodedTimestampSeconds).toBe(1.5)

    await expect(complete(trustedEvent(), { runId: 'run-1', operationId: 'op-1', kind: 'frame', outcome: 'completed', png: '/tmp/frame.png' })).rejects.toThrow('视频帧图片内容格式错误')
    await expect(complete(trustedEvent(), { runId: 'run-1', operationId: 'op-1', kind: 'frame', outcome: 'failed', message: '<b>page text</b>' })).rejects.toThrow('画布运行准备回执格式错误')
    expect(() => complete(trustedEvent('https://evil.example/'), { runId: 'run-1', operationId: 'op-1', kind: 'frame', outcome: 'failed' })).toThrow('已拒绝来自非画布页面的操作请求')
    expect(completePreparation).toHaveBeenCalledTimes(1)
  })

  it('offers MP4 in the native media picker', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()

    await electronMocks.handlers.get(canvasHostPickAssetChannel)!(trustedEvent())

    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '画布：选择媒体素材',
      filters: expect.arrayContaining([expect.objectContaining({ name: '视频', extensions: ['mp4'] })]),
    }))
  })

  it('rejects oversized or non-string saveFile input before ever opening a dialog', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostSaveFileChannel)!

    await expect(handler(trustedEvent(), 'export.json', 12345)).rejects.toThrow('保存内容格式错误')
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it('never lets the canvas aim a save dialog at a startup directory', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostSaveFileChannel)!

    // A poisoned canvas build proposes the Windows per-user startup folder, so
    // one click on "save" would leave a payload that runs at the next sign-in.
    await handler(
      trustedEvent(),
      'C:\\Users\\yoyo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\update.cmd',
      '{}',
    )
    expect(lastSaveDialogPath()).toBe('update.cmd.xingcanvas')

    // The macOS equivalent is a LaunchAgent plist run at the next login.
    await handler(trustedEvent(), '/Users/yoyo/Library/LaunchAgents/com.xingmang.update.plist', '{}')
    expect(lastSaveDialogPath()).toBe('com.xingmang.update.plist.xingcanvas')
  })

  it('pins canvas saves to the project file type the canvas actually writes', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostSaveFileChannel)!

    // The canvas chooses the content too, so a free extension would let it
    // propose a script the user later double-clicks.
    await handler(trustedEvent(), 'readme.cmd', '@echo off')
    const options = electronMocks.showSaveDialog.mock.calls.at(-1)?.at(-1) as SaveDialogOptions | undefined
    expect(options?.defaultPath).toBe('readme.cmd.xingcanvas')
    expect(options?.filters).toEqual([{ name: '星芒画布项目', extensions: ['xingcanvas'] }])

    await handler(trustedEvent(), 'xingmang-project.xingcanvas', '{}')
    expect(lastSaveDialogPath()).toBe('xingmang-project.xingcanvas')
    await handler(trustedEvent(), '..', '{}')
    expect(lastSaveDialogPath()).toBe('xingmang-project.xingcanvas')
  })

  it('never lets the canvas aim a project export at a startup directory', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostExportProjectChannel)!

    await handler(trustedEvent(), '../../LaunchAgents/com.xingmang.update.plist', projectWorkflow([]))
    expect(lastSaveDialogPath()).toBe('com.xingmang.update.plist.xingcanvas')

    await handler(trustedEvent(), 'C:\\Users\\yoyo\\Startup\\', projectWorkflow([]))
    expect(lastSaveDialogPath()).toBe('xingmang-project.xingcanvas')
  })

  it('previews then imports a portable project with one-time asset remapping', async () => {
    const oldAssetId = 'A'.repeat(43)
    const newAssetId = 'B'.repeat(43)
    const directory = temporaryDirectory()
    const projectPath = path.join(directory, '测试项目.xingcanvas')
    fs.writeFileSync(projectPath, buildCanvasProjectPackage(projectWorkflow([oldAssetId]), [{
      asset: { assetId: oldAssetId, localUrl: `xingmang-asset://image/${oldAssetId}`, mimeType: 'image/png', fileName: `xingmang-${oldAssetId}.png` },
      bytes: projectPng,
    }]), 'utf8')
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [projectPath] })
    const aiAssets = {
      copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), listOwned: vi.fn(async () => []), readOwned: vi.fn(),
      storeBase64: vi.fn(async () => ({ assetId: newAssetId, localUrl: `xingmang-asset://image/${newAssetId}`, mimeType: 'image/png', fileName: `xingmang-${newAssetId}.png` })),
      removeOwned: vi.fn(async () => undefined),
    }
    const controller = createCanvasWindowController(controllerOptions({ aiAssets: aiAssets as never }))
    await controller.open()

    const preview = await electronMocks.handlers.get(canvasHostPreviewProjectChannel)!(trustedEvent()) as { previewId: string; assetCount: number }
    const imported = await electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId) as { content: string; importedAssetCount: number }

    expect(preview.assetCount).toBe(1)
    // Without project storage and a default folder the import still replaces the open canvas.
    expect(preview).not.toHaveProperty('createsProject')
    expect(imported).not.toHaveProperty('projectId')
    expect(imported.importedAssetCount).toBe(1)
    expect(imported.content).not.toContain(oldAssetId)
    expect(imported.content).toContain(newAssetId)
    expect(aiAssets.storeBase64).toHaveBeenCalledWith(7, expect.stringMatching(/^data:image\/png;base64,/))
    await expect(electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId))
      .rejects.toThrow('预览已失效')
  })

  it('rolls back assets imported before a project transaction fails', async () => {
    const oldAssetIds = ['A'.repeat(43), 'C'.repeat(43)]
    const importedAssetId = 'B'.repeat(43)
    const directory = temporaryDirectory()
    const projectPath = path.join(directory, 'rollback.xingcanvas')
    fs.writeFileSync(projectPath, buildCanvasProjectPackage(projectWorkflow(oldAssetIds), oldAssetIds.map((assetId) => ({
      asset: { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: `xingmang-${assetId}.png` },
      bytes: projectPng,
    }))), 'utf8')
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [projectPath] })
    const removeOwned = vi.fn(async () => undefined)
    const storeBase64 = vi.fn()
      .mockResolvedValueOnce({ assetId: importedAssetId, localUrl: `xingmang-asset://image/${importedAssetId}`, mimeType: 'image/png', fileName: 'first.png' })
      .mockRejectedValueOnce(new Error('磁盘写入失败'))
    const controller = createCanvasWindowController(controllerOptions({
      aiAssets: { copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), listOwned: vi.fn(), readOwned: vi.fn(), storeBase64, removeOwned } as never,
    }))
    await controller.open()
    const preview = await electronMocks.handlers.get(canvasHostPreviewProjectChannel)!(trustedEvent()) as { previewId: string }

    await expect(electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId)).rejects.toThrow('磁盘写入失败')
    expect(removeOwned).toHaveBeenCalledWith(7, importedAssetId)
  })

  it('invalidates a project preview and rolls back imported assets after an account switch', async () => {
    const oldAssetIds = ['A'.repeat(43), 'C'.repeat(43)]
    const importedAssetId = 'B'.repeat(43)
    const directory = temporaryDirectory()
    const projectPath = path.join(directory, 'account-switch.xingcanvas')
    fs.writeFileSync(projectPath, buildCanvasProjectPackage(projectWorkflow(oldAssetIds), oldAssetIds.map((assetId) => ({
      asset: { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: `xingmang-${assetId}.png` },
      bytes: projectPng,
    }))), 'utf8')
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [projectPath] })
    let userId = 7
    const getSessionState = vi.fn(() => ({ authenticated: true, account: { userId } }))
    const removeOwned = vi.fn(async () => undefined)
    const storeBase64 = vi.fn(async () => {
      userId = 9
      return { assetId: importedAssetId, localUrl: `xingmang-asset://image/${importedAssetId}`, mimeType: 'image/png', fileName: 'first.png' }
    })
    const controller = createCanvasWindowController(controllerOptions({
      accountService: { getSessionState } as never,
      aiAssets: { copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), listOwned: vi.fn(), readOwned: vi.fn(), storeBase64, removeOwned } as never,
    }))
    await controller.open()
    const preview = await electronMocks.handlers.get(canvasHostPreviewProjectChannel)!(trustedEvent()) as { previewId: string }

    await expect(electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId))
      .rejects.toThrow('账号已切换')
    expect(storeBase64).toHaveBeenCalledTimes(1)
    expect(removeOwned).toHaveBeenCalledWith(7, importedAssetId)
  })

  it('names an imported project after the package and never after a control character', () => {
    expect(importedCanvasProjectName('  春季海报  ', '/tmp/a.xingcanvas')).toBe('春季海报')
    expect(importedCanvasProjectName('第一行\n第二行\u0000', '/tmp/a.xingcanvas')).toBe('第一行 第二行')
    expect(importedCanvasProjectName('', '/tmp/客户样稿.XINGCANVAS')).toBe('客户样稿')
    expect(importedCanvasProjectName(42, '/tmp/.xingcanvas')).toBe('导入的项目')
    expect(importedCanvasProjectName('\n\t', '/tmp/\t.xingcanvas')).toBe('导入的项目')
    expect(importedCanvasProjectName('图'.repeat(200), '/tmp/a.xingcanvas')).toHaveLength(128)
  })

  describe('importing a project package as a new project', () => {
    const openProjectId = '11111111-1111-4111-8111-111111111111'
    const newProjectId = '33333333-3333-4333-8333-333333333333'
    const oldAssetId = 'A'.repeat(43)
    const newAssetId = 'B'.repeat(43)

    function packageFile(assetIds: readonly string[]): string {
      const projectPath = path.join(temporaryDirectory(), '客户样稿.xingcanvas')
      fs.writeFileSync(projectPath, buildCanvasProjectPackage(projectWorkflow(assetIds), assetIds.map((assetId) => ({
        asset: { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: `xingmang-${assetId}.png` },
        bytes: projectPng,
      }))), 'utf8')
      return projectPath
    }

    function summary(id: string, name: string) {
      return {
        id, name, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
        lastOpenedAt: '2026-11-09T00:00:00.000Z', nodeCount: 1, assetCount: 1,
        workspaceName: name, workspaceConfigured: true, workspaceStatus: 'ready' as CanvasProjectWorkspaceStatus,
      }
    }

    /** A folder's asset store that writes real files, so a rollback can be seen on disk. */
    function folderAssets(directory: string, storeBase64?: (userId: number, dataUrl: string) => Promise<unknown>) {
      const images = {
        ensureOutputDirectory: vi.fn(),
        storeBase64: vi.fn(storeBase64 ?? (async () => {
          fs.mkdirSync(path.join(directory, 'assets', 'user-7'), { recursive: true })
          fs.writeFileSync(path.join(directory, 'assets', 'user-7', `${newAssetId}.png`), projectPng)
          return { assetId: newAssetId, localUrl: `xingmang-asset://image/${newAssetId}`, mimeType: 'image/png', fileName: `xingmang-${newAssetId}.png` }
        })),
        removeOwned: vi.fn(async (_userId: number, assetId: string) => {
          fs.rmSync(path.join(directory, 'assets', 'user-7', `${assetId}.png`), { force: true })
        }),
      }
      return { images, media: { setSource: vi.fn(async () => undefined) } }
    }

    async function openedController(
      createImported: (...args: unknown[]) => Promise<unknown>,
      overrides: Partial<CanvasWindowControllerOptions> = {},
      storeBase64?: (directory: string) => (userId: number, dataUrl: string) => Promise<unknown>,
    ) {
      const created = projectController(createImported, overrides, storeBase64)
      await created.controller.open()
      await electronMocks.handlers.get(canvasHostOpenProjectChannel)!(trustedEvent(), openProjectId)
      return created
    }

    function projectController(
      createImported: (...args: unknown[]) => Promise<unknown>,
      overrides: Partial<CanvasWindowControllerOptions> = {},
      storeBase64?: (directory: string) => (userId: number, dataUrl: string) => Promise<unknown>,
    ) {
      const root = path.join(temporaryDirectory(), '星芒画布')
      const contexts: ReturnType<typeof folderAssets>[] = []
      const forNewWorkspace = vi.fn((directory: string) => {
        const context = folderAssets(directory, storeBase64?.(directory))
        contexts.push(context)
        return context
      })
      const projects = {
        list: vi.fn(async () => []), create: vi.fn(), createImported: vi.fn(createImported),
        open: vi.fn(async (_userId: number, id: string) => ({ project: summary(id, id === newProjectId ? '可移植项目' : '在开的项目'), content: projectWorkflow([]) })),
        save: vi.fn(async (_userId: number, id: string) => summary(id, '在开的项目')),
      }
      const aiAssets = { copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), listOwned: vi.fn(), readOwned: vi.fn(), storeBase64: vi.fn(), removeOwned: vi.fn() }
      const controller = createCanvasWindowController(controllerOptions({
        projects: projects as never,
        projectAssets: { forNewWorkspace, forProject: vi.fn(async () => folderAssets(temporaryDirectory())), forgetProject: vi.fn() } as never,
        defaultProjectsDirectory: () => root,
        aiAssets: aiAssets as never,
        ...overrides,
      }))
      return { controller, root, projects, forNewWorkspace, contexts, aiAssets }
    }

    it('puts the package into a new project in the default folder and leaves the open project alone', async () => {
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [packageFile([oldAssetId])] })
      const { root, projects, forNewWorkspace, contexts, aiAssets } = await openedController(async (_userId, name, directory, content) => ({
        project: summary(newProjectId, String(name)), content, directory,
      }))
      const save = electronMocks.handlers.get(canvasHostSaveProjectChannel)!

      const preview = await electronMocks.handlers.get(canvasHostPreviewProjectChannel)!(trustedEvent()) as { previewId: string; createsProject?: boolean }
      expect(preview.createsProject).toBe(true)
      expect(forNewWorkspace).not.toHaveBeenCalled()
      expect(fs.existsSync(root)).toBe(false)

      const imported = await electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId) as { projectId: string; content: string; importedAssetCount: number }
      const folder = path.join(root, '可移植项目')
      expect(forNewWorkspace).toHaveBeenCalledWith(folder)
      expect(contexts[0]!.images.storeBase64).toHaveBeenCalledWith(7, expect.stringMatching(/^data:image\/png;base64,/))
      expect(contexts[0]!.media.setSource).toHaveBeenCalledWith(7, newAssetId, 'imported')
      expect(aiAssets.storeBase64).not.toHaveBeenCalled()
      expect(projects.createImported).toHaveBeenCalledWith(7, '可移植项目', folder, expect.stringContaining(newAssetId))
      expect(projects.createImported.mock.calls[0]![3]).not.toContain(oldAssetId)
      expect(imported).toMatchObject({ projectId: newProjectId, importedAssetCount: 1 })
      expect(JSON.stringify(imported)).not.toContain(root)

      // The canvas opens the new project itself; until then the one it shows keeps saving.
      await expect(save(trustedEvent(), openProjectId, projectWorkflow([]))).resolves.toMatchObject({ id: openProjectId })
      await expect(save(trustedEvent(), newProjectId, projectWorkflow([]))).rejects.toThrow('只能保存当前打开的画布项目')
      await electronMocks.handlers.get(canvasHostOpenProjectChannel)!(trustedEvent(), newProjectId)
      await expect(save(trustedEvent(), newProjectId, projectWorkflow([]))).resolves.toMatchObject({ id: newProjectId })
      await expect(electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId)).rejects.toThrow('预览已失效')
    })

    it('removes the imported files and the new folder when the project cannot be registered', async () => {
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [packageFile([oldAssetId])] })
      const { root, contexts } = await openedController(async () => { throw new Error('画布项目已达到数量上限') })
      const preview = await electronMocks.handlers.get(canvasHostPreviewProjectChannel)!(trustedEvent()) as { previewId: string }

      await expect(electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId)).rejects.toThrow('画布项目已达到数量上限')
      expect(contexts[0]!.images.removeOwned).toHaveBeenCalledWith(7, newAssetId)
      expect(fs.readdirSync(root)).toEqual([])
    })

    it('stops before registering a project when the account changes during the import', async () => {
      let userId = 7
      const getSessionState = vi.fn(() => ({ authenticated: true, account: { userId } }))
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [packageFile([oldAssetId, 'C'.repeat(43)])] })
      const { root, projects, contexts } = await openedController(async () => { throw new Error('should not register') }, {
        accountService: { getSessionState } as never,
      }, (directory) => async () => {
        userId = 9
        fs.mkdirSync(path.join(directory, 'assets', 'user-7'), { recursive: true })
        fs.writeFileSync(path.join(directory, 'assets', 'user-7', `${newAssetId}.png`), projectPng)
        return { assetId: newAssetId, localUrl: `xingmang-asset://image/${newAssetId}`, mimeType: 'image/png', fileName: 'first.png' }
      })
      const preview = await electronMocks.handlers.get(canvasHostPreviewProjectChannel)!(trustedEvent()) as { previewId: string }

      await expect(electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId)).rejects.toThrow('账号已切换')
      expect(contexts[0]!.images.storeBase64).toHaveBeenCalledTimes(1)
      expect(projects.createImported).not.toHaveBeenCalled()
      expect(contexts[0]!.images.removeOwned).toHaveBeenCalledWith(7, newAssetId)
      expect(fs.readdirSync(root)).toEqual([])
    })

    it('says the import did not happen when the default folder cannot be made', async () => {
      const blocked = path.join(temporaryDirectory(), 'blocked')
      fs.writeFileSync(blocked, '')
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [packageFile([oldAssetId])] })
      const { projects, forNewWorkspace } = await openedController(async () => { throw new Error('should not register') }, {
        defaultProjectsDirectory: () => path.join(blocked, '星芒画布'),
      })
      const preview = await electronMocks.handlers.get(canvasHostPreviewProjectChannel)!(trustedEvent()) as { previewId: string }

      await expect(electronMocks.handlers.get(canvasHostImportProjectChannel)!(trustedEvent(), preview.previewId))
        .rejects.toThrow(/^没能在「星芒画布」文件夹里建项目（.+），这次没有导入$/)
      expect(forNewWorkspace).not.toHaveBeenCalled()
      expect(projects.createImported).not.toHaveBeenCalled()
    })

    describe('opening a project file the system handed over (double-click, D92)', () => {
      function importsNewProject(_userId: unknown, name: unknown, directory: unknown, content: unknown) {
        return Promise.resolve({ project: summary(newProjectId, String(name)), content, directory })
      }

      function loadedProjectId(window: Record<string, unknown> | null): string | null {
        const loadURL = window!.loadURL as ReturnType<typeof vi.fn>
        return new URL(loadURL.mock.calls.at(-1)![0] as string).searchParams.get('project')
      }

      function latestCloseRequestId(): string | undefined {
        const send = electronMocks.latestWebContents!.send as ReturnType<typeof vi.fn>
        return [...send.mock.calls].reverse().find(([channel]) => channel === canvasHostChannels.closeRequested)?.[1].requestId
      }

      it('imports the file as a new project and opens the canvas on it, without any dialog', async () => {
        const { controller, root, projects, contexts } = projectController(importsNewProject)

        await expect(controller.openProjectFile(packageFile([oldAssetId]))).resolves.toBe(true)
        const folder = path.join(root, '可移植项目')
        expect(projects.createImported).toHaveBeenCalledWith(7, '可移植项目', folder, expect.stringContaining(newAssetId))
        expect(contexts[0]!.media.setSource).toHaveBeenCalledWith(7, newAssetId, 'imported')
        expect(electronMocks.browserWindowOptions).toHaveLength(1)
        expect(loadedProjectId(electronMocks.latestBrowserWindow)).toBe(newProjectId)
        expect(electronMocks.showOpenDialog).not.toHaveBeenCalled()
        expect(electronMocks.showMessageBox).not.toHaveBeenCalled()
      })

      it('lets an open canvas save and close through its own confirmation before switching to the new project', async () => {
        const { controller, projects } = await openedController(importsNewProject)
        const firstWindow = electronMocks.latestBrowserWindow!

        const opening = controller.openProjectFile(packageFile([oldAssetId]))
        await vi.waitFor(() => expect(latestCloseRequestId()).toBeDefined())
        expect(projects.createImported).not.toHaveBeenCalled()
        expect(electronMocks.handlers.get(canvasHostChannels.finishClose)!(trustedEvent(), latestCloseRequestId(), true)).toBe(true)

        await expect(opening).resolves.toBe(true)
        expect(firstWindow.close).toHaveBeenCalledOnce()
        expect(projects.createImported).toHaveBeenCalledOnce()
        expect(electronMocks.latestBrowserWindow).not.toBe(firstWindow)
        expect(loadedProjectId(electronMocks.latestBrowserWindow)).toBe(newProjectId)
      })

      it('stays on the open project and imports nothing when the user keeps the canvas open', async () => {
        const { controller, projects, forNewWorkspace } = await openedController(importsNewProject)
        const firstWindow = electronMocks.latestBrowserWindow!
        const shown = (firstWindow.show as ReturnType<typeof vi.fn>).mock.calls.length

        const opening = controller.openProjectFile(packageFile([oldAssetId]))
        await vi.waitFor(() => expect(latestCloseRequestId()).toBeDefined())
        electronMocks.handlers.get(canvasHostChannels.finishClose)!(trustedEvent(), latestCloseRequestId(), false)

        await expect(opening).resolves.toBe(false)
        expect(firstWindow.close).not.toHaveBeenCalled()
        expect((firstWindow.show as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(shown)
        expect(forNewWorkspace).not.toHaveBeenCalled()
        expect(projects.createImported).not.toHaveBeenCalled()
        expect(electronMocks.browserWindowOptions).toHaveLength(1)
      })

      it('refuses a broken file before it touches the open canvas', async () => {
        const { controller, projects } = await openedController(importsNewProject)
        const broken = path.join(temporaryDirectory(), '坏的.xingcanvas')
        fs.writeFileSync(broken, '{not json', 'utf8')

        await expect(controller.openProjectFile(broken)).rejects.toThrow('画布项目文件不是有效 JSON')
        expect(latestCloseRequestId()).toBeUndefined()
        expect(projects.createImported).not.toHaveBeenCalled()
      })

      it('checks the path the way it checks a dropped file: absolute, the right kind, one link, no links on the way', async () => {
        const { controller, projects } = projectController(importsNewProject)
        const original = packageFile([oldAssetId])
        const hardLink = path.join(temporaryDirectory(), '硬链接.xingcanvas')
        fs.linkSync(original, hardLink)
        const renamed = path.join(temporaryDirectory(), '样稿.json')
        fs.copyFileSync(original, renamed)

        await expect(controller.openProjectFile('样稿.xingcanvas')).rejects.toThrow('画布项目文件路径无效')
        await expect(controller.openProjectFile(renamed)).rejects.toThrow('画布项目文件路径无效')
        await expect(controller.openProjectFile(hardLink)).rejects.toThrow('画布项目文件不安全')
        expect(projects.createImported).not.toHaveBeenCalled()
        expect(electronMocks.browserWindowOptions).toHaveLength(0)
      })

      it.runIf(process.platform !== 'win32')('refuses a file reached through a link', async () => {
        const { controller, projects } = projectController(importsNewProject)
        const original = packageFile([oldAssetId])
        const linkedFolder = path.join(temporaryDirectory(), 'linked')
        fs.symlinkSync(path.dirname(original), linkedFolder)
        const linkedFile = path.join(temporaryDirectory(), '链接.xingcanvas')
        fs.symlinkSync(original, linkedFile)

        await expect(controller.openProjectFile(path.join(linkedFolder, path.basename(original)))).rejects.toThrow('不能经过符号链接或目录联接')
        await expect(controller.openProjectFile(linkedFile)).rejects.toThrow('不能经过符号链接或目录联接')
        expect(projects.createImported).not.toHaveBeenCalled()
      })

      it('needs a signed-in account and does not import for an account that changed while the canvas was closing', async () => {
        const signedOut = projectController(importsNewProject, {
          accountService: { getSessionState: vi.fn(() => ({ authenticated: false, account: null })) } as never,
        })
        await expect(signedOut.controller.openProjectFile(packageFile([oldAssetId]))).rejects.toThrow('请先登录星芒账号')

        let userId = 7
        const { controller, projects } = await openedController(importsNewProject, {
          accountService: { getSessionState: vi.fn(() => ({ authenticated: true, account: { userId } })) } as never,
        })
        const opening = controller.openProjectFile(packageFile([oldAssetId]))
        await vi.waitFor(() => expect(latestCloseRequestId()).toBeDefined())
        userId = 9
        electronMocks.handlers.get(canvasHostChannels.finishClose)!(trustedEvent(), latestCloseRequestId(), true)
        await expect(opening).rejects.toThrow('账号已切换')
        expect(projects.createImported).not.toHaveBeenCalled()
      })
    })
  })

  it('publishes run events only to their originating window while its account is still active', async () => {
    let activeUserId = 7
    let listener: ((publication: { event: unknown; userId: number; ownerId: number }) => void) | undefined
    const canvasRuns = {
      start: vi.fn(), cancel: vi.fn(), cancelOwner: vi.fn(), listRuns: vi.fn(async () => []),
      getAssetLineage: vi.fn(async () => ({})),
      subscribe: vi.fn((next: typeof listener) => { listener = next; return () => undefined }),
    }
    const controller = createCanvasWindowController(controllerOptions({
      accountService: { getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: activeUserId } })) } as never,
      canvasRuns: canvasRuns as never,
    }))
    await controller.open()
    const send = electronMocks.latestWebContents!.send as ReturnType<typeof vi.fn>
    const event = { type: 'node-state', runId: 'run-1' }

    listener?.({ event, userId: 7, ownerId: 99 })
    activeUserId = 9
    listener?.({ event, userId: 7, ownerId: 41 })
    listener?.({ event, userId: 9, ownerId: 41 })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(canvasHostRunEventChannel, event)
  })

  it('delegates group, image and asset operations without returning API keys', async () => {
    const chatCredentials = {
      listGroups: vi.fn(async () => [{ name: '生图分组', description: '图片', ratio: 1 }]),
      prepareGroup: vi.fn(async (group: string) => ({ group, models: ['gpt-image-1'], keyCreated: true })),
      resolveCredential: vi.fn(),
    }
    const imageService = {
      generate: vi.fn(async () => [{ assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }]),
      edit: vi.fn(async () => [{ assetId: 'b'.repeat(43), localUrl: `xingmang-asset://image/${'b'.repeat(43)}` }]),
      cancel: vi.fn(() => ({ canceled: true, mayStillComplete: false })),
      cancelSender: vi.fn(() => 0),
    }
    const aiAssets = {
      copy: vi.fn(async () => undefined),
      saveAs: vi.fn(async () => true),
      contextMenu: vi.fn(async () => undefined),
      listOwned: vi.fn(async () => []),
      listOwnedPage: vi.fn(async () => ({ items: [], offset: 24, limit: 24, total: 25, hasMore: false })),
    }
    const mediaAssets = {
      listOwnedPage: vi.fn(async () => ({ items: [], offset: 24, limit: 24, total: 25, hasMore: false })),
      copy: vi.fn(async () => undefined), saveAs: vi.fn(async () => true), contextMenu: vi.fn(async () => undefined),
      rename: vi.fn(async (_userId: number, assetId: string, displayName: string) => ({ assetId, displayName })),
      updateMetadata: vi.fn(async (_userId: number, assetId: string, metadata: { favorite?: boolean; tags?: string[] }) => ({
        assetId, favorite: metadata.favorite ?? false, tags: metadata.tags ?? [],
      })),
      markUsed: vi.fn(async (_userId: number, assetId: string) => ({ assetId, lastUsedAt: '2026-08-19T00:00:00.000Z' })),
      setSource: vi.fn(),
    }
    const controller = createCanvasWindowController(controllerOptions({
      chatCredentials,
      imageService: imageService as never,
      aiAssets: aiAssets as never,
      mediaAssets: mediaAssets as never,
    }))
    await controller.open()

    const groups = await electronMocks.handlers.get(canvasHostListGroupsChannel)!(trustedEvent())
    const prepared = await electronMocks.handlers.get(canvasHostPrepareGroupChannel)!(trustedEvent(), '生图分组')
    const generated = await electronMocks.handlers.get(canvasHostGenerateImageChannel)!(trustedEvent(), {
      requestId: 'request-1', group: '生图分组', model: 'gpt-image-1', prompt: '星空',
    })
    const edited = await electronMocks.handlers.get(canvasHostEditImageChannel)!(trustedEvent(), {
      requestId: 'edit-1', group: '生图分组', model: 'gpt-image-1', prompt: '改成夜景',
      sourceAssetIds: ['a'.repeat(43)],
    })
    await electronMocks.handlers.get(canvasHostCopyAssetChannel)!(trustedEvent(), 'a'.repeat(43))
    await expect(electronMocks.handlers.get(canvasHostSaveAssetChannel)!(trustedEvent(), 'a'.repeat(43)))
      .resolves.toEqual({ saved: true })
    await expect(electronMocks.handlers.get(canvasHostListAssetsChannel)!(trustedEvent(), {
      offset: 24, limit: 24, mediaType: 'image', search: '产品',
    })).resolves.toMatchObject({ offset: 24, total: 25 })
    await expect(electronMocks.handlers.get(canvasHostRenameAssetChannel)!(trustedEvent(), {
      assetId: 'a'.repeat(43), displayName: ' 产品主视觉 ',
    })).resolves.toEqual({ assetId: 'a'.repeat(43), displayName: '产品主视觉' })
    await expect(electronMocks.handlers.get(canvasHostUpdateAssetMetadataChannel)!(trustedEvent(), {
      assetId: 'a'.repeat(43), favorite: true, tags: [' 产品 '],
    })).resolves.toEqual({ assetId: 'a'.repeat(43), favorite: true, tags: ['产品'] })
    await expect(electronMocks.handlers.get(canvasHostMarkAssetUsedChannel)!(trustedEvent(), 'a'.repeat(43)))
      .resolves.toEqual({ assetId: 'a'.repeat(43), lastUsedAt: '2026-08-19T00:00:00.000Z' })

    expect(JSON.stringify({ groups, prepared, generated, edited })).not.toContain('apiKey')
    expect(imageService.generate).toHaveBeenCalledWith(41, expect.objectContaining({ requestId: 'request-1', expectedUserId: 7 }))
    expect(imageService.edit).toHaveBeenCalledWith(41, {
      requestId: 'edit-1', group: '生图分组', model: 'gpt-image-1', prompt: '改成夜景',
      sourceAssetIds: ['a'.repeat(43)], expectedUserId: 7,
    })
    expect(mediaAssets.copy).toHaveBeenCalledWith(7, 'a'.repeat(43), expect.any(Function))
    expect(mediaAssets.listOwnedPage).toHaveBeenCalledWith(7, { offset: 24, limit: 24, mediaType: 'image', search: '产品' })
    expect(mediaAssets.rename).toHaveBeenCalledWith(7, 'a'.repeat(43), '产品主视觉')
    expect(mediaAssets.updateMetadata).toHaveBeenCalledWith(7, 'a'.repeat(43), { favorite: true, tags: ['产品'] })
    expect(mediaAssets.markUsed).toHaveBeenCalledWith(7, 'a'.repeat(43))
  })

  it('rejects group reads and preparation that finish after an account switch', async () => {
    let userId = 7
    let releaseGroups!: (value: Array<{ name: string; description: string; ratio: number }>) => void
    let releasePrepared!: (value: { group: string; models: string[]; keyCreated: boolean }) => void
    const listGroups = vi.fn(() => new Promise<Array<{ name: string; description: string; ratio: number }>>((resolve) => { releaseGroups = resolve }))
    const prepareGroup = vi.fn(() => new Promise<{ group: string; models: string[]; keyCreated: boolean }>((resolve) => { releasePrepared = resolve }))
    const controller = createCanvasWindowController(controllerOptions({
      accountService: { getSessionState: vi.fn(() => ({ authenticated: true, account: { userId } })) } as never,
      chatCredentials: { listGroups, prepareGroup, resolveCredential: vi.fn() },
    }))
    await controller.open()
    controller.setAccountUser(7)

    const groupsPending = electronMocks.handlers.get(canvasHostListGroupsChannel)!(trustedEvent())
    await vi.waitFor(() => expect(listGroups).toHaveBeenCalledTimes(1))
    userId = 9
    controller.setAccountUser(9)
    releaseGroups([{ name: '旧账号分组', description: '', ratio: 1 }])
    await expect(groupsPending).rejects.toThrow('账号已切换')

    userId = 7
    controller.setAccountUser(7)
    const preparedPending = electronMocks.handlers.get(canvasHostPrepareGroupChannel)!(trustedEvent(), '旧账号分组')
    await vi.waitFor(() => expect(prepareGroup).toHaveBeenCalledTimes(1))
    userId = 9
    controller.setAccountUser(9)
    releasePrepared({ group: '旧账号分组', models: ['gpt-image-2'], keyCreated: false })
    await expect(preparedPending).rejects.toThrow('账号已切换')
  })

  it('holds every asset channel to the same identifier shape', async () => {
    // copy, save and the context menu used to accept any string up to 64
    // characters while the rest demanded the 43 character asset id. The stores
    // caught the difference, but two validation strengths for one identifier is
    // how a gap eventually gets through.
    const mediaAssets = {
      copy: vi.fn(async () => undefined),
      saveAs: vi.fn(async () => true),
      contextMenu: vi.fn(async () => undefined),
      markUsed: vi.fn(async () => ({ assetId: 'a', lastUsedAt: '2026-08-19T00:00:00.000Z' })),
      softDelete: vi.fn(async () => ({ assetId: 'a', deletedAt: '2026-08-19T00:00:00.000Z' })),
      restore: vi.fn(async () => ({ assetId: 'a' })),
    }
    const controller = createCanvasWindowController(controllerOptions({ mediaAssets: mediaAssets as never }))
    await controller.open()

    for (const channel of [
      canvasHostCopyAssetChannel,
      canvasHostSaveAssetChannel,
      canvasHostShowAssetMenuChannel,
      canvasHostMarkAssetUsedChannel,
      canvasHostDeleteAssetChannel,
      canvasHostRestoreAssetChannel,
    ]) {
      for (const rejected of ['../secrets', 'a'.repeat(44), 'a'.repeat(42), `${'a'.repeat(42)}/`, '']) {
        await expect(electronMocks.handlers.get(channel)!(trustedEvent(), rejected)).rejects.toThrow(/画布资产标识/)
      }
    }
    expect(mediaAssets.copy).not.toHaveBeenCalled()
    expect(mediaAssets.saveAs).not.toHaveBeenCalled()
    expect(mediaAssets.contextMenu).not.toHaveBeenCalled()
    expect(mediaAssets.markUsed).not.toHaveBeenCalled()
    expect(mediaAssets.softDelete).not.toHaveBeenCalled()
    expect(mediaAssets.restore).not.toHaveBeenCalled()
  })

  it('rejects a completed asset rename when the account changes in flight', async () => {
    let activeUserId = 7
    let release!: (value: { assetId: string; displayName: string }) => void
    const rename = vi.fn((_userId: number, assetId: string, displayName: string) => new Promise((resolve) => {
      release = resolve
    }))
    const controller = createCanvasWindowController(controllerOptions({
      accountService: { getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: activeUserId } })) } as never,
      mediaAssets: {
        listOwnedPage: vi.fn(), copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), rename,
      } as never,
    }))
    await controller.open()
    const pending = electronMocks.handlers.get(canvasHostRenameAssetChannel)!(trustedEvent(), {
      assetId: 'a'.repeat(43), displayName: '新名称',
    })
    await vi.waitFor(() => expect(rename).toHaveBeenCalled())
    activeUserId = 8
    release({ assetId: 'a'.repeat(43), displayName: '新名称' })
    await expect(pending).rejects.toThrow('账号已切换')
  })

  it('does not return a completed asset metadata mutation after the account changes', async () => {
    let activeUserId = 7
    let release!: (value: { assetId: string; favorite: boolean; tags: string[] }) => void
    const updateMetadata = vi.fn((_userId: number, assetId: string) => new Promise((resolve) => {
      release = resolve
    }))
    const controller = createCanvasWindowController(controllerOptions({
      accountService: { getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: activeUserId } })) } as never,
      mediaAssets: {
        listOwnedPage: vi.fn(), copy: vi.fn(), saveAs: vi.fn(), contextMenu: vi.fn(), rename: vi.fn(),
        updateMetadata, markUsed: vi.fn(), setSource: vi.fn(),
      } as never,
    }))
    await controller.open()
    const pending = electronMocks.handlers.get(canvasHostUpdateAssetMetadataChannel)!(trustedEvent(), {
      assetId: 'a'.repeat(43), favorite: true,
    })
    await vi.waitFor(() => expect(updateMetadata).toHaveBeenCalled())
    activeUserId = 8
    release({ assetId: 'a'.repeat(43), favorite: true, tags: [] })
    await expect(pending).rejects.toThrow('账号已切换')
  })

  it('delegates video generation without exposing credentials and cancels through the shared request channel', async () => {
    const videoService = {
      generate: vi.fn(async () => ({
        assetId: 'v'.repeat(43), localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
        mimeType: 'video/mp4', fileName: 'video.mp4', taskId: 'video_123',
      })),
      cancel: vi.fn(() => ({ canceled: true, mayStillComplete: true })),
      cancelSender: vi.fn(() => 0), cancelUser: vi.fn(() => 0), resumeUser: vi.fn(async () => []),
      resumeVideoTask: vi.fn(),
    }
    const controller = createCanvasWindowController(controllerOptions({ videoService: videoService as never }))
    await controller.open()
    const result = await electronMocks.handlers.get(canvasHostGenerateVideoChannel)!(trustedEvent(), {
      requestId: 'video-1', group: '生图分组', model: 'grok-imagine-video', prompt: '海浪', seconds: '5',
    })
    const canceled = await electronMocks.handlers.get(canvasHostCancelRequestChannel)!(trustedEvent(), 'video-1')
    expect(result).toMatchObject({ taskId: 'video_123', mimeType: 'video/mp4' })
    expect(JSON.stringify(result)).not.toMatch(/apiKey|accessToken|refreshToken/)
    expect(videoService.generate).toHaveBeenCalledWith(41, expect.objectContaining({ expectedUserId: 7 }))
    expect(canceled).toEqual({ canceled: true, mayStillComplete: true })
  })

  it('resumes only one validated task id for the current account', async () => {
    const asset = {
      assetId: 'v'.repeat(43), localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
      mimeType: 'video/mp4', fileName: 'video.mp4', taskId: 'video_resume_1',
    }
    const videoService = {
      generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
      cancelSender: vi.fn(() => 0), cancelUser: vi.fn(() => 0), resumeUser: vi.fn(async () => []),
      resumeVideoTask: vi.fn(async () => asset),
    }
    const controller = createCanvasWindowController(controllerOptions({ videoService: videoService as never }))
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostResumeVideoTaskChannel)!

    await expect(handler(trustedEvent(), 'video_resume_1')).resolves.toEqual(asset)
    await expect(handler(trustedEvent(), { taskId: 'video_resume_1' })).rejects.toThrow('任务标识格式错误')
    expect(videoService.resumeVideoTask).toHaveBeenCalledTimes(1)
    expect(videoService.resumeVideoTask).toHaveBeenCalledWith(41, 7, 'video_resume_1')
    expect(videoService.generate).not.toHaveBeenCalled()
  })

  it('does not return a resumed video asset after the active account changes', async () => {
    let activeUserId = 7
    let release!: (value: unknown) => void
    const resumeVideoTask = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const controller = createCanvasWindowController(controllerOptions({
      accountService: {
        getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: activeUserId } })),
      } as never,
      videoService: {
        generate: vi.fn(), cancel: vi.fn(() => ({ canceled: false, mayStillComplete: false })),
        cancelSender: vi.fn(() => 0), cancelUser: vi.fn(() => 0), resumeUser: vi.fn(async () => []),
        resumeVideoTask,
      } as never,
    }))
    await controller.open()
    const pending = electronMocks.handlers.get(canvasHostResumeVideoTaskChannel)!(trustedEvent(), 'video_resume_1')
    await vi.waitFor(() => expect(resumeVideoTask).toHaveBeenCalledWith(41, 7, 'video_resume_1'))
    activeUserId = 8
    release({
      assetId: 'v'.repeat(43), localUrl: `xingmang-asset://video/${'v'.repeat(43)}`,
      mimeType: 'video/mp4', fileName: 'video.mp4', taskId: 'video_resume_1',
    })
    await expect(pending).rejects.toThrow('账号已切换')
  })

  it('scopes prompt preset CRUD to the current account and returns no credentials', async () => {
    const promptPresets = {
      list: vi.fn(async () => [{ id: 'preset-id-0000000000000001', name: '商品', prompt: '棚拍', tags: [], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z', provenance: 'user-created' }]),
      create: vi.fn(async (_userId: number, input: unknown) => ({ id: 'preset-id-0000000000000002', ...(input as object), tags: [], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z', provenance: 'user-created' })),
      update: vi.fn(async (_userId: number, input: unknown) => ({ ...(input as object), prompt: '更新', tags: [], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:01:00.000Z', provenance: 'user-created' })),
      delete: vi.fn(async () => true),
    }
    const controller = createCanvasWindowController(controllerOptions({ promptPresets: promptPresets as never }))
    await controller.open()

    const listed = await electronMocks.handlers.get(canvasHostListPromptPresetsChannel)!(trustedEvent())
    const created = await electronMocks.handlers.get(canvasHostCreatePromptPresetChannel)!(trustedEvent(), { name: '商品', prompt: '棚拍' })
    const updated = await electronMocks.handlers.get(canvasHostUpdatePromptPresetChannel)!(trustedEvent(), { id: 'preset-id-0000000000000002', prompt: '更新' })
    const deleted = await electronMocks.handlers.get(canvasHostDeletePromptPresetChannel)!(trustedEvent(), 'preset-id-0000000000000002')

    expect(promptPresets.list).toHaveBeenCalledWith(7)
    expect(promptPresets.create).toHaveBeenCalledWith(7, { name: '商品', prompt: '棚拍' })
    expect(promptPresets.update).toHaveBeenCalledWith(7, { id: 'preset-id-0000000000000002', prompt: '更新' })
    expect(promptPresets.delete).toHaveBeenCalledWith(7, 'preset-id-0000000000000002')
    expect(deleted).toBe(true)
    expect(JSON.stringify({ listed, created, updated })).not.toMatch(/apiKey|accessToken|refreshToken/)
  })

  it('rejects a prompt preset mutation if the account changes before it completes', async () => {
    let activeUserId = 7
    let release!: (value: unknown) => void
    const create = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const controller = createCanvasWindowController(controllerOptions({
      accountService: { getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: activeUserId } })) } as never,
      promptPresets: { list: vi.fn(), create, update: vi.fn(), delete: vi.fn() } as never,
    }))
    await controller.open()
    const pending = electronMocks.handlers.get(canvasHostCreatePromptPresetChannel)!(trustedEvent(), { name: '预设', prompt: '内容' })
    await vi.waitFor(() => expect(create).toHaveBeenCalled())
    activeUserId = 8
    release({ id: 'preset-id-0000000000000001' })
    await expect(pending).rejects.toThrow('账号已切换')
  })

  it('dispose() removes every handle channel', () => {
    const controller = createCanvasWindowController(controllerOptions())

    controller.dispose()

    for (const channel of Object.values({
      canvasHostSaveFileChannel, canvasHostPickFileChannel, canvasHostNotifyChannel,
      canvasHostOpenExternalChannel, canvasHostListGroupsChannel, canvasHostPrepareGroupChannel,
      canvasHostGenerateImageChannel, canvasHostCancelRequestChannel, canvasHostCopyAssetChannel,
      canvasHostGenerateVideoChannel,
      canvasHostResumeVideoTaskChannel,
      canvasHostEditImageChannel,
      canvasHostCreatePromptPresetChannel, canvasHostDeletePromptPresetChannel,
      canvasHostSaveAssetChannel, canvasHostShowAssetMenuChannel, canvasHostListAssetsChannel,
      canvasHostRenameAssetChannel,
      canvasHostUpdateAssetMetadataChannel, canvasHostMarkAssetUsedChannel,
      canvasHostDeleteAssetChannel, canvasHostRestoreAssetChannel, canvasHostPurgeAssetChannel,
      canvasHostStartRunChannel, canvasHostCancelRunChannel, canvasHostListRunsChannel,
      canvasHostExportProjectChannel, canvasHostPreviewProjectChannel, canvasHostImportProjectChannel,
      canvasHostListPromptPresetsChannel, canvasHostUpdatePromptPresetChannel,
    })) {
      expect(electronMocks.removeHandler).toHaveBeenCalledWith(channel)
    }
  })
})

describe('canvasRendererAnswers', () => {
  it('answers true when the page runs the script, even with an error, and false when it never settles', async () => {
    expect(await canvasRendererAnswers({ executeJavaScript: vi.fn(async () => 1) }, 50)).toBe(true)
    expect(await canvasRendererAnswers({ executeJavaScript: vi.fn(async () => { throw new Error('blocked') }) }, 50)).toBe(true)
    expect(await canvasRendererAnswers({ executeJavaScript: vi.fn(() => new Promise<never>(() => undefined)) }, 50)).toBe(false)
    expect(await canvasRendererAnswers({ executeJavaScript: vi.fn(() => { throw new Error('destroyed') }) }, 50)).toBe(true)
  })
})

describe('canvas close confirmation', () => {
  function latestRequestId(): string {
    const send = electronMocks.latestWebContents!.send as ReturnType<typeof vi.fn>
    return [...send.mock.calls].reverse().find(([channel]) => channel === canvasHostChannels.closeRequested)![1].requestId
  }

  it('resolves an unopened canvas without asking a renderer', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    expect(await controller.requestClose()).toBe(true)
  })

  it('fails open when the canvas closes before the React close guard is ready', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'did-start-loading')![1]()

    expect(await controller.requestClose()).toBe(true)
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('shares repeated close requests and waits for the current renderer acknowledgement', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const first = controller.requestClose()
    expect(controller.requestClose()).toBe(first)
    expect(electronMocks.latestBrowserWindow!.close).not.toHaveBeenCalled()
    const handler = electronMocks.handlers.get(canvasHostChannels.finishClose)!
    expect(handler(trustedEvent(), latestRequestId(), true)).toBe(true)
    expect(await first).toBe(true)
    expect(electronMocks.latestBrowserWindow!.close).toHaveBeenCalledOnce()
  })

  it('retains the same window when the renderer cancels or reports a save failure', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const closing = controller.requestClose()
    const requestId = latestRequestId()
    electronMocks.handlers.get(canvasHostChannels.finishClose)!(trustedEvent(), requestId, false)
    expect(await closing).toBe(false)
    expect(electronMocks.latestBrowserWindow!.close).not.toHaveBeenCalled()
    expect(electronMocks.latestWebContents!.send).toHaveBeenCalledWith(canvasHostChannels.closeCancelled, { requestId })
  })

  it('does not resolve success until the native window actually emits closed', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    ;(window.close as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const closing = controller.requestClose()
    let resolved = false
    void closing.then(() => { resolved = true })
    electronMocks.handlers.get(canvasHostChannels.finishClose)!(trustedEvent(), latestRequestId(), true)
    await Promise.resolve()
    expect(resolved).toBe(false)
    const on = window.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'closed')![1]()
    expect(await closing).toBe(true)
  })

  it('routes the native X button through confirmation instead of destroying the renderer', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    ;(window.close as () => void)()
    expect((window.isDestroyed as () => boolean)()).toBe(false)
    const closing = controller.requestClose()
    electronMocks.handlers.get(canvasHostChannels.finishClose)!(trustedEvent(), latestRequestId(), true)
    expect(await closing).toBe(true)
    expect((window.isDestroyed as () => boolean)()).toBe(true)
  })

  it('fails closed on timeout and rejects expired acknowledgements during a newer request', async () => {
    vi.useFakeTimers()
    try {
      const controller = createCanvasWindowController(controllerOptions({ closeRequestTimeoutMs: 100 }))
      await controller.open()
      const first = controller.requestClose()
      const expiredId = latestRequestId()
      await vi.advanceTimersByTimeAsync(100)
      expect(await first).toBe(false)
      const next = controller.requestClose()
      const nextId = latestRequestId()
      expect(nextId).not.toBe(expiredId)
      const handler = electronMocks.handlers.get(canvasHostChannels.finishClose)!
      expect(handler(trustedEvent(), expiredId, true)).toBe(false)
      expect(electronMocks.latestBrowserWindow!.close).not.toHaveBeenCalled()
      handler(trustedEvent(), nextId, false)
      expect(await next).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('rejects another window and permits task cancellation only for the active close nonce', async () => {
    const options = controllerOptions()
    const controller = createCanvasWindowController(options)
    await controller.open()
    const closing = controller.requestClose()
    const requestId = latestRequestId()
    const finish = electronMocks.handlers.get(canvasHostChannels.finishClose)!
    const cancelTasks = electronMocks.handlers.get(canvasHostChannels.cancelCloseTasks)!
    expect(() => finish(foreignEvent(), requestId, true)).toThrow('非画布页面')
    expect(() => cancelTasks(foreignEvent(), requestId)).toThrow('非画布页面')
    expect(cancelTasks(trustedEvent(), 'expired')).toBe(false)
    expect(options.canvasRuns.cancelOwner).not.toHaveBeenCalled()
    expect(cancelTasks(trustedEvent(), requestId)).toBe(true)
    expect(options.canvasRuns.cancelOwner).toHaveBeenCalledExactlyOnceWith(41)
    expect(options.imageService.cancelSender).toHaveBeenCalledExactlyOnceWith(41)
    expect(options.videoService.cancelSender).toHaveBeenCalledExactlyOnceWith(41)
    finish(trustedEvent(), requestId, false)
    expect(await closing).toBe(false)
    expect(cancelTasks(trustedEvent(), requestId)).toBe(false)
  })

  it('destroys a canvas page that does not answer when the app quits, instead of waiting out the close handshake', async () => {
    vi.useFakeTimers()
    try {
      const runtimeLog = { log: vi.fn(), exception: vi.fn() }
      const controller = createCanvasWindowController(controllerOptions({ runtimeLog: runtimeLog as never }))
      await controller.open()
      const window = electronMocks.latestBrowserWindow!
      // A page stuck in a loop never settles the script it is asked to run.
      ;(electronMocks.latestWebContents!.executeJavaScript as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => undefined))
      let result: boolean | undefined
      void controller.requestCloseForQuit().then((value) => { result = value })
      await vi.advanceTimersByTimeAsync(3_999)
      expect(result).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(result).toBe(true)
      expect(window.destroy).toHaveBeenCalledOnce()
      expect(electronMocks.latestWebContents!.send).not.toHaveBeenCalledWith(canvasHostChannels.closeRequested, expect.anything())
      expect(runtimeLog.log).toHaveBeenCalledWith('warn', 'canvas', 'close.unresponsive', '画布没响应，退出时直接关掉', { waitedMs: 4_000 })
    } finally { vi.useRealTimers() }
  })

  it('keeps the normal close handshake on quit when the canvas page answers, and waits for the user there', async () => {
    vi.useFakeTimers()
    try {
      const controller = createCanvasWindowController(controllerOptions())
      await controller.open()
      const window = electronMocks.latestBrowserWindow!
      let result: boolean | undefined
      void controller.requestCloseForQuit().then((value) => { result = value })
      await vi.advanceTimersByTimeAsync(0)
      const requestId = latestRequestId()
      // The page is showing its running-tasks dialog: no answer yet, and the quit check is long over.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(result).toBeUndefined()
      expect(window.destroy).not.toHaveBeenCalled()
      electronMocks.handlers.get(canvasHostChannels.finishClose)!(trustedEvent(), requestId, false)
      await vi.advanceTimersByTimeAsync(0)
      expect(result).toBe(false)
      expect(window.destroy).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('treats a page that answers the quit check with an error as alive', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    ;(electronMocks.latestWebContents!.executeJavaScript as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Script failed to execute'))
    const closing = controller.requestCloseForQuit()
    await vi.waitFor(() => expect(electronMocks.latestWebContents!.send).toHaveBeenCalledWith(canvasHostChannels.closeRequested, expect.anything()))
    electronMocks.handlers.get(canvasHostChannels.finishClose)!(trustedEvent(), latestRequestId(), true)
    expect(await closing).toBe(true)
    expect(electronMocks.latestBrowserWindow!.destroy).not.toHaveBeenCalled()
  })

  it('does not run the quit check when no canvas is open or its renderer is already gone', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    expect(await controller.requestCloseForQuit()).toBe(true)
    await controller.open()
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'render-process-gone')![1]({}, { reason: 'crashed', exitCode: 1 })
    expect(await controller.requestCloseForQuit()).toBe(true)
    expect(electronMocks.latestWebContents!.executeJavaScript).not.toHaveBeenCalled()
    expect(electronMocks.latestBrowserWindow!.destroy).toHaveBeenCalledOnce()
  })

  it('invalidates the pending handshake when the renderer crashes', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const closing = controller.requestClose()
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'render-process-gone')![1]({}, { reason: 'crashed', exitCode: 1 })
    expect(await closing).toBe(false)
    expect(electronMocks.latestBrowserWindow!.close).not.toHaveBeenCalled()
  })

  it('reloads a crashed canvas from an entry URL with the current appearance', async () => {
    const runtimeLog = { log: vi.fn(), exception: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ runtimeLog: runtimeLog as never }))
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    const loadURL = window.loadURL as ReturnType<typeof vi.fn>
    expect(new URL(loadURL.mock.calls[0]![0] as string).searchParams.get('theme')).toBe('dark')
    controller.setTheme('light')
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'render-process-gone')![1]({}, { reason: 'crashed', exitCode: 1 })

    expect(loadURL).toHaveBeenCalledTimes(2)
    const reloaded = new URL(loadURL.mock.calls[1]![0] as string)
    expect(reloaded.pathname).toBe('/')
    expect(reloaded.searchParams.get('theme')).toBe('light')
    expect(runtimeLog.log).toHaveBeenCalledWith('warn', 'canvas', 'process.gone.reload', '画布界面进程退出后自动重新加载')
  })

  it('stops reloading a canvas that keeps crashing and reloads it when the user opens it again', async () => {
    const runtimeLog = { log: vi.fn(), exception: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ runtimeLog: runtimeLog as never }))
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    const webContents = electronMocks.latestWebContents!
    const loadURL = window.loadURL as ReturnType<typeof vi.fn>
    const gone = (webContents.on as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === 'render-process-gone')![1]
    gone({}, { reason: 'crashed', exitCode: 1 })
    gone({}, { reason: 'crashed', exitCode: 1 })
    gone({}, { reason: 'crashed', exitCode: 1 })
    expect(loadURL).toHaveBeenCalledTimes(3)
    expect(runtimeLog.log).toHaveBeenCalledWith('warn', 'canvas', 'process.gone.reload-limit', '画布界面接连退出，不再自动重新加载')

    ;(webContents.isCrashed as ReturnType<typeof vi.fn>).mockReturnValue(true)
    await controller.open()
    expect(loadURL).toHaveBeenCalledTimes(4)
    expect(window.focus).toHaveBeenCalled()
    expect(runtimeLog.log).toHaveBeenCalledWith('info', 'canvas', 'process.gone.reopen-reload', '重新打开画布时重新加载界面')
  })

  it('only focuses a healthy canvas when it is opened again', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    await controller.open()
    expect(electronMocks.latestBrowserWindow!.loadURL).toHaveBeenCalledOnce()
    expect(electronMocks.latestBrowserWindow!.focus).toHaveBeenCalledOnce()
  })

  it('does not bring back a canvas whose renderer exits during app shutdown', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    const gone = (electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>).mock.calls.find(([event]) => event === 'render-process-gone')![1]
    controller.dispose()
    gone({}, { reason: 'killed', exitCode: 1 })
    expect(window.loadURL).toHaveBeenCalledOnce()
  })

  it('records a preload failure and invalidates an in-flight close handshake', async () => {
    const runtimeLog = { log: vi.fn(), exception: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ runtimeLog: runtimeLog as never }))
    await controller.open()
    const closing = controller.requestClose()
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'preload-error')![1]({}, '/tmp/canvas-preload.js', new Error('module not found'))
    expect(await closing).toBe(false)
    expect(runtimeLog.log).toHaveBeenCalledWith(
      'error',
      'canvas',
      'preload.failed',
      '画布宿主 preload 加载失败',
      expect.objectContaining({ preloadPath: '/tmp/canvas-preload.js', reason: 'module not found' }),
    )
  })

  it('allows the native close after a preload failure instead of trapping the window', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'preload-error')![1]({}, '/tmp/canvas-preload.js', new Error('module not found'))
    ;(window.close as () => void)()
    expect((window.isDestroyed as () => boolean)()).toBe(true)
    controller.dispose()
  })

  it('fails open when the app quit path requests a close after preload failure', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'preload-error')![1]({}, '/tmp/canvas-preload.js', new Error('module not found'))

    expect(await controller.requestClose()).toBe(true)
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('fails open when the renderer process is gone before the app quit path', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'render-process-gone')![1]({}, { reason: 'crashed', exitCode: 1 })

    expect(await controller.requestClose()).toBe(true)
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('marks a main-frame load failure as unavailable for later close requests', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const window = electronMocks.latestBrowserWindow!
    const on = electronMocks.latestWebContents!.on as ReturnType<typeof vi.fn>
    on.mock.calls.find(([event]) => event === 'did-fail-load')![1]({}, -105, 'NAME_NOT_RESOLVED', 'xingmang-canvas://app/', true)

    expect(await controller.requestClose()).toBe(true)
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('detects a missing bridge after page load even when preload-error is not emitted', async () => {
    const runtimeLog = { log: vi.fn(), exception: vi.fn() }
    const controller = createCanvasWindowController(controllerOptions({ runtimeLog: runtimeLog as never }))
    await controller.open()
    const webContents = electronMocks.latestWebContents!
    ;(webContents.executeJavaScript as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    const on = webContents.on as ReturnType<typeof vi.fn>
    const finishLoad = on.mock.calls.find(([event]) => event === 'did-finish-load')![1] as () => void
    finishLoad()
    await Promise.resolve()
    expect(runtimeLog.log).toHaveBeenCalledWith(
      'error',
      'canvas',
      'preload.failed',
      '画布宿主 preload 加载失败',
      expect.objectContaining({ reason: '画布页面未发现宿主桥接' }),
    )
    controller.dispose()
  })

  it('sends only display preferences through initial URL and appearance events, never the stored skin', async () => {
    // The canvas follows the main window (#1103): an old stored skin such as mist no longer reaches it.
    const systemService = {
      readStoredConfig: vi.fn(() => ({ theme: 'dark', uiSkin: 'mist' })),
      revealApiKey: vi.fn(() => ''),
    } as unknown as SystemService
    const controller = createCanvasWindowController(controllerOptions({ systemService }))
    controller.setAppearance({ theme: 'light', uiSkin: 'mist', reducedMotion: true })
    await controller.open()
    expect(electronMocks.latestBrowserWindow!.loadURL).toHaveBeenCalledWith('xingmang-canvas://app/?theme=light&reducedMotion=1')
    expect(electronMocks.browserWindowOptions).toEqual([expect.objectContaining({ backgroundColor: canvasWindowLightBackgroundColor })])
    controller.setAppearance({ theme: 'dark', uiSkin: 'aurora' })
    expect(electronMocks.latestBrowserWindow!.setBackgroundColor).toHaveBeenLastCalledWith(canvasWindowBackgroundColor)
    expect(electronMocks.latestWebContents!.send).toHaveBeenCalledWith(canvasHostChannels.appearanceChanged, { theme: 'dark', reducedMotion: false })
  })

  it('opens with the stored dark theme without the stored skin', async () => {
    const systemService = {
      readStoredConfig: vi.fn(() => ({ theme: 'dark', uiSkin: 'mist' })),
      revealApiKey: vi.fn(() => ''),
    } as unknown as SystemService
    const controller = createCanvasWindowController(controllerOptions({ systemService }))
    await controller.open()
    expect(electronMocks.latestBrowserWindow!.loadURL).toHaveBeenCalledWith('xingmang-canvas://app/?theme=dark')
    expect(electronMocks.browserWindowOptions).toEqual([expect.objectContaining({ backgroundColor: canvasWindowBackgroundColor })])
  })
})

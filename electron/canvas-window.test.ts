import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NewApiClientService } from './new-api-client'
import type { SystemService } from './system-service'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(async () => ({ canceled: true, filePaths: [] })),
  browserWindowFromWebContents: vi.fn(() => undefined),
  registerFileProtocol: vi.fn(),
  notificationShow: vi.fn(),
  notificationSupported: vi.fn(() => true),
  browserWindowOptions: [] as unknown[],
  latestWebContents: null as null | Record<string, unknown>,
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: Object.assign(vi.fn(function BrowserWindowMock(options: unknown) {
    electronMocks.browserWindowOptions.push(options)
    const mainFrame = { url: 'xingmang-canvas://app/index.html' }
    const webContents = {
      id: 41,
      mainFrame,
      getURL: () => mainFrame.url,
      isDestroyed: () => false,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    electronMocks.latestWebContents = webContents
    return {
      webContents,
      once: vi.fn(),
      on: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      center: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
    }
  }), { fromWebContents: electronMocks.browserWindowFromWebContents }),
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

import { buildCanvasProjectPackage } from './canvas-project-package'
import {
  canvasHostCancelRequestChannel,
  canvasHostCopyAssetChannel,
  canvasHostCreatePromptPresetChannel,
  canvasHostDeletePromptPresetChannel,
  canvasHostEditImageChannel,
  canvasHostGenerateImageChannel,
  canvasHostListGroupsChannel,
  canvasHostListAssetsChannel,
  canvasHostListPromptPresetsChannel,
  canvasHostPickAssetChannel,
  canvasHostImportAssetFileChannel,
  canvasHostStartRunChannel,
  canvasHostCancelRunChannel,
  canvasHostExportProjectChannel,
  canvasHostImportProjectChannel,
  canvasHostListRunsChannel,
  canvasHostNotifyChannel,
  canvasHostOpenExternalChannel,
  canvasHostPickFileChannel,
  canvasHostPrepareGroupChannel,
  canvasHostPreviewProjectChannel,
  canvasHostRunEventChannel,
  canvasHostSaveFileChannel,
  canvasHostSaveAssetChannel,
  canvasHostShowAssetMenuChannel,
  canvasHostUpdatePromptPresetChannel,
  canvasWindowBackgroundColor,
  createCanvasWindowController,
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
    systemService: { revealApiKey: vi.fn(() => '') } as unknown as SystemService,
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
      subscribe: vi.fn((_listener: unknown) => () => undefined),
    } as never,
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
  electronMocks.browserWindowOptions.length = 0
  electronMocks.latestWebContents = null
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('createCanvasWindowController', () => {
  it('registers exactly the documented canvas-host invoke channels with no token channel', () => {
    createCanvasWindowController(controllerOptions())

    expect([...electronMocks.handlers.keys()].sort()).toEqual([
      canvasHostCancelRequestChannel,
      canvasHostCopyAssetChannel,
      canvasHostCreatePromptPresetChannel,
      canvasHostDeletePromptPresetChannel,
      canvasHostEditImageChannel,
      canvasHostGenerateImageChannel,
      canvasHostListAssetsChannel,
      canvasHostListPromptPresetsChannel,
      canvasHostPickAssetChannel,
      canvasHostImportAssetFileChannel,
      canvasHostStartRunChannel,
      canvasHostCancelRunChannel,
      canvasHostExportProjectChannel,
      canvasHostImportProjectChannel,
      canvasHostListRunsChannel,
      canvasHostListGroupsChannel,
      canvasHostNotifyChannel,
      canvasHostOpenExternalChannel,
      canvasHostPickFileChannel,
      canvasHostPrepareGroupChannel,
      canvasHostPreviewProjectChannel,
      canvasHostSaveAssetChannel,
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
    expect(canvasWindowBackgroundColor).toBe('#111315')
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
    const controller = createCanvasWindowController(controllerOptions({ aiAssets: aiAssets as never }))
    await controller.open()

    await expect(electronMocks.handlers.get(canvasHostPickAssetChannel)!(trustedEvent())).resolves.toEqual(imported)
    expect(aiAssets.storeLocalFile).toHaveBeenCalledWith(7, imagePath)
  })

  it('rejects oversized or non-string saveFile input before ever opening a dialog', async () => {
    const controller = createCanvasWindowController(controllerOptions())
    await controller.open()
    const handler = electronMocks.handlers.get(canvasHostSaveFileChannel)!

    await expect(handler(trustedEvent(), 'export.json', 12345)).rejects.toThrow('保存内容格式错误')
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()
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

  it('publishes run events only to their originating window while its account is still active', async () => {
    let activeUserId = 7
    let listener: ((publication: { event: unknown; userId: number; ownerId: number }) => void) | undefined
    const canvasRuns = {
      start: vi.fn(), cancel: vi.fn(), cancelOwner: vi.fn(), listRuns: vi.fn(async () => []),
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
    const controller = createCanvasWindowController(controllerOptions({
      chatCredentials,
      imageService: imageService as never,
      aiAssets: aiAssets as never,
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

    expect(JSON.stringify({ groups, prepared, generated, edited })).not.toContain('apiKey')
    expect(imageService.generate).toHaveBeenCalledWith(41, expect.objectContaining({ requestId: 'request-1' }))
    expect(imageService.edit).toHaveBeenCalledWith(41, {
      requestId: 'edit-1', group: '生图分组', model: 'gpt-image-1', prompt: '改成夜景',
      sourceAssetIds: ['a'.repeat(43)], expectedUserId: 7,
    })
    expect(aiAssets.copy).toHaveBeenCalledWith(7, 'a'.repeat(43), expect.any(Function))
    expect(aiAssets.listOwnedPage).toHaveBeenCalledWith(7, { offset: 24, limit: 24, mediaType: 'image', search: '产品' })
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
      canvasHostEditImageChannel,
      canvasHostCreatePromptPresetChannel, canvasHostDeletePromptPresetChannel,
      canvasHostSaveAssetChannel, canvasHostShowAssetMenuChannel, canvasHostListAssetsChannel,
      canvasHostStartRunChannel, canvasHostCancelRunChannel, canvasHostListRunsChannel,
      canvasHostExportProjectChannel, canvasHostPreviewProjectChannel, canvasHostImportProjectChannel,
      canvasHostListPromptPresetsChannel, canvasHostUpdatePromptPresetChannel,
    })) {
      expect(electronMocks.removeHandler).toHaveBeenCalledWith(channel)
    }
  })
})

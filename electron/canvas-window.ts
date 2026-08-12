import fs from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  protocol,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron'
import {
  canvasPackagedBaseUrl,
  canvasProtocolScheme,
  isAllowedAppNavigationUrl,
  isTrustedIpcSenderUrl,
  resolveCanvasProtocolFile,
  type ApplicationUrlPolicy,
} from './canvas-protocol'
import { isAllowedExternalUrl } from './security'
import { readBoundedUtf8File } from './bounded-file'
import { writeAtomicSafeUtf8File } from './safe-local-data'
import type { RelayBackendClient } from './relay-backend'
import type { SystemService } from './system-service'
import type { RuntimeLogStore } from './runtime-log'
import { createExternalShellLauncher, type ExternalShellLauncher } from './system-shell'
import { canvasHostChannels } from './canvas-contract'
import {
  parseCanvasAssetQuery,
  parseCanvasImageEditInput,
  parseCanvasImageGenerateInput,
  parseCanvasPromptPresetId,
  parseCanvasPromptPresetInput,
  parseCanvasPromptPresetUpdate,
  parseCanvasStartRunInput,
  requiredCanvasString,
} from './canvas-request-parser'
import type { ChatCredentialCoordinator } from './chat-credential-coordinator'
import type { AiImageService } from './ai-image-service'
import type { AiAssetStore } from './ai-asset-store'
import type { CanvasRunService } from './canvas-run-service'
import type { CanvasPromptPresetStore } from './canvas-prompt-preset-store'
import { computeCanvasGraphRevision } from './canvas-fingerprint'
import {
  buildCanvasProjectPackage,
  createCanvasProjectPreviewId,
  maximumCanvasProjectBytes,
  parseCanvasProjectPackage,
  parseCanvasProjectWorkflow,
  remapCanvasProjectWorkflow,
  type ParsedCanvasProjectPackage,
} from './canvas-project-package'

// Narrow, hand-maintained channel names for the canvas window's own host
// bridge -- deliberately NOT part of ipc-contract.ts's XingmangInvokeContract
// (that contract is exclusively for the main app's window.xingmang bridge,
// consumed from src/). canvas-preload.ts cannot import these as values (I7:
// sandboxed preload scripts cannot require local runtime modules) so it
// duplicates the literals; keep both copies in sync by hand if these ever
// change.
export const canvasHostSaveFileChannel = canvasHostChannels.saveFile
export const canvasHostPickFileChannel = canvasHostChannels.pickFile
export const canvasHostNotifyChannel = canvasHostChannels.notify
export const canvasHostOpenExternalChannel = canvasHostChannels.openExternal
export const canvasHostListGroupsChannel = canvasHostChannels.listGroups
export const canvasHostPrepareGroupChannel = canvasHostChannels.prepareGroup
export const canvasHostGenerateImageChannel = canvasHostChannels.generateImage
export const canvasHostEditImageChannel = canvasHostChannels.editImage
export const canvasHostCancelRequestChannel = canvasHostChannels.cancelRequest
export const canvasHostCopyAssetChannel = canvasHostChannels.copyAsset
export const canvasHostSaveAssetChannel = canvasHostChannels.saveAsset
export const canvasHostShowAssetMenuChannel = canvasHostChannels.showAssetMenu
export const canvasHostListAssetsChannel = canvasHostChannels.listAssets
export const canvasHostPickAssetChannel = canvasHostChannels.pickAsset
export const canvasHostImportAssetFileChannel = canvasHostChannels.importAssetFile
export const canvasHostListPromptPresetsChannel = canvasHostChannels.listPromptPresets
export const canvasHostCreatePromptPresetChannel = canvasHostChannels.createPromptPreset
export const canvasHostUpdatePromptPresetChannel = canvasHostChannels.updatePromptPreset
export const canvasHostDeletePromptPresetChannel = canvasHostChannels.deletePromptPreset
export const canvasHostStartRunChannel = canvasHostChannels.startRun
export const canvasHostCancelRunChannel = canvasHostChannels.cancelRun
export const canvasHostListRunsChannel = canvasHostChannels.listRuns
export const canvasHostExportProjectChannel = canvasHostChannels.exportProject
export const canvasHostPreviewProjectChannel = canvasHostChannels.previewProject
export const canvasHostImportProjectChannel = canvasHostChannels.importProject
export const canvasHostRunEventChannel = canvasHostChannels.runEvent

const maximumSavedFileBytes = 20 * 1024 * 1024
const maximumPickedFileBytes = 20 * 1024 * 1024
const maximumTitleLength = 200
const maximumBodyLength = 2_000

export interface CanvasWindowControllerOptions {
  /** Absolute path to the packaged infinite-canvas dist/ directory. */
  canvasDistRoot: string
  externalUrlAllowlist: readonly string[]
  systemService: SystemService
  // Typed as the backend-agnostic RelayBackendClient (relay-backend.ts), not
  // new-api-client.ts's concrete type -- this window never needs to know
  // which relay backend minted its canvas key.
  accountService: RelayBackendClient
  previewOnboarding: boolean
  runtimeLog: RuntimeLogStore
  chatCredentials: ChatCredentialCoordinator
  imageService: AiImageService
  aiAssets: AiAssetStore
  promptPresets: CanvasPromptPresetStore
  canvasRuns: CanvasRunService
  externalShell?: ExternalShellLauncher
}

export interface CanvasWindowController {
  /** Opens the canvas window, or focuses it if already open. Idempotent under rapid repeat calls (in-flight creation is reused, never doubled). */
  open(): Promise<void>
  /** Closes the canvas window if one is open; a no-op otherwise. */
  closeIfOpen(): void
  /** Removes every IPC handler this controller registered. */
  dispose(): void
}

function senderUrlOf(event: IpcMainInvokeEvent): string {
  return event.senderFrame?.url ?? event.sender.getURL()
}

export const canvasWindowBackgroundColor = '#111315'

/**
 * Builds and wires an isolated BrowserWindow for the bundled infinite-canvas
 * app, plus the narrow host bridge it talks to. See the task report for the
 * full isolation checklist; in short: separate BrowserWindow, separate
 * sandboxed preload, separate xingmang-canvas:// protocol restricted to
 * canvasDistRoot, separate IPC channel namespace validated against the
 * canvas window's own origin (never the main app's) -- the canvas page can
 * never reach window.xingmang or any ipcMain channel the main app owns.
 */
export function createCanvasWindowController(
  options: CanvasWindowControllerOptions,
): CanvasWindowController {
  const policy: ApplicationUrlPolicy = {
    rendererRoot: options.canvasDistRoot,
    packagedBaseUrl: canvasPackagedBaseUrl,
  }
  const externalShell = options.externalShell ?? createExternalShellLauncher()
  const handleChannels: string[] = []
  let canvasWindow: BrowserWindow | null = null
  let pendingOpen: Promise<void> | null = null
  const pendingProjects = new Map<number, { previewId: string; userId: number; parsed: ParsedCanvasProjectPackage }>()

  protocol.registerFileProtocol(canvasProtocolScheme, (request, callback) => {
    const target = resolveCanvasProtocolFile(request.url, policy)
    if (!target) {
      callback({ error: -6 })
      return
    }
    callback({ path: target })
  })

  function assertTrustedCanvasSender(event: IpcMainInvokeEvent): void {
    const currentContents = canvasWindow && !canvasWindow.isDestroyed()
      ? canvasWindow.webContents
      : null
    const mainFrame = event.sender.mainFrame
    const isMainFrame = Boolean(mainFrame) && event.senderFrame === mainFrame
    if (
      !isTrustedIpcSenderUrl(senderUrlOf(event), policy)
      || !isMainFrame
      || currentContents === null
      || event.sender !== currentContents
    ) {
      throw new Error('已拒绝来自非画布页面的操作请求')
    }
  }

  function authenticatedCanvasUserId(): number {
    const session = options.accountService.getSessionState()
    const userId = session.authenticated ? session.account?.userId : undefined
    if (!Number.isSafeInteger(userId) || !userId || userId <= 0) throw new Error('请先登录星芒账号')
    return userId
  }

  function assertCanvasUserUnchanged(expectedUserId: number): void {
    if (authenticatedCanvasUserId() !== expectedUserId) {
      throw new Error('星芒账号已切换，请重新执行画布操作')
    }
  }

  function registerCanvasHandler(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void {
    handleChannels.push(channel)
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedCanvasSender(event)
      return handler(event, ...args)
    })
  }

  registerCanvasHandler(canvasHostSaveFileChannel, async (event, suggestedNameInput, contentInput) => {
    const suggestedName = requiredCanvasString(suggestedNameInput, '保存文件名', 256)
    const content = requiredCanvasString(contentInput, '保存内容', maximumSavedFileBytes)
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: SaveDialogOptions = {
      title: '画布：保存文件',
      defaultPath: suggestedName,
      filters: [{ name: '所有文件', extensions: ['*'] }],
    }
    const result = parentWindow
      ? await dialog.showSaveDialog(parentWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    await writeAtomicSafeUtf8File(result.filePath, content, '画布导出文件')
    return { savedPath: result.filePath }
  })

  registerCanvasHandler(canvasHostPickFileChannel, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '画布：选择文件',
      properties: ['openFile'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    const content = await readBoundedUtf8File(filePath, maximumPickedFileBytes, '画布导入文件')
    return { name: path.basename(filePath), content }
  })

  registerCanvasHandler(canvasHostNotifyChannel, (_event, titleInput, bodyInput) => {
    const title = requiredCanvasString(titleInput, '通知标题', maximumTitleLength)
    const body = bodyInput === undefined ? '' : requiredCanvasString(bodyInput, '通知内容', maximumBodyLength)
    if (!Notification.isSupported()) return false
    new Notification({ title, body }).show()
    return true
  })

  registerCanvasHandler(canvasHostOpenExternalChannel, async (_event, urlInput) => {
    if (typeof urlInput !== 'string' || !isAllowedExternalUrl(urlInput, options.externalUrlAllowlist)) {
      throw new Error('不允许打开该链接')
    }
    await externalShell.openExternal(urlInput)
    return true
  })

  registerCanvasHandler(canvasHostListGroupsChannel, async () => {
    const groups = await options.chatCredentials.listGroups()
    return groups.map(({ name, description, ratio }) => ({ name, description, ratio }))
  })

  registerCanvasHandler(canvasHostPrepareGroupChannel, (_event, groupInput) => (
    options.chatCredentials.prepareGroup(requiredCanvasString(groupInput, '画布生图分组', 128))
  ))

  registerCanvasHandler(canvasHostGenerateImageChannel, (event, input) => (
    options.imageService.generate(event.sender.id, parseCanvasImageGenerateInput(input))
  ))

  registerCanvasHandler(canvasHostEditImageChannel, (event, input) => {
    const userId = authenticatedCanvasUserId()
    return options.imageService.edit(event.sender.id, {
      ...parseCanvasImageEditInput(input),
      expectedUserId: userId,
    })
  })

  registerCanvasHandler(canvasHostCancelRequestChannel, (event, requestIdInput) => (
    options.imageService.cancel(
      event.sender.id,
      requiredCanvasString(requestIdInput, '画布生图请求标识', 160),
    )
  ))

  registerCanvasHandler(canvasHostListPromptPresetsChannel, () => (
    options.promptPresets.list(authenticatedCanvasUserId())
  ))

  registerCanvasHandler(canvasHostCreatePromptPresetChannel, async (_event, input) => {
    const userId = authenticatedCanvasUserId()
    const result = await options.promptPresets.create(userId, parseCanvasPromptPresetInput(input))
    assertCanvasUserUnchanged(userId)
    return result
  })

  registerCanvasHandler(canvasHostUpdatePromptPresetChannel, async (_event, input) => {
    const userId = authenticatedCanvasUserId()
    const result = await options.promptPresets.update(userId, parseCanvasPromptPresetUpdate(input))
    assertCanvasUserUnchanged(userId)
    return result
  })

  registerCanvasHandler(canvasHostDeletePromptPresetChannel, async (_event, idInput) => {
    const userId = authenticatedCanvasUserId()
    const result = await options.promptPresets.delete(userId, parseCanvasPromptPresetId(idInput))
    assertCanvasUserUnchanged(userId)
    return result
  })

  registerCanvasHandler(canvasHostCopyAssetChannel, async (_event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    await options.aiAssets.copy(
      userId,
      requiredCanvasString(assetIdInput, '画布图片资产标识', 64),
      () => assertCanvasUserUnchanged(userId),
    )
  })

  registerCanvasHandler(canvasHostSaveAssetChannel, async (_event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    const saved = await options.aiAssets.saveAs(
      userId,
      requiredCanvasString(assetIdInput, '画布图片资产标识', 64),
      () => assertCanvasUserUnchanged(userId),
    )
    return { saved }
  })

  registerCanvasHandler(canvasHostShowAssetMenuChannel, async (_event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    const assetId = requiredCanvasString(assetIdInput, '画布图片资产标识', 64)
    await options.aiAssets.contextMenu(userId, assetId, () => {
      if (authenticatedCanvasUserId() !== userId) throw new Error('星芒账号已切换，已停止图片操作')
    })
  })

  registerCanvasHandler(canvasHostListAssetsChannel, async (_event, queryInput) => {
    const userId = authenticatedCanvasUserId()
    const assets = await options.aiAssets.listOwnedPage(userId, parseCanvasAssetQuery(queryInput))
    assertCanvasUserUnchanged(userId)
    return assets
  })

  async function importCanvasAsset(userId: number, filePath: string) {
    const asset = await options.aiAssets.storeLocalFile(userId, filePath)
    try {
      assertCanvasUserUnchanged(userId)
      return asset
    } catch (error) {
      await options.aiAssets.removeOwned(userId, asset.assetId).catch(() => undefined)
      throw error
    }
  }

  registerCanvasHandler(canvasHostPickAssetChannel, async (event) => {
    const userId = authenticatedCanvasUserId()
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '画布：选择图片素材',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return null
    return importCanvasAsset(userId, result.filePaths[0])
  })

  registerCanvasHandler(canvasHostImportAssetFileChannel, async (_event, filePathInput) => {
    const userId = authenticatedCanvasUserId()
    const filePath = requiredCanvasString(filePathInput, '本地图片路径', 32_768)
    if (!path.isAbsolute(filePath)) throw new Error('本地图片路径无效')
    return importCanvasAsset(userId, filePath)
  })

  registerCanvasHandler(canvasHostStartRunChannel, (event, input) => {
    const { graph, scope } = parseCanvasStartRunInput(input)
    const userId = authenticatedCanvasUserId()
    const handle = options.canvasRuns.start({
      userId,
      ownerId: event.sender.id,
      graphRevision: computeCanvasGraphRevision(graph),
      graph,
      scope,
    })
    void handle.promise.catch((error) => options.runtimeLog.exception('canvas', 'run.failed', error))
    return { runId: handle.runId, graphRevision: handle.graphRevision }
  })

  registerCanvasHandler(canvasHostCancelRunChannel, (event, runIdInput) => (
    options.canvasRuns.cancel(requiredCanvasString(runIdInput, '画布运行标识', 256), event.sender.id)
  ))

  registerCanvasHandler(canvasHostListRunsChannel, async () => {
    const userId = authenticatedCanvasUserId()
    const runs = await options.canvasRuns.listRuns(userId)
    assertCanvasUserUnchanged(userId)
    return runs
  })

  registerCanvasHandler(canvasHostExportProjectChannel, async (event, suggestedNameInput, contentInput) => {
    const userId = authenticatedCanvasUserId()
    const suggestedName = requiredCanvasString(suggestedNameInput, '画布项目文件名', 256)
    const workflowContent = requiredCanvasString(contentInput, '画布项目工作流', maximumSavedFileBytes)
    const parsed = parseCanvasProjectWorkflow(workflowContent)
    const sources = await Promise.all(parsed.assetIds.map((assetId) => options.aiAssets.readOwned(userId, assetId)))
    assertCanvasUserUnchanged(userId)
    const projectContent = buildCanvasProjectPackage(workflowContent, sources)
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const defaultPath = suggestedName.toLowerCase().endsWith('.xingcanvas') ? suggestedName : `${suggestedName}.xingcanvas`
    const dialogOptions: SaveDialogOptions = {
      title: '画布：导出项目', defaultPath,
      filters: [{ name: '星芒画布项目', extensions: ['xingcanvas'] }],
    }
    const result = parentWindow ? await dialog.showSaveDialog(parentWindow, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    assertCanvasUserUnchanged(userId)
    await writeAtomicSafeUtf8File(result.filePath, projectContent, '画布项目导出文件')
    return { savedPath: result.filePath }
  })

  registerCanvasHandler(canvasHostPreviewProjectChannel, async (event) => {
    const userId = authenticatedCanvasUserId()
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '画布：导入项目', properties: ['openFile'],
      filters: [{ name: '星芒画布项目', extensions: ['xingcanvas'] }],
    }
    const result = parentWindow ? await dialog.showOpenDialog(parentWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return null
    assertCanvasUserUnchanged(userId)
    const filePath = result.filePaths[0]
    const parsed = parseCanvasProjectPackage(await readBoundedUtf8File(filePath, maximumCanvasProjectBytes, '画布项目导入文件'))
    assertCanvasUserUnchanged(userId)
    const previewId = createCanvasProjectPreviewId()
    pendingProjects.set(event.sender.id, { previewId, userId, parsed })
    return {
      previewId, name: path.basename(filePath), workflowName: String(parsed.workflow.name),
      nodeCount: (parsed.workflow.nodes as unknown[]).length,
      edgeCount: (parsed.workflow.edges as unknown[]).length,
      assetCount: parsed.assets.length,
      warnings: parsed.warnings,
    }
  })

  registerCanvasHandler(canvasHostImportProjectChannel, async (event, previewIdInput) => {
    const userId = authenticatedCanvasUserId()
    const previewId = requiredCanvasString(previewIdInput, '画布项目预览标识', 128)
    const pending = pendingProjects.get(event.sender.id)
    if (!pending || pending.previewId !== previewId) throw new Error('画布项目预览已失效，请重新选择文件')
    pendingProjects.delete(event.sender.id)
    if (pending.userId !== userId) throw new Error('星芒账号已切换，请重新选择画布项目')
    const imported: string[] = []
    const mappings = new Map<string, string>()
    try {
      for (const entry of pending.parsed.assets) {
        assertCanvasUserUnchanged(userId)
        const asset = await options.aiAssets.storeBase64(userId, `data:${entry.mimeType};base64,${entry.bytes.toString('base64')}`)
        imported.push(asset.assetId)
        mappings.set(entry.assetId, asset.assetId)
      }
      assertCanvasUserUnchanged(userId)
    } catch (error) {
      await Promise.all(imported.map((assetId) => options.aiAssets.removeOwned(userId, assetId).catch(() => undefined)))
      throw error
    }
    return {
      content: remapCanvasProjectWorkflow(pending.parsed.workflow, mappings),
      warnings: pending.parsed.warnings,
      importedAssetCount: imported.length,
    }
  })

  const unsubscribeRunEvents = options.canvasRuns.subscribe(({ event, userId, ownerId }) => {
    if (!canvasWindow || canvasWindow.isDestroyed()) return
    if (canvasWindow.webContents.id !== ownerId) return
    try {
      if (authenticatedCanvasUserId() !== userId) return
    } catch {
      return
    }
    canvasWindow.webContents.send(canvasHostRunEventChannel, event)
  })

  function assertCanvasDistPresent(): void {
    const indexPath = path.join(options.canvasDistRoot, 'index.html')
    if (!fs.existsSync(indexPath)) {
      throw new Error('画布资源未找到，请重新安装应用')
    }
  }

  async function createWindow(): Promise<void> {
    assertCanvasDistPresent()

    const window = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 960,
      minHeight: 620,
      backgroundColor: canvasWindowBackgroundColor,
      show: false,
      title: '无限画布 - 星芒AI管理工具',
      webPreferences: {
        preload: path.join(__dirname, 'canvas-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged,
        // No webview escape hatch, and no drag-drop navigation out of the
        // sandboxed origin -- matches the main window's hardening exactly.
        webviewTag: false,
        navigateOnDragDrop: false,
      },
    })
    canvasWindow = window
    const senderId = window.webContents.id

    window.once('ready-to-show', () => {
      window.center()
      window.show()
    })
    window.on('closed', () => {
      options.imageService.cancelSender(senderId)
      options.canvasRuns.cancelOwner(senderId)
      pendingProjects.delete(senderId)
      if (canvasWindow === window) canvasWindow = null
    })
    // Deny every popup by default; the only ones ever legitimate are the
    // handful of known external links infinite-canvas itself opens via
    // window.open(url, "_blank") (docs button, About-modal GitHub credit).
    // Those still never get a real popup window -- shell.openExternal hands
    // them to the OS browser instead, and the popup request itself is
    // always denied.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url, options.externalUrlAllowlist)) {
        void externalShell.openExternal(url)
      }
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, targetUrl) => {
      if (isAllowedAppNavigationUrl(targetUrl, policy)) return
      event.preventDefault()
      if (isAllowedExternalUrl(targetUrl, options.externalUrlAllowlist)) {
        void externalShell.openExternal(targetUrl)
      }
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      options.runtimeLog.log('error', 'canvas', 'process.gone', '画布渲染进程异常退出', {
        reason: details.reason,
        exitCode: details.exitCode,
      })
    })

    // Load the bare protocol root (pathname '/'), not '/index.html'. The canvas
    // SPA uses createBrowserRouter and only registers '/', so a '/index.html'
    // path 404s in its router; the protocol handler's catch-all still serves
    // index.html for '/', letting the app boot on its home route.
    await window.loadURL(canvasPackagedBaseUrl)
  }

  return {
    async open() {
      if (canvasWindow && !canvasWindow.isDestroyed()) {
        if (canvasWindow.isMinimized()) canvasWindow.restore()
        canvasWindow.show()
        canvasWindow.focus()
        return
      }
      if (!pendingOpen) {
        pendingOpen = createWindow().finally(() => {
          pendingOpen = null
        })
      }
      await pendingOpen
    },
    closeIfOpen() {
      if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.close()
    },
    dispose() {
      if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.close()
      canvasWindow = null
      for (const channel of handleChannels) ipcMain.removeHandler(channel)
      unsubscribeRunEvents()
    },
  }
}

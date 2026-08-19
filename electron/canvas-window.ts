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
import { assertNoReparseComponents, writeAtomicSafeUtf8File } from './safe-local-data'
import type { RelayBackendClient } from './relay-backend'
import type { SystemService } from './system-service'
import type { AppTheme } from './app-settings'
import type { RuntimeLogStore } from './runtime-log'
import { createExternalShellLauncher, type ExternalShellLauncher } from './system-shell'
import { canvasHostChannels } from './canvas-contract'
import {
  parseCanvasAssetQuery,
  parseCanvasAssetId,
  parseCanvasImageEditInput,
  parseCanvasImageGenerateInput,
  parseCanvasPromptPresetId,
  parseCanvasPromptPresetInput,
  parseCanvasPromptPresetUpdate,
  parseCanvasRenameAssetInput,
  parseCanvasUpdateAssetMetadataInput,
  parseCanvasStartRunInput,
  parseCanvasVideoGenerateInput,
  parseCanvasVideoTaskId,
  requiredCanvasString,
  requiredCanvasText,
} from './canvas-request-parser'
import type { ChatCredentialCoordinator } from './chat-credential-coordinator'
import type { AiImageService } from './ai-image-service'
import type { AiAssetStore } from './ai-asset-store'
import type { AiAudioAssetStore } from './ai-audio-asset-store'
import type { AiVideoAssetStore } from './ai-video-asset-store'
import type { AiVideoService } from './ai-video-service'
import type { AiMediaAssetService } from './ai-media-asset-service'
import type { CanvasRunService } from './canvas-run-service'
import type { CanvasPromptPresetStore } from './canvas-prompt-preset-store'
import { findCanvasWorkflowAssetReferenceNodeIds, type CanvasProjectStore } from './canvas-project-store'
import { findCanvasRunAssetReferences } from './canvas-asset-references'
import type { CanvasProjectAssetManager } from './canvas-project-asset-manager'
import { computeCanvasGraphRevision } from './canvas-fingerprint'
import { CanvasGenerationAdmission } from './canvas-generation-admission'
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
export const canvasHostGenerateVideoChannel = canvasHostChannels.generateVideo
export const canvasHostResumeVideoTaskChannel = canvasHostChannels.resumeVideoTask
export const canvasHostCancelRequestChannel = canvasHostChannels.cancelRequest
export const canvasHostCopyAssetChannel = canvasHostChannels.copyAsset
export const canvasHostSaveAssetChannel = canvasHostChannels.saveAsset
export const canvasHostShowAssetMenuChannel = canvasHostChannels.showAssetMenu
export const canvasHostListAssetsChannel = canvasHostChannels.listAssets
export const canvasHostRenameAssetChannel = canvasHostChannels.renameAsset
export const canvasHostUpdateAssetMetadataChannel = canvasHostChannels.updateAssetMetadata
export const canvasHostMarkAssetUsedChannel = canvasHostChannels.markAssetUsed
export const canvasHostDeleteAssetChannel = canvasHostChannels.deleteAsset
export const canvasHostRestoreAssetChannel = canvasHostChannels.restoreAsset
export const canvasHostPurgeAssetChannel = canvasHostChannels.purgeAsset
export const canvasHostInspectAssetReferencesChannel = canvasHostChannels.inspectAssetReferences
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
export const canvasHostListProjectsChannel = canvasHostChannels.listProjects
export const canvasHostCreateProjectChannel = canvasHostChannels.createProject
export const canvasHostOpenProjectChannel = canvasHostChannels.openProject
export const canvasHostSaveProjectChannel = canvasHostChannels.saveProject
export const canvasHostRenameProjectChannel = canvasHostChannels.renameProject
export const canvasHostDuplicateProjectChannel = canvasHostChannels.duplicateProject
export const canvasHostSetProjectArchivedChannel = canvasHostChannels.setProjectArchived
export const canvasHostRunEventChannel = canvasHostChannels.runEvent
export const canvasHostThemeChangedChannel = canvasHostChannels.themeChanged

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
  videoService: AiVideoService
  aiAssets: AiAssetStore
  videoAssets?: AiVideoAssetStore
  audioAssets?: AiAudioAssetStore
  mediaAssets: Pick<AiMediaAssetService, 'listOwnedPage' | 'copy' | 'saveAs' | 'contextMenu' | 'rename' | 'updateMetadata' | 'markUsed' | 'setSource' | 'softDelete' | 'restore' | 'purge'>
  promptPresets: CanvasPromptPresetStore
  canvasRuns: CanvasRunService
  projects?: CanvasProjectStore
  projectAssets?: CanvasProjectAssetManager
  externalShell?: ExternalShellLauncher
}

export interface CanvasWindowController {
  /** Opens the canvas window, or focuses it if already open. Idempotent under rapid repeat calls (in-flight creation is reused, never doubled). */
  open(): Promise<void>
  /** Applies the global application theme without exposing the settings record to the canvas renderer. */
  setTheme(theme: AppTheme): void
  /** Closes the canvas window if one is open; a no-op otherwise. */
  closeIfOpen(): void
  /** Removes every IPC handler this controller registered. */
  dispose(): void
}

function senderUrlOf(event: IpcMainInvokeEvent): string {
  return event.senderFrame?.url ?? event.sender.getURL()
}

export const canvasWindowBackgroundColor = '#111315'
export const canvasWindowLightBackgroundColor = '#eef1f3'

export function canvasWindowBackgroundForTheme(theme: AppTheme): string {
  return theme === 'light' ? canvasWindowLightBackgroundColor : canvasWindowBackgroundColor
}

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
  let currentTheme: AppTheme = options.systemService.readStoredConfig().theme
  const pendingProjects = new Map<number, { previewId: string; userId: number; parsed: ParsedCanvasProjectPackage }>()
  const activeProjects = new Map<number, { userId: number; projectId: string }>()
  const generationAdmission = new CanvasGenerationAdmission()

  function activeProjectId(ownerId: number, userId: number): string | undefined {
    if (!options.projects) return undefined
    const active = activeProjects.get(ownerId)
    if (!active || active.userId !== userId) throw new Error('请先选择或新建一个画布项目')
    return active.projectId
  }

  async function activeAssetContext(ownerId: number, userId: number) {
    const projectId = activeProjectId(ownerId, userId)
    return projectId ? options.projectAssets?.forProject(userId, projectId) : undefined
  }

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
    const content = requiredCanvasText(contentInput, '保存内容', maximumSavedFileBytes)
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

  registerCanvasHandler(canvasHostListProjectsChannel, () => {
    if (!options.projects) throw new Error('项目自动保存能力不可用')
    return options.projects.list(authenticatedCanvasUserId())
  })

  registerCanvasHandler(canvasHostCreateProjectChannel, async (event, nameInput) => {
    if (!options.projects) throw new Error('项目自动保存能力不可用')
    const userId = authenticatedCanvasUserId()
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '选择画布项目工作文件夹',
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return null
    assertCanvasUserUnchanged(userId)
    const created = await options.projects.create(
      userId,
      requiredCanvasString(nameInput, '画布项目名称', 128),
      result.filePaths[0],
    )
    assertCanvasUserUnchanged(userId)
    activeProjects.set(event.sender.id, { userId, projectId: created.project.id })
    return created
  })

  registerCanvasHandler(canvasHostOpenProjectChannel, async (event, projectIdInput) => {
    if (!options.projects) throw new Error('项目自动保存能力不可用')
    const userId = authenticatedCanvasUserId()
    const opened = await options.projects.open(userId, requiredCanvasString(projectIdInput, '画布项目标识', 64))
    assertCanvasUserUnchanged(userId)
    activeProjects.set(event.sender.id, { userId, projectId: opened.project.id })
    return opened
  })

  registerCanvasHandler(canvasHostSaveProjectChannel, async (_event, projectIdInput, contentInput) => {
    if (!options.projects) throw new Error('项目自动保存能力不可用')
    const userId = authenticatedCanvasUserId()
    const projectId = requiredCanvasString(projectIdInput, '画布项目标识', 64)
    if (activeProjectId(_event.sender.id, userId) !== projectId) throw new Error('只能保存当前打开的画布项目')
    const content = requiredCanvasText(contentInput, '画布项目内容', maximumSavedFileBytes)
    const saved = await options.projects.save(userId, projectId, content)
    assertCanvasUserUnchanged(userId)
    return saved
  })

  registerCanvasHandler(canvasHostRenameProjectChannel, async (_event, projectIdInput, nameInput) => {
    if (!options.projects) throw new Error('项目自动保存能力不可用')
    const userId = authenticatedCanvasUserId()
    const renamed = await options.projects.rename(
      userId,
      requiredCanvasString(projectIdInput, '画布项目标识', 64),
      requiredCanvasString(nameInput, '画布项目名称', 128),
    )
    assertCanvasUserUnchanged(userId)
    return renamed
  })

  registerCanvasHandler(canvasHostDuplicateProjectChannel, async (event, projectIdInput, nameInput) => {
    if (!options.projects) throw new Error('项目自动保存能力不可用')
    const userId = authenticatedCanvasUserId()
    const projectId = requiredCanvasString(projectIdInput, '画布项目标识', 64)
    const name = requiredCanvasString(nameInput, '画布项目名称', 128)
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '选择项目副本的工作文件夹',
      buttonLabel: '复制到此文件夹',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return null
    assertCanvasUserUnchanged(userId)
    const duplicated = await options.projects.duplicate(userId, projectId, name, result.filePaths[0])
    assertCanvasUserUnchanged(userId)
    return duplicated
  })

  registerCanvasHandler(canvasHostSetProjectArchivedChannel, async (event, projectIdInput, archivedInput) => {
    if (!options.projects) throw new Error('项目自动保存能力不可用')
    if (typeof archivedInput !== 'boolean') throw new Error('画布项目归档状态无效')
    const userId = authenticatedCanvasUserId()
    const projectId = requiredCanvasString(projectIdInput, '画布项目标识', 64)
    const updated = await options.projects.setArchived(userId, projectId, archivedInput)
    assertCanvasUserUnchanged(userId)
    const active = activeProjects.get(event.sender.id)
    if (archivedInput && active?.userId === userId && active.projectId === projectId) activeProjects.delete(event.sender.id)
    return updated
  })

  registerCanvasHandler(canvasHostPrepareGroupChannel, (_event, groupInput) => (
    options.chatCredentials.prepareGroup(requiredCanvasString(groupInput, '画布生图分组', 128))
  ))

  registerCanvasHandler(canvasHostGenerateImageChannel, (event, input) => {
    const userId = authenticatedCanvasUserId()
    const projectId = activeProjectId(event.sender.id, userId)
    return generationAdmission.run(event.sender.id, () => options.imageService.generate(event.sender.id, {
      ...parseCanvasImageGenerateInput(input),
      expectedUserId: userId,
      ...(projectId ? { projectId } : {}),
    }))
  })

  registerCanvasHandler(canvasHostEditImageChannel, (event, input) => {
    const userId = authenticatedCanvasUserId()
    const projectId = activeProjectId(event.sender.id, userId)
    return generationAdmission.run(event.sender.id, () => options.imageService.edit(event.sender.id, {
      ...parseCanvasImageEditInput(input),
      expectedUserId: userId,
      ...(projectId ? { projectId } : {}),
    }))
  })

  registerCanvasHandler(canvasHostGenerateVideoChannel, (event, input) => {
    const userId = authenticatedCanvasUserId()
    const projectId = activeProjectId(event.sender.id, userId)
    return generationAdmission.run(event.sender.id, () => options.videoService.generate(event.sender.id, {
      ...parseCanvasVideoGenerateInput(input),
      expectedUserId: userId,
      ...(projectId ? { projectId } : {}),
    }))
  })

  registerCanvasHandler(canvasHostResumeVideoTaskChannel, async (event, taskIdInput) => {
    const userId = authenticatedCanvasUserId()
    const projectId = activeProjectId(event.sender.id, userId)
    const taskId = parseCanvasVideoTaskId(taskIdInput)
    const asset = projectId
      ? await options.videoService.resumeVideoTask(event.sender.id, userId, taskId, projectId)
      : await options.videoService.resumeVideoTask(event.sender.id, userId, taskId)
    assertCanvasUserUnchanged(userId)
    return asset
  })

  registerCanvasHandler(canvasHostCancelRequestChannel, (event, requestIdInput) => {
    const requestId = requiredCanvasString(requestIdInput, '画布生成请求标识', 160)
    const image = options.imageService.cancel(event.sender.id, requestId)
    const video = options.videoService.cancel(event.sender.id, requestId)
    return image.canceled ? image : video
  })

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

  registerCanvasHandler(canvasHostCopyAssetChannel, async (event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    const context = await activeAssetContext(event.sender.id, userId)
    await (context?.media ?? options.mediaAssets).copy(
      userId,
      requiredCanvasString(assetIdInput, '画布图片资产标识', 64),
      () => assertCanvasUserUnchanged(userId),
    )
  })

  registerCanvasHandler(canvasHostSaveAssetChannel, async (event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    const context = await activeAssetContext(event.sender.id, userId)
    const saved = await (context?.media ?? options.mediaAssets).saveAs(
      userId,
      requiredCanvasString(assetIdInput, '画布图片资产标识', 64),
      () => assertCanvasUserUnchanged(userId),
    )
    return { saved }
  })

  registerCanvasHandler(canvasHostShowAssetMenuChannel, async (event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    const assetId = requiredCanvasString(assetIdInput, '画布图片资产标识', 64)
    const context = await activeAssetContext(event.sender.id, userId)
    await (context?.media ?? options.mediaAssets).contextMenu(userId, assetId, () => {
      if (authenticatedCanvasUserId() !== userId) throw new Error('星芒账号已切换，已停止图片操作')
    })
  })

  registerCanvasHandler(canvasHostListAssetsChannel, async (event, queryInput) => {
    const userId = authenticatedCanvasUserId()
    const context = await activeAssetContext(event.sender.id, userId)
    const assets = await (context?.media ?? options.mediaAssets).listOwnedPage(userId, parseCanvasAssetQuery(queryInput))
    const lineage = await options.canvasRuns.getAssetLineage(userId, assets.items.map((asset) => asset.assetId))
    assertCanvasUserUnchanged(userId)
    return {
      ...assets,
      items: assets.items.map((asset) => ({
        ...asset,
        ...(lineage[asset.assetId] ? { lineage: lineage[asset.assetId] } : {}),
      })),
    }
  })

  registerCanvasHandler(canvasHostRenameAssetChannel, async (event, input) => {
    const userId = authenticatedCanvasUserId()
    const { assetId, displayName } = parseCanvasRenameAssetInput(input)
    const context = await activeAssetContext(event.sender.id, userId)
    const renamed = await (context?.media ?? options.mediaAssets).rename(userId, assetId, displayName)
    assertCanvasUserUnchanged(userId)
    return renamed
  })

  registerCanvasHandler(canvasHostUpdateAssetMetadataChannel, async (event, input) => {
    const userId = authenticatedCanvasUserId()
    const { assetId, ...metadata } = parseCanvasUpdateAssetMetadataInput(input)
    const context = await activeAssetContext(event.sender.id, userId)
    const updated = await (context?.media ?? options.mediaAssets).updateMetadata(userId, assetId, metadata)
    assertCanvasUserUnchanged(userId)
    return updated
  })

  registerCanvasHandler(canvasHostMarkAssetUsedChannel, async (event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    const context = await activeAssetContext(event.sender.id, userId)
    const updated = await (context?.media ?? options.mediaAssets).markUsed(userId, parseCanvasAssetId(assetIdInput))
    assertCanvasUserUnchanged(userId)
    return updated
  })

  async function assetReferenceReport(senderId: number, userId: number, assetIdInput: unknown, currentProjectContentInput: unknown) {
    if (!options.projects) throw new Error('项目自动保存能力不可用')
    const projectId = activeProjectId(senderId, userId)
    if (!projectId) throw new Error('请先选择或新建一个画布项目')
    const assetId = requiredCanvasString(assetIdInput, '画布资产标识', 64)
    const currentProjectContent = requiredCanvasText(currentProjectContentInput, '当前画布项目内容', maximumSavedFileBytes)
    const currentWorkflow = parseCanvasProjectWorkflow(currentProjectContent).workflow
    const [projects, runs] = await Promise.all([
      options.projects.findAssetReferences(userId, assetId),
      options.canvasRuns.listRuns(userId),
    ])
    assertCanvasUserUnchanged(userId)
    const currentNodeIds = findCanvasWorkflowAssetReferenceNodeIds(currentWorkflow, assetId)
    const runReferences = findCanvasRunAssetReferences(runs, assetId)
    return {
      assetId,
      inUse: currentNodeIds.length > 0 || projects.length > 0 || runReferences.length > 0,
      currentProject: {
        projectId,
        projectName: String(currentWorkflow.name),
        nodeIds: currentNodeIds,
      },
      projects,
      runs: runReferences,
    }
  }

  registerCanvasHandler(canvasHostDeleteAssetChannel, async (event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    const context = await activeAssetContext(event.sender.id, userId)
    // Deliberately not reference-checked: assets are referenced because they
    // were used, so blocking here would make the bin unreachable for exactly
    // the assets a library needs to shed. Nothing leaves the disk yet.
    const deleted = await (context?.media ?? options.mediaAssets).softDelete(userId, parseCanvasAssetId(assetIdInput))
    assertCanvasUserUnchanged(userId)
    return deleted
  })

  registerCanvasHandler(canvasHostRestoreAssetChannel, async (event, assetIdInput) => {
    const userId = authenticatedCanvasUserId()
    const context = await activeAssetContext(event.sender.id, userId)
    const restored = await (context?.media ?? options.mediaAssets).restore(userId, parseCanvasAssetId(assetIdInput))
    assertCanvasUserUnchanged(userId)
    return restored
  })

  registerCanvasHandler(canvasHostPurgeAssetChannel, async (event, assetIdInput, currentProjectContentInput) => {
    const userId = authenticatedCanvasUserId()
    const assetId = parseCanvasAssetId(assetIdInput)
    const context = await activeAssetContext(event.sender.id, userId)
    // The reference check runs here, at the point of no return: a workflow that
    // loses an input it still points at cannot be repaired by an undo.
    const purged = await (context?.media ?? options.mediaAssets).purge(
      userId,
      assetId,
      () => assetReferenceReport(event.sender.id, userId, assetId, currentProjectContentInput),
    )
    assertCanvasUserUnchanged(userId)
    return purged
  })

  registerCanvasHandler(canvasHostInspectAssetReferencesChannel, async (event, assetIdInput, currentProjectContentInput) => {
    const userId = authenticatedCanvasUserId()
    return assetReferenceReport(event.sender.id, userId, assetIdInput, currentProjectContentInput)
  })

  async function importCanvasAsset(ownerId: number, userId: number, filePath: string) {
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('本地媒体路径无效')
    assertNoReparseComponents(filePath, '画布导入媒体')
    const source = await fs.promises.lstat(filePath, { bigint: true })
    if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1n) throw new Error('本地媒体文件不安全')
    const extension = path.extname(filePath).toLowerCase()
    const kind = ['.png', '.jpg', '.jpeg', '.webp'].includes(extension)
      ? 'image'
      : ['.mp3', '.wav', '.ogg', '.m4a'].includes(extension)
        ? 'audio'
        : extension === '.mp4'
          ? 'video'
          : null
    if (!kind) throw new Error('本地媒体格式不支持，仅支持 PNG、JPEG、WebP、MP4、MP3、WAV、OGG 或 M4A')
    const context = await activeAssetContext(ownerId, userId)
    const audioStore = context?.audios ?? options.audioAssets
    const videoStore = context?.videos ?? options.videoAssets
    const imageStore = context?.images ?? options.aiAssets
    if (kind === 'audio' && !audioStore) throw new Error('当前版本不支持音频素材')
    if (kind === 'video' && !videoStore) throw new Error('当前版本不支持视频素材')
    const asset = kind === 'audio'
      ? await audioStore!.storeLocalFile(userId, filePath)
      : kind === 'video'
        ? await videoStore!.storeLocalFile(userId, filePath)
        : await imageStore.storeLocalFile(userId, filePath)
    try {
      assertCanvasUserUnchanged(userId)
      await (context?.media ?? options.mediaAssets).setSource(userId, asset.assetId, 'imported').catch((error) => {
        options.runtimeLog.log('warn', 'canvas', 'asset.source.persist.failed', '素材已导入，但来源信息保存失败', {
          assetId: asset.assetId,
          reason: error instanceof Error ? error.message : String(error),
        })
      })
      assertCanvasUserUnchanged(userId)
      return kind === 'image' ? asset : { ...asset, mediaType: kind }
    } catch (error) {
      if (kind === 'image') await imageStore.removeOwned(userId, asset.assetId).catch(() => undefined)
      throw error
    }
  }

  registerCanvasHandler(canvasHostPickAssetChannel, async (event) => {
    const userId = authenticatedCanvasUserId()
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '画布：选择媒体素材',
      properties: ['openFile'],
      filters: [
        { name: '媒体素材', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mp3', 'wav', 'ogg', 'm4a'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: '视频', extensions: ['mp4'] },
        { name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a'] },
      ],
    }
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return null
    return importCanvasAsset(event.sender.id, userId, result.filePaths[0])
  })

  registerCanvasHandler(canvasHostImportAssetFileChannel, async (event, filePathInput) => {
    const userId = authenticatedCanvasUserId()
    const filePath = requiredCanvasString(filePathInput, '本地媒体路径', 32_768)
    if (!path.isAbsolute(filePath)) throw new Error('本地媒体路径无效')
    return importCanvasAsset(event.sender.id, userId, filePath)
  })

  registerCanvasHandler(canvasHostStartRunChannel, async (event, input) => {
    const { graph, scope } = parseCanvasStartRunInput(input)
    const userId = authenticatedCanvasUserId()
    const projectId = activeProjectId(event.sender.id, userId)
    const handle = await options.canvasRuns.start({
      userId,
      ownerId: event.sender.id,
      ...(projectId ? { projectId } : {}),
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

  registerCanvasHandler(canvasHostListRunsChannel, async (event) => {
    const userId = authenticatedCanvasUserId()
    const projectId = activeProjectId(event.sender.id, userId)
    const runs = await options.canvasRuns.listRuns(userId, projectId)
    assertCanvasUserUnchanged(userId)
    return runs
  })

  registerCanvasHandler(canvasHostExportProjectChannel, async (event, suggestedNameInput, contentInput) => {
    const userId = authenticatedCanvasUserId()
    const suggestedName = requiredCanvasString(suggestedNameInput, '画布项目文件名', 256)
    const workflowContent = requiredCanvasText(contentInput, '画布项目工作流', maximumSavedFileBytes)
    const parsed = parseCanvasProjectWorkflow(workflowContent)
    const context = await activeAssetContext(event.sender.id, userId)
    const imageStore = context?.images ?? options.aiAssets
    const sources = await Promise.all(parsed.assetIds.map((assetId) => imageStore.readOwned(userId, assetId)))
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
    const context = await activeAssetContext(event.sender.id, userId)
    const imageStore = context?.images ?? options.aiAssets
    const media = context?.media ?? options.mediaAssets
    try {
      for (const entry of pending.parsed.assets) {
        assertCanvasUserUnchanged(userId)
        const asset = await imageStore.storeBase64(userId, `data:${entry.mimeType};base64,${entry.bytes.toString('base64')}`)
        imported.push(asset.assetId)
        await media.setSource(userId, asset.assetId, 'imported').catch((error) => {
          options.runtimeLog.log('warn', 'canvas', 'asset.source.persist.failed', '项目素材已导入，但来源信息保存失败', {
            assetId: asset.assetId,
            reason: error instanceof Error ? error.message : String(error),
          })
        })
        mappings.set(entry.assetId, asset.assetId)
      }
      assertCanvasUserUnchanged(userId)
    } catch (error) {
      await Promise.all(imported.map((assetId) => imageStore.removeOwned(userId, assetId).catch(() => undefined)))
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
      backgroundColor: canvasWindowBackgroundForTheme(currentTheme),
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
      options.videoService.cancelSender(senderId)
      options.canvasRuns.cancelOwner(senderId)
      generationAdmission.releaseOwner(senderId)
      pendingProjects.delete(senderId)
      activeProjects.delete(senderId)
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
    const canvasUrl = new URL(canvasPackagedBaseUrl)
    canvasUrl.searchParams.set('theme', currentTheme)
    await window.loadURL(canvasUrl.href)
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
    setTheme(theme) {
      currentTheme = theme
      if (!canvasWindow || canvasWindow.isDestroyed()) return
      canvasWindow.setBackgroundColor(canvasWindowBackgroundForTheme(theme))
      canvasWindow.webContents.send(canvasHostThemeChangedChannel, theme)
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

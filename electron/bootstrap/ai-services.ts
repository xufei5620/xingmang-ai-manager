// 按账号站点分开的 AI 工作区（#1070 第 5 步从 main.ts 的启动回调原样搬出）：聊天、画图、视频、画布运行、
// 作品存储和缩略图每个站点一份，第一次用到那个站点时才建，之后一直用这一份。main.ts 只把当前站点那份
// 用 createRealmServiceDispatch 包一层交出去。

import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, Menu, nativeImage, safeStorage, shell } from 'electron'
import { AccountCredentialStore } from '../account-credential-store'
import { createAccountUsageTracker } from '../account-usage-tracker'
import { createActiveIdentityReader } from '../active-identity'
import { AiAssetMetadataStore } from '../ai-asset-metadata-store'
import { createAiAssetProtocolHandler } from '../ai-asset-protocol'
import { AiAssetStore } from '../ai-asset-store'
import { AiAudioAssetStore } from '../ai-audio-asset-store'
import { createChatAttachmentService, type ChatImageCodec } from '../ai-chat-attachments'
import { AI_CHAT_STREAM_LIMITS, createAiChatService } from '../ai-chat-service'
import { createAiImageService } from '../ai-image-service'
import { createAiMediaAssetService, type AiMediaAssetService } from '../ai-media-asset-service'
import { chooseAiOutputRoot, migrateLegacyAiOutput, resolveLegacyAiOutputRoot } from '../ai-output-location'
import { AiVideoAssetStore } from '../ai-video-asset-store'
import { createAiVideoService, type AiVideoAssetWriter } from '../ai-video-service'
import { AiVideoTaskStore } from '../ai-video-task-store'
import { assetThumbnailMaxEdge, assetThumbnailSize } from '../asset-thumbnail'
import { createAssetThumbnailService, type AssetThumbnailRenderer } from '../asset-thumbnail-service'
import { AssetThumbnailStore } from '../asset-thumbnail-store'
import { createCanvasNodeExecutors } from '../canvas-node-executors'
import { CanvasProjectAssetManager, createCanvasProjectAssetContext } from '../canvas-project-asset-manager'
import { CanvasProjectStore } from '../canvas-project-store'
import { CanvasPromptPresetStore } from '../canvas-prompt-preset-store'
import { createCanvasRunService } from '../canvas-run-service'
import { CanvasRunStore } from '../canvas-run-store'
import { createChatCredentialCoordinator } from '../chat-credential-coordinator'
import { ChatKeyStore } from '../chat-key-store'
import { readClipboardPng, writeClipboardPng } from '../clipboard-image'
import { ipcEventChannels } from '../ipc-contract'
import type { AccountGroupHints } from '../managed-cli-groups'
import { ManagedCliKeyStore } from '../managed-cli-key-store'
import type { RealmAccountService, RealmAccountSiteId } from '../realm-account-service'
import { resolveRealmDataRoots } from '../realm-data-roots'
import { createRealmServiceDispatch } from '../realm-service-dispatch'
import type { RuntimeLogStore } from '../runtime-log'
import type { CredentialPersistence } from '../safe-storage-backend'
import { requireSiteRuntimeDefinition } from '../site-runtime'
import type { SystemService } from '../system-service'
import { assetMenuFailureDialog, type AssetMenuMediaType } from '../window-presentation'

/**
 * Derives thumbnails with Electron's bundled Skia encoder.
 *
 * The plan called for `createImageBitmap` plus `OffscreenCanvas` in a
 * `utilityProcess`. That is not available: a utility process is a Node.js
 * environment with Electron's `net` module, not a Blink one, so it has neither
 * global. The alternative that keeps those APIs would be a hidden
 * `BrowserWindow`, which adds a renderer surface for no benefit. `nativeImage`
 * gives the same Chromium decoders synchronously in the main process with zero
 * new dependencies, which is why generation is serialized behind a queue.
 */
/**
 * 主窗口（视频剪辑页）出的视频存进全局作品库，和对话里出的图片同一处。没有 prepareProject：
 * 它不属于哪个画布项目，画布那份没选项目就停下的检查不该拦它。参考图按编号先找全局、再找各个项目，
 * 对话里选的图片也在全局里。
 */
export function createGlobalVideoAssetWriter(options: {
  images: Pick<AiAssetStore, 'assertWritable'>
  videos: Pick<AiVideoAssetStore, 'storeMp4'>
  media: Pick<AiMediaAssetService, 'setSource'>
  references: Pick<CanvasProjectAssetManager, 'readImageDataUri' | 'readMediaOwned'>
  log: Pick<RuntimeLogStore, 'log'>
}): AiVideoAssetWriter {
  return {
    assertWritable: (userId) => options.images.assertWritable(userId),
    async storeMp4(userId, bytes, metadata) {
      const asset = await options.videos.storeMp4(userId, bytes, { taskId: metadata.taskId })
      // 来源只影响作品库里的筛选和提示词显示；片段已经存下了，记不上也不该让这次出片算失败。
      await options.media.setSource(userId, asset.assetId, 'generated', metadata.prompt).catch((error: unknown) => options.log.log(
        'warn', 'ai-chat', 'asset.source.persist.failed', '生成素材已保存，但来源信息保存失败',
        { userId, assetId: asset.assetId, source: 'generated', reason: error instanceof Error ? error.message : String(error) },
      ))
      return asset
    },
    readImageDataUri: (userId, assetId) => options.references.readImageDataUri(userId, assetId),
    readOwned: (userId, assetId, kind) => options.references.readMediaOwned(userId, assetId, kind),
  }
}

function createNativeThumbnailRenderer(): AssetThumbnailRenderer {
  return {
    async fromImageBytes(bytes, mimeType) {
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) return null
      const { width, height } = image.getSize()
      const contained = assetThumbnailSize(width, height)
      const resized = image.resize({ ...contained, quality: 'better' })
      if (resized.isEmpty()) return null
      return mimeType === 'image/jpeg' ? resized.toJPEG(82) : resized.toPNG()
    },
    async fromMediaFile(filePath) {
      // Backed by the platform shell thumbnail provider, which exists only on
      // Windows and macOS. Both are the platforms this product ships on, and
      // elsewhere the tray falls back to its own placeholder.
      if (process.platform !== 'win32' && process.platform !== 'darwin') return null
      try {
        const image = await nativeImage.createThumbnailFromPath(filePath, {
          width: assetThumbnailMaxEdge,
          height: assetThumbnailMaxEdge,
        })
        return image.isEmpty() ? null : image.toPNG()
      } catch {
        return null
      }
    },
  }
}

// 作品菜单的「复制」：先用系统的图片解码认一遍（坏图当场说），再统一以 PNG 放上剪贴板。
async function copyImageToClipboard(bytes: Buffer): Promise<void> {
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) throw new Error('图片内容无效，无法复制')
  await writeClipboardPng(clipboard, (payload) => new ClipboardItem(payload), image.toPNG())
}

// Screenshots pasted into the chat are shrunk here, in the main process, before
// anything is stored or sent. nativeImage decodes PNG and JPEG on every
// platform; a WebP it cannot read comes back empty and is reported as such.
const nativeChatImageCodec: ChatImageCodec = {
  decode(bytes, maxEdge) {
    let image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return null
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    if (longest > maxEdge) {
      const scale = maxEdge / longest
      image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' })
    }
    const resized = image.getSize()
    return { width: resized.width, height: resized.height, png: () => image.toPNG(), jpeg: (quality) => image.toJPEG(quality) }
  },
}

export interface RealmBusinessesOptions {
  managerDataDirectory: string
  /** 开发版的 AI 作品默认存在项目目录下（chooseAiOutputRoot），由 main.ts 按它自己所在的位置给。 */
  projectRoot: string
  accounts: Pick<RealmAccountService, 'client' | 'getSiteId' | 'assertReady'>
  /** 主窗口建得比这里晚，用到时再取。 */
  mainWindow: () => BrowserWindow | null
  credentialPersistence: CredentialPersistence
  systemService: Pick<SystemService, 'fetchAvailableModels'>
  readAccountGroupHints: () => Promise<AccountGroupHints | null>
  readDocumentsDirectory: () => string | null
  runtimeLog: RuntimeLogStore
  sessionFetch: typeof fetch
  routedRelayFetch: typeof fetch
}

export function createRealmBusinesses(options: RealmBusinessesOptions) {
  const {
    managerDataDirectory, projectRoot, accounts, mainWindow, credentialPersistence, systemService,
    readAccountGroupHints, readDocumentsDirectory, runtimeLog, sessionFetch, routedRelayFetch,
  } = options
  // Each realm moves its own subtree once per launch; a second realm object for
  // the same subtree must not start a second walk over files already moving.
  const aiOutputMigrations = new Set<string>()
  function migrateAiOutputOnce(from: string, to: string, mergeMetadata: (userId: number, content: string) => Promise<void>): void {
    if (aiOutputMigrations.has(from)) return
    aiOutputMigrations.add(from)
    void migrateLegacyAiOutput(from, to, { mergeMetadata }).then((result) => {
      if (!result.moved && !result.kept && !result.failed) return
      // Counts only: support needs to know whether anything stayed behind, not
      // where the user's files are (I13).
      runtimeLog.log(result.failed ? 'warn' : 'info', 'ai-chat', 'asset.output.migrated', '老版本的 AI 作品已搬到新的保存位置', { ...result })
    }).catch((error) => runtimeLog.exception('ai-chat', 'asset.output.migrate-failed', error))
  }
  function createBusiness(siteId: RealmAccountSiteId) {
    // AI 工作区的请求同样按默认线路的地址发，走哪条线路由 routedRelayFetch 换（「自动」会在运行中换线路）。
    const definition = requireSiteRuntimeDefinition(siteId)
    const roots = resolveRealmDataRoots(managerDataDirectory, definition.realmId)
    const accountService = createRealmServiceDispatch(() => {
      if (accounts.getSiteId() !== siteId) throw new Error('账号上下文已变化，请重试')
      return accounts.client
    })
    const onAiRequestStarted = createAccountUsageTracker({
      identities: createActiveIdentityReader(definition, {
        getSessionState: () => accountService.getSessionState(),
        getSessionRevision: () => accountService.getSessionRevision!(),
      }),
      assertReady: accounts.assertReady,
      emit: (event) => {
        const managedMainWindow = mainWindow()
        if (!managedMainWindow || managedMainWindow.isDestroyed()) return
        if (managedMainWindow.webContents.isDestroyed()) return
        managedMainWindow.webContents.send(ipcEventChannels.onAccountUsageChanged, event)
      },
    })
    const accountCredentialStore = new AccountCredentialStore(path.join(roots.rootDirectory, 'account-credentials.dat'), safeStorage)
    const managedCliKeyStore = new ManagedCliKeyStore(roots.managedCliKeysFile, safeStorage, siteId, credentialPersistence)
    const chatKeyStore = new ChatKeyStore(roots.chatKeysFile, safeStorage, credentialPersistence, siteId)
    // AI 工作区查模型是星芒自己的请求：「自动」时直连没走通当场改走默认线路。
    const chatCredentials = createChatCredentialCoordinator({ accountService, keyStore: chatKeyStore, modelService: {
      fetchAvailableModels: (apiKey, options) => systemService.fetchAvailableModels(apiKey, { ...options, routed: true }),
    }, loadAccountGroupHints: readAccountGroupHints })
    // 「文档」不让写时改存到主目录下（ai-output-location.ts），检查页照实说。
    const aiOutputPlacement = chooseAiOutputRoot({
      isPackaged: app.isPackaged,
      projectRoot,
      documentsDirectory: readDocumentsDirectory(),
      location: { platform: process.platform, home: os.homedir(), env: process.env },
      scope: (root) => roots.assetOutputDirectory(root),
    })
    const aiOutputRoot = aiOutputPlacement.root
    if (aiOutputPlacement.movedFromDocuments) {
      runtimeLog.log('warn', 'ai-chat', 'asset.output-directory.moved-from-documents', '「文档」不让写，AI 作品改存到个人文件夹', {
        earlierWorksLeftInDocuments: aiOutputPlacement.earlierWorksLeftInDocuments,
      })
    }
    if (aiOutputPlacement.earlierWorksLeftInSyncedDocuments) {
      runtimeLog.log('info', 'ai-chat', 'asset.output-directory.earlier-works-in-synced-documents', '「文档」开了云盘同步，以前的 AI 作品还在「文档」里', {
        cloud: aiOutputPlacement.earlierWorksLeftInSyncedDocuments,
      })
    }
    // 以前这六个菜单出错时一行日志都不记，客服事后查不到；错误框里只说中文（assetMenuFailureDialog）。
    function showAssetMenuFailure(source: 'ai-chat' | 'canvas', mediaType: AssetMenuMediaType, action: string, error: unknown): void {
      runtimeLog.exception(source, 'asset.menu.failed', error, { mediaType, action })
      const content = assetMenuFailureDialog(mediaType, error)
      dialog.showErrorBox(content.title, content.message)
    }
    const assetStore = new AiAssetStore({
      outputRoot: aiOutputRoot,
      // 全局保存位置在「文档」里，写不进多半是整个文档出了状况，用户自己能绕开的是
      // 画布项目：新项目的作品存在用户自己选的文件夹里。
      unwritableGuidance: '可以先在画布里新建一个项目、给它选一个自己的文件夹，在那里生成就能存下来；也可以联系客服。',
      trustedProxyFetchImpl: sessionFetch,
      nativeOperations: {
        copyImage: copyImageToClipboard,
        selectSavePath: async (suggestedFileName) => {
          const result = await dialog.showSaveDialog({
            title: '图片另存为',
            defaultPath: suggestedFileName,
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'webp'] }],
          })
          return result.canceled ? null : result.filePath ?? null
        },
        revealInFolder: (filePath) => shell.showItemInFolder(filePath),
        showContextMenu: (items) => {
          const menu = Menu.buildFromTemplate(items.map((item) => ({
            id: item.id,
            label: item.label,
            click: () => {
              void item.run().catch((error) => showAssetMenuFailure('ai-chat', 'image', item.id, error))
            },
          })))
          menu.popup()
        },
      },
    })
    // Create the output location at startup and prove it accepts a file, so a
    // location that cannot be written shows up in the log and on the check page
    // (AI_OUTPUT) before anyone pays for a generation. Every paid request probes
    // again, and the write path is still checked by AiAssetStore for each asset.
    void assetStore.assertWritable().catch((error) => {
      runtimeLog.log('warn', 'ai-chat', 'asset.output-directory.unavailable', 'AI 作品保存位置写不进去', {
        // The user-facing message only says "写不进去"; the log keeps the OS
        // reason (EACCES, EROFS, ENOSPC …) that support needs.
        reason: error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error),
      })
    })
    const videoAssets = new AiVideoAssetStore({
      outputRoot: aiOutputRoot,
      nativeOperations: {
        selectSavePath: async (suggestedFileName) => {
          const result = await dialog.showSaveDialog({
            title: '视频另存为', defaultPath: suggestedFileName,
            filters: [{ name: '视频', extensions: ['mp4'] }],
          })
          return result.canceled ? null : result.filePath ?? null
        },
        revealInFolder: (filePath) => shell.showItemInFolder(filePath),
        showContextMenu: (items) => {
          Menu.buildFromTemplate(items.map((item) => ({
            id: item.id, label: item.label,
            click: () => { void item.run().catch((error) => showAssetMenuFailure('ai-chat', 'video', item.id, error)) },
          }))).popup()
        },
      },
    })
    const audioAssets = new AiAudioAssetStore({
      outputRoot: aiOutputRoot,
      nativeOperations: {
        selectSavePath: async (suggestedFileName) => {
          const result = await dialog.showSaveDialog({ title: '音频另存为', defaultPath: suggestedFileName, filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }] })
          return result.canceled ? null : result.filePath ?? null
        },
        revealInFolder: (filePath) => shell.showItemInFolder(filePath),
        showContextMenu: (items) => {
          Menu.buildFromTemplate(items.map((item) => ({ id: item.id, label: item.label, click: () => { void item.run().catch((error) => showAssetMenuFailure('ai-chat', 'audio', item.id, error)) } }))).popup()
        },
      },
    })
    const assetMetadata = new AiAssetMetadataStore({ outputRoot: aiOutputRoot })
    // 老版本存在可执行文件旁边的 output 里。画布、聊天记录只按作品编号找文件，
    // 搬的时候布局不变，老作品搬完照样能打开；搬的过程在后台，不拖慢启动。
    // 元数据合并交给正在用的这个 store，和搬家期间的收藏、新作品写入排同一个队。
    const legacyAiOutputRoot = resolveLegacyAiOutputRoot({ isPackaged: app.isPackaged, execPath: process.execPath })
    if (legacyAiOutputRoot) {
      migrateAiOutputOnce(roots.assetOutputDirectory(legacyAiOutputRoot), aiOutputRoot, (userId, content) => assetMetadata.mergeLegacy(userId, content))
    }
    // Permanent deletion hands the file to the OS recycle bin rather than
    // unlinking it. The bytes are the user's artwork; the last recoverable copy
    // should not depend on this program being right.
    const trashItem = (filePath: string) => shell.trashItem(filePath)
    const mediaAssets = createAiMediaAssetService({ images: assetStore, videos: videoAssets, audios: audioAssets, metadata: assetMetadata, trashItem })
    const canvasProjects = new CanvasProjectStore(roots.canvasProjectsDirectory)
    const createProjectAssetContext = (outputRoot: string) => {
      const images = new AiAssetStore({
        outputRoot,
        unwritableGuidance: '这个项目的文件夹可能被移走了，或者放不进新文件。请新建一个项目、换个文件夹再试。',
        trustedProxyFetchImpl: sessionFetch,
        nativeOperations: {
          copyImage: copyImageToClipboard,
          selectSavePath: async (suggestedFileName) => {
            const result = await dialog.showSaveDialog({
              title: '图片另存为', defaultPath: suggestedFileName,
              filters: [{ name: '图片', extensions: ['png', 'jpg', 'webp'] }],
            })
            return result.canceled ? null : result.filePath ?? null
          },
          revealInFolder: (filePath) => shell.showItemInFolder(filePath),
          showContextMenu: (items) => {
            Menu.buildFromTemplate(items.map((item) => ({
              id: item.id, label: item.label,
              click: () => { void item.run().catch((error) => showAssetMenuFailure('canvas', 'image', item.id, error)) },
            }))).popup()
          },
        },
      })
      const videos = new AiVideoAssetStore({
        outputRoot,
        nativeOperations: {
          selectSavePath: async (suggestedFileName) => {
            const result = await dialog.showSaveDialog({ title: '视频另存为', defaultPath: suggestedFileName, filters: [{ name: '视频', extensions: ['mp4'] }] })
            return result.canceled ? null : result.filePath ?? null
          },
          revealInFolder: (filePath) => shell.showItemInFolder(filePath),
          showContextMenu: (items) => {
            Menu.buildFromTemplate(items.map((item) => ({ id: item.id, label: item.label, click: () => { void item.run().catch((error) => showAssetMenuFailure('canvas', 'video', item.id, error)) } }))).popup()
          },
        },
      })
      const audios = new AiAudioAssetStore({
        outputRoot,
        nativeOperations: {
          selectSavePath: async (suggestedFileName) => {
            const result = await dialog.showSaveDialog({ title: '音频另存为', defaultPath: suggestedFileName, filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }] })
            return result.canceled ? null : result.filePath ?? null
          },
          revealInFolder: (filePath) => shell.showItemInFolder(filePath),
          showContextMenu: (items) => {
            Menu.buildFromTemplate(items.map((item) => ({ id: item.id, label: item.label, click: () => { void item.run().catch((error) => showAssetMenuFailure('canvas', 'audio', item.id, error)) } }))).popup()
          },
        },
      })
      return createCanvasProjectAssetContext(images, videos, audios, new AiAssetMetadataStore({ outputRoot }), trashItem)
    }
    const canvasProjectAssets = new CanvasProjectAssetManager({
      realmId: definition.realmId,
      projects: canvasProjects,
      global: createCanvasProjectAssetContext(assetStore, videoAssets, audioAssets, assetMetadata, trashItem),
      create: createProjectAssetContext,
      onMetadataError: (error, context) => runtimeLog.log(
        'warn',
        'canvas',
        'asset.source.persist.failed',
        '生成素材已保存，但来源信息保存失败',
        { ...context, reason: error instanceof Error ? error.message : String(error) },
      ),
    })
    const assetThumbnails = createAssetThumbnailService({
      store: new AssetThumbnailStore({ cacheRoot: roots.assetThumbnailsDirectory }),
      renderer: createNativeThumbnailRenderer(),
      sources: {
        // Must resolve through the project asset manager, not the global store.
        // Canvas projects keep their media under the project workspace, so
        // deriving from `output/` alone left every project asset without a
        // thumbnail and the tray showed a placeholder for all of them.
        readImage: async (userId, assetId) => {
          const owned = await canvasProjectAssets.readOwned(userId, assetId, 'image')
          return { bytes: owned.bytes, mimeType: owned.asset.mimeType }
        },
        resolveVideoPath: (userId, assetId) => canvasProjectAssets.resolveOwnedFilePath(userId, assetId, 'video'),
      },
      onFailure: (assetId, reason) => runtimeLog.log(
        'warn',
        'canvas',
        'asset.thumbnail.failed',
        '素材缩略图生成失败，已回退到占位图',
        { assetId, reason },
      ),
    })
    const chatAttachments = createChatAttachmentService({
      store: assetStore,
      codec: nativeChatImageCodec,
      pickFiles: async () => {
        const result = await dialog.showOpenDialog({
          title: '选择要发给 AI 的图片',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        })
        return result.canceled ? [] : result.filePaths
      },
      readClipboardImage: async () => {
        const png = await readClipboardPng(clipboard)
        if (!png) return null
        const image = nativeImage.createFromBuffer(png)
        return image.isEmpty() ? null : image.toPNG()
      },
    })
    const assetProtocol = createAiAssetProtocolHandler({
      assets: canvasProjectAssets,
      identities: createActiveIdentityReader(definition, { getSessionState: () => accountService.getSessionState(),
        getSessionRevision: () => accountService.getSessionRevision!() }),
      thumbnails: assetThumbnails,
    })
    const chatService = createAiChatService({
      onRequestStarted: onAiRequestStarted,
      readChatImage: (userId, assetId) => chatAttachments.readDataUri(userId, assetId),
      baseUrl: definition.aiBaseUrl,
      backend: definition.backend,
      credentialCoordinator: chatCredentials,
      fetchImpl: routedRelayFetch,
      emit: (senderId, event) => {
        const sender = BrowserWindow.getAllWindows()
          .map((window) => window.webContents)
          .find((contents) => contents.id === senderId && !contents.isDestroyed())
        if (!sender) throw new Error('AI聊天窗口已关闭')
        if (event.type === 'delta') {
          if (event.content) sender.send(ipcEventChannels.onAiChatStream, {
            requestId: event.requestId,
            type: 'content',
            content: event.content,
          })
          if (event.reasoning) sender.send(ipcEventChannels.onAiChatStream, {
            requestId: event.requestId,
            type: 'reasoning',
            content: event.reasoning,
          })
          return
        }
        if (event.type === 'error') sender.send(ipcEventChannels.onAiChatStream, {
          requestId: event.requestId,
          type: 'error',
          code: event.code,
          message: event.message,
        })
        else sender.send(ipcEventChannels.onAiChatStream, {
          requestId: event.requestId,
          type: event.type,
        })
      },
      log: (entry) => runtimeLog.log(
        entry.status === 'error' ? 'warn' : 'debug',
        'chat',
        `stream.${entry.status}`,
        `AI聊天流已${entry.status === 'complete' ? '完成' : '结束'}`,
        entry,
      ),
    })
    runtimeLog.log('info', 'chat', 'network.ready', 'AI聊天网络栈已就绪', {
      transport: 'electron-net',
      responseHeaderTimeoutMs: AI_CHAT_STREAM_LIMITS.connectionTimeoutMs,
    })
    const imageService = createAiImageService({
      onRequestStarted: onAiRequestStarted,
      fetchImpl: routedRelayFetch,
      baseUrl: definition.aiBaseUrl,
      backend: definition.backend,
      credentials: chatCredentials,
      assets: assetStore,
    })
    const canvasImageService = createAiImageService({
      onRequestStarted: onAiRequestStarted,
      fetchImpl: routedRelayFetch,
      baseUrl: definition.aiBaseUrl,
      backend: definition.backend,
      credentials: chatCredentials,
      // 画布点停止、关窗、换号时，已经发出去的图照样收完放进付钱那个账号的素材库（#1394 第 6 条）；对话页那份不开。
      finishDispatchedAfterStop: true,
      onFinishedAfterStop: (outcome) => {
        if ('error' in outcome) runtimeLog.log('warn', 'canvas', 'image.after-stop.failed', '停止后继续收的图没收到', outcome)
        else runtimeLog.log('info', 'canvas', 'image.after-stop.stored', '停止后继续收的图已放进素材库', outcome)
      },
      assets: {
        prepareProject: (userId, projectId) => canvasProjectAssets.prepareProject(userId, projectId),
        assertWritable: (userId, projectId) => canvasProjectAssets.assertWritable(userId, projectId),
        storeBase64: (userId, value, metadata) => canvasProjectAssets.storeBase64(userId, value, metadata),
        storeRemoteUrl: (userId, url, metadata) => canvasProjectAssets.storeRemoteUrl(userId, url, metadata),
        readOwned: (userId, assetId, projectId) => canvasProjectAssets.readImageOwned(userId, assetId, projectId),
        addTag: (userId, assetIds, tag, projectId) => canvasProjectAssets.addImageTag(userId, assetIds, tag, projectId),
      },
    })
    const videoTasks = new AiVideoTaskStore({
      rootDirectory: roots.canvasVideoTasksDirectory,
    })
    const videoService = createAiVideoService({
      onRequestStarted: onAiRequestStarted,
      fetchImpl: routedRelayFetch,
      baseUrl: definition.aiBaseUrl,
      credentials: chatCredentials,
      tasks: videoTasks,
      assets: {
        prepareProject: (userId, projectId) => canvasProjectAssets.prepareProject(userId, projectId),
        assertWritable: (userId, projectId) => canvasProjectAssets.assertWritable(userId, projectId),
        storeMp4: (userId, bytes, metadata) => canvasProjectAssets.storeMp4(userId, bytes, metadata),
        readImageDataUri: (userId, assetId, projectId) => canvasProjectAssets.readImageDataUri(userId, assetId, projectId),
        readOwned: (userId, assetId, kind, projectId) => canvasProjectAssets.readMediaOwned(userId, assetId, kind, projectId),
      },
    })
    // 主窗口（视频剪辑页）出的视频不属于哪个画布项目，存进全局作品库，和对话里出的图片同一处。
    // 画布那份按项目存、没选项目就在扣费前停下，所以另起一份；任务记录也分开放，开机续查时两份各认各的。
    const chatVideoService = createAiVideoService({
      onRequestStarted: onAiRequestStarted,
      fetchImpl: routedRelayFetch,
      baseUrl: definition.aiBaseUrl,
      credentials: chatCredentials,
      tasks: new AiVideoTaskStore({ rootDirectory: roots.chatVideoTasksDirectory }),
      assets: createGlobalVideoAssetWriter({
        images: assetStore, videos: videoAssets, media: mediaAssets, references: canvasProjectAssets, log: runtimeLog,
      }),
    })
    if (siteId === 'solov-api') {
      for (const service of [videoService, chatVideoService]) {
        service.generate = async () => { throw new Error('当前账号暂不支持视频生成') }
        service.resumeVideoTask = async () => { throw new Error('当前账号暂不支持视频生成') }
      }
    }
    const canvasRunStore = new CanvasRunStore({
      rootDirectory: roots.canvasRuntimeDirectory,
      assets: canvasProjectAssets,
    })
    const canvasPromptPresets = new CanvasPromptPresetStore({
      rootDirectory: path.join(roots.rootDirectory, 'canvas-content'),
    })
    const canvasRuns = createCanvasRunService({
      store: canvasRunStore,
      executors: createCanvasNodeExecutors({
        imageService: canvasImageService,
        videoService,
        assets: canvasProjectAssets,
        completeText: {
          completeOnce: (input) => chatService.completeOnce({
            group: input.group,
            model: input.model,
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: input.user },
            ],
            signal: input.signal,
          }),
        },
      }),
    })
    return { accountCredentialStore, managedCliKeyStore, chatKeyStore, chatCredentials, assetStore, videoAssets,
      audioAssets, mediaAssets, canvasPromptPresets, canvasProjects, canvasProjectAssets,
      chatService, imageService, canvasImageService, videoService, chatVideoService, canvasRuns, assetProtocol, chatAttachments, aiOutputPlacement }
  }
  const businesses = new Map<RealmAccountSiteId, ReturnType<typeof createBusiness>>()
  type CanvasRunListener = Parameters<ReturnType<typeof createCanvasRunService>['subscribe']>[0]
  type CanvasRunUnsubscribe = ReturnType<ReturnType<typeof createCanvasRunService>['subscribe']>
  const canvasRunSubscriptions = new Set<{
    listener: CanvasRunListener
    removers: Map<RealmAccountSiteId, CanvasRunUnsubscribe>
  }>()
  const ensureBusiness = (siteId: RealmAccountSiteId) => {
    const existing = businesses.get(siteId)
    if (existing) return existing
    const created = createBusiness(siteId)
    businesses.set(siteId, created)
    // A renderer subscription can outlive a realm switch. Attach it to a
    // lazily-created realm as soon as that realm becomes available.
    for (const subscription of canvasRunSubscriptions) {
      subscription.removers.set(siteId, created.canvasRuns.subscribe(subscription.listener))
    }
    return created
  }
  function subscribeCanvasRuns(listener: CanvasRunListener): CanvasRunUnsubscribe {
    const subscription = { listener, removers: new Map<RealmAccountSiteId, CanvasRunUnsubscribe>() }
    for (const [siteId, business] of businesses) {
      subscription.removers.set(siteId, business.canvasRuns.subscribe(listener))
    }
    canvasRunSubscriptions.add(subscription)
    return () => {
      if (!canvasRunSubscriptions.delete(subscription)) return
      for (const unsubscribe of subscription.removers.values()) unsubscribe()
    }
  }
  return { businesses, ensureBusiness, subscribeCanvasRuns }
}

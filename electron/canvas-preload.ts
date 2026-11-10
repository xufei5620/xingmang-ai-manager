import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Sandboxed preload scripts cannot import local runtime modules (I7). These
// literals deliberately mirror canvas-contract.ts and are locked by tests.
const channels = {
  saveFile: 'canvas-host:save-file',
  pickFile: 'canvas-host:pick-file',
  notify: 'canvas-host:notify',
  openExternal: 'canvas-host:open-external',
  listGroups: 'canvas-host:list-groups',
  prepareGroup: 'canvas-host:prepare-group',
  generateImage: 'canvas-host:generate-image',
  editImage: 'canvas-host:edit-image',
  generateVideo: 'canvas-host:generate-video',
  resumeVideoTask: 'canvas-host:resume-video-task',
  cancelRequest: 'canvas-host:cancel-request',
  copyAsset: 'canvas-host:copy-asset',
  saveAsset: 'canvas-host:save-asset',
  showAssetMenu: 'canvas-host:asset-menu',
  listAssets: 'canvas-host:list-assets',
  getAssetDetail: 'canvas-host:get-asset-detail',
  renameAsset: 'canvas-host:rename-asset',
  updateAssetMetadata: 'canvas-host:update-asset-metadata',
  markAssetUsed: 'canvas-host:mark-asset-used',
  deleteAsset: 'canvas-host:delete-asset',
  restoreAsset: 'canvas-host:restore-asset',
  purgeAsset: 'canvas-host:purge-asset',
  inspectAssetReferences: 'canvas-host:inspect-asset-references',
  pickAsset: 'canvas-host:pick-asset',
  importAssetFile: 'canvas-host:import-asset-file',
  importAssetBytes: 'canvas-host:import-asset-bytes',
  completeRunPreparation: 'canvas-host:complete-run-preparation',
  listPromptPresets: 'canvas-host:list-prompt-presets',
  createPromptPreset: 'canvas-host:create-prompt-preset',
  updatePromptPreset: 'canvas-host:update-prompt-preset',
  deletePromptPreset: 'canvas-host:delete-prompt-preset',
  startRun: 'canvas-host:start-run',
  cancelRun: 'canvas-host:cancel-run',
  listRuns: 'canvas-host:list-runs',
  exportProject: 'canvas-host:export-project',
  previewProject: 'canvas-host:preview-project',
  importProject: 'canvas-host:import-project',
  listProjects: 'canvas-host:list-projects',
  createProject: 'canvas-host:create-project',
  openProject: 'canvas-host:open-project',
  saveProject: 'canvas-host:save-project',
  renameProject: 'canvas-host:rename-project',
  duplicateProject: 'canvas-host:duplicate-project',
  setProjectArchived: 'canvas-host:set-project-archived',
  createProjectInDefaultFolder: 'canvas-host:create-project-in-default-folder',
  relinkProjectFolder: 'canvas-host:relink-project-folder',
  deleteProject: 'canvas-host:delete-project',
  getAccountSummary: 'canvas-host:get-account-summary',
  getPriceSnapshot: 'canvas-host:get-price-snapshot',
  runEvent: 'canvas-host:run-event',
  accountChanged: 'canvas-host:account-changed',
  themeChanged: 'canvas-host:theme-changed',
  appearanceChanged: 'canvas-host:appearance-changed',
  closeRequested: 'canvas-host:close-requested',
  closeCancelled: 'canvas-host:close-cancelled',
  finishClose: 'canvas-host:finish-close',
  cancelCloseTasks: 'canvas-host:cancel-close-tasks',
} as const

// Mirrors desktopCanvasCapabilities in canvas-contract.ts (I7); the preload
// test loads this file and deep-compares the two. Answered here rather than
// over IPC: it is a constant, so it opens no main-process entry point.
const capabilities = deepFreeze({
  contractVersion: 1,
  host: 'desktop',
  executableNodeKinds: [
    'text', 'prompt', 'note', 'image', 'image-generate', 'image-edit', 'video', 'video-generate',
    'image-input', 'video-input', 'audio-input', 'router', 'gallery', 'output', 'group',
    'drama-bible', 'drama-script', 'drama-parse', 'drama-shot', 'drama-character', 'drama-scene', 'drama-prop',
    'text-generate', 'frame-extract',
  ],
  features: {
    quote: true,
    accountSummary: true,
    imageEditMask: true,
    textGenerate: true,
    textWebSearch: false,
    imageTools: false,
    frameExtract: true,
    scenarioTemplates: false,
    routerStrategy: false,
    generateAudio: false,
    referenceOrder: false,
    cloud: false,
    agentExecution: false,
    byteUpload: true,
    promptPresetGroups: false,
  },
  imageCandidates: { maximum: 4 },
  videoCandidates: { maximum: 1 },
  promptPresetNameMaxLength: 160,
  imageResolutions: {
    byModel: {
      'gemini-3.1-flash-image': ['1K', '2K', '4K'],
      'gpt-image-1': ['1K'],
      'gpt-image-2': ['1K', '2K', '4K'],
      'gpt-image-2-2026-04-21': ['1K', '2K', '4K'],
      jimeng_high_aes_general_v21_L: ['1K'],
      'grok-imagine-image': ['1K'],
      'grok-imagine-image-2.0': ['1K'],
      'grok-imagine-image-quality': ['1K'],
    },
    otherGptImage: ['1K', '2K', '4K'],
  },
  video: {
    siteIds: ['solov'],
    protocols: ['relay-videos'],
    seconds: { minimum: 1, maximum: 15 },
    dimensions: ['1280x720', '720x1280', '1024x1024', '1024x768', '768x1024'],
    miniMaxResolutions: ['480p', '720p'],
    miniMaxAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'],
  },
})

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

// Electron rejects a failed invoke with "Error invoking remote method
// '<channel>': <ClassName>: <reason>". The channel and class name are
// implementation details, yet the canvas puts error.message on nodes and
// banners verbatim, and canvas-v2 itself stays untouched, so the wrapper is
// peeled here before the error crosses the bridge. Same pattern as
// renderer-v2's stripIpcErrorPrefix (src/renderer-v2/ipc-error-prefix.ts),
// copied because a sandboxed preload cannot import it (I7); that module's test
// pins the two literals to each other. Only one class name is taken per
// layer, right after the channel and with a space after its colon, so a reason
// that itself starts with `EPERM:` or a `C:\` path keeps it.
const ipcErrorPrefix = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s+)?/

function hostError(error: unknown) {
  // Duck-typed: tests run this file in a separate VM realm whose Error differs.
  if (!error || typeof error !== 'object' || typeof (error as { message?: unknown }).message !== 'string') return error
  const original = (error as { message: string }).message
  let message = original
  // 一个 handler 再 invoke 另一个通道时前缀会嵌套多层，逐层剥净
  while (ipcErrorPrefix.test(message)) message = message.replace(ipcErrorPrefix, '')
  return message && message !== original ? new Error(message) : error
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    throw hostError(error)
  })
}

function subscribeCloseRequest(channel: string, listener: (request: { requestId: string }) => void) {
  const wrapped = (_event: unknown, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const requestId = (payload as { requestId?: unknown }).requestId
    if (typeof requestId === 'string' && /^[a-f0-9-]{36}$/i.test(requestId)) listener({ requestId })
  }
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

function subscribeAccountChange(listener: (change: { userId: number | null; previousUserId: number | null; siteId?: 'solov' | 'solov-api' }) => void) {
  const wrapped = (_event: unknown, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const value = payload as Record<string, unknown>
    const userId = value.userId === null
      ? null
      : typeof value.userId === 'number' && Number.isSafeInteger(value.userId) && value.userId > 0
        ? value.userId
        : undefined
    const previousUserId = value.previousUserId === null
      ? null
      : typeof value.previousUserId === 'number' && Number.isSafeInteger(value.previousUserId) && value.previousUserId > 0
        ? value.previousUserId
        : undefined
    if (userId === undefined || previousUserId === undefined) return
    const siteId = value.siteId
    if (siteId !== undefined && siteId !== 'solov' && siteId !== 'solov-api') return
    listener({ userId, previousUserId, ...(siteId === undefined ? {} : { siteId }) })
  }
  ipcRenderer.on(channels.accountChanged, wrapped)
  return () => ipcRenderer.removeListener(channels.accountChanged, wrapped)
}

contextBridge.exposeInMainWorld('xingmangCanvasHost', {
  capabilities: () => capabilities,
  saveFile: (suggestedName: string, content: string) => (
    invoke(channels.saveFile, suggestedName, content)
  ),
  pickFile: () => invoke(channels.pickFile),
  notify: (title: string, body?: string) => invoke(channels.notify, title, body),
  openExternal: (url: string) => invoke(channels.openExternal, url),
  listGroups: () => invoke(channels.listGroups),
  prepareGroup: (group: string) => invoke(channels.prepareGroup, group),
  generateImage: (input: unknown) => invoke(channels.generateImage, input),
  editImage: (input: unknown) => invoke(channels.editImage, input),
  generateVideo: (input: unknown) => invoke(channels.generateVideo, input),
  resumeVideoTask: (taskId: string) => invoke(channels.resumeVideoTask, taskId),
  cancelRequest: (requestId: string) => invoke(channels.cancelRequest, requestId),
  copyAsset: (assetId: string) => invoke(channels.copyAsset, assetId),
  saveAsset: (assetId: string) => invoke(channels.saveAsset, assetId),
  showAssetMenu: (assetId: string) => invoke(channels.showAssetMenu, assetId),
  listAssets: (query?: unknown) => invoke(channels.listAssets, query),
  // One asset as the library lists it. The kernel also passes an AbortSignal;
  // it does not cross the isolation boundary, so only the id is sent.
  getAssetDetail: (assetId: string) => invoke(channels.getAssetDetail, assetId),
  renameAsset: (input: unknown) => invoke(channels.renameAsset, input),
  updateAssetMetadata: (input: unknown) => invoke(channels.updateAssetMetadata, input),
  markAssetUsed: (assetId: string) => invoke(channels.markAssetUsed, assetId),
  deleteAsset: (assetId: string) => invoke(channels.deleteAsset, assetId),
  restoreAsset: (assetId: string) => invoke(channels.restoreAsset, assetId),
  purgeAsset: (assetId: string, currentProjectContent: string) => invoke(channels.purgeAsset, assetId, currentProjectContent),
  inspectAssetReferences: (assetId: string, currentProjectContent: string) => invoke(channels.inspectAssetReferences, assetId, currentProjectContent),
  pickAsset: () => invoke(channels.pickAsset),
  importAssetFile: async (file: File) => {
    const filePath = webUtils.getPathForFile(file)
    if (filePath) return invoke(channels.importAssetFile, filePath)
    // A picture the page drew itself (the mask editor's black-and-white PNG)
    // has no path. Only its bytes cross, and the main process decides from
    // the file header what it is; the page's name and type are not sent.
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('无法读取拖入的本地文件')
    if (file.size > 20 * 1024 * 1024) throw new Error('画布图片超过 20 MB，没有保存')
    return invoke(channels.importAssetBytes, new Uint8Array(await file.arrayBuffer()))
  },
  // 画布完善第 7 条第二步：抽帧节点要的那段视频。画布本来就能按这个地址读自己账号的视频（预览、播放），
  // 这里不开新通道，只是替内核读出来、限 32 MB（内核解码器的上限）。不接 AbortSignal：它过不了隔离边界。
  readVideoForFramePreview: async (assetId: string) => {
    if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(assetId)) throw new Error('视频素材标识格式错误')
    const response = await fetch(`xingmang-asset://video/${assetId}`, { cache: 'no-store', redirect: 'error' })
    if (!response.ok) throw new Error('视频读不出来，请确认素材还在')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > 32 * 1024 * 1024) throw new Error('视频超过 32 MB，画布抽不了这一帧')
    const blob = await response.blob()
    if (blob.size > 32 * 1024 * 1024) throw new Error('视频超过 32 MB，画布抽不了这一帧')
    return blob.type === 'video/mp4' ? blob : new Blob([blob], { type: 'video/mp4' })
  },
  // The frame the kernel decoded for a frame-extract node. Only the PNG bytes
  // and the ids the main process handed out cross; a failure carries no text.
  completeRunPreparation: async (input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('画布运行准备回执格式错误')
    const { runId, operationId, kind, outcome, png, decodedTimestampSeconds } = input as Record<string, unknown>
    if (outcome === 'failed') return invoke(channels.completeRunPreparation, { runId, operationId, kind, outcome })
    if (!(png instanceof Blob)) throw new Error('视频帧图片内容格式错误')
    if (png.size > 20 * 1024 * 1024) throw new Error('视频帧图片超过 20 MB，没有保存')
    return invoke(channels.completeRunPreparation, {
      runId,
      operationId,
      kind,
      outcome,
      png: new Uint8Array(await png.arrayBuffer()),
      ...(decodedTimestampSeconds !== undefined ? { decodedTimestampSeconds } : {}),
    })
  },
  listPromptPresets: () => invoke(channels.listPromptPresets),
  createPromptPreset: (input: unknown) => invoke(channels.createPromptPreset, input),
  updatePromptPreset: (input: unknown) => invoke(channels.updatePromptPreset, input),
  deletePromptPreset: (id: string) => invoke(channels.deletePromptPreset, id),
  startRun: (input: unknown) => invoke(channels.startRun, input),
  cancelRun: (runId: string) => invoke(channels.cancelRun, runId),
  listRuns: () => invoke(channels.listRuns),
  exportProject: (suggestedName: string, content: string) => invoke(channels.exportProject, suggestedName, content),
  previewProject: () => invoke(channels.previewProject),
  importProject: (previewId: string) => invoke(channels.importProject, previewId),
  listProjects: () => invoke(channels.listProjects),
  // The kernel's "save a copy" also passes the current workflow and the
  // project it came from. A wrong type is forwarded, not dropped, so the main
  // process refuses it instead of quietly creating an empty project.
  createProject: (name: string, initialWorkflowContent?: unknown, options?: unknown) => (
    initialWorkflowContent === undefined && options === undefined
      ? invoke(channels.createProject, name)
      : invoke(channels.createProject, name, initialWorkflowContent, options)
  ),
  openProject: (projectId: string) => invoke(channels.openProject, projectId),
  saveProject: (projectId: string, content: string) => invoke(channels.saveProject, projectId, content),
  renameProject: (projectId: string, name: string) => invoke(channels.renameProject, projectId, name),
  duplicateProject: (projectId: string, name: string) => invoke(channels.duplicateProject, projectId, name),
  setProjectArchived: (projectId: string, archived: boolean) => invoke(channels.setProjectArchived, projectId, archived),
  createProjectInDefaultFolder: (name: string) => invoke(channels.createProjectInDefaultFolder, name),
  relinkProjectFolder: (projectId: string) => invoke(channels.relinkProjectFolder, projectId),
  deleteProject: (projectId: string) => invoke(channels.deleteProject, projectId),
  // Takes nothing from the page, so the page cannot steer what the main process reads.
  getAccountSummary: () => invoke(channels.getAccountSummary),
  getPriceSnapshot: () => invoke(channels.getPriceSnapshot),
  onAccountChange: (listener: (change: { userId: number | null; previousUserId: number | null; siteId?: 'solov' | 'solov-api' }) => void) => subscribeAccountChange(listener),
  finishClose: (requestId: string, allowed: boolean) => invoke(channels.finishClose, requestId, allowed),
  cancelCloseTasks: (requestId: string) => invoke(channels.cancelCloseTasks, requestId),
  onCloseRequested: (listener: (request: { requestId: string }) => void) => subscribeCloseRequest(channels.closeRequested, listener),
  onCloseCancelled: (listener: (request: { requestId: string }) => void) => subscribeCloseRequest(channels.closeCancelled, listener),
  onAppearanceChange: (listener: (appearance: { theme: 'light' | 'dark'; uiSkin?: 'dawn' | 'obsidian' | 'mist' | 'aurora'; reducedMotion?: boolean }) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const value = payload as Record<string, unknown>
      if (value.theme !== 'light' && value.theme !== 'dark') return
      const uiSkin = value.uiSkin === 'dawn' || value.uiSkin === 'obsidian' || value.uiSkin === 'mist' || value.uiSkin === 'aurora' ? value.uiSkin : undefined
      listener({ theme: value.theme, ...(uiSkin ? { uiSkin } : {}), reducedMotion: value.reducedMotion === true })
    }
    ipcRenderer.on(channels.appearanceChanged, wrapped)
    return () => ipcRenderer.removeListener(channels.appearanceChanged, wrapped)
  },
  onRunEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(channels.runEvent, wrapped)
    return () => ipcRenderer.removeListener(channels.runEvent, wrapped)
  },
  onThemeChange: (listener: (theme: 'light' | 'dark') => void) => {
    const wrapped = (_event: unknown, payload: unknown) => {
      if (payload === 'light' || payload === 'dark') listener(payload)
    }
    ipcRenderer.on(channels.themeChanged, wrapped)
    return () => ipcRenderer.removeListener(channels.themeChanged, wrapped)
  },
})

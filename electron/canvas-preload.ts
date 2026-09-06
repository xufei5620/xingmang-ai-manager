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
  renameAsset: 'canvas-host:rename-asset',
  updateAssetMetadata: 'canvas-host:update-asset-metadata',
  markAssetUsed: 'canvas-host:mark-asset-used',
  deleteAsset: 'canvas-host:delete-asset',
  restoreAsset: 'canvas-host:restore-asset',
  purgeAsset: 'canvas-host:purge-asset',
  inspectAssetReferences: 'canvas-host:inspect-asset-references',
  pickAsset: 'canvas-host:pick-asset',
  importAssetFile: 'canvas-host:import-asset-file',
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
  runEvent: 'canvas-host:run-event',
  themeChanged: 'canvas-host:theme-changed',
  appearanceChanged: 'canvas-host:appearance-changed',
  closeRequested: 'canvas-host:close-requested',
  closeCancelled: 'canvas-host:close-cancelled',
  finishClose: 'canvas-host:finish-close',
  cancelCloseTasks: 'canvas-host:cancel-close-tasks',
} as const

function subscribeCloseRequest(channel: string, listener: (request: { requestId: string }) => void) {
  const wrapped = (_event: unknown, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const requestId = (payload as { requestId?: unknown }).requestId
    if (typeof requestId === 'string' && /^[a-f0-9-]{36}$/i.test(requestId)) listener({ requestId })
  }
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('xingmangCanvasHost', {
  saveFile: (suggestedName: string, content: string) => (
    ipcRenderer.invoke(channels.saveFile, suggestedName, content)
  ),
  pickFile: () => ipcRenderer.invoke(channels.pickFile),
  notify: (title: string, body?: string) => ipcRenderer.invoke(channels.notify, title, body),
  openExternal: (url: string) => ipcRenderer.invoke(channels.openExternal, url),
  listGroups: () => ipcRenderer.invoke(channels.listGroups),
  prepareGroup: (group: string) => ipcRenderer.invoke(channels.prepareGroup, group),
  generateImage: (input: unknown) => ipcRenderer.invoke(channels.generateImage, input),
  editImage: (input: unknown) => ipcRenderer.invoke(channels.editImage, input),
  generateVideo: (input: unknown) => ipcRenderer.invoke(channels.generateVideo, input),
  resumeVideoTask: (taskId: string) => ipcRenderer.invoke(channels.resumeVideoTask, taskId),
  cancelRequest: (requestId: string) => ipcRenderer.invoke(channels.cancelRequest, requestId),
  copyAsset: (assetId: string) => ipcRenderer.invoke(channels.copyAsset, assetId),
  saveAsset: (assetId: string) => ipcRenderer.invoke(channels.saveAsset, assetId),
  showAssetMenu: (assetId: string) => ipcRenderer.invoke(channels.showAssetMenu, assetId),
  listAssets: (query?: unknown) => ipcRenderer.invoke(channels.listAssets, query),
  renameAsset: (input: unknown) => ipcRenderer.invoke(channels.renameAsset, input),
  updateAssetMetadata: (input: unknown) => ipcRenderer.invoke(channels.updateAssetMetadata, input),
  markAssetUsed: (assetId: string) => ipcRenderer.invoke(channels.markAssetUsed, assetId),
  deleteAsset: (assetId: string) => ipcRenderer.invoke(channels.deleteAsset, assetId),
  restoreAsset: (assetId: string) => ipcRenderer.invoke(channels.restoreAsset, assetId),
  purgeAsset: (assetId: string, currentProjectContent: string) => ipcRenderer.invoke(channels.purgeAsset, assetId, currentProjectContent),
  inspectAssetReferences: (assetId: string, currentProjectContent: string) => ipcRenderer.invoke(channels.inspectAssetReferences, assetId, currentProjectContent),
  pickAsset: () => ipcRenderer.invoke(channels.pickAsset),
  importAssetFile: (file: File) => {
    const filePath = webUtils.getPathForFile(file)
    if (!filePath) return Promise.reject(new Error('无法读取拖入的本地文件'))
    return ipcRenderer.invoke(channels.importAssetFile, filePath)
  },
  listPromptPresets: () => ipcRenderer.invoke(channels.listPromptPresets),
  createPromptPreset: (input: unknown) => ipcRenderer.invoke(channels.createPromptPreset, input),
  updatePromptPreset: (input: unknown) => ipcRenderer.invoke(channels.updatePromptPreset, input),
  deletePromptPreset: (id: string) => ipcRenderer.invoke(channels.deletePromptPreset, id),
  startRun: (input: unknown) => ipcRenderer.invoke(channels.startRun, input),
  cancelRun: (runId: string) => ipcRenderer.invoke(channels.cancelRun, runId),
  listRuns: () => ipcRenderer.invoke(channels.listRuns),
  exportProject: (suggestedName: string, content: string) => ipcRenderer.invoke(channels.exportProject, suggestedName, content),
  previewProject: () => ipcRenderer.invoke(channels.previewProject),
  importProject: (previewId: string) => ipcRenderer.invoke(channels.importProject, previewId),
  listProjects: () => ipcRenderer.invoke(channels.listProjects),
  createProject: (name: string) => ipcRenderer.invoke(channels.createProject, name),
  openProject: (projectId: string) => ipcRenderer.invoke(channels.openProject, projectId),
  saveProject: (projectId: string, content: string) => ipcRenderer.invoke(channels.saveProject, projectId, content),
  renameProject: (projectId: string, name: string) => ipcRenderer.invoke(channels.renameProject, projectId, name),
  duplicateProject: (projectId: string, name: string) => ipcRenderer.invoke(channels.duplicateProject, projectId, name),
  setProjectArchived: (projectId: string, archived: boolean) => ipcRenderer.invoke(channels.setProjectArchived, projectId, archived),
  finishClose: (requestId: string, allowed: boolean) => ipcRenderer.invoke(channels.finishClose, requestId, allowed),
  cancelCloseTasks: (requestId: string) => ipcRenderer.invoke(channels.cancelCloseTasks, requestId),
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

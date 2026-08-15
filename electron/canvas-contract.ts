import type { GeneratedAiAsset } from './ai-image-service'
import type { GeneratedAiVideoAsset } from './ai-video-service'
import type { CanvasPromptPreset } from './canvas-prompt-preset-store'
import type { CanvasRunEvent, CanvasRunGraph, CanvasRunRecord, CanvasRunScope } from './canvas-run-contract'

export const canvasHostChannels = {
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
  runEvent: 'canvas-host:run-event',
} as const

export interface CanvasGroupSummary {
  name: string
  description: string
  ratio: number | string
}

export interface CanvasPreparedGroup {
  group: string
  models: string[]
  keyCreated: boolean
  storageWarning?: string
}

export interface CanvasImageGenerateInput {
  requestId: string
  group: string
  model: string
  prompt: string
  size?: string
  quality?: 'low' | 'medium' | 'high' | 'auto'
}

export interface CanvasImageEditInput extends CanvasImageGenerateInput {
  sourceAssetIds: string[]
}

export type CanvasGeneratedAsset = GeneratedAiAsset
export type CanvasGeneratedVideoAsset = GeneratedAiVideoAsset

export interface CanvasCancelResult {
  canceled: boolean
  mayStillComplete: boolean
}

export interface CanvasAssetSummary extends CanvasGeneratedAsset {
  createdAt: string
  mediaType: 'image'
  thumbnailUrl: string
  displayName: string
}

export interface CanvasVideoAssetSummary extends CanvasGeneratedVideoAsset {
  createdAt: string
  mediaType: 'video'
  thumbnailUrl: string
  displayName: string
  width?: number
  height?: number
  durationSeconds?: number
}

export interface CanvasAudioAssetSummary {
  assetId: string
  localUrl: string
  mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'audio/mp4'
  fileName: string
  createdAt: string
  mediaType: 'audio'
  thumbnailUrl: string
  displayName: string
  durationSeconds?: number
}

export interface CanvasRenameAssetInput {
  assetId: string
  displayName: string
}

export interface CanvasRenameAssetResult {
  assetId: string
  displayName: string
}

export interface CanvasAssetQuery {
  offset?: number
  limit?: number
  mediaType?: 'all' | 'image' | 'video' | 'audio'
  search?: string
}

export interface CanvasAssetPage {
  items: Array<CanvasAssetSummary | CanvasVideoAssetSummary | CanvasAudioAssetSummary>
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export type CanvasPromptPresetDto = CanvasPromptPreset

export interface CanvasStartRunInput {
  graph: CanvasRunGraph
  scope: CanvasRunScope
}

export type CanvasRunEventDto = CanvasRunEvent
export type CanvasRunRecordDto = CanvasRunRecord

export interface CanvasProjectPreview {
  previewId: string
  name: string
  workflowName: string
  nodeCount: number
  edgeCount: number
  assetCount: number
  warnings: string[]
}

export interface CanvasProjectImportResult {
  content: string
  warnings: string[]
  importedAssetCount: number
}

export interface CanvasStoredProjectSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  nodeCount: number
  workspaceName?: string
  workspaceConfigured: boolean
}

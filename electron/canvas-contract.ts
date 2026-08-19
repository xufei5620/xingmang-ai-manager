import type { GeneratedAiAsset } from './ai-image-service'
import type { GeneratedAiVideoAsset } from './ai-video-service'
import type { CanvasPromptPreset } from './canvas-prompt-preset-store'
import type { CanvasRunAssetLineage, CanvasRunEvent, CanvasRunGraph, CanvasRunRecord, CanvasRunScope } from './canvas-run-contract'

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
  updateAssetMetadata: 'canvas-host:update-asset-metadata',
  markAssetUsed: 'canvas-host:mark-asset-used',
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
  imageResolution?: '1K' | '2K' | '4K'
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

export type CanvasAssetSource = 'generated' | 'imported' | 'legacy'

export interface CanvasAssetOrganization {
  favorite: boolean
  tags: string[]
  source: CanvasAssetSource
  lastUsedAt?: string
}

export interface CanvasAssetSummary extends CanvasGeneratedAsset, CanvasAssetOrganization {
  createdAt: string
  mediaType: 'image'
  thumbnailUrl: string
  displayName: string
  lineage?: CanvasRunAssetLineage
}

export interface CanvasVideoAssetSummary extends CanvasGeneratedVideoAsset, CanvasAssetOrganization {
  createdAt: string
  mediaType: 'video'
  thumbnailUrl: string
  displayName: string
  width?: number
  height?: number
  durationSeconds?: number
  lineage?: CanvasRunAssetLineage
}

export interface CanvasAudioAssetSummary extends CanvasAssetOrganization {
  assetId: string
  localUrl: string
  mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'audio/mp4'
  fileName: string
  createdAt: string
  mediaType: 'audio'
  thumbnailUrl: string
  displayName: string
  durationSeconds?: number
  lineage?: CanvasRunAssetLineage
}

export interface CanvasRenameAssetInput {
  assetId: string
  displayName: string
}

export interface CanvasRenameAssetResult {
  assetId: string
  displayName: string
}

export interface CanvasUpdateAssetMetadataInput {
  assetId: string
  favorite?: boolean
  tags?: string[]
}

export interface CanvasUpdateAssetMetadataResult {
  assetId: string
  favorite: boolean
  tags: string[]
  lastUsedAt?: string
}

export interface CanvasMarkAssetUsedResult {
  assetId: string
  lastUsedAt: string
}

export interface CanvasAssetReferenceReport {
  assetId: string
  inUse: boolean
  currentProject: {
    projectId: string
    projectName: string
    nodeIds: string[]
  }
  projects: Array<{
    projectId: string
    projectName: string
    nodeIds: string[]
    archived: boolean
  }>
  runs: Array<{
    runId: string
    projectId?: string
    createdAt: string
    status: string
    nodeIds: string[]
    inputReferenceCount: number
    candidateReferenceCount: number
  }>
}

export interface CanvasAssetQuery {
  offset?: number
  limit?: number
  mediaType?: 'all' | 'image' | 'video' | 'audio'
  search?: string
  view?: 'all' | 'favorites' | 'recent'
  tag?: string
  source?: 'all' | CanvasAssetSource
  sort?: 'created-desc' | 'created-asc' | 'used-desc' | 'name-asc'
}

export interface CanvasAssetPage {
  items: Array<CanvasAssetSummary | CanvasVideoAssetSummary | CanvasAudioAssetSummary>
  offset: number
  limit: number
  total: number
  hasMore: boolean
  facets: CanvasAssetFacets
}

export interface CanvasAssetFacets {
  tags: Array<{ tag: string; count: number }>
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
  lastOpenedAt: string
  nodeCount: number
  assetCount: number
  workspaceName?: string
  workspaceConfigured: boolean
  workspaceStatus: 'ready' | 'missing' | 'legacy'
  previewAsset?: {
    kind: 'image' | 'video' | 'audio'
    assetId: string
    localUrl: string
  }
  archivedAt?: string
}

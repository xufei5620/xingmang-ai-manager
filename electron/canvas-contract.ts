import type { GeneratedAiAsset } from './ai-image-service'
import type { GeneratedAiVideoAsset } from './ai-video-service'
import type { CanvasPromptPreset } from './canvas-prompt-preset-store'
import type { CanvasRunAssetLineage, CanvasRunEvent, CanvasRunGraph, CanvasRunRecord, CanvasRunScope } from './canvas-run-contract'

export const canvasHostChannels = {
  saveFile: 'canvas-host:save-file',
  pickFile: 'canvas-host:pick-file',
  notify: 'canvas-host:notify',
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
  createProjectInDefaultFolder: 'canvas-host:create-project-in-default-folder',
  relinkProjectFolder: 'canvas-host:relink-project-folder',
  deleteProject: 'canvas-host:delete-project',
  getAccountSummary: 'canvas-host:get-account-summary',
  runEvent: 'canvas-host:run-event',
  accountChanged: 'canvas-host:account-changed',
  themeChanged: 'canvas-host:theme-changed',
  appearanceChanged: 'canvas-host:appearance-changed',
  closeRequested: 'canvas-host:close-requested',
  closeCancelled: 'canvas-host:close-cancelled',
  finishClose: 'canvas-host:finish-close',
  cancelCloseTasks: 'canvas-host:cancel-close-tasks',
} as const

export const maximumCanvasPromptPresetNameLength = 160

/**
 * What this desktop host can run, read by the xingmang-canvas kernel through
 * `xingmangCanvasHost.capabilities()` (#1392). It is a fixed literal: no
 * account data, no IPC round trip, the same answer on every call, so a
 * poisoned canvas learns nothing from it it could not read in this file.
 * canvas-preload.ts carries a copy (I7); canvas-preload.test.ts pins the two
 * together, and canvas-contract.test.ts pins this one to the executor table
 * and the image model table it describes.
 *
 * A switch only says the kernel may show an entry. The main process still
 * refuses, before any paid request, every parameter it cannot honour.
 */
export interface CanvasHostCapabilities {
  contractVersion: number
  host: 'desktop'
  executableNodeKinds: readonly string[]
  features: {
    quote: boolean
    accountSummary: boolean
    imageEditMask: boolean
    textGenerate: boolean
    textWebSearch: boolean
    imageTools: boolean
    frameExtract: boolean
    scenarioTemplates: boolean
    routerStrategy: boolean
    generateAudio: boolean
    referenceOrder: boolean
    cloud: boolean
    agentExecution: boolean
    byteUpload: boolean
    promptPresetGroups: boolean
  }
  imageCandidates: { maximum: number }
  videoCandidates: { maximum: number }
  promptPresetNameMaxLength: number
  imageResolutions: {
    byModel: Readonly<Record<string, readonly ('1K' | '2K' | '4K')[]>>
    /** Any other gpt-image-* model the account lists, except gpt-image-1.5. */
    otherGptImage: readonly ('1K' | '2K' | '4K')[]
  }
  video: {
    /** The legacy account site has video switched off in the main process. */
    siteIds: readonly ('solov' | 'solov-api')[]
    protocols: readonly string[]
    seconds: { minimum: number; maximum: number }
    dimensions: readonly string[]
    miniMaxResolutions: readonly string[]
    miniMaxAspectRatios: readonly string[]
  }
}

export const desktopCanvasCapabilities: CanvasHostCapabilities = {
  contractVersion: 1,
  host: 'desktop',
  executableNodeKinds: [
    'text', 'prompt', 'note', 'image', 'image-generate', 'image-edit', 'video', 'video-generate',
    'image-input', 'video-input', 'audio-input', 'router', 'gallery', 'output', 'group',
    'drama-bible', 'drama-script', 'drama-parse', 'drama-shot', 'drama-character', 'drama-scene', 'drama-prop',
  ],
  features: {
    quote: false,
    accountSummary: true,
    imageEditMask: false,
    textGenerate: false,
    textWebSearch: false,
    imageTools: false,
    frameExtract: false,
    scenarioTemplates: false,
    routerStrategy: false,
    generateAudio: false,
    referenceOrder: false,
    cloud: false,
    agentExecution: false,
    byteUpload: false,
    promptPresetGroups: false,
  },
  imageCandidates: { maximum: 4 },
  videoCandidates: { maximum: 1 },
  promptPresetNameMaxLength: maximumCanvasPromptPresetNameLength,
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
}

export interface CanvasAppearance {
  theme: 'light' | 'dark'
  uiSkin?: 'dawn' | 'obsidian' | 'mist' | 'aurora'
  reducedMotion?: boolean
}

/**
 * Emitted when the main application session changes while the canvas window
 * is still open. The renderer uses this as a lifecycle boundary and drops all
 * account-owned in-memory state before accepting data for the new session.
 */
export interface CanvasAccountChange {
  siteId?: 'solov' | 'solov-api'
  userId: number | null
  previousUserId: number | null
}

export interface CanvasCloseRequest { requestId: string }

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
  /** Present only in the recycle bin view; absent means the asset is live. */
  deletedAt?: string
  /** The prompt that generated the asset, recorded once when it was created. */
  prompt?: string
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

export interface CanvasDeleteAssetResult {
  assetId: string
  deletedAt: string
}

export interface CanvasRestoreAssetResult {
  assetId: string
}

export interface CanvasPurgeAssetResult {
  assetId: string
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
  view?: 'all' | 'favorites' | 'recent' | 'trash'
  tag?: string
  source?: 'all' | CanvasAssetSource
  sort?: 'created-desc' | 'created-asc' | 'used-desc' | 'name-asc'
  /**
   * "Find similar" filters. `prompt` matches exactly; `runId` and `nodeId` are
   * resolved against the run store into an identifier set before the library
   * filters on them, so the total keeps describing the whole matching set.
   */
  prompt?: string
  runId?: string
  nodeId?: string
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
  /** Set when the import becomes a new project in the default folder instead of replacing the open one. */
  createsProject?: true
}

export interface CanvasProjectImportResult {
  content: string
  warnings: string[]
  importedAssetCount: number
  /** The new project the import created, which the canvas opens next. */
  projectId?: string
}

export interface CanvasProjectDeleteResult {
  projectId: string
  /** The project's own folder directly under the default projects folder went to the system trash; any other folder is left alone. */
  folderMovedToTrash: boolean
}

/**
 * The balance chip's answer (画布完善第 2b 条). Four things and nothing else:
 * which kind of account, its name half-hidden, the balance, when it was read.
 * Never the email, the user id or any key (I15).
 */
export interface CanvasAccountSummary {
  /** 星芒账号 or 历史账号. */
  siteLabel: string
  /** maskCanvasAccountLabel's output; null when the account has no name. */
  accountLabel: string | null
  /** US dollars, quota / quotaPerUnit as in the main window; null while not read. */
  balanceUsd: number | null
  /** 「订阅剩余 USD 12.30 · 10月3日到期」 when a subscription is usable, else null. */
  subscriptionLabel: string | null
  /** When the balance was read (ISO); null while not read. */
  readAt: string | null
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

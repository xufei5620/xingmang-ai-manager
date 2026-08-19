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

export interface CanvasGeneratedAsset {
  assetId: string
  localUrl: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width?: number
  height?: number
  fileName: string
  revisedPrompt?: string
}

export interface CanvasGeneratedVideoAsset {
  assetId: string
  localUrl: string
  mimeType: 'video/mp4'
  fileName: string
  taskId: string
  width?: number
  height?: number
  durationSeconds?: number
}

export interface CanvasAssetLineage {
  origin: 'generated'
  runId: string
  graphRevision: string
  nodeId: string
  attemptId: string
  candidateId: string
  projectId?: string
  sourceAssetIds: string[]
}

export type CanvasAssetSource = 'generated' | 'imported' | 'legacy'

export interface CanvasAssetOrganization {
  favorite?: boolean
  tags?: string[]
  source?: CanvasAssetSource
  lastUsedAt?: string
  deletedAt?: string
}

export interface CanvasImageAssetSummary extends CanvasGeneratedAsset, CanvasAssetOrganization {
  createdAt: string
  mediaType: 'image'
  thumbnailUrl: string
  displayName?: string
  lineage?: CanvasAssetLineage
}

export interface CanvasVideoAssetSummary extends CanvasGeneratedVideoAsset, CanvasAssetOrganization {
  createdAt: string
  mediaType: 'video'
  thumbnailUrl: string
  displayName?: string
  width?: number
  height?: number
  durationSeconds?: number
  lineage?: CanvasAssetLineage
}

export interface CanvasAudioAssetSummary extends CanvasAssetOrganization {
  assetId: string
  localUrl: string
  mimeType: 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'audio/mp4'
  fileName: string
  createdAt: string
  mediaType: 'audio'
  thumbnailUrl: string
  displayName?: string
  durationSeconds?: number
  lineage?: CanvasAssetLineage
}

export type CanvasAssetSummary = CanvasImageAssetSummary | CanvasVideoAssetSummary | CanvasAudioAssetSummary
export type CanvasListedAssetSummary = CanvasAssetSummary & { displayName: string }

export interface CanvasAssetQuery {
  offset?: number
  limit?: number
  mediaType?: 'all' | 'image' | 'video' | 'audio'
  search?: string
  view?: 'all' | 'favorites' | 'recent' | 'trash'
  tag?: string
  source?: 'all' | CanvasAssetSource
  sort?: 'created-desc' | 'created-asc' | 'used-desc' | 'name-asc'
}

export interface CanvasAssetPage {
  items: CanvasListedAssetSummary[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
  /** Counted over the whole library, so the panel does not change while paging. */
  facets: CanvasAssetFacets
}

export interface CanvasAssetFacets {
  tags: Array<{ tag: string; count: number }>
}

export function emptyCanvasAssetPage(offset = 0, limit = 24): CanvasAssetPage {
  return { items: [], offset, limit, total: 0, hasMore: false, facets: { tags: [] } }
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

export interface CanvasPromptPreset {
  id: string
  name: string
  prompt: string
  tags: string[]
  createdAt: string
  updatedAt: string
  provenance: 'user-created'
}

export interface CanvasRunGraph {
  nodes: Array<{
    id: string
    kind: string
    definitionVersion: number
    disabled?: boolean
    data: {
      prompt: string
      model: string
      group?: string
      quality?: string
      size?: string
      imageResolution?: '1K' | '2K' | '4K'
      seconds?: string
      adoptedAssetId?: string
      videoMode?: 'auto' | 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va'
      videoResolution?: '480p' | '720p'
      videoAspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | '4:5' | '5:4'
      promptOptimization?: boolean
    }
  }>
  edges: Array<{ id: string; source: string; sourceHandle: string; target: string; targetHandle: string }>
}

export const canvasRunTimelineLimit = 4_096

export type CanvasRunNodeStage =
  | 'validating'
  | 'resolving-cache'
  | 'waiting-slot'
  | 'submitting'
  | 'processing'
  | 'downloading'
  | 'saving'

interface CanvasRunEventBase {
  version: 1
  runId: string
  graphRevision: string
  sequence: number
  at: string
}

export type CanvasRunEvent = CanvasRunEventBase & (
  | {
    type: 'node-state'
    nodeId: string
    state: CanvasRunNodeState
    attemptId?: string
    fingerprint?: string
    candidateIds?: string[]
    errorMessage?: string
    costQuota?: number
  }
  | {
    type: 'node-stage'
    nodeId: string
    stage: CanvasRunNodeStage
    attemptId?: string
    progress?: number
    progressMode?: 'determinate' | 'indeterminate'
    health?: 'normal' | 'delayed'
  }
  | {
    type: 'run-terminal'
    status: Exclude<CanvasRunStatus, 'running'>
    outcome: {
      succeeded: string[]
      failed: string[]
      skipped: string[]
      cancelled: string[]
      cached: string[]
    }
  }
)

export type CanvasRunNodeState =
  | 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed'
  | 'skipped' | 'cancelled' | 'cached' | 'interrupted'
export type CanvasRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'interrupted'

export type CanvasRunScope =
  | { kind: 'all' }
  | { kind: 'to-node'; nodeId: string }
  | { kind: 'from-node'; nodeId: string }
  | { kind: 'selection'; nodeIds: string[] }
  | { kind: 'dirty'; nodeIds: string[] }

export interface CanvasRunCandidate {
  candidateId: string
  attemptId: string
  createdAt: string
  asset: { kind: 'image' | 'video' | 'audio'; assetId: string; localUrl: string; mimeType?: string; width?: number; height?: number }
  group?: string
  model?: string
  costQuota?: number
}

export interface CanvasRunRecord {
  version: 1
  userId: number
  ownerId: number
  runId: string
  graphRevision: string
  scope: CanvasRunScope
  status: CanvasRunStatus
  createdAt: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  outcome?: {
    succeeded: string[]
    failed: string[]
    skipped: string[]
    cancelled: string[]
    cached: string[]
  }
  nodes: Array<{
    nodeId: string
    kind: string
    state: CanvasRunNodeState
    latestStage?: CanvasRunNodeStage
    latestStageAt?: string
    latestStageSequence?: number
    latestProgress?: number
    latestProgressMode?: 'determinate' | 'indeterminate'
    latestHealth?: 'normal' | 'delayed'
    errorMessage?: string
    attempts: Array<{
      attemptId: string
      fingerprint: string
      state: CanvasRunNodeState
      startedAt: string
      completedAt: string
      durationMs: number
      cached: boolean
      inputAssetIds?: string[]
      candidates: CanvasRunCandidate[]
      outputText?: string
      errorMessage?: string
      costQuota?: number
      group?: string
      model?: string
    }>
  }>
  events: CanvasRunEvent[]
}

export interface CanvasProjectPreview {
  previewId: string
  name: string
  workflowName: string
  nodeCount: number
  edgeCount: number
  assetCount: number
  warnings: string[]
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

export interface CanvasHostBridge {
  saveFile(suggestedName: string, content: string): Promise<{ savedPath: string } | null>
  pickFile(): Promise<{ name: string; content: string } | null>
  notify(title: string, body?: string): Promise<boolean>
  openExternal(url: string): Promise<void>
  listGroups(): Promise<CanvasGroupSummary[]>
  prepareGroup(group: string): Promise<CanvasPreparedGroup>
  generateImage(input: {
    requestId: string
    group: string
    model: string
    prompt: string
    size?: string
    quality?: 'low' | 'medium' | 'high' | 'auto'
    imageResolution?: '1K' | '2K' | '4K'
  }): Promise<CanvasGeneratedAsset[]>
  editImage(input: {
    requestId: string
    group: string
    model: string
    prompt: string
    sourceAssetIds: string[]
    size?: string
    quality?: 'low' | 'medium' | 'high' | 'auto'
    imageResolution?: '1K' | '2K' | '4K'
  }): Promise<CanvasGeneratedAsset[]>
  generateVideo(input: {
    requestId: string
    group: string
    model: string
    prompt: string
    seconds: string
    imageAssetId?: string
    imageAssetIds?: string[]
    videoAssetIds?: string[]
    audioAssetIds?: string[]
    width?: number
    height?: number
    mode?: 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va'
    resolution?: '480p' | '720p'
    aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | '4:5' | '5:4'
    promptOptimization?: boolean
  }): Promise<CanvasGeneratedVideoAsset>
  resumeVideoTask(taskId: string): Promise<CanvasGeneratedVideoAsset>
  cancelRequest(requestId: string): Promise<{ canceled: boolean; mayStillComplete: boolean }>
  copyAsset(assetId: string): Promise<void>
  saveAsset(assetId: string): Promise<{ saved: boolean }>
  showAssetMenu(assetId: string): Promise<void>
  listAssets(query?: CanvasAssetQuery): Promise<CanvasAssetPage>
  renameAsset(input: { assetId: string; displayName: string }): Promise<{ assetId: string; displayName: string }>
  updateAssetMetadata(input: { assetId: string; favorite?: boolean; tags?: string[] }): Promise<{ assetId: string; favorite: boolean; tags: string[]; lastUsedAt?: string }>
  markAssetUsed(assetId: string): Promise<{ assetId: string; lastUsedAt: string }>
  deleteAsset(assetId: string): Promise<{ assetId: string; deletedAt: string }>
  restoreAsset(assetId: string): Promise<{ assetId: string }>
  purgeAsset(assetId: string, currentProjectContent: string): Promise<{ assetId: string }>
  inspectAssetReferences(assetId: string, currentProjectContent: string): Promise<CanvasAssetReferenceReport>
  pickAsset(): Promise<CanvasGeneratedAsset | CanvasAssetSummary | null>
  importAssetFile(file: File): Promise<CanvasGeneratedAsset | CanvasAssetSummary>
  listPromptPresets(): Promise<CanvasPromptPreset[]>
  createPromptPreset(input: { name: string; prompt: string; tags?: string[] }): Promise<CanvasPromptPreset>
  updatePromptPreset(input: { id: string; name?: string; prompt?: string; tags?: string[] }): Promise<CanvasPromptPreset>
  deletePromptPreset(id: string): Promise<boolean>
  startRun(input: { graph: CanvasRunGraph; scope: CanvasRunScope }): Promise<{ runId: string; graphRevision: string }>
  cancelRun(runId: string): Promise<boolean>
  listRuns(): Promise<CanvasRunRecord[]>
  exportProject(suggestedName: string, content: string): Promise<{ savedPath: string } | null>
  previewProject(): Promise<CanvasProjectPreview | null>
  importProject(previewId: string): Promise<{ content: string; warnings: string[]; importedAssetCount: number }>
  listProjects(): Promise<CanvasStoredProjectSummary[]>
  createProject(name: string): Promise<{ project: CanvasStoredProjectSummary; content: string } | null>
  openProject(projectId: string): Promise<{ project: CanvasStoredProjectSummary; content: string }>
  saveProject(projectId: string, content: string): Promise<CanvasStoredProjectSummary>
  renameProject(projectId: string, name: string): Promise<CanvasStoredProjectSummary>
  duplicateProject(projectId: string, name: string): Promise<{ project: CanvasStoredProjectSummary; content: string } | null>
  setProjectArchived(projectId: string, archived: boolean): Promise<CanvasStoredProjectSummary>
  onRunEvent(listener: (event: CanvasRunEvent) => void): () => void
  onThemeChange(listener: (theme: 'light' | 'dark') => void): () => void
}

declare global {
  interface Window {
    xingmangCanvasHost?: CanvasHostBridge
  }
}

function unavailable(): never {
  throw new Error('浏览器演示模式不连接生产服务，请在桌面应用中登录后使用')
}

export function hostBridge(): CanvasHostBridge {
  if (window.xingmangCanvasHost) return window.xingmangCanvasHost
  return {
    async saveFile(suggestedName, content) {
      const blob = new Blob([content], { type: 'application/json' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = suggestedName
      link.click()
      URL.revokeObjectURL(link.href)
      return { savedPath: suggestedName }
    },
    async pickFile() {
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'application/json'
        input.onchange = async () => {
          const file = input.files?.[0]
          resolve(file ? { name: file.name, content: await file.text() } : null)
        }
        input.click()
      })
    },
    async notify(title, body) {
      console.info(`[画布通知] ${title}${body ? `:${body}` : ''}`)
      return false
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener')
    },
    async listGroups() { return [] },
    async prepareGroup() { return unavailable() },
    async generateImage() { return unavailable() },
    async editImage() { return unavailable() },
    async generateVideo() { return unavailable() },
    async resumeVideoTask() { return unavailable() },
    async cancelRequest() { return { canceled: false, mayStillComplete: false } },
    async copyAsset() { return unavailable() },
    async saveAsset() { return unavailable() },
    async showAssetMenu() { return unavailable() },
    async listAssets(query = {}) {
      return emptyCanvasAssetPage(query.offset ?? 0, query.limit ?? 24)
    },
    async renameAsset() { return unavailable() },
    async updateAssetMetadata() { return unavailable() },
    async markAssetUsed() { return unavailable() },
    async deleteAsset() { return unavailable() },
    async restoreAsset() { return unavailable() },
    async purgeAsset() { return unavailable() },
    async inspectAssetReferences() { return unavailable() },
    async pickAsset() { return unavailable() },
    async importAssetFile() { return unavailable() },
    async listPromptPresets() { return [] },
    async createPromptPreset() { return unavailable() },
    async updatePromptPreset() { return unavailable() },
    async deletePromptPreset() { return unavailable() },
    async startRun() { return unavailable() },
    async cancelRun() { return false },
    async listRuns() { return [] },
    async exportProject(suggestedName, content) { return this.saveFile(suggestedName, content) },
    async previewProject() { return null },
    async importProject() { return unavailable() },
    async listProjects() { return [] },
    async createProject() { return unavailable() },
    async openProject() { return unavailable() },
    async saveProject() { return unavailable() },
    async renameProject() { return unavailable() },
    async duplicateProject() { return unavailable() },
    async setProjectArchived() { return unavailable() },
    onRunEvent() { return () => undefined },
    onThemeChange() { return () => undefined },
  }
}

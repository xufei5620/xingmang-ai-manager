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

export interface CanvasImageAssetSummary extends CanvasGeneratedAsset {
  createdAt: string
  mediaType: 'image'
  thumbnailUrl: string
  displayName?: string
}

export interface CanvasVideoAssetSummary extends CanvasGeneratedVideoAsset {
  createdAt: string
  mediaType: 'video'
  thumbnailUrl: string
  displayName?: string
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
  displayName?: string
  durationSeconds?: number
}

export type CanvasAssetSummary = CanvasImageAssetSummary | CanvasVideoAssetSummary | CanvasAudioAssetSummary
export type CanvasListedAssetSummary = CanvasAssetSummary & { displayName: string }

export interface CanvasAssetQuery {
  offset?: number
  limit?: number
  mediaType?: 'all' | 'image' | 'video' | 'audio'
  search?: string
}

export interface CanvasAssetPage {
  items: CanvasListedAssetSummary[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
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
    data: { prompt: string; model: string; group?: string; quality?: string; size?: string; seconds?: string; adoptedAssetId?: string }
  }>
  edges: Array<{ id: string; source: string; sourceHandle: string; target: string; targetHandle: string }>
}

export interface CanvasRunEvent {
  type: 'node-state' | 'run-terminal'
  runId: string
  graphRevision: string
  sequence: number
  nodeId?: string
  state?: string
  candidateIds?: string[]
  errorMessage?: string
  costQuota?: number
  status?: string
}

export type CanvasRunNodeState =
  | 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed'
  | 'skipped' | 'cancelled' | 'cached' | 'interrupted'
export type CanvasRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'interrupted'

export type CanvasRunScope =
  | { kind: 'all' }
  | { kind: 'to-node'; nodeId: string }
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
    errorMessage?: string
    attempts: Array<{
      attemptId: string
      fingerprint: string
      state: CanvasRunNodeState
      startedAt: string
      completedAt: string
      durationMs: number
      cached: boolean
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
  nodeCount: number
  workspaceName?: string
  workspaceConfigured: boolean
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
  }): Promise<CanvasGeneratedAsset[]>
  editImage(input: {
    requestId: string
    group: string
    model: string
    prompt: string
    sourceAssetIds: string[]
    size?: string
    quality?: 'low' | 'medium' | 'high' | 'auto'
  }): Promise<CanvasGeneratedAsset[]>
  generateVideo(input: {
    requestId: string
    group: string
    model: string
    prompt: string
    seconds: string
    imageAssetId?: string
    width?: number
    height?: number
  }): Promise<CanvasGeneratedVideoAsset>
  resumeVideoTask(taskId: string): Promise<CanvasGeneratedVideoAsset>
  cancelRequest(requestId: string): Promise<{ canceled: boolean; mayStillComplete: boolean }>
  copyAsset(assetId: string): Promise<void>
  saveAsset(assetId: string): Promise<{ saved: boolean }>
  showAssetMenu(assetId: string): Promise<void>
  listAssets(query?: CanvasAssetQuery): Promise<CanvasAssetPage>
  renameAsset(input: { assetId: string; displayName: string }): Promise<{ assetId: string; displayName: string }>
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
  onRunEvent(listener: (event: CanvasRunEvent) => void): () => void
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
      return { items: [], offset: query.offset ?? 0, limit: query.limit ?? 24, total: 0, hasMore: false }
    },
    async renameAsset() { return unavailable() },
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
    onRunEvent() { return () => undefined },
  }
}

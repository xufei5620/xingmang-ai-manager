import type { WorkshopCreationRecovery } from './lib/workshop-creation-recovery'
import type { ProjectCollaborationClient } from './lib/project-collaboration-client-port'
import type { WorkshopCreationIdentity } from './lib/workshop-creation-identity'
import type { WorkshopCreationOperation } from './lib/workshop-creation-operation'
export type { WorkshopCreationIdentity } from './lib/workshop-creation-identity'
export type { WorkshopCreationOperation } from './lib/workshop-creation-operation'
import type { CanvasMcpMethod, CanvasMcpMethodMap } from './lib/canvas-mcp-contract'
import type { ProviderVideoProtocol } from './lib/provider-video-protocol'
import type { VideoRequestAspectRatio } from './lib/video-request-protocol'
import type { WorkshopImportRecovery } from './lib/workshop-import-recovery'
import type { WorkshopOperationRecoveryPort } from './lib/workshop-operation-recovery'
import type { WorkflowFile } from './model'
import type { WorkshopContentRecovery } from './lib/workshop-content-recovery'
import type { WorkshopContentUpdateInput, WorkshopContentUpdateReceipt, WorkshopContentOperation, WorkshopContentOperationIdentity } from './lib/workshop-content-contract'
export type { WorkshopContentUpdateInput, WorkshopContentUpdateReceipt, WorkshopContentOperation, WorkshopContentOperationIdentity } from './lib/workshop-content-contract'
import type { ProjectImportRecoveryPort } from './lib/project-import-recovery'
import type { ImageCollageInputOrder } from './image-tools/collage-input-order'
import type { ImageLayerRecipe, ImageTransformRecipe } from './image-tools/recipe'
import type { AssetColorLutSource } from './image-tools/layer-color-lut-selection'
import type { ColorLutTable } from './image-tools/layer-color-lut'
import type { ColorLutResourceDescriptor } from './lib/color-lut-resource-contract'
import type { BrowserImportedLayerPsd } from './library/browser-layer-psd-import'
import type { CanvasPromptPreset, PromptPresetInput, PromptPresetUpdateInput, PromptPresetOrderInput, PromptPresetOrderEntry } from './library/prompt-preset-contract'
import type { CanvasHostCapabilities } from './host-capabilities'
export type { CanvasPromptPreset } from './library/prompt-preset-contract'
import type { CanvasImagePreparation, ImageTransformProvenance } from './lib/image-transform-contract'
export type { CanvasImagePreparation } from './lib/image-transform-contract'
import type { ProjectExportPreview, ProjectExportProgress, ProjectExportResult } from './lib/project-export-contract'
import type { QuickProjectCreationReceipt } from './lib/quick-project-creation-receipt'
import type { CanvasProjectHistoryPage, CanvasProjectRevisionDetail, CanvasProjectRestoreInput, CanvasProjectRestoreResult, CanvasProjectRestoreInspection } from './lib/project-history-contract'
import type { CanvasWorkshopItem, CanvasWorkshopItemSummary, CanvasWorkshopPage, CanvasWorkshopQuery, CanvasWorkshopCreateInput, CanvasWorkshopUpdateInput } from './lib/workshop-contract'
export type { CanvasWorkshopKind, CanvasWorkshopItem, CanvasWorkshopItemSummary, CanvasWorkshopPage, CanvasWorkshopQuery, CanvasWorkshopCreateInput, CanvasWorkshopUpdateInput } from './lib/workshop-contract'
import type { CommunityWorkshopQuery, CommunityWorkshopPage, CommunityWorkshopDetail, CommunityPublicationSource, CommunityPublicationPreview, CommunityPublicationInput, CommunityWorkshopMutationInput, CommunityWorkshopReceipt, CommunityWorkshopOperation } from './lib/community-workshop-contract'
import type { WorkshopTransferMethod, WorkshopTransferMethodMap } from './lib/workshop-transfer-contract'
import type { CanvasAgentMethod, CanvasAgentMethodMap } from './lib/canvas-agent-contract'
import type { CanvasAgentExecution, CanvasAgentExecutionOrigin } from './lib/canvas-agent-execution-contract'
import type { CanvasRunSummaryPage, CanvasRunSummaryQuery } from './lib/run-summary-contract'
export type { CanvasRunSummary, CanvasRunSummaryPage, CanvasRunSummaryQuery } from './lib/run-summary-contract'
export type { CommunityWorkshopKind, CommunityWorkshopOrigin, CommunityWorkshopOwned, CommunityWorkshopSummary, CommunityWorkshopQuery, CommunityWorkshopPage, CommunityWorkshopDetail, CommunityPublicationSource, CommunityPublicationPreview, CommunityPublicationInput, CommunityWorkshopMutationInput, CommunityWorkshopReceipt, CommunityWorkshopOperation } from './lib/community-workshop-contract'

export type CanvasProjectCreationReceipt = QuickProjectCreationReceipt

export interface CanvasGroupSummary {
  name: string
  description: string
  ratio: number | string
  purposes?: ('image' | 'text' | 'video')[]
  videoProtocol?: ProviderVideoProtocol
  /** Source metadata revision. Web providers change it after edits or catalog checks. */
  revision?: number
  connectionStatus?: 'untested' | 'ready' | 'failed'
}

export interface CanvasPreparedGroup {
  group: string
  models: string[]
  purposes?: ('image' | 'text' | 'video')[]
  videoProtocol?: ProviderVideoProtocol
  revision?: number
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

export interface CanvasVideoTaskTarget {
  taskId: string
  runId: string
  nodeId: string
  attemptId: string
}

/** Current owner-scoped job metadata. No upstream task ID or signed URL. */
export interface CanvasVideoTaskSummary {
  id: string
  runId: string
  nodeId: string
  attemptId: string
  version: number
  state: 'submitting' | 'unknown' | 'pending' | 'ready' | 'saved' | 'failed'
  progress?: number
  nextCheckAt?: string
  asset?: CanvasVideoAssetSummary
  assetStatus?: 'active' | 'trash' | 'missing'
  error?: string
  mayStillComplete: boolean
  createdAt: string
  updatedAt: string
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
export type { OfficialAssetItem, OfficialAssetCategory, OfficialAssetIdentity, OfficialAssetManifest, OfficialAssetQuery, OfficialAssetPage, OfficialAssetAcquisition, OfficialAssetProvenance } from './lib/official-asset-contract'

export interface CanvasAssetOrganization {
  /** Private owner-library grouping; never part of workflow or shared bytes. */
  categoryId?: string | null
  organizationVersion?: number
  metadataLevel?: 'summary' | 'complete'
  hasPrompt?: boolean
  hasRevisedPrompt?: boolean
  hasLineage?: boolean
  favorite?: boolean
  tags?: string[]
  source?: CanvasAssetSource
  officialSource?: import('./lib/official-asset-contract').OfficialAssetProvenance
  lastUsedAt?: string
  deletedAt?: string
  /** The prompt that generated the asset, recorded once when it was created. */
  prompt?: string
}

export interface CanvasImageAssetSummary extends CanvasGeneratedAsset, CanvasAssetOrganization {
  createdAt: string
  mediaType: 'image'
  thumbnailUrl: string
  displayName?: string
  lineage?: CanvasAssetLineage
  imageTransform?: ImageTransformProvenance
  frameDerivation?: {
    version: 1
    origin: 'browser-frame'
    operationId: string
    projectId: string
    nodeId: string
    sourceAssetId: string
    requestedTimestampSeconds: number
    decodedTimestampSeconds?: number
    decoderRevision: 'browser-frame-v1'
    requestDigest: string
  }
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
  categoryId?: string | null
  offset?: number
  limit?: number
  mediaType?: 'all' | 'image' | 'video' | 'audio'
  search?: string
  view?: 'all' | 'favorites' | 'recent' | 'trash'
  tag?: string
  source?: 'all' | CanvasAssetSource
  sort?: 'created-desc' | 'created-asc' | 'used-desc' | 'name-asc'
  /** "Find similar" filters: exact prompt, or everything from one run or one source node. */
  prompt?: string
  runId?: string
  nodeId?: string
}

export interface CanvasAssetPage {
  categoryFilter?: import('./lib/asset-category-contract').AssetCategoryFilter
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
  /** No project identity or counts from another owner's private scope. */
  sharedProjectUse?: boolean
  projectScanStatus?: 'complete' | 'partial'
  runScanStatus?: 'complete' | 'partial' | 'unavailable'
  runReferenceCount?: number
  runDetailsTruncated?: boolean
  pendingRunInputCount?: number
  unreadableRunInputCount?: number
  invalidRunRecordCount?: number
  projectReferenceCount?: number
  projectDetailsTruncated?: boolean
  invalidProjectCount?: number
  /** History is a separate scope; these are not references in the current graph. */
  versions?: import('./lib/project-history-contract').CanvasProjectVersionAssetReference[]
  versionReferenceCount?: number
  versionDetailsTruncated?: boolean
  invalidVersionCount?: number
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
    nodeReferenceCount?: number | null
    nodeDetailsTruncated?: boolean
  }>
  runs: Array<{
    runId: string
    projectId?: string
    createdAt: string
    status: string
    nodeIds: string[]
    inputReferenceCount: number
    candidateReferenceCount: number
    graphReferenceCount?: number
    nodeReferenceCount?: number
    nodeDetailsTruncated?: boolean
  }>
}

export interface CanvasRunGraph {
  nodes: Array<{
    id: string
    kind: string
    definitionVersion: number
    disabled?: boolean
    data: {
      prompt: string
      routerStrategy?: import('./runtime/router-strategy').CanvasRouterStrategy
      textWebSearch?: boolean
      model: string
      group?: string
      quality?: string
      size?: string
      imageResolution?: '1K' | '2K' | '4K'
      imageCandidateCount?: import('./runtime/image-candidate-count').ImageCandidateCount
      videoCandidateCount?: import('./runtime/video-candidate-count').VideoCandidateCount
      imageEditMask?: import('./image-tools/image-edit-mask').ImageEditMask
      interiorTask?: import('./interior/interior-task').InteriorTask
      exteriorTask?: import('./exterior/exterior-task').ExteriorTask
      storyboardTask?: import('./storyboard/storyboard-task').StoryboardTask
      commerceTask?: import('./commerce/commerce-task').CommerceTask
      imageReferenceOrder?: import('./commerce/image-reference-order').ImageReferenceOrder
      seconds?: string
      adoptedAssetId?: string
      videoMode?: 'auto' | 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va'
      videoResolution?: '480p' | '720p' | '1080p'
      videoAspectRatio?: VideoRequestAspectRatio
      promptOptimization?: boolean
      generateAudio?: boolean
      videoProtocol?: ProviderVideoProtocol
      imageTransform?: ImageTransformRecipe
      imageCollageInputOrder?: ImageCollageInputOrder
      tileInput?: import('./image-tools/tile-input').TileInputSelection
      videoReferenceOrder?: import('./video-tools/video-reference-order').VideoReferenceOrder
      imageOutputIndex?: number
      frameTimestampSeconds?: number
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
    type: 'run-waiting'
    waitingForVideo: boolean
    framePreparations: CanvasFramePreparation[]
    imagePreparations?: CanvasImagePreparation[]
    resumeAfter?: string
  }
  | {
    type: 'run-terminal'
    status: Exclude<CanvasRunStatus, 'running'>
    /** Missing input or historical records prevent a complete node-ID outcome. */
    outcomePartial?: boolean
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
  /** Stable batch order, independent of the currently selected candidate. */
  outputIndex?: number
  candidateId: string
  attemptId: string
  createdAt: string
  asset: { kind: 'image' | 'video' | 'audio'; assetId: string; localUrl: string; mimeType?: string; width?: number; height?: number; durationSeconds?: number; taskId?: string }
  group?: string
  model?: string
  costQuota?: number
}

export interface CanvasFramePreparation {
  operationId: string
  nodeId: string
  attemptId: string
  sourceAssetId: string
  timestampSeconds: number
}

export interface CanvasRunRecord {
  /** Set by the server from the owner/project-bound Agent turn record. */
  purpose?: 'agent-plan' | 'agent-execution'
  projectId?: string
  /** Older records and desktop hosts may omit server summary metadata. */
  totalNodes?: number | null
  nodeCounts?: Record<CanvasRunNodeState, number>
  /** A paid submission may still complete even after local waiting stopped. */
  mayStillComplete?: boolean
  cancelRequested?: boolean
  waitingForVideo?: boolean
  framePreparations?: CanvasFramePreparation[]
  imagePreparations?: CanvasImagePreparation[]
  resumeAfter?: string
  reconciledExpired?: boolean
  reconciliationPartial?: boolean
  outcomePartial?: boolean
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
      /** Each item is one independently submitted n=1 request, indexed from 1. */
      imageBatch?: { batchId: string; index: 1 | 2 | 3 | 4; count: 1 | 2 | 3 | 4 }
      /** One independently submitted durable video task per batch slot. */
      videoBatch?: import('./runtime/video-candidate-batch').VideoCandidateBatch
      fingerprint: string
      state: CanvasRunNodeState
      startedAt: string
      completedAt: string
      durationMs: number
      cached: boolean
      inputAssetIds?: string[]
      candidates: CanvasRunCandidate[]
      outputText?: string
      textWebSearch?: import('./runtime/text-web-search').TextWebSearchReceipt
      errorMessage?: string
      costQuota?: number
      group?: string
      model?: string
      /** Owner-scoped durable job ID, never an upstream task identifier. */
      videoTaskId?: string
    }>
  }>
  events: CanvasRunEvent[]
}

export interface CanvasProjectPreview {
  previewId: string
  resumingImport?: true
  originalImportPolicy?: 'drop' | 'reject'
  name: string
  workflowName: string
  nodeCount: number
  edgeCount: number
  assetCount: number
  warnings: string[]
  missingAssetCount?: number
  embeddedAssetCount?: number
  embeddedAssetBytes?: number
  embeddedMediaCounts?: { image: number; video: number; audio: number }
  embeddedAssets?: Array<{ assetId: string; mediaType: 'image' | 'video' | 'audio'; fileName?: string; nodeIds: string[]; nodeTitles?: string[]; byteSize: number }>
  packageFileBytes?: number
  missingAssets?: Array<{ assetId: string; nodeIds: string[]; nodeTitles?: string[]; kinds?: Array<'image' | 'video' | 'audio'> }>
  createsProject?: boolean
  provenance?: Array<{ name: string; license: string; notice?: string }>
}

export interface CanvasProjectImportProgress {
  completed: number
  total: number
  bytesUploaded: number
}

export interface CanvasStoredProjectSummary {
  access?: import('./lib/project-access-contract').ProjectAccessSnapshot
  version?: number
  /** Independent organization revision; legacy projects default to zero. */
  metadataVersion?: number
  categoryId?: string
  cover?: import('./lib/project-management-contract').ProjectManualCover
  id: string
  name: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  nodeCount: number | null
  assetCount: number | null
  summaryStatus?: 'ready' | 'unavailable'
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

export interface CanvasProjectQuery {
  view?: 'active' | 'archived' | 'all'
  q?: string
  limit?: number
  offset?: number
  sort?: 'updated-desc' | 'created-desc' | 'name-asc' | 'name-desc'
  /** Omitted means all categories; null means uncategorized. */
  categoryId?: string | null
}

export interface CanvasProjectPage {
  items: Array<CanvasStoredProjectSummary & { version: number }>
  total: number
  limit: number
  offset: number
  counts: { all: number; active: number; archived: number }
  query?: CanvasProjectQuery
}

export interface CanvasAppearance {
  theme: 'light' | 'dark'
  uiSkin?: 'dawn' | 'obsidian' | 'mist' | 'aurora'
  reducedMotion?: boolean
}

export interface CanvasAccountChange {
  userId: number | null
  previousUserId: number | null
  siteId?: 'solov' | 'solov-api'
}

export interface CanvasHostBridge {
  /** Static and read once per bridge; without it the kernel offers only the v2-equivalent set (host-capabilities.ts). */
  capabilities?(): CanvasHostCapabilities
  /** Web-only typed protocol; an absent capability never becomes a whole-document save. */
  projectCollaboration?: ProjectCollaborationClient
  getProjectAccess?(): { projectId: string; access?: import('./lib/project-access-contract').ProjectAccessSnapshot; denied?: boolean; message?: string } | null
  refreshProjectAccess?(): Promise<void>
  onProjectAccessChange?(listener: (state: { projectId: string; access?: import('./lib/project-access-contract').ProjectAccessSnapshot; denied?: boolean; message?: string } | null) => void): () => void
  /**
   * Receives the whole stored address (`xingmang-asset://<image|video|audio>/<id>`
   * or a `xingmang-asset://thumb/…` address) and returns what the page can load,
   * or undefined when it must not show it. Without it the kernel shows the stored
   * address as it is, which a desktop host serves through its own protocol.
   */
  resolveAssetDisplayUrl?(assetUrl: string): string | undefined
  /**
   * The asset behind an address this host handed out for its own media before
   * stored data used `xingmang-asset://` throughout, or undefined for any other
   * address. The kernel accepts it only where it accepts that asset's protocol
   * address, and keeps the protocol address from then on.
   */
  resolveHostAssetUrl?(url: string): { assetId: string; projectId?: string } | undefined
  workshopImportRecovery?: WorkshopImportRecovery
  workshopOperationRecovery?: WorkshopOperationRecoveryPort
  workshopCreationRecovery?: WorkshopCreationRecovery
  workshopContentRecovery?: WorkshopContentRecovery
  projectImportRecovery?: ProjectImportRecoveryPort
  saveFile(suggestedName: string, content: string): Promise<{ savedPath: string } | null>
  /** Exports the supplied draft as independent raster layers; never applies it to a node. */
  exportLayerPsd?(input: { recipe: ImageLayerRecipe; sourceAssetIds: string[]; name: string }, signal?: AbortSignal): Promise<{ fileName: string; byteSize: number; layerCount: number; groupCount?: number }>
  /** Renders a flattened annotation over one owned, unchanged base image; does not save it. */
  readVideoForFramePreview?(assetId: string, signal?: AbortSignal): Promise<Blob>
  renderImageAnnotation?(input: { sourceAssetId: string; recipe: ImageLayerRecipe }, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number }>
  importLayerPsd?(document: BrowserImportedLayerPsd, signal: AbortSignal, onProgress?: (completed: number, total: number) => void): Promise<CanvasImageAssetSummary[]>
  importColorLutFile?(file: File, signal?: AbortSignal): Promise<AssetColorLutSource>
  importColorLut?(table: ColorLutTable, signal?: AbortSignal): Promise<ColorLutResourceDescriptor>
  readColorLut?(source: AssetColorLutSource, signal?: AbortSignal): Promise<{ descriptor: ColorLutResourceDescriptor; table: ColorLutTable }>
  listColorLuts?(input?: { limit?: number; cursor?: string }, signal?: AbortSignal): Promise<{ items: ColorLutResourceDescriptor[]; nextCursor: string | null }>
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
    aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | '4:5' | '5:4' | '3:2' | '2:3' | '5:2'
    promptOptimization?: boolean
  }): Promise<CanvasGeneratedVideoAsset>
  resumeVideoTask(taskId: string): Promise<CanvasGeneratedVideoAsset>
  inspectVideoTask?(target: CanvasVideoTaskTarget): Promise<CanvasVideoTaskSummary>
  checkVideoTask?(target: CanvasVideoTaskTarget, expectedVersion: number): Promise<CanvasVideoTaskSummary>
  saveVideoTask?(target: CanvasVideoTaskTarget, expectedVersion: number): Promise<CanvasVideoTaskSummary>
  cancelRequest(requestId: string): Promise<{ canceled: boolean; mayStillComplete: boolean }>
  copyAsset(assetId: string): Promise<void>
  saveAsset(assetId: string): Promise<{ saved: boolean }>
  showAssetMenu(assetId: string): Promise<void>
  listAssets(query?: CanvasAssetQuery): Promise<CanvasAssetPage>
  listAssetCategories?(signal?: AbortSignal): Promise<import('./lib/asset-category-contract').AssetCategoryDirectory>
  readAssetCategoryAssignments?(assetIds: readonly string[], signal?: AbortSignal): Promise<import('./lib/asset-category-contract').AssetCategoryAssignmentDetail[]>
  manageAssetCategories?(input: import('./lib/asset-category-contract').AssetCategoryInput, signal?: AbortSignal): Promise<import('./lib/asset-category-contract').AssetCategoryResult>
  inspectAssetCategoryOperation?(input: import('./lib/asset-category-contract').AssetCategoryInput, signal?: AbortSignal): Promise<import('./lib/asset-category-contract').AssetCategoryOperationInspection>
  manageAssetMutations?(input: import('./lib/asset-mutation-contract').AssetMutationInput, signal?: AbortSignal): Promise<import('./lib/asset-mutation-contract').AssetMutationResult>
  inspectAssetMutationOperation?(input: import('./lib/asset-mutation-contract').AssetMutationInput, signal?: AbortSignal): Promise<import('./lib/asset-mutation-contract').AssetMutationInspection>
  listOfficialAssets?(query?: import('./lib/official-asset-contract').OfficialAssetQuery, signal?: AbortSignal): Promise<import('./lib/official-asset-contract').OfficialAssetPage>
  acquireOfficialAsset?(input: import('./lib/official-asset-contract').OfficialAssetIdentity, signal?: AbortSignal): Promise<import('./lib/official-asset-contract').OfficialAssetAcquisition>
  inspectOfficialAsset?(input: import('./lib/official-asset-contract').OfficialAssetIdentity, signal?: AbortSignal): Promise<import('./lib/official-asset-contract').OfficialAssetAcquisition>
  getAssetDetail?(assetId: string, signal?: AbortSignal): Promise<CanvasListedAssetSummary>
  /** Readonly, server-verified origin; never reconciles or monitors a run. */
  readAssetOrigin?(assetId: string, signal?: AbortSignal): Promise<import('./lib/asset-origin-contract').CanvasAssetOriginResult>
  downloadAssets?(assetIds: readonly string[]): Promise<void>
  renameAsset(input: { assetId: string; displayName: string }): Promise<{ assetId: string; displayName: string }>
  updateAssetMetadata(input: { assetId: string; favorite?: boolean; tags?: string[] }): Promise<{ assetId: string; favorite: boolean; tags: string[]; lastUsedAt?: string }>
  markAssetUsed(assetId: string): Promise<{ assetId: string; lastUsedAt: string }>
  deleteAsset(assetId: string): Promise<{ assetId: string; deletedAt: string }>
  restoreAsset(assetId: string): Promise<{ assetId: string }>
  purgeAsset(assetId: string, currentProjectContent: string): Promise<{ assetId: string }>
  inspectAssetReferences(assetId: string, currentProjectContent: string): Promise<CanvasAssetReferenceReport>
  checkAssetRunInputs?(assetId: string, currentProjectContent: string, retryUnavailable?: boolean): Promise<CanvasAssetReferenceReport>
  pickAsset(options?: import('./lib/canvas-media-import').CanvasMediaImportOptions): Promise<CanvasGeneratedAsset | CanvasAssetSummary | null>
  importAssetFile(file: File, options?: import('./lib/canvas-media-import').CanvasMediaImportOptions): Promise<CanvasGeneratedAsset | CanvasAssetSummary>
  listPromptPresets(): Promise<CanvasPromptPreset[]>
  createPromptPreset(input: PromptPresetInput): Promise<CanvasPromptPreset>
  updatePromptPreset(input: PromptPresetUpdateInput): Promise<CanvasPromptPreset>
  deletePromptPreset(id: string, expectedVersion?: number): Promise<boolean>
  reorderPromptPresets?(input: PromptPresetOrderInput): Promise<PromptPresetOrderEntry[]>
  listWorkshopItems?(query?: CanvasWorkshopQuery): Promise<CanvasWorkshopPage>
  readWorkshopItem?(id: string): Promise<CanvasWorkshopItem>
  inspectWorkshopItemCreation?(identity: WorkshopCreationIdentity, signal?: AbortSignal): Promise<WorkshopCreationOperation>
  cancelWorkshopItemCreation?(identity: WorkshopCreationIdentity, signal?: AbortSignal): Promise<Exclude<WorkshopCreationOperation, { state: 'missing' }>>
  createWorkshopItem?(input: CanvasWorkshopCreateInput): Promise<CanvasWorkshopItem>
  prepareWorkshopWorkflow?(workflow: WorkflowFile, signal?: AbortSignal): Promise<WorkflowFile>
  updateWorkshopItem?(input: CanvasWorkshopUpdateInput): Promise<CanvasWorkshopItem>
  updateWorkshopItemContent?(input: WorkshopContentUpdateInput): Promise<WorkshopContentUpdateReceipt>
  inspectWorkshopItemContentOperation?(operationId: string): Promise<WorkshopContentOperation>
  cancelWorkshopItemContentOperation?(input: WorkshopContentOperationIdentity): Promise<Exclude<WorkshopContentOperation, { state: 'missing' }>>
  deleteWorkshopItem?(id: string, expectedVersion: number): Promise<CanvasWorkshopItemSummary>
  restoreWorkshopItem?(id: string, expectedVersion: number): Promise<CanvasWorkshopItemSummary>
  listCommunityWorkshop?(query?: CommunityWorkshopQuery): Promise<CommunityWorkshopPage>
  readCommunityWorkshop?(id: string): Promise<CommunityWorkshopDetail>
  getCommunityExampleImage?(publicationId: string, publicationVersion: number, imageId: string, signal?: AbortSignal): Promise<Blob>
  previewCommunityPublication?(input: CommunityPublicationSource): Promise<CommunityPublicationPreview>
  publishCommunityWorkshop?(input: CommunityPublicationInput): Promise<CommunityWorkshopReceipt>
  withdrawCommunityWorkshop?(input: CommunityWorkshopMutationInput): Promise<CommunityWorkshopReceipt>
  acquireCommunityWorkshop?(input: CommunityWorkshopMutationInput): Promise<CommunityWorkshopReceipt>
  inspectCommunityOperation?(operationId: string): Promise<CommunityWorkshopOperation>
  workshopTransfer?<M extends WorkshopTransferMethod>(method: M, input: WorkshopTransferMethodMap[M]['input'], signal?: AbortSignal): Promise<WorkshopTransferMethodMap[M]['result']>
  prepareWorkshopImportContent?(content: string, signal?: AbortSignal, options?: { readOnly?: boolean }): Promise<string>
  mcp?<M extends CanvasMcpMethod>(method: M, input: CanvasMcpMethodMap[M]['input'], signal?: AbortSignal): Promise<CanvasMcpMethodMap[M]['result']>
  agent?<M extends CanvasAgentMethod>(method: M, input: CanvasAgentMethodMap[M]['input'], signal?: AbortSignal): Promise<CanvasAgentMethodMap[M]['result']>
  startRun(input: { graph: CanvasRunGraph; scope: CanvasRunScope; agentExecution?: CanvasAgentExecutionOrigin }, options?: { operationId?: string; signal?: AbortSignal }): Promise<{ runId: string; graphRevision: string; execution?: CanvasAgentExecution }>
  cancelRun(runId: string): Promise<boolean>
  /** Continue the original run and attempts without starting a new operation. */
  resumeRun?(runId: string): Promise<boolean>
  listRuns(): Promise<CanvasRunRecord[]>
  /** Read-only, owner-scoped history; browsing never monitors or projects runs. */
  listRunHistory?(query?: Omit<CanvasRunSummaryQuery, 'projectId'>, signal?: AbortSignal): Promise<CanvasRunSummaryPage>
  readRunHistory?(runId: string, signal?: AbortSignal): Promise<CanvasRunRecord>
  /** Owner-scoped original inputs, without credentials or runtime outputs. */
  getRunInputGraph?(runId: string): Promise<CanvasRunGraph>
  exportProject(suggestedName: string, content: string, options?: { projectId?: string }): Promise<{ savedPath: string } | null>
  previewProjectExport?(content: string): Promise<ProjectExportPreview>
  exportProjectPackage?(previewId: string, options: { allowExternalReferences: boolean }, onProgress?: (progress: ProjectExportProgress) => void): Promise<ProjectExportResult>
  cancelProjectExport?(previewId?: string): void
  previewProject(): Promise<CanvasProjectPreview | null>
  previewWorkflowContent?(content: string, name?: string): Promise<CanvasProjectPreview>
  /** Owner-only original media eligibility; no import, upload or reference write. */
  inspectClipboardWorkflow?(workflow: WorkflowFile, signal?: AbortSignal): Promise<void>
  importProject(previewId: string, options?: { missingAssets: 'drop' | 'reject' }, onProgress?: (progress: CanvasProjectImportProgress) => void): Promise<{ content: string; warnings: string[]; importedAssetCount: number; projectId?: string }>
  discardProjectImport?(previewId: string): void
  listProjects(): Promise<CanvasStoredProjectSummary[]>
  listProjectPage?(query: CanvasProjectQuery): Promise<CanvasProjectPage>
  createProject(name: string, initialWorkflowContent?: string, options?: { sourceProjectId: string }): Promise<{ project: CanvasStoredProjectSummary; content: string; projectProvenance?: Array<{ name: string; license: string; notice?: string }> } | null>
  createTemplateProject?(input: { operationId: string; content: string }): Promise<{ project: CanvasStoredProjectSummary; content: string }>
  inspectProjectCreation?(input: { operationId: string; creationDigest: string }): Promise<CanvasProjectCreationReceipt>
  openProject(projectId: string): Promise<{ project: CanvasStoredProjectSummary; content: string; projectProvenance?: Array<{ name: string; license: string; notice?: string }> }>
  listProjectHistory?(projectId: string, signal?: AbortSignal): Promise<CanvasProjectHistoryPage>
  readProjectRevision?(projectId: string, revisionId: string, signal?: AbortSignal): Promise<CanvasProjectRevisionDetail>
  restoreProjectRevision?(projectId: string, input: CanvasProjectRestoreInput): Promise<CanvasProjectRestoreResult>
  inspectProjectRestore?(projectId: string, input: CanvasProjectRestoreInput): Promise<CanvasProjectRestoreInspection>
  saveProject(projectId: string, content: string, options?: { retainRevisionId?: string }): Promise<CanvasStoredProjectSummary>
  renameProject(projectId: string, name: string): Promise<CanvasStoredProjectSummary>
  duplicateProject(projectId: string, name: string): Promise<{ project: CanvasStoredProjectSummary; content: string; projectProvenance?: Array<{ name: string; license: string; notice?: string }> } | null>
  setProjectArchived(projectId: string, archived: boolean): Promise<CanvasStoredProjectSummary>
  onAccountChange(listener: (change: CanvasAccountChange) => void): () => void
  onRunEvent(listener: (event: CanvasRunEvent) => void): () => void
  onThemeChange(listener: (theme: 'light' | 'dark') => void): () => void
  onAppearanceChange(listener: (appearance: CanvasAppearance) => void): () => void
  onCloseRequested(listener: (request: { requestId: string }) => void): () => void
  onCloseCancelled(listener: (request: { requestId: string }) => void): () => void
  finishClose(requestId: string, allowed: boolean): Promise<boolean>
  cancelCloseTasks(requestId: string): Promise<boolean>
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
    async listWorkshopItems() { return unavailable() },
    async readWorkshopItem() { return unavailable() },
    async createWorkshopItem() { return unavailable() },
    async updateWorkshopItem() { return unavailable() },
    async updateWorkshopItemContent() { return unavailable() },
    async inspectWorkshopItemContentOperation() { return unavailable() },
    async cancelWorkshopItemContentOperation() { return unavailable() },
    async deleteWorkshopItem() { return unavailable() },
    async restoreWorkshopItem() { return unavailable() },
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
    onAccountChange() { return () => undefined },
    onRunEvent() { return () => undefined },
    onThemeChange() { return () => undefined },
    onAppearanceChange() { return () => undefined },
    onCloseRequested() { return () => undefined },
    onCloseCancelled() { return () => undefined },
    async finishClose() { return false },
    async cancelCloseTasks() { return false },
  }
}

// 插槽（#3）：工坊、Agent 和 MCP、协作、视频任务恢复这些云端界面不在内核里，由网页外壳把组件传进来
// （app/canvas-slots/）。桌面和嵌入宿主不传，对应的面板、窗口和打开它们的入口都不出现。
//
// Slots only decide which interface is rendered; they grant nothing. Every
// cloud action still goes through the host bridge, so a host that offers no
// workshop, agent or collaboration methods keeps those features off even when
// a slot is present, and the server keeps refusing what an account may not do.
import type { ComponentType } from 'react'
import type { CanvasAgentApprovalReference } from './lib/canvas-agent-approval-contract'
import type { CanvasAgentClient, CanvasAgentImageReference, CanvasAgentTurn } from './lib/canvas-agent-contract'
import type { CanvasAgentExecution } from './lib/canvas-agent-execution-contract'
import type { CanvasAgentMediaModelSource } from './lib/canvas-agent-media-models'
import type { CanvasMcpClient } from './lib/canvas-mcp-contract'
import type { CanvasVideoTaskActions } from './lib/canvas-video-task-target'
import type { WorkshopContentUpdateReceipt } from './lib/workshop-content-contract'
import type { CanvasAgentContextNode, CanvasAgentContextRequest, CanvasAgentPanelScope } from './components/canvas-agent-panel-state'
import type { OfficialAssetAccess } from './components/official-asset-browser-model'
import type { TemplateAssetLoader } from './components/template-asset-picker-model'
import type { CanvasCollaborationState } from './editor/project-collaboration-controller'
import type { WorkshopModelMappingChoice, WorkshopModelMappingIssue, WorkshopModelMappingRow, WorkshopModelMappingSource } from './editor/workshop-model-mapping'
import type { WorkshopSetup, WorkshopSetupItem, WorkshopSetupScopeKind } from './editor/workshop-setup'
import type { CanvasAssetPage, CanvasAssetSummary, CanvasGroupSummary, CanvasImageAssetSummary, CanvasPromptPreset, CanvasRunCandidate, CanvasVideoAssetSummary, CanvasVideoTaskTarget, CanvasWorkshopItem } from './host'
import type { WorkflowFile } from './model'
import type { CanvasRunPreflight } from './runtime/run-preflight'

export type AgentImageReader = (assetId: string, signal?: AbortSignal) => Promise<CanvasImageAssetSummary>

export interface CanvasAgentPanelProps {
  mediaModelCatalog?: readonly CanvasAgentMediaModelSource[]
  mediaModelCatalogLoading?: boolean
  mediaModelCatalogError?: string
  onRefreshMediaModels?(): void
  client: CanvasAgentClient
  mcpClient?: CanvasMcpClient
  scope: CanvasAgentPanelScope
  open: boolean
  nodes: readonly CanvasAgentContextNode[]
  selectedNodeIds: readonly string[]
  contextRequest?: CanvasAgentContextRequest | null
  groups: readonly CanvasGroupSummary[]
  textModels: readonly string[]
  textGroup: string | null
  textModel?: string | null
  onPrepare(imageReferences?: readonly CanvasAgentImageReference[]): Promise<{ projectId: string; expectedProjectVersion: number }>
  onApply(turn: CanvasAgentTurn): Promise<CanvasAgentTurn>
  automationRevision?: number
  getAutomationRevision?(): number
  onApplyApproved?(turn: CanvasAgentTurn, approval: CanvasAgentApprovalReference, signal: AbortSignal): Promise<CanvasAgentTurn>
  onRunApproved?(turn: CanvasAgentTurn, approval: CanvasAgentApprovalReference, signal: AbortSignal): Promise<CanvasAgentExecution | null>
  onContinueApproved?(turn: CanvasAgentTurn, approval: CanvasAgentApprovalReference, signal: AbortSignal): Promise<CanvasAgentTurn>
  onListAssets?: TemplateAssetLoader
  onReadImageAsset?: AgentImageReader
  onImportImage?(): Promise<CanvasImageAssetSummary | null>
  onRun(turn: CanvasAgentTurn): void
  executionRefreshKey?: number
  onReadExecutionAsset?(assetId: string, signal: AbortSignal): Promise<CanvasAssetSummary>
  onPreviewExecutionAsset?(asset: CanvasRunCandidate['asset']): Promise<void>
  onDownloadExecutionAsset?(assetId: string): Promise<void>
  onResumeExecution?(execution: CanvasAgentExecution): Promise<boolean>
  onReadExecutionPreflight?(execution: CanvasAgentExecution): Promise<CanvasRunPreflight>
  onCancelExecution?(execution: CanvasAgentExecution): Promise<boolean>
  onConfigureModels(): void
  onLocateNode?(nodeId: string): void
  onLocatePlan?(nodeIds: string[]): void
  onClose(): void
}

export type CollaborationPanelAction = 'join' | 'resync' | 'inspect' | 'retry' | 'abandon' | 'use-server' | 'leave' | 'end'
export interface CollaborationPanelProps {
  state: CanvasCollaborationState
  onAction(action: CollaborationPanelAction, operationId?: string): void
  onExport(): void
}

export interface CanvasWorkshopLibraryDialogProps {
  readOnly?: boolean
  initialItemId?: string
  initialPromptId?: string
  initialBuiltinPromptId?: string
  creatingProject: boolean
  editingItemId?: string
  onInsert(item: CanvasWorkshopItem): Promise<void>
  onInsertPrompt?(preset: CanvasPromptPreset): Promise<void>
  onPromptAcquired?(preset: CanvasPromptPreset): void
  onInsertOfficialTemplate?(id: string): Promise<void>
  onInsertOfficialPrompt?(id: string): Promise<void>
  onClose(): void
}

export interface SaveCanvasWorkshopDialogProps {
  workflow: WorkflowFile
  scopeKey?: string
  isCurrent?(): boolean
  initialTargetId?: string
  onSaved(item: CanvasWorkshopItem): void
  onUpdated?(receipt: WorkshopContentUpdateReceipt): void
  onClose(): void
}

export interface WorkshopAssetPickerDialogProps {
  label: string
  scopeKey: string
  mediaType?: CanvasAssetSummary['mediaType']
  fallbackPage: CanvasAssetPage
  onListAssets: TemplateAssetLoader
  officialAccess?: OfficialAssetAccess
  onChoose(asset: CanvasAssetSummary): Promise<void>
  onClose(): void
  onAcquired(): void
}

export interface WorkshopModelMappingDialogProps {
  rows: readonly WorkshopModelMappingRow[]
  sources: readonly WorkshopModelMappingSource[]
  choices: readonly WorkshopModelMappingChoice[]
  phase: 'editing' | 'review'
  issues?: readonly WorkshopModelMappingIssue[]
  /** The parent counts actual changed nodes, excluding same-route no-ops. */
  changedCount: number
  busy?: boolean
  error?: string
  onChange(choices: WorkshopModelMappingChoice[]): void
  onReview(): void
  onApply(): void
  onCancel(): void
  onBack?(): void
}

export interface WorkshopSetupPanelProps {
  setup: WorkshopSetup
  readOnly?: boolean
  busy?: boolean
  error?: string | null
  reviewDisabledReason?: string
  availableScopes?: readonly WorkshopSetupScopeKind[]
  onLocate(nodeId: string): void
  onAction(item: WorkshopSetupItem): void
  onPickLibrary?(item: WorkshopSetupItem): void
  onScopeChange(kind: WorkshopSetupScopeKind): void
  onReviewRun(): void
  onModelMapping?(): void
  onClose(): void
}

export interface WorkshopContentRecoveryNoticeProps { scopeKey: string; active(): boolean; onUpdated(receipt: WorkshopContentUpdateReceipt): void }
export interface WorkshopCreationRecoveryNoticeProps { scopeKey: string; active(): boolean; onSaved(item: CanvasWorkshopItem): void }

export interface VideoTaskRecoveryProps {
  target: CanvasVideoTaskTarget
  actions?: CanvasVideoTaskActions
  onOpenAssets?(): void
  onUseAsset?(asset: CanvasVideoAssetSummary): void
  currentAssetId?: string
}

/** Every slot is optional; a missing one removes that interface and every entry that opens it. */
export interface CanvasKernelSlots {
  CanvasAgentPanel?: ComponentType<CanvasAgentPanelProps>
  ProjectCollaborationPanel?: ComponentType<CollaborationPanelProps>
  CanvasWorkshopLibraryDialog?: ComponentType<CanvasWorkshopLibraryDialogProps>
  SaveCanvasWorkshopDialog?: ComponentType<SaveCanvasWorkshopDialogProps>
  WorkshopAssetPickerDialog?: ComponentType<WorkshopAssetPickerDialogProps>
  WorkshopModelMappingDialog?: ComponentType<WorkshopModelMappingDialogProps>
  WorkshopSetupPanel?: ComponentType<WorkshopSetupPanelProps>
  WorkshopContentRecoveryNotice?: ComponentType<WorkshopContentRecoveryNoticeProps>
  WorkshopCreationRecoveryNotice?: ComponentType<WorkshopCreationRecoveryNoticeProps>
  VideoTaskRecovery?: ComponentType<VideoTaskRecoveryProps>
}

export const noCanvasSlots: CanvasKernelSlots = Object.freeze({})

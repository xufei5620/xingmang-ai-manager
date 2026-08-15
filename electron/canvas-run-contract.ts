export const canvasRunContractVersion = 1 as const

export type CanvasRunNodeKind =
  | 'text' | 'image' | 'video' | 'prompt'
  | 'image-input' | 'video-input' | 'audio-input' | 'image-generate' | 'image-edit' | 'video-generate'
  | 'frame-extract' | 'router' | 'gallery' | 'output' | 'group' | 'note'
export type CanvasRunScope =
  | { kind: 'all' }
  | { kind: 'to-node'; nodeId: string }
  | { kind: 'selection'; nodeIds: string[] }
  | { kind: 'dirty'; nodeIds: string[] }

export interface CanvasRunAsset {
  kind: 'image' | 'video' | 'audio'
  assetId: string
  localUrl: string
  mimeType?: string
  width?: number
  height?: number
  taskId?: string
}

export interface CanvasRunGraphNode {
  id: string
  kind: CanvasRunNodeKind
  definitionVersion: number
  disabled?: boolean
  data: {
    prompt: string
    model: string
    group?: string
    quality?: string
    size?: string
    seconds?: string
    adoptedAssetId?: string
  }
}

export interface CanvasRunGraphEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface CanvasRunGraph {
  nodes: CanvasRunGraphNode[]
  edges: CanvasRunGraphEdge[]
}

export type CanvasRunNodeState =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'cached'
  | 'interrupted'

export type CanvasRunStatus =
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface CanvasRunCandidate {
  candidateId: string
  attemptId: string
  createdAt: string
  asset: CanvasRunAsset
  group?: string
  model?: string
  costQuota?: number
}

export interface CanvasRunAttempt {
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
}

export interface CanvasRunNodeRecord {
  nodeId: string
  kind: CanvasRunNodeKind
  state: CanvasRunNodeState
  attempts: CanvasRunAttempt[]
  errorMessage?: string
}

interface CanvasRunEventBase {
  version: typeof canvasRunContractVersion
  runId: string
  graphRevision: string
  sequence: number
  at: string
}

export interface CanvasRunNodeEvent extends CanvasRunEventBase {
  type: 'node-state'
  nodeId: string
  state: CanvasRunNodeState
  attemptId?: string
  fingerprint?: string
  candidateIds?: string[]
  errorMessage?: string
  costQuota?: number
}

export interface CanvasRunTerminalEvent extends CanvasRunEventBase {
  type: 'run-terminal'
  status: Exclude<CanvasRunStatus, 'running'>
  outcome: CanvasRunOutcome
}

export type CanvasRunEvent = CanvasRunNodeEvent | CanvasRunTerminalEvent

export interface CanvasRunOutcome {
  succeeded: string[]
  failed: string[]
  skipped: string[]
  cancelled: string[]
  cached: string[]
}

export interface CanvasRunRecord {
  version: typeof canvasRunContractVersion
  userId: number
  ownerId: number
  projectId?: string
  runId: string
  graphRevision: string
  scope: CanvasRunScope
  status: CanvasRunStatus
  createdAt: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  outcome?: CanvasRunOutcome
  nodes: CanvasRunNodeRecord[]
  events: CanvasRunEvent[]
}

export interface CanvasRunCacheEntry {
  version: typeof canvasRunContractVersion
  fingerprint: string
  nodeKind: CanvasRunNodeKind
  candidate?: CanvasRunCandidate
  outputText?: string
  createdAt: string
  lastUsedAt: string
}

export interface CanvasRunAssetManifestEntry {
  version: typeof canvasRunContractVersion
  asset: CanvasRunAsset
  createdAt: string
  lastVerifiedAt: string
}

export function isCanvasRunEventOwnedBy(
  event: CanvasRunEvent,
  ownership: { runId: string; graphRevision: string },
): boolean {
  return event.runId === ownership.runId && event.graphRevision === ownership.graphRevision
}

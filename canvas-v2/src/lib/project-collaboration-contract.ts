import type { CanvasStoredProjectSummary } from '../host'
import type { PersistedWorkflowNodeV2 } from '../persistence/workflow-schema'
import type { WorkflowEdge, WorkflowFile } from '../model'
import type { ProjectAccessSnapshot } from './project-access-contract'

export const projectCollaborationVersion = 1 as const
export const projectCollaborationLimits = {
  requestBytes: 1_500_000, receiptBytes: 16_384, responseBytes: 4 * 1024 * 1024,
  changes: 200, events: 32, retainedEvents: 128, retainedPayloadBytes: 16 * 1024 * 1024,
  presenceSeconds: 45, heartbeatMinimumMs: 2_000, clientsPerActor: 8, clientsPerProject: 64,
  selectedNodes: 40, historyTips: 20,
} as const

export type ProjectCollaborationNode = PersistedWorkflowNodeV2
export type ProjectCollaborationNodeProperties = Omit<ProjectCollaborationNode, 'id' | 'position' | 'data'>
export type ProjectCollaborationChange =
  | { kind: 'node-add'; node: ProjectCollaborationNode }
  | { kind: 'node-remove'; node: ProjectCollaborationNode }
  | { kind: 'node-set'; nodeId: string; slot: 'position'; before: { x: number; y: number }; after: { x: number; y: number } }
  | { kind: 'node-set'; nodeId: string; slot: 'data'; before: ProjectCollaborationNode['data']; after: ProjectCollaborationNode['data'] }
  | { kind: 'node-set'; nodeId: string; slot: 'properties'; before: ProjectCollaborationNodeProperties; after: ProjectCollaborationNodeProperties }
  | { kind: 'node-order-set'; before: string[]; after: string[] }
  | { kind: 'edges-set'; before: WorkflowEdge[]; after: WorkflowEdge[] }
  | { kind: 'document-set'; slot: 'name'; before: string; after: string }
  | { kind: 'document-set'; slot: 'mediaGroups'; before: WorkflowFile['mediaGroups'] | null; after: WorkflowFile['mediaGroups'] | null }

export interface ProjectCollaborationActor { accountId: string; displayName?: string }
export interface ProjectCollaborationHead {
  version: 1; epoch: string; sequence: number; baselineProjectVersion: number; projectVersion: number; endedAt?: string
}
export interface ProjectCollaborationHistoryTip { operationId: string; projectVersion: number }
export interface ProjectCollaborationHistory {
  actorSequence: number; undo?: ProjectCollaborationHistoryTip; redo?: ProjectCollaborationHistoryTip
}
export interface ProjectCollaborationPresence {
  version: 1; clientId: string; actor: ProjectCollaborationActor; selectedNodeIds: string[]
  cursor?: { x: number; y: number }; expiresAt: string
}
export interface ProjectCollaborationSnapshot {
  version: 1; projectId: string
  state: 'ready' | 'not-started' | 'resync-required' | 'ended'
  project: CanvasStoredProjectSummary & { version: number; access: ProjectAccessSnapshot }
  content: string; contentDigest: string; actor: ProjectCollaborationActor; head?: ProjectCollaborationHead
  canJoin: boolean; history: ProjectCollaborationHistory; presence: ProjectCollaborationPresence[]
}
export type ProjectCollaborationAction = 'join' | 'resync' | 'edit' | 'undo' | 'redo' | 'end-epoch'
/** Immutable original receipt. Mutable undo state never rewrites this JSON. */
export interface ProjectCollaborationReceipt {
  version: 1; projectId: string; operationId: string; requestDigest: string; action: ProjectCollaborationAction
  epoch: string; sequence: number; accessVersion: number; previousProjectVersion: number; projectVersion: number
  baseProjectVersion: number; contentDigest: string; targetOperationId?: string
}
export interface ProjectCollaborationEvent {
  version: 1; receipt: ProjectCollaborationReceipt; actor: ProjectCollaborationActor
  changes: ProjectCollaborationChange[]; createdAt: string
}
export type ProjectCollaborationInspection =
  | { version: 1; state: 'missing' }
  | { version: 1; state: 'found'; receipt: ProjectCollaborationReceipt; payloadState: 'retained' | 'compacted' | 'unavailable'; event?: ProjectCollaborationEvent }
export interface ProjectCollaborationFeedInput {
  version: 1; clientId?: string; epoch: string; expectedAccessVersion: number
  afterSequence: number; afterProjectVersion: number; limit?: number
}
export type ProjectCollaborationFeed =
  | { version: 1; state: 'events'; projectId: string; epoch: string; events: ProjectCollaborationEvent[]
      sequence: number; projectVersion: number; hasMore: boolean; history: ProjectCollaborationHistory; presence: ProjectCollaborationPresence[] }
  | { version: 1; state: 'resync-required'; projectId: string; reason: 'external-save' | 'epoch-changed' | 'history-compacted' | 'ended' | 'authority-changed' | 'shared-unavailable'
      projectVersion: number }
export interface ProjectCollaborationJoinInput {
  version: 1; action: 'join' | 'resync'; operationId: string; clientId: string
  expectedAccessVersion: number; expectedProjectVersion: number; contentDigest: string; epoch?: string
}
export interface ProjectCollaborationJoinResult {
  version: 1; receipt: ProjectCollaborationReceipt; snapshot: ProjectCollaborationSnapshot; clientId: string
  leaseState: 'active' | 'expired' | 'left' | 'ended'; expiresAt: string
}
interface MutationBase {
  version: 1; operationId: string; clientId: string; epoch: string; expectedAccessVersion: number
  baseProjectVersion: number; expectedActorSequence: number
}
export type ProjectCollaborationMutationInput = MutationBase & (
  | { action: 'edit'; changes: ProjectCollaborationChange[] }
  | { action: 'undo' | 'redo'; targetOperationId: string }
  | { action: 'end-epoch' }
)
export interface ProjectCollaborationMutationResult {
  version: 1; receipt: ProjectCollaborationReceipt; event?: ProjectCollaborationEvent
  snapshot: ProjectCollaborationSnapshot
}
export interface ProjectCollaborationPresenceInput {
  version: 1; action: 'heartbeat' | 'leave'; clientId: string; epoch: string; expectedAccessVersion: number
  selectedNodeIds: string[]; cursor?: { x: number; y: number }
}
export interface ProjectCollaborationPresenceResult { version: 1; state: 'active' | 'left'; expiresAt?: string }
export interface ProjectCollaborationReadOptions { version: 1; expectedAccessVersion?: number; clientId?: string }

export class ProjectCollaborationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = status === 403 ? 'COLLABORATION_ACCESS_DENIED' : status === 409 ? 'COLLABORATION_CONFLICT' : 'COLLABORATION_INVALID') { super(message); this.name = 'ProjectCollaborationError' }
}
export function assertProjectCollaborationVersion(value: unknown): asserts value is 1 {
  if (value !== 1) throw new ProjectCollaborationError('实时协作能力版本不受支持，请刷新；当前草稿不会改用普通整图保存', 409, 'COLLABORATION_VERSION_REQUIRED')
}

import type { CanvasFramePreparation, CanvasImagePreparation, CanvasRunEvent, CanvasRunNodeState, CanvasRunRecord, CanvasRunScope, CanvasRunStatus } from '../host'

export interface CanvasRunSummaryScope {
  kind: CanvasRunScope['kind']
  nodeId?: string
  nodeCount?: number
}

export type CanvasRunStateCounts = Record<CanvasRunNodeState, number>

export interface CanvasRunSummary {
  runId: string
  projectId: string
  projectName?: string
  graphRevision: string
  status: CanvasRunStatus
  scope: CanvasRunSummaryScope
  createdAt: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  /** Older running records may not have stored the selected node count. */
  totalNodes: number | null
  nodeCounts: CanvasRunStateCounts
  mayStillComplete: boolean
  cancelRequested: boolean
  waitingForVideo?: boolean
  waitingForFrame?: boolean
  waitingForImage?: boolean
  resumeAfter?: string
  /** The lease expired; opening detail persists the conservative terminal state. */
  reconciliationPending?: boolean
  /** Only recorded node facts could be verified during lease reconciliation. */
  reconciliationPartial?: boolean
}

export interface CanvasRunSummaryPage {
  items: CanvasRunSummary[]
  nextCursor: string | null
  hasMore: boolean
}

export interface CanvasRunSummaryQuery {
  projectId?: string
  status?: CanvasRunStatus | 'all'
  q?: string
  cursor?: string
  limit?: number
}

export interface CanvasRunSummaryResponse { summary: CanvasRunSummary }
export interface CanvasRunNodePage {
  nodes: CanvasRunRecord['nodes']
  offset: number
  limit: number
  total: number
  hasMore: boolean
  inputStatus?: 'available' | 'unavailable'
  paginationBasis?: 'graph' | 'stored'
  partial?: boolean
  invalidStoredNodeCount?: number
  originalTotalNodes?: number | null
}
export interface CanvasRunEventsPage {
  events: CanvasRunEvent[]
  afterSequence: number
  hasMore: boolean
  status: CanvasRunStatus
  mayStillComplete: boolean
  waitingForVideo?: boolean
  framePreparations?: CanvasFramePreparation[]
  imagePreparations?: CanvasImagePreparation[]
  resumeAfter?: string
}
export interface CanvasRunCancelResponse { accepted: boolean; mayStillComplete: boolean }

import type { CanvasStoredProjectSummary } from '../host'
import type { ProjectProvenance } from './project-provenance'

export interface CanvasProjectRevisionSummary {
  id: string
  projectId: string
  projectVersion: number
  kind: 'save' | 'restore-point'
  savedAt: string
  authorName?: string
  nodeCount: number | null
  edgeCount: number | null
  assetCount: number | null
}
export interface CanvasProjectHistoryPage {
  projectId: string
  currentVersion: number
  limit: 10
  items: CanvasProjectRevisionSummary[]
}
export interface CanvasProjectRevisionDetail {
  revision: CanvasProjectRevisionSummary
  content: string
  projectProvenance: ProjectProvenance[]
  missingAssets: Array<{ assetId: string; nodeIds: string[]; reason: 'missing' | 'trash' }>
  canRestore: boolean
}
export interface CanvasProjectRestoreInput { operationId: string; revisionId: string; expectedVersion: number }
export interface CanvasProjectRestoreReceipt {
  operationId: string
  revisionId: string
  previousVersion: number
  restoredVersion: number
  restorePointId: string
  savedRevisionId: string
}
export type CanvasProjectRestoreResult =
  | { state: 'restored'; receipt: CanvasProjectRestoreReceipt; project: CanvasStoredProjectSummary; content: string; projectProvenance: ProjectProvenance[] }
  | { state: 'changed'; receipt: CanvasProjectRestoreReceipt; currentVersion: number }
export type CanvasProjectRestoreInspection = CanvasProjectRestoreResult | { state: 'missing' }

export interface CanvasProjectVersionAssetReference {
  projectId: string
  projectName: string
  revisionId: string
  projectVersion: number
  kind: 'save' | 'restore-point'
  savedAt: string
}

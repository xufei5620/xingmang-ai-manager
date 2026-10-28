import type { WorkshopTransferOrigin, WorkshopItemPermissions } from './workshop-transfer-contract'
import type { NodeKind, WorkflowFile } from '../model'
import type { CommunityWorkshopOrigin } from './community-workshop-contract'

export type CanvasWorkshopKind = 'node' | 'group'
export type WorkshopSourcePolicy = 'portable' | 'owner-private'

export interface CanvasWorkshopItemSummary {
  id: string
  kind: CanvasWorkshopKind
  name: string
  description: string
  category: string
  tags: string[]
  version: number
  nodeCount: number
  edgeCount: number
  nodeKinds: NodeKind[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
  origin?: CommunityWorkshopOrigin
  transferOrigin?: WorkshopTransferOrigin
  permissions?: WorkshopItemPermissions
}

/** Owner-private provider IDs are configuration, never credentials or public content. */
export interface CanvasWorkshopItem extends CanvasWorkshopItemSummary {
  workflow: WorkflowFile
  sourcePolicy?: WorkshopSourcePolicy
}

export interface CanvasWorkshopQuery {
  kind?: 'all' | CanvasWorkshopKind
  view?: 'active' | 'trash'
  q?: string
  category?: string
  /** Single-node presets only; applied before pagination and counting. */
  nodeKind?: NodeKind
  offset?: number
  limit?: number
}

export interface CanvasWorkshopPage {
  items: CanvasWorkshopItemSummary[]
  total: number
  offset: number
  limit: number
}

export interface CanvasWorkshopCreateInput {
  sourcePolicy?: WorkshopSourcePolicy
  /** Confirms group comparison sources were captured without flattening pending batches. */
  compareBindingsVersion?: 1
  /** Retain the same ID and input after an interrupted or unconfirmed save. */
  operationId: string
  kind: CanvasWorkshopKind
  name: string
  description?: string
  category?: string
  tags?: string[]
  workflow: WorkflowFile
}

export interface CanvasWorkshopUpdateInput {
  id: string
  expectedVersion: number
  name?: string
  description?: string
  category?: string
  tags?: string[]
}

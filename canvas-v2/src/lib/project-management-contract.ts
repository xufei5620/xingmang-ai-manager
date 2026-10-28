export interface ProjectCounts { all: number; active: number; archived: number }

export interface ProjectCategorySummary {
  id: string
  name: string
  version: number
  createdAt: string
  updatedAt: string
  counts: ProjectCounts
}

export interface ProjectCategoryDirectory {
  items: ProjectCategorySummary[]
  uncategorized: ProjectCounts
}

/** The original owned asset stays intact; both cover views apply this 16:9 crop. */
export interface ProjectManualCover {
  assetId: string
  positionX: number
  positionY: number
  zoom: number
}

export interface ProjectManagementSelection {
  id: string
  expectedVersion: number
  expectedMetadataVersion: number
}

export type ProjectManagementInput =
  | { action: 'create-category'; operationId: string; name: string }
  | { action: 'rename-category'; id: string; expectedVersion: number; name: string }
  | { action: 'delete-category'; id: string; expectedVersion: number }
  | { action: 'move'; projects: ProjectManagementSelection[]; categoryId: string | null }
  | { action: 'archive'; projects: ProjectManagementSelection[]; archived: boolean }
  | { action: 'cover'; projectId: string; expectedVersion: number; expectedMetadataVersion: number; cover: ProjectManualCover | null; source?: 'project' | 'upload' }

/** A compact confirmation followed by a fresh list; never embeds project bodies. */
export type ProjectManagementResult =
  | { action: 'create-category' | 'rename-category'; category: ProjectCategorySummary }
  | { action: 'delete-category'; categoryId: string; movedProjectCount: number }
  | { action: 'move' | 'archive'; updatedIds: string[] }
  | { action: 'cover'; projectId: string; metadataVersion: number; cover: ProjectManualCover | null }

export interface ProjectCoverCandidate {
  assetId: string
  fileName: string
  width?: number
  height?: number
}

export interface ProjectCoverPage {
  projectId: string
  projectVersion: number
  metadataVersion: number
  items: ProjectCoverCandidate[]
  total: number
  offset: number
  limit: number
}

export const maximumProjectCategories = 100
export const maximumProjectBatchSelection = 100

import type { ProjectAccessSnapshot } from './project-access-contract'
import type { WorkspaceProjectSummary } from './workspace-project-summary'
import type { ProjectProvenance } from './project-provenance'
import { maximumProjectContentBytes } from './canvas-limits'

export interface ProjectSnapshot {
  project: WorkspaceProjectSummary & { access: ProjectAccessSnapshot }
  content: string
  projectProvenance: ProjectProvenance[]
}

export const projectSnapshotLimits = {
  contentBytes: maximumProjectContentBytes,
  // The saved JSON is itself a JSON string in this response. Allow its escaping
  // plus the bounded summary and provenance without accepting an unlimited body.
  responseBytes: 2 * maximumProjectContentBytes + 256 * 1024,
} as const

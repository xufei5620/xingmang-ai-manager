import type { WorkflowFile } from '../model'
import { workflowForHostProject, type CanvasProjectStore } from './host-project-fields'
import { migrateWorkflowDocument } from './workflow-migrations'
import { sanitizeWorkflowV2 } from './workflow-sanitizer'
import {
  maximumWorkflowBytes,
  toPersistedWorkflowV2,
  type WorkflowParseResult,
} from './workflow-schema'

function withinWorkflowByteLimit(content: string): boolean {
  if (typeof content !== 'string' || content.length > maximumWorkflowBytes) return false
  return new TextEncoder().encode(content).byteLength <= maximumWorkflowBytes
}

/** Detailed form used by the editor to surface non-fatal sanitizer repairs. */
export function parseWorkflowFileDetailed(content: string): WorkflowParseResult | null {
  if (!withinWorkflowByteLimit(content)) return null
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  const migrated = migrateWorkflowDocument(raw)
  return migrated ? sanitizeWorkflowV2(migrated) : null
}

/** Compatibility form retained for existing App.tsx callers. */
export function parseWorkflowFile(content: string): WorkflowFile | null {
  return parseWorkflowFileDetailed(content)?.workflow ?? null
}

/** Without a store the kernel format is written, as servers and project files expect. */
export function serializeWorkflow(workflow: WorkflowFile, store?: CanvasProjectStore): string {
  const sanitized = sanitizeWorkflowV2(toPersistedWorkflowV2(workflow))
  if (!sanitized) throw new Error('工作流包含无法安全保存的数据')
  const persisted = toPersistedWorkflowV2(sanitized.workflow)
  return JSON.stringify(store ? workflowForHostProject(persisted, store) : persisted, null, 2)
}

import { isRecord, workflowSchemaVersion } from './workflow-schema'

/** Migrates one legacy wire document without trusting any nested field. */
export function migrateWorkflowDocument(raw: unknown): unknown | null {
  if (!isRecord(raw)) return null
  if (raw.schemaVersion === workflowSchemaVersion) return raw
  if (raw.schemaVersion !== 1) return null
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
  return {
    schemaVersion: workflowSchemaVersion,
    name: raw.name,
    nodes: raw.nodes.map((entry) => {
      if (!isRecord(entry)) return entry
      return {
        ...entry,
        definitionVersion: 1,
      }
    }),
    edges: raw.edges,
  }
}

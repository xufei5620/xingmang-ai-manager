import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import type { CanvasDocumentState, CanvasViewport } from './canvas-state'

export type CanvasCommand =
  | { type: 'add-nodes'; nodes: EditorNodeRecord[]; edges?: EditorEdgeRecord[]; mergeKey?: string }
  | { type: 'update-node-data'; nodeId: string; patch: Record<string, unknown>; mergeKey?: string }
  | { type: 'move-nodes'; positions: Readonly<Record<string, { x: number; y: number }>>; mergeKey?: string }
  | { type: 'replace-nodes'; nodes: EditorNodeRecord[]; mergeKey?: string }
  | { type: 'delete-elements'; nodeIds: string[]; edgeIds?: string[] }
  | { type: 'connect'; edge: EditorEdgeRecord }
  | { type: 'disconnect'; edgeIds: string[] }
  | { type: 'set-viewport'; viewport: CanvasViewport; mergeKey?: string }
  | { type: 'replace-document'; document: CanvasDocumentState }
  | { type: 'rename-document'; name: string }

export function commandMergeKey(command: CanvasCommand): string | null {
  return 'mergeKey' in command && command.mergeKey ? command.mergeKey : null
}

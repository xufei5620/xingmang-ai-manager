import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import type { CanvasDocumentState, CanvasMediaGroups, CanvasViewport } from './canvas-state'

export type CanvasCommand =
  | { type: 'add-nodes'; nodes: EditorNodeRecord[]; edges?: EditorEdgeRecord[]; mergeKey?: string }
  | { type: 'update-node-data'; nodeId: string; patch: Record<string, unknown>; mergeKey?: string }
  | { type: 'move-nodes'; positions: Readonly<Record<string, { x: number; y: number }>>; mergeKey?: string }
  | { type: 'resize-nodes'; dimensions: Readonly<Record<string, { width: number; height: number }>>; mergeKey?: string }
  | { type: 'set-node-flags'; nodeIds: string[]; locked?: boolean; disabled?: boolean }
  | { type: 'replace-nodes'; nodes: EditorNodeRecord[]; mergeKey?: string }
  | { type: 'insert-node-on-edge'; node: EditorNodeRecord; edgeId: string; before: EditorEdgeRecord; after: EditorEdgeRecord }
  | { type: 'delete-elements'; nodeIds: string[]; edgeIds?: string[]; bridges?: EditorEdgeRecord[] }
  | { type: 'connect'; edge: EditorEdgeRecord }
  | { type: 'disconnect'; edgeIds: string[] }
  | { type: 'reconnect-edge'; edgeId: string; edge: EditorEdgeRecord }
  | { type: 'set-viewport'; viewport: CanvasViewport; mergeKey?: string }
  | { type: 'set-media-groups'; mediaGroups: CanvasMediaGroups }
  | { type: 'replace-document'; document: CanvasDocumentState }
  | { type: 'rename-document'; name: string }

export function commandMergeKey(command: CanvasCommand): string | null {
  return 'mergeKey' in command && command.mergeKey ? command.mergeKey : null
}

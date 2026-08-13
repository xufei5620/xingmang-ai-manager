import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'

export const canvasClipboardMime = 'application/x-xingmang-canvas+json'
const canvasClipboardVersion = 1
const maximumClipboardBytes = 5 * 1024 * 1024
const maximumClipboardNodes = 1_000
const maximumClipboardEdges = 4_000

export interface CanvasClipboardPayload {
  version: typeof canvasClipboardVersion
  nodes: EditorNodeRecord[]
  edges: EditorEdgeRecord[]
}

export interface PasteCanvasClipboardOptions {
  offset: { x: number; y: number }
  createNodeId(oldId: string): string
  createEdgeId(oldId: string): string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validNode(value: unknown): value is EditorNodeRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.type === 'string'
    && Number.isInteger(value.definitionVersion)
    && isRecord(value.position)
    && Number.isFinite(value.position.x)
    && Number.isFinite(value.position.y)
    && isRecord(value.data)
}

function validEdge(value: unknown): value is EditorEdgeRecord {
  return isRecord(value)
    && ['id', 'source', 'sourceHandle', 'target', 'targetHandle'].every((key) => typeof value[key] === 'string')
}

export function buildCanvasClipboardPayload(
  nodes: readonly EditorNodeRecord[],
  edges: readonly EditorEdgeRecord[],
  selectedNodeIds: ReadonlySet<string>,
): CanvasClipboardPayload {
  const copiedNodes = nodes
    .filter((node) => selectedNodeIds.has(node.id))
    .map((node) => {
      const copy = structuredClone(node)
      delete copy.selected
      return copy
    })
  const copiedIds = new Set(copiedNodes.map((node) => node.id))
  const copiedEdges = edges
    .filter((edge) => copiedIds.has(edge.source) && copiedIds.has(edge.target))
    .map((edge) => {
      const copy = { ...edge }
      delete copy.selected
      return copy
    })
  return { version: canvasClipboardVersion, nodes: copiedNodes, edges: copiedEdges }
}

export function serializeCanvasClipboard(payload: CanvasClipboardPayload): string {
  return JSON.stringify(payload)
}

export function parseCanvasClipboard(content: string): CanvasClipboardPayload | null {
  if (typeof content !== 'string' || content.length > maximumClipboardBytes) return null
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.version !== canvasClipboardVersion || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
  if (raw.nodes.length > maximumClipboardNodes || raw.edges.length > maximumClipboardEdges) return null
  if (!raw.nodes.every(validNode) || !raw.edges.every(validEdge)) return null
  const nodeIds = new Set<string>()
  for (const node of raw.nodes) {
    if (!node.id || nodeIds.has(node.id)) return null
    nodeIds.add(node.id)
  }
  const edgeIds = new Set<string>()
  for (const edge of raw.edges) {
    if (!edge.id || edgeIds.has(edge.id) || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return null
    edgeIds.add(edge.id)
  }
  return {
    version: canvasClipboardVersion,
    nodes: structuredClone(raw.nodes),
    edges: structuredClone(raw.edges),
  }
}

export function pasteCanvasClipboard(
  payload: CanvasClipboardPayload,
  options: PasteCanvasClipboardOptions,
): { nodes: EditorNodeRecord[]; edges: EditorEdgeRecord[] } {
  const nodeIds = new Map(payload.nodes.map((node) => [node.id, options.createNodeId(node.id)]))
  if (new Set(nodeIds.values()).size !== nodeIds.size) throw new Error('粘贴节点标识冲突')
  const nodes = payload.nodes.map((node) => {
    const parentIsCopied = Boolean(node.parentId && nodeIds.has(node.parentId))
    return {
      ...structuredClone(node),
      id: nodeIds.get(node.id) as string,
      position: parentIsCopied
        ? { ...node.position }
        : { x: node.position.x + options.offset.x, y: node.position.y + options.offset.y },
      ...(parentIsCopied ? { parentId: nodeIds.get(node.parentId as string) } : { parentId: undefined }),
      selected: true,
    }
  })
  const edges = payload.edges.map((edge) => ({
    ...edge,
    id: options.createEdgeId(edge.id),
    source: nodeIds.get(edge.source) as string,
    target: nodeIds.get(edge.target) as string,
    selected: true,
  }))
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) throw new Error('粘贴连线标识冲突')
  return { nodes, edges }
}

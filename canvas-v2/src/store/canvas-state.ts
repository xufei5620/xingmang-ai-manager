import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasMediaGroups {
  image?: string
  video?: string
}

export interface CanvasDocumentState {
  name: string
  mediaGroups: CanvasMediaGroups
  nodes: EditorNodeRecord[]
  edges: EditorEdgeRecord[]
  viewport: CanvasViewport
  revision: number
}

export interface CanvasGraphIndex {
  nodesById: ReadonlyMap<string, EditorNodeRecord>
  outgoing: ReadonlyMap<string, ReadonlySet<string>>
  incoming: ReadonlyMap<string, ReadonlySet<string>>
}

export function createCanvasDocument(name = '未命名工作流'): CanvasDocumentState {
  return { name, mediaGroups: {}, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, revision: 0 }
}

export function buildCanvasGraphIndex(document: CanvasDocumentState): CanvasGraphIndex {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()
  for (const edge of document.edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue
    const targets = outgoing.get(edge.source) ?? new Set<string>()
    targets.add(edge.target)
    outgoing.set(edge.source, targets)
    const sources = incoming.get(edge.target) ?? new Set<string>()
    sources.add(edge.source)
    incoming.set(edge.target, sources)
  }
  return { nodesById, outgoing, incoming }
}

export function collectDownstreamNodeIds(document: CanvasDocumentState, starts: readonly string[]): Set<string> {
  const { outgoing } = buildCanvasGraphIndex(document)
  const result = new Set<string>()
  const queue = [...starts]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const target of outgoing.get(current) ?? []) {
      if (result.has(target)) continue
      result.add(target)
      queue.push(target)
    }
  }
  return result
}

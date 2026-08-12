import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'

export interface AutoLayoutOptions {
  nodeIds?: ReadonlySet<string>
  parentId?: string
  origin?: { x: number; y: number }
  horizontalGap?: number
  verticalGap?: number
}

function nodeWidth(node: EditorNodeRecord): number {
  return node.width ?? 240
}

function nodeHeight(node: EditorNodeRecord): number {
  return node.height ?? 160
}

/** Deterministic left-to-right layered layout with no external runtime dependency. */
export function autoLayoutCanvasNodes(
  nodes: readonly EditorNodeRecord[],
  edges: readonly EditorEdgeRecord[],
  options: AutoLayoutOptions = {},
): EditorNodeRecord[] {
  const candidates = nodes
    .filter((node) => node.parentId === options.parentId && (!options.nodeIds || options.nodeIds.has(node.id)))
    .sort((left, right) => left.id.localeCompare(right.id))
  const candidateIds = new Set(candidates.map((node) => node.id))
  const incoming = new Map(candidates.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (!candidateIds.has(edge.source) || !candidateIds.has(edge.target)) continue
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    const targets = outgoing.get(edge.source) ?? []
    targets.push(edge.target)
    targets.sort((left, right) => left.localeCompare(right))
    outgoing.set(edge.source, targets)
  }
  const queue = candidates.filter((node) => incoming.get(node.id) === 0).map((node) => node.id)
  const rank = new Map<string, number>(queue.map((id) => [id, 0]))
  const visited = new Set<string>()
  while (queue.length > 0) {
    queue.sort((left, right) => left.localeCompare(right))
    const id = queue.shift() as string
    if (visited.has(id)) continue
    visited.add(id)
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1))
      const remaining = (incoming.get(target) ?? 0) - 1
      incoming.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }
  // Invalid cyclic remnants are placed in a stable final rank instead of looping.
  const finalRank = Math.max(0, ...rank.values()) + 1
  for (const node of candidates) if (!rank.has(node.id)) rank.set(node.id, finalRank)

  const byRank = new Map<number, EditorNodeRecord[]>()
  for (const node of candidates) {
    const column = byRank.get(rank.get(node.id) as number) ?? []
    column.push(node)
    byRank.set(rank.get(node.id) as number, column)
  }
  const origin = options.origin ?? { x: 80, y: 80 }
  const horizontalGap = options.horizontalGap ?? 100
  const verticalGap = options.verticalGap ?? 52
  const positions = new Map<string, { x: number; y: number }>()
  let x = origin.x
  for (const columnIndex of [...byRank.keys()].sort((left, right) => left - right)) {
    const column = byRank.get(columnIndex) as EditorNodeRecord[]
    let y = origin.y
    let columnWidth = 0
    for (const node of column) {
      if (!node.locked) positions.set(node.id, { x, y })
      y += nodeHeight(node) + verticalGap
      columnWidth = Math.max(columnWidth, nodeWidth(node))
    }
    x += columnWidth + horizontalGap
  }
  return nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id) as { x: number; y: number } } : structuredClone(node))
}

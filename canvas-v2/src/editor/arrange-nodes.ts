import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { autoLayoutCanvasNodes } from './auto-layout'
import { validateParentGraph } from './grouping'

export type CanvasArrangeMode = 'horizontal' | 'vertical' | 'smart'

/** Arrange peers in their own parent coordinates; groups move with children. */
export function arrangeCanvasNodes(nodes: readonly EditorNodeRecord[], edges: readonly EditorEdgeRecord[], mode: CanvasArrangeMode, selectedIds: readonly string[] = []): EditorNodeRecord[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  if (byId.size !== nodes.length || !validateParentGraph(nodes)) throw new Error('分组层级无效，请重新打开工程后再排列')
  const lineage = new Map(nodes.map((node) => {
    const ancestors: string[] = []
    let parentId = node.parentId
    while (parentId) { ancestors.push(parentId); parentId = byId.get(parentId)!.parentId }
    return [node.id, ancestors] as const
  }))
  // Moving a container moves its descendants in world coordinates. Protect
  // both sides of a lock, just as the cross-parent alignment command does.
  const protectedIds = new Set(nodes.filter((node) => node.locked).flatMap((node) => [node.id, ...lineage.get(node.id)!]))
  for (const node of nodes) if (lineage.get(node.id)!.some((id) => byId.get(id)!.locked)) protectedIds.add(node.id)
  const selected = new Set(selectedIds)
  const candidates = nodes.filter((node) => selected.size ? selected.has(node.id) && !hasSelectedAncestor(node, nodes, selected) : !node.parentId)
  const parents = new Set(candidates.map((node) => node.parentId))
  let result = nodes.map((node) => structuredClone(node))
  for (const parentId of parents) {
    const peers = candidates.filter((node) => node.parentId === parentId).sort((a, b) => mode === 'vertical' ? a.position.y - b.position.y || a.position.x - b.position.x : a.position.x - b.position.x || a.position.y - b.position.y)
    if (peers.length < 2) continue
    if (peers.some((node) => lineage.get(node.id)!.some((id) => byId.get(id)!.locked))) throw new Error('无法排列锁定分组内部，请先解锁分组；本次未改变任何节点')
    const origin = { x: Math.max(parentId ? 32 : -Infinity, Math.min(...peers.map((node) => node.position.x))), y: Math.max(parentId ? 96 : -Infinity, Math.min(...peers.map((node) => node.position.y))) }
    const movableIds = new Set(peers.filter((node) => !protectedIds.has(node.id)).map((node) => node.id))
    const obstacles = nodes.filter((node) => node.parentId === parentId && !movableIds.has(node.id)).map((node) => structuredClone(node))
    if (mode === 'smart') {
      result = autoLayoutCanvasNodes(result, edges, { parentId, nodeIds: movableIds, origin })
      result = result.map((node) => {
        if (!movableIds.has(node.id)) return node
        const placed = { ...node, position: clearPosition(node, node.position, obstacles, 'vertical') }
        obstacles.push(placed)
        return placed
      })
      continue
    }
    let cursor = mode === 'horizontal' ? origin.x : origin.y
    const positions = new Map<string, { x: number; y: number }>()
    for (const node of peers) {
      const size = mode === 'horizontal' ? node.width ?? 280 : node.height ?? 220
      if (!movableIds.has(node.id)) continue
      const position = clearPosition(node, mode === 'horizontal' ? { x: cursor, y: origin.y } : { x: origin.x, y: cursor }, obstacles, mode)
      positions.set(node.id, position)
      obstacles.push({ ...node, position })
      cursor = (mode === 'horizontal' ? position.x : position.y) + size + 80
    }
    result = result.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node)
  }
  const arranged = expandArrangedParents(result, candidates)
  for (const node of arranged) {
    const original = byId.get(node.id)!
    if (node.position.x === original.position.x && node.position.y === original.position.y && node.width === original.width && node.height === original.height) continue
    if (node.locked || lineage.get(node.id)!.some((id) => byId.get(id)!.locked)) throw new Error('排列需要改变锁定分组内部，请先解锁后重试；本次未改变任何节点')
  }
  return arranged
}

function expandArrangedParents(nodes: EditorNodeRecord[], candidates: readonly EditorNodeRecord[]): EditorNodeRecord[] {
  const parents = new Set<string>()
  for (const candidate of candidates) {
    const visited = new Set([candidate.id])
    let id = candidate.parentId
    while (id && !visited.has(id)) {
      parents.add(id)
      visited.add(id)
      id = nodes.find((node) => node.id === id)?.parentId
    }
  }
  const byDepth = [...parents].sort((a, b) => parentDepth(b, nodes) - parentDepth(a, nodes))
  let result = nodes
  for (const id of byDepth) {
    const parent = result.find((node) => node.id === id)
    const children = result.filter((node) => node.parentId === id)
    if (!parent || !children.length) continue
    const width = Math.max(parent.width ?? 560, ...children.map((node) => node.position.x + (node.width ?? 280) + 32))
    const height = Math.max(parent.height ?? 360, ...children.map((node) => node.position.y + (node.height ?? 220) + 32))
    if (width === parent.width && height === parent.height) continue
    if (parent.locked) throw new Error('排列后的内容超出锁定分组，请先解锁分组再排列')
    result = result.map((node) => node.id === id ? { ...node, width, height } : node)
  }
  return result
}

function parentDepth(id: string, nodes: readonly EditorNodeRecord[]): number {
  const visited = new Set<string>()
  let current: string | undefined = id
  while (current && !visited.has(current)) { visited.add(current); current = nodes.find((node) => node.id === current)?.parentId }
  return visited.size
}

function clearPosition(node: EditorNodeRecord, initial: { x: number; y: number }, obstacles: readonly EditorNodeRecord[], axis: 'horizontal' | 'vertical'): { x: number; y: number } {
  const position = { ...initial }
  const width = node.width ?? 280
  const height = node.height ?? 220
  for (let attempt = 0; attempt <= obstacles.length; attempt += 1) {
    const hit = obstacles.find((other) => position.x < other.position.x + (other.width ?? 280) + 24 && position.x + width + 24 > other.position.x && position.y < other.position.y + (other.height ?? 220) + 24 && position.y + height + 24 > other.position.y)
    if (!hit) break
    if (axis === 'horizontal') position.x = hit.position.x + (hit.width ?? 280) + 80
    else position.y = hit.position.y + (hit.height ?? 220) + 80
  }
  return position
}

function hasSelectedAncestor(node: EditorNodeRecord, nodes: readonly EditorNodeRecord[], selected: ReadonlySet<string>): boolean {
  const visited = new Set([node.id])
  let parent = node.parentId
  while (parent && !visited.has(parent)) {
    if (selected.has(parent)) return true
    visited.add(parent)
    parent = nodes.find((entry) => entry.id === parent)?.parentId
  }
  return false
}

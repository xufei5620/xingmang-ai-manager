import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { autoLayoutCanvasNodes } from './auto-layout'

function ancestors(node: EditorNodeRecord, nodes: ReadonlyMap<string, EditorNodeRecord>): string[] {
  const ids: string[] = []
  const visited = new Set([node.id])
  let parentId = node.parentId
  while (parentId) {
    if (visited.has(parentId)) throw new Error('分组层级存在循环，请先修复分组关系')
    visited.add(parentId)
    const parent = nodes.get(parentId)
    if (!parent || parent.type !== 'group') throw new Error('分组层级不完整，请重新打开工程后再整理')
    ids.push(parentId)
    parentId = parent.parentId
  }
  return ids
}

function overlaps(left: EditorNodeRecord, right: EditorNodeRecord): boolean {
  return left.position.x < right.position.x + (right.width ?? 280) + 24
    && left.position.x + (left.width ?? 280) + 24 > right.position.x
    && left.position.y < right.position.y + (right.height ?? 220) + 24
    && left.position.y + (left.height ?? 220) + 24 > right.position.y
}

function placeBelowObstacles(node: EditorNodeRecord, obstacles: readonly EditorNodeRecord[]): EditorNodeRecord {
  const placed = { ...node, position: { ...node.position } }
  // Each collision moves below one rectangle; y only increases, so an
  // obstacle already passed can never collide again.
  for (let attempt = 0; attempt <= obstacles.length; attempt += 1) {
    const hit = obstacles.find((other) => overlaps(placed, other))
    if (!hit) return placed
    if (node.locked) throw new Error('整理需要移动锁定分组，请先解锁后重试')
    placed.position.y = hit.position.y + (hit.height ?? 220) + 80
  }
  throw new Error('无法为分组找到可用位置，请先调整或解锁附近节点')
}

function geometryChanged(before: EditorNodeRecord, after: EditorNodeRecord): boolean {
  return before.position.x !== after.position.x || before.position.y !== after.position.y || before.width !== after.width || before.height !== after.height
}

/** Explicitly organize group contents. Ordinary arrange keeps its peer-only semantics. */
export function organizeCanvasGroupContents(nodes: readonly EditorNodeRecord[], edges: readonly EditorEdgeRecord[], selectedGroupIds: readonly string[] = []): EditorNodeRecord[] {
  const originals = new Map(nodes.map((node) => [node.id, node]))
  const lineage = new Map(nodes.map((node) => [node.id, ancestors(node, originals)]))
  const selected = new Set(selectedGroupIds)
  if ([...selected].some((id) => originals.get(id)?.type !== 'group')) throw new Error('请选择有效分组后再整理内部')
  const targets = new Set(nodes.filter((node) => node.type === 'group' && (!selected.size || selected.has(node.id) || lineage.get(node.id)!.some((id) => selected.has(id)))).map((node) => node.id))
  if (!targets.size) return nodes.map((node) => structuredClone(node))
  const containers = new Set([...targets].flatMap((id) => [id, ...lineage.get(id)!]))
  const ordered = [...containers].sort((a, b) => lineage.get(b)!.length - lineage.get(a)!.length || a.localeCompare(b))
  let result = nodes.map((node) => structuredClone(node))
  const expanded = new Set<string>()

  function avoidExpandedSiblings(parentId?: string) {
    const peers = result.filter((node) => node.parentId === parentId)
    const changing = peers.filter((node) => expanded.has(node.id)).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id))
    const obstacles = peers.filter((node) => !expanded.has(node.id))
    const replacements = new Map<string, EditorNodeRecord>()
    for (const node of changing) {
      const initial = parentId ? { ...node, position: { x: Math.max(32, node.position.x), y: Math.max(96, node.position.y) } } : node
      const placed = placeBelowObstacles(initial, obstacles)
      replacements.set(node.id, placed)
      obstacles.push(placed)
    }
    result = result.map((node) => replacements.get(node.id) ?? node)
  }

  // Children are laid out before their parent. The next level therefore sees
  // final group sizes, never the stale rectangle imported with a template.
  for (const id of ordered) {
    if (targets.has(id)) {
      const children = result.filter((node) => node.parentId === id)
      const locked = children.filter((node) => node.locked)
      if (locked.some((node, index) => locked.slice(index + 1).some((other) => overlaps(node, other)))) throw new Error('分组内的锁定节点互相重叠或间距不足，请先解锁后再整理')
      result = autoLayoutCanvasNodes(result, edges, { parentId: id, origin: { x: 32, y: 96 } })
      const obstacles = [...locked]
      result = result.map((node) => {
        if (node.parentId !== id || node.locked) return node
        const placed = placeBelowObstacles(node, obstacles)
        obstacles.push(placed)
        return placed
      })
    } else avoidExpandedSiblings(id)
    const group = result.find((node) => node.id === id)!
    const children = result.filter((node) => node.parentId === id)
    if (!children.length) continue
    if (targets.has(id) && children.some((node) => node.position.x < 32 || node.position.y < 96)) throw new Error('分组内的锁定节点占用了标题或边距，请先解锁后再整理')
    const width = Math.max(group.width ?? 560, ...children.map((node) => node.position.x + (node.width ?? 280) + 32))
    const height = Math.max(group.height ?? 360, ...children.map((node) => node.position.y + (node.height ?? 220) + 32))
    if (width !== group.width || height !== group.height) {
      if (group.locked) throw new Error('整理需要扩展锁定分组，请先解锁后重试')
      expanded.add(id)
      result = result.map((node) => node.id === id ? { ...node, width, height } : node)
    }
  }
  avoidExpandedSiblings()
  // Locking a group also protects its internal layout for this explicit
  // operation. Reject the whole proposal, never a partially arranged graph.
  const resultById = new Map(result.map((node) => [node.id, node]))
  for (const node of result) {
    const original = originals.get(node.id)!
    if (node.locked) {
      const before = lineage.get(node.id)!.reduce((position, id) => ({ x: position.x + originals.get(id)!.position.x, y: position.y + originals.get(id)!.position.y }), { ...original.position })
      const after = lineage.get(node.id)!.reduce((position, id) => ({ x: position.x + resultById.get(id)!.position.x, y: position.y + resultById.get(id)!.position.y }), { ...node.position })
      // A stationary local coordinate is not stationary on the canvas when an
      // expanded ancestor is moved aside to avoid an external obstacle.
      if (before.x !== after.x || before.y !== after.y) throw new Error('整理需要移动包含锁定节点的分组，请先解锁后重试')
    }
    if (!geometryChanged(original, node)) continue
    if (node.locked || lineage.get(node.id)!.some((id) => originals.get(id)?.locked)) throw new Error('整理会改变锁定节点或锁定分组内部，请先解锁后重试')
  }
  return result
}

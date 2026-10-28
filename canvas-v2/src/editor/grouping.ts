import type { EditorNodeRecord } from '../domain/node-definition'
import { maximumCoordinateMagnitude } from '../persistence/workflow-schema'

export interface GroupNodesOptions {
  groupId: string
  title?: string
  padding?: number
}

function nodeWidth(node: EditorNodeRecord): number {
  return node.width ?? 240
}

function nodeHeight(node: EditorNodeRecord): number {
  return node.height ?? 160
}

function parentOfSelection(nodes: readonly EditorNodeRecord[]): string | undefined | null {
  const parents = new Set(nodes.map((node) => node.parentId))
  return parents.size === 1 ? nodes[0]?.parentId : null
}

/** Preserve world positions while making room for every nested group header.
 * Moving a frame left/up is compensated on all of its direct children, then
 * propagated to its parent. Callers commit the complete result only once.
 */
function expandGroupingAncestors(nodes: EditorNodeRecord[], parentId: string | undefined): EditorNodeRecord[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let currentId = parentId
  while (currentId) {
    const parent = byId.get(currentId)!
    const children = nodes.filter((node) => node.parentId === currentId)
    const shiftX = Math.min(0, ...children.map((node) => node.position.x - 32))
    const shiftY = Math.min(0, ...children.map((node) => node.position.y - 96))
    const width = Math.max(nodeWidth(parent), ...children.map((node) => node.position.x + nodeWidth(node) + 32)) - shiftX
    const height = Math.max(nodeHeight(parent), ...children.map((node) => node.position.y + nodeHeight(node) + 32)) - shiftY
    if (shiftX || shiftY || width !== nodeWidth(parent) || height !== nodeHeight(parent)) {
      let ancestor: EditorNodeRecord | undefined = parent
      while (ancestor) {
        if (ancestor.locked) throw new Error('嵌套编组需要扩展锁定分组，请先解锁后重试；本次未改变任何节点')
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined
      }
      parent.position = { x: parent.position.x + shiftX, y: parent.position.y + shiftY }
      parent.width = width
      parent.height = height
      for (const child of children) child.position = { x: child.position.x - shiftX, y: child.position.y - shiftY }
    }
    currentId = parent.parentId
  }
  if (nodes.some((node) => !Number.isFinite(nodeWidth(node)) || !Number.isFinite(nodeHeight(node)) || Math.abs(node.position.x) > maximumCoordinateMagnitude || Math.abs(node.position.y) > maximumCoordinateMagnitude)) throw new Error('编组后的边界范围过大，请先缩小节点间距；本次未改变任何节点')
  return nodes
}

export function groupCanvasNodes(
  nodes: readonly EditorNodeRecord[],
  selectedNodeIds: ReadonlySet<string>,
  options: GroupNodesOptions,
): EditorNodeRecord[] | null {
  const selected = nodes.filter((node) => selectedNodeIds.has(node.id))
  if (selected.length < 2 || nodes.some((node) => node.id === options.groupId)) return null
  if (!validateParentGraph(nodes)) return null
  const commonParent = parentOfSelection(selected)
  if (commonParent === null) return null
  const padding = options.padding ?? 32
  const left = Math.min(...selected.map((node) => node.position.x))
  const top = Math.min(...selected.map((node) => node.position.y))
  const right = Math.max(...selected.map((node) => node.position.x + nodeWidth(node)))
  const bottom = Math.max(...selected.map((node) => node.position.y + nodeHeight(node)))
  // The group header has a title row and editable name/selection controls.
  // Keep content below both rows instead of using symmetric 32px padding.
  const topPadding = padding + 64
  const groupPosition = { x: left - padding, y: top - topPadding }
  const group: EditorNodeRecord = {
    id: options.groupId,
    type: 'group',
    definitionVersion: 1,
    position: groupPosition,
    data: { title: options.title ?? '新建分组' },
    width: right - left + padding * 2,
    height: bottom - top + topPadding + padding,
    ...(commonParent ? { parentId: commonParent } : {}),
  }
  const result = [
    group,
    ...nodes.map((node) => selectedNodeIds.has(node.id)
      ? {
          ...node,
          parentId: options.groupId,
          position: { x: node.position.x - groupPosition.x, y: node.position.y - groupPosition.y },
        }
      : structuredClone(node)),
  ]
  if (!validateParentGraph(result)) return null
  return expandGroupingAncestors(result, commonParent)
}

export function ungroupCanvasNode(nodes: readonly EditorNodeRecord[], groupId: string): EditorNodeRecord[] | null {
  const group = nodes.find((node) => node.id === groupId && node.type === 'group')
  if (!group) return null
  return nodes
    .filter((node) => node.id !== groupId)
    .map((node) => node.parentId === groupId
      ? {
          ...node,
          position: { x: group.position.x + node.position.x, y: group.position.y + node.position.y },
          ...(group.parentId ? { parentId: group.parentId } : { parentId: undefined }),
        }
      : structuredClone(node))
}

export function validateParentGraph(nodes: readonly EditorNodeRecord[], maximumDepth = 8): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    const seen = new Set([node.id])
    let current = node
    let depth = 0
    while (current.parentId) {
      const parent = byId.get(current.parentId)
      if (!parent || parent.type !== 'group' || seen.has(parent.id)) return false
      seen.add(parent.id)
      current = parent
      depth += 1
      if (depth > maximumDepth) return false
    }
  }
  return true
}

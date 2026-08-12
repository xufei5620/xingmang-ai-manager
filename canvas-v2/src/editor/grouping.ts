import type { EditorNodeRecord } from '../domain/node-definition'

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

export function groupCanvasNodes(
  nodes: readonly EditorNodeRecord[],
  selectedNodeIds: ReadonlySet<string>,
  options: GroupNodesOptions,
): EditorNodeRecord[] | null {
  const selected = nodes.filter((node) => selectedNodeIds.has(node.id))
  if (selected.length < 2 || nodes.some((node) => node.id === options.groupId)) return null
  const commonParent = parentOfSelection(selected)
  if (commonParent === null) return null
  const padding = options.padding ?? 32
  const left = Math.min(...selected.map((node) => node.position.x))
  const top = Math.min(...selected.map((node) => node.position.y))
  const right = Math.max(...selected.map((node) => node.position.x + nodeWidth(node)))
  const bottom = Math.max(...selected.map((node) => node.position.y + nodeHeight(node)))
  const groupPosition = { x: left - padding, y: top - padding }
  const group: EditorNodeRecord = {
    id: options.groupId,
    type: 'group',
    definitionVersion: 1,
    position: groupPosition,
    data: { title: options.title ?? '新建分组' },
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
    ...(commonParent ? { parentId: commonParent } : {}),
  }
  return [
    group,
    ...nodes.map((node) => selectedNodeIds.has(node.id)
      ? {
          ...node,
          parentId: options.groupId,
          position: { x: node.position.x - groupPosition.x, y: node.position.y - groupPosition.y },
        }
      : structuredClone(node)),
  ]
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

import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { WorkflowFile, WorkflowNode } from '../model'

export interface ProjectHistoryPreviewNode {
  id: string
  title: string
  typeTitle: string
  x: number
  y: number
  width: number
  height: number
  group: boolean
}

/** Render stored positions, including nested groups, without mounting an editor. */
export function buildProjectHistoryPreview(workflow: WorkflowFile) {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
  const positions = new Map<string, { x: number; y: number }>()
  for (const node of workflow.nodes) {
    if (positions.has(node.id)) continue
    const chain: WorkflowNode[] = [], seen = new Set<string>()
    let entry: WorkflowNode | undefined = node
    while (entry && !positions.has(entry.id) && !seen.has(entry.id)) {
      chain.push(entry); seen.add(entry.id)
      const parent: WorkflowNode | undefined = entry.parentId ? byId.get(entry.parentId) : undefined
      entry = parent?.kind === 'group' ? parent : undefined
    }
    let origin = entry && positions.get(entry.id) || { x: 0, y: 0 }
    for (const child of chain.reverse()) {
      origin = { x: origin.x + child.position.x, y: origin.y + child.position.y }
      positions.set(child.id, origin)
    }
  }
  const all: ProjectHistoryPreviewNode[] = workflow.nodes.map((node) => {
    const definition = builtinNodeRegistry.resolve(node.kind)
    const label = node.data.settings?.title
    return {
      id: node.id, title: typeof label === 'string' && label.trim() ? label.trim() : definition?.title ?? '未知节点',
      typeTitle: definition?.title ?? node.kind, ...positions.get(node.id)!,
      width: node.width && node.width > 0 ? node.width : definition?.dimensions.width ?? 280,
      height: node.height && node.height > 0 ? node.height : definition?.dimensions.height ?? 180,
      group: node.kind === 'group',
    }
  })
  const nodes = all.slice(0, 2000).sort((a, b) => Number(b.group) - Number(a.group))
  const rendered = new Map(nodes.map((node) => [node.id, node]))
  const edges = workflow.edges.slice(0, 4000).flatMap((edge) => {
    const source = rendered.get(edge.source), target = rendered.get(edge.target)
    return source && target ? [{ id: edge.id, x1: source.x + source.width, y1: source.y + source.height / 2, x2: target.x, y2: target.y + target.height / 2 }] : []
  })
  const left = all.length ? Math.min(...all.map((node) => node.x)) : 0
  const top = all.length ? Math.min(...all.map((node) => node.y)) : 0
  const right = all.length ? Math.max(...all.map((node) => node.x + node.width)) : 640
  const bottom = all.length ? Math.max(...all.map((node) => node.y + node.height)) : 360
  return { nodes, edges, viewBox: `${left - 60} ${top - 60} ${right - left + 120} ${bottom - top + 120}`, truncated: nodes.length < all.length || workflow.edges.length > 4000 }
}

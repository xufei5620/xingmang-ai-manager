import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'

export interface AltDragDuplicateOptions {
  nodeIds: readonly string[]
  preserveInputConnections: boolean
  createNodeId(sourceId: string): string
  createEdgeId(sourceId: string): string
}

/** Builds the copied half of an Alt-drag gesture at caller-provided positions. */
export function duplicateCanvasNodesForAltDrag(
  nodes: readonly EditorNodeRecord[],
  edges: readonly EditorEdgeRecord[],
  options: AltDragDuplicateOptions,
): { nodes: EditorNodeRecord[]; edges: EditorEdgeRecord[] } {
  const requested = new Set(options.nodeIds)
  if (requested.size === 0) return { nodes: [], edges: [] }

  // A selected group carries all descendants so the stationary copy remains a
  // valid hierarchy even when React Flow reports only the group as selected.
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (!node.parentId || requested.has(node.id) || !requested.has(node.parentId)) continue
      requested.add(node.id)
      changed = true
    }
  }

  const sourceNodes = nodes.filter((node) => requested.has(node.id))
  const nodeIds = new Map(sourceNodes.map((node) => [node.id, options.createNodeId(node.id)]))
  if (new Set(nodeIds.values()).size !== nodeIds.size) throw new Error('Alt 拖动复制节点标识冲突')

  const duplicatedNodes = sourceNodes.map((node) => {
    const copy = structuredClone(node)
    delete copy.selected
    return {
      ...copy,
      id: nodeIds.get(node.id) as string,
      ...(node.parentId
        ? { parentId: nodeIds.get(node.parentId) ?? node.parentId }
        : { parentId: undefined }),
    }
  })

  const duplicatedEdges = edges.flatMap((edge) => {
    const sourceCopied = nodeIds.has(edge.source)
    const targetCopied = nodeIds.has(edge.target)
    const internal = sourceCopied && targetCopied
    const retainedInput = options.preserveInputConnections && !sourceCopied && targetCopied
    if (!internal && !retainedInput) return []
    return [{
      ...edge,
      id: options.createEdgeId(edge.id),
      source: nodeIds.get(edge.source) ?? edge.source,
      target: nodeIds.get(edge.target) ?? edge.target,
      selected: undefined,
    }]
  })
  if (new Set(duplicatedEdges.map((edge) => edge.id)).size !== duplicatedEdges.length) {
    throw new Error('Alt 拖动复制连线标识冲突')
  }
  return { nodes: duplicatedNodes, edges: duplicatedEdges }
}

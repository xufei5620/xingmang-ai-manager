import { remapImageReferenceOrderSettings } from '../commerce/image-reference-order'
import { remapVideoReferenceOrderSettings } from '../video-tools/video-reference-order'
import { remapCollageInputOrderSettings } from '../image-tools/collage-input-order'
import { remapTileInputSettings } from '../image-tools/tile-input'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { markCopiedInputsChanged } from './copied-inputs'
import { remapImageCompareNodeSettings } from '../image-tools/viewer-settings'

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

  const sourceNodes = nodes.filter((node) => requested.has(node.id)).map((node) => structuredClone(node))
  if (!options.preserveInputConnections) markCopiedInputsChanged(sourceNodes, edges, requested)
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

  const edgeIds = new Map<string, string>()
  const duplicatedEdges = edges.flatMap((edge) => {
    const sourceCopied = nodeIds.has(edge.source)
    const targetCopied = nodeIds.has(edge.target)
    const internal = sourceCopied && targetCopied
    const retainedInput = options.preserveInputConnections && !sourceCopied && targetCopied
    if (!internal && !retainedInput) return []
    const id = options.createEdgeId(edge.id)
    edgeIds.set(edge.id, id)
    return [{
      ...edge,
      id,
      source: nodeIds.get(edge.source) ?? edge.source,
      target: nodeIds.get(edge.target) ?? edge.target,
      selected: undefined,
    }]
  })
  if (new Set(duplicatedEdges.map((edge) => edge.id)).size !== duplicatedEdges.length) {
    throw new Error('Alt 拖动复制连线标识冲突')
  }
  for (const node of duplicatedNodes) if (node.type === 'image-compare' && node.data.settings !== undefined) {
    node.data.settings = remapImageCompareNodeSettings(node.data.settings, edgeIds)
  }
  for (const node of duplicatedNodes) if (node.type === 'image-collage') node.data.settings = remapCollageInputOrderSettings(node.data.settings, edgeIds)
  for (const [index, node] of duplicatedNodes.entries()) if (node.type === 'image-tile') {
    const sourceId = sourceNodes[index].id
    const incoming = edges.filter((edge) => edge.target === sourceId && edge.targetHandle === 'in:image')
    node.data.settings = remapTileInputSettings(node.data.settings, new Map(incoming.flatMap((edge) => edgeIds.has(edge.id) ? [[edge.id, edgeIds.get(edge.id)!] as const] : [])), incoming[0]?.id)
  }
  for (const node of duplicatedNodes) node.data.settings = remapImageReferenceOrderSettings(node.data.settings, edgeIds)
  for (const node of duplicatedNodes) if ((node.type === 'video' || node.type === 'video-generate')) node.data.settings = remapVideoReferenceOrderSettings(node.data.settings, edgeIds)
  return { nodes: duplicatedNodes, edges: duplicatedEdges }
}

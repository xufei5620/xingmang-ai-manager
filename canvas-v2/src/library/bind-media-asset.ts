import type { Edge } from '@xyflow/react'
import type { CanvasAssetSummary } from '../host'
import type { AssetRef } from '../model'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { mediaAssetNodeDimensions } from './media-assets'

export type CanvasMediaAssetBinding =
  | { status: 'bound'; nodes: CanvasNode[]; downstreamNodeIds: string[] }
  | { status: 'missing-target' }
  | { status: 'type-mismatch' }

/** The caller supplies the graph at completion, never the upload's old graph. */
export function buildCanvasMediaAssetBinding(
  nodes: readonly CanvasNode[],
  edges: readonly Pick<Edge, 'source' | 'target'>[],
  nodeId: string,
  asset: CanvasAssetSummary,
): CanvasMediaAssetBinding {
  const target = nodes.find((node) => node.id === nodeId)
  if (!target) return { status: 'missing-target' }
  const expectedMediaType = target.type === 'image-input' ? 'image'
    : target.type === 'video-input' ? 'video'
      : target.type === 'audio-input' ? 'audio' : null
  if (!expectedMediaType || asset.mediaType !== expectedMediaType) return { status: 'type-mismatch' }
  const existingNodeIds = new Set(nodes.map((node) => node.id))
  const descendants = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const source = queue.shift()
    for (const edge of edges) {
      if (edge.source !== source || edge.target === nodeId || descendants.has(edge.target) || !existingNodeIds.has(edge.target)) continue
      descendants.add(edge.target)
      queue.push(edge.target)
    }
  }
  const dimensions = mediaAssetNodeDimensions(asset)
  const result: AssetRef = {
    kind: asset.mediaType, assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType,
    ...('width' in asset && asset.width ? { width: asset.width } : {}),
    ...('height' in asset && asset.height ? { height: asset.height } : {}),
    ...('durationSeconds' in asset && asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}),
    ...('taskId' in asset && asset.taskId ? { taskId: asset.taskId } : {}),
  }
  return {
    status: 'bound',
    downstreamNodeIds: [...descendants],
    nodes: nodes.map((node) => node.id === nodeId ? {
      ...node, width: dimensions.width, height: dimensions.height,
      style: { ...node.style, width: dimensions.width, height: dimensions.height },
      data: { ...node.data, result, status: 'succeeded', dirty: false, errorMessage: undefined },
    } : descendants.has(node.id) ? { ...node, data: { ...node.data, dirty: true } } : node),
  }
}

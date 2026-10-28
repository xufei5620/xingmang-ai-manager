import type { WorkflowNode } from '../model'
import { mediaAssetNodeDimensions, pendingMediaNodeDimensions } from '../library/media-assets'
import { usesMediaBoundLayout } from '../nodes/media-bound'
import { builtinNodeRegistry } from './builtin-node-definitions'

/** The editor and reviewed proposals must agree on implicit node dimensions. */
export function canvasNodeDisplayGeometry(node: WorkflowNode): { width?: number; height?: number } {
  const kind = node.disabled && node.unknownKind ? 'unknown' : node.kind
  const dimensions = builtinNodeRegistry.resolve(kind)?.dimensions
  const mediaBound = usesMediaBoundLayout(kind, node.data.result?.assetId)
  const media = mediaBound ? node.data.result ? mediaAssetNodeDimensions(node.data.result, node.data.size) : pendingMediaNodeDimensions(kind, node.data.size) : null
  return { width: media?.width ?? node.width ?? dimensions?.width, height: mediaBound || kind === 'group' ? media?.height ?? node.height ?? dimensions?.height : undefined }
}

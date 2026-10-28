import type { CanvasRunGraph } from '../host'
import { canvasMediaInputSlots } from '../runtime/image-input-cardinality'
import { assertVideoReferenceSlots, orderVideoReferences, type VideoReferenceIdentity } from './video-reference-order'

export interface CanvasVideoReferenceSlot extends VideoReferenceIdentity { kind: 'image' | 'audio' | 'video' }
export interface CanvasVideoInputSummary { imageCount: number; audioCount: number; videoCount: number; exact: boolean; slots: CanvasVideoReferenceSlot[] }

/** Static grid output cardinality is authoritative even before its first run.
 * Previous candidates never prove the size of a future unknown batch. */
export function inspectCanvasVideoInputs(node: CanvasRunGraph['nodes'][number], edges: readonly CanvasRunGraph['edges'][number][], nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>): CanvasVideoInputSummary {
  const slots: CanvasVideoReferenceSlot[] = []
  const legacySeen = new Set<string>()
  let exact = true
  for (const edge of edges.filter((edge) => edge.target === node.id)) {
    const kind = edge.sourceHandle === 'out:images' || edge.sourceHandle === 'out:image' ? 'image' : edge.sourceHandle === 'out:audio' ? 'audio' : edge.sourceHandle === 'out:video' ? 'video' : null
    if (!kind) continue
    const source = nodes.get(edge.source)
    const estimate = canvasMediaInputSlots(kind, edge, nodes, edges)
    const count = estimate.identities.length
    exact &&= estimate.exact
    for (let outputIndex = 0; outputIndex < count; outputIndex++) {
      // Existing run snapshots used asset deduplication; retain that behavior
      // until an explicit v1 order declares independent reference slots.
      const legacyKey = !(source?.kind === 'router' && Object.hasOwn(source.data, 'routerStrategy')) && source?.data.adoptedAssetId && edge.sourceHandle !== 'out:images' ? JSON.stringify(['asset', source.data.adoptedAssetId]) : estimate.identities[outputIndex]
      if (!node.data.videoReferenceOrder && legacySeen.has(legacyKey)) continue
      legacySeen.add(legacyKey)
      slots.push({ edgeId: edge.id, outputIndex, kind })
    }
  }
  if (exact) assertVideoReferenceSlots(slots, node.data.videoReferenceOrder)
  else if (node.data.videoReferenceOrder?.slots.some((slot) => !edges.some((edge) => edge.target === node.id && edge.id === slot.edgeId))) throw new Error('已保存的视频参考连线缺失，请重新确认首尾帧与参考顺序')
  const ordered = orderVideoReferences(slots, node.data.videoReferenceOrder)
  return { imageCount: ordered.filter((slot) => slot.kind === 'image').length, audioCount: ordered.filter((slot) => slot.kind === 'audio').length, videoCount: ordered.filter((slot) => slot.kind === 'video').length, exact, slots: ordered }
}

export function assertCanvasVideoInputCardinality(summary: CanvasVideoInputSummary): void {
  if (!summary.exact) throw new Error('视频参考批次的展开数量尚未确认，请使用当前图片输出，或配置可确认格数的宫格输出；当前不会提交生成')
}

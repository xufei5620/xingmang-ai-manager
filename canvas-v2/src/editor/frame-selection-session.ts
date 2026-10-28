import type { WorkflowNodeData } from '../model'

interface FrameNode {
  id: string
  type?: string | null
  parentId?: string
  draggable?: boolean
  disabled?: boolean
  data: WorkflowNodeData
}
interface FrameEdge { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }
export interface FrameSelectionSnapshot { nodeId: string; edgeId: string; sourceNodeId: string; sourceAssetId: string; timestampSeconds: number }

/** Bind the editor to the actual video input, never a stale frame result. */
export function captureFrameSelection(nodes: readonly FrameNode[], edges: readonly FrameEdge[], nodeId: string): FrameSelectionSnapshot {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const target = byId.get(nodeId)
  if (!target || target.type !== 'frame-extract') throw new Error('抽帧节点已变化，请重新选择')
  let ancestor: FrameNode | undefined = target
  const seen = new Set<string>()
  while (ancestor) {
    if (seen.has(ancestor.id)) throw new Error('分组层级无效，请重新打开工程')
    seen.add(ancestor.id)
    if (ancestor.draggable === false || ancestor.disabled) throw new Error('抽帧节点或所在分组已锁定或禁用，请先解除后再选择视频帧')
    if (ancestor.parentId && !byId.has(ancestor.parentId)) throw new Error('抽帧节点的分组已变化，请重新打开工程')
    ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined
  }
  if (target.data.status === 'queued' || target.data.status === 'running') throw new Error('抽帧正在进行，请完成或停止后再选帧')
  const incoming = edges.filter((edge) => edge.target === nodeId && edge.targetHandle === 'in:video')
  if (incoming.length !== 1 || incoming[0].sourceHandle !== 'out:video') throw new Error('请连接唯一的视频输入后再选帧')
  const edge = incoming[0], source = byId.get(edge.source), asset = source?.data.result
  if (!source || asset?.kind !== 'video' || !asset.assetId || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId)) throw new Error('上游视频尚未就绪，请先上传视频或等待生成完成')
  if (source.data.status === 'queued' || source.data.status === 'running' || source.type !== 'video-input' && source.data.dirty) throw new Error('上游视频正在变化，请先完成上游再核对视频帧')
  const timestamp = target.data.settings?.timestampSeconds ?? 0
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0 || timestamp > 86_400) throw new Error('抽帧时间点无效，请先填写 0 到 86400 秒之间的数值')
  return { nodeId, edgeId: edge.id, sourceNodeId: source.id, sourceAssetId: asset.assetId, timestampSeconds: timestamp }
}

export function assertFrameSelection(nodes: readonly FrameNode[], edges: readonly FrameEdge[], snapshot: FrameSelectionSnapshot): void {
  const latest = captureFrameSelection(nodes, edges, snapshot.nodeId)
  if (latest.edgeId !== snapshot.edgeId || latest.sourceNodeId !== snapshot.sourceNodeId || latest.sourceAssetId !== snapshot.sourceAssetId || latest.timestampSeconds !== snapshot.timestampSeconds) throw new Error('视频来源或时间点已变化，请重新打开选帧；当前画布已保留')
}

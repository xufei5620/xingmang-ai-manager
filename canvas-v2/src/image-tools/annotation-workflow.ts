import type { CanvasImageAssetSummary } from '../host'
import type { AssetRef, WorkflowCandidateRef, WorkflowNodeData } from '../model'
import { downstreamNodeIds } from '../runtime/run-projection'

interface AnnotationNode { id: string; draggable?: boolean; data: WorkflowNodeData }
interface AnnotationEdge { source: string; target: string }

export function assertAnnotationTarget<T extends AnnotationNode>(nodes: readonly T[], nodeId: string, sourceAssetId?: string): T {
  const target = nodes.find((node) => node.id === nodeId)
  if (!target || target.draggable === false) throw new Error('原节点已删除或锁定，请重新选择图片')
  const asset = target.data.result
  if (asset?.kind !== 'image' || !asset.assetId || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || !asset.localUrl) throw new Error('请先选择一张已保存的图片')
  if (sourceAssetId && asset.assetId !== sourceAssetId) throw new Error('当前候选或底图已变化，请重新打开标注；原图和草稿仍保留')
  return target
}

/** Replace only the selected image in its batch. Original assets and run
 * receipts remain intact, and the document command provides one-step undo. */
export function replaceAnnotatedImage<T extends AnnotationNode>(nodes: readonly T[], edges: readonly AnnotationEdge[], nodeId: string, sourceAssetId: string, asset: CanvasImageAssetSummary): T[] {
  const target = assertAnnotationTarget(nodes, nodeId, sourceAssetId)
  if (asset.mediaType !== 'image' || asset.deletedAt || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || !asset.localUrl
    || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width! < 1 || asset.height! < 1) throw new Error('标注图片未完整保存，请重试')
  const result: AssetRef = { kind: 'image', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, width: asset.width, height: asset.height }
  const replacement: WorkflowCandidateRef = { candidateId: `document:${nodeId}:annotation:${asset.assetId}`, attemptId: `document:${nodeId}`, createdAt: asset.createdAt, asset: result }
  let candidates = target.data.candidates?.map((candidate) => candidate.asset.assetId === sourceAssetId
    ? { ...replacement, ...(candidate.outputIndex !== undefined ? { outputIndex: candidate.outputIndex } : {}) }
    : candidate)
  if (target.data.candidateAssetIds?.includes(sourceAssetId) && !candidates?.some((candidate) => candidate.asset.assetId === asset.assetId)) {
    candidates = [...(candidates ?? []), replacement]
  }
  const descendants = new Set(downstreamNodeIds([nodeId], edges))
  return nodes.map((node) => node.id === nodeId ? { ...node, data: {
    ...node.data, result, errorMessage: undefined, status: 'succeeded',
    // A manual edit is not a model receipt. Preserve ordering without claiming
    // that the PNG came from the original paid attempt.
    candidates, selectedCandidateId: undefined, adoptedCandidateId: undefined,
    candidateAssetIds: node.data.candidateAssetIds?.map((id) => id === sourceAssetId ? asset.assetId : id),
    fromCache: undefined,
  } } : descendants.has(node.id) ? { ...node, data: { ...node.data, dirty: true } } : node)
}

export function downloadAnnotationPng(blob: Blob): void {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  try {
    link.href = url; link.download = '星芒-图片标注.png'; link.style.display = 'none'
    document.body.appendChild(link); link.click()
  } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}

import type { WorkflowFile, WorkflowNode } from '../model'
import { CanvasAgentError, isCanvasAgentLibraryImageReference, parseCanvasAgentImageReferences, type CanvasAgentImageReference } from './canvas-agent-contract'

type ImageContextNode = Pick<WorkflowNode, 'kind' | 'data'>

export function canvasAgentNodeImageUnavailableReason(node: ImageContextNode): string | undefined {
  if (node.data.status === 'queued' || node.data.status === 'running') return '节点仍在运行，请等待完成后重新选择图片'
  if (node.data.dirty) return '节点结果待更新，请先运行或将上次成品另存为独立图片节点'
  if (node.data.result?.kind !== 'image' || !node.data.result.assetId || !/^[A-Za-z0-9_-]{43}$/.test(node.data.result.assetId)) return '此节点没有可引用的当前图片，请先导入或生成图片'
  return undefined
}

/** Never expands candidate pools or follows preview-only selections. */
export function resolveCanvasAgentNodeImageAssetId(node: ImageContextNode): string | undefined {
  return canvasAgentNodeImageUnavailableReason(node) ? undefined : node.data.result?.assetId
}

export function resolveCanvasAgentImageReferences(workflow: WorkflowFile, selectedNodeIds: readonly string[], value: unknown): CanvasAgentImageReference[] | undefined {
  const references = parseCanvasAgentImageReferences(value, selectedNodeIds)
  for (const reference of references ?? []) {
    if (isCanvasAgentLibraryImageReference(reference)) continue
    const node = workflow.nodes.find((item) => item.id === reference.nodeId)
    if (!node) throw new CanvasAgentError('引用图片的节点已删除，请重新选择上下文', 409)
    const reason = canvasAgentNodeImageUnavailableReason(node)
    if (reason) throw new CanvasAgentError(reason, 409)
    if (resolveCanvasAgentNodeImageAssetId(node) !== reference.assetId) throw new CanvasAgentError('节点当前图片已变化，请重新核对并选择图片；不会改用新的图片发送', 409)
  }
  return references
}

import type { CanvasRunScope } from '../host'

export interface PinnableCanvasNode {
  id: string
  data: {
    status?: string
    dirty?: boolean
    result?: { assetId?: string }
  }
}

/**
 * 已经固定在节点上、且用户没改过输入的产物。
 *
 * 下游单独跑的时候这些节点不该再付费生成：画面已经在那儿了。
 * 「运行到此」的目标节点除外——点它就是要重跑它自己。
 */
export function cachedNodeIdsForPreflight(
  nodes: readonly PinnableCanvasNode[],
  scope: CanvasRunScope,
): string[] {
  const reusable = nodes
    .filter((node) => (
      node.data.status === 'succeeded'
      && !node.data.dirty
      && Boolean(node.data.result?.assetId)
    ))
    .map((node) => node.id)
  if (scope.kind === 'to-node') return reusable.filter((id) => id !== scope.nodeId)
  return reusable
}

import { handleKind } from '../ports'

export interface BridgeableEdge {
  id: string
  source: string
  sourceHandle?: string | null
  target: string
  targetHandle?: string | null
}

export interface BridgeEdgeDraft {
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

/**
 * Edges that should be created to heal the graph when nodes are removed.
 *
 * Deleting a node in the middle of a chain normally leaves two dangling ends
 * and the user has to redraw the link by hand. Bridging only happens when the
 * media kind matches on both sides, so removing an image node from a text chain
 * never invents a connection that would not have been allowed.
 */
export function bridgeEdgesForRemoval(
  edges: readonly BridgeableEdge[],
  removedNodeIds: readonly string[],
): BridgeEdgeDraft[] {
  const removed = new Set(removedNodeIds)
  const survives = (edge: BridgeableEdge) => !removed.has(edge.source) && !removed.has(edge.target)
  const drafts: BridgeEdgeDraft[] = []
  const seen = new Set<string>()

  for (const nodeId of removed) {
    const incoming = edges.filter((edge) => edge.target === nodeId && !removed.has(edge.source))
    const outgoing = edges.filter((edge) => edge.source === nodeId && !removed.has(edge.target))
    for (const upstream of incoming) {
      for (const downstream of outgoing) {
        // Only heal a like-for-like pass-through. Anything else would be a
        // connection the user never drew and the ports may not accept.
        const kind = handleKind(upstream.sourceHandle)
        if (kind === null || kind !== handleKind(downstream.targetHandle)) continue
        const draft: BridgeEdgeDraft = {
          source: upstream.source,
          sourceHandle: upstream.sourceHandle ?? '',
          target: downstream.target,
          targetHandle: downstream.targetHandle ?? '',
        }
        const key = `${draft.source}|${draft.sourceHandle}|${draft.target}|${draft.targetHandle}`
        if (seen.has(key)) continue
        // Never duplicate a link the user already has.
        if (edges.some((edge) => survives(edge)
          && edge.source === draft.source
          && (edge.sourceHandle ?? '') === draft.sourceHandle
          && edge.target === draft.target
          && (edge.targetHandle ?? '') === draft.targetHandle)) continue
        seen.add(key)
        drafts.push(draft)
      }
    }
  }
  return drafts
}

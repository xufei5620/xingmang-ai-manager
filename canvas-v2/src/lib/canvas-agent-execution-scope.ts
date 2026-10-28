import type { CanvasAgentProposal } from './canvas-agent-contract'

/** Callers parse and authorize the proposal before using this target scope.
 * Upstream dependencies remain the run planner's responsibility, not targets
 * silently added to the reviewed Agent operation. */
export function canvasAgentProposalTargetNodeIds(proposal: CanvasAgentProposal | undefined): string[] {
  if (!proposal) return []
  return [...new Set([
    ...proposal.nodes.map((node) => node.id),
    ...proposal.updates.map((update) => update.nodeId),
    ...proposal.edges.map((edge) => edge.target),
  ])]
}

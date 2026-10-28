import { assertCanvasAgentTurnImageBindings, parseCanvasAgentImageBindings, type CanvasAgentImageReference, type CanvasAgentProposal } from './canvas-agent-contract'

/** Digest only the reviewed, ordered binding identities; no temporary URL or label participates. */
export async function canvasAgentImageBindingDigest(proposal: Pick<CanvasAgentProposal, 'imageBindings'>): Promise<string> {
  const identities = (proposal.imageBindings ?? []).map(({ nodeId, imageRef, assetId }) => ({ nodeId, imageRef, assetId }))
  const bytes = new TextEncoder().encode(JSON.stringify(identities))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function assertCanvasAgentProposalImageBindings(proposal: CanvasAgentProposal, planningVersion: 2 | 3 | undefined, references?: readonly CanvasAgentImageReference[]): void {
  parseCanvasAgentImageBindings(proposal.imageBindings, proposal.nodes)
  assertCanvasAgentTurnImageBindings({ planningVersion, imageReferences: references ? [...references] : undefined, proposal })
}

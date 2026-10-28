import { describe, expect, it } from 'vitest'
import { parseCanvasAgentProposal, type CanvasAgentProposal } from './canvas-agent-contract'
import { canvasAgentProposalTargetNodeIds } from './canvas-agent-execution-scope'

function proposal(overrides: Partial<CanvasAgentProposal> = {}): CanvasAgentProposal {
  return {
    id: 'execution-scope', digest: '0'.repeat(64), baseProjectVersion: 1,
    baseGraphDigest: '1'.repeat(64), expectedResultGraphDigest: '2'.repeat(64),
    summary: 'Explicit synthetic proposal', nodes: [], updates: [], edges: [], ...overrides,
  }
}

function addedNode(index: number): CanvasAgentProposal['nodes'][number] {
  return { id: `agent-execution-scope-n${index}`, kind: 'prompt', definitionVersion: 1, position: { x: index * 300, y: 0 }, data: { prompt: 'Synthetic original text', model: '', status: 'idle', settings: { title: `Added ${index}` } } }
}

function edge(index: number, source: string, target: string): CanvasAgentProposal['edges'][number] {
  return { id: `agent-execution-scope-e${index}`, source, sourceHandle: 'out:text', target, targetHandle: 'in:text' }
}

describe('Agent proposal execution target scope', () => {
  it('returns an empty independent array when there is no proposal', () => {
    const first = canvasAgentProposalTargetNodeIds(undefined)
    first.push('caller-only')
    expect(canvasAgentProposalTargetNodeIds(undefined)).toEqual([])
  })

  it('uses stable node, update and edge-target order without sorting or mutating the proposal', () => {
    const value = parseCanvasAgentProposal(proposal({
      nodes: [addedNode(0), addedNode(1)],
      updates: [{ nodeId: 'existing-z', data: { prompt: 'Keep existing media results' } }, { nodeId: 'existing-a', title: 'Renamed selected node' }],
      edges: [edge(0, 'selected-upstream', 'existing-z'), edge(1, 'agent-execution-scope-n0', 'selected-edge-target'), edge(2, 'existing-a', 'agent-execution-scope-n1'), edge(3, 'second-upstream', 'selected-edge-target')],
    }))
    const before = structuredClone(value)
    expect(canvasAgentProposalTargetNodeIds(value)).toEqual(['agent-execution-scope-n0', 'agent-execution-scope-n1', 'existing-z', 'existing-a', 'selected-edge-target'])
    expect(value).toEqual(before)
  })

  it('includes the destination of an actual parser-accepted edge-only proposal', () => {
    const value = parseCanvasAgentProposal(proposal({ edges: [edge(0, 'selected-upstream', 'selected-destination')] }))
    expect(value.nodes).toEqual([])
    expect(value.updates).toEqual([])
    expect(canvasAgentProposalTargetNodeIds(value)).toEqual(['selected-destination'])
    expect(canvasAgentProposalTargetNodeIds(value)).not.toContain('selected-upstream')
  })

  it('includes node updates even when they add no node or edge', () => {
    const value = parseCanvasAgentProposal(proposal({ updates: [{ nodeId: 'existing-target', data: { prompt: 'Revised creative instruction' } }] }))
    expect(canvasAgentProposalTargetNodeIds(value)).toEqual(['existing-target'])
  })

  it('deduplicates repeated identities across all target lists without widening the scope', () => {
    const value = proposal({ nodes: [addedNode(0), addedNode(0)], updates: [{ nodeId: 'existing-target', title: 'A' }, { nodeId: 'existing-target', title: 'B' }], edges: [edge(0, 'not-a-target', 'existing-target'), edge(1, 'unrelated-source', 'agent-execution-scope-n0'), edge(2, 'unrelated-source', 'edge-target')] })
    expect(canvasAgentProposalTargetNodeIds(value)).toEqual(['agent-execution-scope-n0', 'existing-target', 'edge-target'])
  })

  it('does not read edge sources, walk upstreams or select other canvas nodes', () => {
    const targetOnlyEdge: CanvasAgentProposal['edges'][number] = { id: 'edge-identity', get source(): string { throw new Error('An upstream identity is not an execution target') }, sourceHandle: 'out:text', target: 'explicit-destination', targetHandle: 'in:text' }
    expect(canvasAgentProposalTargetNodeIds(proposal({ edges: [targetOnlyEdge] }))).toEqual(['explicit-destination'])
  })

  it('returns a fresh snapshot so later caller and proposal changes cannot modify each other', () => {
    const value = proposal({ nodes: [addedNode(0)], edges: [edge(0, 'source', 'destination')] })
    const targets = canvasAgentProposalTargetNodeIds(value)
    targets.push('caller-only')
    value.edges.push(edge(1, 'later-source', 'later-destination'))
    expect(targets).toEqual(['agent-execution-scope-n0', 'destination', 'caller-only'])
    expect(canvasAgentProposalTargetNodeIds(value)).toEqual(['agent-execution-scope-n0', 'destination', 'later-destination'])
  })
})

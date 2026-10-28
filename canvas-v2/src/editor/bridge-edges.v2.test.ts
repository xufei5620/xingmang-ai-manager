import { describe, expect, it } from 'vitest'
import { bridgeEdgesForRemoval, type BridgeableEdge } from './bridge-edges'

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): BridgeableEdge {
  return { id, source, sourceHandle, target, targetHandle }
}

describe('bridgeEdgesForRemoval', () => {
  it('heals a chain when the middle node is removed', () => {
    const edges = [
      edge('e1', 'a', 'out:image', 'b', 'in:images'),
      edge('e2', 'b', 'out:image', 'c', 'in:images'),
    ]
    expect(bridgeEdgesForRemoval(edges, ['b'])).toEqual([
      { source: 'a', sourceHandle: 'out:image', target: 'c', targetHandle: 'in:images' },
    ])
  })

  it('refuses to invent a connection across mismatched media kinds', () => {
    const edges = [
      edge('e1', 'a', 'out:text', 'b', 'in:text'),
      edge('e2', 'b', 'out:image', 'c', 'in:images'),
    ]
    expect(bridgeEdgesForRemoval(edges, ['b'])).toEqual([])
  })

  it('bridges every upstream to every downstream of the same kind', () => {
    const edges = [
      edge('e1', 'a', 'out:image', 'hub', 'in:images'),
      edge('e2', 'b', 'out:image', 'hub', 'in:images'),
      edge('e3', 'hub', 'out:image', 'c', 'in:images'),
    ]
    expect(bridgeEdgesForRemoval(edges, ['hub'])).toHaveLength(2)
  })

  it('does not duplicate a link the user already drew', () => {
    const edges = [
      edge('e1', 'a', 'out:image', 'b', 'in:images'),
      edge('e2', 'b', 'out:image', 'c', 'in:images'),
      edge('e3', 'a', 'out:image', 'c', 'in:images'),
    ]
    expect(bridgeEdgesForRemoval(edges, ['b'])).toEqual([])
  })

  it('ignores ends that are themselves being removed', () => {
    const edges = [
      edge('e1', 'a', 'out:image', 'b', 'in:images'),
      edge('e2', 'b', 'out:image', 'c', 'in:images'),
    ]
    expect(bridgeEdgesForRemoval(edges, ['b', 'c'])).toEqual([])
    expect(bridgeEdgesForRemoval(edges, ['a', 'b'])).toEqual([])
  })

  it('produces nothing for a leaf node', () => {
    const edges = [edge('e1', 'a', 'out:image', 'b', 'in:images')]
    expect(bridgeEdgesForRemoval(edges, ['b'])).toEqual([])
  })

  it('deduplicates when two removed nodes would bridge the same pair', () => {
    const edges = [
      edge('e1', 'a', 'out:image', 'x', 'in:images'),
      edge('e2', 'x', 'out:image', 'c', 'in:images'),
      edge('e3', 'a', 'out:image', 'y', 'in:images'),
      edge('e4', 'y', 'out:image', 'c', 'in:images'),
    ]
    expect(bridgeEdgesForRemoval(edges, ['x', 'y'])).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import { alignNodePositions, distributeNodePositions, type AlignableNode } from './align'

function node(id: string, x: number, y: number, width = 100, height = 60, locked = false): AlignableNode {
  return { id, position: { x, y }, width, height, locked }
}

describe('alignNodePositions', () => {
  it('aligns to the edges of the selection bounding box', () => {
    const nodes = [node('a', 0, 0, 100), node('b', 50, 80, 200)]
    expect(alignNodePositions(nodes, 'left')).toEqual({ b: { x: 0, y: 80 } })
    expect(alignNodePositions(nodes, 'right')).toEqual({ a: { x: 150, y: 0 } })
  })

  it('centres by each node own size, not by its origin', () => {
    // Different widths must end up sharing a centre line, which only works if
    // half the node width is subtracted per node.
    const result = alignNodePositions([node('a', 0, 0, 100), node('b', 0, 80, 300)], 'horizontal-center')
    expect(result.a).toEqual({ x: 100, y: 0 })
    expect(result.b).toBeUndefined()
  })

  it('lets a locked node anchor the others without moving itself', () => {
    const result = alignNodePositions([node('a', 0, 0), node('b', 400, 40, 100, 60, true)], 'left')
    expect(result.b).toBeUndefined()
    expect(result.a).toBeUndefined()
  })

  it('does nothing for fewer than two nodes', () => {
    expect(alignNodePositions([node('a', 10, 10)], 'left')).toEqual({})
    expect(alignNodePositions([], 'top')).toEqual({})
  })

  it('omits nodes that are already in place', () => {
    expect(alignNodePositions([node('a', 0, 0), node('b', 0, 80)], 'left')).toEqual({})
  })
})

describe('distributeNodePositions', () => {
  it('evens the gaps and leaves the outermost nodes untouched', () => {
    const nodes = [node('a', 0, 0, 100), node('b', 120, 0, 100), node('c', 500, 0, 100)]
    const result = distributeNodePositions(nodes, 'horizontal')
    expect(result.a).toBeUndefined()
    expect(result.c).toBeUndefined()
    // Span 600, occupied 300, so each of the two gaps is 150.
    expect(result.b).toEqual({ x: 250, y: 0 })
  })

  it('distributes by gap so unequal sizes do not bunch up', () => {
    const nodes = [node('a', 0, 0, 100), node('b', 150, 0, 400), node('c', 900, 0, 100)]
    const result = distributeNodePositions(nodes, 'horizontal')
    // Span 1000, occupied 600, two gaps of 200: b starts at 100 + 200 = 300.
    expect(result.b).toEqual({ x: 300, y: 0 })
  })

  it('works on the vertical axis using heights', () => {
    const nodes = [node('a', 0, 0, 100, 50), node('b', 0, 60, 100, 50), node('c', 0, 400, 100, 50)]
    const result = distributeNodePositions(nodes, 'vertical')
    // Span 450, occupied 150, so two gaps of 150: a ends at 50, b starts at 200.
    expect(result.b).toEqual({ x: 0, y: 200 })
  })

  it('needs at least three nodes to have a gap to even out', () => {
    expect(distributeNodePositions([node('a', 0, 0), node('b', 200, 0)], 'horizontal')).toEqual({})
  })

  it('never moves a locked node', () => {
    const nodes = [node('a', 0, 0, 100), node('b', 120, 0, 100, 60, true), node('c', 500, 0, 100)]
    expect(distributeNodePositions(nodes, 'horizontal').b).toBeUndefined()
  })

  it('sorts by position rather than trusting selection order', () => {
    const nodes = [node('c', 500, 0, 100), node('a', 0, 0, 100), node('b', 120, 0, 100)]
    expect(distributeNodePositions(nodes, 'horizontal')).toEqual({ b: { x: 250, y: 0 } })
  })
})

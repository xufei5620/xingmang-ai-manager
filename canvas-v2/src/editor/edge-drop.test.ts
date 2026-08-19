import { describe, expect, it } from 'vitest'
import { edgeDropTolerancePx, findEdgeDropTarget, type EdgeEndpoints } from './edge-drop'
import type { SnapBox } from './snap-guides'

function edge(id: string, source: string, target: string, from: [number, number], to: [number, number]): EdgeEndpoints {
  return {
    id, source, target,
    sourceHandle: 'out:image',
    targetHandle: 'in:images',
    sourcePoint: { x: from[0], y: from[1] },
    targetPoint: { x: to[0], y: to[1] },
  }
}

function box(id: string, x: number, y: number): SnapBox {
  return { id, x, y, width: 100, height: 60 }
}

describe('findEdgeDropTarget', () => {
  it('finds the edge a node centre is sitting on', () => {
    const edges = [edge('e1', 'a', 'b', [0, 100], [600, 100])]
    // Centre of this box is (300, 100), right on the wire.
    expect(findEdgeDropTarget(box('m', 250, 70), edges)?.id).toBe('e1')
  })

  it('ignores an edge further away than the tolerance', () => {
    const edges = [edge('e1', 'a', 'b', [0, 0], [600, 0])]
    expect(findEdgeDropTarget(box('m', 250, 500), edges)).toBeNull()
  })

  it('never targets an edge the node itself terminates', () => {
    const edges = [edge('e1', 'm', 'b', [0, 100], [600, 100])]
    expect(findEdgeDropTarget(box('m', 250, 70), edges)).toBeNull()
    expect(findEdgeDropTarget(box('m', 250, 70), [edge('e2', 'a', 'm', [0, 100], [600, 100])])).toBeNull()
  })

  it('picks the nearest edge when several are in range', () => {
    const edges = [
      edge('far', 'a', 'b', [0, 130], [600, 130]),
      edge('near', 'c', 'd', [0, 101], [600, 101]),
    ]
    expect(findEdgeDropTarget(box('m', 250, 70), edges)?.id).toBe('near')
  })

  it('measures to the segment, not the infinite line', () => {
    // The node sits far beyond the end of a short edge, so despite being on the
    // same line it must not be treated as hovering it.
    const edges = [edge('e1', 'a', 'b', [0, 100], [50, 100])]
    expect(findEdgeDropTarget(box('m', 900, 70), edges)).toBeNull()
  })

  it('handles a degenerate zero length edge without dividing by zero', () => {
    const edges = [edge('e1', 'a', 'b', [300, 100], [300, 100])]
    expect(findEdgeDropTarget(box('m', 250, 70), edges)?.id).toBe('e1')
  })

  it('uses a tolerance forgiving enough for a coarse drag', () => {
    expect(edgeDropTolerancePx).toBeGreaterThanOrEqual(24)
  })
})

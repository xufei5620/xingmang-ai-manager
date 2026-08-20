import { describe, expect, it } from 'vitest'
import { edgesCrossedByStroke, segmentsIntersect, strokePath } from './cut-gesture'
import type { EdgeEndpoints } from './edge-drop'

function edge(id: string, from: [number, number], to: [number, number]): EdgeEndpoints {
  return {
    id, source: `${id}-s`, target: `${id}-t`,
    sourceHandle: 'out:image', targetHandle: 'in:images',
    sourcePoint: { x: from[0], y: from[1] },
    targetPoint: { x: to[0], y: to[1] },
  }
}

describe('segmentsIntersect', () => {
  it('detects a plain crossing', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true)
  })

  it('rejects segments that would only meet if extended', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 10, y: 0 }, { x: 14, y: -4 })).toBe(false)
  })

  it('treats a touching endpoint as a crossing', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 8 })).toBe(true)
  })

  it('handles parallel segments that never meet', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBe(false)
  })
})

describe('edgesCrossedByStroke', () => {
  const edges = [
    edge('a', [0, 100], [200, 100]),
    edge('b', [0, 200], [200, 200]),
    edge('c', [0, 900], [200, 900]),
  ]

  it('cuts every wire the stroke passes through', () => {
    const stroke = [{ x: 100, y: 50 }, { x: 100, y: 250 }]
    expect(edgesCrossedByStroke(stroke, edges).sort()).toEqual(['a', 'b'])
  })

  it('leaves wires the stroke misses', () => {
    expect(edgesCrossedByStroke([{ x: 100, y: 50 }, { x: 100, y: 150 }], edges)).toEqual(['a'])
  })

  it('reports each wire once even when the stroke doubles back', () => {
    const stroke = [{ x: 100, y: 50 }, { x: 100, y: 150 }, { x: 100, y: 50 }, { x: 100, y: 150 }]
    expect(edgesCrossedByStroke(stroke, edges)).toEqual(['a'])
  })

  it('needs at least two points to be a stroke at all', () => {
    expect(edgesCrossedByStroke([], edges)).toEqual([])
    expect(edgesCrossedByStroke([{ x: 100, y: 100 }], edges)).toEqual([])
  })

  it('follows a multi-segment freehand path', () => {
    // An L shape that only reaches the second wire on its second leg.
    const stroke = [{ x: 100, y: 50 }, { x: 100, y: 150 }, { x: 400, y: 150 }]
    expect(edgesCrossedByStroke(stroke, edges)).toEqual(['a'])
  })
})

describe('strokePath', () => {
  it('builds a polyline command', () => {
    expect(strokePath([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe('M1 2 L3 4')
  })

  it('returns an empty string for an empty stroke', () => {
    expect(strokePath([])).toBe('')
  })
})

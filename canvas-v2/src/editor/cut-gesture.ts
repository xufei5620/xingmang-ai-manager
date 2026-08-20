import type { EdgeEndpoints } from './edge-drop'

export interface Point { x: number; y: number }

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)
  if (Math.abs(value) < 1e-9) return 0
  return value > 0 ? 1 : 2
}

function onSegment(a: Point, b: Point, c: Point): boolean {
  return b.x <= Math.max(a.x, c.x) && b.x >= Math.min(a.x, c.x)
    && b.y <= Math.max(a.y, c.y) && b.y >= Math.min(a.y, c.y)
}

/** Standard orientation test, including the collinear touching cases. */
export function segmentsIntersect(p1: Point, q1: Point, p2: Point, q2: Point): boolean {
  const o1 = orientation(p1, q1, p2)
  const o2 = orientation(p1, q1, q2)
  const o3 = orientation(p2, q2, p1)
  const o4 = orientation(p2, q2, q1)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSegment(p1, p2, q1)) return true
  if (o2 === 0 && onSegment(p1, q2, q1)) return true
  if (o3 === 0 && onSegment(p2, p1, q2)) return true
  if (o4 === 0 && onSegment(p2, q1, q2)) return true
  return false
}

/**
 * Edges crossed by a freehand stroke. Each stroke segment is tested against
 * each edge's endpoint segment, which is the same straight-line approximation
 * of the bezier used for drop targeting.
 */
export function edgesCrossedByStroke(
  stroke: readonly Point[],
  edges: readonly EdgeEndpoints[],
): string[] {
  if (stroke.length < 2) return []
  const cut = new Set<string>()
  for (let index = 1; index < stroke.length; index += 1) {
    const from = stroke[index - 1]
    const to = stroke[index]
    for (const edge of edges) {
      if (cut.has(edge.id)) continue
      if (segmentsIntersect(from, to, edge.sourcePoint, edge.targetPoint)) cut.add(edge.id)
    }
  }
  return [...cut]
}

/** Screen-space polyline for rendering the stroke. */
export function strokePath(stroke: readonly Point[]): string {
  if (stroke.length === 0) return ''
  return stroke.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ')
}

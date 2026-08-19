import type { SnapBox } from './snap-guides'

export interface EdgeEndpoints {
  id: string
  source: string
  sourceHandle?: string | null
  target: string
  targetHandle?: string | null
  sourcePoint: { x: number; y: number }
  targetPoint: { x: number; y: number }
}

export const edgeDropTolerancePx = 40

function distanceToSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/**
 * The edge a dragged node is hovering over, or null.
 *
 * Hit testing uses the straight segment between the two endpoints rather than
 * the rendered bezier. The bezier only bows away from that line in the middle,
 * which is exactly where the tolerance is most forgiving anyway, so the
 * approximation is not worth the cost of sampling the curve.
 */
export function findEdgeDropTarget(
  node: SnapBox,
  edges: readonly EdgeEndpoints[],
  tolerance = edgeDropTolerancePx,
): EdgeEndpoints | null {
  const centre = { x: node.x + node.width / 2, y: node.y + node.height / 2 }
  let best: { edge: EdgeEndpoints; distance: number } | null = null
  for (const edge of edges) {
    // Splicing a node into a wire it already terminates would create a loop
    // between the node and itself.
    if (edge.source === node.id || edge.target === node.id) continue
    const distance = distanceToSegment(centre, edge.sourcePoint, edge.targetPoint)
    if (distance > tolerance) continue
    if (best && distance >= best.distance) continue
    best = { edge, distance }
  }
  return best?.edge ?? null
}

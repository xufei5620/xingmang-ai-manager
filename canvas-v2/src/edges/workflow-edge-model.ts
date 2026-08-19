import type { PortKind } from '../model'
import { handleKind } from '../ports'

export type CanvasEdgeTone = PortKind | 'unknown'

/**
 * Which media travels along an edge. Read from the source handle, because that
 * is the end that produces the value; a target handle can legitimately accept
 * several kinds (`in:images` on a router), so it cannot name the tone.
 */
export function canvasEdgeTone(sourceHandleId: string | null | undefined): CanvasEdgeTone {
  return handleKind(sourceHandleId) ?? 'unknown'
}

export function canvasEdgeToneVariable(tone: CanvasEdgeTone): string {
  return tone === 'unknown' ? 'var(--xy-edge-stroke-default)' : `var(--port-${tone})`
}

/**
 * Midpoint of a bezier whose control points are horizontal, which is where the
 * edge toolbar anchors. React Flow gives this back from getBezierPath, but the
 * toolbar needs it before the path is rendered, so it is computed here and
 * unit tested rather than trusted to stay in sync by inspection.
 */
export function canvasEdgeMidpoint(
  source: { x: number; y: number },
  target: { x: number; y: number },
): { x: number; y: number } {
  return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 }
}

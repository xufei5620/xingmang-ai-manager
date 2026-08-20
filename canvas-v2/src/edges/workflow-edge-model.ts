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

/** Every wire uses one muted stroke. Port chips stay colored; the graph does not. */
export const canvasEdgeStroke = 'var(--canvas-edge)'

/** Horizontal pull of the cubic bezier. Too little hugs the node; too much loops. */
export const canvasEdgeCurvature = 0.35

/**
 * Midpoint of the two endpoints, which is where the edge toolbar anchors.
 * The bezier control points sit off this line, so it is computed here and
 * unit tested rather than trusted to stay in sync by inspection.
 */
export function canvasEdgeMidpoint(
  source: { x: number; y: number },
  target: { x: number; y: number },
): { x: number; y: number } {
  return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 }
}

export function canvasEdgeTouchesSelection(
  edge: { source: string; target: string },
  selectedNodeIds: ReadonlySet<string>,
): boolean {
  if (selectedNodeIds.size === 0) return false
  return selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target)
}

export function canvasEdgeClassName(options: {
  dropTarget?: boolean
  flowing?: boolean
}): string | undefined {
  const parts: string[] = []
  if (options.dropTarget) parts.push('is-drop-target')
  if (options.flowing) parts.push('is-flowing')
  return parts.length > 0 ? parts.join(' ') : undefined
}

export function canvasEdgeIsFlowing(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && (data as { flowing?: unknown }).flowing === true)
}

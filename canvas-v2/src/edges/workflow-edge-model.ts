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

export function canvasEdgeToneLabel(tone: CanvasEdgeTone): string {
  return { text: '文本', image: '图片', video: '视频', audio: '音频', unknown: '数据' }[tone]
}

/** Horizontal pull of the cubic bezier. Too little hugs the node; too much loops. */
export const canvasEdgeCurvature = 0.35

/** Keyboard clicks have no screen point; anchor to the visible button instead. */
export function canvasEdgeInsertPoint(
  event: { detail: number; clientX: number; clientY: number },
  button: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  return event.detail === 0
    ? { x: button.left + button.width / 2, y: button.top + button.height / 2 }
    : { x: event.clientX, y: event.clientY }
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

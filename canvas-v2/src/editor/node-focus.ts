import { minimumCanvasViewportZoom } from '../persistence/canvas-viewport-limits'

interface Dimensions {
  width: number
  height: number
}

/** Explicit insertion positions are preserved; only bring clipped content into view. */
export function createdNodeNeedsFocus(node: Dimensions & { x: number; y: number }, viewport: Dimensions | undefined, transform: { x: number; y: number; zoom: number }): boolean {
  if (!viewport) return false
  const left = node.x * transform.zoom + transform.x
  const top = node.y * transform.zoom + transform.y
  return left < 48 || top < 80
    || left + node.width * transform.zoom > viewport.width - 48
    || top + node.height * transform.zoom > viewport.height - 80
}

/** Leave room for the selection tools, node actions and bottom navigation. */
export function createdNodeFocusZoom(node: Dimensions, viewport: Dimensions | undefined, currentZoom: number): number {
  if (!viewport) return Math.min(currentZoom, 1)
  return Math.max(minimumCanvasViewportZoom, Math.min(
    currentZoom,
    1,
    Math.max(1, viewport.width - 96) / Math.max(1, node.width),
    Math.max(1, viewport.height - 160) / Math.max(1, node.height),
  ))
}

export interface CreatedNodeFocusScope { projectId: string | null; projectEpoch: number }
export interface CreatedNodeFocusCandidate { position: { x: number; y: number }; measured?: Partial<Dimensions>; width?: number; height?: number }
export interface CreatedNodeFocusTarget extends Dimensions { x: number; y: number }

/** A delayed measurement belongs to one insertion and one project lifetime.
 * Cancellation also invalidates already-queued callbacks that cannot be removed.
 */
export function createCreatedNodeFocusCoordinator(adapter: {
  schedule(callback: () => void): number
  cancel(handle: number): void
  scope(): CreatedNodeFocusScope
  readNode(id: string): CreatedNodeFocusCandidate | undefined
  onNavigation?(): void
}) {
  let active: object | null = null
  let frame: number | null = null

  function cancel(): void {
    active = null
    if (frame !== null) adapter.cancel(frame)
    frame = null
  }

  function start(nodeId: string, fallback: Dimensions, ready: (target: CreatedNodeFocusTarget) => void): void {
    adapter.onNavigation?.()
    cancel()
    const token = {}, scope = adapter.scope()
    active = token
    let attempts = 0, seen = false
    function measure(): void {
      if (active !== token) return
      frame = null
      const current = adapter.scope()
      if (scope.projectId !== current.projectId || scope.projectEpoch !== current.projectEpoch) { cancel(); return }
      const node = adapter.readNode(nodeId)
      if (!node && seen) { cancel(); return }
      seen ||= Boolean(node)
      const measured = Boolean(node?.measured?.width && node.measured.width > 0 && node.measured.height && node.measured.height > 0)
      if (!measured && attempts++ < 30) { frame = adapter.schedule(measure); return }
      active = null
      // Never focus a deleted node, even if React Flow never observed it.
      if (!node) return
      ready({ x: node.position.x, y: node.position.y, width: node.measured?.width || node.width || fallback.width, height: node.measured?.height || node.height || fallback.height })
    }
    frame = adapter.schedule(measure)
  }

  return { start, cancel }
}

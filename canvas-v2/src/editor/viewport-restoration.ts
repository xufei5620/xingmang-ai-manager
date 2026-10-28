import type { CanvasViewport } from '../store/canvas-state'

export interface ViewportRestorationScope { projectId: string | null; projectEpoch: number }
interface PendingViewportRestore { viewport: CanvasViewport; scope: ViewportRestorationScope }

/** Loading a document can precede ZoomPane's effect. Keep that request until
 * React Flow explicitly initializes; a single animation frame is not readiness.
 */
export function createViewportRestoration(adapter: {
  schedule(callback: () => void): number
  cancelFrame(handle: number): void
  scope(): ViewportRestorationScope
  active(): boolean
  apply(viewport: CanvasViewport): Promise<CanvasViewport | null>
  applied(viewport: CanvasViewport): void
}) {
  let ready = false
  let frame: number | null = null
  let pending: PendingViewportRestore | null = null
  let applying: PendingViewportRestore | null = null

  function cancel(): void {
    pending = null
    if (frame !== null) adapter.cancelFrame(frame)
    frame = null
  }
  function current(request: PendingViewportRestore): boolean {
    const scope = adapter.scope()
    return pending === request && adapter.active() && scope.projectId === request.scope.projectId && scope.projectEpoch === request.scope.projectEpoch
  }
  function schedule(): void {
    if (!ready || !pending || frame !== null || applying === pending) return
    const request = pending
    if (!current(request)) { cancel(); return }
    frame = adapter.schedule(() => {
      if (!current(request)) return
      frame = null
      applying = request
      void adapter.apply(request.viewport).then((actual) => {
        if (applying === request) applying = null
        if (!current(request)) return
        if (!actual) { ready = false; return }
        pending = null
        adapter.applied(actual)
      }).catch(() => {
        // A destroyed/uninitialized pane is retried only after its next init,
        // never in an unbounded animation loop and never across project scopes.
        if (applying === request) applying = null
        if (current(request)) ready = false
      })
    })
  }
  function request(viewport: CanvasViewport): void {
    cancel()
    pending = { viewport: { ...viewport }, scope: { ...adapter.scope() } }
    schedule()
  }
  function initialized(): void { ready = true; schedule() }
  function reset(): void { ready = false; cancel() }
  return { request, initialized, cancel, reset }
}

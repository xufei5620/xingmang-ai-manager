export interface CompareViewport { scale: number; x: number; y: number }
export interface CompareViewportBounds { width: number; height: number }
export const initialCompareViewport: Readonly<CompareViewport> = { scale: 1, x: 0, y: 0 }

export function constrainCompareViewport(value: CompareViewport, bounds: CompareViewportBounds): CompareViewport {
  const scale = Math.max(1, Math.min(8, Number.isFinite(value.scale) ? value.scale : 1))
  const width = Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : 0
  const height = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 0
  const limitX = width * (scale - 1) / 2, limitY = height * (scale - 1) / 2
  return { scale, x: Math.max(-limitX, Math.min(limitX, Number.isFinite(value.x) ? value.x : 0)) || 0, y: Math.max(-limitY, Math.min(limitY, Number.isFinite(value.y) ? value.y : 0)) || 0 }
}

/** Center-based viewing only: this state never enters a workflow command. */
export function createCompareViewportInteraction(onChange: () => void) {
  let view: CompareViewport = { ...initialCompareViewport }, scope = '', enabled = false
  let gesture: { pointerId: number; x: number; y: number; before: CompareViewport; bounds: CompareViewportBounds } | null = null
  function change(next: CompareViewport) {
    if (next.scale === view.scale && next.x === view.x && next.y === view.y) return
    view = next
    onChange()
  }
  function scale(next: number, bounds: CompareViewportBounds) {
    if (!enabled || gesture || !Number.isFinite(next)) return false
    change(constrainCompareViewport({ ...view, scale: next }, bounds))
    return true
  }
  return {
    sync(nextScope: string, nextEnabled: boolean) {
      if (scope !== nextScope) { view = { ...initialCompareViewport }; gesture = null }
      if (!nextEnabled) gesture = null
      scope = nextScope
      enabled = nextEnabled
    },
    read: () => ({ ...view }),
    pending: () => gesture?.pointerId ?? null,
    scale,
    zoom(delta: number, bounds: CompareViewportBounds) {
      if (!Number.isFinite(delta) || delta === 0) return false
      return scale(view.scale * Math.exp(Math.max(-1, Math.min(1, -delta * .003))), bounds)
    },
    reset() { if (enabled) { gesture = null; change({ ...initialCompareViewport }) } },
    start(pointerId: number, x: number, y: number, bounds: CompareViewportBounds) {
      if (!enabled || gesture || view.scale <= 1 || ![pointerId, x, y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return false
      gesture = { pointerId, x, y, before: { ...view }, bounds: { ...bounds } }
      return true
    },
    move(pointerId: number, x: number, y: number) {
      if (!enabled || gesture?.pointerId !== pointerId || ![x, y].every(Number.isFinite)) return
      change(constrainCompareViewport({ ...gesture.before, x: gesture.before.x + x - gesture.x, y: gesture.before.y + y - gesture.y }, gesture.bounds))
    },
    finish(pointerId: number) { if (gesture?.pointerId === pointerId) gesture = null },
    cancel(pointerId?: number) {
      if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return
      const before = gesture.before
      gesture = null
      if (enabled) change(before)
    },
    key(key: string, bounds: CompareViewportBounds) {
      if (!enabled || gesture) return false
      if (key === '+' || key === '=') return scale(view.scale * 1.25, bounds)
      if (key === '-') return scale(view.scale / 1.25, bounds)
      if (key === 'Home' || key === '0') { change({ ...initialCompareViewport }); return true }
      if (view.scale <= 1) return false
      const delta = key === 'ArrowLeft' ? { x: 24, y: 0 } : key === 'ArrowRight' ? { x: -24, y: 0 } : key === 'ArrowUp' ? { x: 0, y: 24 } : key === 'ArrowDown' ? { x: 0, y: -24 } : null
      if (!delta) return false
      change(constrainCompareViewport({ ...view, x: view.x + delta.x, y: view.y + delta.y }, bounds))
      return true
    },
  }
}

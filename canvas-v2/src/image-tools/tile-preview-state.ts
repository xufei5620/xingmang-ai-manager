import type { UpstreamMediaReference } from '../components/upstream-references'

export interface TileViewport { scale: number; x: number; y: number }
export const initialTileViewport: Readonly<TileViewport> = { scale: 1, x: 0, y: 0 }

/** Asset replacement and slot changes invalidate an editor draft before Apply. */
export function tileEditorInputScope(references: readonly UpstreamMediaReference[], selection: unknown): string {
  return JSON.stringify([selection ?? null, references.filter((reference) => reference.kind === 'image').map((reference) => [reference.edgeId, reference.outputIndex ?? 0, reference.status, reference.asset?.assetId ?? null, reference.asset?.localUrl ?? null])])
}

export function tilePreviewDimensions(width: number, height: number): { width: number; height: number } {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return { width: 256, height: 256 }
  const factor = 320 / Math.max(width, height)
  return { width: width * factor, height: height * factor }
}

/** Viewing only. No graph command, image processing or persistence is involved. */
export function createTileViewportInteraction(onChange: () => void) {
  let view: TileViewport = { ...initialTileViewport }, scope = '', enabled = false
  let drag: { pointerId: number; x: number; y: number; before: TileViewport } | null = null
  function change(next: TileViewport) {
    if (![next.scale, next.x, next.y].every(Number.isFinite)) return
    const normalized = { scale: Math.max(.1, Math.min(8, next.scale)), x: Math.max(-1_000_000, Math.min(1_000_000, next.x)), y: Math.max(-1_000_000, Math.min(1_000_000, next.y)) }
    if (normalized.scale === view.scale && normalized.x === view.x && normalized.y === view.y) return
    view = normalized; onChange()
  }
  function zoom(next: number, point = { x: 0, y: 0 }) {
    if (!enabled || drag || ![next, point.x, point.y].every(Number.isFinite)) return false
    const scale = Math.max(.1, Math.min(8, next)), factor = scale / view.scale
    change({ scale, x: point.x - (point.x - view.x) * factor, y: point.y - (point.y - view.y) * factor })
    return true
  }
  return {
    sync(nextScope: string, nextEnabled: boolean) {
      if (scope !== nextScope) { view = { ...initialTileViewport }; drag = null }
      if (!nextEnabled) drag = null
      scope = nextScope; enabled = nextEnabled
    },
    read: () => ({ ...view }),
    pending: () => drag?.pointerId ?? null,
    zoom,
    wheel(delta: number, point: { x: number; y: number }) { return Number.isFinite(delta) && delta !== 0 ? zoom(view.scale * Math.exp(Math.max(-1, Math.min(1, -delta * .002))), point) : false },
    reset() { if (enabled) { drag = null; change({ ...initialTileViewport }) } },
    start(pointerId: number, x: number, y: number) {
      if (!enabled || drag || ![pointerId, x, y].every(Number.isFinite)) return false
      drag = { pointerId, x, y, before: { ...view } }; return true
    },
    move(pointerId: number, x: number, y: number) {
      if (!enabled || drag?.pointerId !== pointerId || ![x, y].every(Number.isFinite)) return
      change({ ...drag.before, x: drag.before.x + x - drag.x, y: drag.before.y + y - drag.y })
    },
    finish(pointerId: number) { if (drag?.pointerId === pointerId) drag = null },
    cancel(pointerId?: number) { if (drag && (pointerId === undefined || pointerId === drag.pointerId)) { const before = drag.before; drag = null; if (enabled) change(before) } },
    key(key: string, point = { x: 0, y: 0 }) {
      if (!enabled || drag) return false
      if (key === '+' || key === '=') return zoom(view.scale * 1.25, point)
      if (key === '-') return zoom(view.scale / 1.25, point)
      if (key === 'Home' || key === '0') { change({ ...initialTileViewport }); return true }
      const delta = key === 'ArrowLeft' ? { x: 32, y: 0 } : key === 'ArrowRight' ? { x: -32, y: 0 } : key === 'ArrowUp' ? { x: 0, y: 32 } : key === 'ArrowDown' ? { x: 0, y: -32 } : null
      if (!delta) return false
      change({ ...view, x: view.x + delta.x, y: view.y + delta.y }); return true
    },
  }
}

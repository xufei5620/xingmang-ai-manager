export interface PanoramaView { yaw: number; pitch: number; fov: number }

export const initialPanoramaView: Readonly<PanoramaView> = { yaw: 0, pitch: 0, fov: 75 }

/** Clamp both axes by one scale so CSS pixels and downloaded pixels have the same aspect. */
export function panoramaRenderSize(width: number, height: number, devicePixelRatio: number): { width: number; height: number } {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const scale = Math.min(2, ratio, 2048 / safeWidth, 1024 / safeHeight)
  return { width: Math.max(1, Math.round(safeWidth * scale)), height: Math.max(1, Math.round(safeHeight * scale)) }
}

export function normalizePanoramaView(view: PanoramaView): PanoramaView {
  const yaw = Number.isFinite(view.yaw) ? view.yaw : initialPanoramaView.yaw
  return {
    yaw: ((yaw % 360) + 360) % 360,
    pitch: Math.max(-85, Math.min(85, Number.isFinite(view.pitch) ? view.pitch : initialPanoramaView.pitch)),
    fov: Math.max(30, Math.min(110, Number.isFinite(view.fov) ? view.fov : initialPanoramaView.fov)),
  }
}

/** Only view fields survive persistence; image identity belongs to the host. */
export function parsePanoramaView(value: unknown): PanoramaView {
  if (value === undefined) return { ...initialPanoramaView }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('全景视角设置无效')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['yaw', 'pitch', 'fov'].includes(key))) throw new Error('全景视角含不支持的字段')
  const result = { ...initialPanoramaView }
  for (const key of ['yaw', 'pitch', 'fov'] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error('全景视角设置必须是有效数字')
    result[key] = input[key]
  }
  if (result.yaw < 0 || result.yaw >= 360 || result.pitch < -85 || result.pitch > 85 || result.fov < 30 || result.fov > 110) throw new Error('全景视角超出支持范围')
  return result
}

export function panoramaViewsEqual(a: PanoramaView, b: PanoramaView): boolean {
  return a.yaw === b.yaw && a.pitch === b.pitch && a.fov === b.fov
}

export function panoramaKeyView(view: PanoramaView, key: string): PanoramaView | null {
  const patch = key === 'ArrowLeft' ? { yaw: view.yaw - 5 } : key === 'ArrowRight' ? { yaw: view.yaw + 5 }
    : key === 'ArrowUp' ? { pitch: view.pitch + 5 } : key === 'ArrowDown' ? { pitch: view.pitch - 5 }
      : key === '+' || key === '=' ? { fov: view.fov - 5 } : key === '-' ? { fov: view.fov + 5 }
        : key === 'Home' ? initialPanoramaView : null
  return patch ? normalizePanoramaView({ ...view, ...patch }) : null
}

type PanoramaGesture = { kind: 'pointer'; pointerId: number; x: number; y: number; initial: PanoramaView } | { kind: 'keyboard' | 'wheel'; initial: PanoramaView }

/** Draft notifications never write a document. Only finish commits one gesture. */
export function createPanoramaViewInteraction(callbacks: { onChange(view: PanoramaView): void; onCommit(view: PanoramaView): void }) {
  let current = { ...initialPanoramaView }, scope = '', enabled = false
  let gesture: PanoramaGesture | null = null
  function change(next: PanoramaView) {
    const normalized = normalizePanoramaView(next)
    if (panoramaViewsEqual(current, normalized)) return
    current = normalized
    callbacks.onChange({ ...current })
  }
  function finish() {
    const previous = gesture
    gesture = null
    if (enabled && previous && !panoramaViewsEqual(previous.initial, current)) callbacks.onCommit({ ...current })
  }
  function cancel(pointerId?: number) {
    if (!gesture || (pointerId !== undefined && (gesture.kind !== 'pointer' || gesture.pointerId !== pointerId))) return
    const initial = gesture.initial
    gesture = null
    if (enabled) change(initial)
  }
  return {
    sync(next: PanoramaView, nextScope: string, nextEnabled: boolean) {
      const normalized = normalizePanoramaView(next)
      // An external undo/source/account update supersedes the uncommitted draft.
      if (scope !== nextScope || !nextEnabled || !panoramaViewsEqual(current, normalized)) gesture = null
      scope = nextScope
      enabled = nextEnabled
      current = normalized
    },
    read: () => ({ ...current }),
    pending: () => gesture?.kind ?? null,
    startPointer(pointerId: number, x: number, y: number) {
      if (!enabled || gesture || ![pointerId, x, y].every(Number.isFinite)) return false
      gesture = { kind: 'pointer', pointerId, x, y, initial: { ...current } }
      return true
    },
    movePointer(pointerId: number, x: number, y: number) {
      if (!enabled || gesture?.kind !== 'pointer' || gesture.pointerId !== pointerId || ![x, y].every(Number.isFinite)) return
      change({ ...gesture.initial, yaw: gesture.initial.yaw - (x - gesture.x) * .25, pitch: gesture.initial.pitch + (y - gesture.y) * .25 })
    },
    finishPointer(pointerId: number) { if (gesture?.kind === 'pointer' && gesture.pointerId === pointerId) finish() },
    key(key: string) {
      if (!enabled || (gesture && gesture.kind !== 'keyboard')) return false
      const next = panoramaKeyView(current, key)
      if (!next) return false
      gesture ??= { kind: 'keyboard', initial: { ...current } }
      change(next)
      return true
    },
    finishKeyboard() { if (gesture?.kind === 'keyboard') finish() },
    wheel(delta: number) {
      if (!enabled || !Number.isFinite(delta) || delta === 0 || (gesture && gesture.kind !== 'wheel')) return false
      gesture ??= { kind: 'wheel', initial: { ...current } }
      change({ ...current, fov: current.fov + Math.max(-10, Math.min(10, delta * .04)) })
      return true
    },
    finishWheel() { if (gesture?.kind === 'wheel') finish() },
    commit(next: PanoramaView) {
      if (!enabled) return
      cancel()
      const initial = { ...current }
      change(next)
      if (!panoramaViewsEqual(initial, current)) callbacks.onCommit({ ...current })
    },
    cancel,
    discard() { gesture = null },
  }
}

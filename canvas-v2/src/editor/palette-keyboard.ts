export interface CanvasPaletteKeyEvent {
  key: string
  isComposing?: boolean
  keyCode?: number
}

export const canvasPalettePageSize = 20
export type CanvasPaletteKey = 'close' | 'next' | 'previous' | 'first' | 'last' | 'next-page' | 'previous-page' | 'activate'

export function resolveCanvasPaletteKey(event: CanvasPaletteKeyEvent, composing = false): CanvasPaletteKey | null {
  // Some IMEs clear isComposing on the Enter that confirms a candidate. Their
  // legacy 229 key code still identifies that key as part of composition.
  if (composing || event.isComposing || event.keyCode === 229) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'previous'
  if (event.key === 'Home') return 'first'
  if (event.key === 'End') return 'last'
  if (event.key === 'PageDown') return 'next-page'
  if (event.key === 'PageUp') return 'previous-page'
  if (event.key === 'Enter') return 'activate'
  return null
}

export function clampCanvasPaletteIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1))
}

export function moveCanvasPaletteIndex(index: number, count: number, key: CanvasPaletteKey): number {
  if (count === 0) return 0
  const current = clampCanvasPaletteIndex(index, count)
  if (key === 'first') return 0
  if (key === 'last') return count - 1
  if (key === 'next-page') return Math.min(count - 1, current + canvasPalettePageSize)
  if (key === 'previous-page') return Math.max(0, current - canvasPalettePageSize)
  if (key === 'next') return (current + 1) % count
  if (key === 'previous') return (current - 1 + count) % count
  return current
}

/** Keep every result reachable without mounting the whole graph in a popup. */
export function canvasPaletteWindow(index: number, count: number): { start: number; end: number } {
  const start = Math.floor(clampCanvasPaletteIndex(index, count) / canvasPalettePageSize) * canvasPalettePageSize
  return { start, end: Math.min(count, start + canvasPalettePageSize) }
}

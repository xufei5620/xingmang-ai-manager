import { useSyncExternalStore } from 'react'

/**
 * The width at which styles.css floats side panels over the canvas and, while
 * one is open, squeezes the creation library into its 48px rail. Keep it equal
 * to the `max-width: 1180px` blocks there and in canvas-agent.css.
 */
export const canvasNarrowLayoutQuery = '(max-width: 1180px)'

type MediaQuery = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>
type MatchMedia = (query: string) => MediaQuery

function windowMatchMedia(): MatchMedia | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? (query) => window.matchMedia(query) : null
}

export function subscribeCanvasNarrowLayout(onChange: () => void, matchMedia: MatchMedia | null = windowMatchMedia()): () => void {
  const query = matchMedia?.(canvasNarrowLayoutQuery)
  if (!query) return () => {}
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function readCanvasNarrowLayout(matchMedia: MatchMedia | null = windowMatchMedia()): boolean {
  return matchMedia?.(canvasNarrowLayoutQuery).matches === true
}

/** Whether the canvas window is narrow enough for the floating-panel layout; false outside a browser. */
export function useCanvasNarrowLayout(): boolean {
  return useSyncExternalStore(subscribeCanvasNarrowLayout, readCanvasNarrowLayout, () => false)
}

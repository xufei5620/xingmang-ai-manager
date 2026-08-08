export interface RendererErrorDeduper {
  /**
   * Claims a thrown value for reporting. Returns true the first time a given
   * value is claimed (the caller should report it) and false on every later
   * claim of the same value (some earlier caller already reported it).
   */
  claim(error: unknown): boolean
}

/**
 * React's development build re-dispatches a render-phase error through a
 * fake DOM event so the browser's native error overlay still sees it. That
 * makes the exact same Error object reach window.onerror in addition to the
 * nearest error boundary's componentDidCatch. Production builds never do
 * this (an error boundary's try/catch is the only consumer), so the overlap
 * is dev-only, but sharing one deduper between main.tsx's global listeners
 * and ErrorBoundary keeps a single crash from being logged twice either way.
 */
export function createRendererErrorDeduper(): RendererErrorDeduper {
  const claimed = new WeakSet<object>()
  return {
    claim(error) {
      // Only object-like throws (the overwhelming majority: Error instances)
      // can be tracked by identity. A primitive throw (`throw 'x'`) cannot be
      // deduplicated safely, so it is always reported rather than silently
      // dropped.
      if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return true
      if (claimed.has(error)) return false
      claimed.add(error)
      return true
    },
  }
}

// Shared across the whole renderer process: main.tsx's window-level
// listeners and every ErrorBoundary instance must agree on what has already
// been reported.
export const rendererErrorDeduper: RendererErrorDeduper = createRendererErrorDeduper()

export function reportRendererError(message: string, stack?: string, context?: string): void {
  void window.xingmang.reportRendererError({ message, stack, context }).catch(() => undefined)
}

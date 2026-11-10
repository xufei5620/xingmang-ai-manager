import { useEffect, useState } from 'react'
import { hostBridge, type CanvasPriceSnapshot } from '../host'
import type { CanvasRunPreflight } from '../runtime/run-preflight'
import { buildCanvasRunQuote, readCanvasPriceSnapshot, type CanvasRunQuoteView } from '../runtime/run-quote'

/**
 * 「预计约 $x」 for the preflight on screen. Asks the host once per preflight
 * (the host keeps its own cache); a failed or malformed answer prices nothing,
 * which reads 价格未知 rather than a made-up number. Null where the host
 * offers no price list, or when nothing in the run is paid.
 */
export function useCanvasRunQuote(preflight: CanvasRunPreflight | null, enabled: boolean): CanvasRunQuoteView | null {
  const [answer, setAnswer] = useState<{ preflight: CanvasRunPreflight; snapshot: CanvasPriceSnapshot | null } | null>(null)
  useEffect(() => {
    if (!enabled || !preflight || !buildCanvasRunQuote(preflight, null)) return
    let current = true
    const bridge = hostBridge()
    void readCanvasPriceSnapshot(bridge.getPriceSnapshot?.bind(bridge))
      .then((snapshot) => { if (current) setAnswer({ preflight, snapshot }) })
    return () => { current = false }
  }, [enabled, preflight])
  if (!enabled || !preflight) return null
  if (answer?.preflight === preflight) {
    const quote = buildCanvasRunQuote(preflight, answer.snapshot)
    return quote ? { state: 'ready', quote } : null
  }
  return buildCanvasRunQuote(preflight, null) ? { state: 'loading' } : null
}

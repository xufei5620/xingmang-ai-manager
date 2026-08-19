export type CanvasNodeLod = 'detail' | 'summary'

/** Smallest glyph height a reader can still resolve, in physical pixels. */
export const canvasNodeMinimumReadablePx = 8
/** Matches --text-xs, the smallest type the node body is allowed to use. */
export const canvasNodeBaseFontPx = 11
/** Detail resumes slightly above the entry point so the mode cannot flicker. */
export const canvasNodeLodHysteresis = 1.12

/**
 * Zoom at which the smallest node type would fall below the readable floor.
 *
 * A higher pixel density improves legibility sub-linearly, not linearly, so the
 * device ratio enters under a square root: doubling DPR buys roughly 40% more
 * readable shrink, not 100%. The previous fixed 0.52 happened to be correct for
 * a 2x display only, which meant a 1x display kept rendering 11px type down to
 * about 5.7px before switching to the summary.
 */
export function canvasNodeSummaryEnterZoomFor(devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  return canvasNodeMinimumReadablePx / (canvasNodeBaseFontPx * Math.sqrt(ratio))
}

export function canvasNodeSummaryExitZoomFor(devicePixelRatio: number): number {
  return canvasNodeSummaryEnterZoomFor(devicePixelRatio) * canvasNodeLodHysteresis
}

function currentDevicePixelRatio(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio
}

export function canvasNodeLodForZoom(
  zoom: number,
  current: CanvasNodeLod = 'detail',
  devicePixelRatio: number = currentDevicePixelRatio(),
): CanvasNodeLod {
  if (!Number.isFinite(zoom)) return 'detail'
  const enter = canvasNodeSummaryEnterZoomFor(devicePixelRatio)
  if (current === 'summary') return zoom < enter * canvasNodeLodHysteresis ? 'summary' : 'detail'
  return zoom < enter ? 'summary' : 'detail'
}

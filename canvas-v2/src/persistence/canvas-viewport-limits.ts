import { maximumCoordinateMagnitude, maximumWorkflowNodes } from './workflow-schema'

// A chain can accumulate one legal coordinate per parent in both directions,
// plus a legal node dimension. One pixel across that whole span is the lower
// numerical bound, rather than a readability floor that clips large graphs.
export const maximumCanvasWorldSpan = (maximumWorkflowNodes * 2 + 1) * maximumCoordinateMagnitude
export const minimumCanvasViewportZoom = 1 / maximumCanvasWorldSpan
export const maximumCanvasViewportZoom = 8
export const maximumCanvasViewportTranslation = maximumCanvasWorldSpan * maximumCanvasViewportZoom

export function finiteCanvasViewportTranslation(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximumCanvasViewportTranslation
}

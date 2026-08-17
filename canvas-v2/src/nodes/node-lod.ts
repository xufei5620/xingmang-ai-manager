export type CanvasNodeLod = 'detail' | 'summary'

export const canvasNodeSummaryEnterZoom = 0.52
export const canvasNodeSummaryExitZoom = 0.58

export function canvasNodeLodForZoom(zoom: number, current: CanvasNodeLod = 'detail'): CanvasNodeLod {
  if (!Number.isFinite(zoom)) return 'detail'
  if (current === 'summary') return zoom < canvasNodeSummaryExitZoom ? 'summary' : 'detail'
  return zoom < canvasNodeSummaryEnterZoom ? 'summary' : 'detail'
}

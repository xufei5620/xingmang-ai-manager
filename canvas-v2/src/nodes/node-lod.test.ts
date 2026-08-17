import { describe, expect, it } from 'vitest'
import { canvasNodeLodForZoom, canvasNodeSummaryEnterZoom, canvasNodeSummaryExitZoom } from './node-lod'

describe('canvasNodeLodForZoom', () => {
  it('uses a summary below the contextual zoom threshold', () => {
    expect(canvasNodeLodForZoom(canvasNodeSummaryEnterZoom - 0.01)).toBe('summary')
  })

  it('keeps full node content at and above the entry threshold', () => {
    expect(canvasNodeLodForZoom(canvasNodeSummaryEnterZoom)).toBe('detail')
    expect(canvasNodeLodForZoom(1.5)).toBe('detail')
  })

  it('uses hysteresis to avoid flicker around the threshold', () => {
    const midpoint = (canvasNodeSummaryEnterZoom + canvasNodeSummaryExitZoom) / 2
    expect(canvasNodeLodForZoom(midpoint, 'detail')).toBe('detail')
    expect(canvasNodeLodForZoom(midpoint, 'summary')).toBe('summary')
    expect(canvasNodeLodForZoom(canvasNodeSummaryExitZoom, 'summary')).toBe('detail')
  })

  it('fails open for invalid viewport values', () => {
    expect(canvasNodeLodForZoom(Number.NaN)).toBe('detail')
    expect(canvasNodeLodForZoom(Number.POSITIVE_INFINITY)).toBe('detail')
  })
})

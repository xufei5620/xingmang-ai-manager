import { describe, expect, it } from 'vitest'
import {
  canvasNodeBaseFontPx,
  canvasNodeLodForZoom,
  canvasNodeMinimumReadablePx,
  canvasNodeSummaryEnterZoomFor,
  canvasNodeSummaryExitZoomFor,
} from './node-lod'

const standard = canvasNodeSummaryEnterZoomFor(1)

describe('canvasNodeLodForZoom', () => {
  it('uses a summary below the contextual zoom threshold', () => {
    expect(canvasNodeLodForZoom(standard - 0.01, 'detail', 1)).toBe('summary')
  })

  it('keeps full node content at and above the entry threshold', () => {
    expect(canvasNodeLodForZoom(standard, 'detail', 1)).toBe('detail')
    expect(canvasNodeLodForZoom(1.5, 'detail', 1)).toBe('detail')
  })

  it('uses hysteresis to avoid flicker around the threshold', () => {
    const midpoint = (standard + canvasNodeSummaryExitZoomFor(1)) / 2
    expect(canvasNodeLodForZoom(midpoint, 'detail', 1)).toBe('detail')
    expect(canvasNodeLodForZoom(midpoint, 'summary', 1)).toBe('summary')
    expect(canvasNodeLodForZoom(canvasNodeSummaryExitZoomFor(1), 'summary', 1)).toBe('detail')
  })

  it('fails open for invalid viewport values', () => {
    expect(canvasNodeLodForZoom(Number.NaN, 'detail', 1)).toBe('detail')
    expect(canvasNodeLodForZoom(Number.POSITIVE_INFINITY, 'detail', 1)).toBe('detail')
  })
})

describe('canvasNodeSummaryEnterZoomFor', () => {
  it('never lets the smallest node type render below the readable floor', () => {
    for (const ratio of [1, 1.25, 1.5, 2, 3]) {
      const zoom = canvasNodeSummaryEnterZoomFor(ratio)
      const physicalPx = canvasNodeBaseFontPx * zoom * Math.sqrt(ratio)
      expect(physicalPx).toBeCloseTo(canvasNodeMinimumReadablePx, 6)
    }
  })

  it('switches to the summary earlier on a low density display', () => {
    // The old fixed 0.52 was only correct for 2x. A 1x display has to give up
    // detail sooner, not later, because it has no extra pixels to spend.
    expect(canvasNodeSummaryEnterZoomFor(1)).toBeGreaterThan(canvasNodeSummaryEnterZoomFor(2))
    expect(canvasNodeSummaryEnterZoomFor(1)).toBeCloseTo(0.727, 3)
    expect(canvasNodeSummaryEnterZoomFor(2)).toBeCloseTo(0.514, 3)
  })

  it('falls back to a 1x assumption for nonsense ratios', () => {
    for (const ratio of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(canvasNodeSummaryEnterZoomFor(ratio)).toBeCloseTo(standard, 10)
    }
  })
})

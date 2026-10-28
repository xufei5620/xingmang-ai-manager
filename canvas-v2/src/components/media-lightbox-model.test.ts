import { describe, expect, it } from 'vitest'
import { mediaPreviewFitZoom, mediaPreviewFocusIndex, mediaPreviewStepZoom } from './media-lightbox-model'

describe('media preview view controls', () => {
  it('fits a portrait and a landscape without upscaling a small asset', () => {
    expect(mediaPreviewFitZoom({ width: 2000, height: 4000 }, { width: 1000, height: 600 })).toBe(0.15)
    expect(mediaPreviewFitZoom({ width: 4000, height: 2000 }, { width: 1000, height: 600 })).toBe(0.25)
    expect(mediaPreviewFitZoom({ width: 64, height: 64 }, { width: 1000, height: 600 })).toBe(1)
  })

  it('bounds manual zoom and can step back from enlarged details', () => {
    expect(mediaPreviewStepZoom(4, 1)).toBe(4)
    expect(mediaPreviewStepZoom(0.01, -1)).toBe(0.01)
    expect(mediaPreviewStepZoom(mediaPreviewStepZoom(1, 1), -1)).toBe(1)
  })

  it('wraps both ends of the preview without hijacking intermediate tab stops', () => {
    expect(mediaPreviewFocusIndex(4, 3, false)).toBe(0)
    expect(mediaPreviewFocusIndex(4, 0, true)).toBe(3)
    expect(mediaPreviewFocusIndex(4, -1, false)).toBe(0)
    expect(mediaPreviewFocusIndex(4, 1, false)).toBeNull()
    expect(mediaPreviewFocusIndex(0, -1, false)).toBeNull()
  })
})

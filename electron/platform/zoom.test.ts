import { describe, expect, it } from 'vitest'
import { calculatePlatformZoom, UI_DESIGN_WIDTH_DIP, UI_MAX_ZOOM, UI_MIN_ZOOM } from './zoom'
import {
  calculateUiZoom,
  resolveWindowPlacement,
  UI_DESIGN_WIDTH_DIP as WINDOW_DESIGN_WIDTH_DIP,
  UI_MAX_ZOOM as WINDOW_MAX_ZOOM,
  UI_MIN_ZOOM as WINDOW_MIN_ZOOM,
} from '../window-preferences'

const SCALES = ['auto', '90', '100', '110'] as const

// Both appliers are registered on the same window for the same two events
// (resize, did-finish-load), so whichever listener runs last writes the zoom
// the user sees. These tests pin the only property that makes that ordering
// irrelevant: the two entry points cannot produce different numbers.
describe('a single window zoom formula', () => {
  it('shares one set of constants between the two entry points', () => {
    expect(UI_MIN_ZOOM).toBe(WINDOW_MIN_ZOOM)
    expect(UI_MAX_ZOOM).toBe(WINDOW_MAX_ZOOM)
    expect(UI_DESIGN_WIDTH_DIP).toBe(WINDOW_DESIGN_WIDTH_DIP)
  })

  it('keeps the floor at the value the narrowest allowed window needs', () => {
    expect(UI_MIN_ZOOM).toBe(0.7)
    expect(UI_MAX_ZOOM).toBe(1.25)
    expect(UI_DESIGN_WIDTH_DIP).toBe(1280)
  })

  it('agrees on every scale across the widths where the two formulas used to differ', () => {
    for (let width = 320; width <= 3840; width += 16) {
      for (const scale of SCALES) {
        expect(calculatePlatformZoom(width, scale)).toBe(calculateUiZoom(width, scale))
      }
    }
  })

  it('agrees on invalid widths instead of each choosing its own fallback', () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(calculatePlatformZoom(width)).toBe(calculateUiZoom(width))
    }
  })

  it('scales the minimum-width window to exactly the design width', () => {
    // resolveWindowPlacement never lets the window go below 960 DIP on a
    // display this size, and 960 / 0.75 === 1280: the renderer lays out at its
    // design width. The retired 0.8 floor produced 1200 instead, cropping it.
    const placement = resolveWindowPlacement(
      undefined,
      [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
      1,
    )
    expect(placement.minimumSize.width).toBe(960)
    const zoom = calculateUiZoom(placement.minimumSize.width)
    expect(zoom).toBe(0.75)
    expect(placement.minimumSize.width / zoom).toBe(UI_DESIGN_WIDTH_DIP)
  })

  it('reports the width band where the retired 0.8 floor used to disagree', () => {
    // Below 1024 DIP the old main-process copy clamped to 0.8 while the
    // platform copy followed the ratio. 1024 is where they met.
    expect(calculatePlatformZoom(1023)).toBeLessThan(0.8)
    expect(calculatePlatformZoom(1024)).toBe(0.8)
    expect(calculatePlatformZoom(1025)).toBeGreaterThan(0.8)
  })
})

import { describe, expect, it } from 'vitest'
import { calculatePlatformZoom, UI_AUTO_MIN_ZOOM, UI_DESIGN_WIDTH_DIP, UI_MAX_ZOOM, UI_MIN_ZOOM } from './zoom'
import {
  calculateUiZoom,
  resolveWindowPlacement,
  UI_AUTO_MIN_ZOOM as WINDOW_AUTO_MIN_ZOOM,
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
    expect(UI_AUTO_MIN_ZOOM).toBe(WINDOW_AUTO_MIN_ZOOM)
    expect(UI_MIN_ZOOM).toBe(WINDOW_MIN_ZOOM)
    expect(UI_MAX_ZOOM).toBe(WINDOW_MAX_ZOOM)
    expect(UI_DESIGN_WIDTH_DIP).toBe(WINDOW_DESIGN_WIDTH_DIP)
  })

  it('keeps the UI v4.0 floors: 0.9 for the automatic factor, 0.85 after the user multiplier', () => {
    expect(UI_AUTO_MIN_ZOOM).toBe(0.9)
    expect(UI_MIN_ZOOM).toBe(0.85)
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

  it('reads the minimum-width window at 90% instead of squeezing it into the design width', () => {
    // resolveWindowPlacement never lets the window go below 960 DIP on a
    // display this size. Until UI v4.0 the 0.7 floor let 960 / 0.75 fill the
    // 1280 design width, which shrank the text to 75%; now the logical width
    // stays narrower than 1280 and the shell collapses the sidebar instead.
    const placement = resolveWindowPlacement(
      undefined,
      [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
      1,
    )
    expect(placement.minimumSize.width).toBe(960)
    const zoom = calculateUiZoom(placement.minimumSize.width)
    expect(zoom).toBe(0.9)
    expect(placement.minimumSize.width / zoom).toBeLessThan(UI_DESIGN_WIDTH_DIP)
    expect(calculateUiZoom(placement.minimumSize.width, '90')).toBe(0.85)
  })

  it('follows the width ratio only above the automatic floor', () => {
    // 1152 / 1280 === 0.9: narrower windows all read at the floor.
    expect(calculatePlatformZoom(1000)).toBe(0.9)
    expect(calculatePlatformZoom(1152)).toBe(0.9)
    expect(calculatePlatformZoom(1153)).toBeGreaterThan(0.9)
  })
})

import { describe, expect, it } from 'vitest'
import {
  calculateUiZoom,
  isWindowTitleReachable,
  parseWindowState,
  resolveCloseAction,
  resolveFittedWindowBounds,
  resolveRecoveredWindowBounds,
  resolveWindowPlacement,
  type AppWindowState,
  type WindowDisplay,
} from './window-preferences'

const primary: WindowDisplay = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const secondary: WindowDisplay = { id: 2, workArea: { x: -1920, y: -100, width: 1920, height: 1080 } }

function state(overrides: Partial<AppWindowState> = {}): AppWindowState {
  return { bounds: { x: 130, y: 100, width: 1280, height: 820 }, maximized: false, ...overrides }
}

describe('window placement', () => {
  it('uses proportional first-run bounds within the design limits', () => {
    expect(resolveWindowPlacement(undefined, [primary], primary.id)).toEqual({
      bounds: { x: 240, y: 78, width: 1440, height: 884 },
      minimumSize: { width: 960, height: 560 },
      maximized: false,
      restored: false,
    })
  })

  it('keeps every edge reachable on a display smaller than the design minimum', () => {
    const small: WindowDisplay = { id: 3, workArea: { x: 40, y: 32, width: 800, height: 480 } }
    expect(resolveWindowPlacement(undefined, [small], small.id)).toEqual({
      bounds: small.workArea,
      minimumSize: { width: 800, height: 480 },
      maximized: true,
      restored: false,
    })
  })

  it('maximizes only a first-run small work area, preserving a saved restored preference', () => {
    const compact: WindowDisplay = { id: 3, workArea: { x: 0, y: 0, width: 1200, height: 700 } }
    expect(resolveWindowPlacement(undefined, [compact], 3).maximized).toBe(true)
    expect(resolveWindowPlacement(state(), [compact], 3).maximized).toBe(false)
  })

  it('preserves a valid user layout instead of enforcing first-run maximums', () => {
    const saved = state({ bounds: { x: 5, y: 6, width: 1800, height: 1000 }, maximized: true })
    const restored = resolveWindowPlacement(saved, [primary], primary.id)
    expect(restored.bounds).toEqual(saved.bounds)
    expect(restored.maximized).toBe(true)
    expect(restored.restored).toBe(true)
  })

  it('restores onto a secondary display with negative coordinates', () => {
    const saved = state({ bounds: { x: -1820, y: -50, width: 1280, height: 820 } })
    expect(resolveWindowPlacement(saved, [primary, secondary], primary.id).bounds).toEqual(saved.bounds)
  })

  it('centers a disconnected-screen window on the primary display and retains its size', () => {
    const saved = state({ bounds: { x: -1820, y: -50, width: 1280, height: 820 } })
    expect(resolveWindowPlacement(saved, [primary], primary.id).bounds).toEqual({
      x: 320, y: 110, width: 1280, height: 820,
    })
  })

  it('brings titlebar and actions back inside the work area after a taskbar or monitor change', () => {
    const saved = state({ bounds: { x: -10, y: -400, width: 1600, height: 1400 } })
    expect(resolveWindowPlacement(saved, [primary], primary.id).bounds).toEqual({
      x: 0, y: 0, width: 1600, height: 1040,
    })
  })

  it('uses the display containing most of a straddling window', () => {
    const saved = state({ bounds: { x: -1200, y: 30, width: 1440, height: 820 } })
    expect(resolveWindowPlacement(saved, [primary, secondary], primary.id).bounds).toEqual({
      x: -1440, y: 30, width: 1440, height: 820,
    })
  })

  it('raises an old onboarding-sized record only as much as the current minimum requires', () => {
    const saved = state({ bounds: { x: 10, y: 20, width: 720, height: 520 } })
    expect(resolveWindowPlacement(saved, [primary], primary.id).bounds).toEqual({
      x: 10, y: 20, width: 960, height: 560,
    })
  })

  it('falls back to the first usable display when the primary identity changes', () => {
    const broken = { id: 0, workArea: { x: 0, y: 0, width: 0, height: 0 } }
    expect(resolveWindowPlacement(undefined, [broken, secondary], primary.id).bounds.x).toBe(-1680)
    expect(() => resolveWindowPlacement(undefined, [broken], 0)).toThrow('No usable display work area')
  })
})

describe('recovering a window after displays change', () => {
  const onSecondary = { x: -1820, y: -50, width: 1280, height: 820 }

  it('leaves a window alone while its display is still connected', () => {
    expect(resolveRecoveredWindowBounds(onSecondary, onSecondary, [primary, secondary], primary.id)).toBeNull()
  })

  it('centers a window left on an unplugged display on the primary display at its restored size', () => {
    expect(resolveRecoveredWindowBounds(onSecondary, onSecondary, [primary], primary.id)).toEqual({
      x: 320, y: 110, width: 1280, height: 820,
    })
  })

  it('sizes a maximized window by its restored bounds, not the vanished display', () => {
    const maximized = secondary.workArea
    const restore = { x: -1700, y: 0, width: 1100, height: 700 }
    expect(resolveRecoveredWindowBounds(maximized, restore, [primary], primary.id)).toEqual({
      x: 410, y: 170, width: 1100, height: 700,
    })
  })

  it('shrinks a window that no longer fits onto a smaller primary display', () => {
    const laptop: WindowDisplay = { id: 5, workArea: { x: 0, y: 0, width: 1366, height: 728 } }
    const big = { x: 2000, y: 0, width: 1800, height: 1000 }
    expect(resolveRecoveredWindowBounds(big, big, [laptop], laptop.id)).toEqual({
      x: 0, y: 0, width: 1366, height: 728,
    })
  })

  it('does not move a window the user parked partly off screen while its title bar is still grabbable', () => {
    const parked = { x: 1700, y: 900, width: 1280, height: 820 }
    expect(isWindowTitleReachable(parked, [primary])).toBe(true)
    expect(resolveRecoveredWindowBounds(parked, parked, [primary], primary.id)).toBeNull()
  })

  it('moves a window whose title bar is above every work area even when its body is still visible', () => {
    const titleHidden = { x: 100, y: -200, width: 1280, height: 820 }
    expect(isWindowTitleReachable(titleHidden, [primary])).toBe(false)
    expect(resolveRecoveredWindowBounds(titleHidden, titleHidden, [primary], primary.id)).toEqual({
      x: 320, y: 110, width: 1280, height: 820,
    })
  })

  it('treats a thin sliver of title bar as unreachable', () => {
    const sliver = { x: 1880, y: 100, width: 1280, height: 820 }
    expect(isWindowTitleReachable(sliver, [primary])).toBe(false)
  })

  it('does nothing when no usable display is reported', () => {
    const broken = { id: 0, workArea: { x: 0, y: 0, width: 0, height: 0 } }
    expect(resolveRecoveredWindowBounds(onSecondary, onSecondary, [broken], 0)).toBeNull()
    expect(resolveRecoveredWindowBounds(onSecondary, onSecondary, [], 0)).toBeNull()
  })
})

describe('fitting a window that outgrew its display', () => {
  // 1080p 笔记本设 150%：工作区约 1280×672 DIP，任务栏在下面。
  const laptop: WindowDisplay = { id: 7, workArea: { x: 0, y: 0, width: 1280, height: 672 } }
  const mainMinimum = { width: 960, height: 560 }
  const canvasMinimum = { width: 960, height: 620 }

  it('shrinks a window the system moved off an unplugged monitor into the remaining work area', () => {
    const movedOver = { x: 40, y: 20, width: 1440, height: 900 }
    expect(resolveFittedWindowBounds(movedOver, mainMinimum, [laptop])).toEqual({ x: 0, y: 0, width: 1280, height: 672 })
  })

  it('trims only the height after the system scale went from 125 to 150 percent', () => {
    const rescaled = { x: 25, y: 0, width: 1229, height: 694 }
    expect(resolveFittedWindowBounds(rescaled, mainMinimum, [laptop])).toEqual({ x: 25, y: 0, width: 1229, height: 672 })
  })

  it('pulls the shrunk window fully inside the display it overlaps most', () => {
    const external: WindowDisplay = { id: 8, workArea: { x: 1280, y: 0, width: 1920, height: 1040 } }
    const tall = { x: 1700, y: 300, width: 1400, height: 1200 }
    expect(resolveFittedWindowBounds(tall, mainMinimum, [laptop, external])).toEqual({ x: 1700, y: 0, width: 1400, height: 1040 })
  })

  it('fits the canvas window the same way without going under its own minimum size', () => {
    const canvas = { x: 100, y: 50, width: 1360, height: 860 }
    expect(resolveFittedWindowBounds(canvas, canvasMinimum, [laptop])).toEqual({ x: 0, y: 0, width: 1280, height: 672 })
    const shortLaptop: WindowDisplay = { id: 9, workArea: { x: 0, y: 0, width: 1097, height: 569 } }
    expect(resolveFittedWindowBounds(canvas, canvasMinimum, [shortLaptop])).toEqual({ x: 0, y: 0, width: 1097, height: 620 })
  })

  it('keeps the title bar on screen when even the minimum size cannot fit', () => {
    const tiny: WindowDisplay = { id: 10, workArea: { x: -800, y: 30, width: 800, height: 500 } }
    expect(resolveFittedWindowBounds({ x: -900, y: 10, width: 1000, height: 600 }, mainMinimum, [tiny])).toEqual({
      x: -800, y: 30, width: 960, height: 560,
    })
  })

  it('leaves a window that already fits, even when the user parked it partly off screen', () => {
    expect(resolveFittedWindowBounds({ x: 0, y: 0, width: 1280, height: 672 }, mainMinimum, [laptop])).toBeNull()
    expect(resolveFittedWindowBounds({ x: 900, y: 400, width: 1000, height: 600 }, mainMinimum, [laptop])).toBeNull()
  })

  it('leaves a window the user stretched across two side-by-side monitors', () => {
    const left: WindowDisplay = { id: 11, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
    const right: WindowDisplay = { id: 12, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }
    expect(resolveFittedWindowBounds({ x: 600, y: 100, width: 2600, height: 900 }, mainMinimum, [left, right])).toBeNull()
  })

  it('ignores a one-point seam between displays when checking a stretched window', () => {
    const left: WindowDisplay = { id: 13, workArea: { x: 0, y: 0, width: 1280, height: 672 } }
    const right: WindowDisplay = { id: 14, workArea: { x: 1281, y: 0, width: 1920, height: 1040 } }
    expect(resolveFittedWindowBounds({ x: 400, y: 0, width: 2000, height: 600 }, mainMinimum, [left, right])).toBeNull()
  })

  it('still fits a stretched window once part of it hangs outside every work area', () => {
    const left: WindowDisplay = { id: 15, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
    const right: WindowDisplay = { id: 16, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }
    expect(resolveFittedWindowBounds({ x: 600, y: 100, width: 2600, height: 1000 }, mainMinimum, [left, right])).toEqual({
      x: 0, y: 40, width: 1920, height: 1000,
    })
  })

  it('leaves windows on no display to the off-screen recovery', () => {
    expect(resolveFittedWindowBounds({ x: 3000, y: 0, width: 1440, height: 900 }, mainMinimum, [laptop])).toBeNull()
    expect(resolveFittedWindowBounds({ x: 0, y: 0, width: 1440, height: 900 }, mainMinimum, [])).toBeNull()
  })
})

describe('window settings validation', () => {
  it.each([
    null,
    [],
    { bounds: { x: 0, y: 0, width: 1200, height: 800 } },
    state({ maximized: 'true' as unknown as boolean }),
    state({ bounds: { x: Number.NaN, y: 0, width: 1200, height: 800 } }),
    state({ bounds: { x: 0, y: Number.POSITIVE_INFINITY, width: 1200, height: 800 } }),
    state({ bounds: { x: 0, y: 0, width: -1, height: 800 } }),
    state({ bounds: { x: 0, y: 0, width: 1e9, height: 800 } }),
    state({ bounds: { x: 0.5, y: 0, width: 1200, height: 800 } }),
  ])('rejects an invalid saved window record: %j', (value) => {
    expect(parseWindowState(value)).toBeUndefined()
  })

  it('copies the validated bounds rather than exposing mutable input state', () => {
    const saved = state()
    const parsed = parseWindowState(saved)!
    parsed.bounds.x = 900
    expect(saved.bounds.x).toBe(130)
  })
})

describe('automatic DIP zoom', () => {
  it.each([
    [960, 'auto', 0.9],
    [1152, 'auto', 0.9],
    [1280, 'auto', 1],
    [1600, 'auto', 1.25],
    [1920, 'auto', 1.25],
    [1280, '90', 0.9],
    [1280, '110', 1.1],
    [1440, '100', 1.125],
    [960, '90', 0.85],
    [1152, '90', 0.85],
    [1920, '110', 1.25],
  ] as const)('calculates the whole WebContents width %i DIP with %s preference', (width, preference, expected) => {
    expect(calculateUiZoom(width, preference)).toBe(expected)
  })

  it('keeps 100 percent relative to automatic zoom, without a second DPI multiplier', () => {
    expect(calculateUiZoom(1440, '100')).toBe(calculateUiZoom(1440, 'auto'))
    expect(calculateUiZoom(1440, '100')).not.toBe(1)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('uses a readable fallback while content width is invalid: %s', (width) => {
    expect(calculateUiZoom(width, '90')).toBe(1)
  })
})

describe('close preference decisions', () => {
  it('never hides into an unavailable tray', () => {
    expect(resolveCloseAction('tray', false)).toBe('keep-visible')
    expect(resolveCloseAction('tray', true)).toBe('hide')
  })

  it('requires a prompt by default and preserves an explicit quit request', () => {
    expect(resolveCloseAction(undefined, false)).toBe('prompt')
    expect(resolveCloseAction('ask', true)).toBe('prompt')
    expect(resolveCloseAction('quit', false)).toBe('quit')
  })
})

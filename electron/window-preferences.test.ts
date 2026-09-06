import { describe, expect, it } from 'vitest'
import {
  calculateUiZoom,
  parseWindowState,
  resolveCloseAction,
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
    [960, 'auto', 0.8],
    [1280, 'auto', 1],
    [1600, 'auto', 1.25],
    [1920, 'auto', 1.25],
    [1280, '90', 0.9],
    [1280, '110', 1.1],
    [1440, '100', 1.125],
    [960, '90', 0.8],
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

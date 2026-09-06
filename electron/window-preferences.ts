export type AppUiScale = 'auto' | '90' | '100' | '110'
export type AppCloseBehavior = 'ask' | 'tray' | 'quit'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface AppWindowState {
  /** Normal (restored) bounds, never maximized or fullscreen bounds. */
  bounds: WindowBounds
  maximized: boolean
}

export interface WindowDisplay {
  id: number | string
  workArea: WindowBounds
}

export interface WindowPlacement {
  bounds: WindowBounds
  minimumSize: { width: number; height: number }
  maximized: boolean
  restored: boolean
}

export const UI_DESIGN_WIDTH_DIP = 1280
export const UI_MIN_ZOOM = 0.8
export const UI_MAX_ZOOM = 1.25

const MAX_WINDOW_DIMENSION = 32_768
const MAX_WINDOW_COORDINATE = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function parseBounds(value: unknown): WindowBounds | undefined {
  if (!isRecord(value)
    || !isBoundedInteger(value.x, -MAX_WINDOW_COORDINATE, MAX_WINDOW_COORDINATE)
    || !isBoundedInteger(value.y, -MAX_WINDOW_COORDINATE, MAX_WINDOW_COORDINATE)
    || !isBoundedInteger(value.width, 1, MAX_WINDOW_DIMENSION)
    || !isBoundedInteger(value.height, 1, MAX_WINDOW_DIMENSION)) return undefined
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

export function parseWindowState(value: unknown): AppWindowState | undefined {
  if (!isRecord(value) || typeof value.maximized !== 'boolean') return undefined
  const bounds = parseBounds(value.bounds)
  return bounds ? { bounds, maximized: value.maximized } : undefined
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function intersectionArea(bounds: WindowBounds, workArea: WindowBounds): number {
  const width = Math.max(0, Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x))
  const height = Math.max(0, Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y))
  return width * height
}

export function resolveWindowPlacement(
  saved: AppWindowState | undefined,
  displays: readonly WindowDisplay[],
  primaryId: WindowDisplay['id'],
): WindowPlacement {
  const available = displays.filter((display) => parseBounds(display.workArea))
  const primary = available.find((display) => display.id === primaryId) ?? available[0]
  if (!primary) throw new Error('No usable display work area')

  const state = parseWindowState(saved)
  let display = primary
  let visibleArea = 0
  if (state) {
    for (const candidate of available) {
      const area = intersectionArea(state.bounds, candidate.workArea)
      if (area > visibleArea) {
        display = candidate
        visibleArea = area
      }
    }
  }

  const area = display.workArea
  const minimumSize = { width: Math.min(960, area.width), height: Math.min(560, area.height) }
  // The initial target limits are not restoration limits: preserve an existing
  // large user layout when it still fits the selected display.
  const width = state
    ? clamp(state.bounds.width, minimumSize.width, area.width)
    : clamp(Math.round(area.width * 0.8), minimumSize.width, Math.min(1440, area.width))
  const height = state
    ? clamp(state.bounds.height, minimumSize.height, area.height)
    : clamp(Math.round(area.height * 0.85), minimumSize.height, Math.min(900, area.height))
  const center = {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
  }
  return {
    bounds: {
      x: state && visibleArea > 0 ? clamp(state.bounds.x, area.x, area.x + area.width - width) : center.x,
      y: state && visibleArea > 0 ? clamp(state.bounds.y, area.y, area.y + area.height - height) : center.y,
      width,
      height,
    },
    minimumSize,
    maximized: state?.maximized ?? (area.width < 1280 || area.height < 720),
    restored: state !== undefined,
  }
}

/** Uses the complete WebContents width in DIP, before browser zoom. */
export function calculateUiZoom(contentWidthDip: number, scale: AppUiScale = 'auto'): number {
  if (!Number.isFinite(contentWidthDip) || contentWidthDip <= 0) return 1
  const automatic = clamp(contentWidthDip / UI_DESIGN_WIDTH_DIP, UI_MIN_ZOOM, UI_MAX_ZOOM)
  const multiplier = scale === '90' ? 0.9 : scale === '110' ? 1.1 : 1
  return Math.round(clamp(automatic * multiplier, UI_MIN_ZOOM, UI_MAX_ZOOM) * 10_000) / 10_000
}

export function resolveCloseAction(
  preference: AppCloseBehavior = 'ask',
  trayAvailable: boolean,
): 'prompt' | 'hide' | 'quit' | 'keep-visible' {
  if (preference === 'ask') return 'prompt'
  if (preference === 'quit') return 'quit'
  return trayAvailable ? 'hide' : 'keep-visible'
}

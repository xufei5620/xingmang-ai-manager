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
// The floor is what the narrowest allowed window needs, not a readability
// preference. resolveWindowPlacement pins the minimum width at 960 DIP, and
// 960 / 1280 = 0.75, so any floor above 0.75 stops the renderer from laying
// out at its 1280 design width and crops the layout instead of scaling it.
// 0.7 leaves headroom for the displays whose work area is narrower than 960.
export const UI_MIN_ZOOM = 0.7
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

// 标题栏是用户唯一能抓住窗口拖回来的地方。它在任何一块屏幕上还露出一截抓得住
// 的，就当是用户自己拖到边上的，不去动它；只有整条标题栏都够不着才挪。
const TITLE_BAND_HEIGHT = 36
const REACHABLE_TITLE_WIDTH = 100
const REACHABLE_TITLE_HEIGHT = 20

function overlapSize(bounds: WindowBounds, workArea: WindowBounds): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x)),
    height: Math.max(0, Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y)),
  }
}

export function isWindowTitleReachable(bounds: WindowBounds, displays: readonly WindowDisplay[]): boolean {
  const band = { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.min(TITLE_BAND_HEIGHT, bounds.height) }
  const minimumWidth = Math.min(REACHABLE_TITLE_WIDTH, band.width)
  const minimumHeight = Math.min(REACHABLE_TITLE_HEIGHT, band.height)
  return displays.some((display) => {
    if (!parseBounds(display.workArea)) return false
    const overlap = overlapSize(band, display.workArea)
    return overlap.width >= minimumWidth && overlap.height >= minimumHeight
  })
}

/**
 * 窗口创建之后显示器还会变：白天拖到外接屏上、缩到托盘，晚上拔线回家再从托盘
 * 唤出，窗口就停在一块已经不存在的屏幕坐标上。`visible` 是窗口此刻的实际位置
 * （最大化时就是最大化后的位置），`restore` 是还原尺寸；够不着时按还原尺寸挪回
 * 主屏居中。返回 null 表示不用动，或者根本没有能用的屏幕可挪。
 */
export function resolveRecoveredWindowBounds(
  visible: WindowBounds,
  restore: WindowBounds,
  displays: readonly WindowDisplay[],
  primaryId: WindowDisplay['id'],
): WindowBounds | null {
  const available = displays.filter((display) => parseBounds(display.workArea))
  const primary = available.find((display) => display.id === primaryId) ?? available[0]
  if (!primary || isWindowTitleReachable(visible, available)) return null
  const area = primary.workArea
  const width = clamp(restore.width, Math.min(960, area.width), area.width)
  const height = clamp(restore.height, Math.min(560, area.height), area.height)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  }
}

/**
 * Uses the complete WebContents width in DIP, before browser zoom.
 *
 * This is the only zoom formula in the product. Two windows-level appliers
 * call it -- main.ts on resize/did-finish-load and platform/renderer-v2.ts on
 * the same two events -- and both are registered on the same window, so the
 * one that happens to run last decides the zoom the user sees. That is only
 * safe while they cannot disagree: platform/zoom.ts must keep delegating here
 * rather than re-deriving the clamp. 之前两份公式的下限分别是 0.8 和 0.7,
 * 960 宽时各自算出 0.8 与 0.75, 谁生效纯靠监听注册顺序。
 */
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

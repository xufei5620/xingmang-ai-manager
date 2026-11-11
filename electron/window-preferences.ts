import { isRecord } from './input-guards'

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
// Two floors since UI v4.0 (ui-spec/03-layout-window.md §1). The automatic
// factor stops at 0.9 so the 960 DIP minimum window still reads at 90%
// instead of 75%; the logical width then drops below 1280 and the shell
// collapses the sidebar into its rail to make room, rather than the text
// shrinking past legibility. The user's 90% multiplier may take it one step
// lower, but never below 0.85.
export const UI_AUTO_MIN_ZOOM = 0.9
export const UI_MIN_ZOOM = 0.85
// Two ceilings for the same reason in the other direction (D79, 2026-11-10).
// The automatic factor still stops at 1.25, so a user on "自动" sees exactly
// what they saw before. The final clamp used to be 1.25 as well, which
// swallowed the 110% multiplier on any window wider than about 1455 DIP: a
// maximized 1080p desktop already sits at 1.25, so 110% changed nothing.
// The final ceiling is the automatic one times the 110% multiplier, so that
// step is always 10% larger than automatic at every width.
export const UI_AUTO_MAX_ZOOM = 1.25
export const UI_MAX_ZOOM = 1.375

// 第一次打开（没记过窗口位置）的两条下限（D80，2026-11-10）。以前初始宽 = 工作区宽 × 0.8、
// 工作区不到 1280×720 才最大化：1366×768、1280×800 这类最常见的便宜笔记本开出来只有 1093、1024 宽，
// 缩放落到下限 0.9，逻辑宽不到 1280，侧栏收成只有图标的窄条，右边还空着一大块。
// 1152 × 0.9 正好是 1280 逻辑宽，侧栏能展开；工作区宽不到 1440 时 × 0.8 够不着 1152，
// 干脆最大化，还原时也至少有 1152 宽。记过窗口位置的人走上面那条分支，一个数都不变。
const FIRST_RUN_MIN_WIDTH = 1152
const FIRST_RUN_MAXIMIZE_BELOW_WIDTH = 1440

const MAX_WINDOW_DIMENSION = 32_768
const MAX_WINDOW_COORDINATE = 1_000_000

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
    : clamp(Math.round(area.width * 0.8), Math.min(FIRST_RUN_MIN_WIDTH, area.width), Math.min(1440, area.width))
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
    maximized: state?.maximized ?? (area.width < FIRST_RUN_MAXIMIZE_BELOW_WIDTH || area.height < 720),
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

// 显示器之间按 DIP 换算后可能差一两个点的缝，不算露在屏幕外面。
const COVERAGE_TOLERANCE = 2

function containsPoint(area: WindowBounds, x: number, y: number): boolean {
  return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height
}

// 把窗口按各块工作区的边切成小格，每一格都落在某块工作区里，窗口才算整个看得见。
// 显示器最多几块，格子数可以忽略。
function isCoveredByWorkAreas(bounds: WindowBounds, areas: readonly WindowBounds[]): boolean {
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  const xs = new Set([bounds.x, right])
  const ys = new Set([bounds.y, bottom])
  for (const area of areas) {
    for (const x of [area.x, area.x + area.width]) if (x > bounds.x && x < right) xs.add(x)
    for (const y of [area.y, area.y + area.height]) if (y > bounds.y && y < bottom) ys.add(y)
  }
  const columns = [...xs].sort((a, b) => a - b)
  const rows = [...ys].sort((a, b) => a - b)
  for (let i = 1; i < columns.length; i += 1) {
    if (columns[i] - columns[i - 1] <= COVERAGE_TOLERANCE) continue
    const x = (columns[i - 1] + columns[i]) / 2
    for (let j = 1; j < rows.length; j += 1) {
      if (rows[j] - rows[j - 1] <= COVERAGE_TOLERANCE) continue
      const y = (rows[j - 1] + rows[j]) / 2
      if (!areas.some((area) => containsPoint(area, x, y))) return false
    }
  }
  return true
}

/**
 * 拔掉外接屏或者改了系统缩放，系统会把窗口挪到剩下那块屏上，但大小（DIP）照旧：
 * 1440×900 的窗口落到 1280×672 的笔记本工作区里，底部压在任务栏后面，右上角的
 * 关闭键跑到屏幕外。标题栏还抓得住，`resolveRecoveredWindowBounds` 不会管它。
 *
 * 只认「比它所在那块屏的工作区还大、而且确实有一截露在所有工作区外面」：跨两块屏
 * 摆的大窗口整个都在工作区里，不动；大小放得下、只是被用户拖到边上的，也不动。
 * 收小时不小于窗口的最小尺寸（系统也不让），放不下就贴住左上角，标题栏总在屏幕里。
 * `bounds` 是还原状态下的实际位置，最大化、全屏的窗口由调用方挡掉。返回 null 表示
 * 不用动；完全不在任何一块屏上的窗口也返回 null，交给 `resolveRecoveredWindowBounds`。
 */
export function resolveFittedWindowBounds(
  bounds: WindowBounds,
  minimumSize: { width: number; height: number },
  displays: readonly WindowDisplay[],
): WindowBounds | null {
  const available = displays.filter((display) => parseBounds(display.workArea))
  let display: WindowDisplay | undefined
  let visibleArea = 0
  for (const candidate of available) {
    const area = intersectionArea(bounds, candidate.workArea)
    if (area > visibleArea) {
      display = candidate
      visibleArea = area
    }
  }
  if (!display) return null
  const area = display.workArea
  if (bounds.width <= area.width && bounds.height <= area.height) return null
  if (isCoveredByWorkAreas(bounds, available.map((candidate) => candidate.workArea))) return null
  const width = Math.max(minimumSize.width, Math.min(bounds.width, area.width))
  const height = Math.max(minimumSize.height, Math.min(bounds.height, area.height))
  const fitted = {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height,
  }
  const unchanged = fitted.x === bounds.x && fitted.y === bounds.y && fitted.width === bounds.width && fitted.height === bounds.height
  return unchanged ? null : fitted
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
  const automatic = clamp(contentWidthDip / UI_DESIGN_WIDTH_DIP, UI_AUTO_MIN_ZOOM, UI_AUTO_MAX_ZOOM)
  const multiplier = scale === '90' ? 0.9 : scale === '110' ? 1.1 : 1
  return Math.round(clamp(automatic * multiplier, UI_MIN_ZOOM, UI_MAX_ZOOM) * 10_000) / 10_000
}

/** 「大字」「界面缩放」两项和「定过没有」的记录，字段与 AppSettings 同名。 */
export interface TextSizePreferences {
  largeText?: boolean
  uiScale?: AppUiScale
  textSizeChosen?: boolean
}

/**
 * Windows「设置 › 辅助功能 › 文本大小」调大以后（`systemTextScale` 是那个百分比，读不到为 null），
 * 系统弹框和托盘菜单的字都跟着大，界面里的网页内容不吃这一项。客户没定过字的大小（没开关过
 * 「大字」，缩放还是「自动」）时，替他打开一次「大字」（D81）；之后由他自己在设置里开关。
 * 只开「大字」、不动缩放：大字只放大说明文字和小字，布局和侧栏宽窄都不变。
 */
export function shouldFollowSystemTextSize(preferences: TextSizePreferences, systemTextScale: number | null): boolean {
  if (systemTextScale === null || systemTextScale <= 100) return false
  if (preferences.textSizeChosen === true || preferences.largeText === true) return false
  return preferences.uiScale === undefined || preferences.uiScale === 'auto'
}

export function resolveCloseAction(
  preference: AppCloseBehavior = 'ask',
  trayAvailable: boolean,
): 'prompt' | 'hide' | 'quit' | 'keep-visible' {
  if (preference === 'ask') return 'prompt'
  if (preference === 'quit') return 'quit'
  return trayAvailable ? 'hide' : 'keep-visible'
}

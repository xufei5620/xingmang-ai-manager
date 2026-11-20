import type { CrashReportInput } from './crash-report'

/**
 * 卡住时上报卡在哪段代码（0.2.24 排查后的「卡顿检测」，yoyo 2026-11-20「卡顿做」）。
 *
 * 每天的匿名统计早就在数「卡住」（usage-stats.ts：主进程计时器晚 2 秒以上、窗口没响应），可只有次数，
 * 0.2.24 卡住比 0.2.23 多出十倍也只能猜。这里只多做一件事：卡住的那一刻问出主进程或界面正跑在哪段
 * 代码，按崩溃上报那一套（crash-report.ts 打码、改写帧地址、按会话去重）发到 Sentry。
 *
 * 这个文件全是纯函数，不碰 Node：抓栈的后台线程在 main-hang-watchdog-worker.ts，管它的在
 * main-hang-watchdog.ts，界面那一半在 main.ts 的窗口「没响应」里。
 */

/** 主进程连续这么久没动弹才去抓卡在哪。比匿名统计的 2 秒长：短的那批多半是读盘、杀毒扫描，栈说明不了什么。 */
export const mainHangThresholdMs = 5_000

/**
 * Only this share of app sessions reports hangs at all. Sentry's free plan
 * holds 5,000 events a month for the whole organisation, crashes included,
 * and the daily usage ping already shows Windows machines logging more than
 * one stall a day each. A sample of sessions is plenty to see which code
 * blocks; letting every machine send would risk the quota running out and
 * real crashes being dropped for the rest of the month. Each sampled session
 * still sends at most one main-process and one renderer hang.
 */
export const hangReportSampleRate = 0.2

/** 界面卡住时 collectJavaScriptCallStack 在页面一句 JS 都不跑时永远不回，最多等这么久。 */
export const rendererCallStackTimeoutMs = 3_000

/** Same cap as crash-report.ts parses; deeper frames are Electron's own timers. */
const MAX_HANG_FRAMES = 60
const MAX_FRAME_FIELD_LENGTH = 2_048
const MAX_RENDERER_STACK_LENGTH = 16_000

/** workerData 里的这个标记让 main-hang-watchdog-worker.ts 认出自己是被当成后台线程起的；那边有一份一样的（它只许依赖 Node 自带模块），测试钉住两份相等。 */
export const mainHangWatchdogKind = 'xingmang-main-hang-watchdog'

export const mainHangMessage = '主进程卡住 5 秒以上'
export const rendererHangMessage = '界面卡住没响应'

/** One frame as the inspector reports it: line and column are 0-based (CDP). */
export interface MainHangFrame {
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
}

export interface MainHangCapture {
  /** From the last heartbeat before the stall to the first one after it. */
  stalledMs: number
  frames: MainHangFrame[]
  /**
   * The pause landed only after the main thread had already moved on, so the
   * frames show whatever ran first afterwards, not what blocked. That happens
   * when the time went to native work with no JavaScript of ours on the stack
   * (Chromium's own UI work, a system call made from outside JS).
   */
  afterRecovery: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_FRAME_FIELD_LENGTH || /[\r\n\0]/.test(value)) return null
  return value
}

function position(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parseFrame(value: unknown): MainHangFrame | null {
  if (!isRecord(value)) return null
  const functionName = boundedText(value.functionName)
  const url = boundedText(value.url)
  const lineNumber = position(value.lineNumber)
  const columnNumber = position(value.columnNumber)
  if (functionName === null || url === null || lineNumber === null || columnNumber === null) return null
  return { functionName, url, lineNumber, columnNumber }
}

/**
 * The worker is our own code, but its message still crosses a thread boundary
 * and ends up in a report that leaves the machine, so it is read field by
 * field like any other untrusted input. Anything malformed is dropped whole.
 */
export function parseMainHangCapture(value: unknown): MainHangCapture | null {
  if (!isRecord(value) || value.type !== 'hang') return null
  const stalledMs = value.stalledMs
  if (typeof stalledMs !== 'number' || !Number.isFinite(stalledMs) || stalledMs < 0) return null
  if (typeof value.afterRecovery !== 'boolean' || !Array.isArray(value.frames)) return null
  const frames: MainHangFrame[] = []
  for (const entry of value.frames.slice(0, MAX_HANG_FRAMES)) {
    const frame = parseFrame(entry)
    if (!frame) return null
    frames.push(frame)
  }
  return { stalledMs, frames, afterRecovery: value.afterRecovery }
}

/**
 * Writes the frames back as a V8 stack so crash-report.ts parses, redacts and
 * rewrites them exactly like a thrown error's: `app:///dist-electron/x.js`
 * addresses that match the uploaded source maps. A frame without a script URL
 * (V8 internals) has nothing to point at and is left out.
 */
export function buildMainHangStack(frames: readonly MainHangFrame[]): string {
  return frames
    .filter((frame) => frame.url !== '')
    .slice(0, MAX_HANG_FRAMES)
    .map((frame) => {
      const location = `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
      return frame.functionName ? `    at ${frame.functionName} (${location})` : `    at ${location}`
    })
    .join('\n')
}

function hangError(name: string, message: string, frames: string): Error {
  const error = new Error(message)
  error.name = name
  error.stack = frames ? `${name}: ${message}\n${frames}` : `${name}: ${message}`
  return error
}

export function mainHangReportInput(capture: MainHangCapture): CrashReportInput {
  return {
    mechanism: 'main-hang',
    source: 'main',
    level: 'warning',
    error: hangError('MainProcessHang', mainHangMessage, buildMainHangStack(capture.frames)),
    context: `stalledMs=${Math.round(capture.stalledMs)}${capture.afterRecovery ? '; capturedAfterRecovery (blocked outside JavaScript)' : ''}`,
  }
}

/**
 * What collectJavaScriptCallStack hands back is a V8 stack without the
 * message line. Only the `at` lines are kept: they are the part a source map
 * can resolve, and nothing else the page could put there leaves the machine.
 */
export function normalizeRendererCallStack(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const lines = value.slice(0, MAX_RENDERER_STACK_LENGTH).split('\n').filter((line) => /^\s*at\s+\S/.test(line))
  return lines.length > 0 ? lines.slice(0, MAX_HANG_FRAMES).join('\n') : null
}

export function rendererHangReportInput(callStack: string): CrashReportInput {
  return {
    mechanism: 'renderer-hang',
    source: 'renderer',
    level: 'warning',
    error: hangError('RendererHang', rendererHangMessage, callStack),
  }
}

export interface JavaScriptCallStackSource {
  collectJavaScriptCallStack(): Promise<string | void>
}

/** Resolves null instead of waiting forever when the page runs no JavaScript, and never rejects. */
export function collectRendererCallStack(
  frame: JavaScriptCallStackSource,
  timeoutMs = rendererCallStackTimeoutMs,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout },
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = timers.setTimeout(() => resolve(null), timeoutMs)
    let collected: Promise<string | void>
    try {
      collected = frame.collectJavaScriptCallStack()
    } catch {
      timers.clearTimeout(timer)
      resolve(null)
      return
    }
    collected.then((stack) => {
      timers.clearTimeout(timer)
      resolve(normalizeRendererCallStack(stack))
    }, () => {
      timers.clearTimeout(timer)
      resolve(null)
    })
  })
}

export function shouldReportHangsThisSession(random: number): boolean {
  return random < hangReportSampleRate
}

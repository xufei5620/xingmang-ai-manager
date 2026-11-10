import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 双击画布项目文件（D92）：安装包把 .xingcanvas 关联到星芒，系统把文件路径交给主进程——
// Windows、Linux 放在启动参数里（已经开着就是 second-instance 的 argv），Mac 发 open-file。
// 路径从系统直接进主进程，不经过任何渲染层，也不新开 canvas-host 通道，所以不是 I15 说的
// 「第二个由 renderer 提供绝对路径的通道」；读文件前主进程照拖放那一套严查（canvas-window.ts）。

export const canvasProjectFileExtension = '.xingcanvas'

const maximumArgumentLength = 32_768
const pendingLifetimeMs = 10 * 60_000
const repeatWindowMs = 2_000

/**
 * The canvas project file a launch argument names, as an absolute path, or
 * null for every other argument. Chromium switches (`--foo=a.xingcanvas`) and
 * relative paths are never files the system handed over: the file manager
 * always passes an absolute path, and on Linux a desktop entry with %U may
 * pass a local file: URL instead.
 */
export function resolveCanvasProjectFileArgument(raw: unknown, platform: NodeJS.Platform): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maximumArgumentLength) return null
  if (raw.includes('\0') || raw.startsWith('-')) return null
  let candidate = raw
  if (platform === 'linux' && /^file:/i.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash) return null
      candidate = fileURLToPath(url, { windows: false })
    } catch {
      return null
    }
    if (candidate.includes('\0')) return null
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!pathApi.isAbsolute(candidate)) return null
  // \\?\ and \\.\ reach devices and skip the path normalisation everything else relies on.
  if (platform === 'win32' && /^[\\/]{2}[?.][\\/]/.test(candidate)) return null
  if (pathApi.extname(candidate).toLowerCase() !== canvasProjectFileExtension) return null
  return candidate
}

/**
 * The launch arguments a relaunch should carry: everything but a canvas
 * project file. Restarting (after an update setting, or after an unexpected
 * exit) reuses this launch's arguments, and a file still among them would be
 * imported again as one more project.
 */
export function withoutCanvasProjectFileArguments(args: readonly string[], platform: NodeJS.Platform): string[] {
  return args.filter((argument) => resolveCanvasProjectFileArgument(argument, platform) === null)
}

export interface CanvasProjectFileInbox {
  /** Keeps the file a launch argument names; false (and nothing kept) for any other argument. */
  accept(raw: unknown): boolean
  /** Whether a file is still waiting, e.g. for the user to sign in. */
  hasPending(): boolean
  /** Hands the waiting file over once; a file that waited ten minutes is dropped. */
  take(): string | null
}

// 只留最近一个：一次选几个文件双击，系统会一个一个交过来，打开最后那个；登录前交来的也等着，
// 登录好了再开，但等十分钟就作废，免得过了很久才突然弹出画布。
export function createCanvasProjectFileInbox(platform: NodeJS.Platform, now: () => number = Date.now): CanvasProjectFileInbox {
  let pending: { filePath: string; expires: number } | null = null
  let previous: { filePath: string; at: number } | null = null
  return {
    accept(raw) {
      const filePath = resolveCanvasProjectFileArgument(raw, platform)
      if (!filePath) return false
      const time = now()
      // The same double-click can reach us twice (a launch argument and an
      // open-file event); opening it twice would import it twice.
      if (previous?.filePath === filePath && time - previous.at < repeatWindowMs) return false
      previous = { filePath, at: time }
      pending = { filePath, expires: time + pendingLifetimeMs }
      return true
    },
    hasPending() {
      if (pending && pending.expires <= now()) pending = null
      return pending !== null
    },
    take() {
      const next = pending
      pending = null
      return next && next.expires > now() ? next.filePath : null
    },
  }
}

export interface CanvasProjectFileOpenFailurePrompt {
  title: string
  message: string
  detail: string
  buttons: string[]
}

/**
 * What the user sees when a double-clicked project cannot be opened. The
 * checks along the way already speak Chinese; a raw system error (the file
 * was moved, no permission) carries an English code and the full path, so it
 * goes to the runtime log only and the user gets one plain sentence instead.
 */
export function buildCanvasProjectFileOpenFailurePrompt(error: unknown): CanvasProjectFileOpenFailurePrompt {
  const systemError = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
  const reason = !systemError && error instanceof Error && error.message.trim()
    ? error.message.trim()
    : '读不到这个文件，可能已经移走、删掉了，或者星芒没有权限读它。'
  return {
    title: '没能打开画布项目',
    message: '没能打开这个画布项目文件。',
    detail: reason,
    buttons: ['知道了'],
  }
}

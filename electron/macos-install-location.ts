import path from 'node:path'

/**
 * A packaged build started from the disk image it shipped in looks perfectly
 * healthy: the window opens, the account signs in, nothing crashes. What does
 * not work is everything that needs a writable, stable home on the machine --
 * acceleration above all, whose core is launched from inside the bundle and is
 * killed by Gatekeeper the moment the volume is ejected or the randomized
 * read-only copy behind App Translocation is discarded. The user sees only
 * "acceleration cannot connect" and concludes the product is broken, which is
 * exactly what happened on a customer Mac on 2026-09-20.
 *
 * Path inspection is the whole detection: both answers macOS gives here are
 * positional, so the decision is a pure function of the two paths the main
 * process already knows and can be tested without a mounted volume.
 */
export type MacosInstallLocation = 'mounted-volume' | 'translocated'

export interface MacosInstallLocationInput {
  platform: NodeJS.Platform
  /** `app.isPackaged`. A development run lives in the checkout, never in either place. */
  packaged: boolean
  /** `app.getAppPath()`. */
  appPath: string
  /** `process.execPath`. */
  executablePath: string
}

/** What each button of the first notice means, index for index. */
export type MacosInstallLocationChoice = 'move' | 'continue' | 'quit'

export interface MacosInstallLocationNotice {
  title: string
  message: string
  detail: string
  buttons: readonly string[]
  choices: readonly MacosInstallLocationChoice[]
  defaultId: number
  cancelId: number
}

export type MacosMoveConflict = 'exists' | 'existsAndRunning'

/**
 * `moved`: Electron has copied the bundle and is quitting to relaunch the copy,
 * so startup must stop here. `cancelled`: the user dismissed the administrator
 * prompt. `failed`: the copy itself threw; the message is Electron's English
 * diagnostic and belongs in the log, never on screen.
 */
export type MacosMoveOutcome =
  | { kind: 'moved', conflict: MacosMoveConflict | null }
  | { kind: 'cancelled', conflict: MacosMoveConflict | null }
  | { kind: 'failed', conflict: MacosMoveConflict | null, error: unknown }

export type MoveToApplicationsFolder = (options: {
  conflictHandler: (conflictType: MacosMoveConflict) => boolean
}) => boolean

const translocationDirectoryName = 'AppTranslocation'
const volumesDirectoryName = 'Volumes'
const applicationBundleSuffix = '.app'

function pathSegments(value: string): readonly string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  const normalized = path.posix.normalize(value)
  if (!normalized.startsWith('/')) return []
  return normalized.split('/').filter((segment) => segment.length > 0)
}

function classifyPath(value: string): MacosInstallLocation | null {
  const segments = pathSegments(value)
  if (segments.length === 0) return null
  // Gatekeeper 的随机只读副本：/private/var/folders/<…>/AppTranslocation/<UUID>/d/<应用>.app
  if (segments.includes(translocationDirectoryName)) return 'translocated'
  if (segments[0] !== volumesDirectoryName) return null
  const bundleIndex = segments.findIndex((segment) => segment.endsWith(applicationBundleSuffix))
  // 装在移动硬盘上的应用同样挂在 /Volumes 下，那是用户自己选的安装位置，不该拦。
  // 磁盘映像的区别在于版式固定：.app 就躺在卷根上，与「应用程序」替身并排。
  // 所以只有 /Volumes/<卷名>/<应用>.app 这一层才判成从映像里运行。
  if (bundleIndex >= 0 && bundleIndex !== 2) return null
  return 'mounted-volume'
}

/**
 * Returns the location that needs a warning, or null when the app is running
 * from somewhere it can actually work. Both paths are consulted because a
 * translocated launch rewrites `process.execPath` while the asar path may or
 * may not follow, depending on how the bundle was opened.
 */
export function inspectMacosInstallLocation(
  input: MacosInstallLocationInput,
): MacosInstallLocation | null {
  if (input.platform !== 'darwin') return null
  if (!input.packaged) return null
  return classifyPath(input.appPath) ?? classifyPath(input.executablePath)
}

const moveButtonLabel = '移到「应用程序」并重新打开'
const manualMoveInstruction = '请把「星芒AI管理工具」拖到「应用程序」文件夹后再打开。'

export function buildMacosInstallLocationNotice(
  location: MacosInstallLocation,
): MacosInstallLocationNotice {
  const detail = location === 'mounted-volume'
    ? '星芒还在磁盘映像里，没放进「应用程序」文件夹，在这里运行的话加速和自动更新用不了。'
    : '星芒还没放进「应用程序」文件夹，系统让它在一个只读的临时位置运行，加速和自动更新用不了。'
  return {
    title: '请先把程序放进「应用程序」',
    message: location === 'mounted-volume'
      ? '星芒AI管理工具正在从磁盘映像里运行'
      : '星芒AI管理工具正在从系统的临时副本里运行',
    detail: `${detail}\n\n点「${moveButtonLabel}」，星芒会自己搬过去并重新打开。`,
    buttons: [moveButtonLabel, '仍要继续', '退出'],
    choices: ['move', 'continue', 'quit'],
    defaultId: 0,
    cancelId: 2,
  }
}

/**
 * Runs Electron's bundle mover and folds its three ways of ending into one
 * value. Both conflicts keep Electron's default: an idle older copy in
 * Applications goes to the Trash (recoverable, and the user just asked for
 * this one), and a running copy takes focus while this one quits -- the same
 * thing a double-click in Applications would have done.
 */
export function moveMacosAppToApplications(move: MoveToApplicationsFolder): MacosMoveOutcome {
  let conflict: MacosMoveConflict | null = null
  try {
    const moved = move({
      conflictHandler(conflictType) {
        conflict = conflictType
        return true
      },
    })
    return moved ? { kind: 'moved', conflict } : { kind: 'cancelled', conflict }
  } catch (error) {
    return { kind: 'failed', conflict, error }
  }
}

export function buildMacosMoveFailureNotice(
  location: MacosInstallLocation,
  outcome: Exclude<MacosMoveOutcome, { kind: 'moved' }>,
): MacosInstallLocationNotice {
  // Electron 的报错是英文诊断，只进日志；这里按能确定的情况给大白话原因。
  const reason = outcome.kind === 'cancelled'
    ? '输入电脑密码的窗口被取消了'
    : location === 'mounted-volume'
      ? '「应用程序」文件夹写不进去，或者磁盘映像不允许复制'
      : '「应用程序」文件夹写不进去，或者系统不允许从临时位置复制'
  return {
    title: '没能自动移动',
    message: `没能自动移动（${reason}）。`,
    detail: `${manualMoveInstruction}\n\n仍要继续的话，加速和自动更新用不了。`,
    buttons: ['退出', '仍要继续'],
    choices: ['quit', 'continue'],
    defaultId: 0,
    cancelId: 0,
  }
}

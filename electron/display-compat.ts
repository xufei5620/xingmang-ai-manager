import path from 'node:path'
import {
  appendSafeUtf8FileSync,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  removeSafeDataFile,
  removeSafeDataFileSync,
} from './safe-local-data'

/**
 * 显卡驱动有问题的电脑（老集显、远程桌面、部分虚拟机）上，界面会黑屏、花屏，
 * 或者显卡进程接连崩掉直到整个程序退出。这里记下每一次显卡进程异常退出，
 * 下次打开时如果看到短时间里连着崩了几次，就这一次改用不走显卡的兼容方式显示，
 * 让用户至少能进得去、自己选。
 */

const fileLabel = '显卡崩溃记录'
const fileName = 'display-crashes.log'
/** 一行一个毫秒时间戳，十几字节；再多也只说明「早就该切兼容方式了」。 */
const maximumEntries = 32
const maximumBytes = 4 * 1024
export const displayCrashWindowMs = 10 * 60 * 1_000
export const displayCrashThreshold = 2

/**
 * - accelerated：照常用显卡加速。
 * - user-disabled：用户自己在设置里关了。
 * - auto-compat：这次是因为显卡接连崩溃才自动改的，界面要告诉用户并让他选。
 */
export type DisplayLaunchMode = 'accelerated' | 'user-disabled' | 'auto-compat'

export interface DisplayLaunch {
  mode: DisplayLaunchMode
  recordPath: string
  crashTimes: number[]
  /** 崩溃记录读不出来（被占用、被改坏）。照常加速打开，只记日志。 */
  readError?: unknown
}

export interface ChildProcessGoneDetails {
  type: string
  reason: string
}

export function displayCrashRecordPath(dataDirectory: string): string {
  return path.join(dataDirectory, fileName)
}

/** 坏行、未来时间一律丢掉：这份文件只决定要不要多一层保险，读歪了不该挡住启动。 */
export function parseDisplayCrashTimes(content: string, now: number): number[] {
  const times: number[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!/^\d{1,16}$/.test(trimmed)) continue
    const value = Number(trimmed)
    if (Number.isSafeInteger(value) && value > 0 && value <= now) times.push(value)
  }
  return times.sort((left, right) => left - right).slice(-maximumEntries)
}

export function hasRepeatedDisplayCrashes(times: readonly number[]): boolean {
  const sorted = [...times].sort((left, right) => left - right)
  for (let index = 0; index + displayCrashThreshold - 1 < sorted.length; index++) {
    if (sorted[index + displayCrashThreshold - 1] - sorted[index] <= displayCrashWindowMs) return true
  }
  return false
}

export function buildDisplayLaunchMode(input: {
  hardwareAcceleration: boolean | undefined
  crashTimes: readonly number[]
}): DisplayLaunchMode {
  if (input.hardwareAcceleration === false) return 'user-disabled'
  return hasRepeatedDisplayCrashes(input.crashTimes) ? 'auto-compat' : 'accelerated'
}

/**
 * Called before app ready, so it must be synchronous and must never throw:
 * `app.disableHardwareAcceleration()` is ignored once ready has fired, and a
 * failure here would turn "maybe show the UI more safely" into "cannot start".
 */
export function inspectDisplayLaunch(input: {
  dataDirectory: string
  hardwareAcceleration: boolean | undefined
  now: number
}): DisplayLaunch {
  const recordPath = displayCrashRecordPath(input.dataDirectory)
  let crashTimes: number[] = []
  let readError: unknown
  try {
    const content = readSafeUtf8FileSync(recordPath, fileLabel, maximumBytes)
    if (content !== null) crashTimes = parseDisplayCrashTimes(content, input.now)
  } catch (error) {
    readError = error
  }
  return {
    mode: buildDisplayLaunchMode({ hardwareAcceleration: input.hardwareAcceleration, crashTimes }),
    recordPath,
    crashTimes,
    ...(readError !== undefined ? { readError } : {}),
  }
}

/** 正常退出（关窗、切换显示方式时主动重启显卡进程）不算。 */
export function isDisplayCrash(details: ChildProcessGoneDetails): boolean {
  return details.type === 'GPU' && details.reason !== 'clean-exit'
}

/**
 * Synchronous and durable on purpose: after a few GPU crashes Chromium may
 * terminate the whole browser process right after this event, and an async
 * write would never reach the disk -- exactly the case this record exists for.
 */
export function recordDisplayCrash(recordPath: string, now: number): void {
  const content = readSafeUtf8FileSync(recordPath, fileLabel, maximumBytes)
  if (content !== null && parseDisplayCrashTimes(content, now).length >= maximumEntries) return
  ensureSafeDataDirectory(path.dirname(recordPath), fileLabel)
  appendSafeUtf8FileSync(recordPath, `${now}\n`, fileLabel, { durable: true })
}

/**
 * 没触发兼容方式、记录又全是 10 分钟以前的：它们再也凑不成「10 分钟内两次」，删掉，
 * 文件就不会越攒越长。放在 ready 之前同步做，那时显卡进程还没起来，不会和
 * recordDisplayCrash 的追加撞在一起；还有近期记录就原样留着，数量已由上限兜住。
 */
export function pruneStaleDisplayCrashRecord(launch: DisplayLaunch, now: number): boolean {
  if (launch.mode === 'auto-compat' || launch.readError !== undefined || launch.crashTimes.length === 0) return false
  if (launch.crashTimes.some((time) => now - time <= displayCrashWindowMs)) return false
  removeSafeDataFileSync(launch.recordPath, fileLabel)
  return true
}

/** 用户在提示或设置里做了选择：之前的崩溃已经有了交代，从头再数。 */
export async function clearDisplayCrashRecord(recordPath: string): Promise<void> {
  await removeSafeDataFile(recordPath, fileLabel)
}

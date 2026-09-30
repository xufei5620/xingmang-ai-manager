import path from 'node:path'
import { redactCrashText } from './crash-report'
import type { UnexpectedExitNotice } from './ipc-contract'
import { loginLaunchArgument } from './login-launch'
import {
  appendSafeUtf8FileSync,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  removeSafeDataFileSync,
} from './safe-local-data'

/**
 * 主进程运行中抛出没人接住的异常时，Electron 自带的处理是弹一个英文的
 * 「A JavaScript error occurred in the main process」框，点掉以后软件带着坏掉的
 * 状态接着跑。小白看不懂那个框，也不知道该重开。这里改成：记一笔、自动重开一次，
 * 下次打开时用一句中文说清楚，并给「复制给客服」。
 *
 * 10 分钟内已经自动重开过一次就不再重开：同一个问题一打开就犯的话，反复重开只会
 * 让窗口一闪一闪，用户连「复制给客服」都点不到。
 */

const fileLabel = '意外退出记录'
const fileName = 'unexpected-exits.log'
const maximumEntries = 8
const maximumBytes = 16 * 1024
const maximumErrorLength = 300
/** 一次提示里最多列几次退出：客服要看的是最近这几次，不是全部历史。 */
const maximumNoticeExits = 3
export const unexpectedExitWindowMs = 10 * 60 * 1_000

export interface UnexpectedExitEntry {
  at: number
  /** 错误名和第一句话，已打码（Key、账号名、邮箱、用户目录）。 */
  error: string
  relaunched: boolean
  /** 下次打开时已经告诉过用户了。留着它只为数「10 分钟内重开过没有」。 */
  notified: boolean
}

export function unexpectedExitRecordPath(dataDirectory: string): string {
  return path.join(dataDirectory, fileName)
}

function isEntry(value: unknown, now: number): value is UnexpectedExitEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.at === 'number' && Number.isSafeInteger(entry.at) && entry.at > 0 && entry.at <= now
    && typeof entry.error === 'string' && entry.error.length <= maximumErrorLength * 2
    && typeof entry.relaunched === 'boolean' && typeof entry.notified === 'boolean'
}

/** 坏行、未来时间一律丢掉：这份记录只决定要不要多说一句，读歪了不该挡住启动。 */
export function parseUnexpectedExitEntries(content: string, now: number): UnexpectedExitEntry[] {
  const entries: UnexpectedExitEntry[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (isEntry(parsed, now)) {
      entries.push({ at: parsed.at, error: parsed.error, relaunched: parsed.relaunched, notified: parsed.notified })
    }
  }
  return entries.sort((left, right) => left.at - right.at).slice(-maximumEntries)
}

function serializeEntries(entries: readonly UnexpectedExitEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')
}

/**
 * 只留错误名和第一句话：完整的调用栈已经进了运行日志和错误报告，这一句是给
 * 客服看「大概是哪类问题」的，也要能原样复制出去，所以同样过一遍错误报告的打码。
 */
export function describeUnexpectedExitError(error: unknown, homeDirectory: string): string {
  const raw = error instanceof Error
    ? `${error.name || 'Error'}: ${error.message}`
    : typeof error === 'string' ? error : '未知错误'
  const firstLine = raw.split(/\r?\n/, 1)[0].trim() || '未知错误'
  const redacted = redactCrashText(firstLine, homeDirectory)
  return redacted.length > maximumErrorLength ? `${redacted.slice(0, maximumErrorLength - 1)}…` : redacted
}

/** 10 分钟内已经自动重开过一次，这次就不再重开。 */
export function shouldRelaunchAfterUnexpectedExit(entries: readonly UnexpectedExitEntry[], now: number): boolean {
  return !entries.some((entry) => entry.relaunched && now - entry.at <= unexpectedExitWindowMs)
}

/**
 * 重开出来的窗口跟出事前一样：窗口开着就把它开出来，缩在托盘里就还缩在托盘里。
 * 开机启动的参数正好表达「这次别弹窗」（见 login-launch.ts），所以按出事前窗口
 * 可见与否加上或去掉它，其余参数原样带着。
 */
export function buildUnexpectedExitRelaunchArgs(args: readonly string[], windowVisible: boolean): string[] {
  const rest = args.filter((argument) => argument !== loginLaunchArgument)
  return windowVisible ? rest : [...rest, loginLaunchArgument]
}

/**
 * Synchronous and durable on purpose: the process is about to exit, and an
 * async write may never reach the disk. Returns whether this exit may relaunch;
 * a record that cannot be read or written means the loop guard cannot work,
 * so the caller must treat a throw as "do not relaunch".
 */
export function recordUnexpectedExit(recordPath: string, input: { now: number; error: string; allowRelaunch?: boolean }): { relaunch: boolean } {
  const content = readSafeUtf8FileSync(recordPath, fileLabel, maximumBytes)
  const entries = content === null ? [] : parseUnexpectedExitEntries(content, input.now)
  const relaunch = input.allowRelaunch !== false && shouldRelaunchAfterUnexpectedExit(entries, input.now)
  const entry: UnexpectedExitEntry = { at: input.now, error: input.error, relaunched: relaunch, notified: false }
  ensureSafeDataDirectory(path.dirname(recordPath), fileLabel)
  if (entries.length >= maximumEntries || (content !== null && Buffer.byteLength(content) > maximumBytes / 2)) {
    // 满了就只留最近几条重写一遍，免得追加撞上读取上限、下次整份读不出来。
    removeSafeDataFileSync(recordPath, fileLabel)
    appendSafeUtf8FileSync(recordPath, serializeEntries([...entries.slice(-(maximumEntries - 1)), entry]), fileLabel, { durable: true })
  } else {
    appendSafeUtf8FileSync(recordPath, serializeEntries([entry]), fileLabel, { durable: true })
  }
  return { relaunch }
}

/** 还没告诉过用户的那几次里最新的一次决定说法；列出来的是它前后 10 分钟内的几次。 */
export function buildUnexpectedExitNotice(entries: readonly UnexpectedExitEntry[]): UnexpectedExitNotice | null {
  const pending = entries.filter((entry) => !entry.notified)
  if (pending.length === 0) return null
  const latest = pending[pending.length - 1]
  const recent = entries.filter((entry) => latest.at - entry.at <= unexpectedExitWindowMs)
  return {
    relaunched: latest.relaunched,
    exits: recent.slice(-maximumNoticeExits).map((entry) => ({ at: entry.at, error: entry.error })),
  }
}

/**
 * 启动时读一次：有没告诉过用户的就返回要说的话，并把记录改成「都说过了」，只留
 * 10 分钟内的几条给下一次数重开次数用。同步、先删后写：这时还没有别的代码会写这份
 * 记录，出事的那条追加也是同步的，不会插进这两步中间。
 */
export function takeUnexpectedExitNotice(recordPath: string, now: number): UnexpectedExitNotice | null {
  const content = readSafeUtf8FileSync(recordPath, fileLabel, maximumBytes)
  if (content === null) return null
  const entries = parseUnexpectedExitEntries(content, now)
  const notice = buildUnexpectedExitNotice(entries)
  const kept = entries
    .filter((entry) => now - entry.at <= unexpectedExitWindowMs)
    .map((entry) => ({ ...entry, notified: true }))
  removeSafeDataFileSync(recordPath, fileLabel)
  if (kept.length > 0) appendSafeUtf8FileSync(recordPath, serializeEntries(kept), fileLabel, { durable: true })
  return notice
}

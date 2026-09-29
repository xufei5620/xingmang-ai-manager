import fs from 'node:fs'
import path from 'node:path'
import { readBoundedUtf8FileSync } from './bounded-file'
import { ensureSafeDataDirectory } from './safe-local-data'
import type { TerminalFailureReason, TerminalNotice } from './platform/notifications'

// 读 CLI 钩子脚本（bundled-catalog/cli-hooks/xingmang-hook.cjs）丢进数据目录的小文件，
// 决定要不要弹「终端里没回上 / 做完了 / 在等你」那几条系统通知。
//
// 这个目录谁都能写（用户可写区），所以每个文件都当成敌意输入：只认固定格式的文件名，
// 读取经过单链接普通文件 + 大小上限那一套（I8），内容逐字段按白名单重建（I5）。
// 文件里任何文字都不会进通知：通知文案全部出自 platform/notifications.ts 那张表。

const MAX_EVENT_BYTES = 4 * 1024
// 一次最多处理这么多个；满了就过一会儿再来，不让一个塞满文件的目录卡住主进程。
const MAX_ENTRIES_PER_SWEEP = 100
// 星芒没开着时留下的记录，开机后再弹就是陈旧提醒了，直接丢掉。
const STALE_EVENT_MS = 10 * 60_000
const STALE_TEMPORARY_MS = 60_000
// fs.watch 起不来（网络盘、权限）时退回定时看一眼。
const FALLBACK_POLL_MS = 5_000
const SWEEP_DEBOUNCE_MS = 200

export const LONG_TURN_MS = 60_000
export const FAILURE_QUIET_MS = 30 * 60_000
export const WAITING_QUIET_MS = 2 * 60_000

const EVENT_FILE_PATTERN = /^\d{1,16}-\d{1,10}-[0-9a-f]{8}\.(json|tmp)$/

export type CliHookEventKind = 'started' | 'finished' | 'failed' | 'waiting'

export interface CliHookEvent {
  tool: TerminalNotice['tool']
  event: CliHookEventKind
  reason?: TerminalFailureReason
  session: string
  at: number
}

const failureReasons: ReadonlySet<string> = new Set<TerminalFailureReason>(['billing', 'auth', 'busy', 'model', 'service', 'unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 解析一条钩子记录；格式不对一律返回 null，从不抛错。 */
export function parseCliHookEvent(text: string): CliHookEvent | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== 1) return null
  const { tool, event, reason, session, at } = value
  if (tool !== 'claude' && tool !== 'gemini') return null
  if (event !== 'started' && event !== 'finished' && event !== 'failed' && event !== 'waiting') return null
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return null
  if (typeof session !== 'string' || !/^[A-Za-z0-9_.:-]{0,100}$/.test(session)) return null
  if (event === 'failed') {
    if (typeof reason !== 'string' || !failureReasons.has(reason)) return null
    return { tool, event, reason: reason as TerminalFailureReason, session, at }
  }
  return { tool, event, session, at }
}

/**
 * 把一串钩子事件变成该弹的通知。不刷屏是这里的事：
 * - 做完：只有配得上「开始」、且这一轮跑满一分钟才提醒——一问一答的小事不用叫人；
 * - 在等你：同一个工具两分钟内只提醒一次；
 * - 没回上：同一个工具、同一个原因半小时内只提醒一次。
 */
export function createCliTurnTracker(options: {
  longTurnMs?: number
  failureQuietMs?: number
  waitingQuietMs?: number
} = {}) {
  const longTurnMs = options.longTurnMs ?? LONG_TURN_MS
  const failureQuietMs = options.failureQuietMs ?? FAILURE_QUIET_MS
  const waitingQuietMs = options.waitingQuietMs ?? WAITING_QUIET_MS
  const starts = new Map<string, number>()
  const lastShown = new Map<string, number>()

  function quiet(key: string, at: number, window: number): boolean {
    const previous = lastShown.get(key)
    if (previous !== undefined && at - previous >= 0 && at - previous < window) return true
    lastShown.set(key, at)
    return false
  }

  return {
    observe(event: CliHookEvent): TerminalNotice | null {
      const turnKey = `${event.tool}:${event.session}`
      switch (event.event) {
        case 'started':
          if (!event.session) return null
          starts.delete(turnKey)
          starts.set(turnKey, event.at)
          // 开着一堆终端从不收尾时也只记最近的几十个。
          while (starts.size > 50) starts.delete(starts.keys().next().value!)
          return null
        case 'finished': {
          const started = event.session ? starts.get(turnKey) : undefined
          starts.delete(turnKey)
          if (started === undefined || event.at - started < longTurnMs) return null
          return { tool: event.tool, event: 'finished' }
        }
        case 'waiting':
          if (quiet(`waiting:${event.tool}`, event.at, waitingQuietMs)) return null
          return { tool: event.tool, event: 'waiting' }
        case 'failed': {
          starts.delete(turnKey)
          const reason = event.reason ?? 'unknown'
          if (quiet(`failed:${event.tool}:${reason}`, event.at, failureQuietMs)) return null
          return { tool: event.tool, event: 'failed', reason }
        }
      }
    },
  }
}

export interface CliHookEventMonitorOptions {
  directory: string
  notify: (notice: TerminalNotice, eventKey: string) => void
  now?: () => number
  log?: (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>) => void
  /** 测试注入；缺省用 fs.watch。 */
  watch?: (directory: string, onChange: () => void) => { close(): void }
}

function removeEntry(filePath: string): void {
  try {
    // unlink 删的是目录项本身，就算有人放了符号链接也不会顺着删到别处。
    fs.unlinkSync(filePath)
  } catch {
    // 删不掉下次再试；读过的记录由 handled 集合挡住，不会重复提醒。
  }
}

export function createCliHookEventMonitor(options: CliHookEventMonitorOptions) {
  const now = options.now ?? Date.now
  const tracker = createCliTurnTracker()
  const handled = new Set<string>()
  let watcher: { close(): void } | null = null
  let poller: ReturnType<typeof setInterval> | null = null
  let pending: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function handle(name: string, filePath: string, current: number): void {
    if (name.endsWith('.tmp')) {
      // 钩子进程写到一半被杀留下的半成品。
      try {
        const stats = fs.lstatSync(filePath)
        if (current - stats.mtimeMs > STALE_TEMPORARY_MS) removeEntry(filePath)
      } catch {
        // 已经没了。
      }
      return
    }
    if (handled.has(name)) {
      removeEntry(filePath)
      return
    }
    let text: string | null = null
    try {
      text = readBoundedUtf8FileSync(filePath, MAX_EVENT_BYTES, '终端事件记录')
    } catch (error) {
      options.log?.('warn', 'cli-hook.event-rejected', '终端事件记录读取被拒绝', { reason: error instanceof Error ? error.message : String(error) })
    }
    removeEntry(filePath)
    handled.add(name)
    while (handled.size > 500) handled.delete(handled.values().next().value!)
    const event = text === null ? null : parseCliHookEvent(text)
    if (!event) return
    if (current - event.at > STALE_EVENT_MS || event.at - current > STALE_EVENT_MS) return
    const notice = tracker.observe(event)
    if (!notice) return
    options.log?.('info', 'cli-hook.notice', '终端里的工具有事要告诉用户', { tool: notice.tool, event: notice.event, ...(notice.event === 'failed' ? { reason: notice.reason } : {}) })
    options.notify(notice, `${notice.tool}:${notice.event}:${name}`)
  }

  function sweep(): void {
    if (disposed) return
    let directory: fs.Dir
    try {
      directory = fs.opendirSync(options.directory)
    } catch {
      return
    }
    const names: string[] = []
    let full = false
    try {
      while (true) {
        const entry = directory.readSync()
        if (!entry) break
        if (!EVENT_FILE_PATTERN.test(entry.name)) continue
        if (names.length >= MAX_ENTRIES_PER_SWEEP) {
          full = true
          break
        }
        names.push(entry.name)
      }
    } finally {
      directory.closeSync()
    }
    // 文件名以写入时刻开头，按名字排就是按先后处理，「开始」总在「做完」前面。
    names.sort((left, right) => Number(left.split('-')[0]) - Number(right.split('-')[0]))
    const current = now()
    for (const name of names) {
      try {
        handle(name, path.join(options.directory, name), current)
      } catch (error) {
        options.log?.('warn', 'cli-hook.event-failed', '终端事件记录处理失败', { reason: error instanceof Error ? error.message : String(error) })
      }
    }
    if (full) schedule()
  }

  function schedule(): void {
    if (disposed || pending) return
    pending = setTimeout(() => {
      pending = null
      sweep()
    }, SWEEP_DEBOUNCE_MS)
  }

  return {
    start(): void {
      if (disposed) return
      try {
        ensureSafeDataDirectory(options.directory, '终端事件目录')
      } catch (error) {
        options.log?.('warn', 'cli-hook.directory-unavailable', '终端事件目录不可用，这次运行不提醒终端里的事', { reason: error instanceof Error ? error.message : String(error) })
        return
      }
      sweep()
      function poll(): void {
        watcher?.close()
        watcher = null
        if (disposed || poller) return
        poller = setInterval(sweep, FALLBACK_POLL_MS)
        poller.unref?.()
      }
      try {
        if (options.watch) {
          watcher = options.watch(options.directory, schedule)
        } else {
          const fsWatcher = fs.watch(options.directory, { persistent: false }, schedule)
          fsWatcher.on('error', poll)
          watcher = fsWatcher
        }
      } catch {
        poll()
      }
    },
    /** 测试与关机前手动过一遍。 */
    sweep,
    dispose(): void {
      disposed = true
      watcher?.close()
      watcher = null
      if (poller) clearInterval(poller)
      poller = null
      if (pending) clearTimeout(pending)
      pending = null
    },
  }
}

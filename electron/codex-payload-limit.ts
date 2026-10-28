/**
 * Codex 有个对话大到线路 1 发不出去（413 Payload Too Large）时怎么办（yoyo 10-28 需求）。
 *
 * 线路 1（Cloudflare 入口）单个请求体上限 100MB，是 Cloudflare 套餐的限制，服务端改不了，超了在 Cloudflare 边缘
 * 就被拒。线路 1 上服务端对 WebSocket 握手回 426，Codex 改走普通 HTTP，每一轮都把整段对话（连同截图、文件）
 * 重新发一遍：长对话过了 100MB，在这个对话里发什么都失败，连 Codex 自己的压缩也要先把整段发上去，一样不行。
 * 线路 2 上限 256MB，还允许 WebSocket（连上以后每轮只发新增的），同一个对话换到线路 2 就能接着聊。
 *
 * 认法：Codex 每一轮结束往会话记录（CODEX_HOME/sessions/年/月/日/rollout-…-<会话 ID>.jsonl）写一行
 * event_msg / task_complete，没发出去时带着 error.message，原文是「unexpected status 413 Payload Too Large:
 * <网页>, url: <地址>, cf-ray: …」（0.163、0.164 的命令行和桌面端那种 app-server 连法连本机假接口实测）。更老的
 * 版本可能另写一行 error 事件，一起认。这里只盯新写进的那一段：目录有动静才读，每个文件只读末尾，一次最多读
 * rolloutTailBytes，一行太长（截图）不解析。
 *
 * 会话记录目录用户可写，内容一律当敌意输入（I5、I8）：文件名只认 Codex 的固定格式，只读单链接普通文件、不跟
 * 符号链接；一行里只取地址和时刻，地址只拿去和 relay-sites.ts 的各条线路逐个比 origin。报错原文、地址都不进日志
 * 和提示（I13），日志只记会话 ID、站点、线路和记录有多大。
 */
import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from './input-guards'
import { relayEndpointForUrl, type RelayEndpointId, type RelayRoutePreference, type RelayRouteSiteId } from './relay-sites'
import type { RelayRouteHoldResult } from './relay-route-controller'
import type { CodexPayloadNotice, CodexPayloadNoticeKind } from './running-tools'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

/** 线路 1 上会话记录过了这么大，提前提醒一次（会话记录比实际发出去的大一些，算偏早的提醒）。 */
export const codexPayloadNearingBytes = 80 * 1024 * 1024
/** 每次最多读会话记录末尾这么多：报错那一行几百字节，总在最后。 */
export const rolloutTailBytes = 256 * 1024
/** 超过这么长的一行不解析：报错那一行连 Cloudflare 的网页也就几百字节，长的是截图和文件。 */
const maxErrorLineChars = 64 * 1024
/** 报错写下的时刻离现在超过这么久就不管了：星芒没开着时留下的，开机再提已经是旧事（同 cli-hook-events.ts）。 */
export const codexPayloadStaleMs = 10 * 60_000
/** 目录动静来了以后等这么久再读：Codex 一轮里连着写好几行。 */
const sweepDebounceMs = 1_000
/** 最近写过的会话记录隔这么久回头看一眼：Windows 上别的程序开着文件写，目录通知可能来得晚。 */
const activePollMs = 30_000
/** 多久没动静的会话记录不再回头看。 */
const activeWindowMs = 10 * 60_000
/** 会话记录目录还没有（没用过 Codex）、或者盯不上时，隔这么久再试一次。 */
const watchRetryMs = 60_000
/** 同时记着读到哪的会话记录最多这么多个。 */
const maxTrackedFiles = 32
/** 处理过、提醒过的会话记录多少个、多久。 */
const maxRememberedSessions = 64
const rememberedSessionMs = 30 * 24 * 60 * 60_000

const sessionIdPattern = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const payloadTooLargePattern = /unexpected status 413 Payload Too Large\b/
// 报错原文最后是「, url: <地址>, cf-ray: …」，取最后一个：前面那段网页由对面给，可能也带着这几个字。
const urlPattern = /, url: (https?:\/\/[^\s,]+)/g

/** 会话记录的文件名里取会话 ID；不是 Codex 的会话记录给 null。 */
export function codexRolloutSessionId(fileName: string): string | null {
  const match = sessionIdPattern.exec(fileName)
  return match ? match[1].toLowerCase() : null
}

function errorMessage(payload: Record<string, unknown>): string | null {
  // 一轮结束那一行（task_complete，协议里也叫 turn_complete）带着这一轮的错误；老版本另写的 error 事件把原文放在 message。
  if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
    return isRecord(payload.error) && typeof payload.error.message === 'string' ? payload.error.message : null
  }
  if (payload.type === 'error') return typeof payload.message === 'string' ? payload.message : null
  return null
}

/**
 * 会话记录里的一行是不是「这一轮因为请求体太大（413）没发出去」：是就给报错里的地址和这一行的时刻，别的一律
 * null，从不抛错。中途重连那几行（Reconnecting… n/5）不算，只认这一轮最后的结论。
 */
export function parseCodexPayloadTooLarge(line: string): { url: string; at: number } | null {
  if (line.length > maxErrorLineChars || !line.includes('413') || !line.includes('Payload Too Large')) return null
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!isRecord(value) || value.type !== 'event_msg' || !isRecord(value.payload)) return null
  const message = errorMessage(value.payload)
  if (!message || !payloadTooLargePattern.test(message)) return null
  const urls = [...message.matchAll(urlPattern)]
  const url = urls.length ? urls[urls.length - 1][1] : null
  const at = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : Number.NaN
  if (!url || !Number.isFinite(at)) return null
  return { url, at }
}

export interface CodexPayloadTooLargeEvent {
  sessionId: string
  url: string
  at: number
  /** 会话记录这会儿多大（字节）。 */
  rolloutBytes: number
}

export interface CodexLargeSessionEvent {
  sessionId: string
  rolloutBytes: number
}

export interface CodexRolloutWatcherOptions {
  /** CODEX_HOME/sessions。 */
  sessionsDirectory: string
  onPayloadTooLarge(event: CodexPayloadTooLargeEvent): void
  /** 会话记录过了 codexPayloadNearingBytes：每次读到它都报，提醒不提醒、提醒几次由接的那边定。 */
  onLargeSession?(event: CodexLargeSessionEvent): void
  now?: () => number
  log?: (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>) => void
  /** 测试注入；缺省用 fs.watch 递归盯着目录。onChange 收到的是相对目录的文件路径，拿不到就是 null。 */
  watch?: (directory: string, onChange: (fileName: string | null) => void, onError: () => void) => { close(): void }
  /** 测试注入；缺省 setTimeout / setInterval（unref）。 */
  schedule?: (callback: () => void, delayMs: number) => () => void
}

interface TrackedRollout {
  /** 下次从这里读。 */
  offset: number
  /** offset 落在行首；跳过一整段太长的行以后不是。 */
  aligned: boolean
  touchedAt: number
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

function defaultWatch(directory: string, onChange: (fileName: string | null) => void, onError: () => void): { close(): void } {
  const watcher = fs.watch(directory, { recursive: true, persistent: false }, (_event, fileName) => {
    onChange(typeof fileName === 'string' ? fileName : null)
  })
  watcher.on('error', onError)
  return watcher
}

/** 会话目录下的相对路径是不是一个 Codex 会话记录，是就给会话 ID。带「..」、绝对路径的不认。 */
function rolloutRelativePath(fileName: string): { relative: string; sessionId: string } | null {
  const relative = path.normalize(fileName)
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((segment) => segment === '..')) return null
  const sessionId = codexRolloutSessionId(path.basename(relative))
  return sessionId ? { relative, sessionId } : null
}

// 只读单链接普通文件，打开时不跟符号链接（I8）：会话目录用户可写，有人放个链接也只会被跳过。
async function readRolloutRange(filePath: string, tracked: TrackedRollout | undefined): Promise<{ size: number; start: number; aligned: boolean; buffer: Buffer } | null> {
  const before = await fs.promises.lstat(filePath).catch(() => null)
  if (!before || !before.isFile() || before.nlink !== 1) return null
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)).catch(() => null)
  if (!handle) return null
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.nlink !== 1 || stats.ino !== before.ino || stats.dev !== before.dev) return null
    const size = stats.size
    // 接着上次读到的地方读；第一次见、被截短过、一下子写进来太多的，只读末尾那一段。
    const resume = tracked !== undefined && tracked.offset <= size
    let start = resume ? tracked.offset : Math.max(0, size - rolloutTailBytes)
    let aligned = resume && tracked.aligned
    if (size - start > rolloutTailBytes) {
      start = size - rolloutTailBytes
      aligned = false
    }
    if (start === 0) aligned = true
    const buffer = Buffer.alloc(size - start)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { size: start + read, start, aligned, buffer: buffer.subarray(0, read) }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 盯着 Codex 的会话记录，报「这一轮因为太大没发出去」和「记录已经很大了」。 */
export function createCodexRolloutWatcher(options: CodexRolloutWatcherOptions) {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? defaultSchedule
  const watchDirectory = options.watch ?? defaultWatch
  const tracked = new Map<string, TrackedRollout>()
  const pending = new Set<string>()
  let watcher: { close(): void } | null = null
  let cancelSweep: (() => void) | null = null
  let cancelPoll: (() => void) | null = null
  let cancelRetry: (() => void) | null = null
  let running: Promise<void> = Promise.resolve()
  let disposed = false

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) } catch { /* 记日志失败不影响别的 */ }
  }

  function remember(relative: string, entry: TrackedRollout): void {
    tracked.delete(relative)
    tracked.set(relative, entry)
    while (tracked.size > maxTrackedFiles) tracked.delete(tracked.keys().next().value!)
  }

  async function processFile(relative: string, sessionId: string): Promise<void> {
    const filePath = path.join(options.sessionsDirectory, relative)
    const previous = tracked.get(relative)
    const range = await readRolloutRange(filePath, previous).catch(() => null)
    if (!range) {
      tracked.delete(relative)
      return
    }
    const { buffer, start, size } = range
    const lastNewline = buffer.lastIndexOf(0x0a)
    let lines: string[] = []
    if (lastNewline < 0) {
      // 一整行都还没写完：在行首的接着等它写完；这一段已经比一次能读的还长（截图那种），这一行不要了，从末尾接着读。
      const waiting = range.aligned && buffer.length < rolloutTailBytes
      remember(relative, { offset: waiting ? start : size, aligned: waiting, touchedAt: now() })
    } else {
      lines = buffer.subarray(0, lastNewline).toString('utf8').split('\n')
      // 从一行中间读起的，第一行是半截。
      if (!range.aligned) lines.shift()
      remember(relative, { offset: start + lastNewline + 1, aligned: true, touchedAt: now() })
    }
    for (const line of lines) {
      const found = parseCodexPayloadTooLarge(line)
      if (!found) continue
      try { options.onPayloadTooLarge({ sessionId, url: found.url, at: found.at, rolloutBytes: size }) } catch { /* 接的那边出错不影响接着读 */ }
    }
    if (size >= codexPayloadNearingBytes) {
      try { options.onLargeSession?.({ sessionId, rolloutBytes: size }) } catch { /* 同上 */ }
    }
  }

  function sweep(): Promise<void> {
    const names = [...pending]
    pending.clear()
    running = running.then(async () => {
      for (const relative of names) {
        if (disposed) return
        const sessionId = codexRolloutSessionId(path.basename(relative))
        if (sessionId) await processFile(relative, sessionId)
      }
    })
    return running
  }

  function queue(fileName: string | null): void {
    if (disposed || !fileName) return
    const rollout = rolloutRelativePath(fileName)
    if (!rollout) return
    pending.add(rollout.relative)
    if (cancelSweep) return
    cancelSweep = schedule(() => {
      cancelSweep = null
      void sweep()
    }, sweepDebounceMs)
  }

  // 最近写过的会话记录隔一阵看一眼大小，变了就读：目录通知漏了、来晚了也不耽误。
  function poll(): void {
    cancelPoll = schedule(() => {
      cancelPoll = null
      if (disposed) return
      const at = now()
      for (const [relative, entry] of tracked) {
        if (at - entry.touchedAt >= 0 && at - entry.touchedAt < activeWindowMs) pending.add(relative)
      }
      void sweep().then(() => { if (!disposed) poll() })
    }, activePollMs)
  }

  function retryLater(): void {
    if (disposed || cancelRetry) return
    cancelRetry = schedule(() => {
      cancelRetry = null
      begin()
    }, watchRetryMs)
  }

  function begin(): void {
    if (disposed || watcher) return
    try {
      watcher = watchDirectory(options.sessionsDirectory, queue, () => {
        watcher?.close()
        watcher = null
        retryLater()
      })
    } catch {
      // 还没用过 Codex（目录还没有），或者这个目录盯不上：过一会儿再试，不扫目录。
      watcher = null
      retryLater()
      return
    }
    log('info', 'codex-payload.watch-started', '开始看 Codex 的对话记录，对话太大发不出去时帮客户换线路')
  }

  return {
    start(): void {
      if (disposed) return
      begin()
      if (!cancelPoll) poll()
    },
    /** 测试用：把目录动静马上处理掉。 */
    flush(): Promise<void> {
      cancelSweep?.()
      cancelSweep = null
      return sweep()
    },
    /** 测试用：把最近写过的会话记录再看一遍（同定时那一下）。 */
    pollNow(): Promise<void> {
      const at = now()
      for (const [relative, entry] of tracked) {
        if (at - entry.touchedAt >= 0 && at - entry.touchedAt < activeWindowMs) pending.add(relative)
      }
      return sweep()
    },
    dispose(): void {
      disposed = true
      watcher?.close()
      watcher = null
      cancelSweep?.()
      cancelPoll?.()
      cancelRetry?.()
      cancelSweep = null
      cancelPoll = null
      cancelRetry = null
      pending.clear()
      tracked.clear()
    },
  }
}

/** 处理过（413）、提前提醒过的会话：会话 ID → 时刻。 */
export interface CodexPayloadState {
  /** 线路 1 上报 413、处理过的。 */
  handled: Record<string, number>
  /**
   * 线路 2 上也报了 413、提示过新开对话的。跟线路 1 分开记（R29-02）：记在一起时，线路 1 上处理过、换到线路 2
   * 的对话再超，就一声不吭。存下的记录以前没有这一项，读出来是空的。
   */
  handledDirect: Record<string, number>
  warned: Record<string, number>
}

/** 处理一次 413 的结果，记进日志的 action。 */
export type CodexPayloadAction = 'switched' | 'already' | 'locked' | 'unreachable' | 'unfollowed' | 'too-large'

export interface CodexPayloadLimitDependencies {
  /** 当前登录的是哪个站（solov / solov-api）。 */
  activeSiteId(): string
  /** 这个站开机时生效的线路偏好。 */
  preference(siteId: RelayRouteSiteId): RelayRoutePreference
  /** 这个站这会儿写进工具配置的线路（星芒账号是工具线路，历史账号是应用线路）。 */
  toolLine(siteId: RelayRouteSiteId): RelayEndpointId
  /** Codex 这会儿接着的是当前账号（不是官方账号）。 */
  codexOnRelay(): boolean
  /**
   * 「自动」的站换到线路 2：星芒账号是工具线路（tool-route-controller.ts），历史账号是应用线路
   * （relay-route-controller.ts，24 小时不切回线路 1）。
   */
  holdDirect(siteId: RelayRouteSiteId, trigger: string): Promise<RelayRouteHoldResult>
  /**
   * 换到（或者本来就在）线路 2 以后：Codex 的配置跟过去、提示客户重开。Codex 的配置星芒没法替客户改到线路 2 的
   * 返回 false，这时改说「新开对话」。
   */
  followCodex(siteId: RelayRouteSiteId, result: 'switched' | 'already'): Promise<boolean>
  notify(kind: CodexPayloadNoticeKind): void
  readState(): CodexPayloadState | null
  writeState(state: CodexPayloadState): Promise<void>
  /** false = 不提前提醒（线路 1 上记录过了 80MB 那一条）。缺省 = 提醒。 */
  warnNearing?: boolean
  now?(): number
  log?(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void
}

function isRouteSite(siteId: string): siteId is RelayRouteSiteId {
  return siteId === 'solov' || siteId === 'solov-api'
}

function copyState(state: CodexPayloadState): CodexPayloadState {
  return { handled: { ...state.handled }, handledDirect: { ...state.handledDirect }, warned: { ...state.warned } }
}

function pruneSessions(records: Record<string, number>, at: number): Record<string, number> {
  const kept = Object.entries(records)
    .filter(([, recordedAt]) => recordedAt <= at && at - recordedAt < rememberedSessionMs)
    .sort((left, right) => left[1] - right[1])
    .slice(-maxRememberedSessions)
  return Object.fromEntries(kept)
}

/**
 * 认出一次 413 以后怎么办（需求三）：同一个会话在每条线路上只处理、只提示一次；线路 2 上提示过新开对话的，
 * 回到线路 1 再报也不管（线路 2 都发不出去，线路 1 更不行，再换一次线只会让客户白重开一次 Codex）。
 * - 地址是线路 2：已经超过线路 2 的上限，只提示新开对话。
 * - 地址是线路 1：设置里选了只用线路 1，只提示；「自动」的站线路 2 查得通就换过去、让 Codex 跟过去、提示重开，
 *   查不通只提示；已经在线路 2 上了（换线以前开的对话），提示重开。
 * 不是星芒的地址、不是当前账号那个站的，不管。
 */
export function createCodexPayloadLimitService(dependencies: CodexPayloadLimitDependencies) {
  const now = dependencies.now ?? Date.now
  let state: CodexPayloadState = { handled: {}, handledDirect: {}, warned: {} }
  try {
    const saved = dependencies.readState()
    if (saved) state = copyState(saved)
  } catch {
    state = { handled: {}, handledDirect: {}, warned: {} }
  }
  let writing: Promise<void> = Promise.resolve()

  function log(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void {
    try { dependencies.log?.(level, event, message, detail) } catch { /* 记日志失败不影响别的 */ }
  }

  /** 线路 2 上提示过新开对话的，哪条线路再报都不管（见上）。 */
  function seen(sessionId: string, line: RelayEndpointId): boolean {
    if (Object.hasOwn(state.handledDirect, sessionId)) return true
    return line === 'primary' && Object.hasOwn(state.handled, sessionId)
  }

  function record(field: keyof CodexPayloadState, sessionId: string): void {
    const at = now()
    state = { ...state, [field]: pruneSessions({ ...state[field], [sessionId]: at }, at) }
    const copy = copyState(state)
    // 一个写完再写下一个。存不下最多重启以后同一个对话再提示一次。
    writing = writing.then(() => dependencies.writeState(copy)).catch(() => {
      log('warn', 'codex-payload.persist-failed', '处理过的 Codex 对话没有记下来，重启后可能再提示一次', {})
    })
  }

  function notify(kind: CodexPayloadNoticeKind): void {
    try { dependencies.notify(kind) } catch { /* 出提示失败不影响别的 */ }
  }

  async function decide(siteId: RelayRouteSiteId, line: RelayEndpointId): Promise<CodexPayloadAction> {
    if (line === 'direct') return 'too-large'
    const preference = dependencies.preference(siteId)
    if (preference === 'primary') return 'locked'
    const result = preference === 'direct' ? 'already' : await dependencies.holdDirect(siteId, 'payload-too-large')
    if (result === 'fixed') return 'locked'
    if (result === 'unreachable') return 'unreachable'
    const followed = await dependencies.followCodex(siteId, result).catch(() => false)
    return followed ? result : 'unfollowed'
  }

  return {
    async payloadTooLarge(event: CodexPayloadTooLargeEvent): Promise<void> {
      const at = now()
      if (Math.abs(at - event.at) > codexPayloadStaleMs) return
      const endpoint = relayEndpointForUrl(event.url)
      // 不是星芒的线路（官方账号、别家中转）。
      if (!endpoint) return
      const activeSiteId = dependencies.activeSiteId()
      if (endpoint.siteId !== activeSiteId || seen(event.sessionId, endpoint.endpointId)) return
      record(endpoint.endpointId === 'direct' ? 'handledDirect' : 'handled', event.sessionId)
      const action = await decide(endpoint.siteId, endpoint.endpointId)
      if (action !== 'switched' && action !== 'already') notify(action)
      log('info', 'relay.route.payload-too-large', action === 'switched'
        ? 'Codex 有个对话太大、线路1发不出去，已换到线路2'
        : action === 'already' ? 'Codex 有个对话太大、线路1发不出去，已经在线路2上，提示重开 Codex'
          : 'Codex 有个对话太大、发不出去，提示新开对话', {
        sessionId: event.sessionId,
        siteId: endpoint.siteId,
        from: endpoint.endpointId,
        to: action === 'switched' || action === 'already' ? 'direct' : null,
        action,
        rolloutBytes: event.rolloutBytes,
      })
    },
    largeSession(event: CodexLargeSessionEvent): void {
      if (dependencies.warnNearing === false || event.rolloutBytes < codexPayloadNearingBytes) return
      if (seen(event.sessionId, 'primary') || Object.hasOwn(state.warned, event.sessionId)) return
      const siteId = dependencies.activeSiteId()
      if (!isRouteSite(siteId) || !dependencies.codexOnRelay() || dependencies.toolLine(siteId) !== 'primary') return
      record('warned', event.sessionId)
      notify('nearing')
      log('info', 'relay.route.payload-nearing', 'Codex 有个对话快到线路1的上限了，提醒客户新开对话', {
        sessionId: event.sessionId, siteId, line: 'primary', rolloutBytes: event.rolloutBytes,
      })
    },
  }
}

const stateLabel = 'Codex 对话大小记录'
const maxStateBytes = 16 * 1024
const storedSessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function parseSessions(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const parsed: Record<string, number> = {}
  for (const [sessionId, at] of Object.entries(value)) {
    if (storedSessionPattern.test(sessionId) && typeof at === 'number' && Number.isSafeInteger(at) && at > 0) parsed[sessionId] = at
  }
  return parsed
}

/** 解析存下的记录；认不出的会话 ID、时刻一律丢掉，整体不像样就给 null。 */
export function parseCodexPayloadState(text: string): CodexPayloadState | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!isRecord(value) || value.version !== 1) return null
  return { handled: parseSessions(value.handled), handledDirect: parseSessions(value.handledDirect), warned: parseSessions(value.warned) }
}

/** 存处理过、提醒过的会话（codex-payload-sessions.json）。读坏了当没有：最多同一个对话再提示一次。 */
export function createCodexPayloadStateStore(filePath: string): Pick<CodexPayloadLimitDependencies, 'readState' | 'writeState'> {
  if (!path.isAbsolute(filePath)) throw new Error('Codex 对话大小记录必须使用绝对路径。')
  return {
    readState() {
      try {
        const content = readSafeUtf8FileSync(filePath, stateLabel, maxStateBytes)
        return content === null ? null : parseCodexPayloadState(content)
      } catch {
        return null
      }
    },
    async writeState(value) {
      const parsed = parseCodexPayloadState(JSON.stringify({ version: 1, ...value }))
      if (!parsed) throw new Error('Codex 对话大小记录不完整，没有写入。')
      ensureSafeDataDirectory(path.dirname(filePath), stateLabel)
      await writeAtomicSafeUtf8File(filePath, `${JSON.stringify({ version: 1, ...parsed })}\n`, stateLabel)
    },
  }
}

/** 给界面的那条「新开对话」提示：出来以后半小时内有效（窗口晚开、重载还看得到），同 tool-route-follow-service.ts 的重开提示。 */
export const codexPayloadNoticeTtlMs = 30 * 60_000

export type CodexPayloadNoticeBoard = ReturnType<typeof createCodexPayloadNoticeBoard>

export function createCodexPayloadNoticeBoard(now: () => number = Date.now) {
  let latest: CodexPayloadNotice | null = null
  let shownAt = 0
  return {
    show(kind: CodexPayloadNoticeKind): CodexPayloadNotice {
      shownAt = now()
      // 同一毫秒里来两条也要分得开：渲染层按 id 只弹一次。
      latest = { id: Math.max(shownAt, (latest?.id ?? 0) + 1), kind }
      return { ...latest }
    },
    current(): CodexPayloadNotice | undefined {
      if (!latest) return undefined
      const age = now() - shownAt
      return age >= 0 && age < codexPayloadNoticeTtlMs ? { ...latest } : undefined
    },
  }
}

import path from 'node:path'
import { readBoundedResponseText } from './bounded-response'
import { ensureSafeDataDirectory, readSafeUtf8File, removeSafeDataFile, writeAtomicSafeUtf8File } from './safe-local-data'
import {
  addUsageEvent,
  buildUsageStatsPath,
  emptyUsageStatsState,
  isMainProcessStall,
  parseUsageStatsState,
  serializeUsageStatsState,
  subtractUsageCounters,
  usageMaxAttemptsPerDay,
  usageStatsDay,
  usageStatsOrigins,
  withoutExpiredCounters,
  type UsageStatsEvent,
  type UsageStatsSnapshot,
  type UsageStatsState,
} from './usage-stats'

export interface UsageStatsReporterOptions {
  /** 本机计数文件，放在星芒自己的数据目录。 */
  filePath: string
  /** 每次记数、每次发送前都现问一次，客户关掉开关后下一次就停。 */
  isEnabled(): boolean
  /** 除计数以外的那些（版本、系统、装了哪些工具……）。只读手上现成的，不起新检测。 */
  collect(): Promise<UsageStatsSnapshot>
  /** 只会拿两个固定地址来调，所以比 typeof fetch 窄。 */
  fetchImpl(url: string, init: RequestInit): Promise<Response>
  now?(): Date
  /** 发送失败只记在本机日志，不重试到底、也不告诉客户。 */
  onSendFailure?(error: unknown): void
  /** 本机这边出的错（读写计数文件、收集现状），同样只记日志。 */
  onLocalFailure?(error: unknown): void
  /** 打开后等多久发第一次：不跟开机检测抢。 */
  initialDelayMs?: number
  /** 之后每隔多久看一次是不是换了一天。 */
  intervalMs?: number
  /** 没发成的话多久后再试。 */
  retryDelayMs?: number
  timeoutMs?: number
}

export type UsageStatsRunResult = 'sent' | 'skipped' | 'failed' | 'disabled'

export interface UsageStatsReporter {
  record(event: UsageStatsEvent): void
  start(): void
  /** 退出时调：停掉定时，之后记的一律不算。 */
  stop(): void
  /** 跑一次「今天发了没有，没发就发」。定时器调它，测试也直接调。 */
  runOnce(): Promise<UsageStatsRunResult>
  /** 已排队的读写都做完时兑现；测试用。 */
  idle(): Promise<void>
}

const storeLabel = '匿名使用统计记录'
// 整份最多几十个计数加几个日期，一两 KB；上限只防这个位置被换成别的大文件。
const maxStoreBytes = 16 * 1024
const maxResponseBytes = 16 * 1024
const defaultInitialDelayMs = 3 * 60 * 1000
const defaultIntervalMs = 6 * 60 * 60 * 1000
const defaultRetryDelayMs = 30 * 60 * 1000
const defaultTimeoutMs = 10_000
const redirectStatuses = new Set([301, 302, 303, 307, 308])

/**
 * Whether one GET reached the place where it is counted. The primary origin
 * is Cloudflare itself, which logs every request it answers, so any response
 * there counts -- even the expected 404, since nothing is stored under
 * stats/. The fallback is a plain nginx forward, whose 5xx means the request
 * never got through to Cloudflare. A redirect is never followed: it would
 * hand the record to a host neither origin named.
 */
async function deliverOnce(
  origin: string,
  pathName: string,
  options: UsageStatsReporterOptions,
  primary: boolean,
): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs)
  timeout.unref?.()
  try {
    const response = await options.fetchImpl(`${origin}${pathName}`, {
      method: 'GET',
      redirect: 'manual',
      // The default session's cookie jar holds the account's refresh cookie
      // (I3); this request has no business carrying it anywhere.
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (redirectStatuses.has(response.status)) return false
    if (response.url && !sameOrigin(response.url, origin)) return false
    // Drain a bounded amount so the connection can close; the body is never used.
    await readBoundedResponseText(response, maxResponseBytes, '匿名使用统计').catch(() => '')
    return primary || response.status < 500
  } finally {
    clearTimeout(timeout)
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

async function deliver(pathName: string, options: UsageStatsReporterOptions): Promise<boolean> {
  for (const [index, origin] of usageStatsOrigins.entries()) {
    try {
      if (await deliverOnce(origin, pathName, options, index === 0)) return true
      // A response that does not count (a redirect, or the forward's 5xx) is
      // not a reason to send the same day's record a second way.
      return false
    } catch (error) {
      options.onSendFailure?.(error)
    }
  }
  return false
}

export function createUsageStatsReporter(options: UsageStatsReporterOptions): UsageStatsReporter {
  if (!path.isAbsolute(options.filePath)) throw new Error('匿名使用统计记录必须使用绝对路径。')
  const now = options.now ?? (() => new Date())
  let cached: UsageStatsState | null = null
  // 关掉开关后本机那份删过一次就不再删：每次定时检查都去删一个不存在的文件没有意义。
  let discarded = false
  let queue: Promise<unknown> = Promise.resolve()
  let timer: NodeJS.Timeout | null = null
  let running = false
  // 退出时停下以后不再记：退出过程中各处收尾报的错不算客户碰到的。
  let stopped = false

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task)
    queue = result.catch(() => undefined)
    return result
  }

  async function load(): Promise<UsageStatsState> {
    if (cached) return cached
    try {
      const content = await readSafeUtf8File(options.filePath, storeLabel, maxStoreBytes)
      cached = content === null ? emptyUsageStatsState() : parseUsageStatsState(content)
    } catch {
      cached = emptyUsageStatsState()
    }
    return cached
  }

  async function persist(next: UsageStatsState): Promise<void> {
    cached = next
    discarded = false
    ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
    await writeAtomicSafeUtf8File(options.filePath, serializeUsageStatsState(next), storeLabel)
  }

  // 客户关掉开关：攒着的计数和本机那份一起丢掉，不留到下次打开。
  function discard(): Promise<void> {
    if (discarded) return Promise.resolve()
    return serial(async () => {
      cached = emptyUsageStatsState()
      discarded = true
      await removeSafeDataFile(options.filePath, storeLabel)
    }).catch((error: unknown) => { options.onLocalFailure?.(error) })
  }

  function record(event: UsageStatsEvent): void {
    if (stopped || !options.isEnabled()) return
    void serial(async () => {
      const at = now().getTime()
      const state = withoutExpiredCounters(await load(), at)
      await persist({ ...state, counters: addUsageEvent(state.counters, event), countersSince: state.countersSince ?? at })
    }).catch((error: unknown) => { options.onLocalFailure?.(error) })
  }

  async function runOnce(): Promise<UsageStatsRunResult> {
    if (!options.isEnabled()) {
      await discard()
      return 'disabled'
    }
    const day = usageStatsDay(now())
    const prepared = await serial(async () => {
      const state = withoutExpiredCounters(await load(), now().getTime())
      if (state.lastSentDay === day) return null
      const attempts = state.attemptDay === day ? state.attempts : 0
      if (attempts >= usageMaxAttemptsPerDay) return null
      // 先记下「今天又试了一次」再发：发到一半退出，下次打开也不会多试。
      await persist({ ...state, attemptDay: day, attempts: attempts + 1 })
      return state.counters
    })
    if (!prepared) return 'skipped'
    const pathName = buildUsageStatsPath(day, await options.collect(), prepared)
    if (!pathName) return 'skipped'
    // 收集现状要一会儿：这期间客户可能刚把开关关掉。
    if (!options.isEnabled()) {
      await discard()
      return 'disabled'
    }
    if (!await deliver(pathName, options)) return 'failed'
    await serial(async () => {
      if (!options.isEnabled()) return
      const state = await load()
      const counters = subtractUsageCounters(state.counters, prepared)
      await persist({ ...state, lastSentDay: day, counters, countersSince: Object.keys(counters).length ? state.countersSince : null })
    })
    return 'sent'
  }

  function schedule(delayMs: number): void {
    if (!running) return
    timer = setTimeout(() => {
      timer = null
      void runOnce()
        .then((result) => schedule(result === 'failed' ? options.retryDelayMs ?? defaultRetryDelayMs : options.intervalMs ?? defaultIntervalMs))
        .catch((error: unknown) => {
          options.onLocalFailure?.(error)
          schedule(options.intervalMs ?? defaultIntervalMs)
        })
    }, delayMs)
    timer.unref?.()
  }

  return {
    record,
    runOnce,
    start() {
      if (running || stopped) return
      running = true
      schedule(options.initialDelayMs ?? defaultInitialDelayMs)
    },
    stop() {
      running = false
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    idle() {
      return queue.then(() => undefined, () => undefined)
    },
  }
}

export interface MainStallMonitorOptions {
  onStall(): void
  intervalMs?: number
  /** 单调时钟（performance.now）；测试里换成假的。 */
  clock?: () => number
}

export interface MainStallMonitor {
  /** 星芒的窗口到了前台：开始量。 */
  resume(): void
  /** 没有星芒的窗口在前台：停下，不在后台空转。 */
  pause(): void
  stop(): void
}

/**
 * 主进程卡住时界面整个不动（Windows 上窗口消息也是主进程在处理），可 Electron 不会为这个报
 * 「没响应」——报的那个是渲染层。所以拿一个每秒一次的计时器量它晚到了多久（isMainProcessStall）。
 */
export function createMainStallMonitor(options: MainStallMonitorOptions): MainStallMonitor {
  const intervalMs = options.intervalMs ?? 1_000
  const clock = options.clock ?? (() => performance.now())
  let timer: NodeJS.Timeout | null = null
  let last = 0
  let stopped = false

  function pause(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    resume() {
      if (stopped || timer) return
      last = clock()
      timer = setInterval(() => {
        const current = clock()
        const elapsed = current - last
        last = current
        if (isMainProcessStall(intervalMs, elapsed)) options.onStall()
      }, intervalMs)
      timer.unref?.()
    },
    pause,
    stop() {
      stopped = true
      pause()
    },
  }
}

import path from 'node:path'
import { readBoundedResponseText } from './bounded-response'
import {
  clientVersionReportDay,
  clientVersionReportDigest,
  clientVersionReportUrl,
  emptyClientVersionReportState,
  parseClientVersionReportState,
  planClientVersionReport,
  serializeClientVersionReport,
  serializeClientVersionReportState,
  type ClientVersionReport,
  type ClientVersionReportState,
} from './client-version-report'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

export interface ClientVersionReporterOptions {
  /** 本机记「今天报过没有」的文件，放在星芒自己的数据目录。 */
  filePath: string
  /** 现在登录的是谁、什么版本；没登录返回 null。只读手上现成的，不起新请求。 */
  collect(): ClientVersionReport | null
  /** 只会拿 clientVersionReportUrl 来调，所以比 typeof fetch 窄。 */
  fetchImpl(url: string, init: RequestInit): Promise<Response>
  now?(): Date
  /** 发不出去（连不上、超时）只记本机日志，不告诉客户。 */
  onSendFailure?(error: unknown): void
  /** 控制台回了不是 2xx 的状态（接收口还没上线、限速、不认这份）：同样只记日志。 */
  onRejected?(status: number): void
  /** 本机这边出的错（读写记录文件），同样只记日志。 */
  onLocalFailure?(error: unknown): void
  /** 打开后等多久报第一次：不跟开机检测抢。 */
  initialDelayMs?: number
  /** 登录、换账号后等多久报：登录后那一阵要拉资料、余额、密钥，往后排一点。 */
  accountChangeDelayMs?: number
  /** 之后每隔多久看一次是不是换了一天。 */
  intervalMs?: number
  /** 没报成的话多久后再试。 */
  retryDelayMs?: number
  timeoutMs?: number
}

export type ClientVersionReportResult = 'sent' | 'skipped' | 'failed'

export interface ClientVersionReporter {
  start(): void
  /** 退出时调：停掉定时，之后不再报。 */
  stop(): void
  /** 账号登录态变了（登录、退出、换人、续期都会走到这里）：排一次报告，不会把已经排好的往后推。 */
  accountChanged(): void
  /** 跑一次「这一份今天报了没有，没报就报」。定时器调它，测试也直接调。 */
  runOnce(): Promise<ClientVersionReportResult>
  /** 正在跑的那一次和已排队的读写都做完时兑现；测试用。 */
  idle(): Promise<void>
}

const storeLabel = '客户端版本上报记录'
// 整份就一个摘要加几个日期，几十个字节；上限只防这个位置被换成别的大文件。
const maxStoreBytes = 4 * 1024
// 控制台只回一句「收下了」；读一点点让连接能关掉，内容不用。
const maxResponseBytes = 4 * 1024
const defaultInitialDelayMs = 3 * 60 * 1000
const defaultAccountChangeDelayMs = 60 * 1000
const defaultIntervalMs = 6 * 60 * 60 * 1000
const defaultRetryDelayMs = 30 * 60 * 1000
const defaultTimeoutMs = 10_000
const redirectStatuses = new Set([301, 302, 303, 307, 308])

/**
 * One POST of the report to the console's fixed address. A redirect is never
 * followed -- it would hand the account id to a host nobody named -- and the
 * default session's cookie jar (which holds the account's refresh cookie, I3)
 * is never attached. Only a 2xx counts as delivered.
 */
async function deliver(report: ClientVersionReport, options: ClientVersionReporterOptions): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs)
  timeout.unref?.()
  try {
    const response = await options.fetchImpl(clientVersionReportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serializeClientVersionReport(report),
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (redirectStatuses.has(response.status) || response.type === 'opaqueredirect') {
      options.onRejected?.(response.status)
      return false
    }
    if (response.url && !sameOrigin(response.url, clientVersionReportUrl)) {
      options.onRejected?.(response.status)
      return false
    }
    await readBoundedResponseText(response, maxResponseBytes, '客户端版本上报').catch(() => '')
    if (response.status >= 200 && response.status < 300) return true
    options.onRejected?.(response.status)
    return false
  } catch (error) {
    options.onSendFailure?.(error)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function sameOrigin(url: string, expected: string): boolean {
  try {
    return new URL(url).origin === new URL(expected).origin
  } catch {
    return false
  }
}

export function createClientVersionReporter(options: ClientVersionReporterOptions): ClientVersionReporter {
  if (!path.isAbsolute(options.filePath)) throw new Error('客户端版本上报记录必须使用绝对路径。')
  const now = options.now ?? (() => new Date())
  let cached: ClientVersionReportState | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let timer: NodeJS.Timeout | null = null
  let dueAt = 0
  let running = false
  let stopped = false
  // 同一时间只跑一次：定时到点和刚登录排的那次撞在一起时，后一次等前一次的结果。
  let inFlight: Promise<ClientVersionReportResult> | null = null

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task)
    queue = result.catch(() => undefined)
    return result
  }

  async function load(): Promise<ClientVersionReportState> {
    if (cached) return cached
    try {
      const content = await readSafeUtf8File(options.filePath, storeLabel, maxStoreBytes)
      cached = content === null ? emptyClientVersionReportState() : parseClientVersionReportState(content)
    } catch {
      cached = emptyClientVersionReportState()
    }
    return cached
  }

  async function persist(next: ClientVersionReportState): Promise<void> {
    cached = next
    ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
    await writeAtomicSafeUtf8File(options.filePath, serializeClientVersionReportState(next), storeLabel)
  }

  async function attempt(): Promise<ClientVersionReportResult> {
    if (stopped) return 'skipped'
    const report = options.collect()
    if (!report) return 'skipped'
    const digest = clientVersionReportDigest(report)
    const day = clientVersionReportDay(now())
    const planned = await serial(async () => {
      const next = planClientVersionReport(await load(), digest, day)
      if (next) await persist(next)
      return next
    })
    if (!planned) return 'skipped'
    if (!await deliver(report, options)) return 'failed'
    await serial(async () => {
      await persist({ ...await load(), sentDigest: digest, sentDay: day })
    })
    return 'sent'
  }

  function runOnce(): Promise<ClientVersionReportResult> {
    if (inFlight) return inFlight
    const current = attempt().finally(() => { inFlight = null })
    inFlight = current
    return current
  }

  function schedule(delayMs: number): void {
    if (!running) return
    if (timer) clearTimeout(timer)
    dueAt = now().getTime() + delayMs
    timer = setTimeout(() => {
      timer = null
      void runOnce()
        .then((result) => scheduleNext(result === 'failed' ? options.retryDelayMs ?? defaultRetryDelayMs : options.intervalMs ?? defaultIntervalMs))
        .catch((error: unknown) => {
          options.onLocalFailure?.(error)
          scheduleNext(options.intervalMs ?? defaultIntervalMs)
        })
    }, delayMs)
    timer.unref?.()
  }

  // 这一轮跑着的时候客户刚好登录或换人，accountChanged 已经排了更早的一次：留着它，不拿 6 小时后的盖掉。
  function scheduleNext(delayMs: number): void {
    if (!timer) schedule(delayMs)
  }

  return {
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
    accountChanged() {
      if (!running) return
      const delayMs = options.accountChangeDelayMs ?? defaultAccountChangeDelayMs
      // 续期、刷新资料也会走到这里，而且可能很频繁：只往前提，不往后推，不然一直有变化就一直报不出去。
      if (timer && dueAt <= now().getTime() + delayMs) return
      schedule(delayMs)
    },
    async idle() {
      // 发成功后记「已报」那一笔，要等请求回来才排进队：只等调用那一刻的队列，会在它还在写盘时就兑现。
      await inFlight?.catch(() => undefined)
      await queue.catch(() => undefined)
    },
  }
}

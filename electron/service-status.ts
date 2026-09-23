import { readBoundedUtf8FileSync } from './bounded-file'
import { readBoundedResponseText } from './bounded-response'

/**
 * 更新目录上的一份状态文件（`service-status.json`），给发布者一个不发版就能对
 * 已装好的客户端说话的地方。
 *
 * 为什么要它：星芒站维护或被防护层拦住时，客户端只能从一次失败的请求里倒推原因，
 * 猜出来的往往是「Key 坏了」「登录失效」；而站内公告要登录后才看得到，没登录的
 * 人连「在维护」都无从知道。更新目录是静态文件，和账号服务不在一处，账号服务停了
 * 它照样答话，所以把「正在维护」放在这里。
 *
 * 这份文件只能让客户端「少做」或「多说一句」，不能让它多拿任何能力：读不到、格式
 * 不对、字段缺失，一律当作没有这份文件——没在维护，客户端照常工作。它绝不能因为
 * 这份文件读不到而报错或拖慢启动。
 */
export const serviceStatusFileName = 'service-status.json'

export interface ServiceMaintenance {
  /** 发布者写给用户的一句话；没写就是 null，界面用自己的默认说法。 */
  message: string | null
}

export interface ServiceStatus {
  /** 正在维护为对象，没在维护为 null。 */
  maintenance: ServiceMaintenance | null
}

export const emptyServiceStatus: ServiceStatus = Object.freeze({ maintenance: null })

// 一份只写着几个开关的 JSON 远用不到这么大；上限是给「这个地址被换成了别的东西」
// 准备的，免得把一整张网页读进内存再去解析。
const maxStatusBytes = 16 * 1024
const maxMessageLength = 200
const defaultTimeoutMs = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * electron-builder 写进安装包的 `app-update.yml` 只有几行 `key: value`，这里只取
 * `url` 那一行，不为它引入 YAML 解析器。地址的要求与构建脚本
 * `normalizeUpdateBaseUrl` 一致：HTTPS、不内嵌账号密码、不带查询参数与片段；只有
 * 开发态更新源允许本机 HTTP。任何一条不满足就返回 null——读不到状态文件而已。
 */
export function resolveServiceStatusUrl(
  updateConfigText: string,
  options: { allowLocalHttp?: boolean } = {},
): string | null {
  const line = updateConfigText.split(/\r?\n/).find((entry) => /^url\s*:/.test(entry))
  if (!line) return null
  const raw = line.slice(line.indexOf(':') + 1).trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  if (!raw) return null
  let base: URL
  try {
    base = new URL(raw)
  } catch {
    return null
  }
  const localHttp = options.allowLocalHttp === true && base.protocol === 'http:' && isLoopbackHost(base.hostname)
  if (base.protocol !== 'https:' && !localHttp) return null
  if (base.protocol === 'https:' && isLoopbackHost(base.hostname)) return null
  if (base.username || base.password || base.search || base.hash) return null
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`
  return new URL(serviceStatusFileName, base).href
}

/**
 * 从安装包里的更新配置推出状态文件的地址：正式包读资源目录的 `app-update.yml`，
 * 开发态读 `dev-app-update.yml`。文件在用户可写的安装目录下，所以照 I8 走有界、
 * 拒绝链接的读法；读不出来返回 null，这台客户端就不看状态文件。
 */
export function locateServiceStatusUrl(updateConfigPath: string, options: { allowLocalHttp?: boolean } = {}): string | null {
  try {
    return resolveServiceStatusUrl(readBoundedUtf8FileSync(updateConfigPath, 16 * 1024, '更新配置'), options)
  } catch {
    return null
  }
}

// 控制字符与双向文本控制符会让一句公告在界面上排版错乱，或把后半句伪装成别的
// 内容；这份文字只该是一句普通的话。
const unsafeCharacters = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

function readMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(unsafeCharacters, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return Array.from(cleaned).slice(0, maxMessageLength).join('')
}

function readMaintenance(value: unknown, now: Date): ServiceMaintenance | null {
  if (!isRecord(value) || value.active !== true) return null
  // until 是给「维护完忘了关」兜底的：过了这个时间就当维护结束，客户端不会一直
  // 挂着一条过期的维护提示。写错了读不出来就不管它，只认 active。
  if (typeof value.until === 'string') {
    const until = Date.parse(value.until)
    if (Number.isFinite(until) && until <= now.getTime()) return null
  }
  return { message: readMessage(value.message) }
}

/** 解析状态文件；格式不对的部分一律按「没有」处理，永不抛错。 */
export function parseServiceStatus(text: string, now: Date): ServiceStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return emptyServiceStatus
  }
  if (!isRecord(parsed)) return emptyServiceStatus
  return { maintenance: readMaintenance(parsed.maintenance, now) }
}

export interface ServiceStatusReaderOptions {
  url: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
  now?: () => Date
}

/**
 * 读一次状态文件。读不到（没联网、文件不存在、超时、被重定向、太大、不是 JSON）
 * 返回 null，调用方把它当成「没在维护」。
 *
 * 重定向直接拒绝：这份文件和更新清单放在同一个目录，没有任何理由跳去别处；门户
 * 认证页之类的拦截会把它换成一张网页，跟着跳过去读到的只会是别人的内容。
 */
export async function readServiceStatus(options: ServiceStatusReaderOptions): Promise<ServiceStatus | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs)
  timer.unref?.()
  try {
    const response = await options.fetch(options.url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const text = await readBoundedResponseText(response, maxStatusBytes, '服务状态文件')
    return parseServiceStatus(text, (options.now ?? (() => new Date()))())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface ServiceStatusMonitorOptions {
  read: () => Promise<ServiceStatus | null>
  onChange: (status: ServiceStatus | null) => void
  /** 平时多久看一次；默认 15 分钟。 */
  idleIntervalMs?: number
  /** 维护期间多久看一次，好让维护一结束提示就消失；默认 5 分钟。 */
  activeIntervalMs?: number
}

export interface ServiceStatusMonitor {
  start(): void
  refresh(): Promise<ServiceStatus | null>
  current(): ServiceStatus | null
  dispose(): void
}

function sameStatus(left: ServiceStatus | null, right: ServiceStatus | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * 启动时读一次，之后定时再读。同一时间只有一个请求在路上，调用方并发 refresh
 * 拿到的是同一个结果；结果变了才通知。
 */
export function createServiceStatusMonitor(options: ServiceStatusMonitorOptions): ServiceStatusMonitor {
  const idleIntervalMs = options.idleIntervalMs ?? 15 * 60_000
  const activeIntervalMs = options.activeIntervalMs ?? 5 * 60_000
  let status: ServiceStatus | null = null
  let inflight: Promise<ServiceStatus | null> | null = null
  let timer: NodeJS.Timeout | null = null
  let started = false
  let disposed = false

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!started || disposed) return
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, status?.maintenance ? activeIntervalMs : idleIntervalMs)
    timer.unref?.()
  }

  function refresh(): Promise<ServiceStatus | null> {
    if (disposed) return Promise.resolve(status)
    if (inflight) return inflight
    inflight = (async () => {
      let next: ServiceStatus | null
      try {
        next = await options.read()
      } catch {
        next = null
      }
      if (disposed) return status
      const changed = !sameStatus(status, next)
      status = next
      if (changed) {
        try { options.onChange(next) } catch { /* a listener failure must not stop the polling */ }
      }
      return status
    })().finally(() => {
      inflight = null
      schedule()
    })
    return inflight
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      void refresh()
    },
    refresh,
    current: () => status,
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

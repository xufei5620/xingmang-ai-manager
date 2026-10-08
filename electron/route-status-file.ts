import net from 'node:net'
import { readBoundedResponseText } from './bounded-response'
import { relayEndpointOrigin, type RelayEndpointId } from './relay-sites'

/**
 * 服务端发布的线路状态文件 /xm-route-status.json（xm 三线路 C5，需求第 7 节）。服务端还没上线：现在
 * 读到的是 404 或一张网页，按「读不到」处理，只是不许新分配香港，别的照常（需求 7.4）。
 *
 * 和更新目录里的 service-status.json（维护提示、撤回版本、分批放量）是两份不同的文件。
 */

/** 状态文件里认得的线路 id。v1 只会写 direct 和 direct-hk；别的 id 一律忽略。 */
export const routeStatusLineIds = ['direct', 'direct-hk'] as const
export type RouteStatusLineId = typeof routeStatusLineIds[number]

export type RouteIncidentState = 'none' | 'suspected' | 'switching' | 'switched'

export interface RouteStatusLine {
  /** 这个域名现在指向哪台入口（lax / hkg / 别的）；只给诊断看，不认识的值当普通字符串。 */
  target: string | null
  /** true = 这个域名现在被切到了 CF，合法地址改看 CF 的地址段。 */
  proxied: boolean
  /** 服务端看这条线路健不健康。 */
  healthy: boolean
  /** 这个域名当前的合法地址，每一项都已经确认是 IP 字面量。 */
  legitIps: string[]
}

export interface RouteStatus {
  updatedAt: string | null
  incident: { line: string | null; state: RouteIncidentState; since: string | null }
  lines: Partial<Record<RouteStatusLineId, RouteStatusLine>>
  hkEnabled: boolean
  hkRecommended: boolean
}

export const routeStatusPath = '/xm-route-status.json'
const maximumStatusBytes = 16 * 1024
const statusTimeoutMs = 10_000
export const routeStatusCacheMs = 10 * 60_000
const maximumLegitIps = 64
const incidentStates: readonly RouteIncidentState[] = ['none', 'suspected', 'switching', 'switched']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 只进诊断显示的短字符串：控制字符、过长的一律不要。
function shortText(value: unknown, maximum = 64): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1F\x7F]/.test(value) ? value : null
}

function parseLine(value: unknown): RouteStatusLine | null {
  if (!isRecord(value)) return null
  const legitIps = Array.isArray(value.legit_ips)
    ? value.legit_ips.filter((entry): entry is string => typeof entry === 'string' && net.isIP(entry) !== 0).slice(0, maximumLegitIps)
    : []
  return { target: shortText(value.target), proxied: value.proxied === true, healthy: value.healthy === true, legitIps }
}

/** 解析状态文件正文；不是 JSON 对象、v 不是 1 都返回 null（按读不到处理）。不认识的字段、线路 id 忽略。 */
export function parseRouteStatus(text: string): RouteStatus | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null
  const incident = isRecord(parsed.incident) ? parsed.incident : {}
  const state = incidentStates.find((entry) => entry === incident.state) ?? 'none'
  const lines: RouteStatus['lines'] = {}
  if (isRecord(parsed.lines)) {
    for (const id of routeStatusLineIds) {
      const line = parseLine(parsed.lines[id])
      if (line) lines[id] = line
    }
  }
  return {
    updatedAt: shortText(parsed.updated_at),
    incident: { line: shortText(incident.line), state, since: shortText(incident.since) },
    lines,
    hkEnabled: parsed.hk_enabled === true,
    hkRecommended: parsed.hk_recommended === true,
  }
}

/** 服务端正说这条线路出了事（先写 incident 再改 DNS）：降级前要等一等（需求 5.1.5）。 */
export function routeIncidentActive(status: RouteStatus | null, line: string): boolean {
  return status !== null && status.incident.line === line && status.incident.state !== 'none'
}

/** 香港能不能新分配：状态文件读得到，并且两个开关都开着（需求 5.1.3、7.4）。 */
export function routeStatusAllowsHongKong(status: RouteStatus | null): boolean {
  return status !== null && status.hkEnabled && status.hkRecommended
}

export interface RouteStatusReaderOptions {
  /**
   * 带代理分流的普通 fetch（main.ts 的 relayFetch）。不要传 createRelayLineFetch 出来的那个：
   * 它会自己换线、退回，这里要按 origin 显式去读。
   */
  fetch: typeof fetch
  /** 按顺序试哪几条线路：当前应用线路在前，读不到再试另一条。 */
  lines(): readonly RelayEndpointId[]
  /** 测试注入用；缺省 Date.now。 */
  now?(): number
  log?(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void
}

export interface RouteStatusReader {
  /** fresh = 不走缓存（因故障准备改写配置之前、遇到不认识的地址时）。读不到返回 null，不抛错。 */
  read(options?: { fresh?: boolean }): Promise<RouteStatus | null>
}

/**
 * 读状态文件。照 I10：超时、正文 16KB 上限、不跟重定向、只去本站自己的线路 origin（不去退役别名）。
 * 读失败不算线路失败，不报给线路控制器（同 /api/notice）。平时缓存 10 分钟，读不到也缓存，免得
 * 状态文件没上线这段时间每次探测都多发两次请求。
 */
export function createRouteStatusReader(options: RouteStatusReaderOptions): RouteStatusReader {
  const now = options.now ?? Date.now
  let cached: { at: number; status: RouteStatus | null } | null = null
  let inFlight: Promise<RouteStatus | null> | null = null

  async function readFrom(line: RelayEndpointId): Promise<RouteStatus | null> {
    const origin = relayEndpointOrigin('solov', line)
    if (!origin) return null
    const response = await options.fetch(`${origin}${routeStatusPath}`, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(statusTimeoutMs),
    })
    if (response.status !== 200 || response.type === 'opaqueredirect') {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    return parseRouteStatus(await readBoundedResponseText(response, maximumStatusBytes, '线路状态文件'))
  }

  async function readAll(): Promise<RouteStatus | null> {
    const tried = new Set<RelayEndpointId>()
    for (const line of options.lines()) {
      if (tried.has(line)) continue
      tried.add(line)
      try {
        const status = await readFrom(line)
        if (status) return status
      } catch {
        // 换下一条线路再试；都读不到才算读不到。
      }
    }
    options.log?.('info', 'relay.route.status-unavailable', '线路状态文件这次没读到，照常探测', { lines: [...tried] })
    return null
  }

  return {
    read(readOptions = {}) {
      const at = now()
      if (!readOptions.fresh && cached && at >= cached.at && at - cached.at < routeStatusCacheMs) return Promise.resolve(cached.status)
      if (inFlight) return inFlight
      const task = readAll().then((status) => {
        cached = { at: now(), status }
        return status
      }).finally(() => {
        if (inFlight === task) inFlight = null
      })
      inFlight = task
      return task
    },
  }
}

/**
 * 「自动」线路怎么定（直连适配第二步，yoyo 10-6 回「改」）。
 *
 * 星芒账号和历史账号各有两条线路：默认线路（xm.solov.cc / api.solov.cc）和直连
 * （xm-direct.solov.cc / api-direct.solov.cc）。选「自动」的站先走直连，直连连不上改走
 * 默认线路；写死一条线路的站不探测、不退回。
 *
 * - 开机不等检查结果：先用上次存下的结论，没有结论就先走默认线路（这时不算定下来，工具
 *   配置不跟着迁），后台查一次健康检查接口再定。
 * - 直连通就用直连；直连不通、默认线路通就改用默认线路；两条都不通（比如开机时还没联网）
 *   就不改，免得工具配置来回换，过一阵再查。
 * - 退回以后每隔一阵查一次直连，连续两次都通才切回来。
 * - 星芒自己的请求在直连上失败了会报到这里，再查一次决定要不要退回（同一时刻只查一次）。
 *
 * 结论落盘（relay-route-lines.json），下次开机先用它。只存线路 id，不存地址：地址只从
 * relay-sites.ts 里来。
 */
import path from 'node:path'
import { readBoundedResponseText } from './bounded-response'
import { isJsonContentType, parsesAsJsonObject } from './network-failure'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import {
  relayRouteSiteIds,
  type RelayEndpointId,
  type RelayRouteLine,
  type RelayRoutePreference,
  type RelayRouteSiteId,
} from './relay-sites'

/** 两条都没连上以后、退回默认线路以后，隔这么久再查。 */
export const relayRouteRecheckIntervalMs = 5 * 60_000

/** 退回默认线路以后，直连连续查通这么多次才切回去：网络时好时坏时不来回换。 */
export const relayRouteRecoveryStreak = 2

/**
 * 请求报上来的直连失败，查过一次以后这么久之内不再为它重查：一批请求一起失败只查一次，
 * 直连其实是通的（失败只是那一下）时也不至于每个请求都去查一遍。
 */
export const relayRouteFailureRecheckGapMs = 30_000

// 健康检查那个接口平时一秒内就回。给太久的话，账号请求（10 秒超时）等它查完再改走默认线路就赶不上了。
const probeTimeoutMs = 5_000
const maxProbeBytes = 256 * 1024

export type RelayRouteChangeReason = 'startup' | 'retry' | 'request-failed' | 'recovered'

export interface RelayRouteState extends RelayRouteLine {
  preference: RelayRoutePreference
}

export interface RelayRouteControllerDependencies {
  /** 开机时生效的偏好；这次运行里不变。 */
  preferences: Readonly<Record<RelayRouteSiteId, RelayRoutePreference>>
  /** 上次存下的结论；读不到、读坏了都当没有。 */
  readConclusions(): Partial<Record<RelayRouteSiteId, RelayEndpointId>>
  writeConclusions(lines: Partial<Record<RelayRouteSiteId, RelayEndpointId>>): Promise<void>
  /** 查一个站的一条线路：通了返回 true；网络层失败、回的不对都返回 false，不抛错。 */
  probe(siteId: RelayRouteSiteId, line: RelayEndpointId): Promise<boolean>
  /** 测试注入用；缺省 setTimeout。 */
  schedule?(callback: () => void, delayMs: number): () => void
  /** 测试注入用；缺省 Date.now。 */
  now?(): number
  log?(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void
}

export interface RelayRouteController {
  /** 每个站这会儿走的线路，给 relay-sites.ts 的 createRelayEndpointRoutingSnapshot 读。 */
  lines(): Record<RelayRouteSiteId, RelayRouteLine>
  /** 一个站这会儿走哪条线路、是不是「自动」挑的（只有「自动」会在直连连不上时改走默认线路）。 */
  route(siteId: RelayRouteSiteId): { line: RelayEndpointId; automatic: boolean }
  /** 开机后在后台查一次「自动」的站。 */
  start(): void
  /**
   * 星芒自己的一次请求在直连上失败了（白名单挡下的 404 不算，那是那一个接口的事）：
   * 再查一次直连，不通、默认线路通才退回。
   */
  reportDirectFailure(siteId: RelayRouteSiteId, reason: string): void
  /** 线路改了就叫一声，返回取消订阅。 */
  subscribe(listener: (siteId: RelayRouteSiteId, line: RelayRouteLine) => void): () => void
  dispose(): void
}

interface SiteState {
  line: RelayEndpointId
  settled: boolean
  /** 退回默认线路以后直连连续查通了几次。 */
  recovered: number
  checking: Promise<void> | null
  /** 上一次为请求报上来的失败去查是什么时候。 */
  failureCheckedAt: number | null
  cancelTimer: (() => void) | null
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createRelayRouteController(dependencies: RelayRouteControllerDependencies): RelayRouteController {
  const schedule = dependencies.schedule ?? scheduleTimeout
  const now = dependencies.now ?? Date.now
  const listeners = new Set<(siteId: RelayRouteSiteId, line: RelayRouteLine) => void>()
  let disposed = false
  let conclusions: Partial<Record<RelayRouteSiteId, RelayEndpointId>> = {}
  try {
    conclusions = dependencies.readConclusions()
  } catch {
    conclusions = {}
  }
  const states = new Map<RelayRouteSiteId, SiteState>()
  for (const siteId of relayRouteSiteIds) {
    if (dependencies.preferences[siteId] !== 'auto') continue
    const concluded = conclusions[siteId]
    states.set(siteId, {
      line: concluded ?? 'primary',
      settled: concluded !== undefined,
      recovered: 0,
      checking: null,
      failureCheckedAt: null,
      cancelTimer: null,
    })
  }

  function log(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void {
    try { dependencies.log?.(level, event, message, detail) } catch { /* 记日志失败不影响定线路 */ }
  }

  function routeLine(siteId: RelayRouteSiteId): RelayRouteLine {
    const preference = dependencies.preferences[siteId]
    if (preference !== 'auto') return { line: preference, settled: true }
    const state = states.get(siteId)
    return state ? { line: state.line, settled: state.settled } : { line: 'primary', settled: false }
  }

  function persist(): void {
    const lines: Partial<Record<RelayRouteSiteId, RelayEndpointId>> = { ...conclusions }
    for (const [siteId, state] of states) {
      if (state.settled) lines[siteId] = state.line
    }
    conclusions = lines
    // 存不下最多下次开机先走上次那条、再查一次，不影响这次。
    void dependencies.writeConclusions(lines).catch((error: unknown) => {
      log('warn', 'relay.route.persist-failed', '线路结论没有存下来，下次开机会再查一次', {
        error: error instanceof Error ? error.name : 'unknown',
      })
    })
  }

  function setTimer(state: SiteState, run: () => void): void {
    state.cancelTimer?.()
    state.cancelTimer = schedule(() => {
      state.cancelTimer = null
      if (!disposed) run()
    }, relayRouteRecheckIntervalMs)
  }

  function settle(siteId: RelayRouteSiteId, state: SiteState, line: RelayEndpointId, reason: RelayRouteChangeReason): void {
    const from = state.line
    const changed = from !== line || !state.settled
    state.line = line
    state.settled = true
    state.recovered = 0
    if (line === 'direct') {
      state.cancelTimer?.()
      state.cancelTimer = null
    } else {
      watchRecovery(siteId, state)
    }
    if (!changed) return
    log('info', 'relay.route.changed', line === 'direct' ? '「自动」线路改走直连' : '「自动」线路改走默认线路', {
      siteId, from, to: line, reason,
    })
    persist()
    const current = { line: state.line, settled: state.settled }
    for (const listener of [...listeners]) {
      try { listener(siteId, current) } catch { /* 一个订阅方出错不影响别的 */ }
    }
  }

  // 退回默认线路以后隔一阵查一次直连，连续查通 relayRouteRecoveryStreak 次才切回去。
  function watchRecovery(siteId: RelayRouteSiteId, state: SiteState): void {
    setTimer(state, () => {
      if (state.line !== 'primary' || state.checking) {
        if (state.line === 'primary') watchRecovery(siteId, state)
        return
      }
      const run = (async () => {
        const reachable = await probe(siteId, 'direct')
        if (disposed || state.line !== 'primary') return
        state.recovered = reachable ? state.recovered + 1 : 0
        if (state.recovered >= relayRouteRecoveryStreak) {
          settle(siteId, state, 'direct', 'recovered')
          return
        }
        watchRecovery(siteId, state)
      })()
      const tracked: Promise<void> = run.finally(() => { if (state.checking === tracked) state.checking = null })
      state.checking = tracked
    })
  }

  async function probe(siteId: RelayRouteSiteId, line: RelayEndpointId): Promise<boolean> {
    try {
      return await dependencies.probe(siteId, line)
    } catch {
      return false
    }
  }

  // 先查直连，不通再查默认线路；两条都不通什么都不改，过一阵再查。
  function evaluate(siteId: RelayRouteSiteId, state: SiteState, reason: RelayRouteChangeReason): Promise<void> {
    const run = (async () => {
      if (await probe(siteId, 'direct')) {
        if (!disposed) settle(siteId, state, 'direct', reason)
        return
      }
      if (disposed) return
      if (await probe(siteId, 'primary')) {
        if (!disposed) settle(siteId, state, 'primary', reason)
        return
      }
      if (disposed) return
      log('warn', 'relay.route.unreachable', '直连和默认线路这会儿都没连上，线路先不改', {
        siteId, line: state.line, settled: state.settled, reason,
      })
      setTimer(state, () => {
        if (!state.checking) void evaluate(siteId, state, 'retry')
      })
    })()
    const tracked: Promise<void> = run.finally(() => { if (state.checking === tracked) state.checking = null })
    state.checking = tracked
    return tracked
  }

  return {
    lines() {
      return { solov: routeLine('solov'), 'solov-api': routeLine('solov-api') }
    },
    route(siteId) {
      return { line: routeLine(siteId).line, automatic: dependencies.preferences[siteId] === 'auto' }
    },
    start() {
      for (const [siteId, state] of states) {
        if (!state.checking) void evaluate(siteId, state, 'startup')
      }
    },
    reportDirectFailure(siteId, reason) {
      const state = states.get(siteId)
      if (disposed || !state || state.line !== 'direct' || state.checking) return
      const at = now()
      if (state.failureCheckedAt !== null && at - state.failureCheckedAt >= 0
        && at - state.failureCheckedAt < relayRouteFailureRecheckGapMs) return
      state.failureCheckedAt = at
      log('info', 'relay.route.direct-failed', '直连上的请求没走通，再查一次直连', { siteId, reason })
      void evaluate(siteId, state, 'request-failed')
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposed = true
      listeners.clear()
      for (const state of states.values()) {
        state.cancelTimer?.()
        state.cancelTimer = null
      }
    },
  }
}

const conclusionsLabel = '连接线路结论'
const maxConclusionsBytes = 4 * 1024

function parseConclusionLine(value: unknown): RelayEndpointId | undefined {
  return value === 'primary' || value === 'direct' ? value : undefined
}

/** 存「自动」上次的结论。读坏了一律当没有：最多开机先走默认线路、再查一次。 */
export function createRelayRouteConclusionStore(filePath: string): Pick<RelayRouteControllerDependencies, 'readConclusions' | 'writeConclusions'> {
  if (!path.isAbsolute(filePath)) throw new Error('连接线路结论必须使用绝对路径。')
  return {
    readConclusions() {
      try {
        const content = readSafeUtf8FileSync(filePath, conclusionsLabel, maxConclusionsBytes)
        if (content === null) return {}
        const value: unknown = JSON.parse(content)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
        const record = value as { version?: unknown; lines?: unknown }
        if (record.version !== 1 || typeof record.lines !== 'object' || record.lines === null || Array.isArray(record.lines)) return {}
        const lines = record.lines as Record<string, unknown>
        const parsed: Partial<Record<RelayRouteSiteId, RelayEndpointId>> = {}
        for (const siteId of relayRouteSiteIds) {
          const line = parseConclusionLine(lines[siteId])
          if (line) parsed[siteId] = line
        }
        return parsed
      } catch {
        return {}
      }
    },
    async writeConclusions(lines) {
      const stored: Partial<Record<RelayRouteSiteId, RelayEndpointId>> = {}
      for (const siteId of relayRouteSiteIds) {
        const line = parseConclusionLine(lines[siteId])
        if (line) stored[siteId] = line
      }
      ensureSafeDataDirectory(path.dirname(filePath), conclusionsLabel)
      await writeAtomicSafeUtf8File(filePath, `${JSON.stringify({ version: 1, lines: stored })}\n`, conclusionsLabel)
    },
  }
}

/**
 * 健康检查：星芒账号查 /api/status，历史账号查 /api/v1/settings/public（diagnostics.ts 的
 * relayStatusProbeUrl，两个都是本来就回 JSON 的公开接口）。回 200 且正文是 JSON 才算通：
 * 白名单挡下的、门户认证页、防护层的验证页回的都是网页。重定向不跟（门户认证正是靠它）。
 */
export async function probeRelayLineHealth(fetchImpl: typeof fetch, url: string): Promise<boolean> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') return false
  const response = await fetchImpl(parsed.href, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'manual',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(probeTimeoutMs),
  })
  if (response.status !== 200 || response.type === 'opaqueredirect' || !isJsonContentType(response.headers.get('content-type'))) {
    await response.body?.cancel().catch(() => undefined)
    return false
  }
  return parsesAsJsonObject(await readBoundedResponseText(response, maxProbeBytes, '线路健康检查'))
}

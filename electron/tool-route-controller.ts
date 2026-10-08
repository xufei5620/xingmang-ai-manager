/**
 * 星芒账号的「工具线路」（xm 三线路 C3，需求 5.1）：写进各 AI 工具配置的那条线路怎么定。管理工具
 * 自己的请求走「应用线路」（relay-route-controller.ts，原样保留，历史账号也只用它），两套可以不一样：
 * 管理工具走 Chromium、能连上洛杉矶，不等于跑在 Node 里的命令行工具也连得上。
 *
 * - 候选按优先级：L1 洛杉矶（direct）→ L2 香港（direct-hk，第一批只是占位，永远选不上）→ L3 CF（primary）。
 * - 当前线路连续 3 轮没通（隔 15 秒），或者判成劫持 1 次，准备降级：先不走缓存读一次线路状态文件，
 *   服务端说这条线路正在处理整体故障，就不改配置，从第一次失败起等 5 分钟，还不通才切 CF。
 * - 降级挑「这一轮探测通过、优先级最高」的线路，比当前高的也算（在 CF 上 CF 坏了、洛杉矶已经好了就
 *   直接回洛杉矶）。目标这一轮没探测通过不切；全都不通不改配置，只出提示。
 * - 两次切换至少隔 5 分钟，开机那一次除外。
 * - 回升带退避：7 天内从这条线路因故障降下来的次数决定冷却期（0 / 1 / 6 / 24 小时，墙钟，落盘），
 *   冷却期满每 2 分钟查一次，连续 6 次通才切回。7 天内没失败过的，开机 30 秒内 3 次全通就切回。
 *   退出时不做回升。
 *
 * 状态单独存一份（tool-route-state.json），不碰 relay-route-lines.json：0.2.17 读那份文件要求
 * version 1、4KB 以内，装回老版本时得照样读得出。只存线路 id、原因和时间，不存地址和 IP。
 */
import path from 'node:path'
import { classifyRouteFailure, type LegitimateAddresses, type RouteFailureLabel } from './route-failure-classifier'
import { routeIncidentActive, routeStatusAllowsHongKong, type RouteStatus } from './route-status-file'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import { toolPathFailureCounted, toolPathTlsRejected, type ToolPathFailureKind } from './tool-path-probe'
import type { RelayRouteConclusions } from './relay-route-controller'
import type { RelayEndpointId, RelayRoutePreference } from './relay-sites'

/** 工具线路的全部候选，按优先级。direct-hk 只在这里出现：不进 RelayEndpointId，设置、IPC、落盘都不认它。 */
export const toolRouteLineOrder = ['direct', 'direct-hk', 'primary'] as const
export type ToolRouteLineId = typeof toolRouteLineOrder[number]

/** 当前线路隔这么久查一次。 */
export const toolRouteRecheckIntervalMs = 5 * 60_000
/** 连续这么多轮没通才准备降级。 */
export const toolRouteFailureThreshold = 3
/** 一轮没通以后隔这么久再查下一轮。 */
export const toolRouteFailureProbeGapMs = 15_000
/** 服务端说正在处理整体故障时，从第一次失败起等这么久还不通才切 CF。 */
export const toolRouteIncidentWaitMs = 5 * 60_000
/** 两次切换至少隔这么久（开机那一次除外）。 */
export const toolRouteMinSwitchGapMs = 5 * 60_000
/** 冷却期满以后隔这么久查一次更高的线路。 */
export const toolRouteRecoveryProbeIntervalMs = 2 * 60_000
/** 更高的线路要连续通这么多次才切回去（约 10 分钟）。数次数不看钟，睡眠前后不连成一段。 */
export const toolRouteRecoveryStreak = 6
/** 开机快速回升：这么多次、每次隔这么久，都在开机 30 秒内。 */
export const toolRouteStartupRecoveryProbes = 3
export const toolRouteStartupRecoveryGapMs = 10_000
/** 失败记录和冷却期看的窗口。 */
export const toolRouteFailureWindowMs = 7 * 24 * 60 * 60_000
/** 工具检查报上来的失败，查过一轮以后这么久之内不再为它重查。 */
export const toolRouteReportGapMs = 30_000
/** 劫持提示每台电脑 7 天最多一次；三线全挂按原因 24 小时一次。 */
export const toolRouteHijackNoticeGapMs = 7 * 24 * 60 * 60_000
export const toolRouteOutageNoticeGapMs = 24 * 60 * 60_000

const hourMs = 60 * 60_000
// 7 天内第 1 次失败没有冷却期，第 2 次 1 小时，第 3 次 6 小时，第 4 次及以上 24 小时。
const cooldownSteps: readonly number[] = [0, 0, hourMs, 6 * hourMs, 24 * hourMs]

/** 7 天内因故障从这条线路降下来过 failures 次，冷却期多长。 */
export function toolRouteCooldownMs(failures: number): number {
  return cooldownSteps[Math.min(Math.max(failures, 0), cooldownSteps.length - 1)]
}

/**
 * 为什么换的线路：failed = 连续几轮没通；hijack = 判成劫持；incident = 服务端在处理整体故障，等够了
 * 还不通，切 CF；recovered = 更高的线路一直通，切回去。
 */
export type ToolRouteChangeReason = 'failed' | 'hijack' | 'incident' | 'recovered'

export interface ToolRouteChange {
  from: RelayEndpointId
  to: RelayEndpointId
  reason: ToolRouteChangeReason
  /** 这一轮是怎么起的：startup / scheduled / resume / manual，或者工具检查报上来的错误码。 */
  trigger?: string
  at: number
}

/** 所有候选线路都不通时，按什么原因提示（需求 5.1.5 第 5 条）。 */
export type ToolRouteOutageReason = 'reset' | 'certificate' | 'dns' | 'unreachable'

export interface ToolRouteStoredState {
  line: RelayEndpointId
  /** 每条线路 7 天内因故障降下来的时刻（毫秒），旧的在前。 */
  failures: Partial<Record<RelayEndpointId, number[]>>
  lastChange?: ToolRouteChange
  /** 上一次出劫持提示、各原因三线全挂提示的时刻。 */
  notices: { hijack?: number; outage?: Partial<Record<ToolRouteOutageReason, number>> }
}

export interface ToolRouteSnapshot {
  line: RelayEndpointId
  /** 只有「自动」会探测、会换线。 */
  automatic: boolean
  /** 服务端说当前线路正在处理整体故障，这边先不改配置（首页安静显示一行）。 */
  serverSwitching: boolean
  /** 所有候选线路都不通；恢复以后自动变回 null。 */
  outage: { reason: ToolRouteOutageReason; since: number } | null
  lastChange: ToolRouteChange | null
}

export type ToolRouteNotice =
  | { kind: 'hijack'; line: RelayEndpointId }
  | { kind: 'outage'; reason: ToolRouteOutageReason }

/** 一次工具同路径探测的结果（tool-path-probe.ts 的 ToolPathResult 里控制器要用的几项）。 */
export interface ToolRouteProbeResult {
  ok: boolean
  kind?: ToolPathFailureKind
  addresses: readonly string[]
}

export interface ToolRouteControllerDependencies {
  /** 星芒账号开机时生效的线路偏好；这次运行里不变。 */
  preference: RelayRoutePreference
  /** 上次存下的工具线路状态；没有、读坏了都给 null。 */
  readState(): ToolRouteStoredState | null
  writeState(state: ToolRouteStoredState): Promise<void>
  /** 升级后第一次运行用：应用线路存下的结论（relay-route-lines.json）。 */
  readLegacyConclusions?(): RelayRouteConclusions
  /** 照工具的网络路径探一条线路。不抛错。 */
  probe(line: RelayEndpointId): Promise<ToolRouteProbeResult>
  /** 读线路状态文件；读不到给 null。 */
  readStatus(options: { fresh: boolean }): Promise<RouteStatus | null>
  /** 要出的提示（已经按 7 天 / 24 小时限过频）。 */
  notify?(notice: ToolRouteNotice): void
  schedule?(callback: () => void, delayMs: number): () => void
  now?(): number
  log?(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void
}

export interface ToolRouteController {
  /** 这会儿写进工具配置的线路。 */
  line(): RelayEndpointId
  snapshot(): ToolRouteSnapshot
  /** 开机后在后台查。 */
  start(): void
  /** 唤醒、网络恢复、用户点「重新检测」：马上查一轮当前线路。 */
  recheck(trigger: 'resume' | 'network' | 'manual'): void
  /** 写配置前查模型、工具自检报上来的连接级失败：只叫这里查一轮，不直接计入连败。 */
  reportFailure(trigger: string): void
  /** 线路、服务端切换状态、三线全挂状态变了就叫一声。 */
  subscribe(listener: (snapshot: ToolRouteSnapshot) => void): () => void
  dispose(): void
}

const triggerPattern = /^[A-Za-z0-9_.:-]{1,64}$/
const maxFailureRecords = 16

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

function isEndpoint(value: unknown): value is RelayEndpointId {
  return value === 'direct' || value === 'primary'
}

/** 这条线路这会儿哪些地址算它自己的。L3、被切到 CF 的线路看 CF 地址段；状态文件读不到就不知道。 */
export function toolRouteLegitimateAddresses(line: RelayEndpointId, status: RouteStatus | null): LegitimateAddresses {
  if (line === 'primary') return { cloudflare: true }
  const entry = status?.lines[line]
  if (!entry) return null
  return entry.proxied ? { cloudflare: true } : { cloudflare: false, ips: entry.legitIps }
}

// 香港的域名还没定；定了以后在 relay-sites.ts 加上 origin、让 probe 认得它，再打开这里。
const hongKongOriginAvailable = false

/**
 * L2 能不能新分配（需求 5.1.3）：状态文件读得到、两个开关都开着、不是服务端在处理整体故障、本机的
 * 生图技能脚本认香港地址。第一批没有香港地址也没有支持它的技能脚本，所以永远是 false。
 */
export function toolRouteHongKongAssignable(input: { status: RouteStatus | null; incident: boolean; skillSupportsHongKong: boolean }): boolean {
  return hongKongOriginAvailable && input.status !== null && routeStatusAllowsHongKong(input.status) && !input.incident
    && input.skillSupportsHongKong
}

/**
 * 两条线路是不是解析到了同一个入口（需求 5.1.7）：服务端把洛杉矶指到香港时 L1 和 L2 会一样，
 * 不在两者之间来回切。DNS 失败、SNI 被掐（重置）时不算：换个域名也许就通了。
 */
export function toolRouteSameEntrance(a: ToolRouteProbeResult, b: ToolRouteProbeResult): boolean {
  for (const result of [a, b]) {
    if (!result.addresses.length || result.kind === 'dns' || result.kind === 'reset') return false
  }
  const left = new Set(a.addresses)
  return left.size === new Set(b.addresses).size && b.addresses.every((address) => left.has(address))
}

function outageReason(kind: ToolPathFailureKind | undefined): ToolRouteOutageReason {
  if (kind === 'reset') return 'reset'
  if (kind === 'certificate' || kind === 'tls') return 'certificate'
  if (kind === 'dns') return 'dns'
  return 'unreachable'
}

function recentFailures(records: readonly number[] | undefined, at: number): number[] {
  return (records ?? []).filter((entry) => entry <= at && at - entry < toolRouteFailureWindowMs)
}

function isHongKongPair(a: ToolRouteLineId, b: ToolRouteLineId): boolean {
  return (a === 'direct' && b === 'direct-hk') || (a === 'direct-hk' && b === 'direct')
}

export function createToolRouteController(dependencies: ToolRouteControllerDependencies): ToolRouteController {
  const schedule = dependencies.schedule ?? scheduleTimeout
  const now = dependencies.now ?? Date.now
  const automatic = dependencies.preference === 'auto'
  const listeners = new Set<(snapshot: ToolRouteSnapshot) => void>()
  let disposed = false
  let writing: Promise<void> = Promise.resolve()

  function log(level: 'info' | 'warn', event: string, message: string, detail: Record<string, unknown>): void {
    try { dependencies.log?.(level, event, message, { kind: 'tool', ...detail }) } catch { /* 记日志失败不影响定线路 */ }
  }

  const stored = automatic ? loadInitialState() : null
  let state: ToolRouteStoredState = stored?.state ?? { line: 'direct', failures: {}, notices: {} }
  const line0: RelayEndpointId = automatic ? state.line : dependencies.preference === 'direct' ? 'direct' : 'primary'

  // 每次换线 +1：换线前发出去、换线后才回来的探测结果一律作废。
  let epoch = 0
  let current = line0
  let round: { trigger: string; failures: number; firstFailureAt: number | null } | null = null
  let roundBusy = false
  let reportedAt: number | null = null
  let switchedAt: number | null = null
  let incidentSince: number | null = null
  let outage: ToolRouteSnapshot['outage'] = null
  let recoveryStreak = 0
  let recoveryBusy = false
  let cancelWatch: (() => void) | null = null
  let cancelRecovery: (() => void) | null = null

  // 开机初值：上次存下的工具线路；没有（升级后第一次运行）就取应用线路存下的星芒账号结论，读不到才用
  // 洛杉矶。应用线路 7 天内因为没通退到 CF 的，给洛杉矶记一次失败，免得刚退下来又被拉回去。
  function loadInitialState(): { state: ToolRouteStoredState; firstRun: boolean } {
    let saved: ToolRouteStoredState | null = null
    try { saved = dependencies.readState() } catch { saved = null }
    if (saved) {
      const restored: ToolRouteStoredState = { line: saved.line, failures: { ...saved.failures }, notices: { ...saved.notices } }
      if (saved.lastChange) restored.lastChange = { ...saved.lastChange }
      return { state: restored, firstRun: false }
    }
    let legacy: RelayRouteConclusions | null = null
    try { legacy = dependencies.readLegacyConclusions?.() ?? null } catch { legacy = null }
    const line = legacy?.lines.solov ?? 'direct'
    const failures: ToolRouteStoredState['failures'] = {}
    const change = legacy?.changes.solov
    const at = now()
    if (change && change.reason === 'health-failed' && change.from === 'direct' && change.at <= at && at - change.at < toolRouteFailureWindowMs) {
      failures.direct = [change.at]
    }
    return { state: { line, failures, notices: {} }, firstRun: true }
  }

  function snapshot(): ToolRouteSnapshot {
    return {
      line: current,
      automatic,
      serverSwitching: incidentSince !== null,
      outage: outage ? { ...outage } : null,
      lastChange: automatic && state.lastChange ? { ...state.lastChange } : null,
    }
  }

  function emit(): void {
    const value = snapshot()
    for (const listener of [...listeners]) {
      try { listener(value) } catch { /* 一个订阅方出错不影响别的 */ }
    }
  }

  function persist(): void {
    const failures: ToolRouteStoredState['failures'] = {}
    for (const line of ['direct', 'primary'] as const) {
      const kept = failuresOf(line).slice(-maxFailureRecords)
      if (kept.length) failures[line] = kept
    }
    state = { ...state, line: current, failures }
    const copy: ToolRouteStoredState = JSON.parse(JSON.stringify(state)) as ToolRouteStoredState
    // 一个写完再写下一个。存不下最多下次开机从上次那条重新查，不影响这次。
    writing = writing.then(() => dependencies.writeState(copy)).catch((error: unknown) => {
      log('warn', 'relay.route.persist-failed', '工具线路状态没有存下来，下次开机会再查一次', {
        error: error instanceof Error ? error.name : 'unknown',
      })
    })
  }

  // 7 天内的失败记录。钟被往回拨过（失败时刻落在「现在」后面）就把它挪到现在：冷却期从现在起算一整段，
  // 只截短单次等待不够，下次再算还是差着拨回去的那几个钟头。
  function failuresOf(line: RelayEndpointId): number[] {
    const at = now()
    const records = state.failures[line] ?? []
    if (records.some((entry) => entry > at)) {
      state = { ...state, failures: { ...state.failures, [line]: records.map((entry) => Math.min(entry, at)) } }
    }
    return recentFailures(state.failures[line], at)
  }

  function cooldownRemaining(line: RelayEndpointId): number {
    const recent = failuresOf(line)
    if (!recent.length) return 0
    return Math.max(0, recent[recent.length - 1] + toolRouteCooldownMs(recent.length) - now())
  }

  function switchWait(): number {
    if (switchedAt === null) return 0
    const at = now()
    if (switchedAt > at) switchedAt = at
    return Math.max(0, switchedAt + toolRouteMinSwitchGapMs - at)
  }

  function setWatch(delayMs: number, run: () => void): void {
    cancelWatch?.()
    const token = epoch
    cancelWatch = schedule(() => {
      cancelWatch = null
      if (!disposed && token === epoch) run()
    }, delayMs)
  }

  function setRecovery(delayMs: number, run: () => void): void {
    cancelRecovery?.()
    const token = epoch
    cancelRecovery = schedule(() => {
      cancelRecovery = null
      if (!disposed && token === epoch) run()
    }, delayMs)
  }

  async function probe(line: RelayEndpointId): Promise<ToolRouteProbeResult> {
    try {
      const result = await dependencies.probe(line)
      return { ok: result.ok === true, ...(result.kind ? { kind: result.kind } : {}), addresses: [...(result.addresses ?? [])] }
    } catch {
      return { ok: false, kind: 'reset', addresses: [] }
    }
  }

  async function readStatus(fresh: boolean): Promise<RouteStatus | null> {
    try { return await dependencies.readStatus({ fresh }) } catch { return null }
  }

  function notice(value: ToolRouteNotice): void {
    const at = now()
    const notices = { ...state.notices, outage: { ...state.notices.outage } }
    const last = value.kind === 'hijack' ? notices.hijack : notices.outage[value.reason]
    const gap = value.kind === 'hijack' ? toolRouteHijackNoticeGapMs : toolRouteOutageNoticeGapMs
    if (last !== undefined && last <= at && at - last < gap) return
    if (value.kind === 'hijack') notices.hijack = at
    else notices.outage[value.reason] = at
    state = { ...state, notices }
    persist()
    try { dependencies.notify?.(value) } catch { /* 出提示失败不影响定线路 */ }
  }

  function clearTransient(): boolean {
    const changed = incidentSince !== null || outage !== null
    incidentSince = null
    outage = null
    return changed
  }

  // 定时查当前线路；不在最高的线路上时另外按冷却期查更高的那条。
  function watch(): void {
    setWatch(toolRouteRecheckIntervalMs, () => beginRound('scheduled'))
  }

  function higherLine(): RelayEndpointId | null {
    // 第一批只有洛杉矶和 CF：在 CF 上，更高的就是洛杉矶。L2 选不上，跳过。
    return current === 'primary' ? 'direct' : null
  }

  function scheduleRecovery(minimumDelayMs: number): void {
    cancelRecovery?.()
    cancelRecovery = null
    recoveryStreak = 0
    const target = higherLine()
    if (!target) return
    const delay = Math.max(minimumDelayMs, cooldownRemaining(target))
    setRecovery(delay, () => { void checkRecovery() })
  }

  function switchTo(target: RelayEndpointId, reason: ToolRouteChangeReason, trigger: string): void {
    const from = current
    const at = now()
    if (reason !== 'recovered') {
      const records = [...(state.failures[from] ?? []), at]
      state = { ...state, failures: { ...state.failures, [from]: records } }
    }
    epoch += 1
    cancelWatch?.()
    cancelRecovery?.()
    cancelWatch = null
    cancelRecovery = null
    round = null
    roundBusy = false
    recoveryBusy = false
    recoveryStreak = 0
    clearTransient()
    current = target
    switchedAt = at
    const change: ToolRouteChange = { from, to: target, reason, ...(triggerPattern.test(trigger) ? { trigger } : {}), at }
    state = { ...state, line: target, lastChange: change }
    log('info', 'relay.route.changed', target === 'direct' ? '工具线路改走洛杉矶' : '工具线路改走 CF', {
      from, to: target, reason, trigger: change.trigger,
      ...(reason === 'recovered' ? {} : { failures7d: failuresOf(from).length }),
    })
    persist()
    emit()
    if (reason === 'hijack') notice({ kind: 'hijack', line: from })
    watch()
    scheduleRecovery(toolRouteRecoveryProbeIntervalMs)
  }

  function beginRound(trigger: string): void {
    if (disposed || !automatic || round || roundBusy) return
    round = { trigger, failures: 0, firstFailureAt: null }
    void checkCurrent()
  }

  // 失败打标签：通不通只看端到端，这里只回答「为什么没通、是不是劫持」。认不出的地址先不走缓存重读
  // 一次状态文件再下结论（需求 5.1.2）。
  async function classify(line: RelayEndpointId, result: ToolRouteProbeResult): Promise<RouteFailureLabel> {
    const tlsRejected = toolPathTlsRejected(result)
    let status = await readStatus(false)
    let label = classifyRouteFailure({ addresses: result.addresses, legitimate: toolRouteLegitimateAddresses(line, status), tlsRejected })
    if (label === 'unknown' && result.addresses.length) {
      status = await readStatus(true)
      label = classifyRouteFailure({ addresses: result.addresses, legitimate: toolRouteLegitimateAddresses(line, status), tlsRejected })
    }
    return label
  }

  async function checkCurrent(): Promise<void> {
    const active = round
    if (!active || roundBusy) return
    const token = epoch
    const line = current
    roundBusy = true
    const result = await probe(line)
    if (disposed || token !== epoch || round !== active) return
    if (result.ok || !toolPathFailureCounted(result)) {
      // 通了，或者慢但有进展（不算失败）：这一轮结束。
      roundBusy = false
      round = null
      if (result.ok && clearTransient()) emit()
      watch()
      return
    }
    active.failures += 1
    active.firstFailureAt ??= now()
    const label = await classify(line, result)
    roundBusy = false
    if (disposed || token !== epoch || round !== active) return
    log('info', 'relay.route.check-failed', '工具线路这次探测没通', {
      line, failures: active.failures, trigger: active.trigger, failure: result.kind, label,
    })
    if (label === 'hijack') {
      void prepareDowngrade(active, 'hijack', result)
      return
    }
    if (active.failures < toolRouteFailureThreshold) {
      setWatch(toolRouteFailureProbeGapMs, () => { void checkCurrent() })
      return
    }
    void prepareDowngrade(active, 'failed', result)
  }

  // 准备降级：先不走缓存读状态文件。服务端说这条线路正在处理整体故障就先等；否则挑这一轮通过的、
  // 优先级最高的线路。
  async function prepareDowngrade(active: NonNullable<typeof round>, reason: 'failed' | 'hijack', failure: ToolRouteProbeResult): Promise<void> {
    const token = epoch
    roundBusy = true
    const line = current
    const status = await readStatus(true)
    if (disposed || token !== epoch || round !== active) return
    const incident = line === 'direct' && routeIncidentActive(status, line)
    log('info', 'relay.route.downgrade-check', '工具线路准备降级，先看服务端的线路状态', {
      line, reason, incident: status ? status.incident.state : 'unavailable', trigger: active.trigger,
    })
    if (incident) {
      const since = active.firstFailureAt ?? now()
      if (incidentSince === null) {
        incidentSince = since
        emit()
      }
      const wait = since + toolRouteIncidentWaitMs - now()
      if (wait > 0) {
        roundBusy = false
        setWatch(wait, () => { void finishIncidentWait(active) })
        return
      }
      roundBusy = false
      void finishIncidentWait(active)
      return
    }
    await chooseTarget(active, reason, failure, token)
  }

  // 服务端处理整体故障时等够 5 分钟：当前线路好了就接着用；还不通只切 CF，不切香港。
  async function finishIncidentWait(active: NonNullable<typeof round>): Promise<void> {
    if (round !== active || roundBusy) return
    const token = epoch
    roundBusy = true
    const again = await probe(current)
    if (disposed || token !== epoch || round !== active) return
    if (again.ok) {
      roundBusy = false
      round = null
      clearTransient()
      emit()
      watch()
      return
    }
    const fallback = await probe('primary')
    if (disposed || token !== epoch || round !== active) return
    if (!fallback.ok) {
      roundBusy = false
      enterOutage(active, again)
      return
    }
    applySwitch(active, 'primary', 'incident')
  }

  async function chooseTarget(active: NonNullable<typeof round>, reason: 'failed' | 'hijack', failure: ToolRouteProbeResult, token: number): Promise<void> {
    const failed = current
    for (const candidate of toolRouteLineOrder) {
      if (candidate === failed) continue
      // L2 四个条件都满足才选（toolRouteHongKongAssignable）。第一批它恒为 false，也没有地址可探。
      if (candidate === 'direct-hk') continue
      const result = await probe(candidate)
      if (disposed || token !== epoch || round !== active) return
      if (!result.ok) continue
      if (isHongKongPair(failed, candidate) && toolRouteSameEntrance(failure, result)) continue
      applySwitch(active, candidate, reason)
      return
    }
    roundBusy = false
    enterOutage(active, failure)
  }

  function applySwitch(active: NonNullable<typeof round>, target: RelayEndpointId, reason: ToolRouteChangeReason): void {
    const wait = switchWait()
    if (wait > 0) {
      roundBusy = false
      round = null
      log('info', 'relay.route.held', '工具线路没通，离上次切换还不够久，到点再查一轮', { line: current, waitMs: wait })
      setWatch(wait, () => beginRound(active.trigger))
      return
    }
    switchTo(target, reason, active.trigger)
  }

  function enterOutage(active: NonNullable<typeof round>, failure: ToolRouteProbeResult): void {
    round = null
    // 服务端切换等够了、CF 也不通：改按三线全挂提示。
    incidentSince = null
    const reason = outageReason(failure.kind)
    log('warn', 'relay.route.unreachable', '工具线路的候选这会儿都不通，配置先不改', { line: current, reason, trigger: active.trigger })
    if (!outage || outage.reason !== reason) {
      outage = { reason, since: outage?.since ?? now() }
      emit()
    }
    notice({ kind: 'outage', reason })
    watch()
  }

  // 冷却期满以后查更高的线路：连续 6 次通才切回去，中间一次没通就从头数。
  async function checkRecovery(): Promise<void> {
    const target = higherLine()
    if (!target || recoveryBusy || disposed) return
    const token = epoch
    recoveryBusy = true
    const result = await probe(target)
    recoveryBusy = false
    if (disposed || token !== epoch) return
    recoveryStreak = result.ok ? recoveryStreak + 1 : 0
    if (recoveryStreak >= toolRouteRecoveryStreak) {
      const wait = switchWait()
      if (wait > 0) {
        setRecovery(wait, () => { void checkRecovery() })
        return
      }
      switchTo(target, 'recovered', 'scheduled')
      return
    }
    setRecovery(toolRouteRecoveryProbeIntervalMs, () => { void checkRecovery() })
  }

  // 开机快速回升：更高的线路 7 天内没失败过，开机 30 秒内 3 次全通就切回；有一次没通就照平常的节奏。
  async function startupRecoveryProbe(attempt: number): Promise<void> {
    const target = higherLine()
    if (!target || recoveryBusy || disposed) return
    const token = epoch
    recoveryBusy = true
    const result = await probe(target)
    recoveryBusy = false
    if (disposed || token !== epoch) return
    if (!result.ok) {
      scheduleRecovery(toolRouteRecoveryProbeIntervalMs)
      return
    }
    if (attempt + 1 >= toolRouteStartupRecoveryProbes) {
      switchTo(target, 'recovered', 'startup')
      return
    }
    setRecovery(toolRouteStartupRecoveryGapMs, () => { void startupRecoveryProbe(attempt + 1) })
  }

  if (stored?.firstRun) {
    log('info', 'relay.route.tool-initialized', '第一次定工具线路，沿用应用线路上次的结论', {
      line: state.line, failures7d: failuresOf('direct').length,
    })
    persist()
  }

  return {
    line() {
      return current
    },
    snapshot,
    start() {
      if (!automatic || disposed) return
      beginRound('startup')
      const target = higherLine()
      if (!target) return
      // 有失败记录的按冷却期走，冷却期已经满了就开机这一次算头一次。
      if (failuresOf(target).length) scheduleRecovery(0)
      else void startupRecoveryProbe(0)
    },
    recheck(trigger) {
      if (!automatic || disposed) return
      // 睡眠前后的结果不连成一段。
      if (trigger === 'resume') recoveryStreak = 0
      beginRound(trigger)
    },
    reportFailure(trigger) {
      if (!automatic || disposed || round || roundBusy) return
      const at = now()
      if (reportedAt !== null && at >= reportedAt && at - reportedAt < toolRouteReportGapMs) return
      reportedAt = at
      beginRound(triggerPattern.test(trigger) ? trigger : 'request')
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      // 退出时偏稳：只停计时器，不做回升。
      disposed = true
      listeners.clear()
      cancelWatch?.()
      cancelRecovery?.()
      cancelWatch = null
      cancelRecovery = null
    },
  }
}

const stateLabel = '工具线路状态'
const maxStateBytes = 8 * 1024
const changeReasons: readonly ToolRouteChangeReason[] = ['failed', 'hijack', 'incident', 'recovered']
const outageReasons: readonly ToolRouteOutageReason[] = ['reset', 'certificate', 'dns', 'unreachable']

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseChange(value: unknown): ToolRouteChange | undefined {
  if (!isRecord(value)) return undefined
  const { from, to, reason, trigger, at } = value
  const parsedReason = changeReasons.find((entry) => entry === reason)
  if (!isEndpoint(from) || !isEndpoint(to) || !parsedReason || !isTimestamp(at)) return undefined
  return { from, to, reason: parsedReason, ...(typeof trigger === 'string' && triggerPattern.test(trigger) ? { trigger } : {}), at }
}

/** 解析存下来的工具线路状态；认不出的字段、线路、原因一律丢掉，整体不像样就给 null。 */
export function parseToolRouteState(text: string): ToolRouteStoredState | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!isRecord(value) || value.version !== 1 || !isEndpoint(value.line)) return null
  const failures: ToolRouteStoredState['failures'] = {}
  if (isRecord(value.failures)) {
    for (const line of ['direct', 'primary'] as const) {
      const records = value.failures[line]
      if (!Array.isArray(records)) continue
      const kept = records.filter(isTimestamp).sort((a, b) => a - b).slice(-maxFailureRecords)
      if (kept.length) failures[line] = kept
    }
  }
  const notices: ToolRouteStoredState['notices'] = {}
  if (isRecord(value.notices)) {
    if (isTimestamp(value.notices.hijack)) notices.hijack = value.notices.hijack
    if (isRecord(value.notices.outage)) {
      const outage: Partial<Record<ToolRouteOutageReason, number>> = {}
      for (const reason of outageReasons) {
        const at = value.notices.outage[reason]
        if (isTimestamp(at)) outage[reason] = at
      }
      if (Object.keys(outage).length) notices.outage = outage
    }
  }
  const lastChange = parseChange(value.lastChange)
  return { line: value.line, failures, ...(lastChange ? { lastChange } : {}), notices }
}

/** 存工具线路状态（tool-route-state.json）。读坏了一律当没有：最多开机从上次应用线路的结论重新开始。 */
export function createToolRouteStateStore(filePath: string): Pick<ToolRouteControllerDependencies, 'readState' | 'writeState'> {
  if (!path.isAbsolute(filePath)) throw new Error('工具线路状态必须使用绝对路径。')
  return {
    readState() {
      try {
        const content = readSafeUtf8FileSync(filePath, stateLabel, maxStateBytes)
        return content === null ? null : parseToolRouteState(content)
      } catch {
        return null
      }
    },
    async writeState(value) {
      const parsed = parseToolRouteState(JSON.stringify({ version: 1, ...value }))
      if (!parsed) throw new Error('工具线路状态不完整，没有写入。')
      ensureSafeDataDirectory(path.dirname(filePath), stateLabel)
      await writeAtomicSafeUtf8File(filePath, `${JSON.stringify({ version: 1, ...parsed })}\n`, stateLabel)
    },
  }
}

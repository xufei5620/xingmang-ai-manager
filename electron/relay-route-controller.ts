/**
 * 「自动」线路怎么定（直连适配第二步，yoyo 10-6 回「改」；#941 第 3 节改成只看健康检查、加防抖）。
 *
 * 星芒账号和历史账号各有两条线路：默认线路（xm.solov.cc / api.solov.cc）和直连
 * （xm-direct.solov.cc / api-direct.solov.cc）。选「自动」的站先走直连，直连连不上改走
 * 默认线路；写死一条线路的站不探测、不退回。
 *
 * 改不改线路只看健康检查（probeRelayLineHealth）。请求慢、超时不算直连坏了：10-7 线上有客户
 * 直连下行只有几十 KB/s，公告下到一半超时就被当成直连坏了，在两条线路之间来回切。
 *
 * - 开机不等检查结果：先用上次存下的结论。没有结论时星芒账号先走直连（yoyo 10-8「xm 站点这边全部
 *   走直连」），开机那一轮两条一起查，直连没通就马上改走默认线路，不等下面那三次（#963：新用户开机
 *   就注册，没查过的线路连不上就注册失败）；查出的结论存下来，下次开机就照下面的规矩。星芒账号写进
 *   工具配置的线路另由 tool-route-controller.ts 定，不看这里。历史账号先走默认线路（这时不算定下来，
 *   工具配置不跟着迁），后台再查。
 * - 走直连时隔一阵查一次。星芒自己的请求在直连上连不上（relay-line-fetch.ts 说了哪些算）就马上
 *   查，不等下一次；报上来的只叫这里去查，改不改照样看查的结果。
 * - 直连连续 3 次没查通、默认线路查通了才改走默认线路；两条都不通（比如开机时还没联网）就不改，
 *   免得工具配置来回换，过一阵再查。
 * - 退回以后隔两分钟查一次直连，连续 10 分钟都查得通才切回来。
 * - 两次切换至少隔 5 分钟：每切一次工具配置都要跟着改，开着的工具要重开。
 *
 * 结论和每个站最近一次切换落盘（relay-route-lines.json），下次开机先用结论，诊断页说得出最近一次
 * 为什么换。只存线路 id 和原因，不存地址：地址只从 relay-sites.ts 里来。
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

/** 走直连时、两条都没连上以后，隔这么久再查一次。 */
export const relayRouteRecheckIntervalMs = 5 * 60_000

/** 直连连续这么多次健康检查没通过，才改走默认线路。 */
export const relayRouteFailureThreshold = 3

/** 一轮里一次没查通，隔这么久再查下一次：网络抖一下、别的下载把窄带宽占满一阵，都不至于连着三次没通过。 */
export const relayRouteFailureProbeGapMs = 15_000

/** 退回默认线路以后，隔这么久查一次直连。 */
export const relayRouteRecoveryProbeIntervalMs = 2 * 60_000

/** 退回默认线路以后，直连要连续查得通这么久才切回去。 */
export const relayRouteRecoveryMs = 10 * 60_000

/** 两次切换至少隔这么久。 */
export const relayRouteMinSwitchGapMs = 5 * 60_000

/** 请求报上来的直连失败，查过一轮以后这么久之内不再为它重查：一批请求一起失败只查一轮。 */
export const relayRouteFailureRecheckGapMs = 30_000

// 切回直连要连着查通这么多次（头一次到最后一次正好隔 relayRouteRecoveryMs）。数次数不看钟：计时器
// 只会晚到不会早到，连着这么多次就一定跨过了那么久；电脑睡一觉醒来钟跳过去几个小时，睡前那一次
// 不该跟醒来这一次连成「一直查得通」。
const recoveryStreak = relayRouteRecoveryMs / relayRouteRecoveryProbeIntervalMs + 1

// 「自动」的站这台电脑上还没有结论时，开机先走哪条。星芒账号直接定在直连：开机那一轮两条一起查
// （checkFirstLaunch），直连没通就马上退回默认线路，好了再按下面的规矩切回来。历史账号（sub2api）
// 这次不动，照旧先走默认线路、查出结论再迁。
const unconcludedStart: Readonly<Record<RelayRouteSiteId, RelayRouteLine>> = {
  solov: { line: 'direct', settled: true },
  'solov-api': { line: 'primary', settled: false },
}

// 全新安装开机那一轮（checkFirstLaunch）从开查算起，默认线路已经查通的话，直连最多等这么久。直连被
// 丢包时它的健康检查要等满 probeTimeoutMs 才算没通，新用户这会儿正在填注册（#963）。
export const relayRouteFirstLaunchPreferDirectMs = 1_500

// 健康检查那个接口只回几 KB，平时一秒内就回；给足时间，直连下行只有几十 KB/s 时也查得完。
const probeTimeoutMs = 10_000
const maxProbeBytes = 256 * 1024

/**
 * 为什么改的线路：startup = 这次开机第一次定下来，直连查通了；health-failed = 直连连续几次健康检查
 * 没通过、默认线路查通了，改走默认线路；recovered = 退回以后直连一直查得通，切回直连。
 */
export type RelayRouteChangeReason = 'startup' | 'health-failed' | 'recovered'

/** 一个站最近一次改线路。只记线路 id 和原因，不记地址。 */
export interface RelayRouteChange {
  from: RelayEndpointId
  to: RelayEndpointId
  reason: RelayRouteChangeReason
  /**
   * 改走默认线路那一轮检查是怎么起的：startup = 开机，scheduled = 定时查，别的是星芒自己的请求在
   * 直连上碰到的失败（错误码，比如 ERR_CONNECTION_RESET）。切到直连时没有。
   */
  trigger?: string
  /** 毫秒时间戳。 */
  at: number
}

/** 存下来的结论：每个站上次定下来的线路，和最近一次改线路。 */
export interface RelayRouteConclusions {
  lines: Partial<Record<RelayRouteSiteId, RelayEndpointId>>
  changes: Partial<Record<RelayRouteSiteId, RelayRouteChange>>
}

export interface RelayRouteState extends RelayRouteLine {
  preference: RelayRoutePreference
}

export interface RelayRouteControllerDependencies {
  /** 开机时生效的偏好；这次运行里不变。 */
  preferences: Readonly<Record<RelayRouteSiteId, RelayRoutePreference>>
  /** 上次存下的结论；读不到、读坏了都当没有。 */
  readConclusions(): RelayRouteConclusions
  writeConclusions(conclusions: RelayRouteConclusions): Promise<void>
  /** 查一个站的一条线路：通了返回 true；网络层失败、回的不对、超时都返回 false，不抛错。 */
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
  /** 「自动」的站最近一次改线路（这台电脑上从没改过就是 null）；写死线路的站没有。 */
  lastChange(siteId: RelayRouteSiteId): RelayRouteChange | null
  /** 开机后在后台查「自动」的站。 */
  start(): void
  /**
   * 星芒自己的一次请求在直连上没走通：马上查一轮直连，不等下一次定时的。只是叫这里去查，改不改
   * 线路照样只看健康检查。
   */
  reportDirectFailure(siteId: RelayRouteSiteId, reason: string): void
  /** 线路改了就叫一声，返回取消订阅。 */
  subscribe(listener: (siteId: RelayRouteSiteId, line: RelayRouteLine) => void): () => void
  dispose(): void
}

interface SiteState {
  line: RelayEndpointId
  settled: boolean
  /** 正在查的这一轮：怎么起的、已经连着没查通几次。不在查就是 null。 */
  round: { trigger: string; failures: number } | null
  /** 退回默认线路以后，直连已经连着查通了几次。 */
  recovered: number
  /** 有一次检查还没回来。 */
  checking: boolean
  /** 这次运行里上一次改线路的时间。 */
  switchedAt: number | null
  /** 上一次为请求报上来的失败去查是什么时候。 */
  failureCheckedAt: number | null
  /**
   * 星芒账号在这台电脑上还没有存下过结论（全新安装），线路是开机先定的、没查过：开机那一轮走
   * checkFirstLaunch，也不把这条没查过的线路存成结论。定下来一次就是 false。
   */
  firstLaunch: boolean
  cancelTimer: (() => void) | null
}

const triggerPattern = /^[A-Za-z0-9_.:-]{1,64}$/

/** 全新安装开机那一轮直连没通、改走默认线路时记的 trigger：检查报告据此不说「连着 3 次」。 */
export const firstLaunchTrigger = 'first-launch'

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
  let conclusions: RelayRouteConclusions = { lines: {}, changes: {} }
  try {
    const stored = dependencies.readConclusions()
    conclusions = { lines: { ...stored.lines }, changes: { ...stored.changes } }
  } catch {
    conclusions = { lines: {}, changes: {} }
  }
  let writing: Promise<void> = Promise.resolve()
  const states = new Map<RelayRouteSiteId, SiteState>()
  for (const siteId of relayRouteSiteIds) {
    if (dependencies.preferences[siteId] !== 'auto') continue
    const concluded = conclusions.lines[siteId]
    const start = concluded === undefined ? unconcludedStart[siteId] : { line: concluded, settled: true }
    states.set(siteId, {
      line: start.line,
      settled: start.settled,
      round: null,
      recovered: 0,
      checking: false,
      switchedAt: null,
      failureCheckedAt: null,
      firstLaunch: siteId === 'solov' && concluded === undefined,
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
    const lines = { ...conclusions.lines }
    for (const [siteId, state] of states) {
      if (state.settled && !state.firstLaunch) lines[siteId] = state.line
    }
    conclusions = { lines, changes: conclusions.changes }
    const snapshot: RelayRouteConclusions = { lines: { ...lines }, changes: { ...conclusions.changes } }
    // 一个写完再写下一个：两个站差不多同时改了线路时，后写的那份（内容更全）不会被先写的盖掉。
    // 存不下最多下次开机先走上次那条、再查一次，不影响这次。
    writing = writing.then(() => dependencies.writeConclusions(snapshot)).catch((error: unknown) => {
      log('warn', 'relay.route.persist-failed', '线路结论没有存下来，下次开机会再查一次', {
        error: error instanceof Error ? error.name : 'unknown',
      })
    })
  }

  function setTimer(state: SiteState, delayMs: number, run: () => void): void {
    state.cancelTimer?.()
    state.cancelTimer = schedule(() => {
      state.cancelTimer = null
      if (!disposed) run()
    }, delayMs)
  }

  // 同一个站同一时刻只有一次检查在查。查完时已经 dispose 了就给 null，调用方什么都不做。
  async function check(state: SiteState, siteId: RelayRouteSiteId, line: RelayEndpointId): Promise<boolean | null> {
    state.checking = true
    let reachable = false
    try {
      reachable = await dependencies.probe(siteId, line)
    } catch {
      reachable = false
    } finally {
      state.checking = false
    }
    return disposed ? null : reachable
  }

  // 离上次切换还要等多久才能再切。钟被往回拨过（上次切换的时刻落到了「现在」后面）就从现在起算一整段：
  // 只截短单次等待不够，下一轮再算还是差着拨回去的那几个钟头，直连坏着也要一轮轮等到钟追上来。
  function switchWait(state: SiteState): number {
    if (state.switchedAt === null) return 0
    const at = now()
    if (state.switchedAt > at) state.switchedAt = at
    return Math.max(0, state.switchedAt + relayRouteMinSwitchGapMs - at)
  }

  // 定下来以后接着看：走直连隔一阵查一次；走默认线路隔两分钟查一次直连，看能不能切回去。
  function watch(siteId: RelayRouteSiteId, state: SiteState): void {
    if (state.line === 'direct') setTimer(state, relayRouteRecheckIntervalMs, () => beginRound(siteId, state, 'scheduled'))
    else setTimer(state, relayRouteRecoveryProbeIntervalMs, () => { void checkRecovery(siteId, state) })
  }

  function settle(siteId: RelayRouteSiteId, state: SiteState, line: RelayEndpointId, reason: RelayRouteChangeReason, trigger?: string): void {
    const from = state.line
    const changed = from !== line || !state.settled
    const firstConclusion = state.firstLaunch
    state.line = line
    state.settled = true
    state.round = null
    state.recovered = 0
    // 定下过一次就不再是全新安装，后面照常走三次阈值那一套。
    state.firstLaunch = false
    watch(siteId, state)
    if (!changed) {
      // 开机先定的直连查通了：线路没变，但这是这台电脑第一次查过的结论，要存下来。不存的话下次开机
      // 又当全新安装，直连哪次开机慢一下就会被打回默认线路至少 10 分钟（10-7 来回切的老问题）。
      if (firstConclusion) persist()
      return
    }
    const at = now()
    state.switchedAt = at
    const changes = { ...conclusions.changes }
    changes[siteId] = { from, to: line, reason, ...(trigger === undefined ? {} : { trigger }), at }
    conclusions = { lines: conclusions.lines, changes }
    log('info', 'relay.route.changed', line === 'direct' ? '「自动」线路改走直连' : '「自动」线路改走默认线路', {
      siteId, from, to: line, reason, ...(trigger === undefined ? {} : { trigger }),
    })
    persist()
    const current = { line: state.line, settled: state.settled }
    for (const listener of [...listeners]) {
      try { listener(siteId, current) } catch { /* 一个订阅方出错不影响别的 */ }
    }
  }

  function beginRound(siteId: RelayRouteSiteId, state: SiteState, trigger: string): void {
    if (disposed || state.round || state.checking) return
    state.round = { trigger, failures: 0 }
    if (state.firstLaunch) void checkFirstLaunch(siteId, state)
    else void checkDirect(siteId, state)
  }

  // 一轮里查一次直连。通了：没定下来的定在直连，走着直连的接着走。没通：连着够 3 次再查默认线路，
  // 它通了（也隔够了上次切换）才改走默认线路。
  async function checkDirect(siteId: RelayRouteSiteId, state: SiteState): Promise<void> {
    const round = state.round
    if (!round) return
    const reachable = await check(state, siteId, 'direct')
    if (reachable === null || state.round !== round) return
    if (reachable) {
      if (!state.settled) {
        settle(siteId, state, 'direct', 'startup')
        return
      }
      state.round = null
      watch(siteId, state)
      return
    }
    round.failures += 1
    log('info', 'relay.route.check-failed', '直连这次健康检查没通过', {
      siteId, line: 'direct', failures: round.failures, trigger: round.trigger,
    })
    if (round.failures < relayRouteFailureThreshold) {
      setTimer(state, relayRouteFailureProbeGapMs, () => { void checkDirect(siteId, state) })
      return
    }
    const primaryReachable = await check(state, siteId, 'primary')
    if (primaryReachable === null || state.round !== round) return
    state.round = null
    if (!primaryReachable) {
      log('warn', 'relay.route.unreachable', '直连和默认线路这会儿都没连上，线路先不改', {
        siteId, line: state.line, settled: state.settled, trigger: round.trigger,
      })
      setTimer(state, relayRouteRecheckIntervalMs, () => beginRound(siteId, state, 'scheduled'))
      return
    }
    const wait = switchWait(state)
    if (wait > 0) {
      log('info', 'relay.route.held', '直连没查通，离上次切换还不够久，到点再查一轮', { siteId, line: state.line, waitMs: wait })
      setTimer(state, wait, () => beginRound(siteId, state, round.trigger))
      return
    }
    settle(siteId, state, 'primary', 'health-failed', round.trigger)
  }

  // 全新安装（星芒账号在这台电脑上还没有存下过结论）开机那一轮：两条一起查，直连查通就定直连；直连
  // 没通、或者默认线路已经查通而直连等了 relayRouteFirstLaunchPreferDirectMs 还没回，就定默认线路。
  //
  // 三次阈值和 15 秒间隔防的是「在两条都能用的线路之间来回横跳」（10-7 线上出过，见文件头）。
  // 这台电脑还没定过任何线路，没有可横跳的对象，那套等待在这里只剩代价——而新用户的注册恰恰
  // 就发生在开机后的这几十秒里：请求发往一条从没验证过的线路，连不上就注册失败，原来还要等满
  // 一分钟才退回（#963）。两条都通时定直连，不看谁先回：谁先回每次开机可能不一样。
  //
  // 两个检查一起查，不经 check()：它那个 checking 标记一次只记一个，两个一起查会互相清掉。直连晚回来的
  // 结果不要了，不在开机几秒里再切一次，交给退回以后的切回规矩。健康检查只读，两条一起查没有副作用。
  async function checkFirstLaunch(siteId: RelayRouteSiteId, state: SiteState): Promise<void> {
    const round = state.round
    if (!round) return
    function probeLine(line: RelayEndpointId): Promise<boolean> {
      try {
        return dependencies.probe(siteId, line).then((reachable) => reachable === true, () => false)
      } catch {
        return Promise.resolve(false)
      }
    }
    state.checking = true
    let line: RelayEndpointId | null
    try {
      const direct = probeLine('direct')
      const primary = probeLine('primary')
      let cancelWait: () => void = () => undefined
      const waited = new Promise<'waited'>((resolve) => {
        cancelWait = schedule(() => resolve('waited'), relayRouteFirstLaunchPreferDirectMs)
      })
      // 先等直连；默认线路查通了还没等到直连，就只再等到 relayRouteFirstLaunchPreferDirectMs。
      const primaryReady = primary.then(async (reachable) => reachable ? waited : new Promise<never>(() => undefined))
      const first = await Promise.race([direct, primaryReady])
      cancelWait()
      if (first === true) line = 'direct'
      else if (first === 'waited') line = 'primary'
      else line = await primary ? 'primary' : null
    } finally {
      state.checking = false
    }
    if (disposed || state.round !== round) return
    if (line === 'direct') {
      settle(siteId, state, 'direct', 'startup')
      return
    }
    state.round = null
    if (line === 'primary') {
      log('info', 'relay.route.first-launch', '这台电脑第一次定线路：直连没连上，不等三次直接定在默认线路', {
        siteId, line: 'primary', trigger: round.trigger,
      })
      settle(siteId, state, 'primary', 'health-failed', firstLaunchTrigger)
      return
    }
    // 两条都没连上（开机时还没联网那种）：和原来一样不改，过一阵再查；还是全新安装，下一轮照样两条一起查。
    log('warn', 'relay.route.unreachable', '直连和默认线路这会儿都没连上，线路先不改', {
      siteId, line: state.line, settled: state.settled, trigger: round.trigger,
    })
    setTimer(state, relayRouteRecheckIntervalMs, () => beginRound(siteId, state, 'scheduled'))
  }

  // 退回默认线路以后查一次直连：连着查通 recoveryStreak 次才切回去，中间一次没通就从头数。
  async function checkRecovery(siteId: RelayRouteSiteId, state: SiteState): Promise<void> {
    if (state.line !== 'primary' || !state.settled || state.checking) return
    const reachable = await check(state, siteId, 'direct')
    if (reachable === null || state.line !== 'primary') return
    state.recovered = reachable ? state.recovered + 1 : 0
    if (state.recovered >= recoveryStreak) {
      settle(siteId, state, 'direct', 'recovered')
      return
    }
    watch(siteId, state)
  }

  return {
    lines() {
      return { solov: routeLine('solov'), 'solov-api': routeLine('solov-api') }
    },
    route(siteId) {
      return { line: routeLine(siteId).line, automatic: dependencies.preferences[siteId] === 'auto' }
    },
    lastChange(siteId) {
      const change = states.has(siteId) ? conclusions.changes[siteId] : undefined
      return change ? { ...change } : null
    },
    start() {
      for (const [siteId, state] of states) {
        // 上次退回了默认线路：照切回的规矩来，开机这一次算头一次。
        if (state.settled && state.line === 'primary') void checkRecovery(siteId, state)
        else beginRound(siteId, state, 'startup')
      }
    },
    reportDirectFailure(siteId, reason) {
      const state = states.get(siteId)
      if (disposed || !state || state.line !== 'direct' || state.round || state.checking) return
      const at = now()
      if (state.failureCheckedAt !== null && at - state.failureCheckedAt >= 0
        && at - state.failureCheckedAt < relayRouteFailureRecheckGapMs) return
      state.failureCheckedAt = at
      log('info', 'relay.route.direct-failed', '直连上的请求没走通，马上查一轮直连', { siteId, line: 'direct', reason })
      beginRound(siteId, state, triggerPattern.test(reason) ? reason : 'request')
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

function isRelayRouteChangeReason(value: unknown): value is RelayRouteChangeReason {
  return value === 'startup' || value === 'health-failed' || value === 'recovered'
}

function parseRelayRouteChange(value: unknown): RelayRouteChange | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const from = parseConclusionLine(record.from)
  const to = parseConclusionLine(record.to)
  const { reason, trigger, at } = record
  if (!from || !to || !isRelayRouteChangeReason(reason) || typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return undefined
  return { from, to, reason, ...(typeof trigger === 'string' && triggerPattern.test(trigger) ? { trigger } : {}), at }
}

// 只认两个站的键，值逐个过 parse：认不出的站、认不出的值都丢掉，不让文件里别的东西跟着读进来。
function parseSiteRecord<T>(value: unknown, parse: (entry: unknown) => T | undefined): Partial<Record<RelayRouteSiteId, T>> {
  const parsed: Partial<Record<RelayRouteSiteId, T>> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return parsed
  const record = value as Record<string, unknown>
  for (const siteId of relayRouteSiteIds) {
    const entry = parse(record[siteId])
    if (entry !== undefined) parsed[siteId] = entry
  }
  return parsed
}

/**
 * 存「自动」上次的结论和最近一次切换。读坏了一律当没有：最多开机先走默认线路、再查一次。
 * 版本号不变：0.2.17 只读 lines、不认识 changes，装回老版本照样读得出结论。
 */
export function createRelayRouteConclusionStore(filePath: string): Pick<RelayRouteControllerDependencies, 'readConclusions' | 'writeConclusions'> {
  if (!path.isAbsolute(filePath)) throw new Error('连接线路结论必须使用绝对路径。')
  return {
    readConclusions() {
      const none: RelayRouteConclusions = { lines: {}, changes: {} }
      try {
        const content = readSafeUtf8FileSync(filePath, conclusionsLabel, maxConclusionsBytes)
        if (content === null) return none
        const value: unknown = JSON.parse(content)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return none
        const record = value as { version?: unknown; lines?: unknown; changes?: unknown }
        if (record.version !== 1 || typeof record.lines !== 'object' || record.lines === null || Array.isArray(record.lines)) return none
        return {
          lines: parseSiteRecord(record.lines, parseConclusionLine),
          changes: parseSiteRecord(record.changes, parseRelayRouteChange),
        }
      } catch {
        return none
      }
    },
    async writeConclusions(conclusions) {
      const lines = parseSiteRecord(conclusions.lines, parseConclusionLine)
      const changes = parseSiteRecord(conclusions.changes, parseRelayRouteChange)
      const stored = Object.keys(changes).length ? { version: 1, lines, changes } : { version: 1, lines }
      ensureSafeDataDirectory(path.dirname(filePath), conclusionsLabel)
      await writeAtomicSafeUtf8File(filePath, `${JSON.stringify(stored)}\n`, conclusionsLabel)
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

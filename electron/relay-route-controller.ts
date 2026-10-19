/**
 * 「自动」线路怎么定（直连适配第二步，yoyo 10-6 回「改」；#941 第 3 节改成只看健康检查、加防抖）。
 *
 * 星芒账号和历史账号各有两条线路：默认线路（xm.solov.cc / api.solov.cc）和直连
 * （xm-direct.solov.cc / api-direct.solov.cc）。选「自动」的站先走一条、连不上改走另一条（备用）：
 * 星芒账号先走直连、备用默认线路；历史账号反过来，先走默认线路（api 的 CF）、备用直连（yoyo 10-14，
 * relay-sites.ts 的 relayAutoPreferredLines）。写死一条线路的站不探测、不退回。
 *
 * 改不改线路只看健康检查（probeRelayLineHealth）。请求慢、超时不算那条线路坏了：10-7 线上有客户
 * 直连下行只有几十 KB/s，公告下到一半超时就被当成直连坏了，在两条线路之间来回切。
 *
 * - 开机不等检查结果：先用上次存下的结论。没有结论时星芒账号先走直连（yoyo 10-8「xm 站点这边全部
 *   走直连」），开机那一轮两条一起查，直连没通就马上改走默认线路，不等下面那三次（#963：新用户开机
 *   就注册，没查过的线路连不上就注册失败）；查出的结论存下来，下次开机就照下面的规矩。星芒账号写进
 *   工具配置的线路另由 tool-route-controller.ts 定，不看这里。历史账号先走默认线路（这时不算定下来，
 *   工具配置不跟着迁），后台再查。
 * - 走先走的那条时隔一阵查一次。星芒自己的请求在它上面连不上（relay-line-fetch.ts 说了哪些算）就马上
 *   查，不等下一次；报上来的只叫这里去查，改不改照样看查的结果。
 * - 先走的那条连续 3 次没查通、备用那条查通了才改走备用那条；两条都不通（比如开机时还没联网）就不改，
 *   免得工具配置来回换，过一阵再查。先走的那条上的请求 5 分钟里攒够 3 次中途断开、等不来回话的，也当它
 *   连着没查通（#1157 第 1 条）：健康检查只拉几 KB，被限速、长连接被掐的线路照样查得通，可 AI 回复次次断在
 *   半路。正文下得慢不算，那种 relay-line-fetch.ts 本来就不报。
 * - 退到备用那条以后隔两分钟查一次先走的那条，连续 10 分钟都查得通才切回来。
 * - 开机（有存下的结论时）、唤醒、网络恢复、点「重新检测」，和退到备用以后它上面的请求也没走通时，
 *   两条一起查：走着的那条不通、另一条通了就当场换过去，不等三次也不等那 10 分钟（#1053）。三次阈值
 *   防的是两条都能用时来回横跳，这时走着的那条刚没查通、另一条刚查通，不是横跳；不这样的话，换了
 *   网络以后要一分多钟才退得出坏掉的那条，备用那条自己坏了更是要等满 10 分钟。唤醒、换网那几秒网络
 *   正在变，一次没查通不作数（#1156）：唤醒、网络恢复以后先等 relayRouteNetworkSettleMs 再查；查出
 *   走着的那条不通，隔 relayRouteLineDownConfirmMs 再查它一次，还不通才换；报「网络变了」那几种错的
 *   算没查准，不算不通。
 * - 两次切换至少隔 5 分钟：每切一次工具配置都要跟着改，开着的工具要重开。
 *
 * 结论和每个站最近一次切换落盘（relay-route-lines.json），下次开机先用结论，诊断页说得出最近一次
 * 为什么换。只存线路 id 和原因，不存地址：地址只从 relay-sites.ts 里来。
 */
import path from 'node:path'
import { readBoundedResponseText } from './bounded-response'
import { isJsonContentType, networkFailureCode, parsesAsJsonObject } from './network-failure'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import { scheduleTimeout } from './schedule-timeout'
import {
  relayAutoBackupLine,
  relayAutoPreferredLines,
  relayRouteSiteIds,
  type RelayEndpointId,
  type RelayRouteLine,
  type RelayRoutePreference,
  type RelayRouteSiteId,
} from './relay-sites'

/** 走先走的那条时、两条都没连上以后，隔这么久再查一次。 */
export const relayRouteRecheckIntervalMs = 5 * 60_000

/** 先走的那条连续这么多次健康检查没通过，才改走备用那条。 */
export const relayRouteFailureThreshold = 3

/** 一轮里一次没查通，隔这么久再查下一次：网络抖一下、别的下载把窄带宽占满一阵，都不至于连着三次没通过。 */
export const relayRouteFailureProbeGapMs = 15_000

/** 退到备用那条以后，隔这么久查一次先走的那条。 */
export const relayRouteRecoveryProbeIntervalMs = 2 * 60_000

/** 退到备用那条以后，先走的那条要连续查得通这么久才切回去。 */
export const relayRouteRecoveryMs = 10 * 60_000

/** 两次切换至少隔这么久。 */
export const relayRouteMinSwitchGapMs = 5 * 60_000

/** 请求报上来的先走那条的失败，查过一轮以后这么久之内不再为它重查：一批请求一起失败只查一轮。 */
export const relayRouteFailureRecheckGapMs = 30_000

/**
 * 先走的那条上的请求这么久里攒够 relayRouteRequestFailureThreshold 次中途断开、等不来回话，就当它连着没查通
 * （#1157 第 1 条）。
 */
export const relayRouteRequestFailureWindowMs = 5 * 60_000
export const relayRouteRequestFailureThreshold = 3

// 健康检查查不出来的那两种请求失败（relay-line-fetch.ts 报的）：回了话以后正文读到一半断了，连回应头都没等来。
const requestLayerReasons: ReadonlySet<string> = new Set(['body', 'no-answer'])

/** 先走的那条上的请求接连没走通、改走备用那条时记的 trigger：检查报告据此不说「连着 3 次没连上」。 */
export const requestFailuresTrigger = 'request-failures'

// 切回先走的那条要连着查通这么多次（头一次到最后一次正好隔 relayRouteRecoveryMs）。数次数不看钟：计时器
// 只会晚到不会早到，连着这么多次就一定跨过了那么久；电脑睡一觉醒来钟跳过去几个小时，睡前那一次
// 不该跟醒来这一次连成「一直查得通」。
const recoveryStreak = relayRouteRecoveryMs / relayRouteRecoveryProbeIntervalMs + 1

// 「自动」的站这台电脑上还没有结论时，开机先走哪条。星芒账号直接定在直连：开机那一轮两条一起查
// （checkFirstLaunch），直连没通就马上退回默认线路，好了再按下面的规矩切回来。历史账号（sub2api）
// 先走的就是默认线路：照旧先走它、查出结论再迁。
const unconcludedStart: Readonly<Record<RelayRouteSiteId, RelayRouteLine>> = {
  solov: { line: 'direct', settled: true },
  'solov-api': { line: 'primary', settled: false },
}

// 全新安装开机那一轮（checkFirstLaunch）从开查算起，默认线路已经查通的话，直连最多等这么久。直连被
// 丢包时它的健康检查要等满 probeTimeoutMs 才算没通，新用户这会儿正在填注册（#963）。
export const relayRouteFirstLaunchPreferDirectMs = 1_500

/**
 * 唤醒、网络恢复以后等这么久再两条一起查：系统这几秒里接连报网络变化，这时查出的「不通」多半是网络
 * 在变、不是线路坏了；这段时间里接连来的只查一次（#1156）。客户点「重新检测」不等。
 */
export const relayRouteNetworkSettleMs = 8_000

/** 两条一起查出走着的那条没通、另一条通了：隔这么久再查一次走着的那条，还不通才换过去（#1156）。 */
export const relayRouteLineDownConfirmMs = 4_000

// 网络这会儿正在变（唤醒、换 Wi-Fi、断网那一下）时 Chromium 报的错：说明不了线路坏没坏，两条一起查
// 时算没查准，不据此换线（#1156）。
const networkUnsettledCodes: ReadonlySet<string> = new Set(['ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_IO_SUSPENDED'])

/** 一次健康检查的结果：通、不通，或者网络正在变、没查准。 */
type LineHealth = 'up' | 'down' | 'unsure'

// 健康检查那个接口只回几 KB，平时一秒内就回；给足时间，直连下行只有几十 KB/s 时也查得完。
const probeTimeoutMs = 10_000
const maxProbeBytes = 256 * 1024

/**
 * 为什么改的线路：startup = 这次开机第一次定下来，先走的那条查通了；health-failed = 先走的那条连续几次
 * 健康检查没通过（或者它上面的请求接连断在半路、等不来回话，trigger 是 requestFailuresTrigger）、备用那条
 * 查通了，改走备用那条；line-down = 两条一起查的那一轮里走着的那条没通、另一条
 * 通了，当场换过去（哪个方向都可能）；recovered = 退到备用以后先走的那条一直查得通，切回去。
 */
export type RelayRouteChangeReason = 'startup' | 'health-failed' | 'line-down' | 'recovered'

/** 一个站最近一次改线路。只记线路 id 和原因，不记地址。 */
export interface RelayRouteChange {
  from: RelayEndpointId
  to: RelayEndpointId
  reason: RelayRouteChangeReason
  /**
   * 换线路那一轮检查是怎么起的：startup = 开机，scheduled = 定时查，resume / network / manual = 唤醒、
   * 网络恢复、点「重新检测」，别的是星芒自己的请求在走着的那条上碰到的失败（错误码，比如
   * ERR_CONNECTION_RESET）。连着查通 10 分钟切回先走的那条时没有。
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
  /** 一个站这会儿走哪条线路、是不是「自动」挑的（只有「自动」会在先走的那条连不上时改走备用那条）。 */
  route(siteId: RelayRouteSiteId): { line: RelayEndpointId; automatic: boolean }
  /** 「自动」的站最近一次改线路（这台电脑上从没改过就是 null）；写死线路的站没有。 */
  lastChange(siteId: RelayRouteSiteId): RelayRouteChange | null
  /** 开机后在后台查「自动」的站。 */
  start(): void
  /**
   * 星芒自己的一次请求在「自动」的站这会儿走的那条线路上没走通：马上查一轮，不等下一次定时的。只是叫
   * 这里去查，改不改线路照样只看健康检查。走的是先走的那条就照三次的规矩查；已经退到备用那条就两条一起
   * 查，备用那条不通、先走的那条通了当场切回去。报的不是这会儿走的那条（线路刚换过）就不管。例外是先走的
   * 那条上中途断开（body）、等不来回话（no-answer）的：攒够了就当它连着没查通（#1157 第 1 条）。
   */
  reportFailure(siteId: RelayRouteSiteId, line: RelayEndpointId, reason: string): void
  /**
   * 唤醒、网络恢复、客户点「重新检测」：每个「自动」的站两条一起查一轮，走着的那条不通、另一条通就
   * 换过去；这个站正有检查没回来的，那次查完马上补这一轮。唤醒、网络恢复先等 relayRouteNetworkSettleMs
   * 再查，「重新检测」马上查。唤醒、网络恢复时，退到备用以后攒下的「一直查得通」从头数：睡前那几次不该
   * 跟醒来连成一段。
   */
  recheck(trigger: 'resume' | 'network' | 'manual'): void
  /** 线路改了就叫一声，返回取消订阅。 */
  subscribe(listener: (siteId: RelayRouteSiteId, line: RelayRouteLine) => void): () => void
  dispose(): void
}

interface SiteState {
  line: RelayEndpointId
  settled: boolean
  /** 正在查的这一轮：怎么起的、已经连着没查通几次。不在查就是 null。 */
  round: { trigger: string; failures: number } | null
  /** 退到备用那条以后，先走的那条已经连着查通了几次。 */
  recovered: number
  /** 有一次检查还没回来。 */
  checking: boolean
  /** 唤醒、网络恢复、「重新检测」赶上 checking：记下怎么起的，那次查完马上补一轮两条一起查。 */
  pendingRecheck: string | null
  /** 这次运行里上一次改线路的时间。 */
  switchedAt: number | null
  /** 上一次为请求报上来的失败去查是什么时候。 */
  failureCheckedAt: number | null
  /** 先走的那条上最近几次请求中途断开、等不来回话是什么时候（relayRouteRequestFailureWindowMs 里的）。 */
  requestFailures: number[]
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

// 0.2.18 及以前两个站都先走直连，历史账号那时存下的「直连」是查通了就定的，不是默认线路连不上退过去的。
// 现在历史账号先走默认线路（yoyo 10-14），这种结论连同那次切换一起不认，开机照没有结论办：先走默认线路，
// 查通了定下来，工具配置跟着迁回来。按现在的规矩退到直连的，最近一次切换一定记着「health-failed（或
// line-down）、改走直连」，照旧认。先走的就是直连的站（星芒账号）规矩没变，结论原样用。
function retireDirectFirstConclusions(stored: RelayRouteConclusions): RelayRouteConclusions {
  const lines = { ...stored.lines }
  const changes = { ...stored.changes }
  for (const siteId of relayRouteSiteIds) {
    if (relayAutoPreferredLines[siteId] === 'direct' || lines[siteId] !== 'direct') continue
    const change = changes[siteId]
    if (change?.to === 'direct' && (change.reason === 'health-failed' || change.reason === 'line-down')) continue
    delete lines[siteId]
    delete changes[siteId]
  }
  return { lines, changes }
}

export function createRelayRouteController(dependencies: RelayRouteControllerDependencies): RelayRouteController {
  const schedule = dependencies.schedule ?? scheduleTimeout
  const now = dependencies.now ?? Date.now
  const listeners = new Set<(siteId: RelayRouteSiteId, line: RelayRouteLine) => void>()
  let disposed = false
  let conclusions: RelayRouteConclusions = { lines: {}, changes: {} }
  try {
    conclusions = retireDirectFirstConclusions(dependencies.readConclusions())
  } catch {
    conclusions = { lines: {}, changes: {} }
  }
  let writing: Promise<void> = Promise.resolve()
  // 唤醒、网络恢复以后等网络稳下来那一下（relayRouteNetworkSettleMs），和两条一起查里等着再查一次的那几下。
  let cancelSettleWait: (() => void) | null = null
  const confirmWaits = new Set<() => void>()
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
      pendingRecheck: null,
      switchedAt: null,
      failureCheckedAt: null,
      requestFailures: [],
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

  // 两条一起查用：不经 check()，抛错时分得出是网络正在变（没查准）还是真没通。
  function probeHealth(siteId: RelayRouteSiteId, line: RelayEndpointId): Promise<LineHealth> {
    function failed(error: unknown): LineHealth {
      const code = networkFailureCode(error)
      return code !== null && networkUnsettledCodes.has(code) ? 'unsure' : 'down'
    }
    try {
      return dependencies.probe(siteId, line).then((reachable): LineHealth => reachable === true ? 'up' : 'down', failed)
    } catch (error) {
      return Promise.resolve(failed(error))
    }
  }

  function confirmWait(): Promise<void> {
    return new Promise((resolve) => {
      const cancel = schedule(() => {
        confirmWaits.delete(cancel)
        resolve()
      }, relayRouteLineDownConfirmMs)
      confirmWaits.add(cancel)
    })
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

  // 定下来以后接着看：走先走的那条隔一阵查一次；退到备用那条隔两分钟查一次先走的那条，看能不能切回去。
  function watch(siteId: RelayRouteSiteId, state: SiteState): void {
    if (state.line === relayAutoPreferredLines[siteId]) setTimer(state, relayRouteRecheckIntervalMs, () => beginRound(siteId, state, 'scheduled'))
    else setTimer(state, relayRouteRecoveryProbeIntervalMs, () => runCheck(siteId, state, checkRecovery))
  }

  function settle(siteId: RelayRouteSiteId, state: SiteState, line: RelayEndpointId, reason: RelayRouteChangeReason, trigger?: string): void {
    const from = state.line
    const changed = from !== line || !state.settled
    const firstConclusion = state.firstLaunch
    state.line = line
    state.settled = true
    state.round = null
    state.recovered = 0
    // 换线以前攒下的请求失败不带到下一回走先走的那条上。
    state.requestFailures = []
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
    log('info', 'relay.route.changed', line === 'direct' ? '「自动」线路改走线路2' : '「自动」线路改走线路1', {
      siteId, from, to: line, reason, ...(trigger === undefined ? {} : { trigger }),
    })
    persist()
    const current = { line: state.line, settled: state.settled }
    for (const listener of [...listeners]) {
      try { listener(siteId, current) } catch { /* 一个订阅方出错不影响别的 */ }
    }
  }

  // bothLines：两条一起查（checkBothLines）。退到备用那条以后起的一轮都是两条一起查。
  function beginRound(siteId: RelayRouteSiteId, state: SiteState, trigger: string, bothLines = false): void {
    if (disposed || state.round || state.checking) return
    state.round = { trigger, failures: 0 }
    if (state.firstLaunch) runCheck(siteId, state, checkFirstLaunch)
    else if (bothLines || state.line !== relayAutoPreferredLines[siteId]) runCheck(siteId, state, checkBothLines)
    else runCheck(siteId, state, checkPreferred)
  }

  // 每一步检查都经这里起：查完有攒着的重新检测就补上（recheckSite）。
  function runCheck(siteId: RelayRouteSiteId, state: SiteState, step: (siteId: RelayRouteSiteId, state: SiteState) => Promise<void>): void {
    void step(siteId, state).then(() => {
      if (state.pendingRecheck !== null && !state.checking) recheckSite(siteId, state, state.pendingRecheck)
    })
  }

  // 唤醒、网络恢复、「重新检测」一定两条一起查一轮，还没定下线路的历史账号也一样，不走三次的规矩。正有检查
  // 没回来就记下来，查完马上补，不丢：唤醒那一刻，睡着时到点的切回检查往往同时起来，它只查先走的那条，
  // 走着的备用那条坏了查不出来。先走的那条没查通、正等着隔 15 秒再查的那一轮不等了，换成两条一起查。
  function recheckSite(siteId: RelayRouteSiteId, state: SiteState, trigger: string): void {
    if (disposed) return
    if (trigger !== 'manual') state.recovered = 0
    if (state.checking) {
      state.pendingRecheck = trigger
      return
    }
    state.pendingRecheck = null
    if (state.round) {
      state.cancelTimer?.()
      state.cancelTimer = null
      state.round = null
    }
    beginRound(siteId, state, trigger, true)
  }

  // 两条一起查以后接着看：走先走的那条照常隔一阵查一次；退到备用那条时切回去的计时照旧，已经挂着的
  // 那次不往后推，不然请求接连失败、一轮轮查下来，切回去那两分钟一次的检查就一直排不上。
  function keepWatching(siteId: RelayRouteSiteId, state: SiteState): void {
    if (state.line === relayAutoPreferredLines[siteId] || !state.cancelTimer) watch(siteId, state)
  }

  // 一轮里查一次先走的那条。通了：没定下来的定在它上面，走着它的接着走。没通：连着够 3 次再查备用那条，
  // 它通了（也隔够了上次切换）才改走备用那条。
  async function checkPreferred(siteId: RelayRouteSiteId, state: SiteState): Promise<void> {
    const round = state.round
    if (!round) return
    const preferred = relayAutoPreferredLines[siteId]
    const reachable = await check(state, siteId, preferred)
    if (reachable === null || state.round !== round) return
    if (reachable) {
      if (!state.settled) {
        settle(siteId, state, preferred, 'startup')
        return
      }
      state.round = null
      watch(siteId, state)
      return
    }
    round.failures += 1
    log('info', 'relay.route.check-failed', '先走的那条线路这次健康检查没通过', {
      siteId, line: preferred, failures: round.failures, trigger: round.trigger,
    })
    if (round.failures < relayRouteFailureThreshold) {
      setTimer(state, relayRouteFailureProbeGapMs, () => runCheck(siteId, state, checkPreferred))
      return
    }
    await checkBackup(siteId, state)
  }

  // 先走的那条算是连着没查通了（三次健康检查，或者请求接连没走通）：查一次备用那条，它通了（也隔够了
  // 上次切换）才改走它。离上次切换不够久的，到点照常从头查一轮先走的那条：请求接连没走通的那种到时候查得通，
  // 线路先不改，它上面的请求再攒够了再来。
  async function checkBackup(siteId: RelayRouteSiteId, state: SiteState): Promise<void> {
    const round = state.round
    if (!round) return
    const backup = relayAutoBackupLine(siteId)
    const backupReachable = await check(state, siteId, backup)
    if (backupReachable === null || state.round !== round) return
    state.round = null
    if (!backupReachable) {
      log('warn', 'relay.route.unreachable', '线路1和线路2这会儿都没连上，线路先不改', {
        siteId, line: state.line, settled: state.settled, trigger: round.trigger,
      })
      setTimer(state, relayRouteRecheckIntervalMs, () => beginRound(siteId, state, 'scheduled'))
      return
    }
    const wait = switchWait(state)
    if (wait > 0) {
      log('info', 'relay.route.held', '先走的那条没查通，离上次切换还不够久，到点再查一轮', { siteId, line: state.line, waitMs: wait })
      setTimer(state, wait, () => beginRound(siteId, state, round.trigger))
      return
    }
    settle(siteId, state, backup, 'health-failed', round.trigger)
  }

  // 先走的那条上的请求中途断开、等不来回话（#1157 第 1 条，文件头）：relayRouteRequestFailureWindowMs 里攒够
  // relayRouteRequestFailureThreshold 次就当它连着没查通，不再查它自己（它的健康检查这时照样查得通），直接查
  // 备用那条。开查了就返回 true。退到备用那条以后不攒：那边请求没走通本来就两条一起查（#1053），切回先走的
  // 那条照旧要连着查通 10 分钟。正有检查没回来的这次不开查，攒下的留着，下一次失败再看。
  function noteRequestFailure(siteId: RelayRouteSiteId, state: SiteState, reason: string, at: number): boolean {
    if (!requestLayerReasons.has(reason) || !state.settled || state.firstLaunch || state.line !== relayAutoPreferredLines[siteId]) return false
    state.requestFailures = state.requestFailures.filter((failedAt) => failedAt <= at && at - failedAt < relayRouteRequestFailureWindowMs)
    state.requestFailures.push(at)
    if (state.requestFailures.length < relayRouteRequestFailureThreshold || state.checking) return false
    state.requestFailures = []
    // 先走的那条正等着隔 15 秒再查的那一轮不等了。
    if (state.round) {
      state.cancelTimer?.()
      state.cancelTimer = null
    }
    state.failureCheckedAt = at
    log('info', 'relay.route.requests-failed', '先走的那条线路上请求接连断在半路、等不来回话，查一下备用那条', {
      siteId, line: state.line, failures: relayRouteRequestFailureThreshold, windowMs: relayRouteRequestFailureWindowMs,
    })
    state.round = { trigger: requestFailuresTrigger, failures: relayRouteFailureThreshold }
    runCheck(siteId, state, checkBackup)
    return true
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
      log('info', 'relay.route.first-launch', '这台电脑第一次定线路：线路2没连上，不等三次直接定在线路1', {
        siteId, line: 'primary', trigger: round.trigger,
      })
      settle(siteId, state, 'primary', 'health-failed', firstLaunchTrigger)
      return
    }
    // 两条都没连上（开机时还没联网那种）：和原来一样不改，过一阵再查；还是全新安装，下一轮照样两条一起查。
    log('warn', 'relay.route.unreachable', '线路1和线路2这会儿都没连上，线路先不改', {
      siteId, line: state.line, settled: state.settled, trigger: round.trigger,
    })
    setTimer(state, relayRouteRecheckIntervalMs, () => beginRound(siteId, state, 'scheduled'))
  }

  // 两条一起查（#1053）：开机（有存下的结论时）、唤醒、网络恢复、点「重新检测」，和退到备用以后它上面的
  // 请求也没走通。走着的那条不通、另一条通了，隔几秒再查一次走着的那条，还不通就换过去，不等三次（文件头）；
  // 报的是网络正在变就不换（#1156）。两次切换至少隔 5 分钟照旧。
  // 都通就不动：退到备用时先走的那条通了也不在这里切回去，切回去照旧要连着查通 10 分钟，这一轮只有开机
  // 那次算进去（和原来一样），别的时候查出先走的那条没通就从头数。健康检查只读，两条一起查没有副作用；
  // 两个检查不经 check()，理由同 checkFirstLaunch。
  async function checkBothLines(siteId: RelayRouteSiteId, state: SiteState): Promise<void> {
    const round = state.round
    if (!round) return
    const preferred = relayAutoPreferredLines[siteId]
    const current = state.line
    const other = current === preferred ? relayAutoBackupLine(siteId) : preferred
    state.checking = true
    let currentHealth: LineHealth = 'down'
    let otherHealth: LineHealth = 'down'
    try {
      [currentHealth, otherHealth] = await Promise.all([probeHealth(siteId, current), probeHealth(siteId, other)])
      // 走着的那条没通、另一条通了：隔一会儿再查一次走着的那条，还不通才算它坏了。唤醒、换网那几秒里
      // 两条同时查，往返长的那条更容易吃到网络变化那一下（#1156）。
      if (currentHealth !== 'up' && otherHealth === 'up' && !disposed) {
        await confirmWait()
        if (!disposed) currentHealth = await probeHealth(siteId, current)
      }
    } finally {
      state.checking = false
    }
    if (disposed || state.round !== round) return
    state.round = null
    const otherUp = otherHealth === 'up'
    if (current !== preferred) {
      if (!otherUp) state.recovered = 0
      else if (round.trigger === 'startup') state.recovered += 1
    }
    if (currentHealth === 'up') {
      if (!state.settled) {
        settle(siteId, state, current, 'startup')
        return
      }
      keepWatching(siteId, state)
      return
    }
    log('info', 'relay.route.check-failed', current === preferred ? '先走的那条线路这次健康检查没通过' : '备用那条线路这次健康检查没通过', {
      siteId, line: current, trigger: round.trigger, bothLines: true, ...(currentHealth === 'unsure' ? { unsure: true } : {}),
    })
    if (!otherUp || currentHealth === 'unsure') {
      if (otherUp) {
        log('info', 'relay.route.unsure', '走着的那条报的是网络正在变，这次不算没通，线路先不改', { siteId, line: current, trigger: round.trigger })
      } else {
        log('warn', 'relay.route.unreachable', '线路1和线路2这会儿都没连上，线路先不改', {
          siteId, line: state.line, settled: state.settled, trigger: round.trigger,
        })
      }
      if (current === preferred) setTimer(state, relayRouteRecheckIntervalMs, () => beginRound(siteId, state, 'scheduled'))
      else keepWatching(siteId, state)
      return
    }
    const wait = switchWait(state)
    if (wait > 0) {
      log('info', 'relay.route.held', '走着的那条没查通，离上次切换还不够久，到点再查一轮', { siteId, line: state.line, waitMs: wait })
      setTimer(state, wait, () => beginRound(siteId, state, round.trigger, true))
      return
    }
    settle(siteId, state, other, 'line-down', round.trigger)
  }

  // 退到备用那条以后查一次先走的那条：连着查通 recoveryStreak 次才切回去，中间一次没通就从头数。
  async function checkRecovery(siteId: RelayRouteSiteId, state: SiteState): Promise<void> {
    const preferred = relayAutoPreferredLines[siteId]
    if (state.line === preferred || !state.settled) return
    // 两条一起查的那一轮还没回来：这次先不查，过两分钟再来，不然切回去这条计时就断了。
    if (state.checking || state.round) {
      watch(siteId, state)
      return
    }
    const reachable = await check(state, siteId, preferred)
    if (reachable === null || state.line === preferred) return
    state.recovered = reachable ? state.recovered + 1 : 0
    if (state.recovered >= recoveryStreak) {
      settle(siteId, state, preferred, 'recovered')
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
        // 有存下的结论：两条一起查，换了网络时走着的那条不通、另一条通就当场换过去（#1053）。上次退到了
        // 备用那条的，切回去照旧按切回的规矩，开机这一次算头一次。没有结论的照原来：星芒账号走
        // checkFirstLaunch，历史账号先查默认线路。
        beginRound(siteId, state, 'startup', state.settled && !state.firstLaunch)
      }
    },
    reportFailure(siteId, line, reason) {
      const state = states.get(siteId)
      if (disposed || !state || state.line !== line) return
      const at = now()
      if (noteRequestFailure(siteId, state, reason, at) || state.round || state.checking) return
      if (state.failureCheckedAt !== null && at - state.failureCheckedAt >= 0
        && at - state.failureCheckedAt < relayRouteFailureRecheckGapMs) return
      state.failureCheckedAt = at
      const preferred = line === relayAutoPreferredLines[siteId]
      log('info', preferred ? 'relay.route.direct-failed' : 'relay.route.backup-failed',
        preferred ? '先走的那条线路上请求没走通，马上查一轮' : '备用那条线路上请求也没走通，两条一起查一轮', { siteId, line, reason })
      beginRound(siteId, state, triggerPattern.test(reason) ? reason : 'request', !preferred)
    },
    recheck(trigger) {
      if (disposed) return
      cancelSettleWait?.()
      cancelSettleWait = null
      for (const [siteId, state] of states) {
        log('info', 'relay.route.recheck', '唤醒、网络恢复或点了重新检测，查一轮线路', { siteId, line: state.line, trigger })
        if (trigger !== 'manual') state.recovered = 0
      }
      if (trigger === 'manual') {
        for (const [siteId, state] of states) recheckSite(siteId, state, trigger)
        return
      }
      // 唤醒、网络恢复：等网络稳下来再查，这段时间里又来的从头等、只查一次（#1156）。
      cancelSettleWait = schedule(() => {
        cancelSettleWait = null
        if (disposed) return
        for (const [siteId, state] of states) recheckSite(siteId, state, trigger)
      }, relayRouteNetworkSettleMs)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposed = true
      listeners.clear()
      cancelSettleWait?.()
      cancelSettleWait = null
      for (const cancel of confirmWaits) cancel()
      confirmWaits.clear()
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
  return value === 'startup' || value === 'health-failed' || value === 'line-down' || value === 'recovered'
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
 * 健康检查：星芒账号查 /api/status，历史账号查 /api/v1/settings/public（diagnostics-network-checks.ts 的
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

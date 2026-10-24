/**
 * 从星芒打开 Claude Desktop 之前，先在后台替用户把加速连上（#1373，yoyo 2026-10-24「按你的推荐修」）。
 *
 * Claude Desktop 第一次用、每次自己升级换了组件以后，都要从 downloads.claude.ai 下 Claude Code 程序和
 * Cowork 工作区（合计约 1.6GB），国内直连下不动，聊天、Cowork、Code 全起不来。它只跟着系统代理走，
 * 加速规则里这个主机已经送线路（acceleration-clash-config.ts 的 lineRoutedRules），所以要的是和
 * Codex 桌面端同一种整机连接（codex-desktop-acceleration.ts），那边的硬约束这里照搬：
 * - 已经连着、正在连、正在停的不动。用户自己连的那条归他，Claude 也跟着它下得到。
 * - 连不上就照常打开：每一处失败都收敛成一句日志，绝不抛给调用方。
 * - 悄悄地连：不扣免费时长，不弹通知，加速页和托盘看不见（acceleration-service 的 userAccelerationState）。
 * - 用完就断。星芒看不出 Claude 什么时候下完（组件放在哪、怎么核是 Claude 内部的事，每版都可能变），
 *   所以等 Claude 退出（连续两次确认）或者连满一小时就断。1.6GB 在这条线路上一般十几分钟下完，一小时是
 *   给慢网络留的余量；断开时内核还会再留十分钟，正在下的那条连接不会当场被掐断
 *   （acceleration-development-backend.ts 的 holdCoreForDrain）。
 * - 和 Codex 桌面端共用同一次会话（两个都是从星芒打开的、前后脚开的）时，先用完的那边不断，交给还在用的
 *   那边（heldElsewhere），不然一边下到一半就断了。
 *
 * 不含任何 Electron 依赖：读状态、连接、断开与问 Claude 在不在都由宿主注入。
 */
import type { AccelerationState } from './acceleration-contract'
import {
  codexDesktopAccelerationDecision,
  type CodexDesktopAccelerationOutcome,
  type CodexDesktopAccelerationSkipReason,
} from './codex-desktop-acceleration'

export type ClaudeDesktopAccelerationOutcome = CodexDesktopAccelerationOutcome

export interface ClaudeDesktopLaunchContext {
  /** Claude 还在不在跑：true / false / null（查不出来）。打开它的那一处才知道它装在哪。 */
  isDesktopRunning(): Promise<boolean | null>
}

export interface ClaudeDesktopAccelerationOptions {
  getAccountScope(): string | null
  readState(scope: string): Promise<AccelerationState>
  /** 第二个参数是刚读到的那一份状态：宿主据此判断记住的模式当前支不支持。 */
  connect(scope: string, state: AccelerationState): Promise<AccelerationState>
  /**
   * 只断 connectedAt 认得的那一次；连着的已经换成用户自己开的，就原样返回它
   * （acceleration-service 的 stopAutomaticAcceleration）。
   */
  disconnect(scope: string, connectedAt: string): Promise<AccelerationState>
  /** Codex 桌面端这会儿还在用同一次会话：Claude 这边用完了也不断，交给它。 */
  heldElsewhere?(scope: string, connectedAt: string): boolean
  /** 多久问一次 Claude 还在不在。缺省一分钟：Windows 上每问一次要起一个 PowerShell。 */
  watchIntervalMs?: number
  /** 连续几次确认 Claude 在跑之后改成多久问一次。缺省三分钟，查到不在或查不出来立刻退回一分钟。 */
  relaxedWatchIntervalMs?: number
  /** 从星芒打开那一刻起最多连多久。缺省一小时；再点一次「打开」从那一刻重新算。 */
  maxHoldMs?: number
  now?(): number
  schedule?(callback: () => void, milliseconds: number): () => void
  /** 「打开」最多为连接等多久；超时照常打开，连接在后台接着走，后来连上了照样盯着断开。 */
  timeoutMs?: number
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface ClaudeDesktopAccelerationCoordinator {
  /** 永不抛错：调用方拿到什么结果都要照常打开 Claude。 */
  ensureConnected(context: ClaudeDesktopLaunchContext): Promise<ClaudeDesktopAccelerationOutcome>
  /** 加速服务每产出一份状态都交过来看一眼：为 Claude 连的那一次漏了没人盯，从这里接着盯。 */
  observe(state: AccelerationState): void
  /** 这一次会话 Claude 这边还在用：Codex 桌面端用完了要交给这边，不能断。 */
  holds(scope: string, connectedAt: string): boolean
  dispose(): void
}

/** 连续这么多次确认 Claude 不在了才断开：刚关又开、进程交接的那一下不算。 */
const desktopGoneConfirmations = 2
/** 连续这么多次查不出来，也按不在了处理：宁可断开，也不能让不扣时长的线路一直开着。 */
const desktopUnknownLimit = 10
/** 连续这么多次确认 Claude 在跑，才放宽检查间隔：刚打开的头几分钟最可能是「打开看一眼就关」。 */
const desktopSteadyBeforeRelaxing = 3

const connectTimeoutMessage = '加速连接超时。'

/** 到了该断的时候，为什么断：Claude 退出了、查不出来太多次、连满了时长。 */
export type ClaudeDesktopReleaseCause = 'desktop-exited' | 'desktop-unknown' | 'hold-expired'

/**
 * 盯着的这一次该不该放手：只看数出来的几个数，好让这条判断能脱离宿主单测。
 * 连满时长排在最后：Claude 刚好退出时记成退出，日志更好读。
 */
export function claudeDesktopReleaseCause(watch: { gone: number; unknown: number; heldMs: number }, maxHoldMs: number): ClaudeDesktopReleaseCause | null {
  if (watch.gone >= desktopGoneConfirmations) return 'desktop-exited'
  if (watch.unknown >= desktopUnknownLimit) return 'desktop-unknown'
  if (watch.heldMs >= maxHoldMs) return 'hold-expired'
  return null
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(connectTimeoutMessage)), milliseconds)
    timer.unref?.()
    operation.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

function failureDetail(error: unknown): Record<string, unknown> {
  return { cause: error instanceof Error ? error.message : String(error) }
}

const releaseMessages: Record<ClaudeDesktopReleaseCause, string> = {
  'desktop-exited': 'Claude Desktop 已退出',
  'desktop-unknown': '一直查不出 Claude Desktop 还在不在',
  'hold-expired': '为 Claude Desktop 连的加速已满时长',
}

export function createClaudeDesktopAccelerationCoordinator(
  options: ClaudeDesktopAccelerationOptions,
): ClaudeDesktopAccelerationCoordinator {
  const timeoutMs = options.timeoutMs ?? 15_000
  const watchIntervalMs = options.watchIntervalMs ?? 60_000
  const relaxedWatchIntervalMs = Math.max(options.relaxedWatchIntervalMs ?? 180_000, watchIntervalMs)
  const maxHoldMs = options.maxHoldMs ?? 60 * 60_000
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  let inFlight: Promise<ClaudeDesktopAccelerationOutcome> | null = null
  interface Watch {
    scope: string
    connectedAt: string
    /** 从星芒打开那一刻（再点一次「打开」就重新算）。 */
    heldSince: number
    gone: number
    unknown: number
    steady: number
    probe: ClaudeDesktopLaunchContext['isDesktopRunning']
    cancel: (() => void) | null
  }
  let watch: Watch | null = null
  // 最近一次打开时拿到的「Claude 在不在」：后台才连上、从状态更新里接着盯的那一次也要用它。
  let lastProbe: ClaudeDesktopLaunchContext['isDesktopRunning'] | null = null
  // 交给 Codex 桌面端或已经放手的那一次：状态更新里再路过，不再盯回来。
  let released: { scope: string; connectedAt: string } | null = null
  let disposed = false

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能反过来挡住打开。 */ }
  }

  function heldElsewhere(scope: string, connectedAt: string): boolean {
    try { return options.heldElsewhere?.(scope, connectedAt) === true }
    catch { return false }
  }

  function stopWatching(): void {
    watch?.cancel?.()
    watch = null
  }

  /**
   * 盯这一次会话。来源不限：从星芒打开 Claude 时撞上 Codex 桌面端那一次，也要盯着，Codex 用完了才会交过来。
   * `reopened`：又从星芒点了一次「打开」，时长从这一刻重新算，数过的也清零。
   */
  function watchSession(state: AccelerationState, probe: Watch['probe'], reopened: boolean): boolean {
    if (disposed || state.phase !== 'active' || !state.autoStartedBy || !state.connectedAt) return false
    if (watch && watch.scope === state.scope && watch.connectedAt === state.connectedAt) {
      if (reopened) {
        watch.cancel?.()
        watch.cancel = null
        watch.heldSince = now()
        watch.gone = 0
        watch.unknown = 0
        watch.steady = 0
        watch.probe = probe
        next(watch)
      }
      return true
    }
    stopWatching()
    released = null
    const current: Watch = {
      scope: state.scope, connectedAt: state.connectedAt, heldSince: now(), gone: 0, unknown: 0, steady: 0, probe, cancel: null,
    }
    watch = current
    next(current)
    return true
  }

  function next(current: Watch): void {
    if (watch !== current) return
    current.cancel = schedule(() => {
      current.cancel = null
      void check(current).catch(() => undefined)
    }, current.steady >= desktopSteadyBeforeRelaxing ? relaxedWatchIntervalMs : watchIntervalMs)
  }

  async function check(current: Watch): Promise<void> {
    if (watch !== current || disposed) return
    // 换了账号：旧账号的会话加速服务已经停掉，再读只会被拒、每分钟空转一次。
    if (options.getAccountScope() !== current.scope) {
      stopWatching()
      return
    }
    let state: AccelerationState
    try { state = await options.readState(current.scope) }
    catch { next(current); return }
    if (watch !== current) return
    // 用户停过、重连过、自己点了「开始加速」，这条线路就不再是软件替他连的那一次了。
    if (state.phase !== 'active' || state.connectedAt !== current.connectedAt || !state.autoStartedBy
      || options.getAccountScope() !== current.scope) {
      stopWatching()
      return
    }
    let running: boolean | null
    try { running = await current.probe() }
    catch { running = null }
    if (watch !== current) return
    if (running === true) {
      current.gone = 0
      current.unknown = 0
      current.steady += 1
    } else {
      current.steady = 0
      if (running === false) current.gone += 1
      else current.unknown += 1
    }
    const cause = claudeDesktopReleaseCause({ gone: current.gone, unknown: current.unknown, heldMs: now() - current.heldSince }, maxHoldMs)
    if (!cause) {
      next(current)
      return
    }
    stopWatching()
    released = { scope: current.scope, connectedAt: current.connectedAt }
    const what = releaseMessages[cause]
    if (heldElsewhere(current.scope, current.connectedAt)) {
      log('info', 'acceleration.claude-desktop.handed-off', `${what}，自动连上的加速 Codex 桌面端还在用，交给它用完再断`, { cause })
      return
    }
    try {
      const after = await options.disconnect(current.scope, current.connectedAt)
      if (after.phase === 'active' && !after.autoStartedBy) {
        log('info', 'acceleration.claude-desktop.handed-over', `${what}，自动连上的那一次已换成用户自己开的加速，未断开`, { cause })
      } else {
        log('info', 'acceleration.claude-desktop.disconnected', `${what}，已断开打开它时自动连上的加速`, { cause })
      }
    } catch (error) {
      log('warn', 'acceleration.claude-desktop.disconnect.failed', `${what}，但自动连上的加速没能断开`, { cause, ...failureDetail(error) })
    }
  }

  /** 「打开」只等十五秒，连接本身撤不回来：后来连上了，跟准时连上的一样盯着断开。 */
  function followLateConnection(connecting: Promise<AccelerationState>, probe: Watch['probe']): void {
    void connecting.then((late) => {
      if (late.autoStartedBy !== 'claude-desktop' || !watchSession(late, probe, false)) return
      log('info', 'acceleration.claude-desktop.connected',
        '打开 Claude Desktop 时没等到的那次自动连接后来连上了，用完自动断开', { late: true })
    }, () => undefined).catch(() => undefined)
  }

  function skip(reason: CodexDesktopAccelerationSkipReason, message: string, detail?: Record<string, unknown>): ClaudeDesktopAccelerationOutcome {
    log(reason === 'no-account' ? 'info' : 'warn', 'acceleration.claude-desktop.skipped', message, { reason, ...detail })
    return { status: 'skipped', reason }
  }

  async function ensure(context: ClaudeDesktopLaunchContext): Promise<ClaudeDesktopAccelerationOutcome> {
    const probe = context.isDesktopRunning
    lastProbe = probe
    const scope = options.getAccountScope()
    if (!scope) return skip('no-account', '未登录当前账号，Claude Desktop 按未加速打开')
    let state: AccelerationState
    try { state = await withTimeout(options.readState(scope), timeoutMs) }
    catch (error) {
      return skip('state-unreadable', '打开 Claude Desktop 前读不到加速状态，已照常打开', failureDetail(error))
    }
    const decision = codexDesktopAccelerationDecision(state)
    if (decision === 'already-connected') {
      // 软件替他连的那一次（为 Claude 上回连的，或者为 Codex 桌面端连的）也算 Claude 在用，接着盯；
      // 用户自己连的归他，不盯。
      const watched = watchSession(state, probe, true)
      log('info', 'acceleration.claude-desktop.reused', watched
        ? '打开 Claude Desktop 时软件替他连的加速已在运行，接着用，用完再断'
        : '打开 Claude Desktop 时加速已在运行，未改动现有连接')
      return { status: 'already-connected' }
    }
    if (decision === 'unavailable') return skip('unavailable', '本机加速组件不可用，Claude Desktop 按未加速打开')
    let connected: AccelerationState
    const connecting = options.connect(scope, state)
    try { connected = await withTimeout(connecting, timeoutMs) }
    catch (error) {
      const timedOut = error instanceof Error && error.message === connectTimeoutMessage
      if (timedOut) followLateConnection(connecting, probe)
      return skip(timedOut ? 'timeout' : 'connect-failed',
        timedOut
          ? '打开 Claude Desktop 前自动连接加速未在预期时间内完成，已照常打开'
          : '打开 Claude Desktop 前自动连接加速未成功，已照常打开',
        failureDetail(error))
    }
    if (connected.phase !== 'active' && connected.phase !== 'connecting') {
      return skip('connect-failed', '打开 Claude Desktop 前自动连接加速未成功，已照常打开', { phase: connected.phase })
    }
    log('info', 'acceleration.claude-desktop.connected', '已为打开 Claude Desktop 自动连接加速，不扣免费时长，用完自动断开')
    // connecting 还没有 connectedAt，认不出要断的是哪一次：等它在状态更新里连上（observe）。
    if (connected.phase === 'active') watchSession(connected, probe, false)
    return { status: 'connected' }
  }

  return {
    ensureConnected(context) {
      if (inFlight) return inFlight
      const pending = ensure(context).catch((error: unknown) => skip('connect-failed',
        '打开 Claude Desktop 前自动连接加速未成功，已照常打开', failureDetail(error)))
      inFlight = pending
      void pending.finally(() => { if (inFlight === pending) inFlight = null }).catch(() => undefined)
      return pending
    },
    observe(state) {
      // 只接着盯为 Claude 连的那一次：为 Codex 连的由它自己管，Claude 没从星芒打开就不陪着。
      if (state.scope !== options.getAccountScope() || state.autoStartedBy !== 'claude-desktop' || !lastProbe) return
      if (released && released.scope === state.scope && released.connectedAt === state.connectedAt) return
      watchSession(state, lastProbe, false)
    },
    holds(scope, connectedAt) {
      return watch !== null && watch.scope === scope && watch.connectedAt === connectedAt
    },
    dispose() {
      disposed = true
      stopWatching()
    },
  }
}

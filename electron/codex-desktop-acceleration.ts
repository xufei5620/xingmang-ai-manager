/**
 * 打开 Codex 桌面端之前，先替用户把加速连上。
 *
 * 桌面端是另一个独立进程，不在本软件的网络栈里，所以它唯一能跟着走的是**系统
 * 代理**——下载专用线路（download-acceleration.ts）那种「只开本机回环端口、
 * 不动系统代理」的用法对它一点作用都没有。这里走的因此是与用户亲手点「连接」
 * 几乎相同的那条路（acceleration-service 的 startAutomaticAcceleration），加速页
 * 上的状态一并照旧，线路与模式也用他在加速页上选过并落了盘的那一套
 * （acceleration-preference-store.ts），没选过才是「智能分配 + 标准模式」。
 * 唯一的不同是计费：这次连接不是他点的，不扣免费时长，时长用完了也照样连
 * （yoyo 2026-09-30 定）。
 *
 * 四条硬约束：
 * - 已经连着、正在连、正在停的，一律不动。那条线路归用户，不许替他重连或改线。
 * - 连不上就照常打开。加速是加分项，不能变成「打开」的前置条件，所以这里的每
 *   一处失败都收敛成一句日志，绝不抛给调用方。
 * - 桌面端退出后断开。不扣时长的线路一直开着就是白送不限时的加速，所以连上后
 *   定时问一次桌面端还在不在（isDesktopRunning），连续两次确认不在了就断开。
 *   只断自己连的那一次：用户停过、重连过，那条线路就归他了，不再管。
 * - 连上的那一刻要告诉他（onAutoConnected，宿主发一条系统通知），否则他不知道
 *   系统的网络设置被改过。
 *
 * 不含任何 Electron 依赖：读状态、连接、断开与问桌面端都由宿主注入。
 */
import type { AccelerationState } from './acceleration-contract'

export type CodexDesktopAccelerationSkipReason =
  /** 没登录，拿不到账号口径，也就没有额度可用。 */
  | 'no-account'
  /** 本机加速组件起不来（随包资源缺失、辅助进程建不出工作目录等）。 */
  | 'unavailable'
  /** 读不到当前状态：不知道用户是不是正连着，就不能贸然发起连接。 */
  | 'state-unreadable'
  | 'connect-failed'
  | 'timeout'

export type CodexDesktopAccelerationOutcome =
  | { status: 'connected' }
  | { status: 'already-connected' }
  | { status: 'skipped'; reason: CodexDesktopAccelerationSkipReason }

export type CodexDesktopAccelerationDecision = 'connect' | 'already-connected' | 'unavailable'

export interface CodexDesktopAccelerationOptions {
  getAccountScope(): string | null
  readState(scope: string): Promise<AccelerationState>
  /** 第二个参数是刚读到的那一份状态：宿主据此判断记住的模式当前支不支持。 */
  connect(scope: string, state: AccelerationState): Promise<AccelerationState>
  /** 这次确实是本模块替用户连上的（已经连着的不算）。回调抛错不影响打开。 */
  onAutoConnected?(state: AccelerationState): void
  /**
   * 桌面端还在不在跑：true / false / null（查不出来）。与 disconnect 一起给了
   * 才会在桌面端退出后断开自动连上的加速；缺省 = 旧行为，连上后不管。
   */
  isDesktopRunning?(): Promise<boolean | null>
  disconnect?(scope: string): Promise<AccelerationState>
  /** 多久问一次桌面端还在不在。缺省一分钟：Windows 上每问一次要起一个 PowerShell。 */
  watchIntervalMs?: number
  /**
   * 连续几次都确认桌面端在跑之后，改成多久问一次。缺省三分钟：人正开着桌面端写东西
   * 的那几个小时里，每分钟起一个 PowerShell（杀毒软件跟着扫一遍）纯属浪费；一旦
   * 查到不在或查不出来，立刻退回 watchIntervalMs。
   */
  relaxedWatchIntervalMs?: number
  schedule?(callback: () => void, milliseconds: number): () => void
  /**
   * 连线路要校验随包资源、拉起内核、再探一次节点，实测几秒。预算给 15 秒：
   * 比正常值宽出一截，又不至于让一台连不上的机器把「打开」拖成半分钟没反应。
   * 超时不代表没连上，只代表不再为它等下去——桌面端照常打开，线路连上了也
   * 留给用户。
   */
  timeoutMs?: number
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface CodexDesktopAccelerationCoordinator {
  /** 永不抛错：调用方拿到什么结果都要照常打开桌面端。 */
  ensureConnected(): Promise<CodexDesktopAccelerationOutcome>
  /** 停掉「桌面端退出就断开」的定时检查。退出程序时加速服务自己会停干净。 */
  dispose(): void
}

/** 连续这么多次确认桌面端不在了才断开：刚关又开、进程交接的那一下不算。 */
const desktopGoneConfirmations = 2
/**
 * 连续这么多次查不出来，也按不在了处理。查询坏掉的电脑上宁可断开，也不能让
 * 不扣时长的线路永远开着；按一分钟一次算，是十分钟。
 */
const desktopUnknownLimit = 10
/**
 * 连续这么多次确认桌面端在跑，才放宽检查间隔。刚连上的头几分钟最可能是「打开看一眼
 * 就关」，那段时间照旧每分钟问，关了能及时断开。放宽之后最坏情况是关掉后约
 * 三分钟才查到第一次「不在」，再隔一分钟确认，比原来晚两分钟左右断开。
 */
const desktopSteadyBeforeRelaxing = 3

/**
 * 只看状态决定要不要连，好让这条判断能脱离宿主单测。`stopping` 归入「不动」：
 * 用户刚点了停止，这时候连回去等于跟他抢。免费时长用完（exhausted）照样连：
 * 这次连接不扣时长。
 */
export function codexDesktopAccelerationDecision(state: AccelerationState): CodexDesktopAccelerationDecision {
  if (state.phase === 'active' || state.phase === 'connecting' || state.phase === 'stopping') {
    return 'already-connected'
  }
  if (state.phase === 'unavailable') return 'unavailable'
  return 'connect'
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('加速连接超时。')), milliseconds)
    timer.unref?.()
    operation.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/** `cause` 而不是 `reason`：后者是跳过的归类，两个不能在同一条日志里互相覆盖。 */
function failureDetail(error: unknown): Record<string, unknown> {
  return { cause: error instanceof Error ? error.message : String(error) }
}

export function createCodexDesktopAccelerationCoordinator(
  options: CodexDesktopAccelerationOptions,
): CodexDesktopAccelerationCoordinator {
  const timeoutMs = options.timeoutMs ?? 15_000
  const watchIntervalMs = options.watchIntervalMs ?? 60_000
  const relaxedWatchIntervalMs = Math.max(options.relaxedWatchIntervalMs ?? 180_000, watchIntervalMs)
  const schedule = options.schedule ?? ((callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  // 连续点两次「打开」不能变成两次连接请求：第二次跟着第一次的结果走。
  let inFlight: Promise<CodexDesktopAccelerationOutcome> | null = null
  interface Watch {
    scope: string
    connectedAt: string
    gone: number
    unknown: number
    /** 连续确认在跑的次数，决定下一次隔多久问。 */
    steady: number
    cancel: (() => void) | null
  }
  let watch: Watch | null = null
  let disposed = false

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能反过来挡住打开。 */ }
  }

  function stopWatching(): void {
    watch?.cancel?.()
    watch = null
  }

  /** 只盯本模块自己连上的那一次会话；同一次会话已经在盯就不重来。 */
  function watchSession(state: AccelerationState): void {
    if (disposed || !options.isDesktopRunning || !options.disconnect) return
    if (state.phase !== 'active' || !state.autoStartedBy || !state.connectedAt) return
    if (watch && watch.scope === state.scope && watch.connectedAt === state.connectedAt) return
    stopWatching()
    const current: Watch = { scope: state.scope, connectedAt: state.connectedAt, gone: 0, unknown: 0, steady: 0, cancel: null }
    watch = current
    next(current)
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
    let state: AccelerationState
    try { state = await options.readState(current.scope) }
    catch { next(current); return }
    if (watch !== current) return
    // 用户停过、重连过、换了账号，这条线路就不再是本模块连的那一次了。
    if (state.phase !== 'active' || state.connectedAt !== current.connectedAt || !state.autoStartedBy
      || options.getAccountScope() !== current.scope) {
      stopWatching()
      return
    }
    let running: boolean | null
    try { running = await options.isDesktopRunning!() }
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
    if (current.gone < desktopGoneConfirmations && current.unknown < desktopUnknownLimit) {
      next(current)
      return
    }
    stopWatching()
    const detail = { cause: current.gone >= desktopGoneConfirmations ? 'desktop-exited' : 'desktop-unknown' }
    try {
      await options.disconnect!(current.scope)
      log('info', 'acceleration.codex-desktop.disconnected', 'Codex 桌面端已退出，已断开打开它时自动连上的加速', detail)
    } catch (error) {
      log('warn', 'acceleration.codex-desktop.disconnect.failed', 'Codex 桌面端已退出，但自动连上的加速没能断开', { ...detail, ...failureDetail(error) })
    }
  }

  function skip(reason: CodexDesktopAccelerationSkipReason, message: string, detail?: Record<string, unknown>): CodexDesktopAccelerationOutcome {
    log(reason === 'no-account' ? 'info' : 'warn', 'acceleration.codex-desktop.skipped', message, { reason, ...detail })
    return { status: 'skipped', reason }
  }

  async function ensure(): Promise<CodexDesktopAccelerationOutcome> {
    const scope = options.getAccountScope()
    if (!scope) return skip('no-account', '未登录当前账号，Codex 桌面端按未加速打开')
    let state: AccelerationState
    try { state = await withTimeout(options.readState(scope), timeoutMs) }
    catch (error) {
      return skip('state-unreadable', '打开 Codex 桌面端前读不到加速状态，已照常打开', failureDetail(error))
    }
    const decision = codexDesktopAccelerationDecision(state)
    if (decision === 'already-connected') {
      log('info', 'acceleration.codex-desktop.reused', '打开 Codex 桌面端时加速已在运行，未改动现有连接')
      // 上次打开时自动连上的那一次还开着：接着盯（重启本模块之后也能接上）。
      watchSession(state)
      return { status: 'already-connected' }
    }
    if (decision === 'unavailable') {
      return skip('unavailable', '本机加速组件不可用，Codex 桌面端按未加速打开')
    }
    let connected: AccelerationState
    try { connected = await withTimeout(options.connect(scope, state), timeoutMs) }
    catch (error) {
      const timedOut = error instanceof Error && error.message === '加速连接超时。'
      return skip(timedOut ? 'timeout' : 'connect-failed',
        timedOut
          ? '打开 Codex 桌面端前自动连接加速未在预期时间内完成，已照常打开'
          : '打开 Codex 桌面端前自动连接加速未成功，已照常打开',
        failureDetail(error))
    }
    if (connected.phase !== 'active' && connected.phase !== 'connecting') {
      return skip('connect-failed', '打开 Codex 桌面端前自动连接加速未成功，已照常打开', { phase: connected.phase })
    }
    log('info', 'acceleration.codex-desktop.connected', '已为打开 Codex 桌面端自动连接加速，不扣免费时长，桌面端退出后自动断开')
    // connecting 还不算连上：会话没有 connectedAt，通知也就没有稳定的去重编号。
    if (connected.phase === 'active') {
      watchSession(connected)
      try { options.onAutoConnected?.(connected) }
      catch (error) { log('warn', 'acceleration.codex-desktop.notify.failed', '自动连接加速的提醒没有发出', failureDetail(error)) }
    }
    return { status: 'connected' }
  }

  return {
    ensureConnected() {
      if (inFlight) return inFlight
      const pending = ensure().catch((error: unknown) => skip('connect-failed',
        '打开 Codex 桌面端前自动连接加速未成功，已照常打开', failureDetail(error)))
      inFlight = pending
      void pending.finally(() => { if (inFlight === pending) inFlight = null }).catch(() => undefined)
      return pending
    },
    dispose() {
      disposed = true
      stopWatching()
    },
  }
}

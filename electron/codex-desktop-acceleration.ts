/**
 * 打开 Codex 桌面端之前，先替用户把加速连上。
 *
 * 桌面端是另一个独立进程，不在本软件的网络栈里，所以它唯一能跟着走的是**系统
 * 代理**——下载专用线路（download-acceleration.ts）那种「只开本机回环端口、
 * 不动系统代理」的用法对它一点作用都没有。这里走的因此是与用户亲手点「连接」
 * 几乎相同的那条路（acceleration-service 的 startAutomaticAcceleration），线路与
 * 模式也用他在加速页上选过并落了盘的那一套（acceleration-preference-store.ts），
 * 没选过才是「智能分配 + 标准模式」。不同的是计费：这次连接不是他点的，不扣免费
 * 时长，时长用完了也照样连（yoyo 2026-09-30 定）。
 *
 * 五条硬约束：
 * - 已经连着、正在连、正在停的，一律不动。那条线路归用户，不许替他重连或改线。
 * - 连不上就照常打开。加速是加分项，不能变成「打开」的前置条件，所以这里的每
 *   一处失败都收敛成一句日志，绝不抛给调用方。
 * - 用完就断。不扣时长的线路一直开着就是白送不限时的加速，还让整台电脑都绕道走
 *   加速（yoyo 2026-10-02：自动连的加速结束后要断开）。连上后定时问一次桌面端还在
 *   不在（isDesktopRunning）：桌面端用的是星芒的 Key，中文界面那份配置只在启动时
 *   拉一次，确认它起来了（约两分钟）就断（onlyNeededAtStartup）；登 ChatGPT 账号的
 *   一直要连 chatgpt.com，断早了发不出消息、启动时还会卡在「无法加载组织设置」，
 *   就等连续两次确认它不在了再断。只断自己连的那一次：用户停过、重连过、自己点了
 *   「开始加速」，那条线路就归他了，不再管。「打开」那一刻没等到、后来才连上的那一次
 *   也算自己连的，照样盯着（见 followLateConnection）。
 * - 悄悄地连。yoyo 2026-10-01 定：打开桌面端时加速只是「在后台顺手连一下」，不弹
 *   通知、不切页面、不抢焦点；连上、跳过、失败都只记日志。
 * - 不在加速页和托盘上出现。yoyo 2026-10-02 定：自动连的加速「不在游戏加速那边
 *   体现」。那边看到的状态由 acceleration-service 的 userAccelerationState 换过，
 *   这里读的、收到的仍是真实状态。
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
  /**
   * 桌面端还在不在跑：true / false / null（查不出来）。与 disconnect 一起给了
   * 才会在桌面端起来后或退出后断开自动连上的加速；缺省 = 旧行为，连上后不管。
   */
  isDesktopRunning?(): Promise<boolean | null>
  /**
   * 只断 connectedAt 认得的那一次；连着的已经换成用户自己开的，就原样返回它
   * （acceleration-service 的 stopAutomaticAcceleration）。
   */
  disconnect?(scope: string, connectedAt: string): Promise<AccelerationState>
  /**
   * 桌面端是不是只在启动那一下要加速：true = 它用的是星芒的 Key，确认它起来之后
   * 就断开；false、抛错 = 还要一直连着（ChatGPT 账号、没登录、读不出配置），等它
   * 退出再断。缺省 = 旧行为，等它退出。每次确认它在跑时都问一次，中途换了登录方式
   * 也跟得上。
   */
  onlyNeededAtStartup?(): boolean | Promise<boolean>
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
   * 超时不代表没连上，只代表「打开」不再为它等下去——桌面端照常打开，连接在
   * 后台接着走，后来连上了照样在桌面端退出后断开。
   */
  timeoutMs?: number
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface CodexDesktopAccelerationCoordinator {
  /** 永不抛错：调用方拿到什么结果都要照常打开桌面端。 */
  ensureConnected(): Promise<CodexDesktopAccelerationOutcome>
  /**
   * 加速服务每产出一份状态都交过来看一眼。软件替他连上、正连着、却没人盯着的那一次
   * （不管是怎么漏掉的），从这里接着盯，免得一条不扣时长的线路一直开到退出星芒。
   */
  observe(state: AccelerationState): void
  /** 停掉「桌面端退出就断开」的定时检查。退出程序时加速服务自己会停干净。 */
  dispose(): void
}

/** 连续这么多次确认桌面端不在了才断开：刚关又开、进程交接的那一下不算。 */
const desktopGoneConfirmations = 2
/**
 * 连续这么多次确认桌面端在跑，就算它已经起来了：按一分钟一次算，是打开后约两分钟。
 * 中文界面那份配置在冷启动的头几秒就拉完了，多出来的是给慢电脑留的余量。
 */
const desktopStartupConfirmations = 2
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

  /**
   * 只盯本模块自己连上的那一次会话；同一次会话已经在盯就不重来。返回这次会话
   * 现在有没有人盯着。
   */
  function watchSession(state: AccelerationState): boolean {
    if (disposed || !options.isDesktopRunning || !options.disconnect) return false
    if (state.phase !== 'active' || !state.autoStartedBy || !state.connectedAt) return false
    if (watch && watch.scope === state.scope && watch.connectedAt === state.connectedAt) return true
    stopWatching()
    const current: Watch = { scope: state.scope, connectedAt: state.connectedAt, gone: 0, unknown: 0, steady: 0, cancel: null }
    watch = current
    next(current)
    return true
  }

  /**
   * 「打开」只等 15 秒，连接本身却撤不回来：加速服务照样把它连完，而且照样不扣时长、
   * 没有到期。原来超时就撒手不管，慢电脑上（A014，2026-10-02）这条线路就一直开到
   * 退出星芒。所以超时之后接着等它的结果，连上了就跟准时连上的一样盯着。
   */
  function followLateConnection(connecting: Promise<AccelerationState>): void {
    void connecting.then((late) => {
      if (!watchSession(late)) return
      log('info', 'acceleration.codex-desktop.connected',
        '打开 Codex 桌面端时没等到的那次自动连接后来连上了，用完自动断开', { late: true })
    }, () => undefined).catch(() => undefined)
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
    // 换了账号、退出了登录：旧账号的会话加速服务已经停掉，再读它的状态只会被拒，
    // 落进下面的 catch 就是每分钟空转一次、永远停不下来。先看账号再读。
    if (options.getAccountScope() !== current.scope) {
      stopWatching()
      return
    }
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
    let cause: 'desktop-started' | 'desktop-exited' | 'desktop-unknown' | null = null
    if (running === true) {
      current.gone = 0
      current.unknown = 0
      current.steady += 1
      if (current.steady >= desktopStartupConfirmations && await neededOnlyAtStartup()) cause = 'desktop-started'
      if (watch !== current) return
    } else {
      current.steady = 0
      if (running === false) current.gone += 1
      else current.unknown += 1
      if (current.gone >= desktopGoneConfirmations) cause = 'desktop-exited'
      else if (current.unknown >= desktopUnknownLimit) cause = 'desktop-unknown'
    }
    if (!cause) {
      next(current)
      return
    }
    stopWatching()
    const started = cause === 'desktop-started'
    const what = started ? 'Codex 桌面端已经打开好了' : 'Codex 桌面端已退出'
    try {
      const after = await options.disconnect!(current.scope, current.connectedAt)
      if (after.phase === 'active' && !after.autoStartedBy) {
        log('info', 'acceleration.codex-desktop.handed-over', `${what}，自动连上的那一次已换成用户自己开的加速，未断开`, { cause })
      } else {
        log('info', 'acceleration.codex-desktop.disconnected', `${what}，已断开打开它时自动连上的加速`, { cause })
      }
    } catch (error) {
      log('warn', 'acceleration.codex-desktop.disconnect.failed', `${what}，但自动连上的加速没能断开`, { cause, ...failureDetail(error) })
    }
  }

  /** 查不出来按「还要一直连着」：断早了 ChatGPT 账号的客户会发不出消息。 */
  async function neededOnlyAtStartup(): Promise<boolean> {
    if (!options.onlyNeededAtStartup) return false
    try { return await options.onlyNeededAtStartup() === true }
    catch { return false }
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
    const connecting = options.connect(scope, state)
    try { connected = await withTimeout(connecting, timeoutMs) }
    catch (error) {
      const timedOut = error instanceof Error && error.message === '加速连接超时。'
      if (timedOut) followLateConnection(connecting)
      return skip(timedOut ? 'timeout' : 'connect-failed',
        timedOut
          ? '打开 Codex 桌面端前自动连接加速未在预期时间内完成，已照常打开'
          : '打开 Codex 桌面端前自动连接加速未成功，已照常打开',
        failureDetail(error))
    }
    if (connected.phase !== 'active' && connected.phase !== 'connecting') {
      return skip('connect-failed', '打开 Codex 桌面端前自动连接加速未成功，已照常打开', { phase: connected.phase })
    }
    log('info', 'acceleration.codex-desktop.connected', '已为打开 Codex 桌面端自动连接加速，不扣免费时长，用完自动断开')
    // connecting 还不算连上：会话没有 connectedAt，没法认出桌面端退出时要断的是哪一次。
    if (connected.phase === 'active') watchSession(connected)
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
    observe(state) {
      // 只认当前账号的：换了账号，旧账号的会话由加速服务自己停掉。
      if (state.scope !== options.getAccountScope()) return
      watchSession(state)
    },
    dispose() {
      disposed = true
      stopWatching()
    },
  }
}

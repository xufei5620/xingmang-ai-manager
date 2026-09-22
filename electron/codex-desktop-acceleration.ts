/**
 * 打开 Codex 桌面端之前，先替用户把加速连上。
 *
 * 桌面端是另一个独立进程，不在本软件的网络栈里，所以它唯一能跟着走的是**系统
 * 代理**——下载专用线路（download-acceleration.ts）那种「只开本机回环端口、
 * 不动系统代理」的用法对它一点作用都没有。这里走的因此是与用户亲手点「连接」
 * 完全相同的那条路：acceleration-service 的 startAcceleration，会话、免费时长
 * 计时、加速页上的状态一并照旧。
 *
 * 三条硬约束：
 * - 已经连着、正在连、正在停的，一律不动。那条线路归用户，不许替他重连或改线。
 * - 连不上就照常打开。加速是加分项，不能变成「打开」的前置条件，所以这里的每
 *   一处失败都收敛成一句日志，绝不抛给调用方。
 * - 不自动断开。连上之后由用户自己在加速页停，软件不替他决定什么时候结束。
 *
 * 不含任何 Electron 依赖：读状态与连接都由宿主注入。
 */
import type { AccelerationState } from './acceleration-contract'

export type CodexDesktopAccelerationSkipReason =
  /** 没登录，拿不到账号口径，也就没有额度可用。 */
  | 'no-account'
  /** 本机加速组件起不来（随包资源缺失、辅助进程建不出工作目录等）。 */
  | 'unavailable'
  | 'exhausted'
  /** 读不到当前状态：不知道用户是不是正连着，就不能贸然发起连接。 */
  | 'state-unreadable'
  | 'connect-failed'
  | 'timeout'

export type CodexDesktopAccelerationOutcome =
  | { status: 'connected' }
  | { status: 'already-connected' }
  | { status: 'skipped'; reason: CodexDesktopAccelerationSkipReason }

export type CodexDesktopAccelerationDecision = 'connect' | 'already-connected' | 'unavailable' | 'exhausted'

export interface CodexDesktopAccelerationOptions {
  getAccountScope(): string | null
  readState(scope: string): Promise<AccelerationState>
  connect(scope: string): Promise<AccelerationState>
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
}

/**
 * 只看状态决定要不要连，好让这条判断能脱离宿主单测。`stopping` 归入「不动」：
 * 用户刚点了停止，这时候连回去等于跟他抢。
 */
export function codexDesktopAccelerationDecision(state: AccelerationState): CodexDesktopAccelerationDecision {
  if (state.phase === 'active' || state.phase === 'connecting' || state.phase === 'stopping') {
    return 'already-connected'
  }
  if (state.phase === 'unavailable') return 'unavailable'
  if (state.phase === 'exhausted') return 'exhausted'
  if (state.remainingSeconds === null || state.remainingSeconds <= 0) return 'exhausted'
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
  // 连续点两次「打开」不能变成两次连接请求：第二次跟着第一次的结果走。
  let inFlight: Promise<CodexDesktopAccelerationOutcome> | null = null

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能反过来挡住打开。 */ }
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
      return { status: 'already-connected' }
    }
    if (decision === 'unavailable') {
      return skip('unavailable', '本机加速组件不可用，Codex 桌面端按未加速打开')
    }
    if (decision === 'exhausted') {
      return skip('exhausted', '当前账号的免费加速时长已用完，Codex 桌面端按未加速打开')
    }
    let connected: AccelerationState
    try { connected = await withTimeout(options.connect(scope), timeoutMs) }
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
    log('info', 'acceleration.codex-desktop.connected', '已为打开 Codex 桌面端自动连接加速，结束后请在加速页自行停止')
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
  }
}

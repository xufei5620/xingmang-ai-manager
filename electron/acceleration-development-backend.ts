import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { AccelerationApi, AccelerationConflictKind, AccelerationFailureReason, AccelerationLine, AccelerationRedemptionResult, AccelerationState } from './acceleration-contract'
import { accelerationBonusSeconds, accelerationConflictNotice, accelerationTrialSeconds, isAccelerationBonusCode } from './acceleration-contract'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'
import type { AccelerationDownloadRouteResult } from './download-acceleration'

export type AccelerationStopFailureStage = 'proxy-restore' | 'core-stop' | 'ledger-write'

/** Why a connect or a line probe never reached an active session. A closed set
 *  rather than the error text: the worker sends this to the main process, and
 *  an error raised down in the runtime or the native proxy helper can carry a
 *  private path or proxy detail (see I13 and the stop-side note below). */
export type AccelerationStartFailureStage =
  | 'core-architecture'
  | 'core-integrity'
  | 'core-launch'
  | 'core-storage'
  | 'line-unavailable'
  | 'runtime-invalid'
  | 'ledger-write'
  | 'proxy-authorization'
  | 'proxy-helper'
  | 'proxy-enable'
  | 'unknown'

/** Where the attempt was when it threw. The same message means different
 *  things on either side of `proxy.enable`, so the caller tracks this rather
 *  than the classifier guessing it back out of the text. */
export type AccelerationStartFailurePhase = 'runtime' | 'verify' | 'ledger' | 'proxy'

export interface AccelerationDevelopmentBackendOptions {
  /** Both sources use the local ledger, never a server-issued entitlement. */
  entitlementSource?: 'local-device' | 'local-development'
  runtime: {
    start(lineId?: string): Promise<{ line: AccelerationLine; proxyPort: number }>
    stop(): Promise<void>
    isRunning(): boolean
  }
  proxy: { enable(port: number): Promise<void>; restore(): Promise<void> }
  ledgerPath: string
  now?: () => number
  monotonicNow?: () => number
  schedule?: (callback: () => void, milliseconds: number) => () => void
  /** Credential-free line metadata supplied by the host/worker. */
  listLines?: () => Promise<AccelerationLine[]>
  /** Optional host-side latency probe. */
  pingLine?: (lineId: string) => Promise<AccelerationLine>
  /** Stage only: native errors can contain private proxy or configuration data. */
  onDiagnostic?: (stage: AccelerationStopFailureStage) => void
  /** Same constraint, for a failed connect or line probe. Until this existed,
   *  a failed start left no trace at all: it resolves with an error-carrying
   *  state instead of rejecting, so the IPC layer above logged it as a success. */
  onStartDiagnostic?: (stage: AccelerationStartFailureStage) => void
  /** Read-only look at who else holds the OS proxy before a connect touches it.
   *  Omitted by hosts that cannot inspect the platform, which keeps the start
   *  path exactly as it was before this check existed. */
  detectConflicts?: () => Promise<AccelerationConflictKind[]>
  /** Both the finding and what the user decided about it, one call per kind. */
  onConflictDiagnostic?: (kind: AccelerationConflictKind, ignored: boolean) => void
  /**
   * 一个正在加速的会话因为内核自己退出而结束了，已经先试过把网络设置改回去
   * （改没改成，由之后读到的状态说明）。不带任何原因或文本：宿主只需要知道
   * 「该去读一次状态、该告诉用户了」。两条路径都会走到这里——内核退出的回调，
   * 以及恰好先一步读状态时发现内核已经不在——所以宿主不必关心是谁先看到的。
   */
  onRuntimeInterrupted?: () => void
}

export interface AccelerationDevelopmentBackend extends AccelerationApi {
  /**
   * 下载专用线路：起内核、只交出本机回环端口，**不碰系统代理**，所以它既不
   * 出现在界面的加速状态里，也不需要用户点「连接」。按持有数计数，多个下载
   * 共用同一个内核（见 download-acceleration.ts）。
   */
  startDownloadRoute(scope: string): Promise<AccelerationDownloadRouteResult>
  stopDownloadRoute(): Promise<void>
  recover(): Promise<void>
  /**
   * 没有会话、没有下载线路、内核没在跑、网络设置也都还原完了：这时让辅助
   * 进程退出不会丢掉任何东西。排在队列里答，免得和正在进行的连接抢着判断。
   */
  isIdle(): Promise<boolean>
  notifyRuntimeExit(): Promise<void>
  /**
   * 电脑要睡了：冻结正在跑的会话的计时并撤掉到期定时器。刻意同步、不排队——
   * 系统留给「即将睡眠」的时间只有一两秒，排在一次十几秒的连接后面就赶不上了。
   */
  suspend(): void
  /**
   * 电脑醒了：把睡着的那段从计时里扣掉，再看加速还在不在。还在就按剩余时长
   * 重新定到期；不在了就走意外断开那条路（先还原网络设置，再报告）。
   */
  resume(): Promise<void>
  dispose(): Promise<void>
}

function assertLineId(lineId: unknown): asserts lineId is string {
  if (typeof lineId !== 'string' || !/^[a-z\d_.-]{1,80}$/i.test(lineId)) throw new Error('加速线路参数无效。')
}

interface AccountUsage { usedMs: number; startedAt: number | null; bonusRedeemed?: true }
// Older builds must reject the new format rather than silently erase a claim.
interface Ledger { version: 2; accounts: Record<string, AccountUsage> }
interface ParsedLedger { ledger: Ledger; needsRewrite: boolean }
interface Session {
  scope: string
  phase: 'connecting' | 'active' | 'stopping'
  line: AccelerationLine | null
  connectedAt: string | null
  startedMono: number | null
  stoppedMono: number | null
  /** 睡眠开始时的单调时刻；醒来后并进 pausedMs。 */
  pausedMono: number | null
  /** 已经扣掉的睡眠时长，不计入免费时长。 */
  pausedMs: number
  error: string | null
}

/**
 * 下载临时加速是否计入免费时长。按「不计入」：这次加速是软件为了把包下下来
 * 自己发起的，不是用户点的，把它算进那 20 分钟等于替用户花钱。额度本身仍然
 * 是门槛——用完的账号不再起临时线路——所以这不是一条无限免费的路。
 * 改成 true 即可按会话计费（届时 startDownloadRoute 要像 startAcceleration
 * 一样写 startedAt，stopDownloadRoute 要结算 usedMs）。
 */
export const downloadRouteBillsFreeAllowance = false

/**
 * 主程序没了、辅助进程还原网络设置一直失败时，下一次重试等多久。每轮要起
 * 两个 PowerShell，以前固定一秒一轮、永不停，一台还原不了的电脑会被它一直
 * 占着。第一次仍是一秒（多数失败只是锁被占着），之后翻倍，最多五分钟一轮。
 */
export function accelerationShutdownRetryDelayMs(failedAttempts: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, Math.min(failedAttempts - 1, 9)))
}

const baseTotalMs = accelerationTrialSeconds * 1000
function accountTotalMs(entry: AccountUsage): number {
  return baseTotalMs + (entry.bonusRedeemed ? accelerationBonusSeconds * 1000 : 0)
}
// Version 1 previously allowed one hour. Preserve that format's validation
// boundary while charging all historical use against the smaller allowance.
const legacyVersion1MaximumUsedMs = 3_600_000
const ledgerLabel = '本机免费加速时长账本'
const ledgerFailure = '本机测试时长无法读取或保存，请检查本地数据目录后重试。'
const startFailure = '加速连接失败，请检查线路和网络连接后重试。'
function connectionFailure(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'MACOS_PROXY_AUTHORIZATION') {
    return 'macOS 网络设置授权未完成，请允许系统授权后重试。'
  }
  return startFailure
}
const stopFailure = '加速尚未完全停止，正在保留恢复状态，请再次点击停止。'
const exitFailure = '加速意外断开了，网络已恢复正常，可以重新连接。'

function assertScope(scope: string) {
  if (!/^(?:xm-account|api-account):[1-9]\d{0,15}$/.test(scope)
    || !Number.isSafeInteger(Number(scope.split(':')[1]))) throw new Error('加速账号参数无效。')
}

function parseLedger(raw: string | null): ParsedLedger {
  if (raw === null) return { ledger: { version: 2, accounts: Object.create(null) }, needsRewrite: false }
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(ledgerFailure)
  const object = value as { version?: unknown; accounts?: Record<string, AccountUsage> }
  if ((object.version !== 1 && object.version !== 2) || !object.accounts || typeof object.accounts !== 'object' || Array.isArray(object.accounts)) throw new Error(ledgerFailure)
  const entries = Object.entries(object.accounts)
  if (entries.length > 2000) throw new Error(ledgerFailure)
  const accounts: Ledger['accounts'] = Object.create(null)
  const needsRewrite = object.version === 1
  for (const [scope, entry] of entries) {
    assertScope(scope)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(ledgerFailure)
    if (Object.prototype.hasOwnProperty.call(entry, 'bonusRedeemed') && (object.version === 1 || entry.bonusRedeemed !== true)) throw new Error(ledgerFailure)
    const maximumUsedMs = object.version === 1 ? legacyVersion1MaximumUsedMs : accountTotalMs(entry)
    if (!Number.isSafeInteger(entry.usedMs) || entry.usedMs < 0 || entry.usedMs > maximumUsedMs
      || (entry.startedAt !== null && (!Number.isSafeInteger(entry.startedAt) || entry.startedAt < 0 || entry.startedAt > 8_640_000_000_000_000))) throw new Error(ledgerFailure)
    accounts[scope] = {
      usedMs: Math.min(accountTotalMs(entry), entry.usedMs), startedAt: entry.startedAt,
      ...(entry.bonusRedeemed === true ? { bonusRedeemed: true } : {}),
    }
  }
  return { ledger: { version: 2, accounts }, needsRewrite }
}

/** Maps the authored failure messages this backend can observe onto the closed
 *  diagnostic set. Every branch matches a message written in this repository;
 *  anything else is reported as `unknown` rather than forwarded, because an
 *  unrecognised message is exactly the one that might not be ours. */
export function classifyAccelerationStartFailure(
  error: unknown,
  phase: AccelerationStartFailurePhase,
): AccelerationStartFailureStage {
  const message = error instanceof Error ? error.message : ''
  if (error instanceof Error && 'code' in error && error.code === 'MACOS_PROXY_AUTHORIZATION') return 'proxy-authorization'
  if (phase === 'proxy') return /系统代理组件不可用/.test(message) ? 'proxy-helper' : 'proxy-enable'
  if (phase === 'ledger') return 'ledger-write'
  if (phase === 'verify') return 'runtime-invalid'
  if (/架构/.test(message)) return 'core-architecture'
  if (/校验失败|Mach-O|不是可执行程序/.test(message)) return 'core-integrity'
  if (/内核启动失败|内核已退出|内核意外退出/.test(message)) return 'core-launch'
  if (/^暂无可用加速线路/.test(message)) return 'line-unavailable'
  if (/^加速(运行目录|内核|连接配置)/.test(message)) return 'core-storage'
  return 'unknown'
}

/** Maps the failures the worker can observe onto the closed reason set the host
 *  is allowed to receive. Same constraint as the start stages above: the worker
 *  is the only process that may see the underlying text, so what crosses the
 *  IPC boundary is one of these names and never the message itself (I13).
 *
 *  Order matters. The proxy-lock messages all start with 系统代理 too, and they
 *  mean something completely different from a failed restore: the helper could
 *  not even take the lock, which on a policy-restricted machine never recovers.
 */
export function classifyAccelerationWorkerFailure(error: unknown): AccelerationFailureReason {
  const message = error instanceof Error ? error.message : ''
  if (message === '另一实例正在使用系统代理，请先停止该实例的加速。') return 'proxy-owned'
  if (/系统代理(操作锁|正在由另一实例操作)/.test(message)) return 'proxy-locked'
  if (message === ledgerFailure) return 'local-data'
  if (/^(系统代理|Windows 系统代理|当前系统暂不支持此系统代理)/.test(message) || message === stopFailure) return 'proxy-restore'
  if (/^本机加速数据/.test(message)) return 'helper-data'
  if (/^(开发加速|开发数据目录)/.test(message)) return 'helper-launch'
  return 'unknown'
}

/** Device-local accounting only. This ledger is not a server-issued entitlement. */
export function createAccelerationDevelopmentBackend(options: AccelerationDevelopmentBackendOptions): AccelerationDevelopmentBackend {
  if (!path.isAbsolute(options.ledgerPath)) throw new Error('本机加速账本必须使用绝对路径。')
  const entitlementSource = options.entitlementSource ?? 'local-development'
  if (entitlementSource !== 'local-device' && entitlementSource !== 'local-development') throw new Error('本机加速时长来源无效。')
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const schedule = options.schedule ?? ((callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds)
    timer.unref()
    return () => clearTimeout(timer)
  })
  let ledger: Ledger | null = null
  let ledgerNeedsRewrite = false
  let needsRecovery = true
  let recoveryError: string | null = null
  let session: Session | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let cancelTimer: (() => void) | null = null
  let timerGeneration = 0
  let closing = false
  let disposed = false
  let probeNeedsCleanup = false
  // 下载专用线路：holders 是还在下载的数量，route 是它们共用的那个端口。
  let downloadHolders = 0
  let downloadRoute: { port: number; line: AccelerationLine } | null = null
  const lastErrors = new Map<string, string>()
  const lastConflicts = new Map<string, AccelerationConflictKind[]>()
  const lastSessionSeconds = new Map<string, number>()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }
  function usage(scope: string): AccountUsage { return ledger?.accounts[scope] ?? { usedMs: 0, startedAt: null } }
  function elapsed(current: Session): number {
    if (current.startedMono === null) return 0
    const end = current.stoppedMono ?? current.pausedMono ?? monotonicNow()
    return Math.max(0, Math.floor(end - current.startedMono - current.pausedMs))
  }
  /**
   * 睡眠那段一律不计时，不管单调钟在睡眠里走不走：Windows 的单调钟跨睡眠照走，
   * macOS 的停表，而「从睡前那一刻到醒来这一刻」按单调钟量出来的差，在两边都
   * 恰好是需要扣掉的那段（macOS 上差不多是零，因为表本来就停着）。
   */
  function foldPause(current: Session) {
    if (current.pausedMono === null) return
    current.pausedMs += Math.max(0, monotonicNow() - current.pausedMono)
    current.pausedMono = null
  }
  function crashElapsed(startedAt: number, totalMs: number): number {
    const difference = Math.floor(now() - startedAt)
    // A clock rollback cannot mint another trial after an unclean shutdown.
    return difference < 0 ? totalMs : Math.min(totalMs, difference)
  }
  async function save(next: Ledger) {
    try {
      if (Object.keys(next.accounts).length > 2000) throw new Error(ledgerFailure)
      ensureSafeDataDirectory(path.dirname(options.ledgerPath), ledgerLabel)
      await writeAtomicSafeUtf8File(options.ledgerPath, `${JSON.stringify(next)}\n`, ledgerLabel)
      ledger = next
    } catch { throw new Error(ledgerFailure) }
  }
  async function saveAccount(scope: string, entry: AccountUsage) {
    await save({ version: 2, accounts: { ...ledger!.accounts, [scope]: { ...usage(scope), ...entry } } })
  }
  async function load() {
    if (ledger) return
    try {
      const parsed = parseLedger(await readSafeUtf8File(options.ledgerPath, ledgerLabel, 256 * 1024))
      ledger = parsed.ledger
      ledgerNeedsRewrite = parsed.needsRewrite
    }
    catch { throw new Error(ledgerFailure) }
  }
  async function recover() {
    try { await load() } catch {
      // A corrupt allowance must fail closed, but it must not prevent restoring
      // a stale OS proxy or cleaning up an already-running development core.
      try {
        await options.proxy.restore()
        if (options.runtime.isRunning()) await options.runtime.stop()
        if (options.runtime.isRunning()) throw new Error(stopFailure)
      } catch { recoveryError = stopFailure; throw new Error(stopFailure) }
      throw new Error(ledgerFailure)
    }
    if (!needsRecovery) return
    try {
      await options.proxy.restore()
      if (options.runtime.isRunning()) await options.runtime.stop()
      if (options.runtime.isRunning()) throw new Error(stopFailure)
      const accounts: Ledger['accounts'] = { ...ledger!.accounts }
      let changed = ledgerNeedsRewrite
      for (const [scope, entry] of Object.entries(accounts)) {
        if (entry.startedAt !== null) {
          const totalMs = accountTotalMs(entry)
          accounts[scope] = { ...entry, usedMs: Math.min(totalMs, entry.usedMs + crashElapsed(entry.startedAt, totalMs)), startedAt: null }
          changed = true
        }
      }
      if (changed) await save({ version: 2, accounts })
      ledgerNeedsRewrite = false
      needsRecovery = false
      recoveryError = null
    } catch {
      recoveryError = stopFailure
      throw new Error(stopFailure)
    }
  }
  function state(scope: string): AccelerationState {
    const current = session?.scope === scope ? session : null
    const entry = usage(scope)
    const totalMs = accountTotalMs(entry)
    const totalSeconds = totalMs / 1000
    const spent = current ? elapsed(current) : needsRecovery && entry.startedAt !== null ? crashElapsed(entry.startedAt, totalMs) : 0
    const remainingMs = Math.max(0, totalMs - entry.usedMs - spent)
    const error = current?.error ?? recoveryError ?? lastErrors.get(scope) ?? null
    const conflicts = current ? [] : lastConflicts.get(scope) ?? []
    const pendingRecovery = needsRecovery && entry.startedAt !== null
    const phase = current ? current.phase === 'active' && remainingMs === 0 ? 'stopping' : current.phase
      : pendingRecovery ? 'stopping' : remainingMs === 0 ? 'exhausted' : error ? 'error' : 'idle'
    const result: AccelerationState = {
      scope, phase, mode: 'system-proxy', totalSeconds,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      sessionSeconds: current ? Math.min(totalSeconds, Math.floor(spent / 1000)) : lastSessionSeconds.get(scope) ?? 0,
      measuredAt: new Date(now()).toISOString(),
      connectedAt: current?.connectedAt ?? (pendingRecovery ? new Date(entry.startedAt!).toISOString() : null),
      line: current?.line ?? null, error,
      entitlementSource, supportedModes: ['system-proxy'],
      ...(conflicts.length ? { conflicts } : {}),
    }
    return result
  }
  function clearTimer() { timerGeneration += 1; cancelTimer?.(); cancelTimer = null }
  async function stopStage<T>(stage: AccelerationStopFailureStage, operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) {
      try { options.onDiagnostic?.(stage) } catch { /* Reporting must not change recovery behavior. */ }
      throw error
    }
  }
  function reportRuntimeInterrupted() {
    try { options.onRuntimeInterrupted?.() }
    catch { /* Reporting must not change recovery behavior. */ }
  }
  function reportStartFailure(error: unknown, phase: AccelerationStartFailurePhase) {
    try { options.onStartDiagnostic?.(classifyAccelerationStartFailure(error, phase)) }
    catch { /* Reporting must not change recovery behavior. */ }
  }
  /** Runs before any OS state is touched, so a refused start costs no time and
   *  leaves nothing to undo. A detector that cannot read the platform reports
   *  nothing, which is the pre-check behavior. */
  async function detectConflicts(scope: string, ignore: boolean): Promise<boolean> {
    if (!options.detectConflicts) return false
    let conflicts: AccelerationConflictKind[] = []
    try { conflicts = await options.detectConflicts() }
    catch { return false }
    lastConflicts.delete(scope)
    if (!conflicts.length) return false
    for (const kind of conflicts) {
      try { options.onConflictDiagnostic?.(kind, ignore) }
      catch { /* Reporting must not change what the user asked for. */ }
    }
    if (ignore) return false
    lastConflicts.set(scope, conflicts)
    lastErrors.set(scope, accelerationConflictNotice)
    return true
  }
  function arm(milliseconds: number) {
    clearTimer()
    const scheduledSession = session
    const generation = timerGeneration
    cancelTimer = schedule(() => {
      if (generation !== timerGeneration) return
      cancelTimer = null
      void enqueue(async () => {
        // An old expiry can queue while a redemption awaits atomic persistence.
        // Its callback must not stop the same session after the timer is extended.
        if (generation !== timerGeneration || !session || session !== scheduledSession || disposed) return
        try { await stopSession() } catch { arm(5000) }
      }).catch(() => undefined)
    }, Math.max(1, Math.ceil(milliseconds)))
  }
  /**
   * 停内核。下载专用线路还有人握着时留着它：一次游戏加速的结束并不代表那边
   * 的下载也结束了，端口一没就是下到一半的包断在那里。
   */
  function stopCore(): Promise<void> {
    return stopStage('core-stop', async () => {
      if (downloadHolders > 0 && downloadRoute) return
      // A previous stop can exit the process yet fail to remove its private
      // config. Retry the idempotent cleanup even when isRunning is false.
      await options.runtime.stop()
      if (options.runtime.isRunning()) throw new Error(stopFailure)
    })
  }
  async function stopSession() {
    if (!session) {
      if (probeNeedsCleanup) {
        await stopCore()
        probeNeedsCleanup = false
      }
      return
    }
    clearTimer()
    const current = session
    current.phase = 'stopping'
    try {
      foldPause(current)
      if (current.stoppedMono === null) {
        // Keep the core alive until proxy restoration succeeds. Otherwise an
        // incomplete restore could leave every proxied app pointing at a dead port.
        await stopStage('proxy-restore', () => options.proxy.restore())
        await stopCore()
        current.stoppedMono = monotonicNow()
      }
      const spent = elapsed(current)
      const totalMs = accountTotalMs(usage(current.scope))
      await stopStage('ledger-write', () => saveAccount(current.scope,
        { usedMs: Math.min(totalMs, usage(current.scope).usedMs + spent), startedAt: null }))
      lastSessionSeconds.set(current.scope, Math.min(totalMs / 1000, Math.floor(spent / 1000)))
      lastErrors.delete(current.scope)
      lastConflicts.delete(current.scope)
      session = null
    } catch {
      current.error = stopFailure
      throw new Error(stopFailure)
    }
  }
  /**
   * 还挂着「睡眠中」的会话在这里醒过来。不只 resume 会调：万一系统没送来醒来
   * 事件，任何一次读状态（托盘、加速页轮询、到期提醒）都会把它叫醒，免得一个
   * 永远冻结的计时变成不限时的免费加速。
   */
  function wakeSession() {
    const current = session
    if (!current || current.pausedMono === null) return
    foldPause(current)
    if (current.phase !== 'active' || !options.runtime.isRunning()) return
    const entry = usage(current.scope)
    arm(accountTotalMs(entry) - entry.usedMs - elapsed(current))
  }
  async function inspect(scope: string) {
    try { await recover() } catch {
      if (!ledger) throw new Error(ledgerFailure)
      return state(scope)
    }
    wakeSession()
    if (session && (session.phase === 'active' && !options.runtime.isRunning()
      || usage(session.scope).usedMs + elapsed(session) >= accountTotalMs(usage(session.scope)))) {
      const oldScope = session.scope
      const exited = !options.runtime.isRunning()
      try {
        await stopSession()
        if (exited) lastErrors.set(oldScope, exitFailure)
      } catch { arm(5000) }
      if (exited) reportRuntimeInterrupted()
    }
    return state(scope)
  }

  return {
    getAccelerationState(scope) {
      assertScope(scope)
      return enqueue(() => inspect(scope))
    },
    isIdle() {
      return enqueue(async () => !closing && !disposed && !needsRecovery && recoveryError === null
        && !session && cancelTimer === null && !probeNeedsCleanup
        && downloadHolders === 0 && !downloadRoute && !options.runtime.isRunning())
    },
    redeemAccelerationCode(scope, code): Promise<AccelerationRedemptionResult> {
      assertScope(scope)
      return enqueue(async () => {
        if (closing || disposed) throw new Error('本机加速服务正在关闭。')
        await recover()
        // Settle a session that expired while the machine slept against its old
        // allowance before adding credit; redemption never restarts its network.
        await inspect(scope)
        if (!isAccelerationBonusCode(code)) return { status: 'invalid-code', addedSeconds: 0, state: state(scope) }
        const entry = usage(scope)
        if (entry.bonusRedeemed) return { status: 'already-redeemed', addedSeconds: 0, state: state(scope) }
        // Publish the mark and allowance together only after the atomic write.
        // Failed writes leave both the in-memory balance and expiry untouched.
        await saveAccount(scope, { ...entry, bonusRedeemed: true })
        if (session?.scope === scope && session.phase === 'active' && options.runtime.isRunning()) {
          arm(accountTotalMs(usage(scope)) - usage(scope).usedMs - elapsed(session))
        }
        return { status: 'redeemed', addedSeconds: accelerationBonusSeconds, state: state(scope) }
      })
    },
    startAcceleration(scope, mode, lineId, ignoreConflicts) {
      assertScope(scope)
      if (lineId !== undefined) assertLineId(lineId)
      if (ignoreConflicts !== undefined && typeof ignoreConflicts !== 'boolean') throw new Error('加速冲突确认参数无效。')
      return enqueue(async () => {
        if (closing || disposed) throw new Error('本机加速服务正在关闭。')
        if (mode !== 'system-proxy') throw new Error('本机开发加速暂不支持 TUN，请关闭 TUN 后重试。')
        try { await recover() } catch { if (!ledger) throw new Error(ledgerFailure); return state(scope) }
        if (probeNeedsCleanup) await stopSession()
        if (session) {
          if (session.scope === scope && session.phase === 'active' && options.runtime.isRunning()) return state(scope)
          try { await stopSession() } catch { throw new Error(stopFailure) }
        }
        lastErrors.delete(scope)
        lastConflicts.delete(scope)
        if (usage(scope).usedMs >= accountTotalMs(usage(scope))) return state(scope)
        if (await detectConflicts(scope, ignoreConflicts === true)) return state(scope)
        // 下载专用线路已经把内核跑起来了：同一条线路直接接管，不重起内核，
        // 正在进行的下载因此不会断在半路。用户点名了另一条线路才必须重起。
        let adopted: { port: number; line: AccelerationLine } | null = null
        if (downloadRoute && options.runtime.isRunning() && (!lineId || lineId === downloadRoute.line.id)) {
          adopted = downloadRoute
        } else if (downloadRoute) {
          downloadRoute = null
          downloadHolders = 0
          try { await options.runtime.stop() } catch { /* 下面的 start 会把失败重新报出来。 */ }
        }
        // Persist intent before touching OS state. A crash in the startup gap
        // is conservatively billed; an ordinary failed start clears it unpaid.
        try { await saveAccount(scope, { usedMs: usage(scope).usedMs, startedAt: now() }) }
        catch (error) { reportStartFailure(error, 'ledger'); lastErrors.set(scope, ledgerFailure); return state(scope) }
        session = { scope, phase: 'connecting', line: null, connectedAt: null, startedMono: null, stoppedMono: null, pausedMono: null, pausedMs: 0, error: null }
        // The user-facing text below collapses every cause into one sentence on
        // purpose. `phase` is what survives that collapse for the log.
        let phase: AccelerationStartFailurePhase = 'runtime'
        try {
          const result = adopted ? { line: adopted.line, proxyPort: adopted.port } : await options.runtime.start(lineId)
          phase = 'verify'
          if (!Number.isInteger(result.proxyPort) || result.proxyPort < 1 || result.proxyPort > 65535 || !options.runtime.isRunning()) throw new Error(startFailure)
          session.line = { id: result.line.id, name: result.line.name, region: result.line.region, latencyMs: result.line.latencyMs }
          phase = 'proxy'
          await options.proxy.enable(result.proxyPort)
          phase = 'verify'
          if (!options.runtime.isRunning()) throw new Error(startFailure)
          session.startedMono = monotonicNow()
          const startedAt = now()
          session.connectedAt = new Date(startedAt).toISOString()
          phase = 'ledger'
          await saveAccount(scope, { usedMs: usage(scope).usedMs, startedAt })
          session.phase = 'active'
          arm(accountTotalMs(usage(scope)) - usage(scope).usedMs - elapsed(session))
          return state(scope)
        } catch (error) {
          reportStartFailure(error, phase)
          try { await stopSession(); lastErrors.set(scope, connectionFailure(error)) }
          catch { arm(5000) }
          return state(scope)
        }
      })
    },
    listAccelerationLines(scope) {
      assertScope(scope)
      return enqueue(async () => {
        try { await recover() } catch { return [] }
        const lines = options.listLines ? await options.listLines() : []
        return lines.map((line) => ({ id: line.id, name: line.name, region: line.region, latencyMs: line.latencyMs }))
      })
    },
    pingAccelerationLine(scope, lineId) {
      assertScope(scope)
      assertLineId(lineId)
      return enqueue(async () => {
        if (closing || disposed) throw new Error('本机加速服务正在关闭。')
        try { await recover() } catch { throw new Error(ledgerFailure) }
        if (session) throw new Error('加速连接进行中，暂不能检测线路。')
        // 探测要独占内核，而下载专用线路正握着它。此时重起内核会把下载打断。
        if (downloadRoute) throw new Error('正在下载安装包，暂不能检测线路。')
        if (probeNeedsCleanup) await stopSession()
        const lines = options.listLines ? await options.listLines() : []
        const line = lines.find((candidate) => candidate.id === lineId)
        if (!line) throw new Error('加速线路不存在。')
        if (options.pingLine) {
          probeNeedsCleanup = true
          // A probe may fail after spawning the temporary core. Cleanup belongs
          // to this serialized owner and remains retryable by stop/dispose.
          try { return await options.pingLine(lineId) }
          // A probe starts the core the same way a connect does, so it fails
          // for the same reasons and is worth the same log line.
          catch (error) { reportStartFailure(error, 'runtime'); throw error }
          finally { await stopSession() }
        }
        // A host may omit active probing (for example in fixture mode). Keep
        // the existing latency value instead of fabricating a measurement.
        return { ...line }
      })
    },
    stopAcceleration(scope) {
      assertScope(scope)
      return enqueue(async () => {
        try { await recover() } catch { if (!ledger) throw new Error(ledgerFailure); return state(scope) }
        if (session?.scope === scope) {
          try { await stopSession() } catch { arm(5000) }
        } else {
          if (probeNeedsCleanup) await stopSession()
          lastErrors.delete(scope)
          lastConflicts.delete(scope)
        }
        return state(scope)
      })
    },
    startDownloadRoute(scope) {
      assertScope(scope)
      return enqueue(async (): Promise<AccelerationDownloadRouteResult> => {
        if (closing || disposed) return { status: 'unavailable' }
        try { await recover() } catch { return { status: 'unavailable' } }
        // 用户自己开着加速：系统代理已经指向内核，下载跟着走就行，别插手。
        if (session) return options.runtime.isRunning() ? { status: 'system-proxy-active' } : { status: 'unavailable' }
        if (downloadRoute && options.runtime.isRunning()) {
          downloadHolders += 1
          return { status: 'ready', port: downloadRoute.port }
        }
        // 内核已经不在了，记录也就作废，别让后来的 stop 去减一个不存在的持有。
        downloadRoute = null
        downloadHolders = 0
        try { if (probeNeedsCleanup) await stopSession() } catch { return { status: 'unavailable' } }
        // 下载不计费（见 downloadRouteBillsFreeAllowance），但额度仍是门槛：
        // 用完的账号不再起临时线路，免得这里变成一条绕开时长的免费通道。
        if (usage(scope).usedMs >= accountTotalMs(usage(scope))) return { status: 'unavailable' }
        try {
          const result = await options.runtime.start()
          if (!Number.isInteger(result.proxyPort) || result.proxyPort < 1 || result.proxyPort > 65_535
            || !options.runtime.isRunning()) throw new Error(startFailure)
          downloadRoute = { port: result.proxyPort, line: result.line }
          downloadHolders = 1
          return { status: 'ready', port: result.proxyPort }
        } catch (error) {
          // 失败照样进日志：这条路用户点不到，不记就完全看不见。
          reportStartFailure(error, 'runtime')
          downloadRoute = null
          downloadHolders = 0
          // 起了一半的内核必须收掉，否则端口留在机器上没人管。
          try { await options.runtime.stop() } catch { /* 停不掉就交给下一次 start / dispose。 */ }
          return { status: 'unavailable' }
        }
      })
    },
    stopDownloadRoute() {
      return enqueue(async () => {
        if (downloadHolders > 0) downloadHolders -= 1
        if (downloadHolders > 0 || !downloadRoute) return
        downloadRoute = null
        // 下载期间用户自己开了加速：内核已经归那个会话所有，不能在这里停。
        if (session) return
        try { await options.runtime.stop() }
        catch { /* 下一次 start / stop / dispose 会再清一次；下载不该因此报错。 */ }
      })
    },
    recover: () => enqueue(recover),
    notifyRuntimeExit: () => enqueue(async () => {
      if (options.runtime.isRunning()) return
      // 内核没了，下载线路的端口也就没了。记录必须跟着作废。
      downloadRoute = null
      downloadHolders = 0
      if (!session || disposed) return
      const scope = session.scope
      try { await stopSession(); lastErrors.set(scope, exitFailure) }
      catch { arm(5000); throw new Error(stopFailure) }
      finally { reportRuntimeInterrupted() }
    }),
    suspend() {
      if (disposed || !session || session.phase !== 'active' || session.pausedMono !== null) return
      // 睡着时不该有任何到期在走：macOS 上跨睡眠的定时器会晚响整整一觉，
      // Windows 上则会一醒来就把睡眠算成用掉的时长。醒来后按剩余时长重新定。
      clearTimer()
      session.pausedMono = monotonicNow()
    },
    // 醒来后的检查就是一次读状态：先把睡眠扣掉、按剩余时长重新定到期，再由
    // inspect 看内核还在不在——不在了就与内核意外退出同一条路，先还原网络设置
    // 再报告；时长恰好在睡前用完的也在这里停掉。
    resume: () => enqueue(async () => {
      if (disposed || !session) return
      await inspect(session.scope)
    }),
    dispose() {
      closing = true
      return enqueue(async () => {
        if (disposed) return
        await recover()
        // 退出时下载线路没有豁免：内核必须停干净，端口不能留在机器上。
        downloadHolders = 0
        downloadRoute = null
        try { await stopSession() } catch { arm(5000); throw new Error(stopFailure) }
        if (options.runtime.isRunning()) {
          try {
            await options.runtime.stop()
            if (options.runtime.isRunning()) throw new Error(stopFailure)
          } catch { arm(5000); throw new Error(stopFailure) }
        }
        clearTimer()
        disposed = true
      })
    },
  }
}

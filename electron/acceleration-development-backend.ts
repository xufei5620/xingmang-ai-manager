import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { AccelerationApi, AccelerationLine, AccelerationRedemptionResult, AccelerationState } from './acceleration-contract'
import { accelerationBonusSeconds, accelerationTrialSeconds, isAccelerationBonusCode } from './acceleration-contract'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

export type AccelerationStopFailureStage = 'proxy-restore' | 'core-stop' | 'ledger-write'

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
}

export interface AccelerationDevelopmentBackend extends AccelerationApi {
  recover(): Promise<void>
  notifyRuntimeExit(): Promise<void>
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
  error: string | null
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
const exitFailure = '加速服务意外退出，原网络设置已恢复，请重新开始加速。'

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
  const lastErrors = new Map<string, string>()
  const lastSessionSeconds = new Map<string, number>()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }
  function usage(scope: string): AccountUsage { return ledger?.accounts[scope] ?? { usedMs: 0, startedAt: null } }
  function elapsed(current: Session): number {
    return current.startedMono === null ? 0 : Math.max(0, Math.floor((current.stoppedMono ?? monotonicNow()) - current.startedMono))
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
  async function stopSession() {
    if (!session) {
      if (probeNeedsCleanup) {
        await stopStage('core-stop', async () => {
          await options.runtime.stop()
          if (options.runtime.isRunning()) throw new Error(stopFailure)
        })
        probeNeedsCleanup = false
      }
      return
    }
    clearTimer()
    const current = session
    current.phase = 'stopping'
    try {
      if (current.stoppedMono === null) {
        // Keep the core alive until proxy restoration succeeds. Otherwise an
        // incomplete restore could leave every proxied app pointing at a dead port.
        await stopStage('proxy-restore', () => options.proxy.restore())
        await stopStage('core-stop', async () => {
          // A previous stop can exit the process yet fail to remove its private
          // config. Retry the idempotent cleanup even when isRunning is false.
          await options.runtime.stop()
          if (options.runtime.isRunning()) throw new Error(stopFailure)
        })
        current.stoppedMono = monotonicNow()
      }
      const spent = elapsed(current)
      const totalMs = accountTotalMs(usage(current.scope))
      await stopStage('ledger-write', () => saveAccount(current.scope,
        { usedMs: Math.min(totalMs, usage(current.scope).usedMs + spent), startedAt: null }))
      lastSessionSeconds.set(current.scope, Math.min(totalMs / 1000, Math.floor(spent / 1000)))
      lastErrors.delete(current.scope)
      session = null
    } catch {
      current.error = stopFailure
      throw new Error(stopFailure)
    }
  }
  async function inspect(scope: string) {
    try { await recover() } catch {
      if (!ledger) throw new Error(ledgerFailure)
      return state(scope)
    }
    if (session && (session.phase === 'active' && !options.runtime.isRunning()
      || usage(session.scope).usedMs + elapsed(session) >= accountTotalMs(usage(session.scope)))) {
      const oldScope = session.scope
      const exited = !options.runtime.isRunning()
      try {
        await stopSession()
        if (exited) lastErrors.set(oldScope, exitFailure)
      } catch { arm(5000) }
    }
    return state(scope)
  }

  return {
    getAccelerationState(scope) {
      assertScope(scope)
      return enqueue(() => inspect(scope))
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
    startAcceleration(scope, mode, lineId) {
      assertScope(scope)
      if (lineId !== undefined) assertLineId(lineId)
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
        if (usage(scope).usedMs >= accountTotalMs(usage(scope))) return state(scope)
        // Persist intent before touching OS state. A crash in the startup gap
        // is conservatively billed; an ordinary failed start clears it unpaid.
        try { await saveAccount(scope, { usedMs: usage(scope).usedMs, startedAt: now() }) }
        catch { lastErrors.set(scope, ledgerFailure); return state(scope) }
        session = { scope, phase: 'connecting', line: null, connectedAt: null, startedMono: null, stoppedMono: null, error: null }
        try {
          const result = await options.runtime.start(lineId)
          if (!Number.isInteger(result.proxyPort) || result.proxyPort < 1 || result.proxyPort > 65535 || !options.runtime.isRunning()) throw new Error(startFailure)
          session.line = { id: result.line.id, name: result.line.name, region: result.line.region, latencyMs: result.line.latencyMs }
          await options.proxy.enable(result.proxyPort)
          if (!options.runtime.isRunning()) throw new Error(startFailure)
          session.startedMono = monotonicNow()
          const startedAt = now()
          session.connectedAt = new Date(startedAt).toISOString()
          await saveAccount(scope, { usedMs: usage(scope).usedMs, startedAt })
          session.phase = 'active'
          arm(accountTotalMs(usage(scope)) - usage(scope).usedMs - elapsed(session))
          return state(scope)
        } catch (error) {
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
        if (probeNeedsCleanup) await stopSession()
        const lines = options.listLines ? await options.listLines() : []
        const line = lines.find((candidate) => candidate.id === lineId)
        if (!line) throw new Error('加速线路不存在。')
        if (options.pingLine) {
          probeNeedsCleanup = true
          // A probe may fail after spawning the temporary core. Cleanup belongs
          // to this serialized owner and remains retryable by stop/dispose.
          try { return await options.pingLine(lineId) }
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
        }
        return state(scope)
      })
    },
    recover: () => enqueue(recover),
    notifyRuntimeExit: () => enqueue(async () => {
      if (!session || disposed || options.runtime.isRunning()) return
      const scope = session.scope
      try { await stopSession(); lastErrors.set(scope, exitFailure) }
      catch { arm(5000); throw new Error(stopFailure) }
    }),
    dispose() {
      closing = true
      return enqueue(async () => {
        if (disposed) return
        await recover()
        try { await stopSession() } catch { arm(5000); throw new Error(stopFailure) }
        clearTimer()
        disposed = true
      })
    },
  }
}

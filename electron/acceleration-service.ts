import type { AccelerationApi, AccelerationConflictKind, AccelerationLine, AccelerationMode, AccelerationPhase, AccelerationRedemptionResult, AccelerationState } from './acceleration-contract'
import { accelerationBonusSeconds, accelerationConflictKinds, accelerationTrialSeconds, isAccelerationConflictKind } from './acceleration-contract'

export interface AccelerationService extends AccelerationApi {
  redeemAccelerationCode(scope: string, code: string): Promise<AccelerationRedemptionResult>
  /** Host lifecycle barrier; also drains sessions whose account has already expired. */
  stopAll(): Promise<void>
  onAccountChanged(): Promise<void>
  dispose(): Promise<void>
}

interface AccelerationServiceOptions {
  getAccountScope: () => string | null
  backend?: AccelerationApi
}

const SERVICE_UNAVAILABLE = '加速线路暂未开通，请稍后再试。'
const INVALID_RESPONSE = '加速服务返回的数据无效，请稍后重试。'
const BACKEND_FAILURE = '加速服务暂不可用，请稍后重试。'
const ACCOUNT_CHANGED = '账号已变更，请重新打开游戏加速。'
const phases: readonly AccelerationPhase[] = ['unavailable', 'idle', 'connecting', 'active', 'stopping', 'exhausted', 'error']

function assertScope(scope: unknown): asserts scope is string {
  if (typeof scope !== 'string' || !/^(?:xm-account|api-account):[1-9]\d{0,15}$/.test(scope)
    || !Number.isSafeInteger(Number(scope.split(':')[1]))) {
    throw new Error('加速账号参数无效。')
  }
}

function assertMode(mode: unknown): asserts mode is AccelerationMode {
  if (mode !== 'system-proxy' && mode !== 'tun') throw new Error('加速模式无效。')
}

function assertIgnoreConflicts(value: unknown): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') throw new Error('加速冲突确认参数无效。')
}

function assertLineId(lineId: unknown): asserts lineId is string {
  if (typeof lineId !== 'string' || !/^[a-z\d_.-]{1,80}$/i.test(lineId)) throw new Error('加速线路参数无效。')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000
}

function isPhase(value: unknown): value is AccelerationPhase {
  return typeof value === 'string' && phases.some((phase) => phase === value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function isDisplayText(value: unknown, maximumLength = 100): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f-\u009f]|:\/\/|\bsk-|\bbearer\s|(?:token|password|secret|key)\s*[:=]/i.test(value)
}

function isRunning(phase: AccelerationPhase): boolean {
  return phase === 'active' || phase === 'connecting' || phase === 'stopping'
}

function projectLine(value: unknown): AccelerationLine {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-z\d_.-]{1,80}$/i.test(value.id)
    || !isDisplayText(value.id) || !isDisplayText(value.name) || !isDisplayText(value.region)
    || (value.latencyMs !== null && (typeof value.latencyMs !== 'number' || !Number.isFinite(value.latencyMs)
      || value.latencyMs < 0 || value.latencyMs > 60_000))) throw new Error(INVALID_RESPONSE)
  return { id: value.id, name: value.name, region: value.region, latencyMs: value.latencyMs as number | null }
}

function projectLines(value: unknown): AccelerationLine[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error(INVALID_RESPONSE)
  const lines = value.map(projectLine)
  if (new Set(lines.map((line) => line.id)).size !== lines.length) throw new Error(INVALID_RESPONSE)
  return lines
}

/** Only allow display data across IPC; transport credentials must stay inside the backend. */
function projectState(value: unknown, scope: string): AccelerationState {
  if (!isRecord(value) || value.scope !== scope || !isPhase(value.phase)
    || (value.mode !== 'system-proxy' && value.mode !== 'tun')
    || !isSeconds(value.totalSeconds) || !isSeconds(value.sessionSeconds)
    || value.sessionSeconds > value.totalSeconds
    || (value.remainingSeconds !== null && (!isSeconds(value.remainingSeconds) || value.remainingSeconds > value.totalSeconds))
    || !isTimestamp(value.measuredAt) || (value.connectedAt !== null && !isTimestamp(value.connectedAt))
    || (value.error !== null && !isDisplayText(value.error, 300))) throw new Error(INVALID_RESPONSE)

  const phase = value.phase
  if (value.entitlementSource !== undefined && value.entitlementSource !== 'server'
    && value.entitlementSource !== 'local-device' && value.entitlementSource !== 'local-development') throw new Error(INVALID_RESPONSE)
  if (value.supportedModes !== undefined && (!Array.isArray(value.supportedModes) || !value.supportedModes.length
    || value.supportedModes.length > 2 || new Set(value.supportedModes).size !== value.supportedModes.length
    || value.supportedModes.some((mode) => mode !== 'system-proxy' && mode !== 'tun'))) throw new Error(INVALID_RESPONSE)
  if (phase === 'active' && (value.connectedAt === null || value.remainingSeconds === null || value.remainingSeconds === 0)) {
    throw new Error(INVALID_RESPONSE)
  }
  if (phase === 'exhausted' && value.remainingSeconds !== 0) throw new Error(INVALID_RESPONSE)
  if (value.conflicts !== undefined && (!Array.isArray(value.conflicts) || !value.conflicts.length
    || value.conflicts.length > accelerationConflictKinds.length || new Set(value.conflicts).size !== value.conflicts.length
    || !value.conflicts.every(isAccelerationConflictKind))) throw new Error(INVALID_RESPONSE)
  let line: AccelerationState['line'] = null
  if (value.line !== null) {
    if (!isRecord(value.line) || typeof value.line.id !== 'string' || !/^[a-z\d_.-]{1,80}$/i.test(value.line.id)
      || !isDisplayText(value.line.id) || !isDisplayText(value.line.name) || !isDisplayText(value.line.region)
      || (value.line.latencyMs !== null && (typeof value.line.latencyMs !== 'number'
        || !Number.isFinite(value.line.latencyMs) || value.line.latencyMs < 0 || value.line.latencyMs > 60_000))) {
      throw new Error(INVALID_RESPONSE)
    }
    line = { id: value.line.id, name: value.line.name, region: value.line.region, latencyMs: value.line.latencyMs }
  }
  return {
    ...(value.entitlementSource === 'server' || value.entitlementSource === 'local-device' || value.entitlementSource === 'local-development' ? { entitlementSource: value.entitlementSource } : {}),
    ...(Array.isArray(value.supportedModes) ? { supportedModes: [...value.supportedModes] as AccelerationMode[] } : {}),
    ...(Array.isArray(value.conflicts) ? { conflicts: [...value.conflicts] as AccelerationConflictKind[] } : {}),
    scope, phase, mode: value.mode, totalSeconds: value.totalSeconds, remainingSeconds: value.remainingSeconds,
    sessionSeconds: value.sessionSeconds, measuredAt: value.measuredAt, connectedAt: value.connectedAt, line, error: value.error,
  }
}

function unavailableState(scope: string): AccelerationState {
  return {
    scope, phase: 'unavailable', mode: 'system-proxy', totalSeconds: accelerationTrialSeconds, remainingSeconds: null,
    sessionSeconds: 0, measuredAt: new Date().toISOString(), connectedAt: null, line: null, error: null,
  }
}

function projectRedemption(value: unknown, scope: string): AccelerationRedemptionResult {
  if (!isRecord(value) || typeof value.status !== 'string' || !['redeemed', 'already-redeemed', 'invalid-code'].includes(value.status)
    || value.addedSeconds !== (value.status === 'redeemed' ? accelerationBonusSeconds : 0)) throw new Error(INVALID_RESPONSE)
  const state = projectState(value.state, scope)
  if (value.status === 'redeemed' && (state.remainingSeconds === null || state.totalSeconds < accelerationBonusSeconds)) {
    throw new Error(INVALID_RESPONSE)
  }
  return { status: value.status as AccelerationRedemptionResult['status'], addedSeconds: value.addedSeconds as number, state }
}

export function createAccelerationService(options: AccelerationServiceOptions): AccelerationService {
  const { backend } = options
  // Track a start before awaiting it: a failed/late response does not prove the tunnel never started.
  const possibleSessions = new Set<string>()
  let queue: Promise<unknown> = Promise.resolve()
  let lastMutation: { key: string; promise: Promise<AccelerationState> } | null = null
  let revision = 0
  let disposed = false
  let disposePromise: Promise<void> | null = null

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  function assertCurrent(scope: string, expectedRevision: number): void {
    if (disposed) throw new Error('游戏加速服务已关闭。')
    if (options.getAccountScope() !== scope || expectedRevision !== revision) throw new Error(ACCOUNT_CHANGED)
  }

  function track(state: AccelerationState): void {
    if (isRunning(state.phase)) possibleSessions.add(state.scope)
    else possibleSessions.delete(state.scope)
  }

  async function stopSession(scope: string): Promise<void> {
    if (!backend) return
    try {
      const state = projectState(await backend.stopAcceleration(scope), scope)
      if (isRunning(state.phase)) throw new Error(BACKEND_FAILURE)
      possibleSessions.delete(scope)
    } catch {
      // Retain failed stops so a later account change/dispose retries instead of forgetting a live tunnel.
      throw new Error('停止加速未完成，请稍后重试。')
    }
  }

  async function stopOtherAccounts(scope: string | null): Promise<void> {
    for (const previousScope of possibleSessions) {
      if (previousScope !== scope) await stopSession(previousScope)
    }
  }

  function request(scope: string, operation: 'get' | 'start' | 'stop', mode?: AccelerationMode, lineId?: string, ignoreConflicts?: boolean): Promise<AccelerationState> {
    try {
      assertScope(scope)
      if (operation === 'start') assertMode(mode)
      if (lineId !== undefined) assertLineId(lineId)
      assertIgnoreConflicts(ignoreConflicts)
      assertCurrent(scope, revision)
    } catch (error) { return Promise.reject(error) }
    const expectedRevision = revision
    // A retry that overrides the conflict warning is a different request from
    // the one that raised it, so it must not be served the refusal in flight.
    const key = `${revision}:${scope}:${operation}:${mode ?? ''}:${lineId ?? ''}:${ignoreConflicts === true}`
    if (operation !== 'get' && lastMutation?.key === key) return lastMutation.promise
    const promise = enqueue(async () => {
      await stopOtherAccounts(options.getAccountScope())
      assertCurrent(scope, expectedRevision)
      if (!backend) {
        if (operation === 'start') throw new Error(SERVICE_UNAVAILABLE)
        return unavailableState(scope)
      }
      if (operation === 'start') possibleSessions.add(scope)
      let state: AccelerationState
      try {
        let raw: unknown
        if (operation === 'start') {
          assertMode(mode)
          raw = await backend.startAcceleration(scope, mode, lineId, ignoreConflicts)
        } else if (operation === 'get') raw = await backend.getAccelerationState(scope)
        else raw = await backend.stopAcceleration(scope)
        state = projectState(raw, scope)
        if (operation === 'start' && state.mode !== mode) throw new Error(INVALID_RESPONSE)
        track(state)
      } catch {
        if (operation === 'start' || options.getAccountScope() !== scope || expectedRevision !== revision || disposed) {
          if (possibleSessions.has(scope)) await stopSession(scope)
        }
        throw new Error(BACKEND_FAILURE)
      }
      if (options.getAccountScope() !== scope || expectedRevision !== revision || disposed) {
        if (possibleSessions.has(scope)) await stopSession(scope)
        throw new Error(ACCOUNT_CHANGED)
      }
      return state
    })
    lastMutation = operation === 'get' ? null : { key, promise }
    void promise.finally(() => {
      if (lastMutation?.promise === promise) lastMutation = null
    }).catch(() => undefined)
    return promise
  }

  return {
    getAccelerationState: (scope) => request(scope, 'get'),
    startAcceleration: (scope, mode, lineId, ignoreConflicts) => request(scope, 'start', mode, lineId, ignoreConflicts),
    stopAcceleration: (scope) => request(scope, 'stop'),
    redeemAccelerationCode(scope, code) {
      try {
        assertScope(scope)
        if (typeof code !== 'string' || !code.trim() || code.length > 64) throw new Error('加速口令格式无效。')
        assertCurrent(scope, revision)
      } catch (error) { return Promise.reject(error) }
      const expectedRevision = revision
      return enqueue(async () => {
        await stopOtherAccounts(options.getAccountScope())
        assertCurrent(scope, expectedRevision)
        if (!backend?.redeemAccelerationCode) throw new Error(SERVICE_UNAVAILABLE)
        let result: AccelerationRedemptionResult
        try { result = projectRedemption(await backend.redeemAccelerationCode(scope, code), scope) }
        catch {
          assertCurrent(scope, expectedRevision)
          throw new Error('加速口令兑换失败，请稍后重试。')
        }
        assertCurrent(scope, expectedRevision)
        track(result.state)
        return result
      })
    },
    listAccelerationLines(scope) {
      try { assertScope(scope); assertCurrent(scope, revision) } catch (error) { return Promise.reject(error) }
      const expectedRevision = revision
      return enqueue(async () => {
        assertCurrent(scope, expectedRevision)
        if (!backend?.listAccelerationLines) return []
        try {
          const lines = projectLines(await backend.listAccelerationLines(scope))
          assertCurrent(scope, expectedRevision)
          return lines
        } catch { throw new Error(BACKEND_FAILURE) }
      })
    },
    pingAccelerationLine(scope, lineId) {
      try { assertScope(scope); assertLineId(lineId); assertCurrent(scope, revision) } catch (error) { return Promise.reject(error) }
      const expectedRevision = revision
      return enqueue(async () => {
        assertCurrent(scope, expectedRevision)
        if (!backend?.pingAccelerationLine) throw new Error(SERVICE_UNAVAILABLE)
        try {
          const line = projectLine(await backend.pingAccelerationLine(scope, lineId))
          if (line.id !== lineId) throw new Error(INVALID_RESPONSE)
          assertCurrent(scope, expectedRevision)
          return line
        } catch { throw new Error(BACKEND_FAILURE) }
      })
    },
    stopAll() {
      revision += 1
      lastMutation = null
      return enqueue(() => stopOtherAccounts(null))
    },
    onAccountChanged() {
      revision += 1
      lastMutation = null
      const nextScope = options.getAccountScope()
      return enqueue(() => stopOtherAccounts(nextScope))
    },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      revision += 1
      disposePromise = enqueue(() => stopOtherAccounts(null))
      void disposePromise.catch(() => { disposePromise = null })
      return disposePromise
    },
  }
}

import type { AccelerationApi, AccelerationMode, AccelerationRedemptionResult, AccelerationState } from './api'
import { errorMessage as sharedErrorMessage } from '../../business-common'

export interface AccelerationSnapshot {
  state: AccelerationState | null
  busy: boolean
  error: string | null
  mode: AccelerationMode
}

export interface AccelerationController {
  getSnapshot(): AccelerationSnapshot
  subscribe(listener: () => void): () => void
  setScope(scope: string | null): void
  setVisible(visible: boolean): void
  refresh(): Promise<void>
  start(lineId?: string, ignoreConflicts?: boolean): Promise<void>
  stop(): Promise<void>
  redeem(code: string): Promise<AccelerationRedemptionResult | null>
  setMode(mode: AccelerationMode): void
  tick(): void
  dispose(): void
}

interface ControllerOptions {
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

interface MutationFlight {
  promise: Promise<void>
  redemption?: Promise<AccelerationRedemptionResult | null>
}

function scheduleTimeout(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

function connected(state: AccelerationState | null) {
  return state?.phase === 'active' || state?.phase === 'stopping'
}

function errorMessage(cause: unknown) {
  // 走公共实现才会剥掉 IPC 通道名前缀并脱敏绝对路径（R-S7）；300 字上限保持不变。
  return sharedErrorMessage(cause, '加速状态更新失败，请重试。').slice(0, 300)
}

/** Display projection only: balances and actual connection lifetime belong to the host. */
export function createAccelerationController(api: AccelerationApi, { now = () => performance.now(), schedule = scheduleTimeout }: ControllerOptions = {}): AccelerationController {
  let snapshot: AccelerationSnapshot = { state: null, busy: false, error: null, mode: 'system-proxy' }
  let scope: string | null = null
  let source: AccelerationState | null = null
  let measuredAt = now()
  let visible = true
  let disposed = false
  let epoch = 0
  let revision = 0
  let expiryRequested = false
  let readFlight: { promise: Promise<void> } | null = null
  let mutation: MutationFlight | null = null
  let cancelTick: (() => void) | undefined
  let cancelPoll: (() => void) | undefined
  let cancelExpiry: (() => void) | undefined
  const listeners = new Set<() => void>()

  function publish(update: Partial<AccelerationSnapshot>) {
    snapshot = { ...snapshot, ...update }
    for (const listener of listeners) listener()
  }

  function projected(): AccelerationState | null {
    if (!source || !connected(source)) return source
    // No wall clock or interval accumulation: delayed callbacks and clock changes
    // cannot grant extra time. The next host read corrects sleep/transport drift.
    const elapsed = Math.max(0, now() - measuredAt) / 1000
    return {
      ...source,
      remainingSeconds: source.remainingSeconds === null ? null : Math.max(0, source.remainingSeconds - elapsed),
      sessionSeconds: source.sessionSeconds + elapsed,
    }
  }

  function scheduleTick() {
    cancelTick?.()
    cancelTick = undefined
    if (!disposed && visible && connected(source)) {
      cancelTick = schedule(() => { cancelTick = undefined; tick(); scheduleTick() }, 1000)
    }
  }

  function schedulePoll() {
    cancelPoll?.()
    cancelPoll = undefined
    if (!disposed && visible && scope && !mutation && !readFlight) {
      cancelPoll = schedule(() => { cancelPoll = undefined; void refresh() }, 15_000)
    }
  }

  function scheduleExpiry() {
    cancelExpiry?.()
    cancelExpiry = undefined
    const state = projected()
    if (!disposed && !mutation && !expiryRequested && state?.phase === 'active' && state.remainingSeconds !== null) {
      cancelExpiry = schedule(() => { cancelExpiry = undefined; tick() }, Math.max(0, state.remainingSeconds * 1000))
    }
  }

  function tick() {
    if (disposed) return
    const state = projected()
    if (state !== snapshot.state) publish({ state })
    if (!mutation && !expiryRequested && state?.phase === 'active' && state.remainingSeconds === 0) {
      expiryRequested = true
      void stop()
    }
  }

  function accept(state: AccelerationState) {
    if (state.scope !== scope || !Number.isFinite(state.totalSeconds) || state.totalSeconds < 0
      || !Number.isFinite(state.sessionSeconds) || state.sessionSeconds < 0
      || (state.remainingSeconds !== null && (!Number.isFinite(state.remainingSeconds) || state.remainingSeconds < 0 || state.remainingSeconds > state.totalSeconds))) {
      throw new Error('加速服务返回的账号或时长信息无效，请刷新重试。')
    }
    const firstRead = source === null
    if (!connected(state) || state.connectedAt !== source?.connectedAt) expiryRequested = false
    source = { ...state }
    measuredAt = now()
    publish({
      state: source,
      mode: firstRead || connected(state) || state.phase === 'connecting' ? state.mode : snapshot.mode,
      error: state.error,
    })
    scheduleTick()
    scheduleExpiry()
  }

  function refresh(): Promise<void> {
    if (disposed || !scope) return Promise.resolve()
    if (mutation) return mutation.promise
    if (readFlight) return readFlight.promise
    const requestScope = scope
    const requestEpoch = epoch
    const requestRevision = revision
    const current = () => !disposed && epoch === requestEpoch && revision === requestRevision && scope === requestScope
    const flight = { promise: Promise.resolve() }
    readFlight = flight
    cancelPoll?.()
    cancelPoll = undefined
    if (!source) publish({ busy: true, error: null })
    flight.promise = Promise.resolve().then(async () => {
      if (!current()) return
      try {
        const state = await api.getAccelerationState(requestScope)
        if (current()) accept(state)
      } catch (cause) {
        if (current()) {
          tick()
          if (current()) publish({ error: errorMessage(cause) })
        }
      } finally {
        if (current() && readFlight === flight) {
          readFlight = null
          publish({ busy: false })
          schedulePoll()
        }
      }
    })
    return flight.promise
  }

  function run(kind: 'start' | 'stop', lineId?: string, ignoreConflicts?: boolean): Promise<void> {
    if (disposed || !scope) return Promise.resolve()
    if (mutation) return mutation.promise
    if (!source || (kind === 'start' && (connected(source) || source.phase === 'connecting' || source.phase === 'unavailable' || source.remainingSeconds === null || source.remainingSeconds <= 0))
      || (kind === 'stop' && !connected(source))) return Promise.resolve()
    const requestScope = scope
    const requestEpoch = epoch
    const requestRevision = ++revision
    const current = () => !disposed && epoch === requestEpoch && revision === requestRevision && scope === requestScope
    const before = source
    const beforeMeasuredAt = measuredAt
    const mode = snapshot.mode
    const flight = { promise: Promise.resolve() }
    mutation = flight
    readFlight = null
    cancelPoll?.()
    cancelPoll = undefined
    cancelExpiry?.()
    cancelExpiry = undefined
    source = { ...source, phase: kind === 'start' ? 'connecting' : 'stopping', error: null }
    publish({ state: projected(), busy: true, error: null })
    scheduleTick()
    flight.promise = Promise.resolve().then(async () => {
      if (!current()) return
      try {
        const state = kind === 'start'
          ? ignoreConflicts === undefined
            ? lineId === undefined ? await api.startAcceleration(requestScope, mode) : await api.startAcceleration(requestScope, mode, lineId)
            : await api.startAcceleration(requestScope, mode, lineId, ignoreConflicts)
          : await api.stopAcceleration(requestScope)
        if (current()) accept(state)
      } catch (cause) {
        if (current()) {
          source = before
          measuredAt = beforeMeasuredAt
          publish({ state: projected(), error: errorMessage(cause) })
          scheduleTick()
        }
      } finally {
        if (current() && mutation === flight) {
          mutation = null
          publish({ busy: false })
          schedulePoll()
          scheduleExpiry()
        }
      }
    })
    return flight.promise
  }

  function start(lineId?: string, ignoreConflicts?: boolean) { return run('start', lineId, ignoreConflicts) }
  function stop() { return run('stop') }

  function redeem(code: string): Promise<AccelerationRedemptionResult | null> {
    if (disposed) return Promise.resolve(null)
    if (!scope) return Promise.reject(new Error('请先登录星芒账号，再领取加速时长。'))
    if (mutation) return mutation.redemption ?? Promise.reject(new Error('加速操作正在进行，请稍后再领取。'))
    const redeemCode = api.redeemAccelerationCode
    if (!redeemCode) return Promise.reject(new Error('加速服务暂未就绪，请稍后重试。'))
    const requestScope = scope
    const requestEpoch = epoch
    const requestRevision = ++revision
    const current = () => !disposed && epoch === requestEpoch && revision === requestRevision && scope === requestScope
    const flight: MutationFlight = { promise: Promise.resolve() }
    mutation = flight
    // A read started before this mutation must not restore the pre-redemption balance.
    readFlight = null
    cancelPoll?.()
    cancelPoll = undefined
    cancelExpiry?.()
    cancelExpiry = undefined
    publish({ busy: true, error: null })
    flight.redemption = Promise.resolve().then(async () => {
      if (!current()) return null
      try {
        const result = await redeemCode(requestScope, code)
        if (!current()) return null
        accept(result.state)
        if (result.state.remainingSeconds !== null && result.state.remainingSeconds > 0) expiryRequested = false
        return result
      } catch (cause) {
        if (!current()) return null
        publish({ error: errorMessage(cause) })
        throw cause
      } finally {
        if (current() && mutation === flight) {
          mutation = null
          publish({ busy: false })
          schedulePoll()
          scheduleExpiry()
        }
      }
    })
    // Existing start/stop/refresh callers await the mutation without consuming its
    // result or reporting its rejection; the submitter owns redemption feedback.
    flight.promise = flight.redemption.then(() => undefined, () => undefined)
    return flight.redemption
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setScope(next) {
      if (disposed || next === scope) return
      epoch++
      scope = next
      source = null
      readFlight = null
      mutation = null
      expiryRequested = false
      cancelTick?.()
      cancelPoll?.()
      cancelExpiry?.()
      publish({ state: null, busy: false, error: null, mode: 'system-proxy' })
      if (scope) void refresh()
    },
    setVisible(next) {
      if (disposed || visible === next) return
      visible = next
      tick()
      scheduleTick()
      schedulePoll()
      if (visible) void refresh()
    },
    refresh, start, stop, redeem, tick,
    setMode(mode) {
      if (disposed || snapshot.busy || connected(source) || source?.phase === 'connecting' || (mode !== 'system-proxy' && mode !== 'tun')) return
      publish({ mode })
    },
    dispose() {
      disposed = true
      epoch++
      cancelTick?.()
      cancelPoll?.()
      cancelExpiry?.()
      listeners.clear()
    },
  }
}

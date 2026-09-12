import type { AccountBalance } from '../../../../electron/ipc-contract'
import { formatAccountReadError } from './account-read-error'

export interface AccountBalanceSnapshot {
  scope: string | null
  balance: AccountBalance | null
  loading: boolean
  updatedAt: number | null
  error: string | null
}

export type AccountBalanceRefreshReason = 'manual' | 'mutation' | 'foreground' | 'interval'

export interface AccountBalanceStore {
  getSnapshot(): AccountBalanceSnapshot
  subscribe(listener: () => void): () => void
  setScope(scope: string | null): void
  setVisible(visible: boolean): void
  refresh(reason?: AccountBalanceRefreshReason): Promise<void>
  scheduleActivity(scope: string): void
  dispose(): void
}

const refreshInterval = 30_000
const foregroundReuseWindow = 5_000
const activityDelay = 2_000

/** One renderer owns the account balance; views subscribe instead of polling independently. */
export function createAccountBalanceStore({ read, now = Date.now }: {
  read: () => Promise<AccountBalance>
  now?: () => number
}): AccountBalanceStore {
  let snapshot: AccountBalanceSnapshot = { scope: null, balance: null, loading: false, updatedAt: null, error: null }
  const listeners = new Set<() => void>()
  let visible = true
  let disposed = false
  let epoch = 0
  let intervalTimer: ReturnType<typeof setTimeout> | undefined
  let activityTimer: ReturnType<typeof setTimeout> | undefined
  let activityDueAt: number | null = null
  let inFlight: { promise: Promise<void>; repeat: boolean } | null = null

  function publish(update: Partial<AccountBalanceSnapshot>) {
    snapshot = { ...snapshot, ...update }
    for (const listener of listeners) listener()
  }

  function clearIntervalTimer() {
    clearTimeout(intervalTimer)
    intervalTimer = undefined
  }

  function clearActivityTimer() {
    clearTimeout(activityTimer)
    activityTimer = undefined
  }

  function scheduleInterval() {
    clearIntervalTimer()
    if (disposed || !visible || !snapshot.scope || inFlight) return
    intervalTimer = setTimeout(() => {
      intervalTimer = undefined
      void refresh('interval')
    }, refreshInterval)
  }

  function schedulePendingActivity() {
    clearActivityTimer()
    if (disposed || !visible || !snapshot.scope || activityDueAt === null) return
    const requestEpoch = epoch
    activityTimer = setTimeout(() => {
      activityTimer = undefined
      if (disposed || requestEpoch !== epoch) return
      activityDueAt = null
      void refresh('mutation')
    }, Math.max(0, activityDueAt - now()))
  }

  function refresh(reason: AccountBalanceRefreshReason = 'manual'): Promise<void> {
    if (disposed || !snapshot.scope || (!visible && (reason === 'interval' || reason === 'foreground'))) return Promise.resolve()
    if (inFlight) {
      // A payment or completed generation may have changed the server balance
      // after this read started. Ordinary refresh callers can share that read.
      if (reason === 'mutation') inFlight.repeat = true
      return inFlight.promise
    }
    if (reason === 'foreground' && snapshot.updatedAt !== null && !snapshot.error && now() - snapshot.updatedAt < foregroundReuseWindow) {
      scheduleInterval()
      return Promise.resolve()
    }

    clearIntervalTimer()
    const requestEpoch = epoch
    const requestScope = snapshot.scope
    const current = () => !disposed && requestEpoch === epoch && requestScope === snapshot.scope
    const flight = { promise: Promise.resolve(), repeat: false }
    inFlight = flight
    // Start in a microtask so both synchronous throws and account changes before
    // dispatch follow the same guarded path as rejected asynchronous reads.
    flight.promise = Promise.resolve().then(async () => {
      try {
        do {
          if (!current()) return
          flight.repeat = false
          try {
            const balance = await read()
            if (!current()) return
            publish({ balance, updatedAt: now(), error: null })
          } catch (cause) {
            if (!current()) return
            publish({ error: formatAccountReadError(cause, 'balance') })
          }
        } while (flight.repeat)
      } finally {
        if (current() && inFlight === flight) {
          inFlight = null
          publish({ loading: false })
          scheduleInterval()
        }
      }
    })
    publish({ loading: true, error: null })
    return flight.promise
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setScope(scope) {
      if (disposed || scope === snapshot.scope) return
      epoch++
      clearIntervalTimer()
      clearActivityTimer()
      activityDueAt = null
      inFlight = null
      publish({ scope, balance: null, loading: false, updatedAt: null, error: null })
      if (scope) void refresh()
    },
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return
      visible = nextVisible
      if (!visible) {
        clearIntervalTimer()
        clearActivityTimer()
        return
      }
      // A completion while hidden must bypass the foreground reuse window.
      if (activityDueAt !== null && activityDueAt <= now()) {
        activityDueAt = null
        void refresh('mutation')
      } else {
        schedulePendingActivity()
        void refresh('foreground')
      }
    },
    refresh,
    scheduleActivity(scope) {
      if (disposed || !snapshot.scope || scope !== snapshot.scope) return
      activityDueAt = now() + activityDelay
      schedulePendingActivity()
    },
    dispose() {
      if (disposed) return
      disposed = true
      epoch++
      clearIntervalTimer()
      clearActivityTimer()
      activityDueAt = null
      inFlight = null
      listeners.clear()
      snapshot = { scope: null, balance: null, loading: false, updatedAt: null, error: null }
    },
  }
}

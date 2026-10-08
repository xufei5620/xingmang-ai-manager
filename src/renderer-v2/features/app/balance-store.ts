import type { AccountBalance } from '../../../../electron/ipc-contract'
import { formatAccountReadError } from './account-read-error'
import type { NetworkFailureReason } from '../../../../electron/network-failure'
import { localNetworkFailureReason } from '../shell/online-status'

export interface AccountBalanceSnapshot {
  scope: string | null
  balance: AccountBalance | null
  loading: boolean
  updatedAt: number | null
  error: string | null
  /**
   * 连着几次读余额都是本机网络的问题（没网、代理挂了、门户认证没做完）；读成功或
   * 换成别的失败就归零。余额是唯一定时去服务端拉数据的地方，顶部的断网横幅靠它
   * 认出 navigator.onLine 看不出来的那几种断网。
   */
  networkFailures: number
  /** 最近那次本机网络失败是哪一种（代理、门户认证……）；计数归零时一起清掉。 */
  networkFailureReason?: NetworkFailureReason
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

// 这是软件里唯一按时去服务端拉数据的地方：余额、公告时间线和后台的新公告提醒都跟着它。
// 以前窗口没缩到托盘就每 30 秒刷一次，被别的窗口挡着也照刷，一台电脑一天能到三千次。
// 现在用户正看着软件时每分钟一次，被挡住、在后台或缩到托盘时每 10 分钟一次（只为了
// 及时弹新公告的系统通知），切回窗口马上刷一次。
export const activeRefreshInterval = 60_000
export const backgroundRefreshInterval = 10 * 60_000
const foregroundReuseWindow = 5_000
const activityDelay = 2_000

function alwaysFocused() { return true }

/** One renderer owns the account balance; views subscribe instead of polling independently. */
export function createAccountBalanceStore({ read, now = Date.now, focused = alwaysFocused }: {
  read: () => Promise<AccountBalance>
  now?: () => number
  /** Whether the user is looking at the window; decides the refresh pace. */
  focused?: () => boolean
}): AccountBalanceStore {
  let snapshot: AccountBalanceSnapshot = { scope: null, balance: null, loading: false, updatedAt: null, error: null, networkFailures: 0 }
  const listeners = new Set<() => void>()
  let visible = true
  let disposed = false
  let epoch = 0
  let intervalTimer: ReturnType<typeof setTimeout> | undefined
  let activityTimer: ReturnType<typeof setTimeout> | undefined
  let activityDueAt: number | null = null
  let inFlight: { promise: Promise<void>; repeat: boolean } | null = null
  // A failed read counts too, so a network outage does not speed the pace up.
  let lastAttemptAt = 0

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

  function refreshDelay() {
    return visible && focused() ? activeRefreshInterval : backgroundRefreshInterval
  }

  // The timer always wakes after the short delay and then decides: focus can
  // come and go without an event this store sees, so the pace is re-read on
  // every wake instead of being fixed when the timer was set.
  function scheduleInterval() {
    clearIntervalTimer()
    if (disposed || !snapshot.scope || inFlight) return
    intervalTimer = setTimeout(() => {
      intervalTimer = undefined
      if (now() - lastAttemptAt >= refreshDelay() - activeRefreshInterval / 2) void refresh('interval')
      else scheduleInterval()
    }, activeRefreshInterval)
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
    if (disposed || !snapshot.scope || (!visible && reason === 'foreground')) return Promise.resolve()
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
          lastAttemptAt = now()
          try {
            const balance = await read()
            if (!current()) return
            publish({ balance, updatedAt: now(), error: null, networkFailures: 0, networkFailureReason: undefined })
          } catch (cause) {
            if (!current()) return
            const reason = localNetworkFailureReason(cause) ?? undefined
            publish({ error: formatAccountReadError(cause, 'balance'), networkFailures: reason ? snapshot.networkFailures + 1 : 0, networkFailureReason: reason })
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
      publish({ scope, balance: null, loading: false, updatedAt: null, error: null, networkFailures: 0, networkFailureReason: undefined })
      if (scope) void refresh()
    },
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return
      visible = nextVisible
      if (!visible) {
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
      snapshot = { scope: null, balance: null, loading: false, updatedAt: null, error: null, networkFailures: 0 }
    },
  }
}

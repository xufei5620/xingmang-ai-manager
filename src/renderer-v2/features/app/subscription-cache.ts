import type { AccountSubscriptionSelf } from '../../../../electron/ipc-contract'

export interface AccountSubscriptionCacheSnapshot {
  scope: string | null
  self: AccountSubscriptionSelf | null
  /** 套餐 id → 名字；订阅本身带了名字（历史账号）时不去读套餐列表。 */
  planNames: ReadonlyMap<number, string>
  /**
   * 这个账号上一次读成功的时间。null = 还没读到过（刚登录、刚换账号、正在读，或者读失败了）：
   * 这时不知道有没有订阅，界面不能当成「没有订阅」去说「余额是 $0」（F1）。
   */
  readAt: number | null
}

export interface AccountSubscriptionCache {
  getSnapshot(): AccountSubscriptionCacheSnapshot
  subscribe(listener: () => void): () => void
  /** 换了账号，或上次读过超过 maxAge 才真去读；其余时候什么都不做。 */
  refreshIfStale(scope: string | null): Promise<void>
  /** 刚买好订阅：不等 maxAge，读完手上这一次（它可能是付款前发出的）再读一次。 */
  refreshNow(scope: string | null): Promise<void>
  dispose(): void
}

// 余额是唯一定时拉服务端的地方（#519），订阅不另起定时器：只在余额读回来时顺带
// 看一眼，而且几分钟内读过就不再读。订阅是按天到期、按次扣费的东西，晚几分钟
// 看到不耽误事；多一条每分钟一次的请求却是实打实的服务端压力。
export const subscriptionCacheMaxAge = 5 * 60_000
/**
 * 这个账号还一次都没读到时，读失败后隔多久再试：30 秒起、每失败一次翻一倍、最多到 maxAge。
 * 没读到的这段时间界面只能先不说钱的事，干等满 5 分钟太久（F1）；读到过的照旧 5 分钟一次。
 */
export const subscriptionFirstReadRetry = 30_000

const empty: AccountSubscriptionCacheSnapshot = { scope: null, self: null, planNames: new Map(), readAt: null }

export function createAccountSubscriptionCache({ readSelf, readPlanNames, now = Date.now, maxAge = subscriptionCacheMaxAge, firstReadRetry = subscriptionFirstReadRetry }: {
  readSelf: () => Promise<AccountSubscriptionSelf>
  readPlanNames: () => Promise<ReadonlyMap<number, string>>
  now?: () => number
  maxAge?: number
  firstReadRetry?: number
}): AccountSubscriptionCache {
  let snapshot = empty
  let disposed = false
  let inFlight: { scope: string; promise: Promise<void> } | null = null
  // A failed read counts as an attempt, so an outage does not turn every
  // balance refresh into a second request.
  let attemptedAt: number | null = null
  // Failures in a row before this account was ever read. Only these shorten
  // the wait: once a read has landed the old value stays on screen, so the
  // usual few-minute rhythm is fine.
  let firstReadFailures = 0
  const listeners = new Set<() => void>()

  function publish(next: AccountSubscriptionCacheSnapshot) {
    snapshot = next
    for (const listener of listeners) listener()
  }

  function refreshIfStale(scope: string | null): Promise<void> {
    if (disposed) return Promise.resolve()
    if (scope !== snapshot.scope) {
      attemptedAt = null
      firstReadFailures = 0
      publish({ ...empty, scope })
    }
    if (!scope) return Promise.resolve()
    if (inFlight?.scope === scope) return inFlight.promise
    const wait = firstReadFailures > 0 ? Math.min(maxAge, firstReadRetry * 2 ** (firstReadFailures - 1)) : maxAge
    if (attemptedAt !== null && now() - attemptedAt < wait) return Promise.resolve()
    attemptedAt = now()
    const flight = { scope, promise: Promise.resolve() }
    flight.promise = (async () => {
      try {
        const self = await readSelf()
        const needsNames = self.activeSubscriptions.some((subscription) => !subscription.groupName)
        const planNames = needsNames ? await readPlanNames().catch(() => snapshot.planNames) : snapshot.planNames
        if (!disposed && snapshot.scope === scope) {
          firstReadFailures = 0
          publish({ scope, self, planNames, readAt: now() })
        }
      } catch {
        // Keep what was read last for this account: one failed read must not
        // bring back the "余额只剩 $0" warning for a customer on a subscription.
        // Nothing read yet means readAt stays null, which the screens treat as
        // "unknown", never as "no subscription".
        if (!disposed && snapshot.scope === scope && snapshot.readAt === null) firstReadFailures++
      } finally {
        if (inFlight === flight) inFlight = null
      }
    })()
    inFlight = flight
    return flight.promise
  }

  async function refreshNow(scope: string | null): Promise<void> {
    if (!scope || scope !== snapshot.scope) return refreshIfStale(scope)
    if (inFlight?.scope === scope) await inFlight.promise
    attemptedAt = null
    return refreshIfStale(scope)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refreshIfStale,
    refreshNow,
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

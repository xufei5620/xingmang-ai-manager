import type { AccountSubscriptionSelf } from '../../../../electron/ipc-contract'

export interface AccountSubscriptionCacheSnapshot {
  scope: string | null
  self: AccountSubscriptionSelf | null
  /** 套餐 id → 名字；订阅本身带了名字（历史账号）时不去读套餐列表。 */
  planNames: ReadonlyMap<number, string>
  readAt: number | null
}

export interface AccountSubscriptionCache {
  getSnapshot(): AccountSubscriptionCacheSnapshot
  subscribe(listener: () => void): () => void
  /** 换了账号，或上次读过超过 maxAge 才真去读；其余时候什么都不做。 */
  refreshIfStale(scope: string | null): Promise<void>
  dispose(): void
}

// 余额是唯一定时拉服务端的地方（#519），订阅不另起定时器：只在余额读回来时顺带
// 看一眼，而且几分钟内读过就不再读。订阅是按天到期、按次扣费的东西，晚几分钟
// 看到不耽误事；多一条每分钟一次的请求却是实打实的服务端压力。
export const subscriptionCacheMaxAge = 5 * 60_000

const empty: AccountSubscriptionCacheSnapshot = { scope: null, self: null, planNames: new Map(), readAt: null }

export function createAccountSubscriptionCache({ readSelf, readPlanNames, now = Date.now, maxAge = subscriptionCacheMaxAge }: {
  readSelf: () => Promise<AccountSubscriptionSelf>
  readPlanNames: () => Promise<ReadonlyMap<number, string>>
  now?: () => number
  maxAge?: number
}): AccountSubscriptionCache {
  let snapshot = empty
  let disposed = false
  let inFlight: { scope: string; promise: Promise<void> } | null = null
  // A failed read counts as an attempt, so an outage does not turn every
  // balance refresh into a second request.
  let attemptedAt: number | null = null
  const listeners = new Set<() => void>()

  function publish(next: AccountSubscriptionCacheSnapshot) {
    snapshot = next
    for (const listener of listeners) listener()
  }

  function refreshIfStale(scope: string | null): Promise<void> {
    if (disposed) return Promise.resolve()
    if (scope !== snapshot.scope) {
      attemptedAt = null
      publish({ ...empty, scope })
    }
    if (!scope) return Promise.resolve()
    if (inFlight?.scope === scope) return inFlight.promise
    if (attemptedAt !== null && now() - attemptedAt < maxAge) return Promise.resolve()
    attemptedAt = now()
    const flight = { scope, promise: Promise.resolve() }
    flight.promise = (async () => {
      try {
        const self = await readSelf()
        const needsNames = self.activeSubscriptions.some((subscription) => !subscription.groupName)
        const planNames = needsNames ? await readPlanNames().catch(() => snapshot.planNames) : snapshot.planNames
        if (!disposed && snapshot.scope === scope) publish({ scope, self, planNames, readAt: now() })
      } catch {
        // Keep what was read last for this account: one failed read must not
        // bring back the "余额只剩 $0" warning for a customer on a subscription.
      } finally {
        if (inFlight === flight) inFlight = null
      }
    })()
    inFlight = flight
    return flight.promise
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refreshIfStale,
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

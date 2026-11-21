import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { XingmangApi } from '../../../../electron/ipc-contract'
import { createAccountBalanceStore, subscribeBalanceReads, type AccountBalanceSnapshot, type AccountBalanceStore } from './balance-store'
import { createAccountSubscriptionCache } from './subscription-cache'
import { resolveUsableSubscription, type UsableSubscription } from '../../../../electron/subscription-summary'

export const AccountBalanceContext = createContext<AccountBalanceStore | null>(null)
const emptySnapshot: AccountBalanceSnapshot = { scope: null, balance: null, loading: false, updatedAt: null, error: null, reads: 0, networkFailures: 0 }
function emptySubscribe() { return () => undefined }
function getEmptySnapshot() { return emptySnapshot }

/** 整份余额快照：转圈、最后更新时间、出错都要跟着变的地方才用它，每次刷新都会重画。 */
export function useSharedAccountBalance() {
  const store = useContext(AccountBalanceContext)
  // The third argument is what lets this component tree render through
  // react-dom/server, which is how every component test in this repo runs.
  const snapshot = useSyncExternalStore(store?.subscribe ?? emptySubscribe, store?.getSnapshot ?? getEmptySnapshot, store?.getSnapshot ?? getEmptySnapshot)
  return { store, snapshot }
}

/** 外层挂着的那份余额；没挂（组件测试）时为 null。只拿来刷新、听「读到了」，不订阅。 */
export function useSharedBalanceStore(): AccountBalanceStore | null {
  return useContext(AccountBalanceContext)
}

/**
 * 只订阅余额快照里挑出来的那一样（R8）：挑出来的跟上次一样（Object.is）就不重画。select 要回快照里
 * 原有的值或基本类型，不能每次新拼一个对象，否则每次发布都当成变了。store 为 null 时按空快照挑。
 */
export function useAccountBalanceSelector<T>(store: AccountBalanceStore | null, select: (snapshot: AccountBalanceSnapshot) => T): T {
  function read() { return select(store ? store.getSnapshot() : emptySnapshot) }
  return useSyncExternalStore(store?.subscribe ?? emptySubscribe, read, read)
}

/** 同上，挑的是外层挂着的那份余额。 */
export function useSharedBalanceSelector<T>(select: (snapshot: AccountBalanceSnapshot) => T): T {
  return useAccountBalanceSelector(useContext(AccountBalanceContext), select)
}

/**
 * 从外层那份余额里挑一样交给 children 去画（R8）：余额刷新时只有这一块跟着重画，摆它的组件不用订阅。
 * 挑法同 useAccountBalanceSelector。
 */
export function AccountBalanceSelect<T>({ select, children }: { select: (snapshot: AccountBalanceSnapshot) => T; children: (value: T) => ReactNode }) {
  return <>{children(useSharedBalanceSelector(select))}</>
}

/**
 * 界面里唯一的那份余额，由根组件建、在 scope 换了时跟着换账号。根组件自己不订阅它（R8）：
 * 以前在这里订阅整份快照，每分钟一次的刷新要把整个界面一百多个组件重画三遍。
 */
export function useAccountBalanceStore(api: XingmangApi, scope: string | null): AccountBalanceStore {
  const store = useMemo(() => createAccountBalanceStore({ read: () => api.getAccountBalance(), focused: () => document.hasFocus() }), [api])
  const lifetime = useMemo(() => ({ consumers: 0 }), [store])
  useLayoutEffect(() => { store.setScope(scope) }, [store, scope])
  useEffect(() => {
    lifetime.consumers++
    const visible = () => document.visibilityState !== 'hidden'
    const syncVisibility = () => store.setVisible(visible())
    const focus = () => {
      syncVisibility()
      if (visible()) void store.refresh('foreground')
    }
    syncVisibility()
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', syncVisibility)
    const unsubscribeUsage = api.onAccountUsageChanged?.((event) => store.scheduleActivity(event.scope))
    return () => {
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', syncVisibility)
      unsubscribeUsage?.()
      lifetime.consumers--
      // StrictMode reconnects the same store immediately. Dispose only after
      // the last real consumer has left, so in-flight requests stay shared.
      queueMicrotask(() => { if (!lifetime.consumers) store.dispose() })
    }
  }, [api, store, lifetime])
  return store
}

/**
 * 当前账号能用的订阅（第十五批 2）。不另起定时器：跟着余额的每次读回顺带看一眼，
 * 几分钟内读过就不读（subscription-cache.ts）。账号不支持订阅时恒为 null。
 * 余额只挑换算比例、只听「读到了」（R8）：它挂在根组件上，订阅整份余额会让每次刷新都整页重画。
 */
export function useUsableSubscription(api: XingmangApi, scope: string | null, balanceStore: AccountBalanceStore): {
  subscription: UsableSubscription | null
  /**
   * 这个账号的订阅还没读到（刚登录、刚换账号，或者读失败了）：subscription 的 null 不代表「没有订阅」。
   * 钱包 $0、靠订阅用的客户这时不能被说成「余额是 $0，去充值」（F1）。账号不支持订阅、没登录时为 false。
   */
  subscriptionUnknown: boolean
  /** 付款到账、兑换成订阅之后调：首页那行订阅马上跟着变，不等几分钟。 */
  refresh: () => Promise<void>
} {
  const cache = useMemo(() => createAccountSubscriptionCache({
    readSelf: () => api.getAccountSubscriptionSelf(),
    async readPlanNames() { return new Map((await api.getAccountSubscriptionPlans()).map((plan) => [plan.id, plan.title])) },
  }), [api])
  const lifetime = useMemo(() => ({ consumers: 0 }), [cache])
  useEffect(() => {
    lifetime.consumers++
    return () => {
      lifetime.consumers--
      // Same as the balance store above: StrictMode runs this cleanup and
      // reconnects the same cache at once. Disposing right here left it dead
      // for good, so the subscription was never read in a development build,
      // which now reads as "unknown" instead of "no subscription".
      queueMicrotask(() => { if (!lifetime.consumers) cache.dispose() })
    }
  }, [cache, lifetime])
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot, cache.getSnapshot)
  const quotaPerUnit = useAccountBalanceSelector(balanceStore, (state) => state.scope === scope ? state.balance?.quotaPerUnit ?? 0 : 0)
  useEffect(() => {
    if (!scope) { void cache.refreshIfStale(null); return }
    function look() {
      const state = balanceStore.getSnapshot()
      if (state.scope === scope && state.updatedAt !== null) void cache.refreshIfStale(scope)
    }
    look()
    return subscribeBalanceReads(balanceStore, look)
  }, [cache, scope, balanceStore])
  const refresh = useCallback(() => cache.refreshNow(scope), [cache, scope])
  if (!scope) return { subscription: null, subscriptionUnknown: false, refresh }
  if (snapshot.scope !== scope || snapshot.readAt === null) return { subscription: null, subscriptionUnknown: true, refresh }
  return {
    subscription: resolveUsableSubscription(snapshot.self, { now: Date.now(), quotaPerUnit, planNames: snapshot.planNames }),
    subscriptionUnknown: false,
    refresh,
  }
}

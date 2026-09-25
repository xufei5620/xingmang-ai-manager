import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { XingmangApi } from '../../../../electron/ipc-contract'
import { createAccountBalanceStore, type AccountBalanceSnapshot, type AccountBalanceStore } from './balance-store'
import { createAccountSubscriptionCache } from './subscription-cache'
import { resolveUsableSubscription, type UsableSubscription } from '../../../../electron/subscription-summary'

export const AccountBalanceContext = createContext<AccountBalanceStore | null>(null)
const emptySnapshot: AccountBalanceSnapshot = { scope: null, balance: null, loading: false, updatedAt: null, error: null, networkFailures: 0 }
function emptySubscribe() { return () => undefined }
function getEmptySnapshot() { return emptySnapshot }

export function useSharedAccountBalance() {
  const store = useContext(AccountBalanceContext)
  // The third argument is what lets this component tree render through
  // react-dom/server, which is how every component test in this repo runs.
  const snapshot = useSyncExternalStore(store?.subscribe ?? emptySubscribe, store?.getSnapshot ?? getEmptySnapshot, store?.getSnapshot ?? getEmptySnapshot)
  return { store, snapshot }
}

export function useAccountBalanceStore(api: XingmangApi, scope: string | null) {
  const store = useMemo(() => createAccountBalanceStore({ read: () => api.getAccountBalance(), focused: () => document.hasFocus() }), [api])
  const lifetime = useMemo(() => ({ consumers: 0 }), [store])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
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
  return { store, snapshot: snapshot.scope === scope ? snapshot : { ...emptySnapshot, scope } }
}

/**
 * 当前账号能用的订阅（第十五批 2）。不另起定时器：跟着余额的每次读回顺带看一眼，
 * 几分钟内读过就不读（subscription-cache.ts）。账号不支持订阅时恒为 null。
 */
export function useUsableSubscription(api: XingmangApi, scope: string | null, balance: AccountBalanceSnapshot): UsableSubscription | null {
  const cache = useMemo(() => createAccountSubscriptionCache({
    readSelf: () => api.getAccountSubscriptionSelf(),
    async readPlanNames() { return new Map((await api.getAccountSubscriptionPlans()).map((plan) => [plan.id, plan.title])) },
  }), [api])
  useEffect(() => () => cache.dispose(), [cache])
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot, cache.getSnapshot)
  useEffect(() => {
    if (!scope) { void cache.refreshIfStale(null); return }
    if (balance.updatedAt !== null) void cache.refreshIfStale(scope)
  }, [cache, scope, balance.updatedAt])
  if (!scope || snapshot.scope !== scope) return null
  return resolveUsableSubscription(snapshot.self, { now: Date.now(), quotaPerUnit: balance.balance?.quotaPerUnit ?? 0, planNames: snapshot.planNames })
}

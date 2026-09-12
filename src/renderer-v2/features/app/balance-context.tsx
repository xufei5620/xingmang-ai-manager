import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { XingmangApi } from '../../../../electron/ipc-contract'
import { createAccountBalanceStore, type AccountBalanceSnapshot, type AccountBalanceStore } from './balance-store'

export const AccountBalanceContext = createContext<AccountBalanceStore | null>(null)
const emptySnapshot: AccountBalanceSnapshot = { scope: null, balance: null, loading: false, updatedAt: null, error: null }
function emptySubscribe() { return () => undefined }
function getEmptySnapshot() { return emptySnapshot }

export function useSharedAccountBalance() {
  const store = useContext(AccountBalanceContext)
  const snapshot = useSyncExternalStore(store?.subscribe ?? emptySubscribe, store?.getSnapshot ?? getEmptySnapshot)
  return { store, snapshot }
}

export function useAccountBalanceStore(api: XingmangApi, scope: string | null) {
  const store = useMemo(() => createAccountBalanceStore({ read: () => api.getAccountBalance() }), [api])
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

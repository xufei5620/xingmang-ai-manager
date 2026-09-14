import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { AccelerationState } from '../../../../electron/acceleration-contract'
import { createNetworkLocationController, type NetworkLocationApi } from './network-controller'

const focusRefreshIntervalMs = 30_000

/** Mount in the app shell so changing pages does not lose a route transition. */
export function useNetworkLocation(bridge: Partial<NetworkLocationApi> | null, connection: AccelerationState | null) {
  const controller = useMemo(() => createNetworkLocationController({
    refreshNetworkLocation: () => bridge?.refreshNetworkLocation
      ? bridge.refreshNetworkLocation()
      : Promise.reject(new Error('网络位置服务暂未就绪。')),
  }), [bridge])
  const lifetime = useMemo(() => ({ consumers: 0 }), [controller])
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useLayoutEffect(() => { controller.setConnection(connection) }, [controller, connection])
  useEffect(() => {
    lifetime.consumers += 1
    return () => {
      lifetime.consumers -= 1
      // React StrictMode immediately reconnects this same controller.
      queueMicrotask(() => { if (!lifetime.consumers) controller.dispose() })
    }
  }, [controller, lifetime])
  useEffect(() => {
    let lastFocusRefresh = -Infinity
    const online = () => { void controller.refresh() }
    const focus = () => {
      if (document.visibilityState === 'hidden') return
      const now = performance.now()
      if (now - lastFocusRefresh < focusRefreshIntervalMs) return
      lastFocusRefresh = now
      void controller.refresh()
    }
    window.addEventListener('online', online)
    window.addEventListener('focus', focus)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('focus', focus)
    }
  }, [controller])
  return { snapshot, refresh: controller.refresh }
}

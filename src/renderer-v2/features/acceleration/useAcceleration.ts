import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { AccelerationApi } from './api'
import { createAccelerationController, type AccelerationSnapshot } from './controller'
import { createAccelerationLinesController } from './lines-controller'

const emptySnapshot: AccelerationSnapshot = { state: null, busy: false, error: null, mode: 'system-proxy' }

/** Keep this hook in the app shell; leaving the page does not disconnect a session. */
export function useAcceleration(api: AccelerationApi, scope: string | null, active = true) {
  const controller = useMemo(() => createAccelerationController(api), [api])
  const linesController = useMemo(() => createAccelerationLinesController(api, () => {
    const current = controller.getSnapshot()
    return !current.busy && !['active', 'connecting', 'stopping'].includes(current.state?.phase ?? '')
  }), [api, controller])
  const lifetime = useMemo(() => ({ consumers: 0 }), [controller, linesController])
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const lineSnapshot = useSyncExternalStore(linesController.subscribe, linesController.getSnapshot)
  useLayoutEffect(() => { controller.setScope(scope); linesController.setScope(scope) }, [controller, linesController, scope])
  useEffect(() => {
    lifetime.consumers++
    return () => {
      lifetime.consumers--
      // React StrictMode reconnects immediately; disposing after its synthetic
      // cleanup would lose pending mutations and create duplicate connections.
      queueMicrotask(() => { if (!lifetime.consumers) { controller.dispose(); linesController.dispose() } })
    }
  }, [controller, linesController, lifetime])
  useEffect(() => {
    const visible = () => active && document.visibilityState !== 'hidden'
    const visibilityChanged = () => controller.setVisible(visible())
    const focus = () => {
      visibilityChanged()
      if (visible()) { controller.tick(); void controller.refresh() }
    }
    visibilityChanged()
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [controller, active])
  return {
    snapshot: snapshot.state && snapshot.state.scope !== scope ? emptySnapshot : {
      ...snapshot,
      // Keep stop available even if a metadata refresh was requested while active.
      busy: snapshot.busy || (lineSnapshot.scope === scope && lineSnapshot.busy && !['active', 'stopping'].includes(snapshot.state?.phase ?? '')),
    },
    refresh: controller.refresh,
    start: (lineId?: string, ignoreConflicts?: boolean) => linesController.getSnapshot().busy ? Promise.resolve() : controller.start(lineId, ignoreConflicts),
    stop: controller.stop,
    redeem: controller.redeem,
    setMode: controller.setMode,
    lines: lineSnapshot.scope === scope ? lineSnapshot.lines : [],
    selectedLineId: lineSnapshot.scope === scope ? lineSnapshot.selectedLineId : null,
    linesBusy: lineSnapshot.scope === scope && lineSnapshot.busy,
    linesError: lineSnapshot.scope === scope ? lineSnapshot.error : null,
    setSelectedLineId: linesController.select, refreshLines: linesController.refresh, pingLine: linesController.ping,
  }
}

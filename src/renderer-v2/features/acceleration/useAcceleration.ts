import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { AccelerationClient } from './api'
import { createAccelerationController, createClockFreeSnapshotReader, type AccelerationSnapshot } from './controller'
import { createAccelerationLinesController } from './lines-controller'

const emptySnapshot: AccelerationSnapshot = { state: null, busy: false, error: null, mode: 'system-proxy' }

function subscribeNever() { return () => undefined }

/** Keep this hook in the app shell; leaving the page does not disconnect a session. */
export function useAcceleration(api: AccelerationClient, scope: string | null, active = true) {
  const controller = useMemo(() => createAccelerationController(api), [api])
  const linesController = useMemo(() => createAccelerationLinesController(api, () => {
    const current = controller.getSnapshot()
    return !current.busy && !['active', 'connecting', 'stopping'].includes(current.state?.phase ?? '')
  }), [api, controller])
  const lifetime = useMemo(() => ({ consumers: 0 }), [controller, linesController])
  // 这个钩子挂在整个应用的最外层：订阅会每秒走表的快照，开着加速时整个界面就每秒重画一遍。
  // 外层只拿不带走表的那份，秒数由加速页自己用 useLiveAccelerationState 订阅。
  const readClockFree = useMemo(() => createClockFreeSnapshotReader(controller.getSnapshot), [controller])
  const snapshot = useSyncExternalStore(controller.subscribe, readClockFree)
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
    subscribeLive: controller.subscribe,
    getLiveSnapshot: controller.getSnapshot,
    refresh: controller.refresh,
    start: (lineId?: string, ignoreConflicts?: boolean) => linesController.getSnapshot().busy ? Promise.resolve() : controller.start(lineId, ignoreConflicts),
    stop: controller.stop,
    redeem: controller.redeem,
    // 只有加速文件坏了的那次运行主进程才给这个方法；没有时按「还是坏的」回答。
    recheckBundle: () => api.recheckAccelerationBundle ? api.recheckAccelerationBundle() : Promise.resolve('damaged' as const),
    setMode: controller.setMode,
    lines: lineSnapshot.scope === scope ? lineSnapshot.lines : [],
    selectedLineId: lineSnapshot.scope === scope ? lineSnapshot.selectedLineId : null,
    rememberedLine: lineSnapshot.scope === scope && lineSnapshot.remembered,
    linesBusy: lineSnapshot.scope === scope && lineSnapshot.busy,
    linesError: lineSnapshot.scope === scope ? lineSnapshot.error : null,
    setSelectedLineId: linesController.select, refreshLines: linesController.refresh, pingLine: linesController.ping,
  }
}

/**
 * 加速页显示剩余时长和本次连接时长，要跟着每秒走；只在这里订阅走表的快照，重画就只到加速页为止。
 * `live` 为 false（加速页藏在后面）时不订阅，秒数等切回来再补上。
 */
export function useLiveAccelerationState(connection: Pick<ReturnType<typeof useAcceleration>, 'snapshot' | 'subscribeLive' | 'getLiveSnapshot'>, live = true) {
  const current = useSyncExternalStore(live ? connection.subscribeLive : subscribeNever, connection.getLiveSnapshot)
  const stable = connection.snapshot.state
  // 外层已按账号把别人的状态换成空快照；这里只在同一账号时才拿走表的那份替上。
  return stable && current.state?.scope === stable.scope ? current.state : stable
}

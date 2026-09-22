import type { AccelerationClient, AccelerationLine, AccelerationPreference, AccelerationPreferenceUpdate } from './api'
import { errorMessage } from '../../business-common'

interface LinesSnapshot {
  scope: string | null
  lines: AccelerationLine[]
  selectedLineId: string | null
  /** 当前选中的这条是从落盘的偏好里恢复的，不是这次会话里手选的。 */
  remembered: boolean
  busy: boolean
  error: string | null
}

/** Account epochs isolate metadata as well as the connection/allowance state. */
export function createAccelerationLinesController(api: AccelerationClient, canSelect: () => boolean) {
  let snapshot: LinesSnapshot = { scope: null, lines: [], selectedLineId: null, remembered: false, busy: false, error: null }
  let epoch = 0
  let disposed = false
  let flight: Promise<void> | null = null
  // 落盘的线路只在拿到第一份列表时套用一次。之后的刷新沿用界面上的选择：偏好的
  // 写入是异步的，再读一次会让「刚选完就刷新」读到上一次的值，把选择又弹回去。
  let restored = false
  const listeners = new Set<() => void>()

  function publish(update: Partial<LinesSnapshot>) {
    snapshot = { ...snapshot, ...update }
    for (const listener of listeners) listener()
  }

  /** 记不住不该影响这一次选择，所以失败只丢掉，界面照常。 */
  function remember(scope: string, update: AccelerationPreferenceUpdate) {
    void Promise.resolve().then(() => api.saveAccelerationPreference?.(scope, update)).catch(() => undefined)
  }

  function readPreference(scope: string): Promise<AccelerationPreference | null> {
    return Promise.resolve().then(() => api.getAccelerationPreference?.(scope) ?? null).catch(() => null)
  }

  function request(lineId?: string): Promise<void> {
    if (disposed || !snapshot.scope) return Promise.resolve()
    // One probe/list request at a time; repeated clicks cannot queue cores or
    // let an older list erase a newer delay measurement.
    if (flight) return flight
    if (lineId !== undefined && (!canSelect() || !snapshot.lines.some(line => line.id === lineId))) return Promise.resolve()
    const scope = snapshot.scope
    const requestEpoch = epoch
    const current = () => !disposed && epoch === requestEpoch && snapshot.scope === scope
    publish({ busy: true, error: null })
    const operation = Promise.resolve().then(async () => {
      if (!current()) return
      try {
        if (lineId === undefined) {
          const [lines, preference] = await Promise.all([
            api.listAccelerationLines?.(scope) ?? [],
            restored ? Promise.resolve(null) : readPreference(scope),
          ])
          if (!current()) return
          const wanted = restored ? snapshot.selectedLineId : preference?.lineId ?? null
          const selectedLineId = wanted !== null && lines.some(line => line.id === wanted) ? wanted : null
          publish({ lines, selectedLineId, remembered: selectedLineId !== null && (restored ? snapshot.remembered : true) })
          // 记住的那条线路已经不在名单里：回退智能分配，并把记录清掉，免得下次
          // 打开、以及托盘一键连接时又去要一条早就下线的线路。
          if (!restored && wanted !== null && selectedLineId === null) remember(scope, { lineId: null })
          restored = true
        } else {
          const updated = await api.pingAccelerationLine?.(scope, lineId)
          if (current() && updated) {
            if (updated.id !== lineId) throw new Error('线路检测结果不匹配，请重新检测。')
            publish({ lines: snapshot.lines.map(line => line.id === updated.id ? updated : line)
              .sort((left, right) => (left.latencyMs ?? Infinity) - (right.latencyMs ?? Infinity)) })
          }
        }
      } catch (cause) {
        if (current()) publish({ error: errorMessage(cause, '线路读取或检测失败，请重试。').slice(0, 300) })
      } finally {
        if (current() && flight === operation) { flight = null; publish({ busy: false }) }
      }
    })
    flight = operation
    return operation
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setScope(scope: string | null) {
      if (disposed || scope === snapshot.scope) return
      epoch++
      flight = null
      restored = false
      publish({ scope, lines: [], selectedLineId: null, remembered: false, busy: false, error: null })
      if (scope) void request()
    },
    refresh: () => request(),
    ping: (lineId: string) => request(lineId),
    select(lineId: string | null) {
      if (disposed || !snapshot.scope || snapshot.busy || !canSelect()) return
      if (lineId !== null && !snapshot.lines.some(line => line.id === lineId)) return
      publish({ selectedLineId: lineId, remembered: false })
      // 「智能分配」也是一次选择：记成 null，与「从没选过」对连接来说等价，但
      // 用户改回自动之后托盘不会再去连他刚刚放弃的那条线路。
      remember(snapshot.scope, { lineId })
    },
    dispose() { disposed = true; epoch++; flight = null; listeners.clear() },
  }
}

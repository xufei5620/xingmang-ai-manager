import type { AccelerationApi, AccelerationLine } from './api'
import { errorMessage } from '../../business-common'

interface LinesSnapshot {
  scope: string | null
  lines: AccelerationLine[]
  selectedLineId: string | null
  busy: boolean
  error: string | null
}

/** Account epochs isolate metadata as well as the connection/allowance state. */
export function createAccelerationLinesController(api: AccelerationApi, canSelect: () => boolean) {
  let snapshot: LinesSnapshot = { scope: null, lines: [], selectedLineId: null, busy: false, error: null }
  let epoch = 0
  let disposed = false
  let flight: Promise<void> | null = null
  const listeners = new Set<() => void>()

  function publish(update: Partial<LinesSnapshot>) {
    snapshot = { ...snapshot, ...update }
    for (const listener of listeners) listener()
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
          const lines = await api.listAccelerationLines?.(scope) ?? []
          if (current()) publish({ lines, selectedLineId: lines.some(line => line.id === snapshot.selectedLineId) ? snapshot.selectedLineId : null })
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
      publish({ scope, lines: [], selectedLineId: null, busy: false, error: null })
      if (scope) void request()
    },
    refresh: () => request(),
    ping: (lineId: string) => request(lineId),
    select(lineId: string | null) {
      if (disposed || !snapshot.scope || snapshot.busy || !canSelect()) return
      if (lineId === null || snapshot.lines.some(line => line.id === lineId)) publish({ selectedLineId: lineId })
    },
    dispose() { disposed = true; epoch++; flight = null; listeners.clear() },
  }
}

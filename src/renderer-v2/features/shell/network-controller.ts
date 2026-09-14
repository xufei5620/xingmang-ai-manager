import type { AccelerationState } from '../../../../electron/acceleration-contract'
import type { SystemSnapshot } from '../../../../electron/ipc-contract'

export type NetworkLocation = SystemSnapshot['network']

export interface NetworkLocationApi {
  refreshNetworkLocation(): Promise<NetworkLocation>
}

export interface NetworkLocationSnapshot {
  network: NetworkLocation | null
  busy: boolean
}

export interface NetworkLocationController {
  subscribe(listener: () => void): () => void
  getSnapshot(): NetworkLocationSnapshot
  setConnection(state: AccelerationState | null): void
  refresh(): Promise<void>
  dispose(): void
}

interface Connection {
  kind: 'disconnected' | 'connecting' | 'connected' | 'uncertain'
  key: string
  scope: string | null
}

const unknownMessage = '暂时无法确认网络位置，请稍后刷新。'

function unknownNetwork(): NetworkLocation {
  return { publicIp: null, countryCode: null, region: 'unknown', checkedAt: new Date().toISOString(), error: unknownMessage }
}

function projectNetwork(network: NetworkLocation): NetworkLocation {
  if (!network || !['mainland-china', 'outside-mainland-china'].includes(network.region)
    || typeof network.countryCode !== 'string' || !/^[a-z]{2}$/i.test(network.countryCode)
    || typeof network.checkedAt !== 'string' || !Number.isFinite(Date.parse(network.checkedAt))) return unknownNetwork()
  return {
    publicIp: typeof network.publicIp === 'string' && /^[\da-f:.]{3,64}$/i.test(network.publicIp) ? network.publicIp : null,
    countryCode: network.countryCode.toUpperCase(),
    region: network.region,
    checkedAt: network.checkedAt,
    error: network.error ? unknownMessage : null,
  }
}

function describeConnection(state: AccelerationState | null, previous: Connection | null): Connection {
  if (!state || ['idle', 'exhausted', 'unavailable'].includes(state.phase)) {
    return { kind: 'disconnected', key: 'disconnected', scope: null }
  }
  if (state.phase === 'error' && !state.connectedAt
    && previous?.kind === 'connected' && previous.scope === state.scope) {
    // An unsuccessful stop or status read cannot confirm that the host restored
    // the direct route. Retain the established connection until it confirms it.
    return previous
  }
  const kind = state.phase === 'connecting' ? 'connecting'
    : state.phase === 'error' && !state.connectedAt ? 'uncertain' : 'connected'
  return {
    kind, scope: state.scope,
    key: JSON.stringify([kind, state.scope, state.mode, state.connectedAt, state.line?.id ?? null]),
  }
}

/** Tracks route changes independently of acceleration timer and status updates. */
export function createNetworkLocationController(api: NetworkLocationApi): NetworkLocationController {
  let snapshot: NetworkLocationSnapshot = { network: null, busy: false }
  let connection: Connection | null = null
  let generation = 0
  let disposed = false
  let inFlight: { generation: number; promise: Promise<void> } | null = null
  const listeners = new Set<() => void>()

  function publish(next: NetworkLocationSnapshot) {
    if (disposed) return
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  function refresh(): Promise<void> {
    if (disposed || connection?.kind === 'connecting') return Promise.resolve()
    if (inFlight?.generation === generation) return inFlight.promise
    const requestGeneration = generation
    publish({ ...snapshot, busy: true })
    // Schedule through a Promise so synchronous bridge failures follow the same
    // sanitized error path and the in-flight handle exists before completion.
    const promise = Promise.resolve().then(async () => {
      if (disposed || requestGeneration !== generation) return
      try {
        const network = await api.refreshNetworkLocation()
        if (!disposed && requestGeneration === generation) publish({ network: projectNetwork(network), busy: false })
      } catch {
        if (!disposed && requestGeneration === generation) publish({ network: unknownNetwork(), busy: false })
      }
    }).finally(() => {
      if (inFlight?.generation === requestGeneration) inFlight = null
    })
    inFlight = { generation: requestGeneration, promise }
    return promise
  }

  return {
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    setConnection(state) {
      if (disposed) return
      const previous = connection
      const next = describeConnection(state, previous)
      connection = next
      if (next.key === previous?.key) return
      // The ordinary initial system snapshot already includes location. Only a
      // connection or an actual transition needs another network probe.
      if (!previous && next.kind === 'disconnected') return
      generation += 1
      inFlight = null
      publish({ network: null, busy: true })
      if (next.kind !== 'connecting') void refresh()
    },
    refresh,
    dispose() {
      disposed = true
      generation += 1
      inFlight = null
      listeners.clear()
    },
  }
}

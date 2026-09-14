import { describe, expect, it, vi } from 'vitest'
import type { AccelerationState } from '../../../../electron/acceleration-contract'
import { createNetworkLocationController, type NetworkLocation, type NetworkLocationApi } from './network-controller'

function state(overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope: 'xm-account:1', phase: 'idle', mode: 'system-proxy', totalSeconds: 3600,
    remainingSeconds: 3600, sessionSeconds: 0, measuredAt: '2026-09-14T00:00:00Z',
    connectedAt: null, line: null, error: null, ...overrides,
  }
}

function active(overrides: Partial<AccelerationState> = {}) {
  return state({
    phase: 'active', connectedAt: '2026-09-14T00:00:00Z',
    line: { id: 'line-a', name: '线路 A', region: 'JP', latencyMs: 30 }, ...overrides,
  })
}

function location(countryCode = 'JP', publicIp = '203.0.113.1'): NetworkLocation {
  return { countryCode, publicIp, region: 'outside-mainland-china', checkedAt: '2026-09-14T00:00:00Z', error: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const api = { refreshNetworkLocation: vi.fn<NetworkLocationApi['refreshNetworkLocation']>().mockResolvedValue(location()) }
  return { api, controller: createNetworkLocationController(api) }
}

describe('network location controller', () => {
  it('leaves the initial location to the ordinary system snapshot without repeated reads', async () => {
    const { api, controller } = setup()
    controller.setConnection(null)
    controller.setConnection(state({ phase: 'unavailable' }))
    controller.setConnection(state())
    await Promise.resolve()
    expect(api.refreshNetworkLocation).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toEqual({ network: null, busy: false })
    expect(controller.getSnapshot()).toBe(controller.getSnapshot())
  })

  it('clears the previous location while connecting and probes only once connected', async () => {
    const { api, controller } = setup()
    controller.setConnection(state())
    await controller.refresh()
    controller.setConnection(state({ phase: 'connecting' }))
    expect(controller.getSnapshot()).toEqual({ network: null, busy: true })
    await controller.refresh()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(1)
    controller.setConnection(active())
    await controller.refresh()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toEqual({ network: location(), busy: false })
  })

  it('ignores countdown, measurement, error text and line display updates on the same connection', async () => {
    const { api, controller } = setup()
    controller.setConnection(active())
    await controller.refresh()
    const snapshot = controller.getSnapshot()
    for (let seconds = 1; seconds <= 30; seconds += 1) {
      controller.setConnection(active({
        remainingSeconds: 3600 - seconds, sessionSeconds: seconds,
        measuredAt: `2026-09-14T00:00:${String(seconds).padStart(2, '0')}Z`, error: '状态更新',
        line: { id: 'line-a', name: '新名称', region: 'SG', latencyMs: seconds },
      }))
    }
    await Promise.resolve()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toBe(snapshot)
  })

  it('remeasures each actual session, mode, account or line change', async () => {
    const { api, controller } = setup()
    let current = active()
    controller.setConnection(current)
    await controller.refresh()
    const changes: Partial<AccelerationState>[] = [
      { connectedAt: '2026-09-14T00:01:00Z' },
      { mode: 'tun' },
      { scope: 'api-account:2' },
      { line: { id: 'line-b', name: '线路 B', region: 'US', latencyMs: 40 } },
    ]
    for (const change of changes) {
      current = { ...current, ...change }
      controller.setConnection(current)
      expect(controller.getSnapshot()).toEqual({ network: null, busy: true })
      await controller.refresh()
    }
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(5)
  })

  it('retains a connection during stopping and remeasures only after confirmed disconnection', async () => {
    const { api, controller } = setup()
    controller.setConnection(active())
    await controller.refresh()
    controller.setConnection(active({ phase: 'stopping' }))
    await Promise.resolve()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().network).toEqual(location())
    api.refreshNetworkLocation.mockResolvedValueOnce(location('CN', '198.51.100.1'))
    controller.setConnection(state())
    await controller.refresh()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().network?.countryCode).toBe('CN')
  })

  it.each(['exhausted', 'unavailable', null] as const)('remeasures after ending an active session with %s', async (phase) => {
    const { api, controller } = setup()
    controller.setConnection(active())
    await controller.refresh()
    controller.setConnection(phase === null ? null : state({ phase }))
    await controller.refresh()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(2)
  })

  it('does not infer a direct route from uncertain stop or status errors', async () => {
    const { api, controller } = setup()
    controller.setConnection(active())
    await controller.refresh()
    controller.setConnection(state({ phase: 'error', error: '停止状态无法确认' }))
    await Promise.resolve()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().network).toEqual(location())
    controller.setConnection(active())
    await Promise.resolve()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(1)
    await controller.refresh()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(2)
    controller.setConnection(state())
    await controller.refresh()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(3)
  })

  it('remeasures the actual route after a failed connection attempt', async () => {
    const { api, controller } = setup()
    controller.setConnection(state({ phase: 'connecting' }))
    controller.setConnection(state())
    await controller.refresh()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().busy).toBe(false)
  })

  it('drops a late pre-connection response instead of displaying the old route during connection', async () => {
    const { api, controller } = setup()
    const pending = deferred<NetworkLocation>()
    api.refreshNetworkLocation.mockReturnValueOnce(pending.promise)
    const oldRead = controller.refresh()
    await Promise.resolve()
    controller.setConnection(state({ phase: 'connecting' }))
    pending.resolve(location('CN', '198.51.100.1'))
    await oldRead
    expect(controller.getSnapshot()).toEqual({ network: null, busy: true })
    controller.setConnection(active())
    await controller.refresh()
    expect(controller.getSnapshot().network).toEqual(location())
  })

  it('drops responses from older sessions even if they finish last', async () => {
    const { api, controller } = setup()
    const pending = deferred<NetworkLocation>()
    api.refreshNetworkLocation.mockReturnValueOnce(pending.promise)
    controller.setConnection(active())
    const oldRead = controller.refresh()
    await Promise.resolve()
    controller.setConnection(active({ scope: 'api-account:2', mode: 'tun' }))
    await controller.refresh()
    pending.resolve(location('CN', '198.51.100.1'))
    await oldRead
    expect(controller.getSnapshot().network).toEqual(location())
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(2)
  })

  it('coalesces manual refreshes and recovers from failures without exposing raw host errors', async () => {
    const { api, controller } = setup()
    const pending = deferred<NetworkLocation>()
    api.refreshNetworkLocation.mockReturnValueOnce(pending.promise)
    const first = controller.refresh()
    expect(controller.refresh()).toBe(first)
    await Promise.resolve()
    pending.reject(new Error('private-upstream-token=secret'))
    await first
    expect(controller.getSnapshot()).toMatchObject({ busy: false, network: {
      countryCode: null, publicIp: null, region: 'unknown', error: '暂时无法确认网络位置，请稍后刷新。',
    } })
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('private-upstream-token')
    await controller.refresh()
    expect(controller.getSnapshot()).toEqual({ network: location(), busy: false })
  })

  it('projects only network fields and hides raw error strings from successful IPC responses', async () => {
    const { api, controller } = setup()
    api.refreshNetworkLocation.mockResolvedValueOnce({
      ...location(), error: 'private-upstream-token=secret', privateNode: 'private-upstream-token=secret',
    } as NetworkLocation)
    await controller.refresh()
    expect(controller.getSnapshot().network).toEqual({ ...location(), error: '暂时无法确认网络位置，请稍后刷新。' })
    api.refreshNetworkLocation.mockResolvedValueOnce({ ...location(), region: 'unknown', error: 'private-upstream-token=secret' })
    await controller.refresh()
    expect(controller.getSnapshot().network).toMatchObject({ region: 'unknown', countryCode: null, publicIp: null })
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('private-upstream-token')
  })

  it('ignores a disposed pending request and never starts new requests after disposal', async () => {
    const { api, controller } = setup()
    const pending = deferred<NetworkLocation>()
    api.refreshNetworkLocation.mockReturnValueOnce(pending.promise)
    const read = controller.refresh()
    await Promise.resolve()
    const listener = vi.fn()
    controller.subscribe(listener)
    const snapshot = controller.getSnapshot()
    controller.dispose()
    pending.resolve(location())
    await read
    controller.setConnection(active())
    await controller.refresh()
    expect(controller.getSnapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
    expect(api.refreshNetworkLocation).toHaveBeenCalledTimes(1)
  })

  it('does not send already-obsolete queued probes after disposal or a connection transition', async () => {
    const disposed = setup()
    const read = disposed.controller.refresh()
    disposed.controller.dispose()
    await read
    expect(disposed.api.refreshNetworkLocation).not.toHaveBeenCalled()
    const switching = setup()
    const oldRead = switching.controller.refresh()
    switching.controller.setConnection(state({ phase: 'connecting' }))
    await oldRead
    expect(switching.api.refreshNetworkLocation).not.toHaveBeenCalled()
  })
})

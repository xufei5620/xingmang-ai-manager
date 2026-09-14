import { describe, expect, it, vi } from 'vitest'
import type { AccelerationApi, AccelerationLine } from './api'
import { createAccelerationLinesController } from './lines-controller'

const firstScope = 'xm-account:1'
const secondScope = 'api-account:2'
const line: AccelerationLine = { id: 'line-1', name: '日本线路', region: 'JP', latencyMs: null }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  let selectable = true
  const api: AccelerationApi = {
    getAccelerationState: vi.fn(), startAcceleration: vi.fn(), stopAcceleration: vi.fn(),
    listAccelerationLines: vi.fn(async () => [line]),
    pingAccelerationLine: vi.fn(async () => ({ ...line, latencyMs: 32 })),
  }
  const controller = createAccelerationLinesController(api, () => selectable)
  return { api, controller, lock: () => { selectable = false } }
}

describe('acceleration line selection lifecycle', () => {
  it('discards a late line list after account change and immediately resets selection', async () => {
    const { api, controller } = setup()
    controller.setScope(firstScope)
    await controller.refresh()
    controller.select(line.id)
    const pending = deferred<AccelerationLine[]>()
    vi.mocked(api.listAccelerationLines!).mockReturnValueOnce(pending.promise)
    const old = controller.refresh()
    await Promise.resolve()
    controller.setScope(secondScope)
    expect(controller.getSnapshot()).toMatchObject({ lines: [], selectedLineId: null })
    await controller.refresh()
    pending.resolve([{ ...line, name: '旧账号线路' }])
    await old
    expect(controller.getSnapshot()).toMatchObject({ scope: secondScope, lines: [line], busy: false })
  })

  it('discards old ping failures after logout and relogin of the same account', async () => {
    const { api, controller } = setup()
    controller.setScope(firstScope)
    await controller.refresh()
    const pending = deferred<AccelerationLine>()
    vi.mocked(api.pingAccelerationLine!).mockReturnValueOnce(pending.promise)
    const ping = controller.ping(line.id)
    await Promise.resolve()
    controller.setScope(null)
    expect(controller.getSnapshot()).toMatchObject({ lines: [], selectedLineId: null, busy: false })
    controller.setScope(firstScope)
    await controller.refresh()
    pending.reject(new Error('旧检测失败'))
    await ping
    expect(controller.getSnapshot()).toMatchObject({ lines: [line], error: null, busy: false })
  })

  it('deduplicates probes and prevents a refresh from erasing the measured latency', async () => {
    const { api, controller } = setup()
    controller.setScope(firstScope)
    await controller.refresh()
    const pending = deferred<AccelerationLine>()
    vi.mocked(api.pingAccelerationLine!).mockReturnValueOnce(pending.promise)
    const ping = controller.ping(line.id)
    expect(controller.ping(line.id)).toBe(ping)
    expect(controller.refresh()).toBe(ping)
    expect(controller.getSnapshot().busy).toBe(true)
    controller.select(line.id)
    expect(controller.getSnapshot().selectedLineId).toBeNull()
    pending.resolve({ ...line, latencyMs: 15 })
    await ping
    expect(api.pingAccelerationLine).toHaveBeenCalledTimes(1)
    expect(api.listAccelerationLines).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ lines: [{ ...line, latencyMs: 15 }], busy: false })
  })

  it('allows returning to automatic selection and locks selection/probes during a connection', async () => {
    const { api, controller, lock } = setup()
    controller.setScope(firstScope)
    await controller.refresh()
    controller.select(line.id)
    expect(controller.getSnapshot().selectedLineId).toBe(line.id)
    controller.select(null)
    expect(controller.getSnapshot().selectedLineId).toBeNull()
    lock()
    controller.select(line.id)
    await controller.ping(line.id)
    expect(controller.getSnapshot().selectedLineId).toBeNull()
    expect(api.pingAccelerationLine).not.toHaveBeenCalled()
  })

  it('ignores a response after disposal without emitting or retaining an error', async () => {
    const { api, controller } = setup()
    const pending = deferred<AccelerationLine[]>()
    vi.mocked(api.listAccelerationLines!).mockReturnValueOnce(pending.promise)
    controller.setScope(firstScope)
    const request = controller.refresh()
    await Promise.resolve()
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispose()
    pending.reject(new Error('迟到失败'))
    await request
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot().error).toBeNull()
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { AccelerationClient, AccelerationLine, AccelerationPreference, AccelerationPreferenceUpdate } from './api'
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
  const api: AccelerationClient = {
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

function withPreferences(stored: AccelerationPreference, lines: AccelerationLine[] = [line]) {
  let selectable = true
  const saved: AccelerationPreferenceUpdate[] = []
  const api: AccelerationClient = {
    getAccelerationState: vi.fn(), startAcceleration: vi.fn(), stopAcceleration: vi.fn(),
    listAccelerationLines: vi.fn(async () => lines),
    pingAccelerationLine: vi.fn(async () => ({ ...line, latencyMs: 32 })),
    getAccelerationPreference: vi.fn(async () => stored),
    saveAccelerationPreference: vi.fn(async (_scope: string, update: AccelerationPreferenceUpdate) => {
      saved.push(update)
      return { ...stored, ...update } as AccelerationPreference
    }),
  }
  return { api, saved, controller: createAccelerationLinesController(api, () => selectable), lock: () => { selectable = false } }
}

/** 等一拍，好让「选完就写回去」那个不被等待的写入跑完。 */
function settle() {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

describe('acceleration line memory', () => {
  it('selects the remembered line as soon as the list arrives', async () => {
    const { controller } = withPreferences({ lineId: line.id, mode: 'system-proxy' })
    controller.setScope(firstScope)
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ selectedLineId: line.id, remembered: true })
  })

  it('falls back to automatic and forgets a remembered line that is no longer offered', async () => {
    const { controller, saved } = withPreferences({ lineId: 'line-gone', mode: 'system-proxy' })
    controller.setScope(firstScope)
    await controller.refresh()
    await settle()
    expect(controller.getSnapshot()).toMatchObject({ selectedLineId: null, remembered: false })
    expect(saved).toEqual([{ lineId: null }])
  })

  it('stores every pick, 智能分配 included', async () => {
    const { controller, saved } = withPreferences({ lineId: null, mode: 'system-proxy' })
    controller.setScope(firstScope)
    await controller.refresh()
    controller.select(line.id)
    controller.select(null)
    await settle()
    expect(saved).toEqual([{ lineId: line.id }, { lineId: null }])
    expect(controller.getSnapshot().remembered).toBe(false)
  })

  // 写回是异步的：刷新时再读一次偏好，会把刚选的那条弹回上一次的值。
  it('keeps the just-picked line across a refresh instead of re-reading the stored one', async () => {
    const other: AccelerationLine = { id: 'line-2', name: '香港线路', region: 'HK', latencyMs: null }
    const { api, controller } = withPreferences({ lineId: line.id, mode: 'system-proxy' }, [line, other])
    controller.setScope(firstScope)
    await controller.refresh()
    controller.select(other.id)
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ selectedLineId: other.id, remembered: false })
    expect(api.getAccelerationPreference).toHaveBeenCalledTimes(1)
  })

  it('never lets a preference failure break the line list', async () => {
    const { api, controller } = withPreferences({ lineId: line.id, mode: 'system-proxy' })
    vi.mocked(api.getAccelerationPreference!).mockRejectedValueOnce(new Error('读偏好失败'))
    vi.mocked(api.saveAccelerationPreference!).mockRejectedValueOnce(new Error('写偏好失败'))
    controller.setScope(firstScope)
    await controller.refresh()
    controller.select(line.id)
    await settle()
    expect(controller.getSnapshot()).toMatchObject({ lines: [line], selectedLineId: line.id, error: null, busy: false })
  })

  it('drops a remembered line that belongs to the account the user just left', async () => {
    const { controller } = withPreferences({ lineId: line.id, mode: 'system-proxy' })
    controller.setScope(firstScope)
    await controller.refresh()
    controller.setScope(secondScope)
    expect(controller.getSnapshot()).toMatchObject({ selectedLineId: null, remembered: false })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createToolRouteStatusBoard, toolRouteHijackNoticeTtlMs } from './tool-route-status'
import type { ToolRouteSnapshot } from './tool-route-controller'

function snapshot(overrides: Partial<ToolRouteSnapshot> = {}): ToolRouteSnapshot {
  return { line: 'direct', automatic: true, serverSwitching: false, outage: null, lastChange: null, ...overrides }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('createToolRouteStatusBoard', () => {
  it('shows nothing while the tool line is fine and a quiet line while the server is switching', () => {
    const board = createToolRouteStatusBoard({ appReachable: async () => true, changed: vi.fn() })
    expect(board.status(snapshot())).toBeUndefined()
    expect(board.status(snapshot({ serverSwitching: true }))).toEqual({ serverSwitching: true })
  })

  it('shows the outage from the notice until the lines come back, saying whether the app itself still connects', async () => {
    const changed = vi.fn()
    let clock = 1_000
    const board = createToolRouteStatusBoard({ appReachable: async () => true, changed, now: () => clock })
    const down = snapshot({ outage: { reason: 'certificate', since: 900 } })
    // 控制器在限频内没叫提示：只有状态，不给提示。
    expect(board.status(down)).toBeUndefined()

    board.notice({ kind: 'outage', reason: 'certificate' })
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(board.status(down)).toEqual({ outage: { id: 1_000, reason: 'certificate', appReachable: true } })

    clock = 2_000
    board.update(down)
    expect(changed).toHaveBeenCalledTimes(1)
    board.update(snapshot())
    expect(changed).toHaveBeenCalledTimes(2)
    expect(board.status(snapshot())).toBeUndefined()
    // 又全挂了，快照有了原因，但这次没到提示的时候：不再给。
    expect(board.status(down)).toBeUndefined()
  })

  it('drops a reachability answer that comes back after the lines recovered', async () => {
    const changed = vi.fn()
    const answer = deferred<boolean>()
    const board = createToolRouteStatusBoard({ appReachable: () => answer.promise, changed })
    board.notice({ kind: 'outage', reason: 'reset' })
    board.update(snapshot())
    answer.resolve(false)
    await answer.promise
    await Promise.resolve()
    expect(changed).not.toHaveBeenCalled()
    expect(board.status(snapshot({ outage: { reason: 'reset', since: 1 } }))).toBeUndefined()
  })

  it('counts an unanswerable reachability check as the app not connecting either', async () => {
    const changed = vi.fn()
    const board = createToolRouteStatusBoard({ appReachable: async () => { throw new Error('offline') }, changed, now: () => 5 })
    board.notice({ kind: 'outage', reason: 'dns' })
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(board.status(snapshot({ outage: { reason: 'dns', since: 1 } }))).toEqual({ outage: { id: 5, reason: 'dns', appReachable: false } })
  })

  it('keeps the hijack notice for half an hour', () => {
    const changed = vi.fn()
    let clock = 10_000
    const board = createToolRouteStatusBoard({ appReachable: async () => true, changed, now: () => clock })
    board.notice({ kind: 'hijack', line: 'direct' })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(board.status(snapshot({ line: 'primary' }))).toEqual({ hijack: { id: 10_000 } })
    clock += toolRouteHijackNoticeTtlMs
    expect(board.status(snapshot({ line: 'primary' }))).toBeUndefined()
  })
})

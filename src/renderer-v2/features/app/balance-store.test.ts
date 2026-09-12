import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountBalance } from '../../../../electron/ipc-contract'
import { createAccountBalanceStore, type AccountBalanceStore } from './balance-store'

const balance = (displayAmount: number): AccountBalance => ({
  quota: displayAmount * 500_000, usedQuota: 0, quotaPerUnit: 500_000,
  quotaDisplayType: 'USD', usdExchangeRate: 7.3, displayAmount,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('shared account balance refresh', () => {
  const stores: AccountBalanceStore[] = []
  function create(read = vi.fn<() => Promise<AccountBalance>>().mockResolvedValue(balance(100))) {
    const store = createAccountBalanceStore({ read })
    stores.push(store)
    return { store, read }
  }
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T00:00:00Z')) })
  afterEach(() => { stores.splice(0).forEach((store) => store.dispose()); vi.useRealTimers() })

  it('loads once per account scope and shares a stable snapshot across subscribers', async () => {
    const { store, read } = create()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    const initial = store.getSnapshot()
    expect(store.getSnapshot()).toBe(initial)
    expect(read).not.toHaveBeenCalled()
    store.setScope('new-api:1')
    store.setScope('new-api:1')
    const first = store.refresh()
    expect(store.refresh('manual')).toBe(first)
    await first
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ scope: 'new-api:1', balance: balance(100), loading: false, error: null, updatedAt: Date.now() })
    expect(store.getSnapshot()).toBe(store.getSnapshot())
    unsubscribe()
    listener.mockClear()
    await store.refresh()
    expect(listener).not.toHaveBeenCalled()
  })

  it('polls every 30 seconds while visible, pauses when hidden and refreshes on return', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    store.setVisible(false)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().balance).toEqual(balance(100))
    store.setVisible(true)
    await store.refresh('foreground')
    expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('reuses a successful balance for five seconds on focus but manual refresh bypasses the window', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    await vi.advanceTimersByTimeAsync(4_999)
    await store.refresh('foreground')
    store.setVisible(false)
    store.setVisible(true)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await store.refresh('foreground')
    expect(read).toHaveBeenCalledTimes(2)
    await store.refresh('manual')
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('retains the last balance and update time after failures, then clears the error on recovery', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    const lastUpdate = store.getSnapshot().updatedAt
    read.mockRejectedValueOnce(new Error('Failed to fetch'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.getSnapshot()).toMatchObject({ balance: balance(100), updatedAt: lastUpdate, loading: false, error: '余额暂时没有读到，请检查网络后重试。' })
    read.mockResolvedValue(balance(90))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ balance: balance(90), updatedAt: Date.now(), error: null })
  })

  it('does not surface obsolete-read errors or destroy the previously displayed amount', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    read.mockRejectedValueOnce(new Error("Error invoking remote method 'account:get-balance': Error: 账号上下文已变化，请重试"))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ balance: balance(100), error: null, loading: false })
  })

  it('coalesces concurrent refreshes and reads again after an in-flight payment mutation', async () => {
    const oldRead = deferred<AccountBalance>()
    const nextRead = deferred<AccountBalance>()
    const { store, read } = create(vi.fn<() => Promise<AccountBalance>>().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(nextRead.promise))
    store.setScope('new-api:1')
    const initial = store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    const mutation = store.refresh('mutation')
    expect(store.refresh('mutation')).toBe(mutation)
    expect(store.refresh('manual')).toBe(initial)
    expect(read).toHaveBeenCalledTimes(1)
    oldRead.resolve(balance(100))
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().loading).toBe(true)
    nextRead.resolve(balance(110))
    await mutation
    expect(store.getSnapshot()).toMatchObject({ balance: balance(110), loading: false })
  })

  it('retries the post-mutation read even if the earlier in-flight read fails', async () => {
    const oldRead = deferred<AccountBalance>()
    const { store, read } = create(vi.fn<() => Promise<AccountBalance>>().mockReturnValueOnce(oldRead.promise).mockResolvedValue(balance(110)))
    store.setScope('new-api:1')
    await vi.advanceTimersByTimeAsync(0)
    const mutation = store.refresh('mutation')
    oldRead.reject(new Error('network failed'))
    await mutation
    expect(read).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toMatchObject({ balance: balance(110), loading: false, error: null })
  })

  it('debounces completed generations for two seconds and ignores another account activity', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    store.scheduleActivity('sub2api:1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(read).toHaveBeenCalledTimes(1)
    store.scheduleActivity('new-api:1')
    await vi.advanceTimersByTimeAsync(1_500)
    store.scheduleActivity('new-api:1')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('refreshes again when a generation completes during an older balance request', async () => {
    const oldRead = deferred<AccountBalance>()
    const { store, read } = create(vi.fn<() => Promise<AccountBalance>>().mockReturnValueOnce(oldRead.promise).mockResolvedValue(balance(90)))
    store.setScope('new-api:1')
    const initial = store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    store.scheduleActivity('new-api:1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(read).toHaveBeenCalledTimes(1)
    oldRead.resolve(balance(100))
    await initial
    expect(read).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().balance).toEqual(balance(90))
  })

  it('defers hidden activity and bypasses the five-second reuse window when returning', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    store.scheduleActivity('new-api:1')
    store.setVisible(false)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(read).toHaveBeenCalledTimes(1)
    store.setVisible(true)
    await store.refresh('foreground')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('waits the remaining delay if the user returns before an activity refresh is due', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    store.setVisible(false)
    store.scheduleActivity('new-api:1')
    await vi.advanceTimersByTimeAsync(1_000)
    store.setVisible(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('allows payment and manual refresh while hidden without starting hidden polling', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    store.setVisible(false)
    await store.refresh('foreground')
    await store.refresh('interval')
    expect(read).toHaveBeenCalledTimes(1)
    await store.refresh('mutation')
    await store.refresh('manual')
    expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it.each(['resolve', 'reject'] as const)('clears a switched account synchronously and discards its late %s', async (outcome) => {
    const oldRead = deferred<AccountBalance>()
    const newRead = deferred<AccountBalance>()
    const { store, read } = create(vi.fn<() => Promise<AccountBalance>>().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise))
    store.setScope('new-api:1')
    const previous = store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    store.scheduleActivity('new-api:1')
    store.setScope('sub2api:1')
    expect(store.getSnapshot()).toMatchObject({ scope: 'sub2api:1', balance: null, loading: true, updatedAt: null, error: null })
    const current = store.refresh()
    newRead.resolve(balance(200))
    await current
    if (outcome === 'resolve') oldRead.resolve(balance(100))
    else oldRead.reject(new Error('network failed'))
    await previous
    expect(store.getSnapshot()).toMatchObject({ scope: 'sub2api:1', balance: balance(200), loading: false, error: null })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('never reuses another account balance after a rapid switch back', async () => {
    const oldRead = deferred<AccountBalance>()
    const { store, read } = create(vi.fn<() => Promise<AccountBalance>>()
      .mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(balance(200)).mockResolvedValueOnce(balance(90)))
    store.setScope('new-api:1')
    const previous = store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    store.setScope('sub2api:1')
    await store.refresh()
    store.setScope('new-api:1')
    await store.refresh('foreground')
    oldRead.resolve(balance(100))
    await previous
    expect(read).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot()).toMatchObject({ scope: 'new-api:1', balance: balance(90) })
  })

  it('clears balance, pending refreshes and late results when logging out', async () => {
    const pending = deferred<AccountBalance>()
    const { store, read } = create()
    store.setScope('new-api:1')
    await store.refresh()
    read.mockReturnValueOnce(pending.promise)
    const request = store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    store.scheduleActivity('new-api:1')
    store.setScope(null)
    expect(store.getSnapshot()).toEqual({ scope: null, balance: null, loading: false, updatedAt: null, error: null })
    pending.resolve(balance(100))
    await request
    await vi.advanceTimersByTimeAsync(90_000)
    await store.refresh('mutation')
    expect(read).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().balance).toBeNull()
  })

  it('does not dispatch a queued read if its account changed before the microtask runs', async () => {
    const { store, read } = create()
    store.setScope('new-api:1')
    const previous = store.refresh()
    store.setScope(null)
    await previous
    expect(read).not.toHaveBeenCalled()
  })

  it('disposes timers and listeners and ignores an outstanding read', async () => {
    const pending = deferred<AccountBalance>()
    const { store, read } = create(vi.fn<() => Promise<AccountBalance>>().mockReturnValue(pending.promise))
    const listener = vi.fn()
    store.subscribe(listener)
    store.setScope('new-api:1')
    const request = store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    store.scheduleActivity('new-api:1')
    store.dispose()
    listener.mockClear()
    pending.resolve(balance(100))
    await request
    store.setVisible(false)
    store.setVisible(true)
    store.setScope('sub2api:1')
    store.scheduleActivity('sub2api:1')
    await store.refresh('mutation')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(listener).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(store.getSnapshot().balance).toBeNull()
  })
})

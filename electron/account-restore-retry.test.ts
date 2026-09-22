import { describe, expect, it, vi } from 'vitest'
import { accountRestoreRetryDelaysMs, createAccountRestoreRetry, resolveAccountRestoreRetryDelay } from './account-restore-retry'

function manualTimer() {
  const timers: { callback: () => void; ms: number; cleared: boolean; fired: boolean }[] = []
  return {
    timers,
    setTimer: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cleared: false, fired: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true },
    pending: () => timers.filter((timer) => !timer.cleared && !timer.fired),
    async fire() {
      for (const timer of timers.filter((entry) => !entry.cleared && !entry.fired)) {
        timer.fired = true
        timer.callback()
      }
      // Let the restore promise and its follow-up scheduling settle.
      for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    },
  }
}

describe('account restore retry', () => {
  it('backs off 30 seconds, 2 minutes, then every 5 minutes', () => {
    expect(accountRestoreRetryDelaysMs).toEqual([30_000, 120_000, 300_000])
    expect([0, 1, 2, 3, 10].map(resolveAccountRestoreRetryDelay)).toEqual([30_000, 120_000, 300_000, 300_000, 300_000])
  })

  it('keeps retrying while the login is kept and stops once a restore settles it', async () => {
    const timer = manualTimer()
    let stalled = true
    const failure = new Error('HTTP 503')
    const restore = vi.fn(async () => {
      if (restore.mock.calls.length < 3) throw failure
      stalled = false
      return true
    })
    const onFailure = vi.fn()
    const retry = createAccountRestoreRetry({ restore, stalled: () => stalled, onFailure, setTimer: timer.setTimer, clearTimer: timer.clearTimer })
    retry.schedule()
    retry.schedule()
    expect(timer.pending().map((entry) => entry.ms)).toEqual([30_000])
    await timer.fire()
    expect(timer.pending().map((entry) => entry.ms)).toEqual([120_000])
    await timer.fire()
    expect(timer.pending().map((entry) => entry.ms)).toEqual([300_000])
    await timer.fire()
    expect(restore).toHaveBeenCalledTimes(3)
    expect(onFailure.mock.calls).toEqual([[failure, 0], [failure, 1]])
    expect(timer.pending()).toEqual([])
  })

  it('does nothing when no login is waiting and stops when the user signs in meanwhile', async () => {
    const timer = manualTimer()
    let stalled = false
    const restore = vi.fn(async () => true)
    const retry = createAccountRestoreRetry({ restore, stalled: () => stalled, setTimer: timer.setTimer, clearTimer: timer.clearTimer })
    retry.schedule()
    expect(timer.pending()).toEqual([])
    stalled = true
    retry.schedule()
    stalled = false
    await timer.fire()
    expect(restore).not.toHaveBeenCalled()
    expect(timer.pending()).toEqual([])
  })

  it('never touches the account again after quitting starts', async () => {
    const timer = manualTimer()
    const restore = vi.fn(async () => true)
    const retry = createAccountRestoreRetry({ restore, stalled: () => true, setTimer: timer.setTimer, clearTimer: timer.clearTimer })
    retry.schedule()
    retry.dispose()
    await timer.fire()
    retry.schedule()
    expect(restore).not.toHaveBeenCalled()
    expect(timer.pending()).toEqual([])
  })
})

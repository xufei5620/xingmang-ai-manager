import { describe, expect, it, vi } from 'vitest'
import { createAccountStartupGate, type AccountStartupGateOptions } from './account-startup-gate'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function manualTimer() {
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = []
  return {
    timers,
    setTimer: (callback: () => void, ms: number) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true },
    fire: () => timers.filter((timer) => !timer.cleared).forEach((timer) => timer.callback()),
  }
}

function gate(overrides: Partial<AccountStartupGateOptions> & { settled: Promise<void> }) {
  const timer = manualTimer()
  const restoringAccount = vi.fn(() => ({ siteId: 'solov' as const, userId: 7 }))
  const created = createAccountStartupGate({
    budgetMs: 3000, offline: false, restoringAccount, setTimer: timer.setTimer, clearTimer: timer.clearTimer, ...overrides,
  })
  return { gate: created, timer, restoringAccount }
}

async function isReleased(promise: Promise<void>): Promise<boolean> {
  let released = false
  void promise.then(() => { released = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return released
}

describe('account startup gate', () => {
  it('releases the bootstrap reads when the restore finishes inside the budget, with nothing left pending', async () => {
    const restore = deferred()
    const { gate: subject, timer } = gate({ settled: restore.promise })
    expect(timer.timers[0].ms).toBe(3000)
    expect(await isReleased(subject.released)).toBe(false)
    restore.resolve()
    expect(await isReleased(subject.released)).toBe(true)
    expect(subject.pending()).toBe(false)
    expect(subject.releasedEarly()).toBe(false)
    expect(subject.restoringAccount()).toBeNull()
    expect(timer.timers[0].cleared).toBe(true)
  })

  it('stops waiting when the budget runs out and reports who is still being restored', async () => {
    const restore = deferred()
    const { gate: subject, timer } = gate({ settled: restore.promise })
    timer.fire()
    expect(await isReleased(subject.released)).toBe(true)
    expect(subject.pending()).toBe(true)
    expect(subject.releasedEarly()).toBe(true)
    expect(subject.restoringAccount()).toEqual({ siteId: 'solov', userId: 7 })
    restore.resolve()
    await Promise.resolve(); await Promise.resolve()
    expect(subject.pending()).toBe(false)
    expect(subject.restoringAccount()).toBeNull()
    expect(subject.releasedEarly()).toBe(true)
  })

  it('does not wait at all when the machine is known to be offline', async () => {
    const restore = deferred()
    const { gate: subject, timer } = gate({ settled: restore.promise, offline: true })
    expect(timer.timers).toHaveLength(0)
    expect(await isReleased(subject.released)).toBe(true)
    expect(subject.releasedEarly()).toBe(true)
  })

  it('treats a rejected restore as settled rather than blocking the splash forever', async () => {
    const { gate: subject } = gate({ settled: Promise.reject(new Error('restore failed')) })
    expect(await isReleased(subject.released)).toBe(true)
    expect(subject.pending()).toBe(false)
  })
})

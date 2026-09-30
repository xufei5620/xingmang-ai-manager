import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliHookEvent } from './cli-hook-events'
import { MAX_KEEP_AWAKE_MS, createCliKeepAwake, type SleepBlocker } from './cli-keep-awake'

afterEach(() => {
  vi.useRealTimers()
})

function event(partial: Partial<CliHookEvent>): CliHookEvent {
  return { tool: 'claude', event: 'started', session: 's', at: 0, ...partial }
}

function fakeBlocker() {
  let next = 1
  const running = new Set<number>()
  const calls: string[] = []
  const blocker: SleepBlocker = {
    start(type) {
      calls.push(`start:${type}`)
      running.add(next)
      return next++
    },
    stop(id) {
      calls.push(`stop:${id}`)
      running.delete(id)
    },
  }
  return { blocker, running, calls }
}

describe('createCliKeepAwake', () => {
  it('blocks automatic sleep only while a turn is running and lets the screen turn off', () => {
    const { blocker, running, calls } = fakeBlocker()
    const keepAwake = createCliKeepAwake({ blocker, now: () => 10 })
    keepAwake.observe(event({ event: 'started' }))
    expect(keepAwake.holding()).toBe(true)
    expect(calls).toEqual(['start:prevent-app-suspension'])
    keepAwake.observe(event({ event: 'finished' }))
    expect(keepAwake.holding()).toBe(false)
    expect(running.size).toBe(0)
    keepAwake.dispose()
  })

  it('holds one blocker for several tools and releases after the last one stops', () => {
    const { blocker, calls } = fakeBlocker()
    const keepAwake = createCliKeepAwake({ blocker, now: () => 10 })
    keepAwake.observe(event({ tool: 'claude', event: 'started' }))
    keepAwake.observe(event({ tool: 'gemini', event: 'started', session: '' }))
    keepAwake.observe(event({ tool: 'grok', event: 'started', session: 'g', turn: 'p1' }))
    keepAwake.observe(event({ tool: 'claude', event: 'failed', reason: 'busy' }))
    keepAwake.observe(event({ tool: 'gemini', event: 'ended', session: '' }))
    expect(keepAwake.holding()).toBe(true)
    keepAwake.observe(event({ tool: 'grok', event: 'cancelled', session: 'g', turn: 'p1' }))
    expect(keepAwake.holding()).toBe(false)
    expect(calls).toEqual(['start:prevent-app-suspension', 'stop:1'])
    keepAwake.dispose()
  })

  it('keeps holding while the tool waits for a permission answer', () => {
    const { blocker } = fakeBlocker()
    const keepAwake = createCliKeepAwake({ blocker, now: () => 10 })
    keepAwake.observe(event({ event: 'started' }))
    keepAwake.observe(event({ event: 'waiting' }))
    expect(keepAwake.holding()).toBe(true)
    keepAwake.observe(event({ event: 'ended' }))
    expect(keepAwake.holding()).toBe(false)
    keepAwake.dispose()
  })

  it('ignores a late cancel report from an earlier Grok turn but settles on a session-level one', () => {
    const { blocker } = fakeBlocker()
    const keepAwake = createCliKeepAwake({ blocker, now: () => 10 })
    keepAwake.observe(event({ tool: 'grok', session: 'g', turn: 'p2' }))
    keepAwake.observe(event({ tool: 'grok', event: 'cancelled', session: 'g', turn: 'p1' }))
    expect(keepAwake.holding()).toBe(true)
    // The session-end Stop has no prompt id.
    keepAwake.observe(event({ tool: 'grok', event: 'finished', session: 'g' }))
    expect(keepAwake.holding()).toBe(false)
    keepAwake.dispose()
  })

  it('never holds for Codex, which keeps itself awake', () => {
    const { blocker, calls } = fakeBlocker()
    const keepAwake = createCliKeepAwake({ blocker, now: () => 10 })
    keepAwake.observe(event({ tool: 'codex', event: 'finished', startedAt: 1 }))
    keepAwake.observe(event({ tool: 'codex', event: 'started' }))
    expect(calls).toEqual([])
    keepAwake.dispose()
  })

  it('gives up on a turn that never reports an end after the hold limit', () => {
    vi.useFakeTimers()
    let now = 0
    const { blocker, running } = fakeBlocker()
    const keepAwake = createCliKeepAwake({ blocker, now: () => now })
    keepAwake.observe(event({ tool: 'gemini', event: 'started', at: 0 }))
    now = MAX_KEEP_AWAKE_MS - 60_000
    vi.advanceTimersByTime(MAX_KEEP_AWAKE_MS - 60_000)
    expect(keepAwake.holding()).toBe(true)
    now = MAX_KEEP_AWAKE_MS
    vi.advanceTimersByTime(60_000)
    expect(keepAwake.holding()).toBe(false)
    expect(running.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    keepAwake.dispose()
  })

  it('does not start holding for a start record already past the limit', () => {
    const { blocker, calls } = fakeBlocker()
    const keepAwake = createCliKeepAwake({ blocker, now: () => MAX_KEEP_AWAKE_MS + 5 })
    keepAwake.observe(event({ at: 5 }))
    expect(calls).toEqual([])
    keepAwake.dispose()
  })

  it('survives a blocker that throws and releases on dispose', () => {
    const log = vi.fn()
    const failing = createCliKeepAwake({
      blocker: { start: () => { throw new Error('no power service') }, stop: vi.fn() },
      now: () => 10,
      log,
    })
    failing.observe(event({}))
    expect(failing.holding()).toBe(false)
    expect(log).toHaveBeenCalledWith('warn', 'cli-keep-awake.start-failed', expect.any(String), expect.any(Object))
    failing.dispose()

    const { blocker, running } = fakeBlocker()
    const keepAwake = createCliKeepAwake({ blocker, now: () => 10 })
    keepAwake.observe(event({}))
    keepAwake.dispose()
    expect(running.size).toBe(0)
    keepAwake.observe(event({}))
    expect(running.size).toBe(0)
  })
})

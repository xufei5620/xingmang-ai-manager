import { describe, expect, it, vi } from 'vitest'
import type { AccelerationPhase, AccelerationState } from './acceleration-contract'
import { claudeDesktopReleaseCause, createClaudeDesktopAccelerationCoordinator } from './claude-desktop-acceleration'

const scope = 'xm-account:7'
const connectedAt = '2026-10-24T08:00:00.000Z'

function stateOf(phase: AccelerationPhase, extra: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope,
    phase,
    mode: 'system-proxy',
    totalSeconds: 1200,
    remainingSeconds: 900,
    sessionSeconds: 0,
    measuredAt: '2026-10-24T08:00:00.000Z',
    connectedAt: phase === 'active' ? connectedAt : null,
    line: null,
    error: null,
    ...extra,
  }
}

const automatic = stateOf('active', { autoStartedBy: 'claude-desktop' })

function setup(options: {
  running?: Array<boolean | null>
  read?: AccelerationState
  connect?: () => Promise<AccelerationState>
  disconnected?: AccelerationState
  heldElsewhere?: (scope: string, connectedAt: string) => boolean
  timeoutMs?: number
  accountScope?: string | null
} = {}) {
  const timers: Array<() => void> = []
  const delays: number[] = []
  const answers = [...(options.running ?? [true])]
  const isDesktopRunning = vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]))
  let current = options.read ?? stateOf('idle')
  const readState = vi.fn(async () => current)
  const connect = vi.fn(options.connect ?? (async () => (current = automatic)))
  const disconnect = vi.fn(async (_scope: string, _connectedAt: string) => options.disconnected ?? stateOf('idle'))
  const log = vi.fn()
  const clock = { now: 1_000_000 }
  let accountScope = options.accountScope === undefined ? scope : options.accountScope
  const coordinator = createClaudeDesktopAccelerationCoordinator({
    getAccountScope: () => accountScope,
    readState,
    connect,
    disconnect,
    ...(options.heldElsewhere ? { heldElsewhere: options.heldElsewhere } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    now: () => clock.now,
    schedule: (callback, milliseconds) => {
      timers.push(callback)
      delays.push(milliseconds)
      return () => { if (timers.includes(callback)) timers.splice(timers.indexOf(callback), 1) }
    },
    log,
  })
  async function tick(advanceMs = 60_000) {
    const callback = timers.shift()
    if (!callback) throw new Error('no watch scheduled')
    clock.now += advanceMs
    const reads = readState.mock.calls.length
    callback()
    await vi.waitFor(() => { expect(readState.mock.calls.length).toBeGreaterThan(reads) })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    coordinator, isDesktopRunning, readState, connect, disconnect, log, timers, delays, tick,
    context: { isDesktopRunning },
    setState: (state: AccelerationState) => { current = state },
    setAccountScope: (next: string | null) => { accountScope = next },
  }
}

describe('claude desktop release cause', () => {
  it('lets go after two misses, ten unreadable checks or an hour, whichever comes first', () => {
    const hour = 60 * 60_000
    expect(claudeDesktopReleaseCause({ gone: 1, unknown: 9, heldMs: hour - 1 }, hour)).toBeNull()
    expect(claudeDesktopReleaseCause({ gone: 2, unknown: 0, heldMs: 0 }, hour)).toBe('desktop-exited')
    expect(claudeDesktopReleaseCause({ gone: 0, unknown: 10, heldMs: 0 }, hour)).toBe('desktop-unknown')
    expect(claudeDesktopReleaseCause({ gone: 0, unknown: 0, heldMs: hour }, hour)).toBe('hold-expired')
    // Exiting right at the hour reads better in the log as an exit.
    expect(claudeDesktopReleaseCause({ gone: 2, unknown: 0, heldMs: hour }, hour)).toBe('desktop-exited')
  })
})

describe('claude desktop acceleration coordinator', () => {
  it('connects as the Claude Desktop origin before the app is launched', async () => {
    const h = setup()
    await expect(h.coordinator.ensureConnected(h.context)).resolves.toEqual({ status: 'connected' })
    expect(h.connect).toHaveBeenCalledWith(scope, stateOf('idle'))
    expect(h.log).toHaveBeenCalledWith('info', 'acceleration.claude-desktop.connected', expect.any(String), undefined)
    expect(h.timers).toHaveLength(1)
    expect(h.coordinator.holds(scope, connectedAt)).toBe(true)
  })

  it('connects even when the free allowance is used up, and skips without an account or component', async () => {
    const exhausted = setup({ read: stateOf('exhausted', { remainingSeconds: 0 }) })
    await expect(exhausted.coordinator.ensureConnected(exhausted.context)).resolves.toEqual({ status: 'connected' })

    const withoutAccount = setup({ accountScope: null })
    await expect(withoutAccount.coordinator.ensureConnected(withoutAccount.context))
      .resolves.toEqual({ status: 'skipped', reason: 'no-account' })
    expect(withoutAccount.readState).not.toHaveBeenCalled()

    const unavailable = setup({ read: stateOf('unavailable', { remainingSeconds: null }) })
    await expect(unavailable.coordinator.ensureConnected(unavailable.context))
      .resolves.toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(unavailable.connect).not.toHaveBeenCalled()
  })

  it('never rejects, whatever the acceleration service does', async () => {
    const failing = setup({ connect: async () => { throw new Error('helper crashed') } })
    await expect(failing.coordinator.ensureConnected(failing.context))
      .resolves.toEqual({ status: 'skipped', reason: 'connect-failed' })
    const refused = setup({ connect: async () => stateOf('idle', { error: '检测到其他代理' }) })
    await expect(refused.coordinator.ensureConnected(refused.context))
      .resolves.toEqual({ status: 'skipped', reason: 'connect-failed' })
    expect(refused.timers).toHaveLength(0)
  })

  it('leaves a connection the user made alone and does not watch it', async () => {
    const h = setup({ read: stateOf('active') })
    await expect(h.coordinator.ensureConnected(h.context)).resolves.toEqual({ status: 'already-connected' })
    expect(h.connect).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(0)
  })

  it('serves a second open click from the connection already in flight', async () => {
    let release!: (state: AccelerationState) => void
    const h = setup({ connect: () => new Promise((resolve) => { release = resolve }) })
    const first = h.coordinator.ensureConnected(h.context)
    const second = h.coordinator.ensureConnected(h.context)
    await vi.waitFor(() => { expect(h.connect).toHaveBeenCalledTimes(1) })
    release(automatic)
    await expect(first).resolves.toEqual({ status: 'connected' })
    await expect(second).resolves.toEqual({ status: 'connected' })
  })

  it('disconnects once Claude Desktop has been gone twice in a row', async () => {
    const h = setup({ running: [true, false, false] })
    await h.coordinator.ensureConnected(h.context)
    await h.tick()
    await h.tick()
    expect(h.disconnect).not.toHaveBeenCalled()
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledExactlyOnceWith(scope, connectedAt) })
    expect(h.timers).toHaveLength(0)
    expect(h.coordinator.holds(scope, connectedAt)).toBe(false)
    expect(h.log).toHaveBeenCalledWith('info', 'acceleration.claude-desktop.disconnected', expect.any(String), { cause: 'desktop-exited' })
  })

  // Nothing tells Starmang when the components are in, so an app left open all
  // day must not keep a free line open all day.
  it('disconnects after an hour even while Claude Desktop keeps running', async () => {
    const h = setup({ running: [true] })
    await h.coordinator.ensureConnected(h.context)
    await h.tick(20 * 60_000)
    await h.tick(20 * 60_000)
    expect(h.disconnect).not.toHaveBeenCalled()
    await h.tick(20 * 60_000)
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledExactlyOnceWith(scope, connectedAt) })
    expect(h.log).toHaveBeenCalledWith('info', 'acceleration.claude-desktop.disconnected', expect.any(String), { cause: 'hold-expired' })
  })

  it('asks less often while Claude Desktop keeps running and snaps back on the first miss', async () => {
    const h = setup({ running: [true, true, true, false] })
    await h.coordinator.ensureConnected(h.context)
    await h.tick()
    await h.tick()
    await h.tick()
    await h.tick()
    expect(h.delays).toEqual([60_000, 60_000, 60_000, 180_000, 60_000])
  })

  it('counts the hour again when Claude Desktop is opened from Starmang once more', async () => {
    const h = setup({ running: [true] })
    await h.coordinator.ensureConnected(h.context)
    await h.tick(50 * 60_000)
    await h.coordinator.ensureConnected(h.context)
    expect(h.connect).toHaveBeenCalledTimes(1)
    expect(h.timers).toHaveLength(1)
    await h.tick(50 * 60_000)
    expect(h.disconnect).not.toHaveBeenCalled()
    await h.tick(10 * 60_000)
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledOnce() })
  })

  it('does not treat an unreadable probe as an exit, but gives up after ten in a row', async () => {
    const h = setup({ running: [null] })
    await h.coordinator.ensureConnected(h.context)
    for (let check = 0; check < 9; check += 1) await h.tick(1_000)
    expect(h.disconnect).not.toHaveBeenCalled()
    await h.tick(1_000)
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledOnce() })
    expect(h.log).toHaveBeenCalledWith('info', 'acceleration.claude-desktop.disconnected', expect.any(String), { cause: 'desktop-unknown' })
  })

  it('stops watching once the user has taken the connection over', async () => {
    const h = setup({ running: [false] })
    await h.coordinator.ensureConnected(h.context)
    h.setState(stateOf('active', { connectedAt: '2026-10-24T08:05:00.000Z' }))
    await h.tick()
    expect(h.timers).toHaveLength(0)
    expect(h.disconnect).not.toHaveBeenCalled()
  })

  it('stops watching once the account has changed', async () => {
    const h = setup({ running: [true] })
    await h.coordinator.ensureConnected(h.context)
    h.setAccountScope('xm-account:8')
    h.timers.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.timers).toHaveLength(0)
    expect(h.isDesktopRunning).not.toHaveBeenCalled()
  })

  it('hands the session to Codex Desktop instead of disconnecting while it still needs the line', async () => {
    const heldElsewhere = vi.fn(() => true)
    const h = setup({ running: [false, false], heldElsewhere })
    await h.coordinator.ensureConnected(h.context)
    await h.tick()
    await h.tick()
    await vi.waitFor(() => { expect(heldElsewhere).toHaveBeenCalledWith(scope, connectedAt) })
    expect(h.disconnect).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(0)
    expect(h.coordinator.holds(scope, connectedAt)).toBe(false)
    expect(h.log).toHaveBeenCalledWith('info', 'acceleration.claude-desktop.handed-off', expect.any(String), { cause: 'desktop-exited' })
    // Passing state updates must not pick the handed-off session back up.
    h.coordinator.observe(automatic)
    expect(h.timers).toHaveLength(0)
  })

  it('keeps a session started for Codex Desktop going while Claude Desktop downloads, then disconnects it', async () => {
    const codexSession = stateOf('active', { autoStartedBy: 'codex-desktop' })
    const h = setup({ read: codexSession, running: [true, false, false] })
    await expect(h.coordinator.ensureConnected(h.context)).resolves.toEqual({ status: 'already-connected' })
    expect(h.connect).not.toHaveBeenCalled()
    expect(h.coordinator.holds(scope, connectedAt)).toBe(true)
    await h.tick()
    await h.tick()
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledExactlyOnceWith(scope, connectedAt) })
  })

  it('follows a connection that only came up after the launch stopped waiting for it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = setup({ timeoutMs: 5, connect: async () => { await gate; return automatic } })
    await expect(h.coordinator.ensureConnected(h.context)).resolves.toEqual({ status: 'skipped', reason: 'timeout' })
    expect(h.timers).toHaveLength(0)
    release()
    await vi.waitFor(() => { expect(h.timers).toHaveLength(1) })
    expect(h.log).toHaveBeenCalledWith('info', 'acceleration.claude-desktop.connected', expect.any(String), { late: true })
  })

  it('picks up only its own automatic session from state updates, and only after an open click', async () => {
    const h = setup({ running: [true] })
    h.coordinator.observe(automatic)
    expect(h.timers).toHaveLength(0)
    await h.coordinator.ensureConnected(h.context)
    h.coordinator.dispose()

    const fresh = setup({ connect: async () => stateOf('connecting') })
    await expect(fresh.coordinator.ensureConnected(fresh.context)).resolves.toEqual({ status: 'connected' })
    expect(fresh.timers).toHaveLength(0)
    fresh.coordinator.observe(stateOf('active', { autoStartedBy: 'codex-desktop' }))
    fresh.coordinator.observe(stateOf('active'))
    fresh.coordinator.observe({ ...automatic, scope: 'xm-account:8' })
    expect(fresh.timers).toHaveLength(0)
    fresh.coordinator.observe(automatic)
    expect(fresh.timers).toHaveLength(1)
    fresh.coordinator.observe({ ...automatic, measuredAt: '2026-10-24T08:01:00.000Z' })
    expect(fresh.timers).toHaveLength(1)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { AccelerationPhase, AccelerationState } from './acceleration-contract'
import {
  codexDesktopAccelerationDecision,
  createCodexDesktopAccelerationCoordinator,
} from './codex-desktop-acceleration'

const scope = 'xm-account:7'

function stateOf(phase: AccelerationPhase, remainingSeconds: number | null = 900): AccelerationState {
  return {
    scope,
    phase,
    mode: 'system-proxy',
    totalSeconds: 1200,
    remainingSeconds,
    sessionSeconds: 0,
    measuredAt: '2026-09-22T11:00:00.000Z',
    connectedAt: phase === 'active' ? '2026-09-22T11:00:00.000Z' : null,
    line: null,
    error: null,
  }
}

function setup(options: {
  accountScope?: string | null
  read?: (scope: string) => Promise<AccelerationState>
  connect?: (scope: string) => Promise<AccelerationState>
  timeoutMs?: number
} = {}) {
  const readState = vi.fn(options.read ?? (async () => stateOf('idle')))
  const connect = vi.fn(options.connect ?? (async () => stateOf('active')))
  const log = vi.fn()
  const coordinator = createCodexDesktopAccelerationCoordinator({
    getAccountScope: () => (options.accountScope === undefined ? scope : options.accountScope),
    readState,
    connect,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    log,
  })
  return { coordinator, readState, connect, log }
}

describe('codex desktop acceleration decision', () => {
  it('leaves a connection the user already owns untouched', () => {
    expect(codexDesktopAccelerationDecision(stateOf('active'))).toBe('already-connected')
    expect(codexDesktopAccelerationDecision(stateOf('connecting'))).toBe('already-connected')
    // 用户刚点了停止，这时候连回去等于跟他抢。
    expect(codexDesktopAccelerationDecision(stateOf('stopping'))).toBe('already-connected')
  })

  it('connects only when an idle account still has allowance', () => {
    expect(codexDesktopAccelerationDecision(stateOf('idle'))).toBe('connect')
    expect(codexDesktopAccelerationDecision(stateOf('error'))).toBe('connect')
    expect(codexDesktopAccelerationDecision(stateOf('exhausted', 0))).toBe('exhausted')
    expect(codexDesktopAccelerationDecision(stateOf('idle', 0))).toBe('exhausted')
    expect(codexDesktopAccelerationDecision(stateOf('idle', null))).toBe('exhausted')
    expect(codexDesktopAccelerationDecision(stateOf('unavailable', null))).toBe('unavailable')
  })
})

describe('codex desktop acceleration coordinator', () => {
  it('connects before the desktop app is launched', async () => {
    const { coordinator, connect, log } = setup()
    await expect(coordinator.ensureConnected()).resolves.toEqual({ status: 'connected' })
    expect(connect).toHaveBeenCalledWith(scope)
    expect(log).toHaveBeenCalledWith('info', 'acceleration.codex-desktop.connected', expect.any(String), undefined)
  })

  it('accepts a connection that is still coming up', async () => {
    const { coordinator } = setup({ connect: async () => stateOf('connecting') })
    await expect(coordinator.ensureConnected()).resolves.toEqual({ status: 'connected' })
  })

  it('never touches an acceleration session that is already running', async () => {
    const { coordinator, connect } = setup({ read: async () => stateOf('active') })
    await expect(coordinator.ensureConnected()).resolves.toEqual({ status: 'already-connected' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('skips without an account, without allowance and without a working component', async () => {
    const withoutAccount = setup({ accountScope: null })
    await expect(withoutAccount.coordinator.ensureConnected())
      .resolves.toEqual({ status: 'skipped', reason: 'no-account' })
    expect(withoutAccount.readState).not.toHaveBeenCalled()

    const exhausted = setup({ read: async () => stateOf('exhausted', 0) })
    await expect(exhausted.coordinator.ensureConnected())
      .resolves.toEqual({ status: 'skipped', reason: 'exhausted' })
    expect(exhausted.connect).not.toHaveBeenCalled()

    const unavailable = setup({ read: async () => stateOf('unavailable', null) })
    await expect(unavailable.coordinator.ensureConnected())
      .resolves.toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(unavailable.connect).not.toHaveBeenCalled()
  })

  it('does not connect when the current state cannot be read', async () => {
    const { coordinator, connect, log } = setup({ read: async () => { throw new Error('helper down') } })
    await expect(coordinator.ensureConnected())
      .resolves.toEqual({ status: 'skipped', reason: 'state-unreadable' })
    expect(connect).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('warn', 'acceleration.codex-desktop.skipped', expect.any(String),
      { reason: 'state-unreadable', cause: 'helper down' })
  })

  it('reports a refused connection as skipped instead of failing the launch', async () => {
    // 检测到其他代理时后端返回的仍是一份 state，只是没有连上。
    const { coordinator } = setup({ connect: async () => stateOf('idle') })
    await expect(coordinator.ensureConnected())
      .resolves.toEqual({ status: 'skipped', reason: 'connect-failed' })
  })

  it('never rejects, whatever the acceleration service does', async () => {
    const { coordinator } = setup({ connect: async () => { throw new Error('加速连接失败') } })
    await expect(coordinator.ensureConnected())
      .resolves.toEqual({ status: 'skipped', reason: 'connect-failed' })
  })

  it('gives up waiting after the budget and still lets the launch continue', async () => {
    const { coordinator } = setup({ timeoutMs: 5, connect: () => new Promise(() => {}) })
    await expect(coordinator.ensureConnected())
      .resolves.toEqual({ status: 'skipped', reason: 'timeout' })
  })

  it('serves a second open click from the connection already in flight', async () => {
    let resolveConnect!: (state: AccelerationState) => void
    const pending = new Promise<AccelerationState>((resolve) => { resolveConnect = resolve })
    const { coordinator, connect } = setup({ connect: () => pending })
    const first = coordinator.ensureConnected()
    const second = coordinator.ensureConnected()
    expect(second).toBe(first)
    await vi.waitFor(() => { expect(connect).toHaveBeenCalledTimes(1) })
    resolveConnect(stateOf('active'))
    await expect(first).resolves.toEqual({ status: 'connected' })
    expect(connect).toHaveBeenCalledTimes(1)
  })
})

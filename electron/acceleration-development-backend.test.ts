import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAccelerationDevelopmentBackend } from './acceleration-development-backend'
import { accelerationTrialSeconds } from './acceleration-contract'
import * as safe from './safe-local-data'

const scope = 'xm-account:1'
const secondScope = 'api-account:2'
const epoch = Date.parse('2026-09-14T00:00:00Z')
const line = { id: 'line-1', name: '开发线路', region: 'JP', latencyMs: 12 }
const cleanup: Array<() => Promise<void>> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function setup(existingPath?: string, pingLine?: (lineId: string) => Promise<typeof line>, entitlementSource?: 'local-device' | 'local-development') {
  const directory = existingPath ? path.dirname(existingPath) : await fs.mkdtemp(path.join(os.tmpdir(), 'xm-dev-acceleration-test-'))
  if (!existingPath) cleanup.push(async () => {
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()))
    expect(path.basename(directory)).toMatch(/^xm-dev-acceleration-test-/)
    await fs.rm(directory, { recursive: true, force: true })
  })
  const ledgerPath = existingPath ?? path.join(directory, 'usage.json')
  let wall = epoch
  let monotonic = 0
  let running = false
  const events: string[] = []
  const scheduled = new Set<{ at: number; callback: () => void }>()
  const runtime = {
    start: vi.fn(async () => { events.push('runtime:start'); running = true; return { line, proxyPort: 19001 } }),
    stop: vi.fn(async () => { events.push('runtime:stop'); running = false }),
    isRunning: () => running,
  }
  const proxy = {
    enable: vi.fn(async (_port: number) => { events.push('proxy:enable') }),
    restore: vi.fn(async () => { events.push('proxy:restore') }),
  }
  const backend = createAccelerationDevelopmentBackend({
    runtime, proxy, ledgerPath, now: () => wall, monotonicNow: () => monotonic,
    listLines: async () => [line], pingLine, entitlementSource,
    schedule(callback, milliseconds) {
      const timer = { at: monotonic + milliseconds, callback }
      scheduled.add(timer)
      return () => { scheduled.delete(timer) }
    },
  })
  cleanup.push(async () => {
    proxy.restore.mockImplementation(async () => {})
    runtime.stop.mockImplementation(async () => { running = false })
    await backend.dispose().catch(() => undefined)
  })
  return {
    backend, runtime, proxy, events, ledgerPath, scheduled,
    setRunning: (value: boolean) => { running = value },
    setWall: (value: number) => { wall = value },
    elapse(milliseconds: number) { wall += milliseconds; monotonic += milliseconds },
    async advance(milliseconds: number) {
      wall += milliseconds
      monotonic += milliseconds
      for (const timer of [...scheduled]) {
        if (timer.at <= monotonic) { scheduled.delete(timer); timer.callback() }
      }
      // A queue barrier, deliberately not getState (which also checks expiry).
      await backend.recover()
    },
    async readLedger() { return JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as { version: number; accounts: Record<string, { usedMs: number; startedAt: number | null }> } },
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

describe('local development acceleration backend', () => {
  it('marks a bundled device-local trial explicitly and preserves local usage across stop and reopen', async () => {
    const test = await setup(undefined, undefined, 'local-device')
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ entitlementSource: 'local-device', totalSeconds: 1200, remainingSeconds: 1200 })
    expect((await test.backend.startAcceleration(scope, 'system-proxy')).entitlementSource).toBe('local-device')
    test.elapse(20_000)
    expect(await test.backend.stopAcceleration(scope)).toMatchObject({ entitlementSource: 'local-device', remainingSeconds: 1180 })
    const reopened = await setup(test.ledgerPath, undefined, 'local-device')
    expect(await reopened.backend.getAccelerationState(scope)).toMatchObject({ entitlementSource: 'local-device', remainingSeconds: 1180 })
  })

  it('cleans failed probe cores without enabling a proxy or consuming allowance', async () => {
    const entered = deferred<void>()
    const held = deferred<typeof line>()
    const probe = vi.fn(() => { entered.resolve(); return held.promise })
    const test = await setup(undefined, probe)
    const pending = expect(test.backend.pingAccelerationLine!(scope, line.id)).rejects.toThrow('probe failed')
    await entered.promise
    test.setRunning(true)
    held.reject(new Error('probe failed'))
    await pending
    expect(test.runtime.isRunning()).toBe(false)
    expect(test.proxy.enable).not.toHaveBeenCalled()
    expect((await test.backend.getAccelerationState(scope)).remainingSeconds).toBe(accelerationTrialSeconds)
  })

  it('retries a failed temporary probe cleanup on disposal even when no paid session exists', async () => {
    const test = await setup(undefined, async () => line)
    test.runtime.stop.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(test.backend.pingAccelerationLine!(scope, line.id)).rejects.toThrow('cleanup failed')
    test.runtime.stop.mockClear()
    await test.backend.dispose()
    expect(test.runtime.stop).toHaveBeenCalledOnce()
    expect(test.proxy.enable).not.toHaveBeenCalled()
  })

  it('serializes a start behind a probe and rejects probes during an active connection', async () => {
    const entered = deferred<void>()
    const held = deferred<typeof line>()
    const probe = vi.fn(() => { entered.resolve(); return held.promise })
    const test = await setup(undefined, probe)
    const ping = test.backend.pingAccelerationLine!(scope, line.id)
    await entered.promise
    const start = test.backend.startAcceleration(scope, 'system-proxy')
    expect(test.runtime.start).not.toHaveBeenCalled()
    held.resolve(line)
    await ping
    expect((await start).phase).toBe('active')
    await expect(test.backend.pingAccelerationLine!(scope, line.id)).rejects.toThrow('加速连接进行中')
    expect(probe).toHaveBeenCalledOnce()
    expect(test.runtime.isRunning()).toBe(true)
  })

  it('labels the local entitlement and refuses TUN without touching network state', async () => {
    const { backend, runtime, proxy } = await setup()
    await expect(backend.startAcceleration(scope, 'tun')).rejects.toThrow('本机开发加速暂不支持 TUN')
    expect(runtime.start).not.toHaveBeenCalled()
    expect(proxy.enable).not.toHaveBeenCalled()
    expect(await backend.getAccelerationState(scope)).toMatchObject({
      phase: 'idle', remainingSeconds: accelerationTrialSeconds, totalSeconds: 1200,
      entitlementSource: 'local-development', supportedModes: ['system-proxy'],
    })
  })

  it('starts accounting only after the core is running and proxy enable confirms success', async () => {
    const test = await setup()
    await test.backend.recover()
    test.events.length = 0
    const pending = deferred<void>()
    test.proxy.enable.mockImplementationOnce(async () => { test.events.push('proxy:enable'); await pending.promise })
    const starting = test.backend.startAcceleration(scope, 'system-proxy')
    await vi.waitFor(() => expect(test.proxy.enable).toHaveBeenCalledOnce())
    test.elapse(12_000)
    pending.resolve()
    expect(await starting).toMatchObject({ phase: 'active', remainingSeconds: accelerationTrialSeconds, sessionSeconds: 0, line })
    test.elapse(1500)
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ remainingSeconds: accelerationTrialSeconds - 1, sessionSeconds: 1 })
    expect(test.events).toEqual(['runtime:start', 'proxy:enable'])
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 0, startedAt: epoch + 12_000 })
  })

  it('restores proxy before stopping the core, persists exact milliseconds and resumes the remainder', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.events.length = 0
    test.elapse(12_345)
    expect(await test.backend.stopAcceleration(scope)).toMatchObject({ phase: 'idle', remainingSeconds: accelerationTrialSeconds - 12, sessionSeconds: 12, connectedAt: null })
    expect(test.events).toEqual(['proxy:restore', 'runtime:stop'])
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 12_345, startedAt: null })
    test.elapse(30_000)
    expect((await test.backend.getAccelerationState(scope)).remainingSeconds).toBe(accelerationTrialSeconds - 12)
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(655)
    await test.backend.stopAcceleration(scope)
    expect((await test.readLedger()).accounts[scope].usedMs).toBe(13_000)
  })

  it('serializes duplicate starts without launching duplicate cores or restarting the clock', async () => {
    const test = await setup()
    const results = await Promise.all([
      test.backend.startAcceleration(scope, 'system-proxy'),
      test.backend.startAcceleration(scope, 'system-proxy'),
    ])
    expect(test.runtime.start).toHaveBeenCalledOnce()
    expect(test.proxy.enable).toHaveBeenCalledOnce()
    expect(results[0].connectedAt).toBe(results[1].connectedAt)
  })

  it('rolls back a failed proxy enable in restore-then-stop order without charging connection time', async () => {
    const test = await setup()
    await test.backend.recover()
    test.events.length = 0
    test.proxy.enable.mockImplementationOnce(async () => { test.events.push('proxy:enable'); test.elapse(9000); throw new Error('private-secret') })
    const result = await test.backend.startAcceleration(scope, 'system-proxy')
    expect(result).toMatchObject({ phase: 'error', remainingSeconds: accelerationTrialSeconds, connectedAt: null })
    expect(result.error).not.toContain('private-secret')
    expect(test.events).toEqual(['runtime:start', 'proxy:enable', 'proxy:restore', 'runtime:stop'])
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 0, startedAt: null })
    expect((await test.backend.startAcceleration(scope, 'system-proxy')).phase).toBe('active')
  })

  it('retains a failed rollback and core until proxy restoration can be retried', async () => {
    const test = await setup()
    await test.backend.recover()
    test.proxy.enable.mockRejectedValueOnce(new Error('private-secret'))
    test.proxy.restore.mockRejectedValueOnce(new Error('private-restore-error'))
    const result = await test.backend.startAcceleration(scope, 'system-proxy')
    expect(result.phase).toBe('stopping')
    expect(result.error).toContain('尚未完全停止')
    expect(test.runtime.stop).not.toHaveBeenCalled()
    expect(test.runtime.isRunning()).toBe(true)
    expect((await test.readLedger()).accounts[scope].startedAt).not.toBeNull()
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('idle')
    expect(test.runtime.isRunning()).toBe(false)
  })

  it('continues charging while stop is unconfirmed and retries without claiming disconnection', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(1000)
    test.runtime.stop.mockRejectedValueOnce(new Error('private-stop-error'))
    expect(await test.backend.stopAcceleration(scope)).toMatchObject({ phase: 'stopping', remainingSeconds: accelerationTrialSeconds - 1, connectedAt: new Date(epoch).toISOString() })
    test.elapse(2000)
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'stopping', remainingSeconds: accelerationTrialSeconds - 3 })
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('idle')
    expect((await test.readLedger()).accounts[scope].usedMs).toBe(3000)
  })

  it('does not accept a stop result while the core still reports running', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.runtime.stop.mockImplementationOnce(async () => {})
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('stopping')
    expect((await test.readLedger()).accounts[scope].startedAt).not.toBeNull()
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('idle')
  })

  it('stops at exhaustion using its independent timer without UI polling', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.events.length = 0
    await test.advance(accelerationTrialSeconds * 1000)
    expect(test.events).toEqual(['proxy:restore', 'runtime:stop'])
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: accelerationTrialSeconds * 1000, startedAt: null })
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'exhausted', remainingSeconds: 0, sessionSeconds: 1200 })
    expect((await test.backend.startAcceleration(scope, 'system-proxy')).phase).toBe('exhausted')
    expect(test.runtime.start).toHaveBeenCalledOnce()
  })

  it('retries failed expiry cleanup while keeping the zero allowance and stopping phase', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.proxy.restore.mockRejectedValueOnce(new Error('temporary'))
    await test.advance(accelerationTrialSeconds * 1000)
    expect(test.runtime.stop).not.toHaveBeenCalled()
    expect(test.scheduled.size).toBe(1)
    await test.advance(5000)
    expect(test.runtime.isRunning()).toBe(false)
    expect((await test.readLedger()).accounts[scope].usedMs).toBe(accelerationTrialSeconds * 1000)
    expect((await test.backend.getAccelerationState(scope)).sessionSeconds).toBe(1200)
  })

  it('restores proxy and settles the session on an unexpected core exit', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(2500)
    test.setRunning(false)
    test.events.length = 0
    await test.backend.notifyRuntimeExit()
    expect(test.events).toEqual(['proxy:restore'])
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'error', remainingSeconds: accelerationTrialSeconds - 2, error: expect.stringContaining('意外退出') })
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 2500, startedAt: null })
    expect((await test.backend.startAcceleration(scope, 'system-proxy')).phase).toBe('active')
  })

  it('keeps unexpected-exit recovery retryable when proxy restoration fails', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.setRunning(false)
    test.proxy.restore.mockRejectedValueOnce(new Error('private-secret'))
    await expect(test.backend.notifyRuntimeExit()).rejects.toThrow('尚未完全停止')
    expect((await test.backend.getAccelerationState(scope)).phase).toBe('stopping')
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('idle')
  })

  it('conservatively settles a persisted unfinished session after restart instead of granting a new trial', async () => {
    const test = await setup()
    await fs.writeFile(test.ledgerPath, JSON.stringify({ version: 1, accounts: { [scope]: { usedMs: 15_000, startedAt: epoch } } }))
    test.setWall(epoch + 45_000)
    await test.backend.recover()
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 60_000, startedAt: null })
    expect((await test.backend.getAccelerationState(scope)).remainingSeconds).toBe(accelerationTrialSeconds - 60)
    const restarted = await setup(test.ledgerPath)
    expect((await restarted.backend.getAccelerationState(scope)).remainingSeconds).toBe(accelerationTrialSeconds - 60)
  })

  it.each([
    [0, 1200],
    [300_000, 900],
    [1_199_500, 1],
    [1_200_000, 0],
    [1_800_000, 0],
    [3_600_000, 0],
  ])('preserves version 1 historical use of %i milliseconds under the twenty-minute allowance', async (usedMs, remainingSeconds) => {
    const test = await setup()
    await fs.writeFile(test.ledgerPath, JSON.stringify({ version: 1, accounts: { [scope]: { usedMs, startedAt: null } } }))
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({
      totalSeconds: 1200, remainingSeconds, phase: remainingSeconds === 0 ? 'exhausted' : 'idle',
    })
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: Math.min(1_200_000, usedMs), startedAt: null })
    const restarted = await setup(test.ledgerPath)
    expect((await restarted.backend.getAccelerationState(scope)).remainingSeconds).toBe(remainingSeconds)
    if (remainingSeconds === 0) {
      expect((await restarted.backend.startAcceleration(scope, 'system-proxy')).phase).toBe('exhausted')
      expect(restarted.runtime.start).not.toHaveBeenCalled()
      expect(restarted.proxy.enable).not.toHaveBeenCalled()
    }
  })

  it('settles unfinished legacy usage against twenty minutes and rewrites all over-limit accounts', async () => {
    const test = await setup()
    await fs.writeFile(test.ledgerPath, JSON.stringify({ version: 1, accounts: {
      [scope]: { usedMs: 1_080_000, startedAt: epoch - 120_000 },
      [secondScope]: { usedMs: 3_600_000, startedAt: null },
    } }))
    await test.backend.recover()
    expect((await test.readLedger()).accounts).toEqual({
      [scope]: { usedMs: 1_200_000, startedAt: null },
      [secondScope]: { usedMs: 1_200_000, startedAt: null },
    })
    expect((await test.backend.getAccelerationState(scope)).phase).toBe('exhausted')
    expect((await test.backend.getAccelerationState(secondScope)).phase).toBe('exhausted')
  })

  it('continues rejecting values outside the historical version 1 ledger boundary', async () => {
    const test = await setup()
    const original = JSON.stringify({ version: 1, accounts: { [scope]: { usedMs: 3_600_001, startedAt: null } } })
    await fs.writeFile(test.ledgerPath, original)
    await expect(test.backend.getAccelerationState(scope)).rejects.toThrow('本机测试时长无法读取或保存')
    expect(await fs.readFile(test.ledgerPath, 'utf8')).toBe(original)
    expect(test.runtime.start).not.toHaveBeenCalled()
  })

  it('does not grant time through a clock rollback during a live session or crash recovery', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(5000)
    test.setWall(epoch - 86_400_000)
    expect((await test.backend.getAccelerationState(scope)).remainingSeconds).toBe(accelerationTrialSeconds - 5)
    await test.backend.stopAcceleration(scope)
    expect((await test.readLedger()).accounts[scope].usedMs).toBe(5000)
    const crashed = await setup()
    await fs.writeFile(crashed.ledgerPath, JSON.stringify({ version: 1, accounts: { [scope]: { usedMs: 0, startedAt: epoch + 1000 } } }))
    expect(await crashed.backend.getAccelerationState(scope)).toMatchObject({ phase: 'exhausted', remainingSeconds: 0 })
  })

  it('fails closed on corrupted ledgers and never starts a core with an unreadable allowance', async () => {
    const test = await setup()
    await fs.writeFile(test.ledgerPath, '{private-secret')
    await expect(test.backend.getAccelerationState(scope)).rejects.toThrow('本机测试时长无法读取或保存')
    await expect(test.backend.startAcceleration(scope, 'system-proxy')).rejects.toThrow('本机测试时长无法读取或保存')
    expect(test.runtime.start).not.toHaveBeenCalled()
    expect(await fs.readFile(test.ledgerPath, 'utf8')).toBe('{private-secret')
  })

  it('still restores a stale proxy and running core when a damaged ledger prevents recovery', async () => {
    const test = await setup()
    await fs.writeFile(test.ledgerPath, 'invalid-ledger')
    test.setRunning(true)
    await expect(test.backend.recover()).rejects.toThrow('时长无法读取或保存')
    expect(test.events).toEqual(['proxy:restore', 'runtime:stop'])
    expect(test.runtime.isRunning()).toBe(false)
    expect(await fs.readFile(test.ledgerPath, 'utf8')).toBe('invalid-ledger')
  })

  it('keeps accounts in one fixed ledger and stops the previous session before changing accounts', async () => {
    const test = await setup()
    expect(() => test.backend.startAcceleration('../../elsewhere', 'system-proxy')).toThrow('账号参数无效')
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(2000)
    test.events.length = 0
    expect((await test.backend.startAcceleration(secondScope, 'system-proxy')).scope).toBe(secondScope)
    expect(test.events).toEqual(['proxy:restore', 'runtime:stop', 'runtime:start', 'proxy:enable'])
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 2000, startedAt: null })
    expect((await test.backend.getAccelerationState(secondScope)).remainingSeconds).toBe(accelerationTrialSeconds)
  })

  it('blocks connectivity if its intent cannot be persisted', async () => {
    const test = await setup()
    await test.backend.recover()
    vi.spyOn(safe, 'writeAtomicSafeUtf8File').mockRejectedValueOnce(new Error('private-fs-path'))
    expect(await test.backend.startAcceleration(scope, 'system-proxy')).toMatchObject({ phase: 'error', error: expect.stringContaining('时长无法读取或保存') })
    expect(test.runtime.start).not.toHaveBeenCalled()
    expect(test.proxy.enable).not.toHaveBeenCalled()
  })

  it('freezes measured use once the network is stopped even when final ledger persistence must retry', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(2000)
    vi.spyOn(safe, 'writeAtomicSafeUtf8File').mockRejectedValueOnce(new Error('private-fs-path'))
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('stopping')
    expect(test.runtime.isRunning()).toBe(false)
    test.elapse(7000)
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('idle')
    expect((await test.readLedger()).accounts[scope].usedMs).toBe(2000)
  })

  it('allows shutdown cleanup to be retried and forbids new starts once shutdown begins', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.proxy.restore.mockRejectedValueOnce(new Error('private-secret'))
    await expect(test.backend.dispose()).rejects.toThrow('尚未完全停止')
    await expect(test.backend.startAcceleration(scope, 'system-proxy')).rejects.toThrow('正在关闭')
    await test.backend.dispose()
    expect(test.runtime.isRunning()).toBe(false)
    expect(test.scheduled.size).toBe(0)
  })
})

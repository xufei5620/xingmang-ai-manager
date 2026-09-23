import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accelerationShutdownRetryDelayMs, classifyAccelerationStartFailure, classifyAccelerationWorkerFailure, createAccelerationDevelopmentBackend } from './acceleration-development-backend'
import { accelerationBonusCode, accelerationBonusSeconds, accelerationConflictNotice, accelerationTrialSeconds, type AccelerationConflictKind } from './acceleration-contract'
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

async function setup(
  existingPath?: string,
  pingLine?: (lineId: string) => Promise<typeof line>,
  entitlementSource?: 'local-device' | 'local-development',
  detectConflicts?: () => Promise<AccelerationConflictKind[]>,
) {
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
  const onDiagnostic = vi.fn()
  const onStartDiagnostic = vi.fn()
  const onConflictDiagnostic = vi.fn()
  const onRuntimeInterrupted = vi.fn()
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
    listLines: async () => [line], pingLine, entitlementSource, onDiagnostic, onStartDiagnostic, onConflictDiagnostic, onRuntimeInterrupted,
    ...(detectConflicts ? { detectConflicts } : {}),
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
    backend, runtime, proxy, events, ledgerPath, scheduled, onDiagnostic, onStartDiagnostic, onConflictDiagnostic, onRuntimeInterrupted,
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
    async readLedger() { return JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as { version: number; accounts: Record<string, { usedMs: number; startedAt: number | null; bonusRedeemed?: true }> } },
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

  it('preserves a safe proxy authorization explanation after rollback without exposing underlying details', async () => {
    const test = await setup()
    await test.backend.recover()
    test.proxy.enable.mockRejectedValueOnce(Object.assign(new Error('private-helper-path-and-secret'), { code: 'MACOS_PROXY_AUTHORIZATION' }))
    const result = await test.backend.startAcceleration(scope, 'system-proxy')
    expect(result).toMatchObject({ phase: 'error', remainingSeconds: 1200, connectedAt: null })
    expect(result.error).toContain('macOS 网络设置授权未完成')
    expect(result.error).not.toContain('private-helper-path')
    expect(test.runtime.isRunning()).toBe(false)
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

  it('retries private-file cleanup after the core has exited before declaring a successful stop', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.runtime.stop.mockImplementationOnce(async () => {
      test.setRunning(false)
      throw new Error('private-config-cleanup-EPERM')
    }).mockRejectedValueOnce(new Error('private-config-cleanup-still-locked'))
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('stopping')
    expect(test.runtime.isRunning()).toBe(false)
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('stopping')
    expect((await test.readLedger()).accounts[scope].startedAt).not.toBeNull()
    expect(test.runtime.stop).toHaveBeenCalledTimes(2)
    expect(test.onDiagnostic.mock.calls).toEqual([['core-stop'], ['core-stop']])
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('idle')
    expect(test.runtime.stop).toHaveBeenCalledTimes(3)
    expect((await test.readLedger()).accounts[scope].startedAt).toBeNull()
  })

  it('reports proxy restoration failures by stage without exposing private native errors', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.proxy.restore.mockRejectedValueOnce(new Error('https://user:secret@private-proxy.test'))
    const result = await test.backend.stopAcceleration(scope)
    expect(result.phase).toBe('stopping')
    expect(test.runtime.stop).not.toHaveBeenCalled()
    expect(test.onDiagnostic.mock.calls).toEqual([['proxy-restore']])
    expect(result.error).not.toContain('private-proxy')
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('idle')
  })

  it('reports ledger failures separately and retries settlement without restarting stopped cleanup', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    vi.spyOn(safe, 'writeAtomicSafeUtf8File').mockRejectedValueOnce(new Error('private-ledger-path'))
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('stopping')
    expect(test.runtime.isRunning()).toBe(false)
    expect(test.onDiagnostic.mock.calls).toEqual([['ledger-write']])
    expect((await test.readLedger()).accounts[scope].startedAt).not.toBeNull()
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('idle')
    expect(test.runtime.stop).toHaveBeenCalledOnce()
  })

  it('keeps cleanup retryable even if diagnostic reporting throws', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.onDiagnostic.mockImplementation(() => { throw new Error('diagnostic unavailable') })
    test.runtime.stop.mockRejectedValueOnce(new Error('private-stop-error'))
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('stopping')
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
    expect(test.events).toEqual(['proxy:restore', 'runtime:stop'])
    expect(test.onRuntimeInterrupted).toHaveBeenCalledOnce()
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'error', remainingSeconds: accelerationTrialSeconds - 2, error: expect.stringContaining('意外断开') })
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 2500, startedAt: null })
    expect((await test.backend.startAcceleration(scope, 'system-proxy')).phase).toBe('active')
  })

  it('does not bill the time the computer slept and re-arms expiry from the time left before sleep', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(60_000)
    test.backend.suspend()
    expect(test.scheduled.size).toBe(0)
    // Windows 的单调钟跨睡眠照走：睡了八小时，醒来时它也往前走了八小时。
    test.elapse(8 * 3_600_000)
    await test.backend.resume()
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'active', remainingSeconds: accelerationTrialSeconds - 60 })
    expect([...test.scheduled].map((timer) => timer.at - 8 * 3_600_000 - 60_000)).toEqual([(accelerationTrialSeconds - 60) * 1000])
    await test.advance((accelerationTrialSeconds - 60) * 1000)
    expect(test.runtime.isRunning()).toBe(false)
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: accelerationTrialSeconds * 1000, startedAt: null })
    expect(test.onRuntimeInterrupted).not.toHaveBeenCalled()
  })

  it('also handles a monotonic clock that stopped during sleep, as on macOS', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(30_000)
    test.backend.suspend()
    // macOS 的单调钟睡眠时停表：墙钟走了一夜，单调钟没动。
    test.setWall(epoch + 8 * 3_600_000)
    await test.backend.resume()
    await test.backend.stopAcceleration(scope)
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 30_000, startedAt: null })
  })

  it('takes the network-first disconnect path when acceleration did not survive the sleep', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(10_000)
    test.backend.suspend()
    test.elapse(3_600_000)
    test.setRunning(false)
    test.events.length = 0
    await test.backend.resume()
    expect(test.events).toEqual(['proxy:restore', 'runtime:stop'])
    expect(test.onRuntimeInterrupted).toHaveBeenCalledOnce()
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'error', error: expect.stringContaining('意外断开') })
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 10_000, startedAt: null })
  })

  it('wakes a paused session on the next state read even if the resume event never arrives', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(20_000)
    test.backend.suspend()
    test.elapse(3_600_000)
    // 一次读状态（托盘、加速页或到期提醒）就把它叫醒，计时不会永远冻着。
    expect((await test.backend.getAccelerationState(scope)).remainingSeconds).toBe(accelerationTrialSeconds - 20)
    expect(test.scheduled.size).toBe(1)
    test.elapse(40_000)
    expect((await test.backend.getAccelerationState(scope)).remainingSeconds).toBe(accelerationTrialSeconds - 60)
  })

  it('ignores sleep with no active session and a stop issued while still paused', async () => {
    const test = await setup()
    test.backend.suspend()
    await test.backend.resume()
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'idle' })
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(5_000)
    test.backend.suspend()
    test.backend.suspend()
    test.elapse(3_600_000)
    await test.backend.stopAcceleration(scope)
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 5_000, startedAt: null })
  })

  it('reports the interruption when a state read notices the dead core before the exit callback', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.setRunning(false)
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'error', error: expect.stringContaining('意外断开') })
    expect(test.onRuntimeInterrupted).toHaveBeenCalledOnce()
    // 随后才到的内核退出回调已经没有会话可结束，不再重复报告。
    await test.backend.notifyRuntimeExit()
    expect(test.onRuntimeInterrupted).toHaveBeenCalledOnce()
  })

  it('does not report an interruption for a core that exits with no session, such as a finished download', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    test.setRunning(false)
    await test.backend.notifyRuntimeExit()
    await test.backend.startAcceleration(scope, 'system-proxy')
    await test.backend.stopAcceleration(scope)
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'idle' })
    expect(test.onRuntimeInterrupted).not.toHaveBeenCalled()
  })

  it('keeps unexpected-exit recovery retryable when proxy restoration fails', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.setRunning(false)
    test.proxy.restore.mockRejectedValueOnce(new Error('private-secret'))
    await expect(test.backend.notifyRuntimeExit()).rejects.toThrow('尚未完全停止')
    // 没还原成也要报：宿主据此去读状态，读到 stopping 才会如实说「网络可能还连不上」。
    expect(test.onRuntimeInterrupted).toHaveBeenCalledOnce()
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

describe('device-local acceleration bonus redemption', () => {
  const extendedSeconds = accelerationTrialSeconds + accelerationBonusSeconds

  it('persists one claim per complete account scope when duplicate requests arrive concurrently', async () => {
    const test = await setup()
    const results = await Promise.all(Array.from({ length: 8 }, () => test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)))
    expect(results.filter((result) => result.status === 'redeemed')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'already-redeemed')).toHaveLength(7)
    expect(results.reduce((sum, result) => sum + result.addedSeconds, 0)).toBe(accelerationBonusSeconds)
    for (const result of results) expect(result.state).toMatchObject({ scope, phase: 'idle', totalSeconds: extendedSeconds, remainingSeconds: extendedSeconds })
    expect(await test.readLedger()).toMatchObject({ version: 2, accounts: { [scope]: { usedMs: 0, startedAt: null, bonusRedeemed: true } } })

    // The account domain is part of the identity even when the numeric ID matches.
    await expect(test.backend.redeemAccelerationCode!('api-account:1', accelerationBonusCode))
      .resolves.toMatchObject({ status: 'redeemed', addedSeconds: accelerationBonusSeconds, state: { scope: 'api-account:1' } })
    await expect(test.backend.redeemAccelerationCode!('xm-account:2', accelerationBonusCode))
      .resolves.toMatchObject({ status: 'redeemed', addedSeconds: accelerationBonusSeconds })
    expect(test.runtime.start).not.toHaveBeenCalled()
    expect(test.proxy.enable).not.toHaveBeenCalled()
  })

  it('rejects invalid codes without persisting a claim and accepts the contract normalization', async () => {
    const test = await setup()
    await test.backend.recover()
    const write = vi.spyOn(safe, 'writeAtomicSafeUtf8File')
    for (const code of ['', 'XM-NEBULA-10M-WRONG', `${accelerationBonusCode} extra`]) {
      await expect(test.backend.redeemAccelerationCode!(scope, code)).resolves.toMatchObject({
        status: 'invalid-code', addedSeconds: 0, state: { totalSeconds: accelerationTrialSeconds, remainingSeconds: accelerationTrialSeconds },
      })
    }
    expect(write).not.toHaveBeenCalled()
    await expect(test.backend.redeemAccelerationCode!(scope, `  ${accelerationBonusCode.toLowerCase()}\n`))
      .resolves.toMatchObject({ status: 'redeemed', addedSeconds: accelerationBonusSeconds })
  })

  it('migrates legacy usage before adding time without resetting spent milliseconds', async () => {
    for (const usedMs of [300_000, 1_200_000, 1_800_000, 3_600_000]) {
      const test = await setup()
      await fs.writeFile(test.ledgerPath, JSON.stringify({ version: 1, accounts: { [scope]: { usedMs, startedAt: null } } }))
      const historicalUse = Math.min(usedMs, accelerationTrialSeconds * 1000)
      await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
        status: 'redeemed', addedSeconds: accelerationBonusSeconds,
        state: { totalSeconds: extendedSeconds, remainingSeconds: extendedSeconds - historicalUse / 1000 },
      })
      expect(await test.readLedger()).toEqual({ version: 2, accounts: { [scope]: { usedMs: historicalUse, startedAt: null, bonusRedeemed: true } } })
    }
  })

  it.each([false, 'true', 1, null])('rejects malformed persisted bonus markers (%s) without rewriting the ledger', async (bonusRedeemed) => {
    const test = await setup()
    const original = JSON.stringify({ version: 2, accounts: { [scope]: { usedMs: 0, startedAt: null, bonusRedeemed } } })
    await fs.writeFile(test.ledgerPath, original)
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).rejects.toThrow('时长无法读取或保存')
    expect(await fs.readFile(test.ledgerPath, 'utf8')).toBe(original)
    expect(test.runtime.start).not.toHaveBeenCalled()
  })

  it('rejects bonus fields on legacy ledgers and version 2 usage beyond the credited allowance', async () => {
    for (const entry of [
      { version: 1, usedMs: 0, bonusRedeemed: true },
      { version: 2, usedMs: accelerationTrialSeconds * 1000 + 1 },
      { version: 2, usedMs: extendedSeconds * 1000 + 1, bonusRedeemed: true },
    ]) {
      const test = await setup()
      const { version, ...usage } = entry
      const original = JSON.stringify({ version, accounts: { [scope]: { ...usage, startedAt: null } } })
      await fs.writeFile(test.ledgerPath, original)
      await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).rejects.toThrow('时长无法读取或保存')
      expect(await fs.readFile(test.ledgerPath, 'utf8')).toBe(original)
    }
  })

  it('leaves an active allowance and timer unchanged if atomic persistence fails, then allows a retry', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(5000)
    const before = await fs.readFile(test.ledgerPath, 'utf8')
    const originalTimer = [...test.scheduled][0]
    test.events.length = 0
    vi.spyOn(safe, 'writeAtomicSafeUtf8File').mockRejectedValueOnce(new Error('private-ledger-write-error'))

    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).rejects.toThrow('时长无法读取或保存')
    expect(await fs.readFile(test.ledgerPath, 'utf8')).toBe(before)
    expect([...test.scheduled]).toEqual([originalTimer])
    expect(test.events).toEqual([])
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'active', totalSeconds: accelerationTrialSeconds, remainingSeconds: accelerationTrialSeconds - 5 })
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
      status: 'redeemed', addedSeconds: accelerationBonusSeconds, state: { phase: 'active', remainingSeconds: extendedSeconds - 5 },
    })
  })

  it('extends the current expiry without restarting the core, proxy, or session clock', async () => {
    const test = await setup()
    const connected = await test.backend.startAcceleration(scope, 'system-proxy')
    const oldTimer = [...test.scheduled][0]
    test.elapse(12_345)
    test.events.length = 0
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
      status: 'redeemed', state: {
        phase: 'active', totalSeconds: extendedSeconds, remainingSeconds: extendedSeconds - 12,
        sessionSeconds: 12, connectedAt: connected.connectedAt, line,
      },
    })
    expect(test.events).toEqual([])
    expect(test.runtime.start).toHaveBeenCalledOnce()
    expect(test.scheduled.has(oldTimer)).toBe(false)
    expect([...test.scheduled].map((timer) => timer.at)).toEqual([extendedSeconds * 1000])
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 0, startedAt: epoch, bonusRedeemed: true })

    await test.advance(accelerationTrialSeconds * 1000 - 12_345)
    expect(test.runtime.isRunning()).toBe(true)
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'active', remainingSeconds: accelerationBonusSeconds })
    await test.advance(accelerationBonusSeconds * 1000)
    expect(test.runtime.isRunning()).toBe(false)
    expect(test.events).toEqual(['proxy:restore', 'runtime:stop'])
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'exhausted', remainingSeconds: 0, sessionSeconds: extendedSeconds })
  })

  it('ignores an old expiry callback queued while the redemption write is in progress', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(accelerationTrialSeconds * 1000 - 1000)
    const oldTimer = [...test.scheduled][0]
    const entered = deferred<void>()
    const held = deferred<void>()
    const originalWrite = safe.writeAtomicSafeUtf8File
    vi.spyOn(safe, 'writeAtomicSafeUtf8File').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await held.promise
      return originalWrite(...args)
    })
    test.events.length = 0
    const pending = test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)
    await entered.promise
    test.elapse(1000)
    test.scheduled.delete(oldTimer)
    oldTimer.callback()
    held.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'redeemed', state: { phase: 'active', remainingSeconds: accelerationBonusSeconds } })
    await test.backend.recover()
    expect(test.events).toEqual([])
    expect(test.runtime.isRunning()).toBe(true)
    expect([...test.scheduled].map((timer) => timer.at)).toEqual([extendedSeconds * 1000])
    await test.advance(accelerationBonusSeconds * 1000)
    expect(test.runtime.isRunning()).toBe(false)
  })

  it('does not replace another account session or its expiry when crediting a different scope', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    const originalTimer = [...test.scheduled][0]
    test.events.length = 0
    await expect(test.backend.redeemAccelerationCode!('api-account:1', accelerationBonusCode)).resolves.toMatchObject({
      status: 'redeemed', state: { scope: 'api-account:1', phase: 'idle', remainingSeconds: extendedSeconds },
    })
    expect(test.events).toEqual([])
    expect([...test.scheduled]).toEqual([originalTimer])
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ phase: 'active', totalSeconds: accelerationTrialSeconds })
  })

  it('settles a session that expired during sleep against the old allowance before crediting', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse((accelerationTrialSeconds + 120) * 1000)
    test.events.length = 0
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
      status: 'redeemed', addedSeconds: accelerationBonusSeconds,
      state: { phase: 'idle', totalSeconds: extendedSeconds, remainingSeconds: accelerationBonusSeconds, connectedAt: null },
    })
    expect(test.events).toEqual(['proxy:restore', 'runtime:stop'])
    expect(test.scheduled.size).toBe(0)
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: accelerationTrialSeconds * 1000, startedAt: null, bonusRedeemed: true })
  })

  it('retains the claim through failed starts, normal stops, unexpected exits and reopening', async () => {
    const test = await setup()
    await test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)
    test.proxy.enable.mockRejectedValueOnce(new Error('proxy unavailable'))
    expect((await test.backend.startAcceleration(scope, 'system-proxy')).phase).toBe('error')
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 0, startedAt: null, bonusRedeemed: true })

    await test.backend.startAcceleration(scope, 'system-proxy')
    expect((await test.readLedger()).accounts[scope].bonusRedeemed).toBe(true)
    test.elapse(2000)
    await test.backend.stopAcceleration(scope)
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 2000, startedAt: null, bonusRedeemed: true })
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(3000)
    test.setRunning(false)
    await test.backend.notifyRuntimeExit()
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 5000, startedAt: null, bonusRedeemed: true })
    await test.backend.dispose()

    const reopened = await setup(test.ledgerPath)
    await expect(reopened.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
      status: 'already-redeemed', addedSeconds: 0, state: { totalSeconds: extendedSeconds, remainingSeconds: extendedSeconds - 5 },
    })
  })

  it('preserves the credited allowance and claim during unfinished-session crash recovery', async () => {
    const test = await setup()
    await fs.writeFile(test.ledgerPath, JSON.stringify({ version: 2, accounts: { [scope]: { usedMs: 15_000, startedAt: epoch, bonusRedeemed: true } } }))
    test.setWall(epoch + 45_000)
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
      status: 'already-redeemed', addedSeconds: 0, state: { phase: 'idle', totalSeconds: extendedSeconds, remainingSeconds: extendedSeconds - 60 },
    })
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 60_000, startedAt: null, bonusRedeemed: true })
  })

  it('exhausts the full credited allowance on crash-time clock rollback without permitting another claim', async () => {
    const test = await setup()
    await fs.writeFile(test.ledgerPath, JSON.stringify({ version: 2, accounts: { [scope]: { usedMs: 0, startedAt: epoch + 1000, bonusRedeemed: true } } }))
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
      status: 'already-redeemed', addedSeconds: 0, state: { phase: 'exhausted', totalSeconds: extendedSeconds, remainingSeconds: 0 },
    })
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: extendedSeconds * 1000, startedAt: null, bonusRedeemed: true })
  })

  it('does not restore spent bonus time or allow another claim after reopening an exhausted account', async () => {
    const test = await setup()
    await test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)
    await test.backend.startAcceleration(scope, 'system-proxy')
    await test.advance(extendedSeconds * 1000)
    await test.backend.dispose()
    const reopened = await setup(test.ledgerPath)
    await expect(reopened.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
      status: 'already-redeemed', addedSeconds: 0, state: { phase: 'exhausted', totalSeconds: extendedSeconds, remainingSeconds: 0 },
    })
    expect((await reopened.readLedger()).accounts[scope]).toEqual({ usedMs: extendedSeconds * 1000, startedAt: null, bonusRedeemed: true })
  })

  it('keeps failed expiry cleanup retryable when a bonus is credited during the stopping phase', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.proxy.restore.mockRejectedValue(new Error('temporary restore failure'))
    await test.advance(accelerationTrialSeconds * 1000)
    const retryTimer = [...test.scheduled][0]
    expect(test.runtime.isRunning()).toBe(true)
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({
      status: 'redeemed', state: { phase: 'stopping', totalSeconds: extendedSeconds },
    })
    expect(test.runtime.start).toHaveBeenCalledOnce()
    expect(test.scheduled.size).toBe(1)
    // Cleanup stays scheduled promptly rather than being postponed by 10 minutes.
    expect([...test.scheduled][0].at).toBe(retryTimer.at)
    test.proxy.restore.mockResolvedValue()
    await test.advance(5000)
    expect(test.runtime.isRunning()).toBe(false)
    expect((await test.readLedger()).accounts[scope].bonusRedeemed).toBe(true)
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({ status: 'already-redeemed', addedSeconds: 0 })
  })

  it('retains the claim and frozen usage when final stop persistence needs a retry', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.elapse(2000)
    vi.spyOn(safe, 'writeAtomicSafeUtf8File').mockRejectedValueOnce(new Error('stop ledger failed'))
    expect((await test.backend.stopAcceleration(scope)).phase).toBe('stopping')
    expect(test.runtime.isRunning()).toBe(false)
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).resolves.toMatchObject({ status: 'redeemed' })
    test.elapse(7000)
    await test.backend.stopAcceleration(scope)
    expect((await test.readLedger()).accounts[scope]).toEqual({ usedMs: 2000, startedAt: null, bonusRedeemed: true })
    expect((await test.backend.getAccelerationState(scope)).remainingSeconds).toBe(extendedSeconds - 2)
  })

  it('refuses claims once shutdown starts or completes', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.proxy.restore.mockRejectedValueOnce(new Error('temporary restore failure'))
    await expect(test.backend.dispose()).rejects.toThrow('尚未完全停止')
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).rejects.toThrow('正在关闭')
    expect((await test.readLedger()).accounts[scope].bonusRedeemed).toBeUndefined()
    await test.backend.dispose()
    await expect(test.backend.redeemAccelerationCode!(scope, accelerationBonusCode)).rejects.toThrow('正在关闭')
  })
})

describe('acceleration start failure classification', () => {
  // The messages below are the authored strings these modules actually throw;
  // a rename that breaks the mapping should break this, not go unnoticed in a
  // log that then only ever says 'unknown'.
  it.each([
    ['加速内核与目标 Mac 架构不一致。', 'core-architecture'],
    ['加速内核架构不受支持。', 'core-architecture'],
    ['加速内核校验失败', 'core-integrity'],
    ['加速内核 Mach-O 结构不完整。', 'core-integrity'],
    ['加速内核不是可执行程序。', 'core-integrity'],
    ['加速内核启动失败', 'core-launch'],
    ['加速内核已退出', 'core-launch'],
    ['加速内核意外退出', 'core-launch'],
    ['暂无可用加速线路，请稍后重试。', 'line-unavailable'],
    ['加速运行目录必须是普通目录', 'core-storage'],
    ['加速连接配置写入被系统占用，请稍后重试', 'core-storage'],
    ['本机加速进程通信失败。', 'unknown'],
  ])('maps %s raised while starting the core', (message, stage) => {
    expect(classifyAccelerationStartFailure(new Error(message), 'runtime')).toBe(stage)
  })

  it('classifies by phase once the core is up', () => {
    expect(classifyAccelerationStartFailure(new Error('加速内核启动失败'), 'verify')).toBe('runtime-invalid')
    expect(classifyAccelerationStartFailure(new Error('加速内核启动失败'), 'ledger')).toBe('ledger-write')
    expect(classifyAccelerationStartFailure(new Error('系统代理组件不可用，请重新安装或联系支持'), 'proxy')).toBe('proxy-helper')
    expect(classifyAccelerationStartFailure(new Error('设置系统代理失败'), 'proxy')).toBe('proxy-enable')
  })

  it('reads the macOS authorization code before anything else', () => {
    const error = Object.assign(new Error('系统代理授权未完成，请授权后重试'), { code: 'MACOS_PROXY_AUTHORIZATION' })
    for (const phase of ['runtime', 'verify', 'ledger', 'proxy'] as const) {
      expect(classifyAccelerationStartFailure(error, phase)).toBe('proxy-authorization')
    }
  })

  it('reports a non-Error rejection as unclassified rather than forwarding it', () => {
    expect(classifyAccelerationStartFailure('私密路径', 'runtime')).toBe('unknown')
  })
})

describe('acceleration start failure reporting', () => {
  it('reports the stage when the core never starts, while the user still sees one sentence', async () => {
    const test = await setup()
    test.runtime.start.mockRejectedValueOnce(new Error('加速内核启动失败'))
    const state = await test.backend.startAcceleration(scope, 'system-proxy')
    expect(state).toMatchObject({ phase: 'error', error: '加速连接失败，请检查线路和网络连接后重试。' })
    expect(test.onStartDiagnostic.mock.calls).toEqual([['core-launch']])
  })

  it('separates a system proxy failure from a core failure', async () => {
    const test = await setup()
    test.proxy.enable.mockRejectedValueOnce(new Error('系统代理组件不可用，请重新安装或联系支持'))
    await test.backend.startAcceleration(scope, 'system-proxy')
    expect(test.onStartDiagnostic.mock.calls).toEqual([['proxy-helper']])
  })

  it('reports a failed line probe, which starts the core the same way', async () => {
    const test = await setup(undefined, vi.fn(async () => { throw new Error('暂无可用加速线路，请稍后重试。') }))
    await expect(test.backend.pingAccelerationLine!(scope, line.id)).rejects.toThrow('暂无可用加速线路')
    expect(test.onStartDiagnostic.mock.calls).toEqual([['line-unavailable']])
  })

  it('stays silent when the connection succeeds', async () => {
    const test = await setup()
    expect(await test.backend.startAcceleration(scope, 'system-proxy')).toMatchObject({ phase: 'active' })
    expect(test.onStartDiagnostic).not.toHaveBeenCalled()
  })
  it('refuses a connect while another program holds the system proxy, and charges nothing for it', async () => {
    const detect = vi.fn(async (): Promise<AccelerationConflictKind[]> => ['system-proxy', 'virtual-adapter'])
    const test = await setup(undefined, undefined, undefined, detect)
    const state = await test.backend.startAcceleration(scope, 'system-proxy')
    expect(state).toMatchObject({ phase: 'error', error: accelerationConflictNotice, conflicts: ['system-proxy', 'virtual-adapter'] })
    expect(state.remainingSeconds).toBe(accelerationTrialSeconds)
    // Only the startup lease recovery ran: nothing was started and nothing enabled.
    expect(test.events).toEqual(['proxy:restore'])
    expect(test.runtime.start).not.toHaveBeenCalled()
    expect(test.onConflictDiagnostic.mock.calls).toEqual([['system-proxy', false], ['virtual-adapter', false]])
    expect(test.onStartDiagnostic).not.toHaveBeenCalled()
    // The refusal survives a plain read, so the warning does not vanish on the next poll.
    expect(await test.backend.getAccelerationState(scope)).toMatchObject({ conflicts: ['system-proxy', 'virtual-adapter'] })
  })

  it('connects anyway once the user overrides the warning, and records that decision', async () => {
    const detect = vi.fn(async (): Promise<AccelerationConflictKind[]> => ['system-proxy'])
    const test = await setup(undefined, undefined, undefined, detect)
    await test.backend.startAcceleration(scope, 'system-proxy')
    const state = await test.backend.startAcceleration(scope, 'system-proxy', undefined, true)
    expect(state).toMatchObject({ phase: 'active', error: null })
    expect(state.conflicts).toBeUndefined()
    expect(test.events).toEqual(['proxy:restore', 'runtime:start', 'proxy:enable'])
    expect(test.onConflictDiagnostic.mock.calls).toEqual([['system-proxy', false], ['system-proxy', true]])
  })

  it('clears the warning once nothing else holds the proxy any more', async () => {
    let conflicts: AccelerationConflictKind[] = ['proxy-auto-config']
    const test = await setup(undefined, undefined, undefined, async () => conflicts)
    expect((await test.backend.startAcceleration(scope, 'system-proxy')).conflicts).toEqual(['proxy-auto-config'])
    conflicts = []
    const state = await test.backend.startAcceleration(scope, 'system-proxy')
    expect(state).toMatchObject({ phase: 'active', error: null })
    expect(state.conflicts).toBeUndefined()
  })

  it('connects as before when the conflict check itself cannot run', async () => {
    const test = await setup(undefined, undefined, undefined, async () => { throw new Error('inspect failed') })
    const state = await test.backend.startAcceleration(scope, 'system-proxy')
    expect(state).toMatchObject({ phase: 'active' })
    expect(state.conflicts).toBeUndefined()
    expect(test.onConflictDiagnostic).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean override before touching the ledger', async () => {
    const detect = vi.fn(async (): Promise<AccelerationConflictKind[]> => ['system-proxy'])
    const test = await setup(undefined, undefined, undefined, detect)
    expect(() => test.backend.startAcceleration(scope, 'system-proxy', undefined, 'yes' as unknown as boolean)).toThrow('加速冲突确认参数无效。')
    expect(detect).not.toHaveBeenCalled()
  })
})

describe('download-only acceleration route', () => {
  it('starts the core without ever touching the system proxy', async () => {
    const test = await setup()
    const route = await test.backend.startDownloadRoute(scope)
    expect(route).toEqual({ status: 'ready', port: 19001 })
    expect(test.runtime.start).toHaveBeenCalledTimes(1)
    // 下载专用：内核起来了，系统代理一行未动（proxy:restore 是启动时的崩溃恢复）。
    expect(test.proxy.enable).not.toHaveBeenCalled()
    expect(test.events).toEqual(['proxy:restore', 'runtime:start'])
  })

  it('keeps the acceleration page showing an idle account', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    const state = await test.backend.getAccelerationState(scope)
    expect(state).toMatchObject({ phase: 'idle', connectedAt: null, line: null, error: null })
    expect(state.remainingSeconds).toBe(accelerationTrialSeconds)
  })

  it('does not bill the free allowance', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    test.elapse(120_000)
    await test.backend.stopDownloadRoute()
    const state = await test.backend.getAccelerationState(scope)
    expect(state.remainingSeconds).toBe(accelerationTrialSeconds)
    // 一个字节都没写：下载既不开账也不结账。
    await expect(fs.readFile(test.ledgerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shares one core between downloads and stops it after the last one', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    await test.backend.startDownloadRoute(scope)
    expect(test.runtime.start).toHaveBeenCalledTimes(1)
    await test.backend.stopDownloadRoute()
    expect(test.runtime.stop).not.toHaveBeenCalled()
    await test.backend.stopDownloadRoute()
    expect(test.runtime.stop).toHaveBeenCalledTimes(1)
  })

  it('refuses once the account has spent its allowance', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    await test.advance(accelerationTrialSeconds * 1000)
    expect((await test.backend.getAccelerationState(scope)).phase).toBe('exhausted')
    test.runtime.start.mockClear()
    expect(await test.backend.startDownloadRoute(scope)).toEqual({ status: 'unavailable' })
    expect(test.runtime.start).not.toHaveBeenCalled()
  })

  it('leaves a running game session alone', async () => {
    const test = await setup()
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.runtime.start.mockClear()
    expect(await test.backend.startDownloadRoute(scope)).toEqual({ status: 'system-proxy-active' })
    expect(test.runtime.start).not.toHaveBeenCalled()
    expect((await test.backend.getAccelerationState(scope)).phase).toBe('active')
  })

  it('reports the failure stage instead of swallowing a core that cannot start', async () => {
    const test = await setup()
    test.runtime.start.mockImplementationOnce(async () => { throw new Error('加速内核启动失败') })
    expect(await test.backend.startDownloadRoute(scope)).toEqual({ status: 'unavailable' })
    expect(test.onStartDiagnostic).toHaveBeenCalledWith('core-launch')
    expect((await test.backend.getAccelerationState(scope)).phase).toBe('idle')
  })

  it('adopts the running download core when the user then starts acceleration', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    test.runtime.start.mockClear()
    const state = await test.backend.startAcceleration(scope, 'system-proxy')
    expect(state).toMatchObject({ phase: 'active', line })
    // 内核不重起，所以正在下载的包不会断在半路。
    expect(test.runtime.start).not.toHaveBeenCalled()
    expect(test.proxy.enable).toHaveBeenCalledWith(19001)
  })

  it('restarts the core when the user picks another line', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    test.runtime.start.mockClear()
    await test.backend.startAcceleration(scope, 'system-proxy', 'line-1')
    expect(test.runtime.start).not.toHaveBeenCalled()
    await test.backend.stopAcceleration(scope)
    await test.backend.startDownloadRoute(scope)
    test.runtime.start.mockClear()
    test.runtime.stop.mockClear()
    await test.backend.startAcceleration(scope, 'system-proxy', 'line-2')
    expect(test.runtime.stop).toHaveBeenCalled()
    expect(test.runtime.start).toHaveBeenCalledWith('line-2')
  })

  it('keeps the core alive for a download when the game session stops', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    await test.backend.startAcceleration(scope, 'system-proxy')
    test.runtime.stop.mockClear()
    await test.backend.stopAcceleration(scope)
    expect(test.proxy.restore).toHaveBeenCalled()
    expect(test.runtime.stop).not.toHaveBeenCalled()
    await test.backend.stopDownloadRoute()
    expect(test.runtime.stop).toHaveBeenCalledTimes(1)
  })

  it('refuses a line probe while a download holds the core', async () => {
    const test = await setup(undefined, async () => line)
    await test.backend.startDownloadRoute(scope)
    await expect(test.backend.pingAccelerationLine!(scope, 'line-1')).rejects.toThrow('正在下载安装包，暂不能检测线路。')
  })

  it('stops a download-only core on shutdown', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    await test.backend.dispose()
    expect(test.runtime.stop).toHaveBeenCalled()
  })

  it('forgets the route when the core exits on its own', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    test.setRunning(false)
    await test.backend.notifyRuntimeExit()
    test.runtime.stop.mockClear()
    // 端口已经没了，这次 stop 不该再去减一个不存在的持有。
    await test.backend.stopDownloadRoute()
    expect(test.runtime.stop).not.toHaveBeenCalled()
    expect(await test.backend.startDownloadRoute(scope)).toEqual({ status: 'ready', port: 19001 })
  })
})

describe('classifyAccelerationWorkerFailure', () => {
  it('separates a live owner from a lock it could not even take', () => {
    // 两句都以「系统代理」开头，但下一步完全不同：前者退掉旧软件就好，后者是
    // 这台机器的策略不让加速动网络设置，重试多少次都一样。
    expect(classifyAccelerationWorkerFailure(new Error('另一实例正在使用系统代理，请先停止该实例的加速。'))).toBe('proxy-owned')
    for (const message of [
      '无法创建系统代理操作锁。',
      '系统代理操作锁提前结束。',
      '系统代理操作锁返回异常。',
      '系统代理操作锁异常中断，请重试恢复。',
      '系统代理正在由另一实例操作，请稍后重试。',
    ]) expect([message, classifyAccelerationWorkerFailure(new Error(message))]).toEqual([message, 'proxy-locked'])
  })

  it('maps the remaining authored failures onto their own reason', () => {
    for (const [message, reason] of [
      ['本机测试时长无法读取或保存，请检查本地数据目录后重试。', 'local-data'],
      ['加速尚未完全停止，正在保留恢复状态，请再次点击停止。', 'proxy-restore'],
      ['系统代理恢复未确认，恢复记录已保留。', 'proxy-restore'],
      ['Windows 系统代理操作未完成，请重试。', 'proxy-restore'],
      ['当前系统暂不支持此系统代理模式。', 'proxy-restore'],
      ['本机加速数据必须是普通目录', 'helper-data'],
      ['开发加速进程未就绪。', 'helper-launch'],
      ['开发数据目录无效。', 'helper-launch'],
    ] as const) expect([message, classifyAccelerationWorkerFailure(new Error(message))]).toEqual([message, reason])
  })

  it('reports an unrecognised message as unknown rather than guessing at it', () => {
    expect(classifyAccelerationWorkerFailure(new Error('something else entirely'))).toBe('unknown')
    expect(classifyAccelerationWorkerFailure(null)).toBe('unknown')
  })
})

describe('idle helper check', () => {
  it('is idle after startup recovery and again once acceleration has stopped', async () => {
    const test = await setup()
    await test.backend.recover()
    expect(await test.backend.isIdle()).toBe(true)
    await test.backend.startAcceleration(scope, 'system-proxy')
    expect(await test.backend.isIdle()).toBe(false)
    await test.backend.stopAcceleration(scope)
    expect(await test.backend.isIdle()).toBe(true)
  })

  it('is not idle while a download holds the route', async () => {
    const test = await setup()
    await test.backend.startDownloadRoute(scope)
    expect(await test.backend.isIdle()).toBe(false)
    await test.backend.stopDownloadRoute()
    expect(await test.backend.isIdle()).toBe(true)
  })

  it('is not idle while the network settings still wait to be restored', async () => {
    const test = await setup()
    test.proxy.restore.mockRejectedValue(new Error('still pointing at the core'))
    await expect(test.backend.recover()).rejects.toThrow()
    expect(await test.backend.isIdle()).toBe(false)
  })
})

describe('helper shutdown retry delay', () => {
  it('starts at one second, doubles and settles at five minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50].map(accelerationShutdownRetryDelayMs))
      .toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000])
    expect(accelerationShutdownRetryDelayMs(0)).toBe(1_000)
  })
})

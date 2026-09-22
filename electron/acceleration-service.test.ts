import { describe, expect, it, vi } from 'vitest'
import type { AccelerationApi, AccelerationMode, AccelerationRedemptionResult, AccelerationState } from './acceleration-contract'
import { accelerationBonusCode, accelerationBonusSeconds, accelerationConflictNotice, accelerationFailureMessages, accelerationTrialSeconds, withAccelerationReason } from './acceleration-contract'
import { createAccelerationService } from './acceleration-service'

const scope = 'xm-account:42'
const otherScope = 'api-account:42'

function state(overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope, phase: 'idle', mode: 'system-proxy', totalSeconds: 3600, remainingSeconds: 3570,
    sessionSeconds: 0, measuredAt: '2026-09-14T08:00:00.000Z', connectedAt: null,
    line: { id: 'jp-01', name: '东京优选', region: '日本', latencyMs: 38 }, error: null,
    ...overrides,
  }
}

function active(overrides: Partial<AccelerationState> = {}): AccelerationState {
  return state({ phase: 'active', connectedAt: '2026-09-14T08:00:00.000Z', ...overrides })
}

function createBackend(): AccelerationApi {
  return {
    getAccelerationState: vi.fn(async (accountScope: string) => state({ scope: accountScope })),
    startAcceleration: vi.fn(async (accountScope: string, mode: AccelerationMode) => active({ scope: accountScope, mode })),
    stopAcceleration: vi.fn(async (accountScope: string) => state({ scope: accountScope })),
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('acceleration-service', () => {
  it('redeems only for the current account and projects a credential-free fixed bonus result', async () => {
    const backend = createBackend()
    const raw = { status: 'redeemed' as const, addedSeconds: accelerationBonusSeconds,
      state: { ...state(), nodePassword: 'private-node-password' }, code: accelerationBonusCode }
    backend.redeemAccelerationCode = vi.fn(async () => raw)
    let account: string | null = null
    const service = createAccelerationService({ getAccountScope: () => account, backend })
    await expect(service.redeemAccelerationCode(scope, accelerationBonusCode)).rejects.toThrow('账号已变更')
    account = otherScope
    await expect(service.redeemAccelerationCode(scope, accelerationBonusCode)).rejects.toThrow('账号已变更')
    expect(backend.redeemAccelerationCode).not.toHaveBeenCalled()
    account = scope
    expect(await service.redeemAccelerationCode(scope, accelerationBonusCode)).toEqual({
      status: 'redeemed', addedSeconds: accelerationBonusSeconds, state: state(),
    })
    expect(backend.redeemAccelerationCode).toHaveBeenCalledWith(scope, accelerationBonusCode)
  })

  it('publishes every projected state to a listener without letting it break the request', async () => {
    const backend = createBackend()
    const seen: AccelerationState[] = []
    const service = createAccelerationService({
      getAccountScope: () => scope, backend,
      onState: (published) => { seen.push(published); throw new Error('listener failed') },
    })
    await service.getAccelerationState(scope)
    await service.startAcceleration(scope, 'system-proxy')
    await service.stopAcceleration(scope)
    expect(seen.map((published) => published.phase)).toEqual(['idle', 'active', 'idle'])
    // 明文凭据不会因为多了一个监听者就流出去：拿到的是 projectState 的产物。
    expect(seen.every((published) => published.scope === scope)).toBe(true)
  })

  it('tells a listener that a build without a backend has no lines at all', async () => {
    const seen: AccelerationState[] = []
    const service = createAccelerationService({ getAccountScope: () => scope, onState: (published) => { seen.push(published) } })
    await service.getAccelerationState(scope)
    expect(seen.map((published) => published.phase)).toEqual(['unavailable'])
  })

  it('does not invent bonus time when the configured backend does not support redemption', async () => {
    const service = createAccelerationService({ getAccountScope: () => scope, backend: createBackend() })
    await expect(service.redeemAccelerationCode(scope, accelerationBonusCode)).rejects.toThrow('加速线路暂未开通')
  })

  it.each(['', ' ', 'x'.repeat(65), null, 600])('rejects a malformed promotion before invoking the backend: %s', async (code) => {
    const backend = createBackend()
    backend.redeemAccelerationCode = vi.fn()
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await expect(service.redeemAccelerationCode(scope, code as string)).rejects.toThrow('加速口令格式无效')
    expect(backend.redeemAccelerationCode).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'redeemed', addedSeconds: 1200, state: state() },
    { status: 'already-redeemed', addedSeconds: 600, state: state() },
    { status: ['already-redeemed'], addedSeconds: 0, state: state() },
    { status: 'invalid-code', addedSeconds: 0, state: state({ scope: otherScope }) },
    { status: 'redeemed', addedSeconds: 600, state: state({ phase: 'unavailable', remainingSeconds: null }) },
    { status: 'unknown', addedSeconds: 0, state: state() },
  ])('rejects an inconsistent redemption response %#', async (response) => {
    const backend = createBackend()
    backend.redeemAccelerationCode = vi.fn(async () => response as AccelerationRedemptionResult)
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await expect(service.redeemAccelerationCode(scope, accelerationBonusCode)).rejects.toThrow('加速口令兑换失败')
  })

  it('rejects a queued redemption after an account epoch changes without crediting the backend', async () => {
    const backend = createBackend()
    const held = deferred<AccelerationState>()
    const entered = deferred<void>()
    vi.mocked(backend.getAccelerationState).mockImplementationOnce(() => { entered.resolve(); return held.promise })
    backend.redeemAccelerationCode = vi.fn()
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const read = expect(service.getAccelerationState(scope)).rejects.toThrow('账号已变更')
    await entered.promise
    const redeem = expect(service.redeemAccelerationCode(scope, accelerationBonusCode)).rejects.toThrow('账号已变更')
    const changed = service.onAccountChanged()
    held.resolve(state())
    await Promise.all([read, redeem, changed])
    expect(backend.redeemAccelerationCode).not.toHaveBeenCalled()
  })

  it('does not return an old account redemption to a new account while the backend completes', async () => {
    const backend = createBackend()
    const held = deferred<AccelerationRedemptionResult>()
    const entered = deferred<void>()
    backend.redeemAccelerationCode = vi.fn(() => { entered.resolve(); return held.promise })
    let account = scope
    const service = createAccelerationService({ getAccountScope: () => account, backend })
    const redeem = expect(service.redeemAccelerationCode(scope, accelerationBonusCode)).rejects.toThrow('账号已变更')
    await entered.promise
    account = otherScope
    const changed = service.onAccountChanged()
    held.resolve({ status: 'redeemed', addedSeconds: 600, state: state() })
    await Promise.all([redeem, changed])
    expect(backend.redeemAccelerationCode).toHaveBeenCalledExactlyOnceWith(scope, accelerationBonusCode)
  })

  it('does not leak backend errors or imply that a failed write credited time', async () => {
    const backend = createBackend()
    backend.redeemAccelerationCode = vi.fn(async () => { throw new Error('private-proxy-token') })
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await expect(service.redeemAccelerationCode(scope, accelerationBonusCode)).rejects.toThrow(/^加速口令兑换失败，请稍后重试。$/)
  })

  it.each(['local-device', 'local-development', 'server'] as const)('preserves the explicit %s entitlement source across IPC', async (entitlementSource) => {
    const backend = createBackend()
    vi.mocked(backend.getAccelerationState).mockResolvedValue(state({ entitlementSource }))
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    expect((await service.getAccelerationState(scope)).entitlementSource).toBe(entitlementSource)
  })

  it.each(['list', 'ping'] as const)('rejects queued %s requests from an expired account epoch before invoking the backend', async (kind) => {
    const backend = createBackend()
    const line = state().line!
    backend.listAccelerationLines = vi.fn(async () => [line])
    backend.pingAccelerationLine = vi.fn(async () => line)
    const held = deferred<AccelerationState>()
    const entered = deferred<void>()
    vi.mocked(backend.getAccelerationState).mockImplementationOnce(() => { entered.resolve(); return held.promise })
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const first = expect(service.getAccelerationState(scope)).rejects.toThrow('账号已变更')
    await entered.promise
    const stale = expect(kind === 'list' ? service.listAccelerationLines!(scope) : service.pingAccelerationLine!(scope, line.id)).rejects.toThrow('账号已变更')
    const changed = service.onAccountChanged()
    held.resolve(state())
    await Promise.all([first, stale, changed])
    expect(backend.listAccelerationLines).not.toHaveBeenCalled()
    expect(backend.pingAccelerationLine).not.toHaveBeenCalled()
  })

  it.each(['list', 'ping'] as const)('rejects an in-flight %s response after the same account signs in again', async (kind) => {
    const backend = createBackend()
    const line = state().line!
    const held = deferred<void>()
    const entered = deferred<void>()
    backend.listAccelerationLines = vi.fn(async () => { entered.resolve(); await held.promise; return [line] })
    backend.pingAccelerationLine = vi.fn(async () => { entered.resolve(); await held.promise; return line })
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const stale = expect(kind === 'list' ? service.listAccelerationLines!(scope) : service.pingAccelerationLine!(scope, line.id)).rejects.toThrow('加速服务暂不可用')
    await entered.promise
    const changed = service.onAccountChanged()
    held.resolve()
    await Promise.all([stale, changed])
  })

  it('reports unavailable without minting a trial balance or a fake connection', async () => {
    const service = createAccelerationService({ getAccountScope: () => scope })
    expect(await service.getAccelerationState(scope)).toEqual({
      scope, phase: 'unavailable', mode: 'system-proxy', totalSeconds: accelerationTrialSeconds, remainingSeconds: null,
      sessionSeconds: 0, measuredAt: expect.any(String), connectedAt: null, line: null, error: null,
    })
    await expect(service.startAcceleration(scope, 'tun')).rejects.toThrow('加速线路暂未开通，请稍后再试。')
    expect((await service.stopAcceleration(scope)).phase).toBe('unavailable')
    await service.dispose()
  })

  it.each(['', 'xm-account:0', 'xm-account:-1', 'xm-account:01', 'xm-account:1/../2', 'api-account:1.1', 'xm-account:9007199254740992', 'other:42'])('rejects malformed scopes: %s', async (invalidScope) => {
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => invalidScope, backend })
    await expect(service.getAccelerationState(invalidScope)).rejects.toThrow('加速账号参数无效')
    expect(backend.getAccelerationState).not.toHaveBeenCalled()
  })

  it('rejects logged-out access and another backend account with the same user id', async () => {
    let accountScope: string | null = null
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => accountScope, backend })
    await expect(service.getAccelerationState(scope)).rejects.toThrow('账号已变更')
    accountScope = scope
    await expect(service.startAcceleration(otherScope, 'tun')).rejects.toThrow('账号已变更')
    expect(backend.startAcceleration).not.toHaveBeenCalled()
  })

  it('validates the mode before calling the backend', async () => {
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await expect(service.startAcceleration(scope, 'global' as AccelerationMode)).rejects.toThrow('加速模式无效')
    expect(backend.startAcceleration).not.toHaveBeenCalled()
  })

  it('passes backend quota and timestamps through a credential-free projection', async () => {
    const backend = createBackend()
    const source = {
      ...active({ mode: 'tun', totalSeconds: 3600, remainingSeconds: 1200, sessionSeconds: 42 }),
      nodeConfig: { password: 'top-secret' },
      line: { id: 'jp-01', name: '东京优选', region: '日本', latencyMs: 38, password: 'top-secret' },
    }
    vi.mocked(backend.startAcceleration).mockResolvedValue(source)
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const result = await service.startAcceleration(scope, 'tun')
    expect(result).toEqual(active({ mode: 'tun', totalSeconds: 3600, remainingSeconds: 1200, sessionSeconds: 42 }))
    expect(JSON.stringify(result)).not.toContain('top-secret')
    expect(result).not.toBe(source)
    expect(result.line).not.toBe(source.line)
  })

  it.each([
    { entitlementSource: 'free-forever' }, { supportedModes: ['invalid'] }, { supportedModes: [] },
    { scope: otherScope }, { phase: 'connected' }, { mode: 'global' }, { totalSeconds: -1 },
    { remainingSeconds: 3601 }, { sessionSeconds: 0.5 }, { totalSeconds: 8_640_001 },
    { measuredAt: 'yesterday' }, { connectedAt: 'later' }, { phase: 'active', connectedAt: null },
    { phase: 'exhausted', remainingSeconds: 1 }, { error: 'password=top-secret' },
    { line: { id: 'jp', name: 'https://user:pass@node.example', region: '日本', latencyMs: 5 } },
    { line: { id: 'jp', name: '东京', region: '日本', latencyMs: Number.NaN } },
    { conflicts: [] }, { conflicts: 'system-proxy' }, { conflicts: ['vpn'] },
    { conflicts: ['system-proxy', 'system-proxy'] },
  ])('rejects malformed or unsafe backend data: %j', async (invalidFields) => {
    const backend = createBackend()
    vi.mocked(backend.getAccelerationState).mockResolvedValue({ ...state(), ...invalidFields } as AccelerationState)
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await expect(service.getAccelerationState(scope)).rejects.toThrow('加速服务暂不可用')
  })

  it('projects a conflict refusal and forwards the user override to the backend', async () => {
    const backend = createBackend()
    const refusal = state({ phase: 'error', error: accelerationConflictNotice, conflicts: ['system-proxy', 'virtual-adapter'] })
    vi.mocked(backend.startAcceleration).mockResolvedValueOnce(refusal)
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const blocked = await service.startAcceleration(scope, 'system-proxy')
    expect(blocked).toEqual(refusal)
    expect(blocked.conflicts).not.toBe(refusal.conflicts)
    expect(backend.startAcceleration).toHaveBeenLastCalledWith(scope, 'system-proxy', undefined, undefined)

    const retried = await service.startAcceleration(scope, 'system-proxy', undefined, true)
    expect(retried.phase).toBe('active')
    expect(backend.startAcceleration).toHaveBeenLastCalledWith(scope, 'system-proxy', undefined, true)
  })

  it('rejects a non-boolean override without reaching the backend', async () => {
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await expect(service.startAcceleration(scope, 'system-proxy', undefined, 'yes' as unknown as boolean))
      .rejects.toThrow('加速冲突确认参数无效。')
    expect(backend.startAcceleration).not.toHaveBeenCalled()
  })

  it('does not leak backend exception text', async () => {
    const backend = createBackend()
    vi.mocked(backend.getAccelerationState).mockRejectedValue(new Error('token=private-server-secret'))
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await expect(service.getAccelerationState(scope)).rejects.toThrow('加速服务暂不可用，请稍后重试。')
  })

  it('rejects a backend that starts a different mode and stops the uncertain session', async () => {
    const backend = createBackend()
    vi.mocked(backend.startAcceleration).mockResolvedValue(active({ mode: 'system-proxy' }))
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await expect(service.startAcceleration(scope, 'tun')).rejects.toThrow('加速服务暂不可用')
    expect(backend.stopAcceleration).toHaveBeenCalledWith(scope)
  })

  it('deduplicates double clicks and serializes a stop behind a pending start', async () => {
    const backend = createBackend()
    const started = deferred<AccelerationState>()
    const startEntered = deferred<void>()
    vi.mocked(backend.startAcceleration).mockImplementation(() => { startEntered.resolve(); return started.promise })
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const first = service.startAcceleration(scope, 'tun')
    const duplicate = service.startAcceleration(scope, 'tun')
    expect(first).toBe(duplicate)
    const stop = service.stopAcceleration(scope)
    const duplicateStop = service.stopAcceleration(scope)
    expect(stop).toBe(duplicateStop)
    await startEntered.promise
    expect(backend.stopAcceleration).not.toHaveBeenCalled()
    started.resolve(active({ mode: 'tun' }))
    expect((await first).phase).toBe('active')
    expect((await stop).phase).toBe('idle')
    expect(backend.startAcceleration).toHaveBeenCalledTimes(1)
    expect(backend.stopAcceleration).toHaveBeenCalledTimes(1)
  })

  it('stops a late start when the account switches before its response', async () => {
    let accountScope = scope
    const backend = createBackend()
    const started = deferred<AccelerationState>()
    const startEntered = deferred<void>()
    vi.mocked(backend.startAcceleration).mockImplementation(() => { startEntered.resolve(); return started.promise })
    const service = createAccelerationService({ getAccountScope: () => accountScope, backend })
    const start = service.startAcceleration(scope, 'tun')
    const startResult = expect(start).rejects.toThrow('账号已变更')
    await startEntered.promise
    accountScope = otherScope
    const changed = service.onAccountChanged()
    started.resolve(active({ mode: 'tun' }))
    await startResult
    await changed
    expect(backend.stopAcceleration).toHaveBeenCalledWith(scope)
    expect((await service.getAccelerationState(otherScope)).scope).toBe(otherScope)
  })

  it('rejects old responses even if the same account logs back in', async () => {
    const backend = createBackend()
    const response = deferred<AccelerationState>()
    const requestEntered = deferred<void>()
    vi.mocked(backend.getAccelerationState).mockImplementation(() => { requestEntered.resolve(); return response.promise })
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const pending = service.getAccelerationState(scope)
    const rejected = expect(pending).rejects.toThrow('账号已变更')
    await requestEntered.promise
    const changed = service.onAccountChanged()
    response.resolve(active())
    await rejected
    await changed
    expect(backend.stopAcceleration).toHaveBeenCalledWith(scope)
  })

  it('stops a prior session before the next account can start', async () => {
    let accountScope = scope
    const backend = createBackend()
    const order: string[] = []
    vi.mocked(backend.startAcceleration).mockImplementation(async (next, mode) => { order.push(`start:${next}`); return active({ scope: next, mode }) })
    vi.mocked(backend.stopAcceleration).mockImplementation(async (previous) => { order.push(`stop:${previous}`); return state({ scope: previous }) })
    const service = createAccelerationService({ getAccountScope: () => accountScope, backend })
    await service.startAcceleration(scope, 'system-proxy')
    accountScope = otherScope
    await service.startAcceleration(otherScope, 'tun')
    expect(order).toEqual([`start:${scope}`, `stop:${scope}`, `start:${otherScope}`])
  })

  it('retains failed cleanup and prevents another account from starting until it stops', async () => {
    let accountScope = scope
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => accountScope, backend })
    await service.startAcceleration(scope, 'tun')
    accountScope = otherScope
    vi.mocked(backend.stopAcceleration).mockRejectedValueOnce(new Error('secret transport details'))
    await expect(service.startAcceleration(otherScope, 'tun')).rejects.toThrow('停止加速未完成')
    expect(backend.startAcceleration).toHaveBeenCalledTimes(1)
    await service.startAcceleration(otherScope, 'tun')
    expect(backend.stopAcceleration).toHaveBeenCalledTimes(2)
  })

  it('preserves a logout cleanup when the same account logs in before the queue runs', async () => {
    let accountScope: string | null = scope
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => accountScope, backend })
    await service.startAcceleration(scope, 'tun')
    accountScope = null
    const loggedOut = service.onAccountChanged()
    accountScope = scope
    const loggedIn = service.onAccountChanged()
    await Promise.all([loggedOut, loggedIn])
    expect(backend.stopAcceleration).toHaveBeenCalledWith(scope)
    expect(backend.stopAcceleration).toHaveBeenCalledTimes(1)
  })

  it('cleans up a failed start without leaving the serialization queue rejected', async () => {
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    vi.mocked(backend.startAcceleration).mockRejectedValueOnce(new Error('start uncertain'))
    await expect(service.startAcceleration(scope, 'tun')).rejects.toThrow('加速服务暂不可用')
    expect(backend.stopAcceleration).toHaveBeenCalledWith(scope)
    expect((await service.startAcceleration(scope, 'tun')).phase).toBe('active')
  })

  it('blocks lifecycle transitions after logout until every possible session has stopped, then allows another login', async () => {
    let accountScope: string | null = scope
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => accountScope, backend })
    await service.startAcceleration(scope, 'system-proxy')
    accountScope = null
    const restoring = active({ phase: 'stopping', error: '系统代理仍在恢复' })
    vi.mocked(backend.stopAcceleration).mockResolvedValueOnce(restoring).mockResolvedValueOnce(restoring)
    await expect(service.onAccountChanged()).rejects.toThrow('停止加速未完成')
    await expect(service.stopAll()).rejects.toThrow('停止加速未完成')
    expect(backend.startAcceleration).toHaveBeenCalledTimes(1)
    await service.stopAll()
    expect(backend.stopAcceleration).toHaveBeenCalledTimes(3)
    expect(backend.stopAcceleration).toHaveBeenLastCalledWith(scope)
    accountScope = otherScope
    await service.onAccountChanged()
    expect(await service.startAcceleration(otherScope, 'system-proxy')).toMatchObject({ scope: otherScope, phase: 'active' })
  })

  it('drains a late start and cancels queued starts without permanently closing the service', async () => {
    const backend = createBackend()
    const started = deferred<AccelerationState>()
    const startEntered = deferred<void>()
    vi.mocked(backend.startAcceleration).mockImplementationOnce(() => { startEntered.resolve(); return started.promise })
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const first = expect(service.startAcceleration(scope, 'tun')).rejects.toThrow('账号已变更')
    await startEntered.promise
    const queued = expect(service.startAcceleration(scope, 'system-proxy')).rejects.toThrow('账号已变更')
    const stopped = service.stopAll()
    started.resolve(active({ mode: 'tun' }))
    await Promise.all([first, queued, stopped])
    expect(backend.startAcceleration).toHaveBeenCalledTimes(1)
    expect(backend.stopAcceleration).toHaveBeenCalledTimes(1)
    expect((await service.startAcceleration(scope, 'system-proxy')).phase).toBe('active')
  })

  it('disposes active sessions and rejects subsequent access', async () => {
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await service.startAcceleration(scope, 'tun')
    const disposed = service.dispose()
    expect(service.dispose()).toBe(disposed)
    await disposed
    expect(backend.stopAcceleration).toHaveBeenCalledWith(scope)
    await expect(service.getAccelerationState(scope)).rejects.toThrow('游戏加速服务已关闭')
  })

  it('can retry disposal after a transport stop failure', async () => {
    const backend = createBackend()
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    await service.startAcceleration(scope, 'tun')
    vi.mocked(backend.stopAcceleration).mockRejectedValueOnce(new Error('timeout'))
    await expect(service.dispose()).rejects.toThrow('停止加速未完成')
    await service.dispose()
    expect(backend.stopAcceleration).toHaveBeenCalledTimes(2)
  })

  it('disposes a start still in progress and cancels queued starts', async () => {
    const backend = createBackend()
    const started = deferred<AccelerationState>()
    const startEntered = deferred<void>()
    vi.mocked(backend.startAcceleration).mockImplementation(() => { startEntered.resolve(); return started.promise })
    const service = createAccelerationService({ getAccountScope: () => scope, backend })
    const first = service.startAcceleration(scope, 'tun')
    const firstResult = expect(first).rejects.toThrow('账号已变更')
    await startEntered.promise
    const next = service.startAcceleration(scope, 'system-proxy')
    const nextResult = expect(next).rejects.toThrow('游戏加速服务已关闭')
    const disposed = service.dispose()
    started.resolve(active({ mode: 'tun' }))
    await firstResult
    await nextResult
    await disposed
    expect(backend.startAcceleration).toHaveBeenCalledTimes(1)
    expect(backend.stopAcceleration).toHaveBeenCalledTimes(1)
  })
})

describe('acceleration failure reasons', () => {
  it('speaks the reason the backend classified instead of one sentence for everything', async () => {
    // 读状态失败以前只有「加速服务暂不可用，请稍后重试。」一句话，临时目录、
    // 被别的实例占着、本机账本损坏在界面和日志里长得一模一样（2026-09-22）。
    for (const reason of ['helper-temp', 'proxy-owned', 'proxy-locked', 'local-data'] as const) {
      const backend = createBackend()
      backend.getAccelerationState = vi.fn(async () => {
        throw withAccelerationReason(new Error('本机加速进程启动失败。'), reason)
      })
      const service = createAccelerationService({ backend, getAccountScope: () => scope })
      const rejection: unknown = await service.getAccelerationState(scope).catch((error: unknown) => error)
      expect([reason, (rejection as Error).message]).toEqual([reason, accelerationFailureMessages[reason]])
      // 归类跟着错误走，日志那边才能按原因检索，而不是再去认一遍中文。
      expect([reason, (rejection as { accelerationReason?: string }).accelerationReason]).toEqual([reason, reason])
    }
  })

  it('keeps the original sentence for a failure nothing classified', async () => {
    const backend = createBackend()
    backend.getAccelerationState = vi.fn(async () => { throw new Error('private-node-password leaked') })
    const service = createAccelerationService({ backend, getAccountScope: () => scope })
    const rejection: unknown = await service.getAccelerationState(scope).catch((error: unknown) => error)
    expect((rejection as Error).message).toBe('加速服务暂不可用，请稍后重试。')
    expect((rejection as { accelerationReason?: string }).accelerationReason).toBe('unknown')
  })
})

describe('acceleration preference', () => {
  function preferenceService(overrides: Partial<Parameters<typeof createAccelerationService>[0]> = {}) {
    const saveAccelerationPreference = vi.fn(async () => ({ lineId: 'jp-01', mode: 'system-proxy' as const }))
    const getAccelerationPreference = vi.fn(async () => ({ lineId: 'jp-01', mode: 'tun' as const }))
    const service = createAccelerationService({
      backend: createBackend(),
      getAccountScope: () => scope,
      preferences: { getAccelerationPreference, saveAccelerationPreference },
      ...overrides,
    })
    return { service, getAccelerationPreference, saveAccelerationPreference }
  }

  it('reads and writes through the injected store', async () => {
    const { service, saveAccelerationPreference } = preferenceService()
    await expect(service.getAccelerationPreference(scope)).resolves.toEqual({ lineId: 'jp-01', mode: 'tun' })
    await service.saveAccelerationPreference(scope, { lineId: 'jp-01' })
    expect(saveAccelerationPreference).toHaveBeenCalledWith(scope, { lineId: 'jp-01' })
  })

  it('refuses an account scope or a field the renderer made up', async () => {
    const { service, saveAccelerationPreference } = preferenceService()
    await expect(service.getAccelerationPreference('../etc')).rejects.toThrow('加速账号参数无效。')
    await expect(service.saveAccelerationPreference(scope, { lineId: '../../secrets' })).rejects.toThrow('加速线路参数无效。')
    await expect(service.saveAccelerationPreference(scope, { mode: 'router' as never })).rejects.toThrow('加速模式无效。')
    expect(saveAccelerationPreference).not.toHaveBeenCalled()
  })

  it('drops the fields the caller did not send instead of writing them as undefined', async () => {
    const { service, saveAccelerationPreference } = preferenceService()
    await service.saveAccelerationPreference(scope, { mode: 'tun' })
    expect(saveAccelerationPreference).toHaveBeenCalledWith(scope, { mode: 'tun' })
    await service.saveAccelerationPreference(scope, { lineId: null })
    expect(saveAccelerationPreference).toHaveBeenLastCalledWith(scope, { lineId: null })
  })

  // 没有偏好存储的宿主（早于这一版、或本机联调）照旧每次从智能分配 + 标准模式开始。
  it('answers "never chose anything" when no store was injected', async () => {
    const service = createAccelerationService({ backend: createBackend(), getAccountScope: () => scope })
    await expect(service.getAccelerationPreference(scope)).resolves.toEqual({ lineId: null, mode: 'system-proxy' })
    await expect(service.saveAccelerationPreference(scope, { lineId: null })).rejects.toThrow('加速线路偏好暂不可用，请稍后重试。')
  })

  // 连接会在队列里排十几秒，界面上点一下线路不该等它。
  it('does not queue behind a connection in flight', async () => {
    const pending = deferred<AccelerationState>()
    const backend = createBackend()
    vi.mocked(backend.startAcceleration).mockReturnValueOnce(pending.promise)
    const { service } = preferenceService({ backend })
    const connecting = service.startAcceleration(scope, 'system-proxy')
    await expect(service.getAccelerationPreference(scope)).resolves.toEqual({ lineId: 'jp-01', mode: 'tun' })
    pending.resolve(active())
    await connecting
  })
})

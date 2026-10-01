import { describe, expect, it, vi } from 'vitest'
import type { AccelerationApi, AccelerationState } from './acceleration-contract'
import { createAccelerationService } from './acceleration-service'
import { buildAccountIdentity, createAccountIdentityTracker } from './account-identity-tracker'

const scope = 'xm-account:42'

function active(): AccelerationState {
  return {
    scope, phase: 'active', mode: 'system-proxy', totalSeconds: 3600, remainingSeconds: 3570,
    sessionSeconds: 0, measuredAt: '2026-10-01T14:10:00.000Z', connectedAt: '2026-10-01T14:00:00.000Z',
    line: { id: 'jp-01', name: '东京优选', region: '日本', latencyMs: 38 }, error: null,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

/** 照 main.ts 的 onChanged 接线：身份变了才通知加速。 */
function harness() {
  const held = deferred<AccelerationState>()
  const entered = deferred<void>()
  const backend: AccelerationApi = {
    getAccelerationState: vi.fn(() => { entered.resolve(); return held.promise }),
    startAcceleration: vi.fn(async () => active()),
    stopAcceleration: vi.fn(async () => ({ ...active(), phase: 'idle' as const, connectedAt: null })),
  }
  let account: string | null = scope
  const acceleration = createAccelerationService({ getAccountScope: () => account, backend })
  const tracker = createAccountIdentityTracker()
  function changed(siteId: 'solov' | 'solov-api', userId: number | null, sessionRevision: number) {
    account = userId === null ? null : `${siteId === 'solov' ? 'xm-account' : 'api-account'}:${userId}`
    if (tracker.advance(buildAccountIdentity(siteId, userId, sessionRevision))) void acceleration.onAccountChanged().catch(() => undefined)
  }
  return { backend, acceleration, changed, held, entered }
}

describe('account-identity-tracker', () => {
  it('reports a change only when site, user or session revision differs', () => {
    const tracker = createAccountIdentityTracker()
    expect(tracker.advance(buildAccountIdentity('solov', 42, 1))).toBe(true)
    expect(tracker.advance(buildAccountIdentity('solov', 42, 1))).toBe(false)
    expect(tracker.advance(buildAccountIdentity('solov', 43, 1))).toBe(true)
    expect(tracker.advance(buildAccountIdentity('solov-api', 43, 1))).toBe(true)
    expect(tracker.advance(buildAccountIdentity('solov-api', 43, 2))).toBe(true)
    expect(tracker.advance(buildAccountIdentity('solov-api', null, 3))).toBe(true)
    expect(buildAccountIdentity('solov', undefined, 3)).toBe('solov:guest:3')
  })

  it('keeps an in-flight acceleration query and the running tunnel when the session only refreshes', async () => {
    const { backend, acceleration, changed, held, entered } = harness()
    changed('solov', 42, 1)
    const pending = acceleration.getAccelerationState(scope)
    await entered.promise
    // 续期换凭据、付款后刷新余额：登录态快照变了，会话代数没变。
    changed('solov', 42, 1)
    changed('solov', 42, 1)
    held.resolve(active())
    await expect(pending).resolves.toMatchObject({ phase: 'active' })
    expect(backend.stopAcceleration).not.toHaveBeenCalled()
  })

  it('still invalidates an in-flight acceleration query when the account really changes', async () => {
    const { backend, acceleration, changed, held, entered } = harness()
    changed('solov', 42, 1)
    const pending = acceleration.getAccelerationState(scope)
    await entered.promise
    changed('solov', 42, 2)
    held.resolve(active())
    await expect(pending).rejects.toThrow('账号已变更')
    expect(backend.stopAcceleration).toHaveBeenCalledWith(scope)
  })
})

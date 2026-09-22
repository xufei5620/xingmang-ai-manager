import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accelerationBonusCode, accelerationBonusSeconds, accelerationConflictNotice, accelerationTrialSeconds } from '../../../../electron/acceleration-contract'
import type { AccelerationApi, AccelerationClient, AccelerationMode, AccelerationPreference, AccelerationPreferenceUpdate, AccelerationRedemptionResult, AccelerationState } from './api'
import { createAccelerationApi } from './api'
import { createAccelerationController, type AccelerationController } from './controller'

function state(overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope: 'new-api:1', phase: 'idle', mode: 'system-proxy', totalSeconds: accelerationTrialSeconds,
    remainingSeconds: accelerationTrialSeconds, sessionSeconds: 0, measuredAt: '2026-09-14T00:00:00Z',
    connectedAt: null, line: null, error: null, ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('acceleration controller', () => {
  const controllers: AccelerationController[] = []
  let monotonic = 0
  function create(initial = state()) {
    let hostState = initial
    let hostAnchor = monotonic
    function readHost() {
      const elapsed = hostState.phase === 'active' ? (monotonic - hostAnchor) / 1000 : 0
      return { ...hostState, remainingSeconds: hostState.remainingSeconds === null ? null : Math.max(0, hostState.remainingSeconds - elapsed), sessionSeconds: hostState.sessionSeconds + elapsed }
    }
    const api = {
      getAccelerationState: vi.fn<AccelerationApi['getAccelerationState']>().mockImplementation(async () => readHost()),
      startAcceleration: vi.fn<AccelerationApi['startAcceleration']>().mockImplementation(async (scope, mode) => {
        hostState = { ...readHost(), scope, mode, phase: 'active', sessionSeconds: 0, connectedAt: `session:${monotonic}`, error: null }
        hostAnchor = monotonic
        return hostState
      }),
      stopAcceleration: vi.fn<AccelerationApi['stopAcceleration']>().mockImplementation(async () => {
        hostState = { ...readHost(), phase: 'idle', connectedAt: null }
        if (hostState.remainingSeconds === 0) hostState.phase = 'exhausted'
        hostAnchor = monotonic
        return hostState
      }),
      redeemAccelerationCode: vi.fn<NonNullable<AccelerationApi['redeemAccelerationCode']>>().mockResolvedValue({
        status: 'redeemed', addedSeconds: accelerationBonusSeconds,
        state: state({ totalSeconds: 1800, remainingSeconds: 1800 }),
      }),
    }
    const controller = createAccelerationController(api, { now: () => monotonic })
    controllers.push(controller)
    return { controller, api }
  }
  async function advance(ms: number) {
    monotonic += ms
    await vi.advanceTimersByTimeAsync(ms)
  }
  beforeEach(() => { vi.useFakeTimers(); monotonic = 0 })
  afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.useRealTimers() })

  it('does not issue free time locally and shares one initial host read', async () => {
    const { controller, api } = create()
    expect(controller.getSnapshot().state).toBeNull()
    expect(controller.getSnapshot()).toBe(controller.getSnapshot())
    controller.setScope('new-api:1')
    const read = controller.refresh()
    expect(controller.refresh()).toBe(read)
    await read
    expect(api.getAccelerationState).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ busy: false, state: { phase: 'idle', remainingSeconds: accelerationTrialSeconds } })
  })

  it('counts only an established connection, freezes after stop and resumes the host balance', async () => {
    const { controller } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    await advance(10_000)
    expect(controller.getSnapshot().state?.remainingSeconds).toBe(accelerationTrialSeconds)
    await controller.start()
    await advance(5000)
    expect(controller.getSnapshot().state).toMatchObject({ remainingSeconds: accelerationTrialSeconds - 5, sessionSeconds: 5 })
    await controller.stop()
    await advance(10_000)
    expect(controller.getSnapshot().state?.remainingSeconds).toBe(accelerationTrialSeconds - 5)
    await controller.start()
    await advance(3000)
    expect(controller.getSnapshot().state).toMatchObject({ remainingSeconds: accelerationTrialSeconds - 8, sessionSeconds: 3 })
  })

  it('does not count connecting time or allow a duplicate start', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    const pending = deferred<AccelerationState>()
    api.startAcceleration.mockReturnValueOnce(pending.promise)
    const start = controller.start()
    expect(controller.start()).toBe(start)
    await advance(9000)
    expect(controller.getSnapshot()).toMatchObject({ busy: true, state: { phase: 'connecting', remainingSeconds: accelerationTrialSeconds } })
    pending.resolve(state({ phase: 'active', connectedAt: 'session-a' }))
    await start
    await advance(2000)
    expect(controller.getSnapshot().state?.remainingSeconds).toBe(accelerationTrialSeconds - 2)
    expect(api.startAcceleration).toHaveBeenCalledTimes(1)
  })

  it('keeps counting during a pending stop and preserves connectivity after stop fails', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    const pending = deferred<AccelerationState>()
    api.stopAcceleration.mockReturnValueOnce(pending.promise)
    const stop = controller.stop()
    await advance(4000)
    expect(controller.getSnapshot()).toMatchObject({ busy: true, state: { phase: 'stopping', remainingSeconds: accelerationTrialSeconds - 4 } })
    pending.reject(new Error('连接尚未停止'))
    await stop
    await advance(2000)
    expect(controller.getSnapshot()).toMatchObject({ busy: false, error: '连接尚未停止', state: { phase: 'active', remainingSeconds: accelerationTrialSeconds - 6 } })
    await controller.stop()
    expect(controller.getSnapshot().state?.phase).toBe('idle')
  })

  it('preserves the available allowance after connection failure', async () => {
    const { controller, api } = create(state({ remainingSeconds: 773 }))
    controller.setScope('new-api:1')
    await controller.refresh()
    api.startAcceleration.mockRejectedValueOnce(new Error('节点连接失败'))
    await controller.start()
    expect(controller.getSnapshot()).toMatchObject({ busy: false, error: '节点连接失败', state: { phase: 'idle', remainingSeconds: 773 } })
  })

  it('does not stop when hidden and projects elapsed monotonic time when shown again', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    controller.setVisible(false)
    await advance(65_000)
    expect(api.stopAcceleration).not.toHaveBeenCalled()
    expect(api.getAccelerationState).toHaveBeenCalledTimes(1)
    controller.setVisible(true)
    expect(controller.getSnapshot().state).toMatchObject({ remainingSeconds: accelerationTrialSeconds - 65, sessionSeconds: 65 })
    await controller.refresh()
    expect(api.getAccelerationState).toHaveBeenCalledTimes(2)
  })

  it('polls visible pages every fifteen seconds and retains a balance when reading fails', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    await advance(14_999)
    expect(api.getAccelerationState).toHaveBeenCalledTimes(1)
    api.getAccelerationState.mockRejectedValueOnce(new Error('读取失败'))
    await advance(1)
    expect(api.getAccelerationState).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({ error: '读取失败', state: { remainingSeconds: accelerationTrialSeconds - 15, phase: 'active' } })
    await advance(15_000)
    expect(controller.getSnapshot().error).toBeNull()
    expect(controller.getSnapshot().state?.remainingSeconds).toBe(accelerationTrialSeconds - 30)
  })

  it('does not grant time when the system wall clock changes', async () => {
    const { controller } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    vi.setSystemTime(new Date('2035-01-01'))
    await advance(3000)
    vi.setSystemTime(new Date('2000-01-01'))
    await advance(2000)
    expect(controller.getSnapshot().state?.remainingSeconds).toBe(accelerationTrialSeconds - 5)
  })

  it('requests stop once at exhaustion even while hidden', async () => {
    const { controller, api } = create(state({ remainingSeconds: 3 }))
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    controller.setVisible(false)
    await advance(3000)
    expect(api.stopAcceleration).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().state).toMatchObject({ phase: 'exhausted', remainingSeconds: 0 })
    await advance(20_000)
    expect(api.stopAcceleration).toHaveBeenCalledTimes(1)
  })

  it('does not repeatedly stop or claim disconnection after automatic stop fails', async () => {
    const { controller, api } = create(state({ remainingSeconds: 2 }))
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    api.stopAcceleration.mockRejectedValueOnce(new Error('断开失败'))
    await advance(2000)
    await advance(4000)
    expect(api.stopAcceleration).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ state: { phase: 'active', remainingSeconds: 0 }, error: '断开失败' })
    await controller.stop()
    expect(controller.getSnapshot().state?.phase).toBe('exhausted')
  })

  it('does not let an older read overwrite a completed start or stop', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    const oldIdle = deferred<AccelerationState>()
    api.getAccelerationState.mockReturnValueOnce(oldIdle.promise)
    const staleRead = controller.refresh()
    await Promise.resolve()
    await controller.start()
    oldIdle.resolve(state())
    await staleRead
    expect(controller.getSnapshot().state?.phase).toBe('active')
    const oldActive = deferred<AccelerationState>()
    api.getAccelerationState.mockReturnValueOnce(oldActive.promise)
    const staleActiveRead = controller.refresh()
    await Promise.resolve()
    await controller.stop()
    oldActive.resolve(state({ phase: 'active', connectedAt: 'session-a' }))
    await staleActiveRead
    expect(controller.getSnapshot().state?.phase).toBe('idle')
  })

  it('does not leak a previous account response or stop its session as the next account', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    const pending = deferred<AccelerationState>()
    api.startAcceleration.mockReturnValueOnce(pending.promise)
    const start = controller.start()
    await Promise.resolve()
    api.getAccelerationState.mockResolvedValueOnce(state({ scope: 'sub2api:2', remainingSeconds: 600 }))
    controller.setScope('sub2api:2')
    await controller.refresh()
    pending.resolve(state({ phase: 'active', connectedAt: 'session-old' }))
    await start
    expect(controller.getSnapshot().state).toMatchObject({ scope: 'sub2api:2', phase: 'idle', remainingSeconds: 600 })
    expect(api.stopAcceleration).not.toHaveBeenCalled()
  })

  it('rejects mismatched account responses without replacing an existing balance', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    api.getAccelerationState.mockResolvedValueOnce(state({ scope: 'sub2api:2', remainingSeconds: 42 }))
    await controller.refresh()
    expect(controller.getSnapshot().state?.remainingSeconds).toBe(accelerationTrialSeconds)
    expect(controller.getSnapshot().error).toContain('账号或时长信息无效')
  })

  it('submits redemption once and uses the authoritative returned balance without an optimistic credit', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    const pending = deferred<AccelerationRedemptionResult>()
    api.redeemAccelerationCode.mockReturnValueOnce(pending.promise)
    const redemption = controller.redeem(accelerationBonusCode)
    expect(controller.redeem(accelerationBonusCode)).toBe(redemption)
    await Promise.resolve()
    expect(api.redeemAccelerationCode).toHaveBeenCalledExactlyOnceWith('new-api:1', accelerationBonusCode)
    expect(controller.getSnapshot()).toMatchObject({ busy: true, state: { remainingSeconds: 1200 } })
    const result: AccelerationRedemptionResult = { status: 'redeemed', addedSeconds: 600, state: state({ totalSeconds: 1800, remainingSeconds: 1471, sessionSeconds: 329 }) }
    pending.resolve(result)
    expect(await redemption).toEqual(result)
    expect(controller.getSnapshot()).toMatchObject({ busy: false, state: { totalSeconds: 1800, remainingSeconds: 1471, sessionSeconds: 329 } })
  })

  it('does not let an old poll overwrite a completed redemption', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    const oldBalance = deferred<AccelerationState>()
    api.getAccelerationState.mockReturnValueOnce(oldBalance.promise)
    const oldPoll = controller.refresh()
    await Promise.resolve()
    await controller.redeem(accelerationBonusCode)
    oldBalance.resolve(state())
    await oldPoll
    expect(controller.getSnapshot()).toMatchObject({ busy: false, state: { remainingSeconds: 1800 } })
  })

  it('discards a redemption result after an account switch or disposal', async () => {
    for (const action of ['switch', 'dispose']) {
      const { controller, api } = create()
      controller.setScope('new-api:1')
      await controller.refresh()
      const pending = deferred<AccelerationRedemptionResult>()
      api.redeemAccelerationCode.mockReturnValueOnce(pending.promise)
      const redemption = controller.redeem(accelerationBonusCode)
      await Promise.resolve()
      if (action === 'switch') {
        api.getAccelerationState.mockResolvedValueOnce(state({ scope: 'sub2api:2', remainingSeconds: 411 }))
        controller.setScope('sub2api:2')
        await controller.refresh()
      } else controller.dispose()
      pending.resolve({ status: 'redeemed', addedSeconds: 600, state: state({ totalSeconds: 1800, remainingSeconds: 1800 }) })
      expect(await redemption).toBeNull()
      if (action === 'switch') expect(controller.getSnapshot()).toMatchObject({ state: { scope: 'sub2api:2', remainingSeconds: 411 } })
      else expect(controller.getSnapshot().state?.remainingSeconds).toBe(1200)
    }
  })

  it('keeps an unsuccessful redemption retryable and accepts already-redeemed without adding time again', async () => {
    const { controller, api } = create(state({ remainingSeconds: 217 }))
    controller.setScope('new-api:1')
    await controller.refresh()
    api.redeemAccelerationCode.mockRejectedValueOnce(new Error('账本写入失败'))
    await expect(controller.redeem(accelerationBonusCode)).rejects.toThrow('账本写入失败')
    expect(controller.getSnapshot()).toMatchObject({ busy: false, error: '账本写入失败', state: { remainingSeconds: 217 } })
    const result: AccelerationRedemptionResult = { status: 'already-redeemed', addedSeconds: 0, state: state({ totalSeconds: 1800, remainingSeconds: 817 }) }
    api.redeemAccelerationCode.mockResolvedValueOnce(result)
    expect(await controller.redeem(accelerationBonusCode)).toEqual(result)
    expect(controller.getSnapshot()).toMatchObject({ busy: false, error: null, state: { remainingSeconds: 817 } })
    expect(api.redeemAccelerationCode).toHaveBeenCalledTimes(2)
  })

  it('keeps active session projection during redemption and rejects a response for another account', async () => {
    const { controller, api } = create(state({ phase: 'active', connectedAt: 'session-a', remainingSeconds: 10 }))
    controller.setScope('new-api:1')
    await controller.refresh()
    const pending = deferred<AccelerationRedemptionResult>()
    api.redeemAccelerationCode.mockReturnValueOnce(pending.promise)
    const redemption = controller.redeem(accelerationBonusCode)
    await advance(3000)
    expect(controller.getSnapshot()).toMatchObject({ busy: true, state: { remainingSeconds: 7, phase: 'active' } })
    pending.resolve({ status: 'redeemed', addedSeconds: 600, state: state({ scope: 'other:2', totalSeconds: 1800, remainingSeconds: 1800 }) })
    await expect(redemption).rejects.toThrow('账号或时长信息无效')
    expect(controller.getSnapshot()).toMatchObject({ busy: false, state: { remainingSeconds: 7, phase: 'active' } })
  })

  it('requires an account and keeps redemption separate from an in-flight connection mutation', async () => {
    const { controller, api } = create()
    await expect(controller.redeem(accelerationBonusCode)).rejects.toThrow('请先登录')
    expect(api.redeemAccelerationCode).not.toHaveBeenCalled()
    controller.setScope('new-api:1')
    await controller.refresh()
    const pending = deferred<AccelerationState>()
    api.startAcceleration.mockReturnValueOnce(pending.promise)
    const starting = controller.start()
    await expect(controller.redeem(accelerationBonusCode)).rejects.toThrow('加速操作正在进行')
    expect(api.redeemAccelerationCode).not.toHaveBeenCalled()
    pending.resolve(state({ phase: 'active', connectedAt: 'session-a' }))
    await starting
  })

  it('rearms exhaustion after redemption replenishes a session whose earlier automatic stop failed', async () => {
    const { controller, api } = create(state({ phase: 'active', connectedAt: 'session-a', remainingSeconds: 1 }))
    controller.setScope('new-api:1')
    await controller.refresh()
    api.stopAcceleration.mockRejectedValueOnce(new Error('连接尚未停止'))
    await advance(1000)
    expect(api.stopAcceleration).toHaveBeenCalledTimes(1)
    api.redeemAccelerationCode.mockResolvedValueOnce({ status: 'redeemed', addedSeconds: 600,
      state: state({ totalSeconds: 1800, remainingSeconds: 2, phase: 'active', connectedAt: 'session-a' }) })
    await controller.redeem(accelerationBonusCode)
    await advance(2000)
    expect(api.stopAcceleration).toHaveBeenCalledTimes(2)
  })

  it('keeps the selected optional TUN mode during idle polling and locks it while connected', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    controller.setMode('tun')
    await advance(15_000)
    expect(controller.getSnapshot().mode).toBe('tun')
    await controller.start()
    expect(api.startAcceleration).toHaveBeenCalledWith('new-api:1', 'tun')
    controller.setMode('system-proxy')
    expect(controller.getSnapshot().mode).toBe('tun')
    await controller.stop()
    controller.setMode('system-proxy')
    expect(controller.getSnapshot().mode).toBe('system-proxy')
  })

  it('cannot turn an unavailable service into an invented connected session', async () => {
    const { controller, api } = create(state({ phase: 'unavailable', remainingSeconds: null }))
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    expect(api.startAcceleration).not.toHaveBeenCalled()
    expect(controller.getSnapshot().state).toMatchObject({ phase: 'unavailable', remainingSeconds: null })
  })

  it('does not disconnect on disposal and ignores late replies', async () => {
    const { controller, api } = create()
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    const pending = deferred<AccelerationState>()
    api.getAccelerationState.mockReturnValueOnce(pending.promise)
    const read = controller.refresh()
    await Promise.resolve()
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispose()
    pending.resolve(state())
    await read
    await advance(5000)
    expect(listener).not.toHaveBeenCalled()
    expect(api.stopAcceleration).not.toHaveBeenCalled()
  })

  it('keeps the conflict refusal on screen and retries once the user overrides it', async () => {
    const { controller, api } = create()
    const refusal = state({ scope: 'new-api:1', phase: 'error', error: accelerationConflictNotice, conflicts: ['system-proxy'] })
    api.startAcceleration.mockResolvedValueOnce(refusal)
    controller.setScope('new-api:1')
    await controller.refresh()
    await controller.start()
    expect(controller.getSnapshot()).toMatchObject({ busy: false, error: accelerationConflictNotice, state: { conflicts: ['system-proxy'] } })
    expect(api.startAcceleration).toHaveBeenLastCalledWith('new-api:1', 'system-proxy')

    await controller.start(undefined, true)
    expect(api.startAcceleration).toHaveBeenLastCalledWith('new-api:1', 'system-proxy', undefined, true)
    expect(controller.getSnapshot().state).toMatchObject({ phase: 'active' })
    expect(controller.getSnapshot().state?.conflicts).toBeUndefined()
  })

  it('reports missing bridge methods instead of simulating a free allowance', async () => {
    const api = createAccelerationApi(null)
    await expect(api.getAccelerationState('new-api:1')).rejects.toThrow('加速服务暂未就绪')
    await expect(api.startAcceleration('new-api:1', 'tun')).rejects.toThrow('加速服务暂未就绪')
    await expect(api.stopAcceleration('new-api:1')).rejects.toThrow('加速服务暂未就绪')
    await expect(api.redeemAccelerationCode!('new-api:1', accelerationBonusCode)).rejects.toThrow('加速服务暂未就绪')
  })

  it('passes only the requested account and mode through the bridge', async () => {
    const { api: bridge } = create()
    const api = createAccelerationApi(bridge)
    await api.getAccelerationState('new-api:1')
    await api.startAcceleration('new-api:1', 'tun' satisfies AccelerationMode)
    await api.stopAcceleration('new-api:1')
    await api.redeemAccelerationCode!('new-api:1', accelerationBonusCode)
    expect(bridge.getAccelerationState).toHaveBeenCalledWith('new-api:1')
    expect(bridge.startAcceleration).toHaveBeenCalledWith('new-api:1', 'tun')
    await api.startAcceleration('new-api:1', 'system-proxy', undefined, true)
    expect(bridge.startAcceleration).toHaveBeenLastCalledWith('new-api:1', 'system-proxy', undefined, true)
    expect(bridge.stopAcceleration).toHaveBeenCalledWith('new-api:1')
    expect(bridge.redeemAccelerationCode).toHaveBeenCalledWith('new-api:1', accelerationBonusCode)
  })
})

describe('acceleration mode memory', () => {
  const controllers: AccelerationController[] = []
  function create(stored: AccelerationPreference, initial = state()) {
    const saved: AccelerationPreferenceUpdate[] = []
    const api: AccelerationClient = {
      getAccelerationState: vi.fn(async () => initial),
      startAcceleration: vi.fn(async () => ({ ...initial, phase: 'active' as const })),
      stopAcceleration: vi.fn(async () => initial),
      getAccelerationPreference: vi.fn(async () => stored),
      saveAccelerationPreference: vi.fn(async (_scope: string, update: AccelerationPreferenceUpdate) => {
        saved.push(update)
        return { ...stored, ...update }
      }),
    }
    const controller = createAccelerationController(api)
    controllers.push(controller)
    return { controller, api, saved }
  }
  afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()) })

  it('restores a remembered mode the host says it supports', async () => {
    const { controller } = create({ lineId: null, mode: 'tun' }, state({ supportedModes: ['system-proxy', 'tun'] }))
    controller.setScope('new-api:1')
    await controller.refresh()
    await Promise.resolve()
    expect(controller.getSnapshot().mode).toBe('tun')
  })

  // TUN 会改系统网络设置：后端没说支持，界面就不许因为一份旧记录显示成开着。
  it('ignores a remembered mode the host does not offer', async () => {
    const { controller } = create({ lineId: null, mode: 'tun' }, state({ supportedModes: ['system-proxy'] }))
    controller.setScope('new-api:1')
    await controller.refresh()
    await Promise.resolve()
    expect(controller.getSnapshot().mode).toBe('system-proxy')
  })

  it('stores the switch the user just flipped', async () => {
    const { controller, saved } = create({ lineId: null, mode: 'system-proxy' }, state({ supportedModes: ['system-proxy', 'tun'] }))
    controller.setScope('new-api:1')
    await controller.refresh()
    controller.setMode('tun')
    await Promise.resolve()
    expect(controller.getSnapshot().mode).toBe('tun')
    expect(saved).toEqual([{ mode: 'tun' }])
  })

  it('never lets a late preference read override the switch the user just flipped', async () => {
    const pending = deferred<AccelerationPreference>()
    const { controller, api } = create({ lineId: null, mode: 'tun' }, state({ supportedModes: ['system-proxy', 'tun'] }))
    vi.mocked(api.getAccelerationPreference!).mockReturnValueOnce(pending.promise)
    controller.setScope('new-api:1')
    await controller.refresh()
    controller.setMode('system-proxy')
    pending.resolve({ lineId: null, mode: 'tun' })
    await pending.promise
    await Promise.resolve()
    expect(controller.getSnapshot().mode).toBe('system-proxy')
  })

  it('never lets a preference failure surface on the page', async () => {
    const { controller, api } = create({ lineId: null, mode: 'tun' }, state({ supportedModes: ['system-proxy', 'tun'] }))
    vi.mocked(api.getAccelerationPreference!).mockRejectedValueOnce(new Error('读偏好失败'))
    vi.mocked(api.saveAccelerationPreference!).mockRejectedValueOnce(new Error('写偏好失败'))
    controller.setScope('new-api:1')
    await controller.refresh()
    controller.setMode('tun')
    await Promise.resolve()
    expect(controller.getSnapshot()).toMatchObject({ mode: 'tun', error: null })
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { AccelerationPhase, AccelerationState } from './acceleration-contract'
import {
  codexDesktopAccelerationDecision,
  codexDesktopNeedsAccelerationOnlyAtStartup,
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

  it('connects an idle account even when its free allowance is used up', () => {
    expect(codexDesktopAccelerationDecision(stateOf('idle'))).toBe('connect')
    expect(codexDesktopAccelerationDecision(stateOf('error'))).toBe('connect')
    // 自动连的不扣时长，时长用完也照样连（yoyo 2026-09-30 定）。
    expect(codexDesktopAccelerationDecision(stateOf('exhausted', 0))).toBe('connect')
    expect(codexDesktopAccelerationDecision(stateOf('idle', 0))).toBe('connect')
    expect(codexDesktopAccelerationDecision(stateOf('unavailable', null))).toBe('unavailable')
  })
})

describe('codex desktop acceleration coordinator', () => {
  it('connects before the desktop app is launched', async () => {
    const { coordinator, connect, log } = setup()
    await expect(coordinator.ensureConnected()).resolves.toEqual({ status: 'connected' })
    // 第二个参数是刚读到的那份状态：宿主据此判断记住的模式当前支不支持。
    expect(connect).toHaveBeenCalledWith(scope, stateOf('idle'))
    expect(log).toHaveBeenCalledWith('info', 'acceleration.codex-desktop.connected', expect.any(String), undefined)
  })

  it('connects quietly: there is no hook to announce the connection to the user', async () => {
    // yoyo 2026-10-01 定「悄悄连」：自动连上不弹通知，只记日志。钉住没有这个口子，
    // 免得以后有人在宿主那边又接回一条系统通知。
    const coordinator = createCodexDesktopAccelerationCoordinator({
      getAccountScope: () => scope,
      readState: async () => stateOf('idle'),
      connect: async () => stateOf('active'),
      // @ts-expect-error onAutoConnected was removed on purpose.
      onAutoConnected: () => undefined,
    })
    await expect(coordinator.ensureConnected()).resolves.toEqual({ status: 'connected' })
    coordinator.dispose()
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

  it('skips without an account and without a working component, but not without allowance', async () => {
    const withoutAccount = setup({ accountScope: null })
    await expect(withoutAccount.coordinator.ensureConnected())
      .resolves.toEqual({ status: 'skipped', reason: 'no-account' })
    expect(withoutAccount.readState).not.toHaveBeenCalled()

    const exhausted = setup({ read: async () => stateOf('exhausted', 0) })
    await expect(exhausted.coordinator.ensureConnected()).resolves.toEqual({ status: 'connected' })
    expect(exhausted.connect).toHaveBeenCalledOnce()

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

describe('codex desktop acceleration exit watch', () => {
  const automatic: AccelerationState = { ...stateOf('active'), autoStartedBy: 'codex-desktop' }

  function watchSetup(options: {
    running: Array<boolean | null>
    connected?: AccelerationState
    /** 给了就等它落定才连上：模拟「打开」等不及、连接在后台才连完的慢电脑。 */
    connectGate?: Promise<void>
    timeoutMs?: number
    onlyNeededAtStartup?: () => boolean | Promise<boolean>
    disconnected?: AccelerationState
  }) {
    const timers: Array<() => void> = []
    const delays: number[] = []
    const answers = [...options.running]
    const isDesktopRunning = vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]))
    const disconnect = vi.fn(async (_scope: string, _connectedAt: string) => options.disconnected ?? stateOf('idle'))
    // 第一次读状态是「打开」前那一次，之后每一次都是定时检查读到的。
    let current: AccelerationState = stateOf('idle')
    const readState = vi.fn(async () => current)
    const log = vi.fn()
    let accountScope: string | null = scope
    const coordinator = createCodexDesktopAccelerationCoordinator({
      getAccountScope: () => accountScope,
      readState,
      connect: async () => {
        await options.connectGate
        current = options.connected ?? automatic
        return current
      },
      isDesktopRunning,
      disconnect,
      ...(options.onlyNeededAtStartup ? { onlyNeededAtStartup: options.onlyNeededAtStartup } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      schedule: (callback, milliseconds) => {
        timers.push(callback)
        delays.push(milliseconds)
        return () => { timers.splice(timers.indexOf(callback), 1) }
      },
      log,
    })
    async function tick() {
      const callback = timers.shift()
      if (!callback) throw new Error('no watch scheduled')
      const probes = isDesktopRunning.mock.calls.length
      const reads = readState.mock.calls.length
      callback()
      await vi.waitFor(() => { expect(readState.mock.calls.length).toBeGreaterThan(reads) })
      await new Promise((resolve) => setTimeout(resolve, 0))
      return isDesktopRunning.mock.calls.length > probes
    }
    return {
      coordinator, isDesktopRunning, disconnect, timers, delays, tick, log, readState,
      setState: (state: AccelerationState) => { current = state },
      setAccountScope: (next: string | null) => { accountScope = next },
    }
  }

  it('disconnects the automatic session after the desktop app has been gone twice in a row', async () => {
    const h = watchSetup({ running: [true, false, false] })
    await h.coordinator.ensureConnected()
    expect(h.timers).toHaveLength(1)
    await h.tick()
    await h.tick()
    expect(h.disconnect).not.toHaveBeenCalled()
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledExactlyOnceWith(scope, automatic.connectedAt) })
    expect(h.timers).toHaveLength(0)
    await vi.waitFor(() => {
      expect(h.log).toHaveBeenCalledWith('info', 'acceleration.codex-desktop.disconnected', expect.any(String), { cause: 'desktop-exited' })
    })
  })

  // yoyo 2026-10-02：自动连的加速用完就断。用星芒 Key 的桌面端只在启动时要它。
  it('disconnects once a desktop app on a Xingmang key has been seen running twice', async () => {
    const onlyNeededAtStartup = vi.fn(() => true)
    const h = watchSetup({ running: [true, true], onlyNeededAtStartup })
    await h.coordinator.ensureConnected()
    await h.tick()
    expect(h.disconnect).not.toHaveBeenCalled()
    expect(onlyNeededAtStartup).not.toHaveBeenCalled()
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledExactlyOnceWith(scope, automatic.connectedAt) })
    expect(h.timers).toHaveLength(0)
    expect(h.delays).toEqual([60_000, 60_000])
    await vi.waitFor(() => {
      expect(h.log).toHaveBeenCalledWith('info', 'acceleration.codex-desktop.disconnected', expect.stringContaining('已经打开好了'), { cause: 'desktop-started' })
    })
  })

  it('keeps the session until exit when the desktop app needs it throughout, and asks again each time', async () => {
    // ChatGPT 账号一直要连 chatgpt.com；读不出配置也按这种算。中途改成星芒 Key 的，下一次检查就断。
    const answers: Array<boolean | Error> = [false, new Error('unreadable'), false, true]
    const onlyNeededAtStartup = vi.fn(async () => {
      const answer = answers.shift()!
      if (answer instanceof Error) throw answer
      return answer
    })
    const h = watchSetup({ running: [true], onlyNeededAtStartup })
    await h.coordinator.ensureConnected()
    for (let index = 0; index < 4; index += 1) await h.tick()
    expect(h.disconnect).not.toHaveBeenCalled()
    expect(onlyNeededAtStartup).toHaveBeenCalledTimes(3)
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledOnce() })
  })

  it('needs two running checks in a row before treating the desktop app as started', async () => {
    const onlyNeededAtStartup = vi.fn(() => true)
    const h = watchSetup({ running: [true, null, true, false, false], onlyNeededAtStartup })
    await h.coordinator.ensureConnected()
    for (let index = 0; index < 3; index += 1) await h.tick()
    expect(h.disconnect).not.toHaveBeenCalled()
    await h.tick()
    await h.tick()
    await vi.waitFor(() => {
      expect(h.log).toHaveBeenCalledWith('info', 'acceleration.codex-desktop.disconnected', expect.any(String), { cause: 'desktop-exited' })
    })
  })

  it('starts counting the startup again when the desktop app is opened again on the same session', async () => {
    // 「帮我重开」切中文、关了马上再开：桌面端又要在启动时拉一次中文界面那份配置。
    const h = watchSetup({ running: [true], onlyNeededAtStartup: () => true })
    await h.coordinator.ensureConnected()
    await h.tick()
    await expect(h.coordinator.ensureConnected()).resolves.toEqual({ status: 'already-connected' })
    expect(h.timers).toHaveLength(1)
    await h.tick()
    expect(h.disconnect).not.toHaveBeenCalled()
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledOnce() })
  })

  it('says so when the user had already made the connection their own', async () => {
    // 到点要断的那一刻他刚点了「开始加速」：服务按 connectedAt 认，不断他的。
    const h = watchSetup({ running: [true, true], onlyNeededAtStartup: () => true,
      disconnected: { ...stateOf('active'), connectedAt: '2026-09-22T11:01:00.000Z' } })
    await h.coordinator.ensureConnected()
    await h.tick()
    await h.tick()
    await vi.waitFor(() => {
      expect(h.log).toHaveBeenCalledWith('info', 'acceleration.codex-desktop.handed-over', expect.any(String), { cause: 'desktop-started' })
    })
    expect(h.log).not.toHaveBeenCalledWith('info', 'acceleration.codex-desktop.disconnected', expect.any(String), expect.anything())
  })

  it('keeps the session while the desktop app runs and forgives a single miss', async () => {
    const h = watchSetup({ running: [false, true, false, true] })
    await h.coordinator.ensureConnected()
    for (let index = 0; index < 4; index += 1) await h.tick()
    expect(h.disconnect).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(1)
  })

  it('does not treat an unreadable probe as an exit, but gives up after ten in a row', async () => {
    const h = watchSetup({ running: [null] })
    await h.coordinator.ensureConnected()
    for (let index = 0; index < 9; index += 1) await h.tick()
    expect(h.disconnect).not.toHaveBeenCalled()
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledOnce() })
  })

  it('asks less often while the desktop app keeps running and snaps back on the first miss', async () => {
    const h = watchSetup({ running: [true, true, true, true, false, null, true] })
    await h.coordinator.ensureConnected()
    for (let index = 0; index < 7; index += 1) await h.tick()
    // 打开后第一次 + 每次检查之后各排一次：头三次确认在跑之前保持一分钟，
    // 之后放宽到三分钟；查到不在、查不出来都立刻退回一分钟，在跑也要重新攒三次。
    expect(h.delays).toEqual([60_000, 60_000, 60_000, 180_000, 180_000, 60_000, 60_000, 60_000])
    expect(h.disconnect).not.toHaveBeenCalled()
  })

  it('still disconnects after two misses once the interval has been relaxed', async () => {
    const h = watchSetup({ running: [true, true, true, false, false] })
    await h.coordinator.ensureConnected()
    for (let index = 0; index < 5; index += 1) await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledExactlyOnceWith(scope, automatic.connectedAt) })
    expect(h.delays).toEqual([60_000, 60_000, 60_000, 180_000, 60_000])
  })

  it('stops watching once the user has taken the connection over', async () => {
    const h = watchSetup({ running: [false] })
    await h.coordinator.ensureConnected()
    // 用户自己停了再连：同一个账号，但已经不是自动连的那一次。
    h.setState({ ...stateOf('active'), connectedAt: '2026-09-22T11:30:00.000Z' })
    expect(await h.tick()).toBe(false)
    expect(h.timers).toHaveLength(0)
    expect(h.disconnect).not.toHaveBeenCalled()
  })

  it('picks the watch back up when the desktop app is opened again on the same session', async () => {
    const h = watchSetup({ running: [true] })
    await h.coordinator.ensureConnected()
    h.coordinator.dispose()
    expect(h.timers).toHaveLength(0)
    const again = watchSetup({ running: [true] })
    again.setState(automatic)
    await expect(again.coordinator.ensureConnected()).resolves.toEqual({ status: 'already-connected' })
    expect(again.timers).toHaveLength(1)
  })

  it('never watches a session the user started', async () => {
    const h = watchSetup({ running: [false], connected: stateOf('active') })
    await h.coordinator.ensureConnected()
    expect(h.timers).toHaveLength(0)
  })

  it('still disconnects a connection that finished after the launch stopped waiting for it', async () => {
    // 2026-10-02 A014：连接超过 15 秒，「打开」按超时照常往下走，连接却在后台连完了，
    // 之后没人盯，一条不扣时长的线路一直开到退出星芒。
    let release!: () => void
    const connectGate = new Promise<void>((resolve) => { release = resolve })
    const h = watchSetup({ running: [false, false], connectGate, timeoutMs: 5 })
    await expect(h.coordinator.ensureConnected()).resolves.toEqual({ status: 'skipped', reason: 'timeout' })
    expect(h.timers).toHaveLength(0)
    release()
    await vi.waitFor(() => { expect(h.timers).toHaveLength(1) })
    expect(h.log).toHaveBeenCalledWith('info', 'acceleration.codex-desktop.connected', expect.any(String), { late: true })
    await h.tick()
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledExactlyOnceWith(scope, automatic.connectedAt) })
  })

  it('leaves a late connection alone when it is not the automatic one', async () => {
    let release!: () => void
    const connectGate = new Promise<void>((resolve) => { release = resolve })
    const h = watchSetup({ running: [false], connected: stateOf('active'), connectGate, timeoutMs: 5 })
    await expect(h.coordinator.ensureConnected()).resolves.toEqual({ status: 'skipped', reason: 'timeout' })
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.timers).toHaveLength(0)
    expect(h.log).not.toHaveBeenCalledWith('info', 'acceleration.codex-desktop.connected', expect.any(String), { late: true })
  })

  it('picks up an automatic session it sees in a state update even without an open click', async () => {
    const h = watchSetup({ running: [false, false] })
    h.setState(automatic)
    h.coordinator.observe(automatic)
    expect(h.timers).toHaveLength(1)
    // 同一次会话反复路过只盯一份。
    h.coordinator.observe({ ...automatic, measuredAt: '2026-09-22T11:05:00.000Z' })
    expect(h.timers).toHaveLength(1)
    await h.tick()
    await h.tick()
    await vi.waitFor(() => { expect(h.disconnect).toHaveBeenCalledExactlyOnceWith(scope, automatic.connectedAt) })
  })

  it('stops watching once the account has changed instead of retrying the old account forever', async () => {
    // 换账号后加速服务对旧账号的读状态一律拒绝；原来落进 catch 每分钟重排一次，停不下来。
    const h = watchSetup({ running: [true] })
    await h.coordinator.ensureConnected()
    expect(h.timers).toHaveLength(1)
    h.setAccountScope('xm-account:8')
    const reads = h.readState.mock.calls.length
    h.timers.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.readState.mock.calls.length).toBe(reads)
    expect(h.timers).toHaveLength(0)
    expect(h.isDesktopRunning).not.toHaveBeenCalled()
    expect(h.disconnect).not.toHaveBeenCalled()
  })

  it('ignores state updates that are not an unattended automatic session of this account', () => {
    const h = watchSetup({ running: [false] })
    h.coordinator.observe(stateOf('active'))
    h.coordinator.observe({ ...automatic, scope: 'xm-account:8' })
    h.coordinator.observe({ ...stateOf('idle'), connectedAt: null })
    expect(h.timers).toHaveLength(0)
    h.coordinator.dispose()
    h.coordinator.observe(automatic)
    expect(h.timers).toHaveLength(0)
  })
})

describe('codexDesktopNeedsAccelerationOnlyAtStartup', () => {
  it('lets go after startup only for a desktop app on this site\'s key', () => {
    const relayKey = { matchesRelay: true, codexAuthMode: 'apikey' as const, codexProviderShadowed: false }
    expect(codexDesktopNeedsAccelerationOnlyAtStartup(relayKey)).toBe(true)
    expect(codexDesktopNeedsAccelerationOnlyAtStartup({ ...relayKey, codexProviderShadowed: undefined })).toBe(true)
    // ChatGPT 登录、没登录、指向别处、连接名被官方保留名顶掉：都要一直连着。
    expect(codexDesktopNeedsAccelerationOnlyAtStartup({ ...relayKey, codexAuthMode: 'chatgpt' })).toBe(false)
    expect(codexDesktopNeedsAccelerationOnlyAtStartup({ ...relayKey, codexAuthMode: null })).toBe(false)
    expect(codexDesktopNeedsAccelerationOnlyAtStartup({ ...relayKey, codexAuthMode: undefined })).toBe(false)
    expect(codexDesktopNeedsAccelerationOnlyAtStartup({ ...relayKey, matchesRelay: false })).toBe(false)
    expect(codexDesktopNeedsAccelerationOnlyAtStartup({ ...relayKey, codexProviderShadowed: true })).toBe(false)
  })
})

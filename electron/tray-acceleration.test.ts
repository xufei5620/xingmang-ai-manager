import { describe, expect, it, vi } from 'vitest'
import { accelerationFailure, type AccelerationState } from './acceleration-contract'
import {
  buildTrayAccelerationEntry,
  createTrayAccelerationCoordinator,
  describeTrayAccelerationFailure,
  type TrayAccelerationCoordinatorOptions,
} from './tray-acceleration'

const scope = 'xm-account:7'

function state(overrides: Partial<AccelerationState> = {}): AccelerationState {
  return {
    scope, phase: 'idle', mode: 'system-proxy', totalSeconds: 1200, remainingSeconds: 1200,
    sessionSeconds: 0, measuredAt: '2026-09-22T12:00:00.000Z', connectedAt: null, line: null, error: null,
    ...overrides,
  }
}

function active(remainingSeconds: number): AccelerationState {
  return state({ phase: 'active', remainingSeconds, sessionSeconds: 1200 - remainingSeconds, connectedAt: '2026-09-22T12:00:00.000Z' })
}

function entry(overrides: Partial<Parameters<typeof buildTrayAccelerationEntry>[0]> = {}) {
  return buildTrayAccelerationEntry({ signedIn: true, state: state(), busy: false, failure: null, ...overrides })
}

describe('tray acceleration menu entry', () => {
  it('offers a connect action only once an account and a readable state exist', () => {
    expect(entry({ signedIn: false })).toMatchObject({ statusLabel: '加速：未登录，登录后可用', actionEnabled: false })
    expect(entry({ state: null })).toMatchObject({ statusLabel: '加速：正在读取状态', actionEnabled: false })
    expect(entry()).toMatchObject({ statusLabel: '加速：未连接', actionLabel: '连接加速', actionEnabled: true, action: 'start' })
  })

  it('reports remaining minutes against the moment the state was read', () => {
    expect(entry({ state: active(754) }).statusLabel).toBe('加速：已连接 · 剩余 12 分钟')
    // 主窗口缩到托盘后渲染层不再轮询，所以读到之后过去的时间要先扣掉再显示。
    expect(entry({ state: active(754), elapsedSeconds: 200 }).statusLabel).toBe('加速：已连接 · 剩余 9 分钟')
    expect(entry({ state: active(30) }).statusLabel).toBe('加速：已连接 · 剩余不到 1 分钟')
    expect(entry({ state: active(754), elapsedSeconds: 10_000 }).statusLabel).toBe('加速：已连接 · 剩余不到 1 分钟')
    expect(entry({ state: active(754) })).toMatchObject({ actionLabel: '断开加速', actionEnabled: true, action: 'stop' })
  })

  it('explains every greyed-out action instead of leaving a dead menu row', () => {
    expect(entry({ state: state({ phase: 'unavailable' }) })).toMatchObject({ statusLabel: '加速：线路准备中', actionEnabled: false })
    expect(entry({ state: state({ phase: 'exhausted', remainingSeconds: 0 }) }))
      .toMatchObject({ statusLabel: '加速：当前账号的免费时长已用完', actionEnabled: false })
    expect(entry({ state: state({ remainingSeconds: 0 }) }))
      .toMatchObject({ statusLabel: '加速：当前账号的免费时长已用完', actionEnabled: false })
    expect(entry({ state: state({ conflicts: ['virtual-adapter'] }) }))
      .toMatchObject({ statusLabel: '加速：检测到其他代理或 VPN，请到加速页处理', actionEnabled: false })
  })

  it('keeps a transition greyed out and names which direction it is going', () => {
    expect(entry({ busy: true })).toMatchObject({ statusLabel: '加速：正在连接', actionLabel: '处理中…', actionEnabled: false, action: 'start' })
    expect(entry({ busy: true, state: active(600) })).toMatchObject({ statusLabel: '加速：正在断开', actionLabel: '处理中…', actionEnabled: false, action: 'stop' })
    expect(entry({ state: state({ phase: 'connecting' }) })).toMatchObject({ statusLabel: '加速：正在连接', actionEnabled: false })
    expect(entry({ state: state({ phase: 'stopping' }) })).toMatchObject({ statusLabel: '加速：正在断开', actionEnabled: false })
  })

  it('leaves a retry reachable from the tray after a stop failed', () => {
    // 加速页在这一刻给的是「重试停止」；托盘要是永远灰着，用户只能回主窗口。
    expect(entry({ state: state({ phase: 'stopping', error: '加速尚未完全停止，正在保留恢复状态，请再次点击停止。' }) }))
      .toMatchObject({ statusLabel: '加速：加速尚未完全停止，正在保留恢复状态，请再次点击停止', actionLabel: '重试断开', actionEnabled: true, action: 'stop' })
  })

  it('puts the reason on the status row and still lets the user try again', () => {
    expect(entry({ state: state({ phase: 'error', error: '加速连接失败，请检查线路和网络连接后重试。' }) }))
      .toMatchObject({ statusLabel: '加速：加速连接失败，请检查线路和网络连接后重试', actionLabel: '连接加速', actionEnabled: true })
    expect(entry({ failure: '加速组件没能启动' }).statusLabel).toBe('加速：加速组件没能启动')
  })

  it('never lets a path or an overlong sentence reach the native menu', () => {
    expect(entry({ state: state({ phase: 'error', error: 'C:\\Users\\peaker\\AppData\\Local\\Temp 不可写' }) }).statusLabel)
      .toBe('加速：连接未成功，请稍后重试')
    expect(entry({ state: state({ phase: 'error', error: '连'.repeat(60) }) }).statusLabel).toBe('加速：连接未成功，请稍后重试')
  })

  it('summarizes a classified failure instead of repeating the full on-screen sentence', () => {
    expect(describeTrayAccelerationFailure(accelerationFailure('helper-temp'))).toBe('系统临时文件夹不可用')
    expect(describeTrayAccelerationFailure(accelerationFailure('proxy-locked'))).toBe('系统策略限制，无法修改网络设置')
    expect(describeTrayAccelerationFailure(accelerationFailure('unknown'))).toBe('连接未成功，请稍后重试')
    expect(describeTrayAccelerationFailure(new Error('账号已变更，请重新打开游戏加速。'))).toBe('账号已变更，请重新打开游戏加速')
    expect(describeTrayAccelerationFailure('not an error')).toBe('连接未成功，请稍后重试')
  })
})

function coordinator(overrides: Partial<TrayAccelerationCoordinatorOptions> = {}) {
  let currentScope: string | null = scope
  const options: TrayAccelerationCoordinatorOptions = {
    getAccountScope: () => currentScope,
    readState: vi.fn(async () => state()),
    connect: vi.fn(async () => active(1200)),
    disconnect: vi.fn(async () => state()),
    onChanged: vi.fn(),
    now: () => 0,
    log: vi.fn(),
    ...overrides,
  }
  return { options, controller: createTrayAccelerationCoordinator(options), setScope: (next: string | null) => { currentScope = next } }
}

describe('tray acceleration coordinator', () => {
  it('follows the states the acceleration service already produces', () => {
    const { options, controller } = coordinator()
    controller.observe(active(600))
    expect(options.onChanged).toHaveBeenCalledOnce()
    expect(controller.entry()).toMatchObject({ statusLabel: '加速：已连接 · 剩余 10 分钟', action: 'stop' })
  })

  it('ignores a state that belongs to another account', () => {
    const { options, controller } = coordinator()
    controller.observe({ ...active(600), scope: 'xm-account:9' })
    expect(options.onChanged).not.toHaveBeenCalled()
    expect(controller.entry().statusLabel).toBe('加速：正在读取状态')
  })

  it('connects and disconnects through the same host calls as the acceleration page', async () => {
    const { options, controller } = coordinator()
    controller.observe(state())
    await controller.toggle()
    expect(options.connect).toHaveBeenCalledExactlyOnceWith(scope)
    expect(controller.entry()).toMatchObject({ actionLabel: '断开加速', action: 'stop' })
    await controller.toggle()
    expect(options.disconnect).toHaveBeenCalledExactlyOnceWith(scope)
    expect(controller.entry()).toMatchObject({ statusLabel: '加速：未连接', action: 'start' })
  })

  it('does nothing at all when the row is greyed out', async () => {
    const { options, controller } = coordinator()
    controller.observe(state({ phase: 'unavailable' }))
    await controller.toggle()
    expect(options.connect).not.toHaveBeenCalled()
    expect(options.disconnect).not.toHaveBeenCalled()
  })

  it('turns a failed connection into one status row, never an exception or a dialog', async () => {
    const { options, controller } = coordinator({ connect: vi.fn(async () => { throw accelerationFailure('helper-launch') }) })
    controller.observe(state())
    await expect(controller.toggle()).resolves.toBeUndefined()
    expect(controller.entry()).toMatchObject({ statusLabel: '加速：加速组件没能启动', actionLabel: '连接加速', actionEnabled: true })
    expect(options.log).toHaveBeenCalledWith('warn', 'acceleration.tray.connect.failed', expect.any(String), expect.any(Object))
  })

  it('reads the current state when the menu opens, one read at a time', async () => {
    const reads: (() => void)[] = []
    const readState = vi.fn(() => new Promise<AccelerationState>((resolve) => { reads.push(() => resolve(active(300))) }))
    const { controller } = coordinator({ readState })
    controller.refresh()
    controller.refresh()
    await vi.waitFor(() => expect(readState).toHaveBeenCalledOnce())
    reads[0]()
    await vi.waitFor(() => expect(controller.entry().statusLabel).toBe('加速：已连接 · 剩余 5 分钟'))
    controller.refresh()
    await vi.waitFor(() => expect(readState).toHaveBeenCalledTimes(2))
  })

  it('reports a failed read rather than leaving a stale connected row', async () => {
    const { controller } = coordinator({ readState: vi.fn(async () => { throw accelerationFailure('helper-timeout') }) })
    controller.refresh()
    await vi.waitFor(() => expect(controller.entry().statusLabel).toBe('加速：加速组件响应超时'))
  })

  it('drops the previous account state on sign-out and on an account switch', () => {
    const { options, controller, setScope } = coordinator()
    controller.observe(active(600))
    setScope(null)
    controller.refresh()
    expect(options.readState).not.toHaveBeenCalled()
    expect(controller.entry()).toMatchObject({ statusLabel: '加速：未登录，登录后可用', actionEnabled: false })
    setScope('xm-account:9')
    controller.observe(active(600))
    controller.reset()
    expect(controller.entry().statusLabel).toBe('加速：正在读取状态')
  })

  it('keeps a menu refresh failure from escaping into the acceleration service', () => {
    const { options, controller } = coordinator({ onChanged: vi.fn(() => { throw new Error('native menu failed') }) })
    expect(() => controller.observe(active(600))).not.toThrow()
    expect(options.log).toHaveBeenCalledWith('warn', 'acceleration.tray.refresh.failed', expect.any(String), expect.any(Object))
  })
})

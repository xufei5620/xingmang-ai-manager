import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteFeatureGate, runWhenOn } from './remote-feature-gate'
import { RemoteFeatureOffError } from './remote-features'

afterEach(() => {
  vi.useRealTimers()
})

describe('createRemoteFeatureGate', () => {
  it('switches nothing off until the status file says so and follows each read', () => {
    const gate = createRemoteFeatureGate()
    expect(gate.isOff('video-studio')).toBe(false)
    expect(gate.assertOn('video-studio', '停用了')).toBeUndefined()
    gate.update(['video-studio', 'install:codex'])
    expect(gate.isOff('video-studio')).toBe(true)
    expect(gate.isOff('launch:codex')).toBe(false)
    expect(() => gate.assertOn('install:codex', 'Codex CLI 的安装和更新暂时停用了')).toThrow(RemoteFeatureOffError)
    gate.update([])
    expect(gate.isOff('video-studio')).toBe(false)
  })

  it('tells listeners only when the switched-off list changes and keeps telling the rest when one throws', () => {
    const gate = createRemoteFeatureGate()
    const broken = vi.fn(() => { throw new Error('listener broke') })
    const listener = vi.fn()
    gate.subscribe(broken)
    const unsubscribe = gate.subscribe(listener)
    gate.update(['acceleration'])
    gate.update(['acceleration'])
    gate.update([])
    expect(listener.mock.calls).toEqual([[['acceleration']], [[]]])
    expect(broken).toHaveBeenCalledTimes(2)
    unsubscribe()
    gate.update(['tray-release'])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('lets a click right after start wait for the first read, and never waits again', async () => {
    let finishRead: () => void = () => undefined
    const settled = vi.fn(() => new Promise<void>((resolve) => { finishRead = resolve }))
    const gate = createRemoteFeatureGate({ settled })
    const waiting = gate.assertOn('video-studio', '视频剪辑暂时停用了')
    expect(waiting).toBeInstanceOf(Promise)
    gate.update(['video-studio'])
    finishRead()
    await expect(waiting).rejects.toThrow('视频剪辑暂时停用了')
    // 之后状态文件每隔一阵重读的那一次不等：当场判断。
    expect(() => gate.assertOn('video-studio', '视频剪辑暂时停用了')).toThrow(RemoteFeatureOffError)
    expect(gate.assertOn('launch:codex', '暂时不能打开')).toBeUndefined()
    expect(settled).toHaveBeenCalledOnce()
  })

  it('stops waiting for a slow or failing first read and goes by what it has', async () => {
    vi.useFakeTimers()
    const slow = createRemoteFeatureGate({ settled: () => new Promise(() => undefined), firstReadWaitMs: 2_000 })
    const waiting = slow.assertOn('install:codex', '停用了')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(waiting).resolves.toBeUndefined()

    const failing = createRemoteFeatureGate({ settled: () => Promise.reject(new Error('status file unreadable')) })
    await expect(failing.assertOn('install:codex', '停用了')).resolves.toBeUndefined()
    expect(failing.assertOn('install:codex', '停用了')).toBeUndefined()
  })
})

describe('runWhenOn', () => {
  it('runs synchronously when the feature is on or no gate is wired', () => {
    const gate = createRemoteFeatureGate()
    expect(runWhenOn(gate, 'launch:codex', '停用了', () => 'launched')).toBe('launched')
    expect(runWhenOn(undefined, 'launch:codex', '停用了', () => 'launched')).toBe('launched')
  })

  it('refuses before running when the feature is off', () => {
    const gate = createRemoteFeatureGate()
    gate.update(['launch:codex'])
    const run = vi.fn()
    expect(() => runWhenOn(gate, 'launch:codex', '暂时不能从星芒打开 Codex CLI', run)).toThrow('暂时不能从星芒打开 Codex CLI')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs after the first read when that read is still going', async () => {
    let finishRead: () => void = () => undefined
    const gate = createRemoteFeatureGate({ settled: () => new Promise<void>((resolve) => { finishRead = resolve }) })
    const run = vi.fn(() => 'launched')
    const result = runWhenOn(gate, 'launch:codex', '停用了', run)
    expect(run).not.toHaveBeenCalled()
    finishRead()
    await expect(result).resolves.toBe('launched')
  })
})

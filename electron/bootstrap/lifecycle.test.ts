import { describe, expect, it, vi } from 'vitest'
import { createQuitCleanup } from './lifecycle'

describe('createQuitCleanup', () => {
  it('runs the steps in the order they were registered', () => {
    const calls: string[] = []
    const cleanup = createQuitCleanup({ onStepFailed: vi.fn() })
    cleanup.add('acceleration', () => calls.push('acceleration'))
    cleanup.add('acceleration-host', () => calls.push('acceleration-host'))
    cleanup.add('updater', () => calls.push('updater'))

    cleanup.run()

    expect(calls).toEqual(['acceleration', 'acceleration-host', 'updater'])
  })

  it('runs every step once even when the cleanup is asked to run again', () => {
    // 独立加速进程只该被放掉一次：它断开后自己按次数上限还原系统代理，退出再叫一遍不能让它多试一轮。
    const disposeHost = vi.fn()
    const cleanup = createQuitCleanup({ onStepFailed: vi.fn() })
    cleanup.add('acceleration-host', disposeHost)

    cleanup.run()
    cleanup.run()

    expect(disposeHost).toHaveBeenCalledTimes(1)
  })

  it('reports a throwing step by name and still runs the later ones', () => {
    // 以前一处抛错，后面的清理连同之后挂的 will-quit 全被跳过，独立加速进程就不会被放掉。
    const failure = new Error('dispose failed')
    const onStepFailed = vi.fn()
    const disposeHost = vi.fn()
    const markQuitting = vi.fn()
    const cleanup = createQuitCleanup({ onStepFailed })
    cleanup.add('acceleration', () => { throw failure })
    cleanup.add('acceleration-host', disposeHost)
    cleanup.add('unexpected-exit-flag', markQuitting)

    expect(() => cleanup.run()).not.toThrow()

    expect(onStepFailed).toHaveBeenCalledTimes(1)
    expect(onStepFailed).toHaveBeenCalledWith('acceleration', failure)
    expect(disposeHost).toHaveBeenCalledTimes(1)
    expect(markQuitting).toHaveBeenCalledTimes(1)
  })

  it('keeps going when reporting a failure throws as well', () => {
    const later = vi.fn()
    const cleanup = createQuitCleanup({ onStepFailed: () => { throw new Error('log closed') } })
    cleanup.add('first', () => { throw new Error('first failed') })
    cleanup.add('second', later)

    expect(() => cleanup.run()).not.toThrow()
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('never runs a step registered after the cleanup ran, like a will-quit listener added too late', () => {
    const late = vi.fn()
    const cleanup = createQuitCleanup({ onStepFailed: vi.fn() })
    cleanup.run()
    cleanup.add('display-watch', late)
    cleanup.run()

    expect(late).not.toHaveBeenCalled()
  })

  it('does nothing when no step was registered', () => {
    const onStepFailed = vi.fn()
    const cleanup = createQuitCleanup({ onStepFailed })

    expect(() => cleanup.run()).not.toThrow()
    expect(onStepFailed).not.toHaveBeenCalled()
  })
})

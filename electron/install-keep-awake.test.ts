import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepBlocker } from './cli-keep-awake'
import {
  createInstallKeepAwake,
  isKeepAwakeInstallKey,
  resolveInstallQueueKeepAwake,
  resolveUpdateKeepAwake,
} from './install-keep-awake'
import { InstallationQueue } from './installation-queue'

afterEach(() => {
  vi.useRealTimers()
})

function fakeBlocker() {
  let next = 1
  const running = new Set<number>()
  const calls: string[] = []
  const blocker: SleepBlocker = {
    start(type) {
      calls.push(`start:${type}`)
      running.add(next)
      return next++
    },
    stop(id) {
      calls.push(`stop:${id}`)
      running.delete(id)
    },
  }
  return { blocker, running, calls }
}

describe('isKeepAwakeInstallKey', () => {
  it('holds for downloads and installs but not for launches, uninstalls or cleanup', () => {
    for (const key of ['runtime:node', 'runtime:python', 'runtime:git', 'desktop:codex:install', 'cli:install:claude', 'external-client:install:cherry']) {
      expect(isKeepAwakeInstallKey(key)).toBe(true)
    }
    for (const key of ['cli:uninstall:claude', 'desktop:codex:uninstall', 'desktop:codex:launch:new:zh-CN', 'external-client:launch:cherry', 'maintenance:install-leftovers', 'cli:launch:claude']) {
      expect(isKeepAwakeInstallKey(key)).toBe(false)
    }
  })

  it('also holds when an install is only waiting behind a launch', () => {
    expect(resolveInstallQueueKeepAwake({ activeKey: 'desktop:codex:launch:new:default', pendingKeys: ['runtime:node'] })).toBe(true)
    expect(resolveInstallQueueKeepAwake({ activeKey: 'cli:uninstall:grok', pendingKeys: [] })).toBe(false)
    expect(resolveInstallQueueKeepAwake({ activeKey: null, pendingKeys: [] })).toBe(false)
  })

  it('holds for an update only while it is downloading', () => {
    expect(resolveUpdateKeepAwake({ phase: 'downloading' })).toBe(true)
    for (const phase of ['idle', 'checking', 'available', 'downloaded', 'error', 'disabled'] as const) {
      expect(resolveUpdateKeepAwake({ phase })).toBe(false)
    }
  })
})

describe('createInstallKeepAwake', () => {
  it('blocks automatic sleep while installing and releases when the queue is done', () => {
    const { blocker, running, calls } = fakeBlocker()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => 0 })
    keepAwake.observeQueue({ activeKey: 'desktop:codex:install', pendingKeys: [] })
    expect(keepAwake.holding()).toBe(true)
    expect(calls).toEqual(['start:prevent-app-suspension'])
    keepAwake.observeQueue({ activeKey: 'desktop:codex:install', pendingKeys: ['cli:install:codex'] })
    expect(calls).toHaveLength(1)
    keepAwake.observeQueue({ activeKey: null, pendingKeys: [] })
    expect(keepAwake.holding()).toBe(false)
    expect(running.size).toBe(0)
  })

  it('keeps one hold across an install and an update download and releases after both finish', () => {
    const { blocker, running, calls } = fakeBlocker()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => 0 })
    keepAwake.observeUpdate({ phase: 'downloading' })
    keepAwake.observeQueue({ activeKey: 'runtime:node', pendingKeys: [] })
    keepAwake.observeUpdate({ phase: 'downloaded' })
    expect(keepAwake.holding()).toBe(true)
    keepAwake.observeQueue({ activeKey: null, pendingKeys: [] })
    expect(keepAwake.holding()).toBe(false)
    expect(calls).toEqual(['start:prevent-app-suspension', 'stop:1'])
    expect(running.size).toBe(0)
  })

  it('releases when an update download fails', () => {
    const { blocker } = fakeBlocker()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => 0 })
    keepAwake.observeUpdate({ phase: 'downloading' })
    keepAwake.observeUpdate({ phase: 'error' })
    expect(keepAwake.holding()).toBe(false)
  })

  it('does not hold for launches', () => {
    const { blocker, calls } = fakeBlocker()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => 0 })
    keepAwake.observeQueue({ activeKey: 'external-client:launch:cherry', pendingKeys: [] })
    expect(keepAwake.holding()).toBe(false)
    expect(calls).toEqual([])
  })

  it('gives sleep back after the cap even if an install never reports the end, until it really ends', () => {
    vi.useFakeTimers()
    let clock = 0
    const { blocker, running } = fakeBlocker()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => clock, maxHoldMs: 10 * 60_000 })
    keepAwake.observeQueue({ activeKey: 'runtime:git', pendingKeys: [] })
    expect(keepAwake.holding()).toBe(true)
    clock = 10 * 60_000
    vi.advanceTimersByTime(60_000)
    expect(keepAwake.holding()).toBe(false)
    expect(running.size).toBe(0)
    // 卡住的这一次还在报「还在装」，不能借此重新挡两小时。
    keepAwake.observeQueue({ activeKey: 'runtime:git', pendingKeys: ['cli:install:gemini'] })
    expect(keepAwake.holding()).toBe(false)
    // 真的结束以后，下一次安装照常挡。
    keepAwake.observeQueue({ activeKey: null, pendingKeys: [] })
    keepAwake.observeQueue({ activeKey: 'cli:install:gemini', pendingKeys: [] })
    expect(keepAwake.holding()).toBe(true)
    keepAwake.dispose()
  })

  it('stops holding on dispose and ignores later events', () => {
    const { blocker, running } = fakeBlocker()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => 0 })
    keepAwake.observeQueue({ activeKey: 'runtime:python', pendingKeys: [] })
    keepAwake.dispose()
    expect(running.size).toBe(0)
    keepAwake.observeUpdate({ phase: 'downloading' })
    expect(keepAwake.holding()).toBe(false)
  })

  it('keeps installing when the system refuses to block sleep', () => {
    const log = vi.fn()
    const keepAwake = createInstallKeepAwake({
      blocker: { start: () => { throw new Error('denied') }, stop: () => undefined },
      now: () => 0,
      log,
    })
    expect(() => keepAwake.observeQueue({ activeKey: 'runtime:node', pendingKeys: [] })).not.toThrow()
    expect(keepAwake.holding()).toBe(false)
    expect(log).toHaveBeenCalledWith('warn', 'install.keep-awake.start-failed', expect.any(String), expect.any(Object))
  })

  it('follows a real installation queue from start to finish, including a cancelled install', async () => {
    const { blocker, running } = fakeBlocker()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => 0 })
    const queue = new InstallationQueue()
    queue.onChange((snapshot) => keepAwake.observeQueue(snapshot))
    let finish!: () => void
    const install = queue.enqueue('desktop:codex:install', () => new Promise<void>((resolve) => { finish = resolve }))
    expect(keepAwake.holding()).toBe(true)
    finish()
    await install
    expect(keepAwake.holding()).toBe(false)
    const cancelled = queue.enqueue('cli:install:claude', async () => { throw new Error('已取消安装') })
    await expect(cancelled).rejects.toThrow('已取消安装')
    expect(keepAwake.holding()).toBe(false)
    expect(running.size).toBe(0)
  })

  it('says why it holds and tells the tray only when the reasons change', () => {
    const { blocker } = fakeBlocker()
    const onChange = vi.fn()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => 0, onChange })
    expect(keepAwake.reasons()).toEqual([])
    keepAwake.observeQueue({ activeKey: 'runtime:node', pendingKeys: [] })
    expect(keepAwake.reasons()).toEqual(['install'])
    expect(onChange).toHaveBeenCalledTimes(1)
    keepAwake.observeQueue({ activeKey: 'runtime:node', pendingKeys: ['cli:install:claude'] })
    expect(onChange).toHaveBeenCalledTimes(1)
    keepAwake.observeUpdate({ phase: 'downloading' })
    // Download progress keeps reporting the same phase; the tray line stays put.
    keepAwake.observeUpdate({ phase: 'downloading' })
    expect(keepAwake.reasons()).toEqual(['install', 'update-download'])
    expect(onChange).toHaveBeenCalledTimes(2)
    keepAwake.observeQueue({ activeKey: null, pendingKeys: [] })
    expect(keepAwake.reasons()).toEqual(['update-download'])
    expect(onChange).toHaveBeenCalledTimes(3)
    keepAwake.observeUpdate({ phase: 'downloaded' })
    expect(keepAwake.reasons()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('stops naming a reason once the cap gives sleep back or the system refuses to block it', () => {
    vi.useFakeTimers()
    let clock = 0
    const { blocker } = fakeBlocker()
    const onChange = vi.fn()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => clock, maxHoldMs: 10 * 60_000, onChange })
    keepAwake.observeQueue({ activeKey: 'runtime:git', pendingKeys: [] })
    expect(keepAwake.reasons()).toEqual(['install'])
    clock = 10 * 60_000
    vi.advanceTimersByTime(60_000)
    expect(keepAwake.reasons()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(2)
    keepAwake.dispose()

    const refusedChange = vi.fn()
    const refused = createInstallKeepAwake({
      blocker: { start: () => { throw new Error('denied') }, stop: () => undefined },
      now: () => 0,
      onChange: refusedChange,
    })
    refused.observeUpdate({ phase: 'downloading' })
    expect(refused.reasons()).toEqual([])
    expect(refusedChange).not.toHaveBeenCalled()
  })

  it('keeps installing when the tray cannot follow', () => {
    const log = vi.fn()
    const { blocker } = fakeBlocker()
    const keepAwake = createInstallKeepAwake({ blocker, now: () => 0, log, onChange: () => { throw new Error('tray gone') } })
    expect(() => keepAwake.observeQueue({ activeKey: 'runtime:node', pendingKeys: [] })).not.toThrow()
    expect(keepAwake.holding()).toBe(true)
    expect(log).toHaveBeenCalledWith('warn', 'install.keep-awake.notify-failed', expect.any(String), expect.any(Object))
    keepAwake.dispose()
  })
})

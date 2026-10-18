import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleTimeout } from './schedule-timeout'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('schedule-timeout', () => {
  it('runs the callback once after the delay and not before', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const callback = vi.fn()
    scheduleTimeout(callback, 30_000)
    vi.advanceTimersByTime(29_999)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('never runs the callback once cancelled', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const callback = vi.fn()
    const cancel = scheduleTimeout(callback, 1_000)
    cancel()
    cancel()
    vi.advanceTimersByTime(5_000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('does not keep the process alive while a background check is pending', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const cancel = scheduleTimeout(() => undefined, 60_000)
    try {
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
      expect(setTimeoutSpy.mock.results[0]?.value.hasRef()).toBe(false)
    } finally {
      cancel()
    }
  })

  it('is the only scheduleTimeout in the main process', () => {
    const owners = fs.readdirSync(__dirname)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => /\bfunction scheduleTimeout\(/.test(fs.readFileSync(path.join(__dirname, name), 'utf8')))
    expect(owners).toEqual(['schedule-timeout.ts'])
  })
})

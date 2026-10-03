import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderId, ToolTemplateFillResult } from '../../../../electron/ipc-contract'
import { createTemplateFillRetry, templateFillRetryLimit } from './template-fill-retry'

const minute = 60_000
const owed: ToolTemplateFillResult = { filled: [], pending: ['codex'] }

function harness(answer: () => Promise<ToolTemplateFillResult> = async () => owed) {
  const fill = vi.fn(answer)
  const filled: ProviderId[][] = []
  const retry = createTemplateFillRetry({ fill, filled: (providers) => { filled.push(providers) } })
  return { fill, filled, retry }
}

describe('template fill retry', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T00:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('does nothing when the startup round owes nothing', async () => {
    const h = harness()
    h.retry.follow({ filled: ['claude'] })
    h.retry.foreground()

    await vi.advanceTimersByTimeAsync(2 * 60 * minute)

    expect(h.fill).not.toHaveBeenCalled()
  })

  it('asks again ten minutes later and stops once the tool has been filled', async () => {
    const h = harness(async () => ({ filled: ['codex'] }))
    h.retry.follow(owed)

    await vi.advanceTimersByTimeAsync(10 * minute - 1)
    expect(h.fill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.fill).toHaveBeenCalledTimes(1)
    expect(h.filled).toEqual([['codex']])

    await vi.advanceTimersByTimeAsync(2 * 60 * minute)
    h.retry.foreground()
    expect(h.fill).toHaveBeenCalledTimes(1)
  })

  it('keeps asking every ten minutes while the tool stays open and gives up after six tries', async () => {
    const h = harness()
    h.retry.follow(owed)

    await vi.advanceTimersByTimeAsync(30 * minute)
    expect(h.fill).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(3 * 60 * minute)
    h.retry.foreground()

    expect(h.fill).toHaveBeenCalledTimes(templateFillRetryLimit)
    expect(h.filled).toEqual([])
  })

  it('asks as soon as the window comes back, but not within two minutes of the last try', async () => {
    const h = harness()
    h.retry.follow(owed)

    await vi.advanceTimersByTimeAsync(2 * minute - 1)
    h.retry.foreground()
    expect(h.fill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    h.retry.foreground()
    expect(h.fill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(minute)
    h.retry.foreground()
    expect(h.fill).toHaveBeenCalledTimes(1)

    // 回到前台那次也重新起算十分钟。
    await vi.advanceTimersByTimeAsync(9 * minute - 1)
    expect(h.fill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.fill).toHaveBeenCalledTimes(2)
  })

  it('does not ask twice while a request is still on its way', async () => {
    let answer: (result: ToolTemplateFillResult) => void = () => undefined
    const h = harness(() => new Promise((resolve) => { answer = resolve }))
    h.retry.follow(owed)
    await vi.advanceTimersByTimeAsync(10 * minute)
    expect(h.fill).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30 * minute)
    h.retry.foreground()
    expect(h.fill).toHaveBeenCalledTimes(1)

    answer({ filled: ['codex'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.filled).toEqual([['codex']])
  })

  it('drops an answer that comes back after the account changed', async () => {
    let answer: (result: ToolTemplateFillResult) => void = () => undefined
    const h = harness(() => new Promise((resolve) => { answer = resolve }))
    h.retry.follow(owed)
    await vi.advanceTimersByTimeAsync(10 * minute)

    h.retry.stop()
    answer({ filled: ['codex'], pending: ['claude'] })
    await vi.advanceTimersByTimeAsync(2 * 60 * minute)

    expect(h.filled).toEqual([])
    expect(h.fill).toHaveBeenCalledTimes(1)
  })

  it('counts a failed request as a try and keeps the same pace', async () => {
    const h = harness(async () => { throw new Error('通道不可用') })
    h.retry.follow(owed)

    await vi.advanceTimersByTimeAsync(20 * minute)

    expect(h.fill).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2 * 60 * minute)
    expect(h.fill).toHaveBeenCalledTimes(templateFillRetryLimit)
  })

  it('keeps its pace and count when a later round still owes something, and stops when one owes nothing', async () => {
    const h = harness()
    h.retry.follow(owed)
    await vi.advanceTimersByTimeAsync(15 * minute)
    expect(h.fill).toHaveBeenCalledTimes(1)

    h.retry.follow(owed)
    await vi.advanceTimersByTimeAsync(5 * minute)
    expect(h.fill).toHaveBeenCalledTimes(2)

    h.retry.follow({ filled: [] })
    await vi.advanceTimersByTimeAsync(2 * 60 * minute)
    expect(h.fill).toHaveBeenCalledTimes(2)
  })

  it('starts over with six fresh tries when a new round owes something after it gave up', async () => {
    const h = harness()
    h.retry.follow(owed)
    await vi.advanceTimersByTimeAsync(2 * 60 * minute)
    expect(h.fill).toHaveBeenCalledTimes(templateFillRetryLimit)

    h.retry.follow(owed)
    await vi.advanceTimersByTimeAsync(10 * minute)

    expect(h.fill).toHaveBeenCalledTimes(templateFillRetryLimit + 1)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createTtlCache } from './ttl-cache'

function clock(start = 0) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('ttl cache', () => {
  it('reuses the previous result while it is still fresh', async () => {
    const time = clock()
    const load = vi.fn(async () => 'first')
    const cache = createTtlCache({ load, ttlMs: 60_000, now: time.now })

    expect(await cache.read()).toBe('first')
    time.advance(59_999)
    expect(await cache.read()).toBe('first')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('loads again once the entry has aged past the ttl', async () => {
    const time = clock()
    let answer = 'first'
    const load = vi.fn(async () => answer)
    const cache = createTtlCache({ load, ttlMs: 60_000, now: time.now })

    expect(await cache.read()).toBe('first')
    time.advance(60_000)
    answer = 'second'
    expect(await cache.read()).toBe('second')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one load between concurrent readers', async () => {
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)
    const cache = createTtlCache({ load, ttlMs: 60_000, now: clock().now })

    const both = Promise.all([cache.read(), cache.read()])
    pending.resolve('once')
    expect(await both).toEqual(['once', 'once'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('drops a cached entry when invalidated', async () => {
    const time = clock()
    let answer = 'first'
    const load = vi.fn(async () => answer)
    const cache = createTtlCache({ load, ttlMs: 60_000, now: time.now })

    expect(await cache.read()).toBe('first')
    answer = 'second'
    cache.invalidate()
    expect(await cache.read()).toBe('second')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never lets a load that started before invalidate become the cached value', async () => {
    const time = clock()
    const stale = deferred<string>()
    const fresh = deferred<string>()
    const load = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise)
    const cache = createTtlCache<string>({ load, ttlMs: 60_000, now: time.now })

    const first = cache.read()
    cache.invalidate()
    const second = cache.read()
    // 作废之后来的这一趟必须是新的一次读取，不能复用还在飞的那个 Promise。
    expect(load).toHaveBeenCalledTimes(2)

    stale.resolve('stale')
    fresh.resolve('fresh')
    expect(await first).toBe('stale')
    expect(await second).toBe('fresh')

    // 缓存里留下的只能是后一趟的结果，再读一次不会退回旧值。
    expect(await cache.read()).toBe('fresh')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure, so the next read retries', async () => {
    const time = clock()
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('读盘失败'))
      .mockResolvedValueOnce('recovered')
    const cache = createTtlCache<string>({ load, ttlMs: 60_000, now: time.now })

    await expect(cache.read()).rejects.toThrow('读盘失败')
    expect(await cache.read()).toBe('recovered')
    expect(load).toHaveBeenCalledTimes(2)
  })
})

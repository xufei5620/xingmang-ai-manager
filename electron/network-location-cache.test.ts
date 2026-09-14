import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetworkLocationCache, reloadNetworkProxyConfiguration } from './network-location-cache'
import type { NetworkLocationStatus } from './system-service'

function location(publicIp: string): NetworkLocationStatus {
  return {
    publicIp, countryCode: 'JP', region: 'outside-mainland-china',
    checkedAt: '2026-09-14T00:00:00.000Z', error: null,
  }
}

function deferredLocation() {
  let resolve!: (value: NetworkLocationStatus) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<NetworkLocationStatus>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => vi.useRealTimers())

describe('network location cache', () => {
  it('coalesces ordinary probes and retains their results for the cache lifetime', async () => {
    const pending = deferredLocation()
    const probe = vi.fn(() => pending.promise)
    let now = 0
    const cache = createNetworkLocationCache({ probe, ttlMs: 600_000, now: () => now })
    const first = cache.read()
    expect(cache.read()).toBe(first)
    pending.resolve(location('203.0.113.1'))
    await first
    now = 599_999
    await expect(cache.read()).resolves.toMatchObject({ publicIp: '203.0.113.1' })
    expect(probe).toHaveBeenCalledTimes(1)
    now = 600_000
    await cache.read()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('bypasses a fresh ten-minute cache when explicitly refreshed', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(location('203.0.113.1'))
      .mockResolvedValueOnce(location('203.0.113.2'))
    const cache = createNetworkLocationCache({ probe, ttlMs: 600_000 })
    await cache.read()
    await expect(cache.read(true)).resolves.toMatchObject({ publicIp: '203.0.113.2' })
    await expect(cache.read()).resolves.toMatchObject({ publicIp: '203.0.113.2' })
    expect(probe.mock.calls).toEqual([[false], [true]])
  })

  it.each(['resolve', 'reject'] as const)('makes an older %s follow the new probe instead of overwriting it', async (completion) => {
    const old = deferredLocation()
    const fresh = deferredLocation()
    const probe = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const cache = createNetworkLocationCache({ probe, ttlMs: 600_000 })
    const original = cache.read()
    await Promise.resolve()
    const forced = cache.read(true)
    await Promise.resolve()
    fresh.resolve(location('203.0.113.2'))
    await forced
    if (completion === 'resolve') old.resolve(location('203.0.113.1'))
    else old.reject(new Error('previous route failed'))
    await expect(original).resolves.toMatchObject({ publicIp: '203.0.113.2' })
    await expect(cache.read()).resolves.toMatchObject({ publicIp: '203.0.113.2' })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('waits for the replacement probe when the older response arrives first', async () => {
    const old = deferredLocation()
    const fresh = deferredLocation()
    const probe = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const cache = createNetworkLocationCache({ probe, ttlMs: 600_000 })
    const original = cache.read()
    await Promise.resolve()
    const forced = cache.read(true)
    old.resolve(location('203.0.113.1'))
    await Promise.resolve()
    await Promise.resolve()
    fresh.resolve(location('203.0.113.2'))
    expect(await Promise.all([original, forced, cache.read()])).toEqual([
      location('203.0.113.2'), location('203.0.113.2'), location('203.0.113.2'),
    ])
  })
})

describe('network proxy configuration reload', () => {
  it('awaits the supplied Chromium reload operation', async () => {
    const reload = vi.fn(async () => undefined)
    await reloadNetworkProxyConfiguration(reload)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('bounds a stuck proxy reload and keeps implementation errors private', async () => {
    vi.useFakeTimers()
    const pending = reloadNetworkProxyConfiguration(() => new Promise<void>(() => undefined))
    const assertion = expect(pending).rejects.toThrow('无法刷新当前网络代理配置')
    await vi.advanceTimersByTimeAsync(2500)
    await assertion
    await expect(reloadNetworkProxyConfiguration(async () => { throw new Error('http://user:password@proxy') }))
      .rejects.toThrow('无法刷新当前网络代理配置，请稍后重试。')
  })
})

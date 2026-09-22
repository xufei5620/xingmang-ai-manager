import { describe, expect, it, vi } from 'vitest'
import {
  createDownloadAccelerationCoordinator,
  downloadRouteEndpoint,
  type AccelerationDownloadRouteResult,
} from './download-acceleration'

const scope = 'xm-account:7'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function setup(options: {
  start?: (scope: string) => Promise<AccelerationDownloadRouteResult>
  accountScope?: string | null
  timeoutMs?: number
  onRouteChanged?: (endpoint: unknown) => Promise<void>
} = {}) {
  const startRoute = vi.fn(options.start ?? (async () => ({ status: 'ready', port: 7890 }) as const))
  const stopRoute = vi.fn(async () => {})
  const routes: Array<unknown> = []
  const log = vi.fn()
  const coordinator = createDownloadAccelerationCoordinator({
    getAccountScope: () => (options.accountScope === undefined ? scope : options.accountScope),
    startRoute,
    stopRoute,
    onRouteChanged: options.onRouteChanged ?? (async (endpoint) => { routes.push(endpoint) }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    log,
  })
  return { coordinator, startRoute, stopRoute, routes, log }
}

describe('download route endpoint', () => {
  it('accepts a loopback port and rejects anything else', () => {
    expect(downloadRouteEndpoint(7890)).toEqual({ scheme: 'http', host: '127.0.0.1', port: 7890 })
    expect(downloadRouteEndpoint(0)).toBeNull()
    expect(downloadRouteEndpoint(65_536)).toBeNull()
    expect(downloadRouteEndpoint(1.5)).toBeNull()
    expect(downloadRouteEndpoint('7890')).toBeNull()
    expect(downloadRouteEndpoint(undefined)).toBeNull()
  })
})

describe('download acceleration coordinator', () => {
  it('starts a loopback route and publishes it to the host', async () => {
    const { coordinator, startRoute, stopRoute, routes } = setup()
    const lease = await coordinator.acquire()
    expect(startRoute).toHaveBeenCalledWith(scope)
    expect(lease.accelerated).toBe(true)
    expect(lease.endpoint).toEqual({ scheme: 'http', host: '127.0.0.1', port: 7890 })
    expect(coordinator.currentEndpoint()).toEqual(lease.endpoint)
    expect(routes).toEqual([{ scheme: 'http', host: '127.0.0.1', port: 7890 }])
    await lease.release()
    expect(stopRoute).toHaveBeenCalledTimes(1)
    expect(coordinator.currentEndpoint()).toBeNull()
    expect(routes).toEqual([{ scheme: 'http', host: '127.0.0.1', port: 7890 }, null])
  })

  it('shares one route between concurrent downloads and stops it once', async () => {
    const { coordinator, startRoute, stopRoute } = setup()
    const first = await coordinator.acquire()
    const second = await coordinator.acquire()
    expect(startRoute).toHaveBeenCalledTimes(1)
    expect(second.endpoint).toEqual(first.endpoint)
    await first.release()
    expect(stopRoute).not.toHaveBeenCalled()
    expect(coordinator.currentEndpoint()).not.toBeNull()
    await second.release()
    expect(stopRoute).toHaveBeenCalledTimes(1)
  })

  it('ignores a repeated release so the shared route is not stopped twice', async () => {
    const { coordinator, stopRoute } = setup()
    const first = await coordinator.acquire()
    const second = await coordinator.acquire()
    await first.release()
    await first.release()
    expect(stopRoute).not.toHaveBeenCalled()
    await second.release()
    expect(stopRoute).toHaveBeenCalledTimes(1)
  })

  it('leaves a user-started acceleration alone', async () => {
    const { coordinator, stopRoute, routes } = setup({ start: async () => ({ status: 'system-proxy-active' }) })
    const lease = await coordinator.acquire()
    // 系统代理已经指过去了：下载跟着走，所以算加速，但这里没有自己的端点。
    expect(lease.accelerated).toBe(true)
    expect(lease.endpoint).toBeNull()
    expect(coordinator.currentEndpoint()).toBeNull()
    await lease.release()
    expect(stopRoute).not.toHaveBeenCalled()
    expect(routes).toEqual([])
  })

  it('falls back to no acceleration when the route is unavailable', async () => {
    const { coordinator, stopRoute } = setup({ start: async () => ({ status: 'unavailable' }) })
    const lease = await coordinator.acquire()
    expect(lease.accelerated).toBe(false)
    expect(lease.endpoint).toBeNull()
    await lease.release()
    expect(stopRoute).not.toHaveBeenCalled()
  })

  it('does not ask for a route without a signed-in account', async () => {
    const { coordinator, startRoute } = setup({ accountScope: null })
    const lease = await coordinator.acquire()
    expect(startRoute).not.toHaveBeenCalled()
    expect(lease.accelerated).toBe(false)
  })

  it('keeps the install going when the route throws', async () => {
    const { coordinator, log } = setup({ start: async () => { throw new Error('内核起不来') } })
    const lease = await coordinator.acquire()
    expect(lease.accelerated).toBe(false)
    expect(log).toHaveBeenCalledWith('warn', 'acceleration.download.start.failed', expect.any(String), expect.any(Object))
  })

  it('gives up on a slow route and stops it when it arrives late', async () => {
    const late = deferred<AccelerationDownloadRouteResult>()
    const { coordinator, stopRoute } = setup({ start: () => late.promise, timeoutMs: 5 })
    const lease = await coordinator.acquire()
    expect(lease.accelerated).toBe(false)
    expect(coordinator.currentEndpoint()).toBeNull()
    late.resolve({ status: 'ready', port: 7890 })
    await late.promise
    await Promise.resolve()
    await Promise.resolve()
    // 超时不等于没起来：内核不能留在机器上没人停。
    expect(stopRoute).toHaveBeenCalledWith(scope)
  })

  it('rejects an out-of-range port and hands the route back', async () => {
    const { coordinator, stopRoute } = setup({ start: async () => ({ status: 'ready', port: 0 }) })
    const lease = await coordinator.acquire()
    expect(lease.accelerated).toBe(false)
    expect(stopRoute).toHaveBeenCalledWith(scope)
  })

  it('hands the route back when the host cannot route downloads through it', async () => {
    const { coordinator, stopRoute } = setup({ onRouteChanged: async () => { throw new Error('设置代理失败') } })
    const lease = await coordinator.acquire()
    expect(lease.accelerated).toBe(false)
    expect(coordinator.currentEndpoint()).toBeNull()
    expect(stopRoute).toHaveBeenCalledWith(scope)
  })
})

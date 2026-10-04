import fs from 'node:fs'
import path from 'node:path'
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
  followsSystemProxy?: () => boolean
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
    ...(options.followsSystemProxy === undefined ? {} : { downloadsFollowSystemProxy: options.followsSystemProxy }),
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

  it('does not count a user-started acceleration while this run connects directly', async () => {
    const { coordinator, stopRoute, routes, log } = setup({
      start: async () => ({ status: 'system-proxy-active' }),
      followsSystemProxy: () => false,
    })
    const lease = await coordinator.acquire()
    // 系统代理指着加速，可下载走的默认会话已经整个改了直连：其实没加速，安装源得照地区排。
    expect(lease.accelerated).toBe(false)
    expect(lease.endpoint).toBeNull()
    expect(coordinator.currentEndpoint()).toBeNull()
    expect(log).toHaveBeenCalledWith('info', 'acceleration.download.direct', expect.any(String), undefined)
    await lease.release()
    expect(stopRoute).not.toHaveBeenCalled()
    expect(routes).toEqual([])
  })

  it('stops counting a shared user-started acceleration once this run connects directly', async () => {
    let follows = true
    const { coordinator, startRoute, stopRoute } = setup({
      start: async () => ({ status: 'system-proxy-active' }),
      followsSystemProxy: () => follows,
    })
    const first = await coordinator.acquire()
    expect(first.accelerated).toBe(true)
    // 第一份还握着时用户停了加速，系统代理改回那个关掉的代理，星芒随后整个改了直连。
    follows = false
    const second = await coordinator.acquire()
    expect(second.accelerated).toBe(false)
    expect(startRoute).toHaveBeenCalledTimes(1)
    await second.release()
    await first.release()
    expect(stopRoute).not.toHaveBeenCalled()
    expect(coordinator.currentEndpoint()).toBeNull()
  })

  it('keeps its own route while this run connects directly', async () => {
    const { coordinator, stopRoute, routes } = setup({ followsSystemProxy: () => false })
    const lease = await coordinator.acquire()
    // 临时线路是给下载专用会话明着设的代理，不看系统代理，改了直连也照样走得上。
    expect(lease.accelerated).toBe(true)
    expect(lease.endpoint).toEqual({ scheme: 'http', host: '127.0.0.1', port: 7890 })
    expect(routes).toEqual([{ scheme: 'http', host: '127.0.0.1', port: 7890 }])
    await lease.release()
    expect(stopRoute).toHaveBeenCalledTimes(1)
  })

  it('is told by main.ts when this run has switched to connecting directly', () => {
    // 接线一断，上面这几条就形同虚设：改了直连以后照样说已经加速。
    const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
    expect(main).toContain('downloadsFollowSystemProxy: () => !proxyBypass.active(),')
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

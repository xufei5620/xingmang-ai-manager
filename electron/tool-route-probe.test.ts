import { describe, expect, it, vi } from 'vitest'
import { createToolRouteProbe } from './tool-route-probe'
import type { ToolPathResult } from './tool-path-probe'

// RFC 5737 documentation addresses only.
const passed: ToolPathResult = { ok: true, addresses: ['192.0.2.10'], attempts: [] }
const reset: ToolPathResult = { ok: false, kind: 'reset', addresses: ['192.0.2.10'], attempts: [] }
const proxyRefused: ToolPathResult = { ok: false, kind: 'refused', addresses: [], attempts: [] }
const proxyPassed: ToolPathResult = { ok: true, addresses: [], attempts: [] }
const losAngeles = 'https://xm-direct.solov.cc'
const cloudflare = 'https://xm.solov.cc'

describe('createToolRouteProbe', () => {
  it('only tests the direct path when no proxy is in use', async () => {
    const direct = vi.fn(async () => passed)
    const throughSystemProxy = vi.fn(async () => proxyPassed)
    const throughProxy = vi.fn(async () => proxyPassed)
    const probe = createToolRouteProbe({
      direct, systemProxyActive: async () => false, throughSystemProxy,
      environmentProxies: async () => [], throughProxy,
    })
    expect(await probe('direct')).toEqual({ ok: true, addresses: ['192.0.2.10'] })
    expect(direct).toHaveBeenCalledWith(losAngeles)
    expect(throughSystemProxy).not.toHaveBeenCalled()
    expect(throughProxy).not.toHaveBeenCalled()
  })

  it('fails a line on its direct path whatever the proxies say', async () => {
    const probe = createToolRouteProbe({ direct: async () => reset, systemProxyActive: async () => true, throughSystemProxy: async () => proxyPassed })
    expect(await probe('direct')).toEqual({ ok: false, kind: 'reset', addresses: ['192.0.2.10'] })
  })

  it('needs every proxy in use to pass when another line passes everywhere', async () => {
    // 系统代理放不过洛杉矶、放得过 CF：工具换到 CF 就都能用，洛杉矶算没通。
    const throughSystemProxy = vi.fn(async (origin: string) => origin === losAngeles ? proxyRefused : proxyPassed)
    const throughProxy = vi.fn(async () => proxyPassed)
    const probe = createToolRouteProbe({
      direct: async () => passed, systemProxyActive: async () => true, throughSystemProxy,
      environmentProxies: async () => ['http://127.0.0.1:7890', 'socks5://127.0.0.1:7891'], throughProxy,
    })
    expect(await probe('direct')).toEqual({ ok: false, kind: 'refused', addresses: ['192.0.2.10'] })
    expect(throughSystemProxy.mock.calls.map(([origin]) => origin)).toEqual([losAngeles, cloudflare])
    expect(throughProxy.mock.calls).toEqual([
      ['http://127.0.0.1:7890', losAngeles], ['socks5://127.0.0.1:7891', losAngeles],
      ['http://127.0.0.1:7890', cloudflare], ['socks5://127.0.0.1:7891', cloudflare],
    ])
    expect(await probe('primary')).toEqual({ ok: true, addresses: ['192.0.2.10'] })
  })

  it('falls back to the direct path when no line passes everywhere', async () => {
    const probe = createToolRouteProbe({
      direct: async () => passed,
      environmentProxies: async () => ['http://127.0.0.1:7890', 'http://127.0.0.1:7891'],
      throughProxy: async (proxy) => proxy.endsWith('7891') ? proxyRefused : proxyPassed,
    })
    expect(await probe('direct')).toEqual({ ok: true, addresses: ['192.0.2.10'] })
    expect(await probe('primary')).toEqual({ ok: true, addresses: ['192.0.2.10'] })
  })

  it('treats an unreadable proxy setting as no proxy', async () => {
    const probe = createToolRouteProbe({
      direct: async () => passed,
      systemProxyActive: async () => { throw new Error('resolveProxy failed') }, throughSystemProxy: async () => proxyRefused,
      environmentProxies: async () => { throw new Error('PowerShell failed') }, throughProxy: async () => proxyRefused,
    })
    expect(await probe('primary')).toEqual({ ok: true, addresses: ['192.0.2.10'] })
  })

  it('reports a slow proxy without counting it when nothing else failed', async () => {
    const slow: ToolPathResult = { ok: false, kind: 'slow', addresses: [], attempts: [] }
    const probe = createToolRouteProbe({
      direct: async () => passed, systemProxyActive: async () => true,
      throughSystemProxy: async (origin) => origin === losAngeles ? slow : proxyPassed,
    })
    expect(await probe('direct')).toEqual({ ok: false, kind: 'slow', addresses: ['192.0.2.10'] })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createRouteStatusReader, parseRouteStatus, routeIncidentActive, routeStatusAllowsHongKong, routeStatusCacheMs } from './route-status-file'

// 地址一律用文档专用段（RFC 5737 / RFC 3849）。
const sample = {
  v: 1,
  updated_at: '2026-10-08T00:00:00Z',
  incident: { line: 'direct', state: 'none', since: null },
  lines: {
    direct: { target: 'lax', proxied: false, healthy: true, legit_ips: ['192.0.2.10', '2001:db8::10', 'not-an-ip', 7] },
    'direct-hk': { target: 'hkg', proxied: false, healthy: true, legit_ips: ['198.51.100.20'] },
    other: { target: 'x' },
  },
  hk_enabled: false,
  hk_recommended: true,
  future_field: { anything: true },
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

describe('route-status-file', () => {
  it('reads the v1 format and drops what it does not know', () => {
    expect(parseRouteStatus(JSON.stringify(sample))).toEqual({
      updatedAt: '2026-10-08T00:00:00Z',
      incident: { line: 'direct', state: 'none', since: null },
      lines: {
        direct: { target: 'lax', proxied: false, healthy: true, legitIps: ['192.0.2.10', '2001:db8::10'] },
        'direct-hk': { target: 'hkg', proxied: false, healthy: true, legitIps: ['198.51.100.20'] },
      },
      hkEnabled: false,
      hkRecommended: true,
    })
  })

  it('treats another version, a non-object or a web page as unreadable', () => {
    for (const text of [JSON.stringify({ ...sample, v: 2 }), '[]', '<html></html>', 'null']) expect(parseRouteStatus(text)).toBeNull()
  })

  it('waits on an incident only for the current line and allows Hong Kong only when both switches are on', () => {
    const switching = parseRouteStatus(JSON.stringify({ ...sample, incident: { line: 'direct', state: 'switching', since: null } }))
    expect(routeIncidentActive(switching, 'direct')).toBe(true)
    expect(routeIncidentActive(switching, 'primary')).toBe(false)
    expect(routeIncidentActive(parseRouteStatus(JSON.stringify(sample)), 'direct')).toBe(false)
    expect(routeIncidentActive(null, 'direct')).toBe(false)
    expect(routeStatusAllowsHongKong(parseRouteStatus(JSON.stringify(sample)))).toBe(false)
    expect(routeStatusAllowsHongKong(parseRouteStatus(JSON.stringify({ ...sample, hk_enabled: true })))).toBe(true)
    expect(routeStatusAllowsHongKong(null)).toBe(false)
  })

  it('tries the current app line first, then the other one, and never follows a redirect', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).startsWith('https://xm-direct.solov.cc')
      ? new Response('<html>not found</html>', { status: 404 })
      : json(sample))
    const reader = createRouteStatusReader({ fetch: fetchImpl, lines: () => ['direct', 'primary'] })
    expect((await reader.read())?.hkRecommended).toBe(true)
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://xm-direct.solov.cc/xm-route-status.json',
      'https://xm.solov.cc/xm-route-status.json',
    ])
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === 'manual' && init.credentials === 'omit')).toBe(true)
  })

  it('reads as unavailable when every line fails, and caches for ten minutes unless asked fresh', async () => {
    const clock = { now: 1_000_000 }
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed') })
    const reader = createRouteStatusReader({ fetch: fetchImpl, lines: () => ['primary', 'direct'], now: () => clock.now })
    expect(await reader.read()).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    fetchImpl.mockImplementation(async () => json(sample))
    expect(await reader.read()).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect((await reader.read({ fresh: true }))?.incident.state).toBe('none')
    clock.now += routeStatusCacheMs - 1
    await reader.read()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    clock.now += 1
    await reader.read()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('refuses an oversized body and a redirect answer', async () => {
    const big = new Response(`{"v":1,"pad":"${'x'.repeat(20 * 1024)}"}`, { status: 200 })
    const reader = createRouteStatusReader({ fetch: vi.fn<typeof fetch>(async () => big), lines: () => ['primary'] })
    expect(await reader.read()).toBeNull()
    const redirect = createRouteStatusReader({ fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })), lines: () => ['primary'] })
    expect(await redirect.read()).toBeNull()
  })

  it('shares one request between callers asking at the same time', async () => {
    let release!: () => void
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = () => resolve(json(sample)) }))
    const reader = createRouteStatusReader({ fetch: fetchImpl, lines: () => ['primary'] })
    const first = reader.read()
    const second = reader.read({ fresh: true })
    release()
    expect(await first).toEqual(await second)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

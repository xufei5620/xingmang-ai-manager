import { describe, expect, it, vi } from 'vitest'
import { createNewApiClient } from './new-api-client'
import { automaticBypassCooldownMs, createProxyBypass, createSiteFetch, isNetworkSettingsKind, networkSettingsTarget, probeDirectConnection, siteProbeBackoffMs, systemProxyCheckIntervalMs, type ProxyBypassDependencies } from './proxy-bypass'

const probeUrl = 'https://relay.example/api/status'
// An AI request to the same service the account requests go to.
const siteUrl = 'https://relay.example/v1/chat/completions'

function dependencies(overrides: Partial<ProxyBypassDependencies> = {}) {
  const modes: string[] = []
  const deps: ProxyBypassDependencies = {
    probeUrl: () => probeUrl,
    resolveProxy: async () => 'PROXY 127.0.0.1:7890',
    setProxy: async (mode) => { modes.push(mode) },
    probe: async () => true,
    probeSiteDirect: async () => true,
    accelerationActive: async () => false,
    ...overrides,
  }
  return { deps, modes }
}

describe('proxy bypass', () => {
  it('switches the app session to direct and keeps it when the service answers', async () => {
    const { deps, modes } = dependencies()
    const bypass = createProxyBypass(deps)
    expect(bypass.active()).toBe(false)
    expect(await bypass.tryBypass()).toBe('direct')
    expect(bypass.active()).toBe(true)
    expect(modes).toEqual(['direct'])
    // Once direct works it stays for the run; no more flipping.
    expect(await bypass.tryBypass()).toBe('direct')
    expect(modes).toEqual(['direct'])
  })

  it('goes back to the system proxy when direct does not work either', async () => {
    const { deps, modes } = dependencies({ probe: async () => false })
    const bypass = createProxyBypass(deps)
    expect(await bypass.tryBypass()).toBe('unreachable')
    expect(bypass.active()).toBe(false)
    expect(modes).toEqual(['direct', 'system'])
  })

  it('treats a failing probe as unreachable', async () => {
    const { deps, modes } = dependencies({ probe: async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED') } })
    expect(await createProxyBypass(deps).tryBypass()).toBe('unreachable')
    expect(modes).toEqual(['direct', 'system'])
  })

  it('leaves the session alone when no proxy is in use', async () => {
    const { deps, modes } = dependencies({ resolveProxy: async () => 'DIRECT' })
    expect(await createProxyBypass(deps).tryBypass()).toBe('no-proxy')
    expect(modes).toEqual([])
  })

  it('never overrides the proxy while acceleration owns it, or when its state cannot be read', async () => {
    const running = dependencies({ accelerationActive: async () => true })
    expect(await createProxyBypass(running.deps).tryBypass()).toBe('acceleration')
    expect(running.modes).toEqual([])
    const unknown = dependencies({ accelerationActive: async () => { throw new Error('helper down') } })
    expect(await createProxyBypass(unknown.deps).tryBypass()).toBe('acceleration')
    expect(unknown.modes).toEqual([])
  })

  it('does nothing without a probe address', async () => {
    const { deps, modes } = dependencies({ probeUrl: () => null })
    expect(await createProxyBypass(deps).tryBypass()).toBe('unavailable')
    expect(modes).toEqual([])
  })

  it('shares one attempt between concurrent callers', async () => {
    const probe = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probe })
    const bypass = createProxyBypass(deps)
    expect(await Promise.all([bypass.tryBypass(), bypass.tryBypass()])).toEqual(['direct', 'direct'])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(modes).toEqual(['direct'])
  })
})

describe('direct connection probe', () => {
  it('counts any real answer from the service, without following redirects or reading the body', async () => {
    const cancel = vi.fn(async () => undefined)
    const fetchImpl = vi.fn(async () => ({ status: 503, type: 'basic', body: { cancel } }) as unknown as Response)
    expect(await probeDirectConnection(fetchImpl, probeUrl)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(probeUrl, expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) }))
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects a redirect, which is what a sign-in portal answers with', async () => {
    const redirected = vi.fn(async () => ({ status: 302, type: 'basic', body: null }) as unknown as Response)
    expect(await probeDirectConnection(redirected, probeUrl)).toBe(false)
    const opaque = vi.fn(async () => ({ status: 0, type: 'opaqueredirect', body: null }) as unknown as Response)
    expect(await probeDirectConnection(opaque, probeUrl)).toBe(false)
  })

  it('refuses anything but https', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'))
    expect(await probeDirectConnection(fetchImpl, 'http://relay.example/api/status')).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('network settings targets', () => {
  it('only knows the two fixed destinations', () => {
    expect(isNetworkSettingsKind('proxy')).toBe(true)
    expect(isNetworkSettingsKind('captive-portal')).toBe(true)
    expect(isNetworkSettingsKind('https://evil.example')).toBe(false)
    expect(isNetworkSettingsKind(undefined)).toBe(false)
  })

  it('opens the proxy page and the system portal check address on each platform', () => {
    expect(networkSettingsTarget('win32', 'proxy')).toBe('ms-settings:network-proxy')
    expect(networkSettingsTarget('win32', 'captive-portal')).toBe('http://www.msftconnecttest.com/redirect')
    expect(networkSettingsTarget('darwin', 'proxy')).toBe('x-apple.systempreferences:com.apple.preference.network')
    expect(networkSettingsTarget('darwin', 'captive-portal')).toBe('http://captive.apple.com/')
    expect(networkSettingsTarget('linux', 'proxy')).toBeNull()
  })
})


describe('proxy bypass after a failed account request', () => {
  it('switches the whole app to direct when the proxy itself is down, and asks for a retry only for requests sent before the switch', async () => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'proxy')).toBe(true)
    expect(modes).toEqual(['direct'])
    expect(bypass.active()).toBe(true)
    // Another request that was stuck on the proxy at the same time is worth resending.
    expect(await bypass.recoverFailedRequest(950, 'timeout')).toBe(true)
    // One sent after the switch already went direct; resending would not change anything.
    clock = 2_000
    expect(await bypass.recoverFailedRequest(1_500, 'proxy')).toBe(false)
    expect(modes).toEqual(['direct'])
    expect(probeSiteDirect).not.toHaveBeenCalled()
    // The app session is direct already; the service needs no separate route.
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
  })

  it.each(['proxy', 'timeout', 'refused'] as const)('does not retry a %s failure when no proxy is in use', async (reason) => {
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ resolveProxy: async () => 'DIRECT', probeSiteDirect })
    expect(await createProxyBypass(deps).recoverFailedRequest(0, reason)).toBe(false)
    expect(modes).toEqual([])
    expect(probeSiteDirect).not.toHaveBeenCalled()
  })

  it.each(['proxy', 'timeout', 'refused'] as const)('does not retry a %s failure while acceleration owns the proxy', async (reason) => {
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ accelerationActive: async () => true, probeSiteDirect })
    expect(await createProxyBypass(deps).recoverFailedRequest(0, reason)).toBe(false)
    expect(modes).toEqual([])
    expect(probeSiteDirect).not.toHaveBeenCalled()
  })

  it('backs off after direct failed too, but still lets the user recheck by hand', async () => {
    let clock = 10_000
    const probe = vi.fn(async () => false)
    const { deps, modes } = dependencies({ probe, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(9_000, 'proxy')).toBe(false)
    expect(modes).toEqual(['direct', 'system'])
    clock += automaticBypassCooldownMs - 1
    expect(await bypass.recoverFailedRequest(clock - 100, 'proxy')).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(await bypass.tryBypass()).toBe('unreachable')
    expect(probe).toHaveBeenCalledTimes(2)
    clock += automaticBypassCooldownMs
    probe.mockResolvedValueOnce(true)
    expect(await bypass.recoverFailedRequest(clock - 100, 'proxy')).toBe(true)
    expect(bypass.active()).toBe(true)
  })

  it('waits for a whole-app switch already under way before answering a timeout, and resends a request sent before it', async () => {
    let clock = 1_000
    let mode = 'system'
    let finishProbe: (reachable: boolean) => void = () => undefined
    const probe = vi.fn(() => new Promise<boolean>((resolve) => { finishProbe = resolve }))
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({
      probe,
      probeSiteDirect,
      now: () => clock,
      // While the attempt runs the app session is already direct, and Chromium says so.
      resolveProxy: async () => mode === 'direct' ? 'DIRECT' : 'PROXY 127.0.0.1:7890',
      setProxy: async (next) => { mode = next },
    })
    const bypass = createProxyBypass(deps)
    const deadProxy = bypass.recoverFailedRequest(900, 'proxy')
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    const timedOut = bypass.recoverFailedRequest(950, 'timeout')
    // Give the timed-out request every chance to look at the app session mid-switch.
    await new Promise((resolve) => setTimeout(resolve, 0))
    clock = 1_100
    finishProbe(true)
    expect(await Promise.all([deadProxy, timedOut])).toEqual([true, true])
    expect(probeSiteDirect).not.toHaveBeenCalled()
  })
})

describe('proxy bypass after an account request timed out or was cut off on a live proxy', () => {
  it.each(['timeout', 'refused'] as const)('moves only requests to the service to the direct session after a %s, leaving the app session on the system proxy', async (reason) => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, reason)).toBe(true)
    expect(probeSiteDirect).toHaveBeenCalledWith(probeUrl)
    expect(modes).toEqual([])
    expect(bypass.active()).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toEqual(expect.any(Number))
    // GitHub, npm and everything else keep following the system proxy.
    expect(bypass.routeSiteRequest('https://github.com/anthropics/claude-plugins-official')).toBeNull()
    expect(bypass.routeSiteRequest('not a url')).toBeNull()
    // Another account request that was stuck on the proxy at the same time is worth resending.
    expect(await bypass.recoverFailedRequest(950, 'timeout')).toBe(true)
    // One sent after the move already went direct and got an answer it could not read; resending would not help.
    clock = 2_000
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
    expect(probeSiteDirect).toHaveBeenCalledTimes(1)
    expect(modes).toEqual([])
  })

  it('probes once for several account requests that fail together', async () => {
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probeSiteDirect })
    const bypass = createProxyBypass(deps)
    expect(await Promise.all([bypass.recoverFailedRequest(0, 'timeout'), bypass.recoverFailedRequest(0, 'refused')])).toEqual([true, true])
    expect(probeSiteDirect).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a probe address', async () => {
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probeUrl: () => null, probeSiteDirect })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(0, 'timeout')).toBe(false)
    expect(probeSiteDirect).not.toHaveBeenCalled()
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
  })

  it('stays on the system proxy when direct does not answer either, and probes again a minute later', async () => {
    let clock = 10_000
    const probeSiteDirect = vi.fn(async () => false)
    const probe = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probeSiteDirect, probe, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(9_000, 'timeout')).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    clock += siteProbeBackoffMs - 1
    expect(await bypass.recoverFailedRequest(clock - 100, 'timeout')).toBe(false)
    expect(probeSiteDirect).toHaveBeenCalledTimes(1)
    // Direct just failed, so a dead proxy is not worth flipping the app session over yet either.
    expect(await bypass.recoverFailedRequest(clock - 100, 'proxy')).toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(modes).toEqual([])
    clock += 1
    probeSiteDirect.mockResolvedValueOnce(true)
    expect(await bypass.recoverFailedRequest(clock - 100, 'timeout')).toBe(true)
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
  })

  it('treats a failing direct probe as unreachable', async () => {
    const { deps } = dependencies({ probeSiteDirect: async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED') } })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(0, 'timeout')).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
  })

  it('hands the service back to the system proxy when a request fails on the direct session, and resends it once direct answers again', async () => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const first = bypass.routeSiteRequest(siteUrl)!
    clock = 2_000
    bypass.siteRouteFailed(first)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    // The request that failed on the direct session asks next. The blip is over, so
    // the probe goes through and the request is sent once more.
    clock = 2_100
    expect(await bypass.recoverFailedRequest(1_500, 'refused')).toBe(true)
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    const second = bypass.routeSiteRequest(siteUrl)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    // A failure from the earlier round that arrives late does not undo the fresh one.
    bypass.siteRouteFailed(first)
    expect(bypass.routeSiteRequest(siteUrl)).toBe(second)
  })

  it('does not leave the service on a proxy that does not forward it for five minutes after the network blinks', async () => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    // Wi-Fi drops: a request on the direct session fails, and so does the probe it sets off.
    clock = 2_000
    bypass.siteRouteFailed(bypass.routeSiteRequest(siteUrl)!)
    probeSiteDirect.mockResolvedValueOnce(false)
    expect(await bypass.recoverFailedRequest(1_900, 'timeout')).toBe(false)
    // Wi-Fi is back, but the proxy still does not forward the service. A minute on, the next
    // timeout probes again and the service goes direct.
    clock += siteProbeBackoffMs
    expect(await bypass.recoverFailedRequest(clock - 100, 'timeout')).toBe(true)
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
  })
})

describe('proxy bypass watching the system proxy while the service goes direct', () => {
  it('checks every five minutes and switches the whole app once the proxy itself is gone', async () => {
    let clock = 1_000
    const probe = vi.fn<(url: string) => Promise<boolean>>(async () => true)
    const { deps, modes } = dependencies({ probe, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    clock += systemProxyCheckIntervalMs - 1
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
    expect(probe).not.toHaveBeenCalled()
    // The proxy app crashed and left the system proxy pointing at nothing.
    clock += 1
    probe.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    // This request still goes direct; the check runs alongside it.
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
    await vi.waitFor(() => expect(bypass.active()).toBe(true))
    expect(probe).toHaveBeenCalledTimes(2)
    expect(modes).toEqual(['direct'])
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
  })

  it.each([
    ['answers', async () => true],
    ['still does not forward the service', async () => { throw new DOMException('The operation timed out.', 'TimeoutError') }],
    ['cuts the connection', async () => { throw new Error('net::ERR_CONNECTION_CLOSED') }],
  ])('changes nothing when the proxy %s, and checks again only after another five minutes', async (_case, answer) => {
    let clock = 1_000
    const probe = vi.fn<(url: string) => Promise<boolean>>(answer)
    const { deps, modes } = dependencies({ probe, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    clock += systemProxyCheckIntervalMs
    const route = bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    clock += systemProxyCheckIntervalMs - 1
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
    await Promise.resolve()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(modes).toEqual([])
    expect(bypass.active()).toBe(false)
  })
})

describe('site fetch', () => {
  function routes(route: number | null) {
    const state = { route }
    const bypass = {
      routeSiteRequest: vi.fn((_url: string) => state.route),
      siteRouteFailed: vi.fn((failed: number) => { if (failed === state.route) state.route = null }),
    }
    const viaSession = vi.fn<typeof fetch>(async () => new Response('session'))
    const viaDirect = vi.fn<typeof fetch>(async () => new Response('direct'))
    return { state, bypass, viaSession, viaDirect }
  }

  it('goes through the app session while the service is not moved', async () => {
    const { bypass, viaSession, viaDirect } = routes(null)
    const response = await createSiteFetch(bypass, viaSession, viaDirect)('https://relay.example/api/user/self', { method: 'GET' })
    expect(await response.text()).toBe('session')
    expect(viaSession).toHaveBeenCalledWith('https://relay.example/api/user/self', { method: 'GET' })
    expect(viaDirect).not.toHaveBeenCalled()
  })

  it('asks about the address of each request, whatever form it is given in', async () => {
    const { bypass, viaSession, viaDirect } = routes(null)
    const siteFetch = createSiteFetch(bypass, viaSession, viaDirect)
    await siteFetch(new URL(siteUrl))
    await siteFetch(new Request(probeUrl))
    expect(bypass.routeSiteRequest.mock.calls).toEqual([[siteUrl], [probeUrl]])
  })

  it('goes through the direct session while the service is moved, and keeps it on any answer from the service', async () => {
    const { bypass, viaSession, viaDirect } = routes(1)
    viaDirect.mockResolvedValueOnce(new Response('busy', { status: 503 }))
    const response = await createSiteFetch(bypass, viaSession, viaDirect)(siteUrl)
    expect(response.status).toBe(503)
    expect(viaSession).not.toHaveBeenCalled()
    expect(bypass.siteRouteFailed).not.toHaveBeenCalled()
  })

  it('hands the service back to the system proxy when the direct session fails at the network layer', async () => {
    const { state, bypass, viaSession, viaDirect } = routes(1)
    const failure = new Error('net::ERR_CONNECTION_TIMED_OUT')
    viaDirect.mockRejectedValueOnce(failure)
    const siteFetch = createSiteFetch(bypass, viaSession, viaDirect)
    await expect(siteFetch(siteUrl)).rejects.toBe(failure)
    expect(bypass.siteRouteFailed).toHaveBeenCalledWith(1)
    expect(state.route).toBeNull()
    await siteFetch(siteUrl)
    expect(viaSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the direct session when the caller stopped the request itself, as pressing stop in AI chat does', async () => {
    const { bypass, viaSession, viaDirect } = routes(1)
    const controller = new AbortController()
    viaDirect.mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'))
    })
    await expect(createSiteFetch(bypass, viaSession, viaDirect)(siteUrl, { signal: controller.signal })).rejects.toThrow('aborted')
    expect(bypass.siteRouteFailed).not.toHaveBeenCalled()
  })

  it('counts a stopped request as a failure for account requests, which only ever stop when no answer came in time', async () => {
    const { bypass, viaSession, viaDirect } = routes(1)
    const controller = new AbortController()
    viaDirect.mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'))
    })
    const accountFetch = createSiteFetch(bypass, viaSession, viaDirect, { abortMeansUnreachable: true })
    await expect(accountFetch(probeUrl, { signal: controller.signal })).rejects.toThrow('aborted')
    expect(bypass.siteRouteFailed).toHaveBeenCalledWith(1)
  })
})

describe('proxy bypass with the account client', () => {
  const status = {
    system_name: '星芒AI',
    version: 'v1.0.0-rc.24',
    setup: true,
    quota_per_unit: 500_000,
    quota_display_type: 'USD',
    usd_exchange_rate: 7.3,
    register_enabled: true,
    password_register_enabled: true,
    email_verification: true,
    turnstile_check: false,
  }

  it('resends an account read that timed out on a live proxy over the direct session, and takes AI requests to the same service along', async () => {
    const { deps, modes } = dependencies()
    const bypass = createProxyBypass(deps)
    // The proxy forwards everything but the service, where it just hangs until the client gives up.
    const viaSession = vi.fn<typeof fetch>(async (input) => {
      if (String(input instanceof Request ? input.url : input).startsWith('https://relay.example/')) {
        throw new DOMException('This operation was aborted', 'AbortError')
      }
      return new Response('through the proxy')
    })
    const viaDirect = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ success: true, message: '', data: status }), {
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = createNewApiClient({
      baseUrl: 'https://relay.example',
      fetchImpl: createSiteFetch(bypass, viaSession, viaDirect, { abortMeansUnreachable: true }),
      retryOffProxy: (failure) => bypass.recoverFailedRequest(failure.startedAt, failure.reason),
    })
    await expect(client.getStatus()).resolves.toBeTruthy()
    expect(viaSession).toHaveBeenCalledTimes(1)
    expect(viaDirect).toHaveBeenCalledTimes(1)
    expect(modes).toEqual([])

    const relayFetch = createSiteFetch(bypass, viaSession, viaDirect)
    await relayFetch(siteUrl, { method: 'POST' })
    expect(viaDirect).toHaveBeenCalledTimes(2)
    expect(await (await relayFetch('https://github.com/anthropics/claude-plugins-official')).text()).toBe('through the proxy')
  })
})

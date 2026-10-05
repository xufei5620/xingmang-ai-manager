import { describe, expect, it, vi } from 'vitest'
import { createNewApiClient } from './new-api-client'
import { automaticBypassCooldownMs, createProxyBypass, createSiteFetch, createSiteRouting, isNetworkSettingsKind, networkSettingsTarget, probeDirectConnection, proxyRecheckDelayMs, siteProbeBackoffMs, siteRecheckDelaysMs, systemProxyCheckIntervalMs, type ProxyBypassDependencies } from './proxy-bypass'

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
    probeSystemProxy: async () => true,
    accelerationActive: async () => false,
    ...overrides,
  }
  return { deps, modes }
}

// The app session as Chromium runs it: it follows the system proxy until it is switched to direct.
// The proxy app the system proxy points at is either up or not running; when it is not, anything
// through it is refused at once. Direct gets through unless a test says otherwise.
function proxyApp(overrides: Partial<ProxyBypassDependencies> = {}) {
  const state = { mode: 'system' as 'direct' | 'system', up: false, direct: true }
  const modes: string[] = []
  const logs: string[] = []
  const refused = () => new Error('net::ERR_PROXY_CONNECTION_FAILED')
  const probe = vi.fn(async (_url: string) => {
    if (state.mode === 'direct') return state.direct
    if (state.up) return true
    throw refused()
  })
  const probeSystemProxy = vi.fn(async (_url: string) => {
    if (state.up) return true
    throw refused()
  })
  const deps: ProxyBypassDependencies = {
    probeUrl: () => probeUrl,
    resolveProxy: async () => state.mode === 'direct' ? 'DIRECT' : 'PROXY 127.0.0.1:7890',
    setProxy: async (mode) => {
      state.mode = mode
      modes.push(mode)
    },
    probe,
    probeSiteDirect: async () => true,
    probeSystemProxy,
    accelerationActive: async () => false,
    schedule: immediately,
    log: (_level, event) => { logs.push(event) },
    ...overrides,
  }
  return { deps, modes, logs, state, probe, probeSystemProxy }
}

// Runs the short wait before the second look at a refused request at once, for tests that are not about that wait.
function immediately(run: () => void): () => void {
  run()
  return () => undefined
}

// A live proxy that does not forward the service gives a probe through it nothing until the probe gives up.
async function proxyDoesNotForward(): Promise<boolean> {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
}

// The later looks after a failure on the direct session wait on a timer; these tests hold the
// timers and run them by hand.
function heldTimers() {
  const timers: { run: () => void, delayMs: number, cancelled: boolean }[] = []
  return {
    schedule(run: () => void, delayMs: number) {
      const timer = { run, delayMs, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    waiting: () => timers.filter((timer) => !timer.cancelled).map((timer) => timer.delayMs),
    runNext() {
      const [timer] = timers.filter((candidate) => !candidate.cancelled)
      timer.cancelled = true
      timer.run()
    },
  }
}

describe('proxy bypass', () => {
  it('switches the app session to direct and keeps it when the service answers', async () => {
    const { deps, modes } = dependencies()
    const bypass = createProxyBypass(deps)
    expect(bypass.active()).toBe(false)
    expect(await bypass.tryBypass()).toBe('direct')
    expect(bypass.active()).toBe(true)
    expect(modes).toEqual(['direct'])
    // Once direct works it stays; another try does not flip it.
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
    const { deps, modes } = proxyApp({ probeSiteDirect, now: () => clock })
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
    const { deps, modes, state, probe } = proxyApp({ now: () => clock })
    state.direct = false
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(9_000, 'proxy')).toBe(false)
    expect(modes).toEqual(['direct', 'system'])
    // Once more through the proxy a moment later, then direct.
    expect(probe).toHaveBeenCalledTimes(2)
    clock += automaticBypassCooldownMs - 1
    expect(await bypass.recoverFailedRequest(clock - 100, 'proxy')).toBe(false)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(await bypass.tryBypass()).toBe('unreachable')
    expect(probe).toHaveBeenCalledTimes(3)
    clock += automaticBypassCooldownMs
    state.direct = true
    expect(await bypass.recoverFailedRequest(clock - 100, 'proxy')).toBe(true)
    expect(bypass.active()).toBe(true)
  })

  it('waits for a whole-app switch already under way before answering a timeout, and resends a request sent before it', async () => {
    let clock = 1_000
    let finishProbe: (reachable: boolean) => void = () => undefined
    const probeSiteDirect = vi.fn(async () => true)
    // While the attempt runs the app session is already direct, and Chromium says so.
    const { deps, state, probe } = proxyApp({ probeSiteDirect, now: () => clock })
    // Direct takes its time to answer.
    probe.mockImplementation((_url: string) => state.mode === 'direct'
      ? new Promise<boolean>((resolve) => { finishProbe = resolve })
      : Promise.reject(new Error('net::ERR_PROXY_CONNECTION_FAILED')))
    const bypass = createProxyBypass(deps)
    const deadProxy = bypass.recoverFailedRequest(900, 'proxy')
    // Refused once more a moment later, then the probe once switched to direct.
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
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

  it('moves the service the failed request went to, which is not always the selected one', async () => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const probe = vi.fn(async () => true)
    const { deps } = dependencies({ probeSiteDirect, probe, now: () => clock })
    const bypass = createProxyBypass(deps)
    // Switching accounts shows the other service's sign-in while this one is still selected.
    expect(await bypass.recoverFailedRequest(900, 'timeout', 'https://other.example/api/status')).toBe(true)
    expect(probeSiteDirect).toHaveBeenCalledWith('https://other.example/api/status')
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    // The proxy is later checked at that same service.
    clock += systemProxyCheckIntervalMs
    expect(bypass.routeSiteRequest('https://other.example/api/user/login')).not.toBeNull()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledWith('https://other.example/api/status'))
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
    const { deps } = dependencies({ probeSiteDirect: async () => { throw new Error('net::ERR_CONNECTION_TIMED_OUT') } })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(0, 'timeout')).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
  })

  it('does not back off when the direct probe failed only because this computer had no network', async () => {
    let clock = 10_000
    const probeSiteDirect = vi.fn(async () => true)
    probeSiteDirect.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    const { deps } = dependencies({ probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(9_000, 'timeout')).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    // The network is back a few seconds later, and the proxy still does not forward the
    // service: the next timeout probes again at once instead of a minute on.
    clock += 5_000
    expect(await bypass.recoverFailedRequest(clock - 100, 'timeout')).toBe(true)
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
  })

  it('does not leave the service on a proxy that does not forward it after the network blinks', async () => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probe: proxyDoesNotForward, probeSiteDirect, now: () => clock, schedule: heldTimers().schedule })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const route = bypass.routeSiteRequest(siteUrl)!
    // Wi-Fi drops: a request on the direct session fails, and so does the probe it sets off.
    clock = 2_000
    probeSiteDirect.mockResolvedValueOnce(false)
    bypass.siteRouteFailed(route)
    expect(await bypass.recoverFailedRequest(1_900, 'timeout')).toBe(false)
    // Wi-Fi is back, and the proxy still does not forward the service: requests go straight
    // over the direct session instead of timing out on the proxy first.
    clock += siteProbeBackoffMs
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
    expect(modes).toEqual([])
  })
})

describe('proxy bypass after a request failed on the direct session', () => {
  it('looks through the proxy and direct before handing the service back, and goes on direct when only direct answers', async () => {
    let clock = 1_000
    const probe = vi.fn<(url: string) => Promise<boolean>>(proxyDoesNotForward)
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probe, probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const first = bypass.routeSiteRequest(siteUrl)!
    // The connection is cut once; the network itself is fine, and the proxy still does not forward the service.
    clock = 2_000
    bypass.siteRouteFailed(first)
    // While the look runs, requests keep going direct rather than hanging on that proxy.
    expect(bypass.routeSiteRequest(siteUrl)).toBe(first)
    // The request that failed asks next. Direct answered, so a fresh round started after it
    // was sent, and it is sent once more.
    clock = 2_100
    expect(await bypass.recoverFailedRequest(1_500, 'refused')).toBe(true)
    expect(probe).toHaveBeenCalledWith(probeUrl)
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    const second = bypass.routeSiteRequest(siteUrl)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    // A failure from the earlier round that arrives late neither looks again nor undoes the fresh one.
    bypass.siteRouteFailed(first)
    expect(bypass.routeSiteRequest(siteUrl)).toBe(second)
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(modes).toEqual([])
  })

  it('hands the service back once the proxy reaches it again, even while direct still answers the probe', async () => {
    let clock = 1_000
    let proxyAnswers: (answered: boolean) => void = () => undefined
    const probe = vi.fn((_url: string) => new Promise<boolean>((resolve) => { proxyAnswers = resolve }))
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probe, probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    // Direct drops requests that the small probe still gets through, while the proxy works again.
    clock = 2_000
    bypass.siteRouteFailed(bypass.routeSiteRequest(siteUrl)!)
    // Direct answers first: the failed request is sent once more rather than waiting on the proxy.
    expect(await bypass.recoverFailedRequest(1_500, 'refused')).toBe(true)
    expect(bypass.siteDirect()).toBe(true)
    // Then the look through the proxy comes back, and the service follows the system proxy again.
    clock = 2_500
    proxyAnswers(true)
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).toBeNull())
    expect(bypass.siteDirect()).toBe(false)
    // A request that failed on direct before the hand-back is sent again, now through the proxy,
    // without probing direct for it and sending the service direct again.
    expect(await bypass.recoverFailedRequest(2_200, 'timeout')).toBe(true)
    // So is one sent in the very millisecond of the hand-back.
    expect(await bypass.recoverFailedRequest(2_500, 'timeout')).toBe(true)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    // One that times out on the proxy afterwards does go direct: the proxy answered the probe, not that request.
    clock = 13_000
    expect(await bypass.recoverFailedRequest(3_000, 'timeout')).toBe(true)
    expect(probeSiteDirect).toHaveBeenCalledTimes(3)
    expect(bypass.siteDirect()).toBe(true)
    expect(modes).toEqual([])
  })

  it('hands the service back to the system proxy when the proxy reaches it first, and sends the failed request again through it without probing direct for it', async () => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    // The laptop moved to a network that only lets traffic out through the proxy; direct goes nowhere.
    clock = 2_000
    probeSiteDirect.mockImplementationOnce(() => new Promise<boolean>(() => undefined))
    bypass.siteRouteFailed(bypass.routeSiteRequest(siteUrl)!)
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(true)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    expect(modes).toEqual([])
  })

  it('answers the failed request as soon as direct fails, without waiting on the look through the proxy, and hands the service back once that look gets through', async () => {
    let clock = 1_000
    let proxyAnswers: (answered: boolean) => void = () => undefined
    const probe = vi.fn((_url: string) => new Promise<boolean>((resolve) => { proxyAnswers = resolve }))
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probe, probeSiteDirect, now: () => clock, schedule: heldTimers().schedule })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const route = bypass.routeSiteRequest(siteUrl)!
    // A sign-in on the direct session is refused, and so is the direct probe right after; the
    // look through the proxy takes its time.
    clock = 2_000
    probeSiteDirect.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
    bypass.siteRouteFailed(route)
    const stillWaiting = new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 0) })
    expect(await Promise.race([bypass.recoverFailedRequest(1_500, 'refused'), stillWaiting])).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
    // The proxy does reach the service: it takes the service back.
    clock = 3_000
    proxyAnswers(true)
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).toBeNull())
    // A read that was still hanging on direct when that happened is sent again through the proxy.
    expect(await bypass.recoverFailedRequest(2_500, 'timeout')).toBe(true)
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    expect(modes).toEqual([])
  })

  it.each([
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NETWORK_CHANGED',
    // The new network does not resolve names yet.
    'net::ERR_NAME_NOT_RESOLVED',
  ])('keeps the service direct when neither way gets through (%s), and goes on direct once a later look does', async (failure) => {
    let clock = 1_000
    const timers = heldTimers()
    const probe = vi.fn<(url: string) => Promise<boolean>>(proxyDoesNotForward)
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probe, probeSiteDirect, now: () => clock, schedule: timers.schedule })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const route = bypass.routeSiteRequest(siteUrl)!
    // Wi-Fi drops or switches: a request on the direct session fails, and so does the look it sets off.
    clock = 2_000
    probeSiteDirect.mockRejectedValueOnce(new Error(failure))
    bypass.siteRouteFailed(route)
    // That request was sent in this round; sending it again would not help.
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    // Requests keep going direct, not through the proxy first, and another look is lined up.
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
    await vi.waitFor(() => expect(timers.waiting()).toEqual([siteRecheckDelaysMs[0]]))
    // The network is back.
    clock = 5_000
    timers.runNext()
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).not.toBe(route))
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
    expect(probeSiteDirect).toHaveBeenCalledTimes(3)
    expect(timers.waiting()).toEqual([])
    expect(modes).toEqual([])
  })

  it('hands the service back when a later look finds the new network only lets traffic out through the proxy', async () => {
    let clock = 1_000
    const timers = heldTimers()
    const probe = vi.fn<(url: string) => Promise<boolean>>(async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED') })
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probe, probeSiteDirect, now: () => clock, schedule: timers.schedule })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const route = bypass.routeSiteRequest(siteUrl)!
    // Wi-Fi switches: the request on the direct session fails before the new network is up.
    clock = 2_000
    probeSiteDirect.mockRejectedValueOnce(new Error('net::ERR_NETWORK_CHANGED'))
    bypass.siteRouteFailed(route)
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
    await vi.waitFor(() => expect(timers.waiting()).toEqual([siteRecheckDelaysMs[0]]))
    // A few seconds on, the new network is up and lets traffic out only through the proxy.
    clock = 5_000
    probe.mockResolvedValue(true)
    probeSiteDirect.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    timers.runNext()
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).toBeNull())
    expect(timers.waiting()).toEqual([])
  })

  it('stops looking after a few tries while neither way gets through, and starts over at the next failure on the direct session', async () => {
    const clock = 1_000
    const timers = heldTimers()
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probe: proxyDoesNotForward, probeSiteDirect, now: () => clock, schedule: timers.schedule })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const route = bypass.routeSiteRequest(siteUrl)!
    probeSiteDirect.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'))
    bypass.siteRouteFailed(route)
    for (const [attempt, delayMs] of siteRecheckDelaysMs.entries()) {
      await vi.waitFor(() => expect(timers.waiting()).toEqual([delayMs]))
      expect(probeSiteDirect).toHaveBeenCalledTimes(2 + attempt)
      timers.runNext()
    }
    await vi.waitFor(() => expect(probeSiteDirect).toHaveBeenCalledTimes(2 + siteRecheckDelaysMs.length))
    // Waiting on a request that failed in the meantime is waiting on the look under way.
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(timers.waiting()).toEqual([])
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
    // Another failure on the direct session looks at once and lines the later looks up afresh.
    bypass.siteRouteFailed(route)
    await vi.waitFor(() => expect(timers.waiting()).toEqual([siteRecheckDelaysMs[0]]))
    expect(probeSiteDirect).toHaveBeenCalledTimes(3 + siteRecheckDelaysMs.length)
    // A failure while a later look is lined up takes its place rather than adding another.
    bypass.siteRouteFailed(route)
    expect(timers.waiting()).toEqual([])
    await vi.waitFor(() => expect(timers.waiting()).toEqual([siteRecheckDelaysMs[0]]))
    expect(probeSiteDirect).toHaveBeenCalledTimes(4 + siteRecheckDelaysMs.length)
  })

  it('starts the later looks over when another request fails on direct while the last look is still out', async () => {
    const timers = heldTimers()
    let proxyAnswers: (answered: boolean) => void = () => undefined
    const probe = vi.fn<(url: string) => Promise<boolean>>(proxyDoesNotForward)
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probe, probeSiteDirect, now: () => 1_000, schedule: timers.schedule })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const route = bypass.routeSiteRequest(siteUrl)!
    probeSiteDirect.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'))
    bypass.siteRouteFailed(route)
    for (const delayMs of siteRecheckDelaysMs.slice(0, -1)) {
      await vi.waitFor(() => expect(timers.waiting()).toEqual([delayMs]))
      timers.runNext()
    }
    await vi.waitFor(() => expect(timers.waiting()).toEqual([siteRecheckDelaysMs.at(-1)]))
    // The last look: direct fails at once, the look through the proxy is still out when
    // another request fails on the direct session.
    probe.mockImplementationOnce(() => new Promise<boolean>((resolve) => { proxyAnswers = resolve }))
    timers.runNext()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(siteRecheckDelaysMs.length + 1))
    bypass.siteRouteFailed(route)
    proxyAnswers(false)
    await vi.waitFor(() => expect(timers.waiting()).toEqual([siteRecheckDelaysMs[0]]))
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
  })

  it('probes once for several requests that fail on the direct session together', async () => {
    const probe = vi.fn<(url: string) => Promise<boolean>>(proxyDoesNotForward)
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probe, probeSiteDirect })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(0, 'timeout')).toBe(true)
    const route = bypass.routeSiteRequest(siteUrl)!
    bypass.siteRouteFailed(route)
    bypass.siteRouteFailed(route)
    expect(await Promise.all([bypass.recoverFailedRequest(0, 'timeout'), bypass.recoverFailedRequest(0, 'refused')])).toEqual([true, true])
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('still probes direct for another service whose request was stuck on the proxy when this one was handed back', async () => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    // The proxy reaches this service again after a failure on the direct session.
    clock = 2_000
    probeSiteDirect.mockResolvedValueOnce(false)
    bypass.siteRouteFailed(bypass.routeSiteRequest(siteUrl)!)
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).toBeNull())
    // The other service's sign-in, shown while switching accounts, was stuck on the proxy all along.
    expect(await bypass.recoverFailedRequest(1_500, 'timeout', 'https://other.example/api/status')).toBe(true)
    expect(probeSiteDirect).toHaveBeenLastCalledWith('https://other.example/api/status')
  })

  it('waits for a whole-app switch under way before looking at the proxy, which reads as direct only while the switch runs', async () => {
    let clock = 1_000
    let mode = 'system'
    let finishProbe: (reachable: boolean) => void = () => undefined
    const probe = vi.fn(() => new Promise<boolean>((resolve) => { finishProbe = resolve }))
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({
      probe,
      probeSiteDirect,
      now: () => clock,
      resolveProxy: async () => mode === 'direct' ? 'DIRECT' : 'PROXY 127.0.0.1:7890',
      setProxy: async (next) => { mode = next },
    })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    const first = bypass.routeSiteRequest(siteUrl)!
    clock = 2_000
    const switching = bypass.tryBypass()
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    // A request on the direct session fails while the app session is switched over for the test.
    bypass.siteRouteFailed(first)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probeSiteDirect).toHaveBeenCalledTimes(1)
    finishProbe(false)
    expect(await switching).toBe('unreachable')
    // Back on the system proxy, the look goes ahead and the service stays direct; the proxy
    // does not answer for the service.
    await vi.waitFor(() => expect(probeSiteDirect).toHaveBeenCalledTimes(2))
    expect(probe).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).not.toBe(first))
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
  })

  it.each([
    ['the system proxy has been turned off', { resolveProxy: async () => 'DIRECT' }],
    ['acceleration has taken the system proxy over', { accelerationActive: async () => true }],
  ] as const)('hands the service back without probing when %s', async (_case, later) => {
    const probe = vi.fn(async () => true)
    const probeSiteDirect = vi.fn(async () => true)
    const { deps } = dependencies({ probe, probeSiteDirect })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(0, 'timeout')).toBe(true)
    Object.assign(deps, later)
    bypass.siteRouteFailed(bypass.routeSiteRequest(siteUrl)!)
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).toBeNull())
    expect(probeSiteDirect).toHaveBeenCalledTimes(1)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('proxy bypass watching the system proxy while the service goes direct', () => {
  it('checks every five minutes and switches the whole app once the proxy itself is gone', async () => {
    let clock = 1_000
    const { deps, modes, state, probe } = proxyApp({ now: () => clock })
    // The proxy app runs but does not forward the service.
    state.up = true
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    clock += systemProxyCheckIntervalMs - 1
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
    expect(probe).not.toHaveBeenCalled()
    // The proxy app crashed and left the system proxy pointing at nothing.
    clock += 1
    state.up = false
    // This request still goes direct; the check runs alongside it.
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
    await vi.waitFor(() => expect(bypass.active()).toBe(true))
    // The check, the look a moment later, and the probe once switched to direct.
    expect(probe).toHaveBeenCalledTimes(3)
    expect(modes).toEqual(['direct'])
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    expect(bypass.siteDirect()).toBe(false)
  })

  it('changes nothing when the check only caught the proxy app restarting its core', async () => {
    let clock = 1_000
    const timers = heldTimers()
    const { deps, modes, state, probe } = proxyApp({ now: () => clock, schedule: timers.schedule })
    state.up = true
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    // Five minutes on, the check lands just as the proxy app restarts its core for another server.
    clock += systemProxyCheckIntervalMs
    state.up = false
    const route = bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(timers.waiting()).toEqual([proxyRecheckDelayMs]))
    expect(probe).toHaveBeenCalledTimes(1)
    // It is back a moment later.
    state.up = true
    timers.runNext()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(modes).toEqual([])
    expect(bypass.active()).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
  })

  it('keeps the five-minute rhythm when a look after a failure on the direct session starts a fresh round', async () => {
    let clock = 1_000
    const probe = vi.fn<(url: string) => Promise<boolean>>(proxyDoesNotForward)
    const { deps } = dependencies({ probe, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    clock += systemProxyCheckIntervalMs - 60_000
    bypass.siteRouteFailed(bypass.routeSiteRequest(siteUrl)!)
    expect(await bypass.recoverFailedRequest(clock - 100, 'refused')).toBe(true)
    // That look went through the proxy once.
    expect(probe).toHaveBeenCalledTimes(1)
    // Connections cut every few minutes must not keep putting the check off.
    clock += 60_000
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
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

describe('proxy bypass when the proxy app only blinks', () => {
  it('looks again a moment later before switching, and sends the request again through the proxy once it answers', async () => {
    const timers = heldTimers()
    const { deps, modes, logs, state, probe } = proxyApp({ schedule: timers.schedule })
    const bypass = createProxyBypass(deps)
    // The proxy app restarts its core while switching servers, and a balance read is refused.
    const answer = bypass.recoverFailedRequest(900, 'proxy')
    await vi.waitFor(() => expect(timers.waiting()).toEqual([proxyRecheckDelayMs]))
    // Nothing is touched while waiting.
    expect(probe).not.toHaveBeenCalled()
    expect(modes).toEqual([])
    // The core is back by the time it looks again.
    state.up = true
    timers.runNext()
    expect(await answer).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(modes).toEqual([])
    expect(bypass.active()).toBe(false)
    expect(logs).toEqual(['proxy-bypass.proxy-back'])
  })

  it('switches the whole app to direct only once the proxy is still refused a moment later', async () => {
    const timers = heldTimers()
    const { deps, modes, probe } = proxyApp({ schedule: timers.schedule })
    const bypass = createProxyBypass(deps)
    const answer = bypass.recoverFailedRequest(900, 'proxy')
    await vi.waitFor(() => expect(timers.waiting()).toEqual([proxyRecheckDelayMs]))
    expect(modes).toEqual([])
    timers.runNext()
    expect(await answer).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(modes).toEqual(['direct'])
    expect(bypass.active()).toBe(true)
  })

  it('does not try direct a second time when a try made during the wait found direct dead as well', async () => {
    const timers = heldTimers()
    const { deps, modes, state } = proxyApp({ schedule: timers.schedule })
    // The network itself is down: neither the proxy app nor direct gets through.
    state.direct = false
    const bypass = createProxyBypass(deps)
    const answer = bypass.recoverFailedRequest(900, 'proxy')
    await vi.waitFor(() => expect(timers.waiting()).toEqual([proxyRecheckDelayMs]))
    // The customer asks to check the network again while it waits.
    expect(await bypass.tryBypass()).toBe('unreachable')
    timers.runNext()
    expect(await answer).toBe(false)
    expect(modes).toEqual(['direct', 'system'])
  })

  it.each([
    ['times out', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'timeout'],
    ['has its connection cut', new Error('net::ERR_CONNECTION_RESET'), 'refused'],
    ['finds no network', new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
  ] as const)('changes nothing and does not resend when the look a moment later %s', async (_case, error, failure) => {
    const logged: Record<string, unknown>[] = []
    const { deps, modes, probe } = proxyApp({ log: (_level, event, _message, detail) => { logged.push({ event, ...detail }) } })
    probe.mockRejectedValueOnce(error)
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'proxy')).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(modes).toEqual([])
    expect(bypass.active()).toBe(false)
    expect(logged).toEqual([{ event: 'proxy-bypass.proxy-unclear', failure }])
  })

  it('waits for a switch to direct still under way when the moment is up, and resends over direct once it is made', async () => {
    const timers = heldTimers()
    const { deps, modes, state, probe } = proxyApp({ schedule: timers.schedule })
    let finishDirect: (reachable: boolean) => void = () => undefined
    probe.mockImplementation((_url: string) => state.mode === 'direct'
      ? new Promise<boolean>((resolve) => { finishDirect = resolve })
      : Promise.reject(new Error('net::ERR_PROXY_CONNECTION_FAILED')))
    const bypass = createProxyBypass(deps)
    const answer = bypass.recoverFailedRequest(900, 'proxy')
    await vi.waitFor(() => expect(timers.waiting()).toEqual([proxyRecheckDelayMs]))
    // The customer asks to check the network again; that switch is still probing direct when the moment is up.
    const switching = bypass.tryBypass()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    timers.runNext()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The app session is direct for the moment, so a look through it would say nothing about the proxy.
    expect(probe).toHaveBeenCalledTimes(1)
    finishDirect(true)
    expect(await switching).toBe('direct')
    expect(await answer).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(modes).toEqual(['direct'])
  })

  it('waits for a switch to direct that starts while a refused request waits on a look at the direct session, and resends it over direct', async () => {
    const timers = heldTimers()
    const probeSiteDirect = vi.fn<(url: string) => Promise<boolean>>(async () => true)
    const { deps, modes, probe } = proxyApp({ now: () => 1_000, schedule: timers.schedule, probeSiteDirect })
    const held: ((answered: boolean) => void)[] = []
    probe.mockImplementation(() => new Promise<boolean>((resolve) => { held.push(resolve) }))
    const bypass = createProxyBypass(deps)
    // The proxy app first stopped forwarding the service, which went direct on its own.
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    let siteDirectAnswer: (answered: boolean) => void = () => undefined
    probeSiteDirect.mockImplementation(() => new Promise<boolean>((resolve) => { siteDirectAnswer = resolve }))
    // A request on the direct session fails, so both ways get looked at again.
    bypass.siteRouteFailed(bypass.routeSiteRequest(siteUrl)!)
    await vi.waitFor(() => expect(probeSiteDirect).toHaveBeenCalledTimes(2))
    // A request still out through the proxy is refused, and waits for that look.
    const answer = bypass.recoverFailedRequest(950, 'proxy')
    // Meanwhile the customer asks to check the network again, and the app session is switched over for the test.
    const switching = bypass.tryBypass()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    // The look at the direct session ends while that switch is still probing.
    siteDirectAnswer(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    held[1](true)
    expect(await switching).toBe('direct')
    expect(await answer).toBe(true)
    expect(modes).toEqual(['direct'])
    expect(timers.waiting()).toEqual([])
    held[0](false)
  })

  it('looks again once for several requests refused together', async () => {
    const timers = heldTimers()
    const { deps, state, probe } = proxyApp({ schedule: timers.schedule })
    const bypass = createProxyBypass(deps)
    const answers = Promise.all([bypass.recoverFailedRequest(900, 'proxy'), bypass.recoverFailedRequest(910, 'proxy')])
    await vi.waitFor(() => expect(timers.waiting()).toEqual([proxyRecheckDelayMs]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(timers.waiting()).toEqual([proxyRecheckDelayMs])
    state.up = true
    timers.runNext()
    expect(await answers).toEqual([true, true])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no proxy is in use', { resolveProxy: async () => 'DIRECT' }],
    ['acceleration owns the proxy', { accelerationActive: async () => true }],
  ] as const)('answers a refused request at once without looking again when %s', async (_case, overrides) => {
    const timers = heldTimers()
    const { deps, modes, probe } = proxyApp({ schedule: timers.schedule, ...overrides })
    expect(await createProxyBypass(deps).recoverFailedRequest(900, 'proxy')).toBe(false)
    expect(timers.waiting()).toEqual([])
    expect(probe).not.toHaveBeenCalled()
    expect(modes).toEqual([])
  })
})

describe('proxy bypass after the whole app went direct', () => {
  // The proxy app was not running when a request needed it, so the whole app went direct at 1_000.
  async function wentDirect(overrides: Partial<ProxyBypassDependencies> = {}) {
    const clock = { now: 1_000 }
    const app = proxyApp({ now: () => clock.now, ...overrides })
    const bypass = createProxyBypass(app.deps)
    expect(await bypass.recoverFailedRequest(900, 'proxy')).toBe(true)
    expect(bypass.active()).toBe(true)
    return { ...app, bypass, clock }
  }

  it('takes the app back to the system proxy once the proxy app is back, looking only every five minutes alongside requests to the service', async () => {
    const { bypass, clock, modes, logs, state, probeSystemProxy } = await wentDirect()
    // The proxy app is running again, but nobody looks before five minutes are up.
    state.up = true
    clock.now += systemProxyCheckIntervalMs - 1
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    expect(probeSystemProxy).not.toHaveBeenCalled()
    // The request that comes along then still goes over the app session; the look runs beside it.
    clock.now += 1
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
    expect(probeSystemProxy).toHaveBeenCalledWith(probeUrl)
    expect(modes).toEqual(['direct', 'system'])
    expect(logs).toContain('proxy-bypass.direct-ended')
    // Requests to the service follow the system proxy with everything else again.
    expect(bypass.siteDirect()).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
  })

  it('lets the window know once the app is back on the system proxy, and not while it stays direct', async () => {
    const directEnded = vi.fn()
    const { bypass, clock, state, probeSystemProxy } = await wentDirect({ directEnded })
    // Still down at the first look.
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(probeSystemProxy).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(directEnded).not.toHaveBeenCalled()
    // Back at the next one.
    state.up = true
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
    expect(directEnded).toHaveBeenCalledTimes(1)
  })

  it('stays direct while the proxy app is still down, and looks again only after another five minutes', async () => {
    const { bypass, clock, modes, probeSystemProxy } = await wentDirect()
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(probeSystemProxy).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bypass.active()).toBe(true)
    clock.now += systemProxyCheckIntervalMs - 1
    bypass.routeSiteRequest(siteUrl)
    expect(probeSystemProxy).toHaveBeenCalledTimes(1)
    clock.now += 1
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(probeSystemProxy).toHaveBeenCalledTimes(2))
    expect(modes).toEqual(['direct'])
  })

  it.each([
    ['acceleration is running', async (): Promise<boolean> => true],
    ['the acceleration state cannot be read', async (): Promise<boolean> => { throw new Error('helper down') }],
  ] as const)('stays direct while %s, even though the system proxy answers', async (_case, accelerationActive) => {
    const { deps, bypass, clock, modes, state, probeSystemProxy } = await wentDirect()
    // Acceleration took the system proxy over; once it stops, the system proxy points at the dead proxy app again.
    deps.accelerationActive = accelerationActive
    state.up = true
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(probeSystemProxy).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bypass.active()).toBe(true)
    expect(modes).toEqual(['direct'])
  })

  it('looks once when several requests to the service go out while a look is under way', async () => {
    const { bypass, clock, probeSystemProxy } = await wentDirect()
    let answer: (answered: boolean) => void = () => undefined
    probeSystemProxy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve }))
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    bypass.routeSiteRequest(siteUrl)
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    expect(probeSystemProxy).toHaveBeenCalledTimes(1)
    answer(true)
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
  })

  it('stays direct when the app session cannot be switched back, and tries again five minutes on', async () => {
    const { deps, bypass, clock, state, probeSystemProxy } = await wentDirect()
    const setProxy = deps.setProxy
    deps.setProxy = async (mode) => {
      if (mode === 'system') throw new Error('proxy settings are busy')
      await setProxy(mode)
    }
    state.up = true
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(probeSystemProxy).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bypass.active()).toBe(true)
    deps.setProxy = setProxy
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
  })

  it('sends a read that was still out on direct when the app switched back again through the proxy, without moving the service to direct', async () => {
    const probeSiteDirect = vi.fn(async () => true)
    const { bypass, clock, state } = await wentDirect({ probeSiteDirect })
    state.up = true
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
    // A read sent over direct just before the switch back times out afterwards.
    expect(await bypass.recoverFailedRequest(clock.now - 100, 'timeout')).toBe(true)
    expect(probeSiteDirect).not.toHaveBeenCalled()
    expect(bypass.siteDirect()).toBe(false)
    // One that times out on the proxy afterwards moves the service to direct, as before.
    clock.now += 1_000
    expect(await bypass.recoverFailedRequest(clock.now - 100, 'timeout')).toBe(true)
    expect(probeSiteDirect).toHaveBeenCalledTimes(1)
    expect(bypass.siteDirect()).toBe(true)
  })

  it('drops an earlier move of the service to direct once the proxy app is back and reaches it', async () => {
    const clock = { now: 1_000 }
    const { deps, modes, state } = proxyApp({ now: () => clock.now })
    // At first the proxy app ran but did not forward the service, so only the service went direct.
    state.up = true
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    expect(bypass.siteDirect()).toBe(true)
    // Then the proxy app went away, and the whole app went direct.
    state.up = false
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(bypass.active()).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // It is back, and reaches the service this time.
    state.up = true
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
    expect(bypass.siteDirect()).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
    expect(modes).toEqual(['direct', 'system'])
  })

  it('goes direct again when the proxy app goes away after the switch back, and looks for it again five minutes on', async () => {
    const { bypass, clock, modes, state, probeSystemProxy } = await wentDirect()
    state.up = true
    clock.now += systemProxyCheckIntervalMs
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The proxy app is gone again.
    state.up = false
    clock.now += 1_000
    expect(await bypass.recoverFailedRequest(clock.now - 10, 'proxy')).toBe(true)
    expect(bypass.active()).toBe(true)
    expect(modes).toEqual(['direct', 'system', 'direct'])
    clock.now += systemProxyCheckIntervalMs - 1
    bypass.routeSiteRequest(siteUrl)
    expect(probeSystemProxy).toHaveBeenCalledTimes(1)
    state.up = true
    clock.now += 1
    bypass.routeSiteRequest(siteUrl)
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
    expect(modes).toEqual(['direct', 'system', 'direct', 'system'])
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

  it('reports a failure at the network layer on the direct session, and takes the next request where the bypass then says', async () => {
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

describe('site routing as main.ts wires it', () => {
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

  function requestUrl(input: string | URL | Request): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  }

  function routing(overrides: Partial<Parameters<typeof createSiteRouting>[0]> = {}) {
    const modes: string[] = []
    // The app session's proxy forwards everything except the service, where it hangs until
    // the caller gives up. Once the whole app is switched, the session itself goes direct.
    const sessionFetch = vi.fn<typeof fetch>(async (input) => {
      if (modes.at(-1) === 'direct') return new Response('direct')
      if (requestUrl(input).startsWith('https://relay.example/')) throw new DOMException('This operation was aborted', 'AbortError')
      return new Response('through the proxy')
    })
    const siteDirectFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ success: true, message: '', data: status }), {
      headers: { 'Content-Type': 'application/json' },
    }))
    // Only ever follows the system proxy, so it meets the same proxy the app session did before any switch.
    const systemProxyFetch = vi.fn<typeof fetch>(async (input) => {
      if (requestUrl(input).startsWith('https://relay.example/')) throw new DOMException('This operation was aborted', 'AbortError')
      return new Response('through the proxy')
    })
    const wired = createSiteRouting({
      probeUrl: () => probeUrl,
      resolveProxy: async () => 'PROXY 127.0.0.1:7890',
      setProxy: async (mode) => { modes.push(mode) },
      accelerationActive: async () => false,
      sessionFetch,
      siteDirectFetch,
      systemProxyFetch,
      ...overrides,
    })
    return { ...wired, modes, sessionFetch, siteDirectFetch, systemProxyFetch }
  }

  it('resends an account read that timed out on a live proxy over the direct session, and takes AI requests to the same service along', async () => {
    const { bypass, accountFetch, relayFetch, modes, sessionFetch, siteDirectFetch } = routing()
    const client = createNewApiClient({
      baseUrl: 'https://relay.example',
      fetchImpl: accountFetch,
      retryOffProxy: (failure) => bypass.recoverFailedRequest(failure.startedAt, failure.reason),
    })
    await expect(client.getStatus()).resolves.toBeTruthy()
    // One try through the proxy, then the probe and the resent read over the direct session.
    expect(sessionFetch).toHaveBeenCalledTimes(1)
    expect(siteDirectFetch).toHaveBeenCalledTimes(2)
    expect(modes).toEqual([])

    await relayFetch(siteUrl, { method: 'POST' })
    expect(siteDirectFetch).toHaveBeenCalledTimes(3)
    expect(await (await relayFetch('https://github.com/anthropics/claude-plugins-official')).text()).toBe('through the proxy')
  })

  it('keeps the direct session when an AI request is stopped, but hands it back when an account request runs out of time and the proxy reaches the service again', async () => {
    const { bypass, accountFetch, relayFetch, sessionFetch, siteDirectFetch } = routing()
    expect(await bypass.recoverFailedRequest(0, 'timeout')).toBe(true)
    const stopped = new AbortController()
    siteDirectFetch.mockImplementationOnce(async () => {
      stopped.abort()
      throw new DOMException('This operation was aborted', 'AbortError')
    })
    await expect(relayFetch(siteUrl, { method: 'POST', signal: stopped.signal })).rejects.toThrow('aborted')
    // Pressing stop does not even set off a look.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(siteDirectFetch).toHaveBeenCalledTimes(2)
    expect(sessionFetch).not.toHaveBeenCalled()
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()

    const timedOut = new AbortController()
    siteDirectFetch.mockImplementationOnce(async () => {
      timedOut.abort()
      throw new DOMException('This operation was aborted', 'AbortError')
    })
    // The proxy forwards the service again.
    sessionFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(accountFetch(probeUrl, { signal: timedOut.signal })).rejects.toThrow('aborted')
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).toBeNull())
    expect(sessionFetch).toHaveBeenCalledTimes(1)
    expect(sessionFetch).toHaveBeenLastCalledWith(probeUrl, expect.objectContaining({ method: 'GET', redirect: 'manual' }))
  })

  it.each([
    ['the network blinks', [new Error('net::ERR_NETWORK_CHANGED'), new Error('net::ERR_INTERNET_DISCONNECTED')]],
    ['the connection is cut once', [new Error('net::ERR_CONNECTION_RESET')]],
  ] as const)('keeps account reads on the direct session when %s under an AI request, so the next read does not wait on the proxy', async (_case, failures) => {
    const { bypass, accountFetch, relayFetch, sessionFetch, siteDirectFetch } = routing({ schedule: heldTimers().schedule })
    const client = createNewApiClient({
      baseUrl: 'https://relay.example',
      fetchImpl: accountFetch,
      retryOffProxy: (failure) => bypass.recoverFailedRequest(failure.startedAt, failure.reason),
    })
    await expect(client.getStatus()).resolves.toBeTruthy()
    expect(sessionFetch).toHaveBeenCalledTimes(1)
    // The AI request fails on the direct session; when the network blinks, the probe it sets
    // off finds no network either. The look through the proxy hangs on the service as before.
    for (const failure of failures) siteDirectFetch.mockRejectedValueOnce(failure)
    await expect(relayFetch(siteUrl, { method: 'POST' })).rejects.toBe(failures[0])
    await vi.waitFor(() => expect(siteDirectFetch).toHaveBeenCalledTimes(4))
    expect(sessionFetch).toHaveBeenCalledTimes(2)
    expect(sessionFetch).toHaveBeenLastCalledWith(probeUrl, expect.objectContaining({ method: 'GET' }))
    // The network is fine again: the next read goes straight over the direct session.
    await expect(client.getStatus()).resolves.toBeTruthy()
    expect(sessionFetch).toHaveBeenCalledTimes(2)
    expect(siteDirectFetch).toHaveBeenCalledTimes(5)
  })

  it('sends an account read that failed on the direct session again through the proxy once the proxy reaches the service again', async () => {
    const { bypass, accountFetch, sessionFetch, siteDirectFetch } = routing()
    const client = createNewApiClient({
      baseUrl: 'https://relay.example',
      fetchImpl: accountFetch,
      retryOffProxy: (failure) => bypass.recoverFailedRequest(failure.startedAt, failure.reason),
    })
    await expect(client.getStatus()).resolves.toBeTruthy()
    expect(sessionFetch).toHaveBeenCalledTimes(1)
    // The proxy forwards the service again. The next read has its connection reset on the direct
    // session, and direct then takes its time over the probe.
    sessionFetch.mockImplementation(async () => new Response(JSON.stringify({ success: true, message: '', data: status }), {
      headers: { 'Content-Type': 'application/json' },
    }))
    siteDirectFetch.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
    siteDirectFetch.mockImplementationOnce(() => new Promise<Response>(() => undefined))
    await expect(client.getStatus()).resolves.toBeTruthy()
    expect(bypass.siteDirect()).toBe(false)
    // The look through the proxy, then the read sent again through it.
    expect(sessionFetch).toHaveBeenCalledTimes(3)
    expect(siteDirectFetch).toHaveBeenCalledTimes(4)
  })

  it('looks for a dead proxy through the app session, which the diversion never touches', async () => {
    let clock = 1_000
    const { bypass, relayFetch, modes, sessionFetch, siteDirectFetch } = routing({ now: () => clock, schedule: immediately })
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    // The proxy app is gone: the check and the look a moment later are both refused.
    sessionFetch.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    sessionFetch.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    clock += systemProxyCheckIntervalMs
    await relayFetch(siteUrl, { method: 'POST' })
    await vi.waitFor(() => expect(bypass.active()).toBe(true))
    expect(sessionFetch).toHaveBeenCalledWith(probeUrl, expect.objectContaining({ method: 'GET' }))
    expect(modes).toEqual(['direct'])
    // The probe and the AI request: neither check went over the direct session.
    expect(siteDirectFetch).toHaveBeenCalledTimes(2)
  })

  it('looks for the proxy app coming back over a session of its own that follows the system proxy, and takes the app session back to it', async () => {
    let clock = 1_000
    const { bypass, relayFetch, modes, sessionFetch, siteDirectFetch, systemProxyFetch } = routing({ now: () => clock })
    expect(await bypass.tryBypass()).toBe('direct')
    sessionFetch.mockClear()
    // The proxy app is back and reaches the service.
    systemProxyFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))
    clock += systemProxyCheckIntervalMs
    // This AI request still goes over the app session, direct for now; the look runs alongside it.
    expect(await (await relayFetch(siteUrl, { method: 'POST' })).text()).toBe('direct')
    await vi.waitFor(() => expect(bypass.active()).toBe(false))
    expect(systemProxyFetch).toHaveBeenCalledWith(probeUrl, expect.objectContaining({ method: 'GET', redirect: 'manual' }))
    expect(modes).toEqual(['direct', 'system'])
    expect(sessionFetch).toHaveBeenCalledTimes(1)
    expect(siteDirectFetch).not.toHaveBeenCalled()
  })
})

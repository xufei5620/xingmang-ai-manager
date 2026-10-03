import { describe, expect, it, vi } from 'vitest'
import { createNewApiClient } from './new-api-client'
import { automaticBypassCooldownMs, createProxyBypass, createSiteFetch, createSiteRouting, isNetworkSettingsKind, networkSettingsTarget, probeDirectConnection, siteProbeBackoffMs, siteRecheckDelaysMs, systemProxyCheckIntervalMs, type ProxyBypassDependencies } from './proxy-bypass'

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
    expect(bypass.routeSiteRequest(siteUrl)).not.toBeNull()
    // Then the look through the proxy comes back, and the service follows the system proxy again.
    clock = 2_500
    proxyAnswers(true)
    await vi.waitFor(() => expect(bypass.routeSiteRequest(siteUrl)).toBeNull())
    // A request that failed on direct before the hand-back does not send the service direct again.
    expect(await bypass.recoverFailedRequest(2_200, 'timeout')).toBe(false)
    expect(probeSiteDirect).toHaveBeenCalledTimes(2)
    // One that times out on the proxy afterwards does: the proxy answered the probe, not that request.
    clock = 13_000
    expect(await bypass.recoverFailedRequest(3_000, 'timeout')).toBe(true)
    expect(probeSiteDirect).toHaveBeenCalledTimes(3)
    expect(modes).toEqual([])
  })

  it('hands the service back to the system proxy when the proxy reaches it and direct does not, without probing direct again for the failed request', async () => {
    let clock = 1_000
    const probeSiteDirect = vi.fn(async () => true)
    const { deps, modes } = dependencies({ probeSiteDirect, now: () => clock })
    const bypass = createProxyBypass(deps)
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    // The laptop moved to a network that only lets traffic out through the proxy.
    clock = 2_000
    probeSiteDirect.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    bypass.siteRouteFailed(bypass.routeSiteRequest(siteUrl)!)
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
    expect(bypass.routeSiteRequest(siteUrl)).toBeNull()
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
    expect(timers.waiting()).toEqual([siteRecheckDelaysMs[0]])
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
    for (const delayMs of siteRecheckDelaysMs) {
      // Waiting on the request that failed is waiting on the look it set off.
      expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
      expect(timers.waiting()).toEqual([delayMs])
      timers.runNext()
    }
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
    expect(probeSiteDirect).toHaveBeenCalledTimes(2 + siteRecheckDelaysMs.length)
    expect(timers.waiting()).toEqual([])
    expect(bypass.routeSiteRequest(siteUrl)).toBe(route)
    // Another failure on the direct session looks at once and lines the later looks up afresh.
    bypass.siteRouteFailed(route)
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
    expect(probeSiteDirect).toHaveBeenCalledTimes(3 + siteRecheckDelaysMs.length)
    expect(timers.waiting()).toEqual([siteRecheckDelaysMs[0]])
    // A failure while a later look is lined up takes its place rather than adding another.
    bypass.siteRouteFailed(route)
    expect(timers.waiting()).toEqual([])
    expect(await bypass.recoverFailedRequest(1_500, 'timeout')).toBe(false)
    expect(probeSiteDirect).toHaveBeenCalledTimes(4 + siteRecheckDelaysMs.length)
    expect(timers.waiting()).toEqual([siteRecheckDelaysMs[0]])
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
    const wired = createSiteRouting({
      probeUrl: () => probeUrl,
      resolveProxy: async () => 'PROXY 127.0.0.1:7890',
      setProxy: async (mode) => { modes.push(mode) },
      accelerationActive: async () => false,
      sessionFetch,
      siteDirectFetch,
      ...overrides,
    })
    return { ...wired, modes, sessionFetch, siteDirectFetch }
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

  it('looks for a dead proxy through the app session, which the diversion never touches', async () => {
    let clock = 1_000
    const { bypass, relayFetch, modes, sessionFetch, siteDirectFetch } = routing({ now: () => clock })
    expect(await bypass.recoverFailedRequest(900, 'timeout')).toBe(true)
    sessionFetch.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    clock += systemProxyCheckIntervalMs
    await relayFetch(siteUrl, { method: 'POST' })
    await vi.waitFor(() => expect(bypass.active()).toBe(true))
    expect(sessionFetch).toHaveBeenCalledWith(probeUrl, expect.objectContaining({ method: 'GET' }))
    expect(modes).toEqual(['direct'])
    // The probe and the AI request: neither check went over the direct session.
    expect(siteDirectFetch).toHaveBeenCalledTimes(2)
  })
})

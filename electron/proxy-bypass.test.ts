import { describe, expect, it, vi } from 'vitest'
import { createProxyBypass, isNetworkSettingsKind, networkSettingsTarget, probeDirectConnection, type ProxyBypassDependencies } from './proxy-bypass'

const probeUrl = 'https://relay.example/api/status'

function dependencies(overrides: Partial<ProxyBypassDependencies> = {}) {
  const modes: string[] = []
  const deps: ProxyBypassDependencies = {
    probeUrl: () => probeUrl,
    resolveProxy: async () => 'PROXY 127.0.0.1:7890',
    setProxy: async (mode) => { modes.push(mode) },
    probe: async () => true,
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

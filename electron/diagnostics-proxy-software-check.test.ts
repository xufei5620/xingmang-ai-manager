import { describe, expect, it, vi } from 'vitest'
import {
  inspectProxySoftware,
  probeRelayStatus,
  proxySoftwareOutcome,
  proxySoftwareSummaries,
  type ProxySoftwareProbes,
  type RelayReachability,
} from './diagnostics-proxy-software-check'

const url = 'https://xm.solov.cc/api/status'

function probes(overrides: Partial<ProxySoftwareProbes> = {}): ProxySoftwareProbes {
  return {
    accelerationActive: async () => false,
    resolveProxy: async () => 'PROXY 127.0.0.1:7890;DIRECT',
    probeLoopback: async () => true,
    throughProxy: async () => 'ok',
    direct: async () => 'ok',
    ...overrides,
  }
}

function inspect(overrides: Partial<ProxySoftwareProbes> = {}) {
  return inspectProxySoftware(url, probes(overrides), new AbortController().signal)
}

function jsonResponse(): Response {
  return new Response('{"success":true}', { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('probeRelayStatus', () => {
  const signal = new AbortController().signal

  it('counts only a JSON answer as reaching the service', async () => {
    expect(await probeRelayStatus(async () => jsonResponse(), url, signal)).toBe('ok')
    expect(await probeRelayStatus(async () => new Response('<html>portal</html>', { status: 200 }), url, signal)).toBe('failed')
    expect(await probeRelayStatus(async () => new Response('bad gateway', { status: 502 }), url, signal)).toBe('failed')
  })

  it('tells a proxy that cannot be reached apart from other failures', async () => {
    expect(await probeRelayStatus(async () => { throw new Error('net::ERR_PROXY_CONNECTION_FAILED') }, url, signal)).toBe('proxy-down')
    expect(await probeRelayStatus(async () => { throw new Error('net::ERR_CONNECTION_RESET') }, url, signal)).toBe('failed')
  })

  it('asks for JSON without credentials and without following redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse())
    await probeRelayStatus(fetchImpl, url, signal)
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' }))
  })
})

describe('inspectProxySoftware', () => {
  it('reports no proxy for a direct or unreadable answer', async () => {
    expect(await inspect({ resolveProxy: async () => 'DIRECT' })).toEqual({ kind: 'none' })
    expect(await inspect({ resolveProxy: async () => { throw new Error('resolve failed') } })).toEqual({ kind: 'none' })
  })

  it('leaves the acceleration proxy alone without asking about the system setting', async () => {
    const resolveProxy = vi.fn(async () => 'PROXY 127.0.0.1:7890')
    expect(await inspect({ accelerationActive: async () => true, resolveProxy })).toEqual({ kind: 'acceleration' })
    expect(resolveProxy).not.toHaveBeenCalled()
  })

  it('calls a closed local port dead before connecting through it', async () => {
    const throughProxy = vi.fn(async (): Promise<RelayReachability> => 'ok')
    const probeLoopback = vi.fn(async () => false)
    expect(await inspect({ resolveProxy: async () => 'SOCKS5 localhost:1080', probeLoopback, throughProxy })).toEqual({ kind: 'dead', port: 1080 })
    expect(probeLoopback).toHaveBeenCalledWith({ host: 'localhost', port: 1080 })
    expect(throughProxy).not.toHaveBeenCalled()
  })

  it('says the proxy forwards the service when a request through it gets an answer', async () => {
    expect(await inspect()).toEqual({ kind: 'forwarding', port: 7890 })
  })

  it('blames the proxy only when going direct works', async () => {
    expect(await inspect({ throughProxy: async () => 'failed' })).toEqual({ kind: 'blocking', port: 7890 })
    expect(await inspect({ throughProxy: async () => 'failed', direct: async () => 'failed' })).toEqual({ kind: 'unreachable', port: 7890 })
  })

  it('calls a proxy that refuses the connection dead', async () => {
    expect(await inspect({ throughProxy: async () => 'proxy-down' })).toEqual({ kind: 'dead', port: 7890 })
  })

  it('does not probe or echo a proxy on another machine', async () => {
    const probeLoopback = vi.fn(async () => true)
    expect(await inspect({ resolveProxy: async () => 'PROXY proxy.corp.example:8080', probeLoopback, throughProxy: async () => 'failed' }))
      .toEqual({ kind: 'blocking', port: null })
    expect(probeLoopback).not.toHaveBeenCalled()
  })
})

describe('proxySoftwareOutcome', () => {
  it('passes when there is no proxy or the proxy is the acceleration', () => {
    expect(proxySoftwareOutcome({ kind: 'none' }, 'win32')).toMatchObject({ state: 'pass', summary: proxySoftwareSummaries.none })
    expect(proxySoftwareOutcome({ kind: 'acceleration' }, 'darwin')).toMatchObject({ state: 'pass', summary: proxySoftwareSummaries.acceleration })
  })

  it('passes when the proxy forwards the service', () => {
    expect(proxySoftwareOutcome({ kind: 'forwarding', port: 7890 }, 'win32')).toEqual({
      state: 'pass',
      summary: '已开启其他代理软件（本机 7890 端口），星芒可通过该代理连接',
      details: { systemProxy: 'forwarding', proxyPort: 7890 },
    })
    expect(proxySoftwareOutcome({ kind: 'forwarding', port: null }, 'win32').summary).toBe('已开启代理（使用其他机器上的代理），星芒可通过该代理连接')
  })

  it('does not blame the proxy when nothing reaches the service', () => {
    expect(proxySoftwareOutcome({ kind: 'unreachable', port: 7890 }, 'win32')).toMatchObject({
      state: 'pass',
      summary: '已开启其他代理软件（本机 7890 端口）。当前通过该代理或直接连接均无法连接星芒，请先查看上方「星芒 AI 网络」一项。',
    })
  })

  it('warns that the tools following the system proxy will fail when it blocks the service', () => {
    const result = proxySoftwareOutcome({ kind: 'blocking', port: 7890 }, 'win32')
    expect(result).toEqual({
      state: 'warn',
      summary: '已开启其他代理软件（本机 7890 端口），但通过该代理无法连接星芒。星芒将自动改为直接连接，无需处理；'
        + 'Codex（命令行和桌面端）、Claude 桌面端会使用该代理，将无法连接。使用这几个工具时，请在代理软件中将星芒设为直连，或先退出代理软件。',
      details: { systemProxy: 'blocking', proxyPort: 7890, fix: 'open-proxy-settings' },
    })
    expect(proxySoftwareOutcome({ kind: 'blocking', port: null }, 'darwin').details).toEqual({ systemProxy: 'blocking', proxyHost: 'remote', fix: 'open-proxy-settings' })
  })

  it('warns about a proxy that is set but not running and offers the settings page', () => {
    expect(proxySoftwareOutcome({ kind: 'dead', port: 7890 }, 'darwin')).toEqual({
      state: 'warn',
      summary: '系统设置中仍开启着代理（本机 7890 端口），但该代理软件未在运行。星芒将自动改为直接连接；'
        + 'Codex（命令行和桌面端）、Claude 桌面端仍会尝试使用该代理，将无法连接。请打开该代理软件，或点击「打开系统代理设置」关闭代理。',
      details: { systemProxy: 'dead', proxyPort: 7890, fix: 'open-proxy-settings' },
    })
    expect(proxySoftwareOutcome({ kind: 'dead', port: null }, 'win32').summary).toMatch(/^系统设置中仍开启着代理（使用其他机器上的代理），但该代理无法连接。/)
  })

  it('offers no settings button where there is no settings page to open', () => {
    const result = proxySoftwareOutcome({ kind: 'dead', port: 7890 }, 'linux')
    expect(result.summary).toContain('或在系统设置中关闭代理。')
    expect(result.details?.fix).toBeUndefined()
  })
})

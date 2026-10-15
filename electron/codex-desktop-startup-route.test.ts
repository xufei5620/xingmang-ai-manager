import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexDesktopAccelerationOutcome } from './codex-desktop-acceleration'
import {
  buildCodexStartupHostResolverRules,
  buildCodexStartupProxyServer,
  buildCodexStartupTunnelUrl,
  chromiumProxyResultIsDirect,
  createCodexDesktopStartupRouteCoordinator,
  formatCodexStartupMacArgument,
  formatCodexStartupMacArguments,
  formatCodexStartupWindowsArgument,
  openCodexStartupProxyBridge,
  openCodexStartupTunnel,
  preflightCodexStartupTunnel,
  probeCodexStartupHostThroughProxy,
  type CodexDesktopStartupRouteOptions,
  type CodexStartupProxyBridge,
  type CodexStartupTunnel,
  type CodexStartupTunnelConnect,
  type CodexStartupTunnelSocket,
} from './codex-desktop-startup-route'

const ticket = 'T'.repeat(48)
const primaryUrl = 'wss://xm.test.internal/api/xingmang-tunnel/v1/ab-chatgpt'
const directUrl = 'wss://xm-direct.test.internal/api/xingmang-tunnel/v1/ab-chatgpt'

class FakeTunnelSocket implements CodexStartupTunnelSocket {
  binaryType = 'blob'
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  readonly sent: Buffer[] = []
  closed = false

  constructor(readonly url: string, readonly headers: Readonly<Record<string, string>>) {}

  send(data: Uint8Array): void {
    this.sent.push(Buffer.from(data))
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.onopen?.({})
  }

  fail(): void {
    this.onerror?.({})
  }

  receive(data: unknown): void {
    this.onmessage?.({ data })
  }

  remoteClose(): void {
    this.onclose?.({})
  }
}

function fakeConnector(onConnect: (socket: FakeTunnelSocket) => void = () => undefined) {
  const sockets: FakeTunnelSocket[] = []
  const connect: CodexStartupTunnelConnect = (url, headers) => {
    const socket = new FakeTunnelSocket(url, headers)
    sockets.push(socket)
    onConnect(socket)
    return socket
  }
  return { connect, sockets }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was never met')
}

const openTunnels: CodexStartupTunnel[] = []
const openClients: net.Socket[] = []

afterEach(() => {
  for (const tunnel of openTunnels.splice(0)) tunnel.close()
  for (const client of openClients.splice(0)) client.destroy()
})

async function startTunnel(options: Partial<Parameters<typeof openCodexStartupTunnel>[0]> & { connect: CodexStartupTunnelConnect }) {
  const tunnel = await openCodexStartupTunnel({ urls: [primaryUrl], ticket, ...options })
  openTunnels.push(tunnel)
  return tunnel
}

function connectClient(port: number) {
  const client = net.connect({ host: '127.0.0.1', port })
  openClients.push(client)
  const received: Buffer[] = []
  let ended = false
  client.on('data', (chunk: Buffer) => received.push(chunk))
  client.on('close', () => { ended = true })
  client.on('error', () => undefined)
  return {
    client,
    received: () => Buffer.concat(received).toString('utf8'),
    ended: () => ended,
    connected: new Promise<void>((resolve) => client.once('connect', () => resolve())),
  }
}

describe('codex startup launch arguments', () => {
  it('maps only the Codex config host to a loopback port', () => {
    expect(buildCodexStartupHostResolverRules(43_210)).toBe('MAP ab.chatgpt.com 127.0.0.1:43210')
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => buildCodexStartupHostResolverRules(port)).toThrow('端口无效')
    }
  })

  it('quotes the rule for the Windows activation command line and passes it bare to macOS open', () => {
    const rules = buildCodexStartupHostResolverRules(1)
    expect(formatCodexStartupWindowsArgument(rules)).toBe('--host-resolver-rules="MAP ab.chatgpt.com 127.0.0.1:1"')
    expect(formatCodexStartupMacArgument(rules)).toBe('--host-resolver-rules=MAP ab.chatgpt.com 127.0.0.1:1')
  })

  it.each([
    'MAP ab.chatgpt.com 127.0.0.1:1" --remote-debugging-port="9222',
    'MAP * 127.0.0.1:1',
    'MAP chatgpt.com 127.0.0.1:1',
    'MAP ab.chatgpt.com 10.0.0.1:443',
    '',
  ])('refuses to format anything but the fixed loopback rule %#', (rules) => {
    expect(() => formatCodexStartupWindowsArgument(rules)).toThrow('启动参数无效')
    expect(() => formatCodexStartupMacArgument(rules)).toThrow('启动参数无效')
  })

  it('builds the tunnel address only from an exact https site origin', () => {
    expect(buildCodexStartupTunnelUrl('https://xm.solov.cc')).toBe('wss://xm.solov.cc/api/xingmang-tunnel/v1/ab-chatgpt')
    expect(buildCodexStartupTunnelUrl('http://xm.solov.cc')).toBeNull()
    expect(buildCodexStartupTunnelUrl('https://xm.solov.cc/sub')).toBeNull()
    expect(buildCodexStartupTunnelUrl('https://user:pass@xm.solov.cc')).toBeNull()
    expect(buildCodexStartupTunnelUrl('not a url')).toBeNull()
  })

  it('treats only an unproxied first hop as direct', () => {
    expect(chromiumProxyResultIsDirect('DIRECT')).toBe(true)
    expect(chromiumProxyResultIsDirect('direct')).toBe(true)
    expect(chromiumProxyResultIsDirect('')).toBe(true)
    expect(chromiumProxyResultIsDirect('PROXY 127.0.0.1:7890; DIRECT')).toBe(false)
    expect(chromiumProxyResultIsDirect('SOCKS5 127.0.0.1:7891')).toBe(false)
  })

  it('hands the customer proxy to Codex only when it is a plain proxy on this computer', () => {
    expect(buildCodexStartupProxyServer('PROXY 127.0.0.1:7890; DIRECT')).toBe('http://127.0.0.1:7890,direct://')
    expect(buildCodexStartupProxyServer('HTTPS localhost:8443')).toBe('https://localhost:8443,direct://')
    // Chromium reads a bare SOCKS as version 4.
    expect(buildCodexStartupProxyServer('SOCKS 127.0.0.1:1080')).toBe('socks4://127.0.0.1:1080,direct://')
    expect(buildCodexStartupProxyServer('socks5 [::1]:1080')).toBe('socks5://[::1]:1080,direct://')
    for (const result of [
      'DIRECT',
      '',
      'PROXY 10.0.0.8:3128',
      'PROXY proxy.corp.example:8080',
      'PROXY user:pass@127.0.0.1:7890',
      'PROXY 127.0.0.1:0',
      'PROXY 127.0.0.1:70000',
      'PROXY 127.0.0.1',
      'QUIC 127.0.0.1:443',
      'PROXY 127.0.0.1:7890 --remote-debugging-port=9222',
      `PROXY 127.0.0.1:7890;${'x'.repeat(2_100)}`,
    ]) {
      expect(buildCodexStartupProxyServer(result), result.slice(0, 60)).toBeNull()
    }
  })

  it('adds the customer proxy and the bypass only for the own-proxy bridge on macOS', () => {
    const rules = buildCodexStartupHostResolverRules(43_210)
    expect(formatCodexStartupMacArguments({ kind: 'none' })).toEqual([])
    expect(formatCodexStartupMacArguments({ kind: 'none', ownProxyBlocked: true })).toEqual([])
    expect(formatCodexStartupMacArguments({ kind: 'fast-fail', hostResolverRules: rules }))
      .toEqual(['--host-resolver-rules=MAP ab.chatgpt.com 127.0.0.1:43210'])
    const bridge = {
      kind: 'own-proxy-bridge' as const,
      hostResolverRules: rules,
      proxyServer: 'http://127.0.0.1:7890,direct://',
      release: () => undefined,
      confirmUse: async () => true,
    }
    expect(formatCodexStartupMacArguments(bridge)).toEqual([
      '--host-resolver-rules=MAP ab.chatgpt.com 127.0.0.1:43210',
      '--proxy-server=http://127.0.0.1:7890,direct://',
      '--proxy-bypass-list=ab.chatgpt.com',
    ])
    for (const proxyServer of ['http://10.0.0.8:3128,direct://', 'http://127.0.0.1:7890', 'http://127.0.0.1:7890,direct:// --x']) {
      expect(() => formatCodexStartupMacArguments({ ...bridge, proxyServer })).toThrow('启动参数无效')
    }
  })
})

describe('probeCodexStartupHostThroughProxy', () => {
  function responding(status: number) {
    return vi.fn<typeof fetch>(async () => new Response(null, { status }))
  }

  it('sends one credential-free HEAD that does not follow redirects', async () => {
    const fetchImpl = responding(404)

    await expect(probeCodexStartupHostThroughProxy(fetchImpl)).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('https://ab.chatgpt.com/', expect.objectContaining({ method: 'HEAD', redirect: 'manual' }))
    const init = fetchImpl.mock.calls[0][1]
    expect(init?.headers).toBeUndefined()
    expect(init?.body).toBeUndefined()
  })

  it('counts a region refusal and a dead route as blocked, and any other answer as reachable', async () => {
    await expect(probeCodexStartupHostThroughProxy(responding(200))).resolves.toBe(true)
    await expect(probeCodexStartupHostThroughProxy(responding(503))).resolves.toBe(true)
    await expect(probeCodexStartupHostThroughProxy(responding(403))).resolves.toBe(false)
    await expect(probeCodexStartupHostThroughProxy(responding(451))).resolves.toBe(false)
    await expect(probeCodexStartupHostThroughProxy(vi.fn<typeof fetch>(async () => { throw new TypeError('net::ERR_TUNNEL_CONNECTION_FAILED') }))).resolves.toBe(false)
    // Electron refuses a redirect it was told not to follow: the far end still answered.
    await expect(probeCodexStartupHostThroughProxy(vi.fn<typeof fetch>(async () => { throw new TypeError('Redirect was cancelled') }))).resolves.toBe(true)
  })

  it('gives up on a route that never answers', async () => {
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))

    await expect(probeCodexStartupHostThroughProxy(hanging, 20)).resolves.toBe(false)
  })
})

describe('preflightCodexStartupTunnel', () => {
  it('returns the first line that completes the handshake and presents the ticket as a bearer token', async () => {
    const { connect, sockets } = fakeConnector((socket) => {
      queueMicrotask(() => (socket.url === primaryUrl ? socket.fail() : socket.open()))
    })

    await expect(preflightCodexStartupTunnel([primaryUrl, directUrl], ticket, { connect })).resolves.toBe(directUrl)

    expect(sockets.map((socket) => socket.url)).toEqual([primaryUrl, directUrl])
    expect(sockets[1].headers).toEqual({ Authorization: `Bearer ${ticket}` })
    expect(sockets.every((socket) => socket.closed && socket.sent.length === 0)).toBe(true)
  })

  it('gives up on a line that never answers and on a connector that throws', async () => {
    const { connect } = fakeConnector()
    await expect(preflightCodexStartupTunnel([primaryUrl], ticket, { connect, timeoutMs: 20 })).resolves.toBeNull()

    const throwing: CodexStartupTunnelConnect = () => { throw new Error('bad url') }
    await expect(preflightCodexStartupTunnel([primaryUrl, directUrl], ticket, { connect: throwing })).resolves.toBeNull()
  })
})

describe('openCodexStartupTunnel', () => {
  it('relays bytes both ways and holds early client bytes until the tunnel is open', async () => {
    const { connect, sockets } = fakeConnector()
    const tunnel = await startTunnel({ connect })
    const local = connectClient(tunnel.port)
    await local.connected
    await new Promise<void>((resolve) => local.client.write('client-hello', () => resolve()))
    await waitFor(() => sockets.length === 1)
    // Give the loopback write time to land in the pending buffer.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sockets[0].sent).toEqual([])
    expect(sockets[0].binaryType).toBe('arraybuffer')
    expect(sockets[0].headers).toEqual({ Authorization: `Bearer ${ticket}` })

    sockets[0].open()
    await waitFor(() => Buffer.concat(sockets[0].sent).toString('utf8') === 'client-hello')

    sockets[0].receive(new TextEncoder().encode('server-hello').buffer)
    await waitFor(() => local.received() === 'server-hello')

    local.client.write('more')
    await waitFor(() => Buffer.concat(sockets[0].sent).toString('utf8') === 'client-hellomore')

    // The last reply bytes must still reach Codex when the server closes right after sending them.
    sockets[0].receive(new TextEncoder().encode('-bye').buffer)
    sockets[0].remoteClose()
    await waitFor(() => local.ended())
    expect(local.received()).toBe('server-hello-bye')
    expect(sockets[0].closed).toBe(true)
  })

  it('falls through to the next line when one fails before opening', async () => {
    const { connect, sockets } = fakeConnector((socket) => {
      queueMicrotask(() => (socket.url === primaryUrl ? socket.fail() : socket.open()))
    })
    const tunnel = await startTunnel({ connect, urls: [primaryUrl, directUrl] })
    const local = connectClient(tunnel.port)
    await local.connected
    await waitFor(() => sockets.length === 2)
    expect(sockets[0].closed).toBe(true)
    expect(sockets[1].url).toBe(directUrl)
    local.client.write('x')
    await waitFor(() => sockets[1].sent.length === 1)
  })

  it('drops the connection when every line fails or the server answers with text', async () => {
    const failing = fakeConnector((socket) => queueMicrotask(() => socket.fail()))
    const first = await startTunnel({ connect: failing.connect, urls: [primaryUrl, directUrl] })
    const lost = connectClient(first.port)
    await waitFor(() => lost.ended())

    const texting = fakeConnector((socket) => queueMicrotask(() => socket.open()))
    const second = await startTunnel({ connect: texting.connect })
    const confused = connectClient(second.port)
    await waitFor(() => texting.sockets.length === 1)
    await tick()
    texting.sockets[0].receive('not bytes')
    await waitFor(() => confused.ended())
    expect(texting.sockets[0].closed).toBe(true)
  })

  it('cuts a connection that goes over its byte budget', async () => {
    const { connect, sockets } = fakeConnector((socket) => queueMicrotask(() => socket.open()))
    const tunnel = await startTunnel({ connect, maxBytesPerConnection: 8 })
    const local = connectClient(tunnel.port)
    await waitFor(() => sockets.length === 1)
    await tick()
    sockets[0].receive(new Uint8Array(16))
    await waitFor(() => local.ended())
    expect(local.received()).toBe('')
  })

  it('cuts a connection whose early bytes overflow the pending buffer', async () => {
    const { connect, sockets } = fakeConnector()
    const tunnel = await startTunnel({ connect, maxPendingBytes: 4 })
    const local = connectClient(tunnel.port)
    await local.connected
    local.client.write('too many bytes')
    await waitFor(() => local.ended())
    expect(sockets[0]?.sent ?? []).toEqual([])
  })

  it('refuses connections beyond the limit', async () => {
    const { connect, sockets } = fakeConnector()
    const tunnel = await startTunnel({ connect, maxConnections: 1 })
    const first = connectClient(tunnel.port)
    await waitFor(() => sockets.length === 1)
    const second = connectClient(tunnel.port)
    await waitFor(() => second.ended())
    expect(sockets).toHaveLength(1)
    expect(first.ended()).toBe(false)
  })

  it('closes everything when the tunnel is closed or its lifetime ends', async () => {
    const { connect, sockets } = fakeConnector((socket) => queueMicrotask(() => socket.open()))
    const tunnel = await startTunnel({ connect })
    const local = connectClient(tunnel.port)
    await waitFor(() => sockets.length === 1)
    tunnel.close()
    await waitFor(() => local.ended())
    expect(sockets[0].closed).toBe(true)
    const late = connectClient(tunnel.port)
    await waitFor(() => late.ended())

    const expiring = await startTunnel({ connect, lifetimeMs: 20 })
    const stale = connectClient(expiring.port)
    await waitFor(() => stale.ended())
  })
})

const openBridges: CodexStartupProxyBridge[] = []
const fakeProxies: net.Server[] = []

afterEach(() => {
  for (const bridge of openBridges.splice(0)) bridge.close()
  for (const server of fakeProxies.splice(0)) server.close()
})

/**
 * Stands in for the acceleration core's loopback HTTP proxy. It answers the
 * CONNECT with `reply`, then plays the far end: anything Codex sends comes
 * back prefixed with "echo:".
 */
async function startFakeConnectProxy(reply = 'HTTP/1.1 200 Connection established\r\n\r\n') {
  const requests: string[] = []
  const sockets: net.Socket[] = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    socket.on('error', () => undefined)
    let buffered = Buffer.alloc(0)
    let tunnelled = false
    socket.on('data', (chunk: Buffer) => {
      if (tunnelled) {
        socket.write(Buffer.concat([Buffer.from('echo:'), chunk]))
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      requests.push(buffered.subarray(0, end + 4).toString('latin1'))
      const rest = buffered.subarray(end + 4)
      socket.write(reply)
      if (!reply.startsWith('HTTP/1.1 200')) { socket.end(); return }
      tunnelled = true
      if (rest.length) socket.write(Buffer.concat([Buffer.from('echo:'), rest]))
    })
  })
  fakeProxies.push(server)
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  return { port, requests, sockets }
}

async function startBridge(options: Parameters<typeof openCodexStartupProxyBridge>[0]) {
  const bridge = await openCodexStartupProxyBridge(options)
  openBridges.push(bridge)
  return bridge
}

describe('openCodexStartupProxyBridge', () => {
  it('asks the loopback route for the fixed config host and relays bytes both ways', async () => {
    const proxy = await startFakeConnectProxy()
    const bridge = await startBridge({ proxyPort: proxy.port })
    expect(bridge.used()).toBe(false)
    expect(bridge.connections()).toBe(0)

    const local = connectClient(bridge.port)
    await local.connected
    await waitFor(() => bridge.connections() === 1)
    // Codex speaks first (TLS ClientHello); those bytes wait for the CONNECT answer.
    local.client.write('client-hello')
    await waitFor(() => local.received() === 'echo:client-hello')

    expect(proxy.requests).toEqual(['CONNECT ab.chatgpt.com:443 HTTP/1.1\r\nHost: ab.chatgpt.com:443\r\n\r\n'])
    expect(bridge.used()).toBe(true)
    await expect(bridge.waitForUse(1_000)).resolves.toBe(true)

    local.client.write('more')
    await waitFor(() => local.received() === 'echo:client-helloecho:more')
  })

  it('reports the bridge as used only once bytes come back from the far end', async () => {
    const proxy = await startFakeConnectProxy()
    const bridge = await startBridge({ proxyPort: proxy.port })
    const waiting = bridge.waitForUse(5_000)

    const local = connectClient(bridge.port)
    await local.connected
    await waitFor(() => proxy.requests.length === 1)
    expect(bridge.used()).toBe(false)

    local.client.write('x')
    await expect(waiting).resolves.toBe(true)
  })

  it('drops the connection when the route refuses the CONNECT', async () => {
    const proxy = await startFakeConnectProxy('HTTP/1.1 403 Forbidden\r\n\r\n')
    const bridge = await startBridge({ proxyPort: proxy.port })

    const local = connectClient(bridge.port)
    await local.connected
    local.client.write('client-hello')
    await waitFor(() => local.ended())

    expect(local.received()).toBe('')
    expect(bridge.used()).toBe(false)
    expect(bridge.connections()).toBe(1)
  })

  it('drops the connection when nothing listens on the route port', async () => {
    const proxy = await startFakeConnectProxy()
    await new Promise<void>((resolve) => fakeProxies.pop()!.close(() => resolve()))
    const bridge = await startBridge({ proxyPort: proxy.port })

    const local = connectClient(bridge.port)
    await waitFor(() => local.ended())
    expect(bridge.used()).toBe(false)
  })

  it('cuts a connection whose early bytes overflow the pending buffer', async () => {
    // A route that never answers keeps every early byte pending.
    const silent = net.createServer((socket) => { socket.on('error', () => undefined) })
    fakeProxies.push(silent)
    await new Promise<void>((resolve) => silent.listen({ host: '127.0.0.1', port: 0 }, () => resolve()))
    const bridge = await startBridge({ proxyPort: (silent.address() as net.AddressInfo).port, maxPendingBytes: 8 })

    const local = connectClient(bridge.port)
    await local.connected
    local.client.write('0123456789')
    await waitFor(() => local.ended())
  })

  it('refuses connections beyond the limit', async () => {
    const proxy = await startFakeConnectProxy()
    const bridge = await startBridge({ proxyPort: proxy.port, maxConnections: 1 })

    const first = connectClient(bridge.port)
    await first.connected
    const second = connectClient(bridge.port)
    await waitFor(() => second.ended())
    expect(first.ended()).toBe(false)
  })

  it('tells an explicit close apart from the lifetime running out', async () => {
    const proxy = await startFakeConnectProxy()
    const closedEarly = await startBridge({ proxyPort: proxy.port })
    const waiting = closedEarly.waitForUse(5_000)
    closedEarly.close()
    await expect(closedEarly.closed).resolves.toEqual({ expired: false })
    await expect(waiting).resolves.toBe(false)

    const expiring = await startBridge({ proxyPort: proxy.port, lifetimeMs: 20 })
    const stale = connectClient(expiring.port)
    await expect(expiring.closed).resolves.toEqual({ expired: true })
    await waitFor(() => stale.ended())
    await expect(expiring.waitForUse(1_000)).resolves.toBe(false)
  })

  it('times out waiting for use without closing the bridge', async () => {
    const proxy = await startFakeConnectProxy()
    const bridge = await startBridge({ proxyPort: proxy.port })

    await expect(bridge.waitForUse(20)).resolves.toBe(false)
    const local = connectClient(bridge.port)
    await local.connected
    local.client.write('late')
    await waitFor(() => local.received() === 'echo:late')
  })

  it('refuses an invalid route port', async () => {
    for (const proxyPort of [0, 65_536, 1.5]) {
      await expect(openCodexStartupProxyBridge({ proxyPort })).rejects.toThrow('端口无效')
    }
  })
})

function ticketOf(seconds = 120) {
  return { ticket, expiresInSeconds: seconds }
}

function coordinatorFixture(overrides: Partial<CodexDesktopStartupRouteOptions> = {}) {
  const tunnelClose = vi.fn()
  const openTunnel = vi.fn(async () => ({ port: 43_210, close: tunnelClose }))
  const ensureAccelerated = vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'connected' }))
  const issueTicket = vi.fn(async () => ticketOf())
  const resolveSystemProxy = vi.fn(async () => 'DIRECT')
  const probeDirect = vi.fn(async () => false)
  const log = vi.fn()
  const { connect, sockets } = fakeConnector((socket) => queueMicrotask(() => socket.open()))
  const options: CodexDesktopStartupRouteOptions = {
    launchArgumentsSupported: true,
    fastFailSupported: true,
    onlyNeededAtStartup: () => true,
    issueTicket,
    tunnelUrls: () => [primaryUrl, directUrl],
    ensureAccelerated,
    resolveSystemProxy,
    probeDirect,
    connect,
    openTunnel,
    log,
    ...overrides,
  }
  const coordinator = createCodexDesktopStartupRouteCoordinator(options)
  return { coordinator, openTunnel, tunnelClose, ensureAccelerated, issueTicket, resolveSystemProxy, probeDirect, log, sockets }
}

describe('createCodexDesktopStartupRouteCoordinator', () => {
  it('routes the startup request through the tunnel without touching acceleration', async () => {
    const f = coordinatorFixture({ issueTicket: vi.fn(async () => ticketOf(90)) })

    const route = await f.coordinator.prepare({ launchArgumentsUsable: true })

    expect(route).toMatchObject({ kind: 'tunnel', hostResolverRules: 'MAP ab.chatgpt.com 127.0.0.1:43210' })
    expect(f.ensureAccelerated).not.toHaveBeenCalled()
    expect(f.openTunnel).toHaveBeenCalledWith(expect.objectContaining({
      urls: [primaryUrl, directUrl], ticket, lifetimeMs: 90_000,
    }))
    // The ticket is a bearer credential: it reaches the tunnel and nothing else.
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(ticket)

    expect(f.openTunnel).toHaveBeenCalledWith(expect.objectContaining({ maxConnections: 7 }))

    if (route.kind !== 'tunnel') throw new Error('expected a tunnel route')
    // An activation error does not prove Codex never started with the
    // argument, so the fallback adds acceleration and leaves the tunnel up.
    await route.fallback(new Error('激活超时'))
    expect(f.tunnelClose).not.toHaveBeenCalled()
    expect(f.ensureAccelerated).toHaveBeenCalledTimes(1)
    expect(f.log).toHaveBeenCalledWith('info', 'codex-desktop.startup-route.fallback', expect.any(String), { cause: '激活超时' })
    route.release()
    expect(f.tunnelClose).toHaveBeenCalledTimes(1)
  })

  it('puts the line that passed the preflight first', async () => {
    const f = coordinatorFixture({
      connect: fakeConnector((socket) => queueMicrotask(() => (socket.url === primaryUrl ? socket.fail() : socket.open()))).connect,
    })

    await f.coordinator.prepare({ launchArgumentsUsable: true })

    expect(f.openTunnel).toHaveBeenCalledWith(expect.objectContaining({ urls: [directUrl, primaryUrl] }))
  })

  it('only accelerates when the launch cannot carry arguments or the account needs ChatGPT all along', async () => {
    for (const [context, overrides] of [
      [{ launchArgumentsUsable: false }, {}],
      [{ launchArgumentsUsable: true }, { launchArgumentsSupported: false }],
      [{ launchArgumentsUsable: true }, { onlyNeededAtStartup: () => false }],
      [{ launchArgumentsUsable: true }, { onlyNeededAtStartup: () => { throw new Error('读不到配置') } }],
    ] as const) {
      const f = coordinatorFixture(overrides)
      await expect(f.coordinator.prepare(context)).resolves.toEqual({ kind: 'none' })
      expect(f.ensureAccelerated).toHaveBeenCalledTimes(1)
      expect(f.issueTicket).not.toHaveBeenCalled()
    }
  })

  it('falls back to acceleration when the service is not deployed, the handshake fails or the port cannot open', async () => {
    const cases: Partial<CodexDesktopStartupRouteOptions>[] = [
      { issueTicket: vi.fn(async () => { throw new Error('Codex 中文启动凭证失败，服务返回 HTTP 404') }) },
      { connect: fakeConnector((socket) => queueMicrotask(() => socket.fail())).connect },
      { tunnelUrls: () => [] },
      { openTunnel: vi.fn(async () => { throw new Error('EADDRINUSE') }) },
    ]
    for (const overrides of cases) {
      const f = coordinatorFixture(overrides)
      await expect(f.coordinator.prepare({ launchArgumentsUsable: true })).resolves.toEqual({ kind: 'none' })
      expect(f.ensureAccelerated).toHaveBeenCalledTimes(1)
      expect(f.probeDirect).not.toHaveBeenCalled()
    }
  })

  it('does not wait on a ticket request that hangs', async () => {
    const f = coordinatorFixture({ issueTicket: () => new Promise(() => undefined), ticketTimeoutMs: 20 })

    await expect(f.coordinator.prepare({ launchArgumentsUsable: true })).resolves.toEqual({ kind: 'none' })
    expect(f.ensureAccelerated).toHaveBeenCalledTimes(1)
  })

  it('fails the startup request fast only when acceleration was skipped and this computer has no route of its own', async () => {
    const f = coordinatorFixture({
      issueTicket: vi.fn(async () => { throw new Error('请先登录星芒账号') }),
      ensureAccelerated: vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'skipped', reason: 'no-account' })),
    })

    await expect(f.coordinator.prepare({ launchArgumentsUsable: true }))
      .resolves.toEqual({ kind: 'fast-fail', hostResolverRules: 'MAP ab.chatgpt.com 127.0.0.1:1' })
    expect(f.resolveSystemProxy).toHaveBeenCalledWith('https://ab.chatgpt.com/')
    expect(f.probeDirect).toHaveBeenCalledTimes(1)
  })

  it('keeps the old behaviour for anyone who may still reach the config host', async () => {
    const skipped = vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'skipped', reason: 'connect-failed' }))
    const noTicket = vi.fn(async () => { throw new Error('请先登录星芒账号') })
    const cases: [string, Partial<CodexDesktopStartupRouteOptions>][] = [
      // 自己开着代理（含 TUN 以外的系统代理）的客户本来就拿得到中文。
      ['system proxy', { resolveSystemProxy: vi.fn(async () => 'PROXY 127.0.0.1:7890; DIRECT') }],
      ['proxy unknown', { resolveSystemProxy: vi.fn(async () => { throw new Error('session gone') }) }],
      // TUN 模式的梯子不改系统代理，只能实际连一次才知道。
      ['direct reachable', { probeDirect: vi.fn(async () => true) }],
      ['probe failed', { probeDirect: vi.fn(async () => { throw new Error('probe crashed') }) }],
      ['not windows', { fastFailSupported: false }],
      // 加速超时的还在后台接着连，晚一点连上照样能拿到中文。
      ['acceleration still connecting', { ensureAccelerated: vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'skipped', reason: 'timeout' })) }],
      ['acceleration connected', { ensureAccelerated: vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'already-connected' })) }],
      ['acceleration threw', { ensureAccelerated: vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => { throw new Error('boom') }) }],
    ]
    for (const [name, overrides] of cases) {
      const f = coordinatorFixture({ issueTicket: noTicket, ensureAccelerated: skipped, ...overrides })
      await expect(f.coordinator.prepare({ launchArgumentsUsable: true }), name).resolves.toEqual({ kind: 'none' })
    }
  })

  it('never throws, whatever the host hooks do', async () => {
    const f = coordinatorFixture({
      tunnelUrls: () => { throw new Error('routing not ready') },
      log: () => { throw new Error('log broken') },
    })

    await expect(f.coordinator.prepare({ launchArgumentsUsable: true })).resolves.toEqual({ kind: 'none' })
    expect(f.ensureAccelerated).toHaveBeenCalledTimes(1)
  })
})

describe('startup route around a customer proxy', () => {
  function ownProxyFixture(overrides: Partial<CodexDesktopStartupRouteOptions> = {}) {
    const releaseRoute = vi.fn(async () => undefined)
    const startLoopbackRoute = vi.fn(async () => ({ port: 50_001, release: releaseRoute }))
    let settleClosed: (value: { expired: boolean }) => void = () => undefined
    let connections = 0
    const bridgeClose = vi.fn()
    const waitForUse = vi.fn(async () => true)
    const bridge: CodexStartupProxyBridge = {
      port: 43_211,
      connections: () => connections,
      used: () => false,
      waitForUse,
      closed: new Promise((resolve) => { settleClosed = resolve }),
      close: bridgeClose,
    }
    const openBridge = vi.fn(async () => bridge)
    const probeThroughSystemProxy = vi.fn(async () => false)
    const ensureAccelerated = vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'skipped', reason: 'connect-failed' }))
    const f = coordinatorFixture({
      issueTicket: vi.fn(async () => { throw new Error('Codex 中文启动凭证失败，服务返回 HTTP 404') }),
      ensureAccelerated,
      resolveSystemProxy: vi.fn(async () => 'PROXY 127.0.0.1:7890; DIRECT'),
      fastFailSupported: false,
      ownProxyBridgeSupported: true,
      probeThroughSystemProxy,
      startLoopbackRoute,
      openBridge,
      ...overrides,
    })
    return {
      ...f,
      ensureAccelerated,
      releaseRoute,
      startLoopbackRoute,
      openBridge,
      probeThroughSystemProxy,
      bridgeClose,
      waitForUse,
      markConnected: () => { connections = 1 },
      settleClosed: (expired: boolean) => settleClosed({ expired }),
    }
  }

  it('sends only the config host around a customer proxy that cannot reach it', async () => {
    const f = ownProxyFixture()

    const route = await f.coordinator.prepare({ launchArgumentsUsable: true })

    expect(route).toMatchObject({
      kind: 'own-proxy-bridge',
      hostResolverRules: 'MAP ab.chatgpt.com 127.0.0.1:43211',
      proxyServer: 'http://127.0.0.1:7890,direct://',
    })
    expect(f.ensureAccelerated).toHaveBeenCalledTimes(1)
    expect(f.probeThroughSystemProxy).toHaveBeenCalledTimes(1)
    expect(f.openBridge).toHaveBeenCalledWith({ proxyPort: 50_001 })
    expect(f.log).toHaveBeenCalledWith('info', 'codex-desktop.startup-route.bridge', expect.any(String), undefined)
    if (route.kind !== 'own-proxy-bridge') throw new Error('expected a bridge route')

    await expect(route.confirmUse(1_000)).resolves.toBe(true)
    expect(f.waitForUse).toHaveBeenCalledWith(1_000)

    route.release()
    route.release()
    expect(f.bridgeClose).toHaveBeenCalledTimes(1)
    expect(f.releaseRoute).toHaveBeenCalledTimes(1)
  })

  it('leaves alone a customer proxy that reaches the config host', async () => {
    const f = ownProxyFixture({ probeThroughSystemProxy: vi.fn(async () => true) })

    await expect(f.coordinator.prepare({ launchArgumentsUsable: true })).resolves.toEqual({ kind: 'none' })
    expect(f.startLoopbackRoute).not.toHaveBeenCalled()
  })

  it('keeps the old behaviour whenever it is not a blocked proxy on this computer', async () => {
    const cases: [string, Partial<CodexDesktopStartupRouteOptions>][] = [
      ['direct', { resolveSystemProxy: vi.fn(async () => 'DIRECT') }],
      ['remote proxy', { resolveSystemProxy: vi.fn(async () => 'PROXY 10.0.0.8:3128') }],
      ['proxy unknown', { resolveSystemProxy: vi.fn(async () => { throw new Error('session gone') }) }],
      ['probe crashed', { probeThroughSystemProxy: vi.fn(async () => { throw new Error('probe crashed') }) }],
      ['no probe wired', { probeThroughSystemProxy: undefined }],
      ['platform not covered', { ownProxyBridgeSupported: false }],
      // 没登录、加速组件起不来时下载线路一样起不来，关掉客户的加速也不会变中文。
      ['no account', { ensureAccelerated: vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'skipped', reason: 'no-account' })) }],
      ['acceleration unavailable', { ensureAccelerated: vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'skipped', reason: 'unavailable' })) }],
      ['acceleration still connecting', { ensureAccelerated: vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'skipped', reason: 'timeout' })) }],
      ['acceleration connected', { ensureAccelerated: vi.fn(async (): Promise<CodexDesktopAccelerationOutcome> => ({ status: 'connected' })) }],
    ]
    for (const [name, overrides] of cases) {
      const f = ownProxyFixture(overrides)
      await expect(f.coordinator.prepare({ launchArgumentsUsable: true }), name).resolves.toEqual({ kind: 'none' })
      expect(f.startLoopbackRoute, name).not.toHaveBeenCalled()
    }
  })

  it('does not look for a customer proxy when the launch cannot carry arguments', async () => {
    const f = ownProxyFixture()

    await expect(f.coordinator.prepare({ launchArgumentsUsable: false })).resolves.toEqual({ kind: 'none' })
    expect(f.probeThroughSystemProxy).not.toHaveBeenCalled()
  })

  it('asks the caller to remind the customer when the bridge cannot be built', async () => {
    const cases: [string, Partial<CodexDesktopStartupRouteOptions>][] = [
      ['no route', { startLoopbackRoute: vi.fn(async () => null) }],
      ['route threw', { startLoopbackRoute: vi.fn(async () => { throw new Error('内核起不来') }) }],
      ['route not wired', { startLoopbackRoute: undefined }],
    ]
    for (const [name, overrides] of cases) {
      const f = ownProxyFixture(overrides)
      await expect(f.coordinator.prepare({ launchArgumentsUsable: true }), name).resolves.toEqual({ kind: 'none', ownProxyBlocked: true })
    }

    const f = ownProxyFixture({ openBridge: vi.fn(async () => { throw new Error('EADDRINUSE') }) })
    await expect(f.coordinator.prepare({ launchArgumentsUsable: true })).resolves.toEqual({ kind: 'none', ownProxyBlocked: true })
    // The route came up before the bridge failed: it must be given back.
    expect(f.releaseRoute).toHaveBeenCalledTimes(1)
  })

  it('stops building bridges in this run once one expired without Codex ever connecting', async () => {
    const f = ownProxyFixture()

    const first = await f.coordinator.prepare({ launchArgumentsUsable: true })
    expect(first.kind).toBe('own-proxy-bridge')
    f.settleClosed(true)
    await waitFor(() => f.releaseRoute.mock.calls.length === 1)
    expect(f.log).toHaveBeenCalledWith('warn', 'codex-desktop.startup-route.bridge-unused', expect.any(String), undefined)

    await expect(f.coordinator.prepare({ launchArgumentsUsable: true })).resolves.toEqual({ kind: 'none', ownProxyBlocked: true })
    expect(f.startLoopbackRoute).toHaveBeenCalledTimes(1)
  })

  it('keeps building bridges after one that Codex connected to or that closed early', async () => {
    for (const [name, settle] of [
      // Codex came but the route never answered: the arguments worked, the line did not.
      ['connected', (f: ReturnType<typeof ownProxyFixture>) => { f.markConnected(); f.settleClosed(true) }],
      ['closed early', (f: ReturnType<typeof ownProxyFixture>) => f.settleClosed(false)],
    ] as const) {
      const f = ownProxyFixture()
      await f.coordinator.prepare({ launchArgumentsUsable: true })
      settle(f)
      await waitFor(() => f.releaseRoute.mock.calls.length === 1)

      await expect(f.coordinator.prepare({ launchArgumentsUsable: true }), name).resolves.toMatchObject({ kind: 'own-proxy-bridge' })
      expect(f.startLoopbackRoute, name).toHaveBeenCalledTimes(2)
    }
  })
})

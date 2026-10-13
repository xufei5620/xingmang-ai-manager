import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexDesktopAccelerationOutcome } from './codex-desktop-acceleration'
import {
  buildCodexStartupHostResolverRules,
  buildCodexStartupTunnelUrl,
  chromiumProxyResultIsDirect,
  createCodexDesktopStartupRouteCoordinator,
  formatCodexStartupMacArgument,
  formatCodexStartupWindowsArgument,
  openCodexStartupTunnel,
  preflightCodexStartupTunnel,
  type CodexDesktopStartupRouteOptions,
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

    sockets[0].remoteClose()
    await waitFor(() => local.ended())
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

    if (route.kind !== 'tunnel') throw new Error('expected a tunnel route')
    route.release()
    expect(f.tunnelClose).toHaveBeenCalledTimes(1)
    await route.fallback()
    expect(f.tunnelClose).toHaveBeenCalledTimes(2)
    expect(f.ensureAccelerated).toHaveBeenCalledTimes(1)
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

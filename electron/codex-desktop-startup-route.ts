/**
 * 从星芒打开 Codex 桌面端时，给它启动那一刻读中文开关的那一个请求找条路（issue #977）。
 *
 * Codex 每次冷启动都要向 ab.chatgpt.com 读一次界面开关（Statsig），国内直连读不到：界面是英文，
 * 还要先白屏半分多钟等它超时（#976 在 A024 上实测约 35 秒）。以前的办法是打开前替用户连上整机
 * 加速、两分钟后断开（codex-desktop-acceleration.ts），那两分钟整台电脑的流量都绕道。这里按顺序
 * 试三条路，前一条走不通才走下一条：
 *
 * 1. 代取：向星芒服务器换一张两分钟的通行票，在本机 127.0.0.1 开一个随机端口，用启动参数
 *    `--host-resolver-rules` 只把 ab.chatgpt.com 指到这个端口。Codex 连上来的字节原样经加密的
 *    WebSocket 交给服务器，服务器只连 ab.chatgpt.com:443（目标写死在服务端）。Codex 和 OpenAI 之间
 *    的 TLS 是端到端的，中间谁都解不开。不连加速、不改系统代理，别的流量一律不动。
 * 2. 退回加速：服务端还没上、没登录、票或通道走不通，照旧连加速。服务端就绪之前中文不能变差。
 * 3. 立刻失败：加速也没连上，而且这台电脑确实连不到 ab.chatgpt.com，就把它指到一个没人听的本机
 *    端口，让那个请求当场失败：界面还是英文，但不再白屏等半分钟。先问系统代理、再探一次：开着自己的
 *    代理或者 TUN 模式梯子的客户本来拿得到中文，不能把他们弄成英文（#976 路 A）。
 *
 * 只管「只在启动那一下要」的客户（用星芒 Key，见 codexDesktopNeedsAccelerationOnlyAtStartup）。登
 * ChatGPT 账号的整个使用过程都要连 chatgpt.com，照旧连加速，这里不碰。启动参数只有拉起新进程时才
 * 生效，Codex 已经开着时调用方会说（launchArgumentsUsable: false），那时也照旧连加速。
 *
 * 账号凭据只在主进程里换票；票只用来开这条通道，不交给 Codex，也不进日志（I3、I13、I15）。
 * 不含任何 Electron 依赖：换票、连加速、问系统代理都由宿主注入。
 */
import net, { type AddressInfo } from 'node:net'
import tls from 'node:tls'
import type { CodexDesktopAccelerationOutcome } from './codex-desktop-acceleration'

/** Codex 启动时读中文开关的那个主机。 */
export const codexStartupConfigHost = 'ab.chatgpt.com'

/** 星芒服务器上那条通道的路径（服务端要求见 Codex中文保持/977-核对.md 第六节）；主机只从 relay-sites.ts 来。 */
export const codexStartupTunnelPath = '/api/xingmang-tunnel/v1/ab-chatgpt'

// 本机 1 号端口没有程序在听，连接当场被拒。#976 在 A024 上实测：界面 9 秒出来，不加时 35 秒。
const fastFailPort = 1

const hostResolverRulesPattern = /^MAP ab\.chatgpt\.com 127\.0\.0\.1:\d{1,5}$/

export type CodexDesktopStartupRoute =
  /** 不带启动参数：加速连上了、用户自己有路，或者判断不了。 */
  | { kind: 'none' }
  /**
   * 代取：开关请求指到本机通道。release 关掉通道（确定没有 Codex 拉起来时用）；带参数启动报错、只能照
   * 普通方式再打开一次时，fallback 补连加速，通道留着到期自己关：报错不等于没拉起来（激活超时之前
   * 进程可能已经带着参数起来了），这时关通道反而会把它弄成英文。
   */
  | { kind: 'tunnel'; hostResolverRules: string; release(): void; fallback(cause?: unknown): Promise<void> }
  /** 立刻失败：开关请求指到没人听的本机端口。 */
  | { kind: 'fast-fail'; hostResolverRules: string }

export const noCodexDesktopStartupRoute: CodexDesktopStartupRoute = Object.freeze({ kind: 'none' })

export function buildCodexStartupHostResolverRules(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Codex 启动参数里的端口无效')
  return `MAP ${codexStartupConfigHost} 127.0.0.1:${port}`
}

function assertHostResolverRules(rules: string): void {
  if (!hostResolverRulesPattern.test(rules)) throw new Error('Codex 启动参数无效')
}

/**
 * Windows 的激活参数是一整条命令行，规则里有空格，要整个加引号（#976 实测的就是这个写法）。规则只能是
 * 上面那个固定样子，拼不进别的参数。
 */
export function formatCodexStartupWindowsArgument(rules: string): string {
  assertHostResolverRules(rules)
  return `--host-resolver-rules="${rules}"`
}

/** macOS 由 open 按参数数组交给 Codex，不经过命令行解析，不加引号。 */
export function formatCodexStartupMacArgument(rules: string): string {
  assertHostResolverRules(rules)
  return `--host-resolver-rules=${rules}`
}

/** 只认 https 的站点根地址；换成 wss 以后接上通道路径。 */
export function buildCodexStartupTunnelUrl(origin: string): string | null {
  let url: URL
  try { url = new URL(codexStartupTunnelPath, origin) } catch { return null }
  if (url.protocol !== 'https:' || url.origin !== origin) return null
  url.protocol = 'wss:'
  return url.href
}

/** 只用到 WebSocket 的这几样，测试换成假的。 */
export interface CodexStartupTunnelSocket {
  binaryType: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
}

export type CodexStartupTunnelConnect = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => CodexStartupTunnelSocket

/**
 * Node 自带的 WebSocket（undici）收 headers 这个参数，浏览器那份标准里没有。握手照规范不跟随跳转，
 * 证书用 Node 自己那套根证书：公司或安全软件换了证书的电脑上握不上手，那时预检就会失败，退回加速。
 */
function connectWebSocket(url: string, headers: Readonly<Record<string, string>>): CodexStartupTunnelSocket {
  const Constructor = (globalThis as unknown as {
    WebSocket?: new (endpoint: string, init: { headers: Record<string, string> }) => CodexStartupTunnelSocket
  }).WebSocket
  if (!Constructor) throw new Error('当前运行时不支持 WebSocket')
  return new Constructor(url, { headers: { ...headers } })
}

function tunnelHeaders(ticket: string): Record<string, string> {
  return { Authorization: `Bearer ${ticket}` }
}

function detachSocket(socket: CodexStartupTunnelSocket): void {
  socket.onopen = null
  socket.onmessage = null
  socket.onerror = null
  socket.onclose = null
  try { socket.close() } catch { /* 已经断了。 */ }
}

function messageBytes(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/** 按顺序试，返回第一个握得上手的地址；全都不行给 null。只握手，不往里写东西。 */
export async function preflightCodexStartupTunnel(
  urls: readonly string[],
  ticket: string,
  options: { connect?: CodexStartupTunnelConnect; timeoutMs?: number } = {},
): Promise<string | null> {
  const connect = options.connect ?? connectWebSocket
  const timeoutMs = options.timeoutMs ?? 4_000
  for (const url of urls) {
    const opened = await new Promise<boolean>((resolve) => {
      let socket: CodexStartupTunnelSocket | null = null
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        if (socket) detachSocket(socket)
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      try { socket = connect(url, tunnelHeaders(ticket)) } catch { finish(false); return }
      socket.binaryType = 'arraybuffer'
      socket.onopen = () => finish(true)
      socket.onerror = () => finish(false)
      socket.onclose = () => finish(false)
    })
    if (opened) return url
  }
  return null
}

export interface CodexStartupTunnelOptions {
  /** 通道地址，先试的在前；一条握不上手才试下一条。 */
  urls: readonly string[]
  ticket: string
  connect?: CodexStartupTunnelConnect
  /** 整条通道开多久，到点全部关掉。缺省两分钟，和票的有效期一样长。 */
  lifetimeMs?: number
  /** 最多接几条本机连接。Codex 启动时只连一两条，多出来的直接拒掉。 */
  maxConnections?: number
  /** 每条连接上下行合计的上限。读开关那一下只有几十 KB。 */
  maxBytesPerConnection?: number
  /** 一条连接多久没有数据就断。 */
  idleTimeoutMs?: number
  /** 和服务器握手最多等多久。 */
  handshakeTimeoutMs?: number
  /** 握手完成之前，本机这边先发来的数据最多攒多少。 */
  maxPendingBytes?: number
}

export interface CodexStartupTunnel {
  readonly port: number
  close(): void
}

/**
 * 在 127.0.0.1 的随机端口上接 Codex 的连接，每条连接配一条到服务器的 WebSocket，字节原样来回。
 * 这个端口只通向服务器那一头写死的 ab.chatgpt.com:443：本机别的程序连上来，也只能到那里。
 */
export function openCodexStartupTunnel(options: CodexStartupTunnelOptions): Promise<CodexStartupTunnel> {
  const connect = options.connect ?? connectWebSocket
  const lifetimeMs = options.lifetimeMs ?? 120_000
  const maxConnections = options.maxConnections ?? 8
  const maxBytes = options.maxBytesPerConnection ?? 8 * 1024 * 1024
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
  const maxPendingBytes = options.maxPendingBytes ?? 256 * 1024
  const urls = [...options.urls]
  const headers = tunnelHeaders(options.ticket)
  const closers = new Set<() => void>()
  let accepted = 0
  let closed = false

  function bridge(local: net.Socket): void {
    let remote: CodexStartupTunnelSocket | null = null
    let opened = false
    let finished = false
    let bytes = 0
    let pendingBytes = 0
    let pending: Buffer[] = []
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null

    function finish(): void {
      if (finished) return
      finished = true
      closers.delete(finish)
      if (handshakeTimer) clearTimeout(handshakeTimer)
      pending = []
      if (remote) detachSocket(remote)
      local.destroy()
    }
    closers.add(finish)

    // 服务器那头正常关了：本机这边先把已经写下去的字节送完再关，别把最后一段回应丢掉。
    function finishAfterFlush(): void {
      if (finished) return
      if (remote) detachSocket(remote)
      remote = null
      local.end()
      const timer = setTimeout(finish, 1_000)
      timer.unref?.()
      local.once('close', () => clearTimeout(timer))
    }

    function withinBudget(length: number): boolean {
      bytes += length
      if (bytes <= maxBytes) return true
      finish()
      return false
    }

    function dial(index: number): void {
      if (finished) return
      if (index >= urls.length) { finish(); return }
      if (handshakeTimer) clearTimeout(handshakeTimer)
      let socket: CodexStartupTunnelSocket
      try { socket = connect(urls[index], headers) } catch { dial(index + 1); return }
      remote = socket
      socket.binaryType = 'arraybuffer'
      handshakeTimer = setTimeout(() => { detachSocket(socket); dial(index + 1) }, handshakeTimeoutMs)
      handshakeTimer.unref?.()
      socket.onopen = () => {
        if (handshakeTimer) clearTimeout(handshakeTimer)
        handshakeTimer = null
        opened = true
        for (const chunk of pending) socket.send(chunk)
        pending = []
        pendingBytes = 0
      }
      socket.onmessage = (event) => {
        const chunk = messageBytes(event.data)
        // 服务器只该回二进制：别的东西说明那头不是我们的通道。
        if (!chunk) { finish(); return }
        if (withinBudget(chunk.length)) local.write(chunk)
      }
      socket.onerror = () => {
        if (opened) { finish(); return }
        detachSocket(socket)
        dial(index + 1)
      }
      socket.onclose = () => {
        if (opened) { finishAfterFlush(); return }
        detachSocket(socket)
        dial(index + 1)
      }
    }

    local.setNoDelay(true)
    local.setTimeout(idleTimeoutMs, finish)
    local.on('data', (chunk: Buffer) => {
      if (finished) return
      if (!withinBudget(chunk.length)) return
      if (opened) {
        remote?.send(chunk)
        return
      }
      pendingBytes += chunk.length
      if (pendingBytes > maxPendingBytes) { finish(); return }
      pending.push(chunk)
    })
    local.on('end', finish)
    local.on('error', finish)
    local.on('close', finish)
    dial(0)
  }

  return new Promise<CodexStartupTunnel>((resolve, reject) => {
    const server = net.createServer((local) => {
      if (closed || accepted >= maxConnections) {
        local.destroy()
        return
      }
      accepted += 1
      bridge(local)
    })
    let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
    function close(): void {
      if (closed) return
      closed = true
      if (lifetimeTimer) clearTimeout(lifetimeTimer)
      server.close()
      for (const finish of [...closers]) finish()
    }
    server.once('error', (error) => {
      close()
      reject(error)
    })
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address() as AddressInfo | null
      if (!address || typeof address.port !== 'number') {
        close()
        reject(new Error('本机通道没能拿到端口'))
        return
      }
      lifetimeTimer = setTimeout(close, lifetimeMs)
      lifetimeTimer.unref?.()
      resolve({ port: address.port, close })
    })
  })
}

// 握手失败在这些情况下其实是连上了：对面回了一张证书，只是这台电脑不认（被污染到别家的地址、
// 安全软件换了证书）。这时按「连得上」算，少做一次立刻失败，照旧是今天的样子。
const certificateFailureCodes: ReadonlySet<string> = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/**
 * 这台电脑现在能不能直接连上 ab.chatgpt.com：只做一次 TLS 握手，不发任何请求。DNS 被污染、握手
 * 被重置、等不到回应，都算连不上。等得比一般握手久一些：慢但通的梯子要算「连得上」，不然会被弄成英文。
 */
export function probeCodexStartupHostDirect(timeoutMs = 5_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const socket = tls.connect({ host: codexStartupConfigHost, port: 443, servername: codexStartupConfigHost })
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once('secureConnect', () => finish(true))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(typeof error.code === 'string' && certificateFailureCodes.has(error.code))
    })
    socket.once('close', () => finish(false))
  })
}

/** Chromium resolveProxy 的结果第一段是不是 DIRECT（例如 `PROXY 127.0.0.1:7890; DIRECT` 不是）。 */
export function chromiumProxyResultIsDirect(result: string): boolean {
  const first = result.split(';')[0]?.trim().toUpperCase() ?? ''
  return first === '' || first === 'DIRECT'
}

export interface CodexDesktopStartupRouteOptions {
  /** 这个平台的 Codex 收不收启动参数。不收就只连加速。 */
  launchArgumentsSupported: boolean
  /** 立刻失败只在 Windows 上实测过（#976），别的平台不做。 */
  fastFailSupported: boolean
  /** 同 codex-desktop-acceleration.ts 的 onlyNeededAtStartup：认不准按「一直要」，不走这里。 */
  onlyNeededAtStartup(): boolean | Promise<boolean>
  /** 向星芒服务器换通行票；没登录、站点没有这个服务时抛错。 */
  issueTicket(): Promise<{ ticket: string; expiresInSeconds: number }>
  /** 通道地址，这会儿走的线路在前。 */
  tunnelUrls(): readonly string[]
  /** 永不抛错，见 codex-desktop-acceleration.ts。 */
  ensureAccelerated(): Promise<CodexDesktopAccelerationOutcome>
  /** 系统代理对这个地址怎么走（Chromium resolveProxy 的原样结果）。 */
  resolveSystemProxy(url: string): Promise<string>
  /** 缺省 = probeCodexStartupHostDirect。 */
  probeDirect?(): Promise<boolean>
  connect?: CodexStartupTunnelConnect
  /** 测试替身；缺省 = openCodexStartupTunnel。 */
  openTunnel?(options: CodexStartupTunnelOptions): Promise<CodexStartupTunnel>
  /** 换票最多等多久。服务端还没上时是一个很快的 404，不会等满。 */
  ticketTimeoutMs?: number
  /** 预检握手每条线路最多等多久。 */
  preflightTimeoutMs?: number
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface CodexDesktopStartupRouteCoordinator {
  /**
   * 永不抛错：调用方拿到什么都要照常打开。launchArgumentsUsable = 这次要拉起新进程，启动参数生效；
   * Codex 已经开着时传 false，只照旧连加速。
   */
  prepare(context: { launchArgumentsUsable: boolean }): Promise<CodexDesktopStartupRoute>
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待超时')), milliseconds)
    timer.unref?.()
    operation.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

function failureDetail(error: unknown): Record<string, unknown> {
  return { cause: (error instanceof Error ? error.message : String(error)).slice(0, 200) }
}

export function createCodexDesktopStartupRouteCoordinator(
  options: CodexDesktopStartupRouteOptions,
): CodexDesktopStartupRouteCoordinator {
  const ticketTimeoutMs = options.ticketTimeoutMs ?? 4_000
  const preflightTimeoutMs = options.preflightTimeoutMs ?? 4_000
  const probeDirect = options.probeDirect ?? (() => probeCodexStartupHostDirect())
  const openTunnel = options.openTunnel ?? openCodexStartupTunnel

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能反过来挡住打开。 */ }
  }

  async function startupOnly(): Promise<boolean> {
    try { return await options.onlyNeededAtStartup() === true }
    catch { return false }
  }

  async function accelerate(): Promise<CodexDesktopAccelerationOutcome | null> {
    try { return await options.ensureAccelerated() }
    catch { return null }
  }

  async function tryTunnel(): Promise<CodexDesktopStartupRoute | null> {
    let ticket: { ticket: string; expiresInSeconds: number }
    try { ticket = await withTimeout(options.issueTicket(), ticketTimeoutMs) }
    catch (error) {
      log('info', 'codex-desktop.startup-route.unavailable', '没拿到 Codex 中文启动通道的通行票，改走加速', { reason: 'ticket', ...failureDetail(error) })
      return null
    }
    let urls: readonly string[] = []
    try { urls = options.tunnelUrls() } catch { /* 线路还没就绪：当作没有通道，下面照旧退回加速。 */ }
    const preferred = urls.length
      ? await preflightCodexStartupTunnel(urls, ticket.ticket, { connect: options.connect, timeoutMs: preflightTimeoutMs })
      : null
    if (!preferred) {
      log('warn', 'codex-desktop.startup-route.unavailable', 'Codex 中文启动通道握不上手，改走加速', { reason: 'preflight', lines: urls.length })
      return null
    }
    let tunnel: CodexStartupTunnel
    try {
      tunnel = await openTunnel({
        urls: [preferred, ...urls.filter((url) => url !== preferred)],
        ticket: ticket.ticket,
        connect: options.connect,
        lifetimeMs: ticket.expiresInSeconds * 1_000,
        // 服务端一张票最多开 8 条通道，预检已经用掉一条。
        maxConnections: 7,
      })
    } catch (error) {
      log('warn', 'codex-desktop.startup-route.unavailable', 'Codex 中文启动通道在本机开不起来，改走加速', { reason: 'listen', ...failureDetail(error) })
      return null
    }
    log('info', 'codex-desktop.startup-route.tunnel', 'Codex 启动时读中文开关的那一下改走星芒服务器，不连加速')
    return {
      kind: 'tunnel',
      hostResolverRules: buildCodexStartupHostResolverRules(tunnel.port),
      release: () => tunnel.close(),
      fallback: async (cause) => {
        log('info', 'codex-desktop.startup-route.fallback', '带启动参数打开 Codex 没成，补连加速', cause === undefined ? undefined : failureDetail(cause))
        await accelerate()
      },
    }
  }

  /** 拿不准就按「连得上」：宁可照旧白屏，也不能把本来拿得到中文的人弄成英文。 */
  async function reachableWithoutUs(): Promise<boolean> {
    try {
      if (!chromiumProxyResultIsDirect(await options.resolveSystemProxy(`https://${codexStartupConfigHost}/`))) return true
    } catch { return true }
    try { return await probeDirect() }
    catch { return true }
  }

  async function prepare(launchArgumentsUsable: boolean): Promise<CodexDesktopStartupRoute> {
    if (!launchArgumentsUsable || !options.launchArgumentsSupported || !await startupOnly()) {
      await accelerate()
      return noCodexDesktopStartupRoute
    }
    const tunnel = await tryTunnel()
    if (tunnel) return tunnel
    const outcome = await accelerate()
    // 连上了、本来就连着的，Codex 跟着系统代理走；超时的还在后台接着连，晚一点连上照样能拿到中文。
    if (!options.fastFailSupported || outcome?.status !== 'skipped' || outcome.reason === 'timeout') {
      return noCodexDesktopStartupRoute
    }
    if (await reachableWithoutUs()) return noCodexDesktopStartupRoute
    log('info', 'codex-desktop.startup-route.fast-fail', '这台电脑连不到 Codex 的中文开关，让它立刻失败，免得白屏等半分钟')
    return { kind: 'fast-fail', hostResolverRules: buildCodexStartupHostResolverRules(fastFailPort) }
  }

  return {
    async prepare(context) {
      try { return await prepare(context.launchArgumentsUsable) }
      catch (error) {
        log('warn', 'codex-desktop.startup-route.failed', '准备 Codex 启动参数时出错，按普通方式打开', failureDetail(error))
        return noCodexDesktopStartupRoute
      }
    },
  }
}

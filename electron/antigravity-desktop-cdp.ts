import net from 'node:net'
import { parseAntigravityChineseInjectionResult, type AntigravityChineseInjectionResult } from './antigravity-desktop-chinese'
import { readBoundedResponseText } from './bounded-response'
import { CommandRunnerError, commandEnvironment, runCommand } from './command-runner'
import { isRecord } from './input-guards'

// Mac 上从星芒打开 Antigravity 桌面端时，给它开一个只在本机的调试口，打开以后经这个口把中文换字脚本送进它的窗口
// （脚本和词表在 antigravity-desktop-chinese.ts）。yoyo 2026-11-26 亲手打了「反重力调试口同意」「反重力默认中文」。
// Windows 上星芒经资源管理器打开它、带不上启动参数，那一半等 Claude·win 或 yoyo 定了再接。
//
// The debugging port stays open for as long as Antigravity runs and has no
// authentication: any process of the same user can drive the window through
// it, as it already can read the settings file this app writes for it. Web
// pages cannot: Chromium refuses a handshake that carries an Origin it was
// not told to allow, and no --remote-allow-origins is passed (the WebSocket
// built into Node sends no Origin, so this app does not need one). What this
// app trusts on that port is narrowed further:
// - the port is a free loopback port picked just before the launch;
// - nothing is sent until lsof shows that every listener on it is the
//   process this app just started, listening on loopback only;
// - the script goes only into Antigravity's own interface pages, and the
//   only thing read back is the small JSON count the script returns.
//
// 一直连着，不是放一次就走：新文档脚本（Page.addScriptToEvaluateOnNewDocument）只在 Page.enable 过、会话还挂着
// 时才生效，会话一断开就撤（2026-11-26 用 Chromium 实测），而 Antigravity 刷新窗口、开新窗口都会换文档。
// 星芒或 Antigravity 任一边退出，连接就断了；已经换成中文的那一页继续是中文，只是之后刷新不再换。

const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '[::1]'])
const lsofExecutable = '/usr/sbin/lsof'
const lsofTimeoutMs = 5_000
const lsofOutputBytes = 256 * 1024
const portPollMs = 500
// 第一次打开时系统还要核一遍签名（Gatekeeper），调试口可能晚十几秒才开。
const portDeadlineMs = 60_000
const portLookupFailureLimit = 3
const versionRequestTimeoutMs = 2_000
const versionResponseBytes = 64 * 1024
// 口刚开起来那一下，HTTP 那一层可能还没就绪。
const endpointAttempts = 3
const socketOpenTimeoutMs = 5_000
// 整份词表有几百 KB，第一次换字要扫一遍窗口，给足时间。
const commandTimeoutMs = 10_000
const maximumMessageBytes = 1024 * 1024
const noPageDeadlineMs = 60_000
const maximumPageAttempts = 2

/** 打开 Antigravity 时加在命令行上的参数。只开调试口，别的不加（口只听本机，Electron 不收别的地址）。 */
export function buildAntigravityDesktopDebugArguments(port: number): string[] {
  return [`--remote-debugging-port=${assertPort(port)}`]
}

/**
 * 挑一个本机空着的口。挑完就放开了，Antigravity 起来之前别的程序也可能占上它，所以连上去之前还要用
 * lsof 核一遍是谁在听（classifyAntigravityDebugPortOwnership）。
 */
export function pickAntigravityDebugPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        if (!address || typeof address === 'string') {
          reject(new Error('挑不出 Antigravity 调试口'))
          return
        }
        resolve(assertPort(address.port))
      })
    })
  })
}

export interface AntigravityDebugPortListener {
  processId: number
  /** lsof 给的地址，`127.0.0.1:9222`、`[::1]:9222`、`*:9222` 这样。 */
  address: string
}

/**
 * 读 `lsof -nP -iTCP:<口> -sTCP:LISTEN -Fpn` 的输出：`p<进程号>` 一行起一个进程，之后每个 `n<地址>` 是它
 * 在听的一个地址；别的字段（`f` 之类）不看。没有一行就是没人在听。看不懂的（地址前面没有进程号、进程号
 * 不是正整数）整份不认，不猜。
 */
export function parseAntigravityDebugPortListeners(stdout: string): AntigravityDebugPortListener[] | null {
  const listeners: AntigravityDebugPortListener[] = []
  let processId: number | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') {
      if (!/^\d{1,10}$/.test(value)) return null
      processId = Number(value)
      if (!Number.isSafeInteger(processId) || processId <= 0) return null
    } else if (field === 'n') {
      if (processId === null || !value) return null
      listeners.push({ processId, address: value })
    }
  }
  return listeners
}

export type AntigravityDebugPortOwnership = 'unbound' | 'owned' | 'refused'

function listenerHostAndPort(address: string): { host: string, port: number } | null {
  const separator = address.lastIndexOf(':')
  if (separator <= 0) return null
  const port = address.slice(separator + 1)
  if (!/^\d{1,5}$/.test(port)) return null
  return { host: address.slice(0, separator).toLowerCase(), port: Number(port) }
}

/**
 * unbound：还没人在听（Antigravity 还在起）。owned：在听的全是星芒刚起的那个进程，而且只听本机。
 * refused：有别的进程也在听（口被抢了），或者听的不是本机地址；这时什么都不送，整次放弃。
 *
 * lsof 只看得见本用户的进程。别的用户（比如 root）的进程抢先占了口，Antigravity 就占不上，这里看到的是
 * 一直没人在听，等到时限放弃，同样什么都不送。
 */
export function classifyAntigravityDebugPortOwnership(
  listeners: readonly AntigravityDebugPortListener[],
  port: number,
  expectedProcessId: number,
): AntigravityDebugPortOwnership {
  assertPort(port)
  if (!listeners.length) return 'unbound'
  for (const listener of listeners) {
    if (listener.processId !== expectedProcessId) return 'refused'
    const endpoint = listenerHostAndPort(listener.address)
    if (!endpoint || endpoint.port !== port || !loopbackHostnames.has(endpoint.host)) return 'refused'
  }
  return 'owned'
}

export interface AntigravityDebugPortLookupOptions {
  env: NodeJS.ProcessEnv
  /** 只给测试换掉。 */
  run?: typeof runCommand
}

/** Mac 上谁在听这个口。lsof 没找到人时退出码是 1、什么都不打印，那就是没人在听；别的失败原样抛。 */
export async function resolveMacAntigravityDebugPortListeners(
  port: number,
  options: AntigravityDebugPortLookupOptions,
): Promise<AntigravityDebugPortListener[]> {
  const run = options.run ?? runCommand
  let stdout: string
  try {
    const result = await run({ executable: lsofExecutable, argv: ['-nP', `-iTCP:${assertPort(port)}`, '-sTCP:LISTEN', '-Fpn'] }, {
      env: commandEnvironment(options.env), trustedOnly: false, timeoutMs: lsofTimeoutMs, maxOutputBytes: lsofOutputBytes,
    })
    stdout = result.stdout
  } catch (error) {
    if (error instanceof CommandRunnerError && error.code === 'EXIT_NON_ZERO' && error.exitCode === 1 && !error.stdout.trim()) return []
    throw error
  }
  const listeners = parseAntigravityDebugPortListeners(stdout)
  if (!listeners) throw new Error('看不懂 lsof 列出的监听进程')
  return listeners
}

export interface AntigravityCdpTargetInfo {
  targetId: string
  type: string
  url: string
}

/**
 * 只往 Antigravity 自己的界面页面放脚本：桌面端（2.x）的主窗口是它自己在本机起的 https 页面，IDE 那种是
 * `vscode-file://vscode-app/…/workbench….html` 工作台。别的（开发者工具、扩展的子页面、内嵌的外部网页）不碰。
 */
export function isAntigravityInterfacePage(info: AntigravityCdpTargetInfo): boolean {
  if (info.type !== 'page') return false
  let url: URL
  try {
    url = new URL(info.url)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return loopbackHostnames.has(url.hostname.toLowerCase()) && url.port !== ''
  if (url.protocol === 'vscode-file:') return url.host === 'vscode-app' && /\/workbench[^/]*\.html$/i.test(url.pathname)
  return false
}

/** `/json/version` 给的浏览器级连接地址：只认本机 127.0.0.1 这个口上的 `/devtools/browser/<编号>`。 */
export function validateAntigravityBrowserEndpoint(value: unknown, port: number): string | null {
  assertPort(port)
  if (typeof value !== 'string' || value.length > 512) return null
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return null
  }
  if (
    endpoint.protocol !== 'ws:'
    || endpoint.hostname !== '127.0.0.1'
    || endpoint.port !== String(port)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || !/^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/.test(endpoint.pathname)
  ) return null
  return endpoint.href
}

export interface AntigravityCdpSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void
}

export type AntigravityDesktopChineseSkipReason =
  | 'port-refused'
  | 'port-unconfirmed'
  | 'not-ready'
  | 'connection-failed'
  | 'no-page'
  | 'closed'
  | 'stopped'

export type AntigravityDesktopChineseOutcome =
  | { status: 'applied', result: AntigravityChineseInjectionResult }
  | { status: 'skipped', reason: AntigravityDesktopChineseSkipReason, error?: string }

export interface AntigravityDesktopChineseLog {
  (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface AntigravityDesktopChineseOptions {
  port: number
  /** 星芒刚起的那个 Antigravity 主进程。调试口上在听的必须全是它。 */
  processId: number
  /** antigravity-desktop-chinese.ts 拼好的那一整段代码。 */
  injection: string
  resolveListeners(port: number): Promise<AntigravityDebugPortListener[]>
  log?: AntigravityDesktopChineseLog
  fetch?: typeof globalThis.fetch
  createWebSocket?(url: string): AntigravityCdpSocket
  delay?(milliseconds: number): Promise<void>
  now?(): number
  /** 只给测试换掉：哪些页面放脚本（测试页不是 Antigravity 的地址）。缺省 isAntigravityInterfacePage。 */
  acceptsPage?(info: AntigravityCdpTargetInfo): boolean
}

export interface AntigravityDesktopChineseWatch {
  /** 第一页换成中文，或者整次放弃时落定；不会失败。之后照样连着，新窗口、刷新过的窗口接着换。 */
  settled: Promise<AntigravityDesktopChineseOutcome>
  /** 断开连接、不再换（已经换好的那几页不动）。 */
  stop(): void
}

interface CdpConnection {
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>
}

interface PageEntry {
  sessionId: string | null
  /** 页面眼下还在界面地址上。挂着的这一会儿换去了别的地址就是 false，挂完撤掉。 */
  wanted: boolean
  applied: boolean
  attempts: number
  busy: boolean
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Antigravity 调试口无效')
  return port
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

function defaultWebSocket(url: string): AntigravityCdpSocket {
  const Constructor = (globalThis as unknown as { WebSocket?: new (endpoint: string) => AntigravityCdpSocket }).WebSocket
  if (!Constructor) throw new Error('当前运行时不支持 WebSocket')
  return new Constructor(url)
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function messageText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return null
}

function readTargetInfo(value: unknown): AntigravityCdpTargetInfo | null {
  if (!isRecord(value)) return null
  const { targetId, type, url } = value
  if (typeof targetId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(targetId)) return null
  if (typeof type !== 'string' || typeof url !== 'string' || url.length > 4096) return null
  return { targetId, type, url }
}

function readSessionId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null
}

function readEvaluation(result: Record<string, unknown>): AntigravityChineseInjectionResult | null {
  if (result.exceptionDetails !== undefined) return null
  const remote = result.result
  return isRecord(remote) ? parseAntigravityChineseInjectionResult(remote.value) : null
}

function waitForOpen(socket: AntigravityCdpSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === 1) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('调试连接超时'))
    }, socketOpenTimeoutMs)
    function cleanup(): void {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onFailure)
      socket.removeEventListener('close', onFailure)
    }
    function onOpen(): void {
      cleanup()
      resolve()
    }
    function onFailure(): void {
      cleanup()
      reject(new Error('调试连接失败'))
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onFailure)
    socket.addEventListener('close', onFailure)
  })
}

/** 一条连接上的命令和事件：命令按编号等回话，事件交给 onEvent，连接断了所有没回话的命令一起失败。 */
function connectCdp(
  socket: AntigravityCdpSocket,
  onEvent: (method: string, params: Record<string, unknown>, sessionId: string | null) => void,
  onClose: () => void,
): CdpConnection {
  let nextId = 0
  const pending = new Map<number, { resolve(result: Record<string, unknown>): void, reject(error: Error): void, timer: ReturnType<typeof setTimeout> }>()
  socket.addEventListener('message', (event) => {
    const text = messageText(event.data)
    if (text === null || text.length > maximumMessageBytes) return
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(message)) return
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) entry.reject(new Error('调试命令返回错误'))
      else entry.resolve(isRecord(message.result) ? message.result : {})
      return
    }
    if (typeof message.method === 'string') {
      onEvent(message.method, isRecord(message.params) ? message.params : {}, readSessionId(message.sessionId))
    }
  })
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('调试连接已断开'))
    }
    pending.clear()
    onClose()
  })
  return {
    send(method, params, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`调试命令 ${method} 超时`))
        }, commandTimeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
  }
}

/**
 * 等星芒刚起的 Antigravity 把调试口开起来、核对是它在听，再连上去，往它现有的和以后开的界面页面里放换字脚本。
 * 不抛错：放弃的原因进日志和 settled。
 */
export function watchAntigravityDesktopChinese(options: AntigravityDesktopChineseOptions): AntigravityDesktopChineseWatch {
  const port = assertPort(options.port)
  const processId = options.processId
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Antigravity 进程号无效')
  const injection = options.injection
  const fetchImpl = options.fetch ?? globalThis.fetch
  const createWebSocket = options.createWebSocket ?? defaultWebSocket
  const delay = options.delay ?? defaultDelay
  const now = options.now ?? Date.now
  const acceptsPage = options.acceptsPage ?? isAntigravityInterfacePage
  const pages = new Map<string, PageEntry>()
  let stopped = false
  let socket: AntigravityCdpSocket | null = null
  let connection: CdpConnection | null = null
  let noPageTimer: ReturnType<typeof setTimeout> | null = null
  let appliedPages = 0
  let lastPageError: string | undefined
  let finished = false
  let resolveSettled: (outcome: AntigravityDesktopChineseOutcome) => void = () => undefined
  const settled = new Promise<AntigravityDesktopChineseOutcome>((resolve) => { resolveSettled = resolve })

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, { port, ...detail }) } catch { /* 日志记不下不挡换字。 */ }
  }

  function finish(outcome: AntigravityDesktopChineseOutcome): void {
    if (finished) return
    finished = true
    if (noPageTimer) clearTimeout(noPageTimer)
    noPageTimer = null
    if (outcome.status === 'skipped' && outcome.reason !== 'stopped') {
      log('warn', 'antigravity.desktop.chinese.skipped', 'Antigravity 没换成中文，照旧英文', { reason: outcome.reason, ...(outcome.error ? { error: outcome.error } : {}) })
    }
    resolveSettled(outcome)
  }

  function closeSocket(): void {
    const current = socket
    socket = null
    try { current?.close(1000, 'done') } catch { /* 已经断了。 */ }
  }

  function stop(): void {
    stopped = true
    finish({ status: 'skipped', reason: 'stopped' })
    closeSocket()
  }

  async function waitForOwnedPort(): Promise<AntigravityDesktopChineseOutcome | null> {
    const deadline = now() + portDeadlineMs
    let failedLookups = 0
    while (!stopped) {
      let listeners: AntigravityDebugPortListener[] | null = null
      try {
        listeners = await options.resolveListeners(port)
        failedLookups = 0
      } catch (error) {
        failedLookups += 1
        if (failedLookups >= portLookupFailureLimit) return { status: 'skipped', reason: 'port-unconfirmed', error: errorText(error) }
      }
      if (stopped) return null
      if (listeners) {
        const ownership = classifyAntigravityDebugPortOwnership(listeners, port, processId)
        // A squatted port ends the whole attempt: waiting would only keep
        // offering the window to whoever answers on it.
        if (ownership === 'refused') return { status: 'skipped', reason: 'port-refused', error: `在听的进程：${listeners.map((listener) => listener.processId).join(',')}` }
        if (ownership === 'owned') return null
      }
      if (now() >= deadline) return { status: 'skipped', reason: 'not-ready' }
      await delay(portPollMs)
    }
    return null
  }

  async function readBrowserEndpoint(): Promise<string> {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(versionRequestTimeoutMs),
    })
    if (!response.ok) throw new Error(`调试口返回 HTTP ${response.status}`)
    const body = await readBoundedResponseText(response, versionResponseBytes, 'Antigravity 调试口', { oversizeMessage: 'Antigravity 调试口的回应过大' })
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error('Antigravity 调试口的回应不是 JSON')
    }
    const endpoint = isRecord(parsed) ? validateAntigravityBrowserEndpoint(parsed.webSocketDebuggerUrl, port) : null
    if (!endpoint) throw new Error('Antigravity 调试口给的连接地址没有通过核对')
    return endpoint
  }

  function detach(sessionId: string): void {
    void connection?.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
  }

  async function attach(targetId: string, entry: PageEntry): Promise<void> {
    const cdp = connection
    if (!cdp) return
    entry.busy = true
    entry.attempts += 1
    try {
      if (!entry.sessionId) {
        const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
        const sessionId = readSessionId(attached.sessionId)
        if (!sessionId) throw new Error('调试口没有给出会话')
        entry.sessionId = sessionId
      }
      const sessionId = entry.sessionId
      if (!entry.wanted) return
      // 先挂新文档脚本再换当前这页：两步之间页面要是刚好刷新，新文档也带上了。Page.enable 不开，新文档脚本不生效。
      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injection }, sessionId)
      const result = readEvaluation(await cdp.send('Runtime.evaluate', { expression: injection, returnByValue: true, awaitPromise: false }, sessionId))
      if (!result) throw new Error('换字脚本没有回报结果')
      entry.applied = true
      appliedPages += 1
      log('info', 'antigravity.desktop.chinese.applied', 'Antigravity 窗口已换成中文', {
        pages: appliedPages, translated: result.translated, version: result.version, depth: result.depth,
      })
      finish({ status: 'applied', result })
    } catch (error) {
      if (stopped) return
      lastPageError = errorText(error)
      log('warn', 'antigravity.desktop.chinese.page-failed', 'Antigravity 有一个窗口没换成中文', { attempts: entry.attempts, error: lastPageError })
    } finally {
      entry.busy = false
      // 挂着的这一会儿页面换去了别的地址：撤掉会话，它的新文档脚本跟着撤。
      if (!entry.wanted && pages.get(targetId) === entry) forget(targetId, entry)
    }
  }

  function forget(targetId: string, entry: PageEntry): void {
    pages.delete(targetId)
    if (entry.sessionId) detach(entry.sessionId)
  }

  function consider(info: AntigravityCdpTargetInfo): void {
    const entry = pages.get(info.targetId)
    if (!acceptsPage(info)) {
      if (!entry) return
      entry.wanted = false
      if (!entry.busy) forget(info.targetId, entry)
      return
    }
    if (!entry) {
      const created: PageEntry = { sessionId: null, wanted: true, applied: false, attempts: 0, busy: false }
      pages.set(info.targetId, created)
      void attach(info.targetId, created)
      return
    }
    entry.wanted = true
    // 换好的页面刷新、换路由，新文档脚本自己会换；没换成的再试一次（页面信息一变就会来这里）。
    if (!entry.busy && !entry.applied && entry.attempts < maximumPageAttempts) void attach(info.targetId, entry)
  }

  function onEvent(method: string, params: Record<string, unknown>, sessionId: string | null): void {
    // 会话里的事件（Page.enable 以后的页面事件）不用看。
    if (stopped || sessionId !== null) return
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = readTargetInfo(params.targetInfo)
      if (info) consider(info)
    } else if (method === 'Target.targetDestroyed') {
      if (typeof params.targetId === 'string') pages.delete(params.targetId)
    } else if (method === 'Target.detachedFromTarget') {
      const detached = readSessionId(params.sessionId)
      for (const [targetId, entry] of pages) {
        if (detached !== null && entry.sessionId === detached) pages.delete(targetId)
      }
    }
  }

  async function run(): Promise<void> {
    const portOutcome = await waitForOwnedPort()
    if (stopped) return
    if (portOutcome) {
      finish(portOutcome)
      return
    }
    let endpoint: string | null = null
    for (let attempt = 1; !endpoint; attempt += 1) {
      try {
        endpoint = await readBrowserEndpoint()
      } catch (error) {
        if (attempt >= endpointAttempts) throw error
        await delay(portPollMs)
      }
      if (stopped) return
    }
    const opened = createWebSocket(endpoint)
    socket = opened
    await waitForOpen(opened)
    if (stopped || socket !== opened) {
      try { opened.close(1000, 'done') } catch { /* 已经断了。 */ }
      return
    }
    connection = connectCdp(opened, onEvent, () => {
      socket = null
      connection = null
      finish({ status: 'skipped', reason: 'closed', ...(lastPageError ? { error: lastPageError } : {}) })
    })
    noPageTimer = setTimeout(() => {
      finish({ status: 'skipped', reason: 'no-page', ...(lastPageError ? { error: lastPageError } : {}) })
    }, noPageDeadlineMs)
    noPageTimer.unref?.()
    await connection.send('Target.setDiscoverTargets', { discover: true })
  }

  void run().catch((error: unknown) => {
    if (stopped) return
    finish({ status: 'skipped', reason: 'connection-failed', error: errorText(error) })
    closeSocket()
  })
  return { settled, stop }
}

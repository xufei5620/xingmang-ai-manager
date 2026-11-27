import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAntigravityDesktopDebugArguments,
  classifyAntigravityDebugPortOwnership,
  isAntigravityInterfacePage,
  parseAntigravityDebugPortListeners,
  pickAntigravityDebugPort,
  resolveMacAntigravityDebugPortListeners,
  validateAntigravityBrowserEndpoint,
  watchAntigravityDesktopChinese,
  type AntigravityCdpSocket,
  type AntigravityDebugPortListener,
  type AntigravityDesktopChineseOptions,
  type AntigravityDesktopChineseWatch,
} from './antigravity-desktop-cdp'
import { CommandRunnerError, type CommandResult, type CommandSpec, type runCommand } from './command-runner'

const port = 41234
const processId = 4242
const browserEndpoint = `ws://127.0.0.1:${port}/devtools/browser/0b5e1c8a-1111-2222-3333-444455556666`
const appPage = { targetId: 'APP1', type: 'page', url: 'https://127.0.0.1:50123/' }
const injection = '((dictionary) => "stand-in")({"version":"1.0.3"})'
const injectionResult = JSON.stringify({ runtimeVersion: 1, version: '1.0.3', depth: 'deep', translated: 7 })

interface SentMessage {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

type Listener = (event: { data?: unknown }) => void

/** A stand-in for Chromium's browser-level DevTools socket: answers the commands this module sends. */
class FakeBrowserSocket implements AntigravityCdpSocket {
  readyState = 0
  readonly sent: SentMessage[] = []
  readonly url: string
  evaluationValue: unknown = injectionResult
  closedByUs = false
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string, private readonly initialTargets: Array<{ targetId: string, type: string, url: string }>) {
    this.url = url
    queueMicrotask(() => {
      this.readyState = 1
      this.dispatch('open', {})
    })
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    const message = JSON.parse(data) as SentMessage
    this.sent.push(message)
    queueMicrotask(() => this.answer(message))
  }

  close(): void {
    this.closedByUs = true
    this.closeFromPeer()
  }

  closeFromPeer(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close', {})
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.dispatch('message', { data: JSON.stringify(sessionId ? { method, params, sessionId } : { method, params }) })
  }

  sessionMethods(sessionId: string): string[] {
    return this.sent.filter((message) => message.sessionId === sessionId).map((message) => message.method)
  }

  private reply(id: number, result: Record<string, unknown>, sessionId?: string): void {
    this.dispatch('message', { data: JSON.stringify(sessionId ? { id, result, sessionId } : { id, result }) })
  }

  private answer(message: SentMessage): void {
    switch (message.method) {
      case 'Target.setDiscoverTargets':
        this.reply(message.id, {})
        for (const targetInfo of this.initialTargets) this.emit('Target.targetCreated', { targetInfo: { ...targetInfo, attached: false } })
        return
      case 'Target.attachToTarget':
        this.reply(message.id, { sessionId: `S-${String(message.params.targetId)}` })
        return
      case 'Page.addScriptToEvaluateOnNewDocument':
        this.reply(message.id, { identifier: '1' }, message.sessionId)
        return
      case 'Runtime.evaluate':
        this.reply(message.id, { result: { type: 'string', value: this.evaluationValue } }, message.sessionId)
        return
      default:
        this.reply(message.id, {}, message.sessionId)
    }
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

function versionFetch(endpoint: unknown = browserEndpoint): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ Browser: 'Chrome/140', webSocketDebuggerUrl: endpoint }), { status: 200 }))
}

const watches: AntigravityDesktopChineseWatch[] = []

interface Started {
  watch: AntigravityDesktopChineseWatch
  sockets: FakeBrowserSocket[]
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
  logs: Array<{ level: string, event: string, detail?: Record<string, unknown> }>
}

function start(overrides: Partial<AntigravityDesktopChineseOptions> = {}, targets = [appPage], prepare?: (socket: FakeBrowserSocket) => void): Started {
  const sockets: FakeBrowserSocket[] = []
  const logs: Started['logs'] = []
  const fetchImpl = versionFetch()
  const watch = watchAntigravityDesktopChinese({
    port,
    processId,
    injection,
    resolveListeners: async () => [{ processId, address: `127.0.0.1:${port}` }],
    fetch: fetchImpl,
    createWebSocket: (url) => {
      const socket = new FakeBrowserSocket(url, targets)
      prepare?.(socket)
      sockets.push(socket)
      return socket
    },
    delay: async () => undefined,
    log: (level, event, _message, detail) => { logs.push({ level, event, ...(detail ? { detail } : {}) }) },
    ...overrides,
  })
  watches.push(watch)
  return { watch, sockets, fetch: (overrides.fetch as Started['fetch'] | undefined) ?? fetchImpl, logs }
}

afterEach(() => {
  for (const watch of watches.splice(0)) watch.stop()
})

describe('Antigravity debugging port helpers', () => {
  it('adds only the debugging port flag to the launch', () => {
    expect(buildAntigravityDesktopDebugArguments(port)).toEqual([`--remote-debugging-port=${port}`])
    for (const value of [0, -1, 65_536, 1.5, Number.NaN]) expect(() => buildAntigravityDesktopDebugArguments(value)).toThrow('调试口无效')
  })

  it('picks a free loopback port', async () => {
    const picked = await pickAntigravityDebugPort()
    expect(Number.isInteger(picked) && picked > 0 && picked <= 65_535).toBe(true)
  })

  it('reads lsof field output into listeners and refuses what it cannot read', () => {
    expect(parseAntigravityDebugPortListeners('p512\nn127.0.0.1:43081\n')).toEqual([{ processId: 512, address: '127.0.0.1:43081' }])
    expect(parseAntigravityDebugPortListeners('p1\nf3\nn127.0.0.1:9\nn[::1]:9\np2\nf4\nn*:9\n')).toEqual([
      { processId: 1, address: '127.0.0.1:9' },
      { processId: 1, address: '[::1]:9' },
      { processId: 2, address: '*:9' },
    ])
    expect(parseAntigravityDebugPortListeners('')).toEqual([])
    for (const output of ['n127.0.0.1:9', 'pabc\nn127.0.0.1:9', 'p0\nn127.0.0.1:9', 'p1\nn', 'p99999999999\nn127.0.0.1:9']) {
      expect(parseAntigravityDebugPortListeners(output)).toBeNull()
    }
  })

  it('counts the port as owned only when every listener is the started process on loopback', () => {
    const own = (address: string): AntigravityDebugPortListener => ({ processId, address })
    expect(classifyAntigravityDebugPortOwnership([], port, processId)).toBe('unbound')
    expect(classifyAntigravityDebugPortOwnership([own(`127.0.0.1:${port}`)], port, processId)).toBe('owned')
    expect(classifyAntigravityDebugPortOwnership([own(`127.0.0.1:${port}`), own(`[::1]:${port}`)], port, processId)).toBe('owned')
    expect(classifyAntigravityDebugPortOwnership([own(`*:${port}`)], port, processId)).toBe('refused')
    expect(classifyAntigravityDebugPortOwnership([own(`192.168.1.5:${port}`)], port, processId)).toBe('refused')
    expect(classifyAntigravityDebugPortOwnership([own(`127.0.0.1:${port + 1}`)], port, processId)).toBe('refused')
    expect(classifyAntigravityDebugPortOwnership([own('garbage')], port, processId)).toBe('refused')
    expect(classifyAntigravityDebugPortOwnership([own(`127.0.0.1:${port}`), { processId: 77, address: `127.0.0.1:${port}` }], port, processId)).toBe('refused')
  })

  it('asks lsof for listeners on the port and reads "nothing found" as nobody listening', async () => {
    const calls: Array<{ spec: CommandSpec, trustedOnly: unknown }> = []
    const result = (spec: CommandSpec, stdout: string): CommandResult => ({ executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: stdout.length, durationMs: 1 })
    const listing: typeof runCommand = async (spec, options) => {
      calls.push({ spec, trustedOnly: options?.trustedOnly })
      return result(spec, `p${processId}\nn127.0.0.1:${port}\n`)
    }
    await expect(resolveMacAntigravityDebugPortListeners(port, { env: { PATH: '/evil' }, run: listing })).resolves.toEqual([{ processId, address: `127.0.0.1:${port}` }])
    expect(calls[0]).toEqual({ spec: { executable: '/usr/sbin/lsof', argv: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'] }, trustedOnly: false })

    const refusal = (exitCode: number, stdout: string) => new CommandRunnerError('lsof 退出', {
      code: 'EXIT_NON_ZERO', executable: '/usr/sbin/lsof', argv: [], exitCode, signal: null, stdout, stderr: '', outputBytes: 0, maxOutputBytes: 1, durationMs: 1,
    })
    await expect(resolveMacAntigravityDebugPortListeners(port, { env: {}, run: async () => { throw refusal(1, '') } })).resolves.toEqual([])
    await expect(resolveMacAntigravityDebugPortListeners(port, { env: {}, run: async () => { throw refusal(1, 'p1\n') } })).rejects.toThrow('lsof 退出')
    await expect(resolveMacAntigravityDebugPortListeners(port, { env: {}, run: async () => { throw refusal(2, '') } })).rejects.toThrow('lsof 退出')
    await expect(resolveMacAntigravityDebugPortListeners(port, { env: {}, run: async (spec) => result(spec, 'n127.0.0.1:1\n') })).rejects.toThrow('看不懂')
  })

  it('treats only Antigravity\'s own interface pages as places for the script', () => {
    const page = (url: string, type = 'page') => isAntigravityInterfacePage({ targetId: 'T', type, url })
    expect(page('https://127.0.0.1:50123/')).toBe(true)
    expect(page('https://localhost:50123/agent?x=1')).toBe(true)
    expect(page('https://[::1]:50123/')).toBe(true)
    expect(page('vscode-file://vscode-app/Applications/Antigravity.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html')).toBe(true)
    expect(page('vscode-file://vscode-app/x/workbench-jetski-agent.html')).toBe(true)
    expect(page('https://127.0.0.1:50123/', 'iframe')).toBe(false)
    expect(page('https://127.0.0.1:50123/', 'service_worker')).toBe(false)
    expect(page('http://127.0.0.1:50123/')).toBe(false)
    expect(page('https://127.0.0.1/')).toBe(false)
    expect(page('https://user:secret@127.0.0.1:50123/')).toBe(false)
    expect(page('https://accounts.google.com/')).toBe(false)
    expect(page('https://127.0.0.1.example.com:443/')).toBe(false)
    expect(page('vscode-file://vscode-app/x/sharedProcess.html')).toBe(false)
    expect(page('vscode-webview://abc/index.html')).toBe(false)
    expect(page('devtools://devtools/bundled/inspector.html')).toBe(false)
    expect(page('about:blank')).toBe(false)
    expect(page('not a url')).toBe(false)
  })

  it('accepts only the loopback browser endpoint on the same port', () => {
    expect(validateAntigravityBrowserEndpoint(browserEndpoint, port)).toBe(browserEndpoint)
    for (const value of [
      `ws://127.0.0.1:${port + 1}/devtools/browser/abc`,
      `ws://localhost:${port}/devtools/browser/abc`,
      `ws://192.168.1.5:${port}/devtools/browser/abc`,
      `wss://127.0.0.1:${port}/devtools/browser/abc`,
      `ws://127.0.0.1:${port}/devtools/page/abc`,
      `ws://127.0.0.1:${port}/devtools/browser/abc?x=1`,
      `ws://127.0.0.1:${port}/devtools/browser/abc#x`,
      `ws://u:p@127.0.0.1:${port}/devtools/browser/abc`,
      `ws://127.0.0.1:${port}/devtools/browser/../../evil`,
      42,
      null,
    ]) {
      expect(validateAntigravityBrowserEndpoint(value, port)).toBeNull()
    }
  })
})

describe('watchAntigravityDesktopChinese', () => {
  it('waits for the started process to own the port, then hooks and translates only interface pages', async () => {
    let lookups = 0
    const { watch, sockets, fetch: fetchImpl, logs } = start({
      resolveListeners: async () => (++lookups < 3 ? [] : [{ processId, address: `127.0.0.1:${port}` }]),
    }, [
      appPage,
      { targetId: 'BLANK', type: 'page', url: 'about:blank' },
      { targetId: 'FRAME', type: 'iframe', url: 'https://127.0.0.1:50123/frame' },
      { targetId: 'WORKER', type: 'service_worker', url: 'https://127.0.0.1:50123/sw.js' },
    ])
    await expect(watch.settled).resolves.toEqual({ status: 'applied', result: { runtimeVersion: 1, version: '1.0.3', depth: 'deep', translated: 7 } })
    expect(lookups).toBe(3)
    expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:${port}/json/version`, expect.objectContaining({ redirect: 'error' }))
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe(browserEndpoint)
    const socket = sockets[0]
    expect(socket.sent.filter((message) => message.method === 'Target.attachToTarget').map((message) => message.params)).toEqual([{ targetId: 'APP1', flatten: true }])
    expect(socket.sessionMethods('S-APP1')).toEqual(['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate'])
    const hook = socket.sent.find((message) => message.method === 'Page.addScriptToEvaluateOnNewDocument')
    const evaluation = socket.sent.find((message) => message.method === 'Runtime.evaluate')
    expect(hook?.params).toEqual({ source: injection })
    expect(evaluation?.params).toEqual({ expression: injection, returnByValue: true, awaitPromise: false })
    expect(logs).toContainEqual({ level: 'info', event: 'antigravity.desktop.chinese.applied', detail: { port, pages: 1, translated: 7, version: '1.0.3', depth: 'deep' } })
    expect(socket.closedByUs).toBe(false)
  })

  it('gives up without connecting when another process listens on the port', async () => {
    const createWebSocket = vi.fn()
    const { watch, fetch: fetchImpl, logs } = start({
      resolveListeners: async () => [{ processId, address: `127.0.0.1:${port}` }, { processId: 77, address: `127.0.0.1:${port}` }],
      createWebSocket,
    })
    await expect(watch.settled).resolves.toEqual(expect.objectContaining({ status: 'skipped', reason: 'port-refused' }))
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(createWebSocket).not.toHaveBeenCalled()
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', event: 'antigravity.desktop.chinese.skipped', detail: expect.objectContaining({ reason: 'port-refused' }) }))
  })

  it('gives up without connecting when the debugging port listens beyond loopback', async () => {
    const { watch, fetch: fetchImpl } = start({ resolveListeners: async () => [{ processId, address: `*:${port}` }] })
    await expect(watch.settled).resolves.toEqual(expect.objectContaining({ reason: 'port-refused' }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('gives up after three failed lookups and never sends anything', async () => {
    let lookups = 0
    const { watch, fetch: fetchImpl } = start({ resolveListeners: async () => { lookups += 1; throw new Error('lsof 超时') } })
    await expect(watch.settled).resolves.toEqual({ status: 'skipped', reason: 'port-unconfirmed', error: 'lsof 超时' })
    expect(lookups).toBe(3)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops waiting once the deadline passes with nobody on the port', async () => {
    let clock = 0
    const { watch, fetch: fetchImpl } = start({ resolveListeners: async () => [], now: () => (clock += 10_000) })
    await expect(watch.settled).resolves.toEqual({ status: 'skipped', reason: 'not-ready' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a browser endpoint that points anywhere but the checked port', async () => {
    const fetchImpl = versionFetch(`ws://127.0.0.1:${port + 1}/devtools/browser/abc`)
    const createWebSocket = vi.fn()
    const { watch } = start({ fetch: fetchImpl, createWebSocket })
    await expect(watch.settled).resolves.toEqual(expect.objectContaining({ status: 'skipped', reason: 'connection-failed' }))
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(createWebSocket).not.toHaveBeenCalled()
  })

  it('follows new windows and navigations, and drops a page that leaves the interface', async () => {
    const { watch, sockets } = start()
    await watch.settled
    const socket = sockets[0]
    socket.emit('Target.targetCreated', { targetInfo: { targetId: 'APP2', type: 'page', url: 'about:blank', attached: false } })
    socket.emit('Target.targetInfoChanged', { targetInfo: { targetId: 'APP2', type: 'page', url: 'https://127.0.0.1:50123/agent', attached: false } })
    await vi.waitFor(() => expect(socket.sessionMethods('S-APP2')).toEqual(['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate']))

    // An in-app navigation of a translated page needs nothing: the new-document hook does it.
    socket.emit('Target.targetInfoChanged', { targetInfo: { targetId: 'APP1', type: 'page', url: 'https://127.0.0.1:50123/settings', attached: true } })
    socket.emit('Target.targetInfoChanged', { targetInfo: { targetId: 'APP1', type: 'page', url: 'https://accounts.google.com/', attached: true } })
    await vi.waitFor(() => expect(socket.sent.filter((message) => message.method === 'Target.detachFromTarget').map((message) => message.params)).toEqual([{ sessionId: 'S-APP1' }]))
    expect(socket.sent.filter((message) => message.method === 'Target.attachToTarget')).toHaveLength(2)
  })

  it('ignores events from inside a page session and malformed messages', async () => {
    const { watch, sockets } = start()
    await watch.settled
    const socket = sockets[0]
    socket.emit('Target.targetCreated', { targetInfo: { targetId: 'APP3', type: 'page', url: 'https://127.0.0.1:50123/' } }, 'S-APP1')
    socket.emit('Target.targetCreated', { targetInfo: { targetId: '../../x', type: 'page', url: 'https://127.0.0.1:50123/' } })
    socket.emit('Target.targetCreated', { targetInfo: 'nope' })
    for (const listener of ['not json', '[]', JSON.stringify({ id: 999, result: {} })]) {
      ;(socket as unknown as { dispatch(type: string, event: { data?: unknown }): void }).dispatch('message', { data: listener })
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(socket.sent.filter((message) => message.method === 'Target.attachToTarget')).toHaveLength(1)
  })

  it('logs a page whose script did not report back and retries it once', async () => {
    const { watch, sockets, logs } = start({}, [appPage], (created) => { created.evaluationValue = 'not the runtime' })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]
    await vi.waitFor(() => expect(logs.some((entry) => entry.event === 'antigravity.desktop.chinese.page-failed')).toBe(true))
    socket.evaluationValue = injectionResult
    socket.emit('Target.targetInfoChanged', { targetInfo: { ...appPage, attached: true } })
    await expect(watch.settled).resolves.toEqual(expect.objectContaining({ status: 'applied' }))
    expect(socket.sent.filter((message) => message.method === 'Target.attachToTarget')).toHaveLength(1)
    expect(socket.sessionMethods('S-APP1').filter((method) => method === 'Runtime.evaluate')).toHaveLength(2)
  })

  it('settles as closed when Antigravity goes away before any page is translated', async () => {
    const { watch, sockets } = start({}, [])
    await vi.waitFor(() => expect(sockets[0]?.sent.some((message) => message.method === 'Target.setDiscoverTargets')).toBe(true))
    sockets[0].closeFromPeer()
    await expect(watch.settled).resolves.toEqual({ status: 'skipped', reason: 'closed' })
  })

  it('stops before connecting, and closes the connection when stopped later', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const early = start({ resolveListeners: async () => { await gate; return [{ processId, address: `127.0.0.1:${port}` }] } })
    early.watch.stop()
    release()
    await expect(early.watch.settled).resolves.toEqual({ status: 'skipped', reason: 'stopped' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(early.fetch).not.toHaveBeenCalled()
    expect(early.logs).toEqual([])

    const later = start()
    await later.watch.settled
    later.watch.stop()
    expect(later.sockets[0].closedByUs).toBe(true)
  })

  it('rejects a process id it could not have started', () => {
    for (const value of [0, -1, 1.5]) {
      expect(() => watchAntigravityDesktopChinese({ port, processId: value, injection, resolveListeners: async () => [] })).toThrow('进程号无效')
    }
  })
})

describe('Antigravity debugging port with random inputs', () => {
  it('never counts a port as owned unless every listener is the started process on loopback and the same port', () => {
    const listener = fc.record({
      processId: fc.oneof(fc.constant(processId), fc.integer({ min: 1, max: 100_000 })),
      address: fc.oneof(
        fc.constantFrom(`127.0.0.1:${port}`, `[::1]:${port}`, `*:${port}`, `0.0.0.0:${port}`, `127.0.0.1:${port + 1}`, `10.0.0.2:${port}`),
        fc.string({ maxLength: 30 }),
      ),
    })
    fc.assert(fc.property(fc.array(listener, { maxLength: 6 }), (listeners) => {
      const ownership = classifyAntigravityDebugPortOwnership(listeners, port, processId)
      if (ownership === 'owned') {
        expect(listeners.length).toBeGreaterThan(0)
        for (const entry of listeners) {
          expect(entry.processId).toBe(processId)
          expect([`127.0.0.1:${port}`, `[::1]:${port}`, `localhost:${port}`]).toContain(entry.address.toLowerCase())
        }
      }
      if (ownership === 'unbound') expect(listeners).toEqual([])
    }))
  })
})

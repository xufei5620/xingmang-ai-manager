import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  activateCodexDesktopWithCdp,
  buildCodexDesktopCdpArguments,
  classifyCodexDesktopCdpPortOwnership,
  codexChineseRuntimeScript,
  codexDesktopCdpPortOwnerArguments,
  filterCodexDesktopCdpTargets,
  injectCodexDesktopChineseLocale,
  parseCodexDesktopCdpPortOwners,
  parseCodexDesktopActivationProcessId,
  resolveCodexDesktopCdpPortOwners,
  validateCodexDesktopAppUserModelId,
  validateCodexDesktopCdpPort,
  validateCodexDesktopCdpTarget,
  withCodexDesktopCdpFailureReport,
  type CodexDesktopCdpTarget,
} from './codex-desktop-cdp'

const codexProcessId = 4321
// What execFile puts in the message when it stops the owner lookup at its limit.
const ownerLookupCommandLine = 'C:\\Windows\\System32\\netstat.exe -a -n -o'
const codexPortOwner = {
  expectedProcessId: codexProcessId,
  resolvePortOwnerProcessIds: async () => [codexProcessId],
}
const windowsMachinePaths = {
  systemRoot: 'C:\\Windows',
  system32: 'C:\\Windows\\System32',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  programData: 'C:\\ProgramData',
}
// `netstat -a -n -o` as English Windows prints it, with Codex (4321) on 9222.
const netstatTable = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1060',
  '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       4321',
  '  TCP    127.0.0.1:9222         127.0.0.1:50123        ESTABLISHED     4321',
  '  TCP    127.0.0.1:9222         127.0.0.1:50124        TIME_WAIT       0',
  '  TCP    127.0.0.1:19222        0.0.0.0:0              LISTENING       5555',
  '  TCP    127.0.0.1:50123        127.0.0.1:9222         ESTABLISHED     2468',
  '  TCP    192.168.1.5:9222       52.1.2.3:443           ESTABLISHED     7788',
  '  TCP    [::]:135               [::]:0                 LISTENING       1060',
  '  TCP    [::1]:9222             [::]:0                 LISTENING       4321',
  '  UDP    0.0.0.0:9222           *:*                                    8888',
  '  UDP    [::]:9222              *:*                                    8888',
  '',
].join('\r\n')

// netstat writes to a pipe in the console code page and execFile decodes its
// stdout as UTF-8, so on Windows in other languages this is what the parser is
// handed. Strings are ASCII; buffers are bytes in that code page.
function decodedAsExecFileDoes(lines: ReadonlyArray<string | ReadonlyArray<string | Buffer>>): string {
  return Buffer.concat(lines.flatMap((line) => [
    ...(typeof line === 'string' ? [line] : line).map((part) => typeof part === 'string' ? Buffer.from(part, 'ascii') : part),
    Buffer.from('\r\n', 'ascii'),
  ])).toString('utf8')
}
// 活动连接 and the header 协议 本地地址 外部地址 状态, as Simplified Chinese Windows
// writes them: in GBK (code page 936). The states stay in English there.
const chineseNetstat = decodedAsExecFileDoes([
  '',
  [Buffer.from('bbeeb6afc1acbdd3', 'hex')],
  '',
  ['  ', Buffer.from('d0add2e9', 'hex'), '  ', Buffer.from('b1beb5d8b5d8d6b7', 'hex'), '          ',
    Buffer.from('cde2b2bfb5d8d6b7', 'hex'), '        ', Buffer.from('d7b4ccac', 'hex'), '           PID'],
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1060',
  '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       4321',
  '  TCP    127.0.0.1:9222         127.0.0.1:50123        ESTABLISHED     4321',
  '  TCP    127.0.0.1:9222         127.0.0.1:50124        TIME_WAIT       0',
  '  TCP    127.0.0.1:50123        127.0.0.1:9222         ESTABLISHED     2468',
  '  TCP    [::]:135               [::]:0                 LISTENING       1060',
  '  UDP    0.0.0.0:9222           *:*                                    8888',
])
// ABHÖREN, German Windows's LISTENING, in code page 850.
const abhoeren = ['ABH', Buffer.from([0x99]), 'REN']
const germanNetstat = decodedAsExecFileDoes([
  '',
  'Aktive Verbindungen',
  '',
  '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
  ['  TCP    0.0.0.0:135            0.0.0.0:0              ', ...abhoeren, '         1060'],
  ['  TCP    127.0.0.1:9222         0.0.0.0:0              ', ...abhoeren, '         4321'],
  '  TCP    127.0.0.1:9222         127.0.0.1:50123        HERGESTELLT     4321',
  '  TCP    127.0.0.1:9222         127.0.0.1:50124        WARTEND         0',
  '  TCP    127.0.0.1:50125        127.0.0.1:9222         SCHLIESSEN_WARTEN  2468',
  ['  TCP    [::]:135               [::]:0                 ', ...abhoeren, '         1060'],
  '  UDP    0.0.0.0:9222           *:*                                    8888',
])

function target(overrides: Partial<CodexDesktopCdpTarget> = {}): CodexDesktopCdpTarget {
  return {
    id: 'page-1',
    type: 'page',
    url: 'file:///C:/Program%20Files/WindowsApps/OpenAI.Codex/app.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1',
    ...overrides,
  }
}

function runtimeHarness(initialRoot?: unknown) {
  class TestNavigator {}
  let now = 0
  const intervals = new Map<number, () => void>()
  let nextTimer = 0
  const context = vm.createContext({
    __STATSIG__: initialRoot,
    Navigator: TestNavigator,
    navigator: new TestNavigator(),
    Date: { now: () => now },
    setInterval: (callback: () => void) => { intervals.set(++nextTimer, callback); return nextTimer },
    clearInterval: (id: number) => intervals.delete(id),
  })
  return {
    context,
    run: () => vm.runInContext(codexChineseRuntimeScript, context),
    state: () => vm.runInContext('globalThis.__xingmangCodexChineseLocaleState', context) as {
      patchedClients: number; patchedConfigs: number; localeReads: number
    },
    tick: (milliseconds: number) => { now += milliseconds; for (const callback of intervals.values()) callback() },
  }
}

const readyProbe = {
  codexRendererProbe: true,
  hasBridge: true,
  hasAppRoot: true,
  textLength: 120,
  documentReady: true,
  documentIdentity: 1_000,
  patchInstalled: true,
  patchReady: true,
  localeReadObserved: true,
  navigatorLocale: 'zh-CN',
}

function mockCdpSocket(
  probe: () => Record<string, unknown> = () => readyProbe,
  onCommand?: (message: { method: string; params: Record<string, unknown> }) => void,
) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []
  const listeners = new Map<string, Set<(event: any) => void>>()
  let closed = false
  const socket = {
    readyState: 1,
    send(payload: string) {
      if (closed) throw new Error('socket already closed')
      const message = JSON.parse(payload) as { id: number; method: string; params: Record<string, unknown> }
      sent.push({ method: message.method, params: message.params })
      onCommand?.(message)
      const result = message.method === 'Runtime.evaluate' && String(message.params.expression).includes('codexRendererProbe')
        ? { result: { value: JSON.stringify(probe()) } }
        : {}
      const event = { data: JSON.stringify({ id: message.id, result }) }
      listeners.get('message')?.forEach((listener) => listener(event))
    },
    close() { closed = true; socket.readyState = 3 },
    addEventListener(type: string, listener: (event: any) => void) {
      const values = listeners.get(type) ?? new Set()
      values.add(listener)
      listeners.set(type, values)
    },
    removeEventListener(type: string, listener: (event: any) => void) {
      listeners.get(type)?.delete(listener)
    },
  }
  return { socket, sent, isClosed: () => closed }
}

describe('Codex Desktop CDP trust boundary', () => {
  it('parses the trusted AppX activation process id without accepting invalid output', () => {
    expect(parseCodexDesktopActivationProcessId(' 18420\r\n')).toBe(18420)
    expect(parseCodexDesktopActivationProcessId('')).toBeNull()
    expect(parseCodexDesktopActivationProcessId('0')).toBeNull()
    expect(parseCodexDesktopActivationProcessId('not-a-pid')).toBeNull()
    expect(parseCodexDesktopActivationProcessId('18420 extra')).toBeNull()
  })

  it('validates the loopback port and produces explicit Chromium arguments', () => {
    expect(validateCodexDesktopCdpPort(9222)).toBe(9222)
    expect(buildCodexDesktopCdpArguments(9222)).toBe(
      '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --remote-allow-origins=http://127.0.0.1:9222 --lang=zh-CN',
    )
    expect(() => validateCodexDesktopCdpPort(0)).toThrow('端口无效')
    expect(() => validateCodexDesktopCdpPort(65_536)).toThrow('端口无效')
  })

  it('accepts only page targets on the current loopback port', () => {
    expect(validateCodexDesktopCdpTarget(target(), 9222)).toBe('ws://127.0.0.1:9222/devtools/page/page-1')
    expect(validateCodexDesktopCdpTarget(target({ webSocketDebuggerUrl: 'ws://192.168.1.2:9222/devtools/page/page-1' }), 9222)).toBeNull()
    expect(validateCodexDesktopCdpTarget(target({ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/page-1' }), 9222)).toBeNull()
    expect(validateCodexDesktopCdpTarget(target({ type: 'service_worker' }), 9222)).toBeNull()
    expect(validateCodexDesktopCdpTarget(target({ type: 'iframe' }), 9222)).toBe('ws://127.0.0.1:9222/devtools/page/page-1')
    expect(validateCodexDesktopCdpTarget(target({ url: 'devtools://devtools/bundled/inspector.html' }), 9222)).toBeNull()
    expect(validateCodexDesktopCdpTarget(target({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1?token=secret' }), 9222)).toBeNull()
    expect(filterCodexDesktopCdpTargets([
      target(),
      target({ id: 'bad', webSocketDebuggerUrl: 'ws://example.test:9222/devtools/page/bad' }),
    ], 9222)).toHaveLength(1)
  })

  it('validates the AppX identity before composing activation arguments', () => {
    expect(validateCodexDesktopAppUserModelId('OpenAI.Codex_2p2nqsd0c76g0!App')).toBe('OpenAI.Codex_2p2nqsd0c76g0!App')
    expect(() => validateCodexDesktopAppUserModelId('Contoso.App!App')).toThrow('应用标识不可信')
    expect(() => validateCodexDesktopAppUserModelId('OpenAI.Codex_foo!App --evil')).toThrow('应用标识不可信')
  })
})

describe('Codex Desktop CDP activation failures', () => {
  it('keeps the activation failure as the cause of the Chinese launch error', async () => {
    // Off Windows the activation refuses the platform, on Windows it refuses
    // this identity; both happen before PowerShell would be started.
    const error = await activateCodexDesktopWithCdp('Contoso.App!App', 9222).then(() => null, (reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    const cause = (error as Error).cause
    expect(cause).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(`Codex Desktop 中文增强启动失败：${(cause as Error).message}`)
  })

  it('reports a failed activation and still rejects with the same error', async () => {
    const failure = new Error('Codex Desktop 中文增强启动失败：激活被拒绝')
    const reported: unknown[] = []
    const activate = withCodexDesktopCdpFailureReport(async () => { throw failure }, (error) => { reported.push(error) })

    await expect(activate('OpenAI.Codex_2p2nqsd0c76g0!App', 9222)).rejects.toBe(failure)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toBe(failure)
  })

  it('passes a successful activation through without reporting anything', async () => {
    const calls: unknown[][] = []
    const environment = { SystemRoot: 'C:\\Windows' }
    const activate = withCodexDesktopCdpFailureReport(async (appUserModelId, port, baseEnv) => {
      calls.push([appUserModelId, port, baseEnv])
      return 18420
    }, () => { throw new Error('a successful activation has nothing to report') })

    await expect(activate('OpenAI.Codex_2p2nqsd0c76g0!App', 9222, environment)).resolves.toBe(18420)
    expect(calls).toEqual([['OpenAI.Codex_2p2nqsd0c76g0!App', 9222, environment]])
  })
})

describe('Codex Desktop Chinese CDP injection', () => {
  it('keeps the injected browser script syntactically valid as a standalone document hook', () => {
    expect(() => new Function(codexChineseRuntimeScript)).not.toThrow()
    expect(codexChineseRuntimeScript).toContain('getLayer')
    expect(codexChineseRuntimeScript).toContain('getDynamicConfig')
    expect(codexChineseRuntimeScript).not.toContain('JSON.stringify({ params })')
  })

  it('forces the current and future Statsig layer reads to enable i18n', () => {
    let forwardedArguments: unknown[] = []
    const config = {
      value: { enable_i18n: false, locale_source: 'REMOTE' },
      get(key: string, fallback: unknown, ..._options: unknown[]) {
        forwardedArguments = [...arguments]
        return key === 'enable_i18n' ? fallback : this.value[key as keyof typeof this.value]
      },
    }
    const root = {
      getLayer: (key: string) => key === '72216192' ? config : null,
    }
    const context = {
      __STATSIG__: root,
      Navigator: function Navigator() {},
      navigator: {},
      document: { readyState: 'loading' },
      sessionStorage: { getItem: () => null, setItem: () => undefined },
      window: { location: { reload: () => undefined } },
      setInterval: () => 1,
      clearInterval: () => undefined,
      setTimeout: () => 1,
      JSON,
      Date,
      Math,
      Object,
      Set,
    }

    vm.runInNewContext(codexChineseRuntimeScript, context)

    expect(root.getLayer('72216192')!.get('enable_i18n', false)).toBe(true)
    expect(root.getLayer('72216192')!.get('locale_source', 'REMOTE')).toBe('SYSTEM')
    root.getLayer('72216192')!.get('other', 'fallback', { disableExposureLog: true })
    expect(forwardedArguments).toEqual(['other', 'fallback', { disableExposureLog: true }])
    expect(config.value).toMatchObject({ enable_i18n: true, locale_source: 'SYSTEM' })
  })

  it('patches a late Statsig root before its synchronous first locale read', () => {
    const harness = runtimeHarness()
    harness.run()
    expect(harness.state().localeReads).toBe(0)
    const result = vm.runInContext(`
      globalThis.__STATSIG__ = {
        getLayer: () => ({ value: {}, get: (_key, fallback) => fallback }),
      };
      globalThis.__STATSIG__.getLayer("72216192").get("enable_i18n", false);
    `, harness.context)
    expect(result).toBe(true)
    expect(harness.state().localeReads).toBe(1)
  })

  it('patches a client published later through firstInstance and does not count its own capability checks as app reads', () => {
    const harness = runtimeHarness({})
    harness.run()
    vm.runInContext(`globalThis.__STATSIG__.firstInstance = {
      getDynamicConfig: () => ({ value: {}, get: (_key, fallback) => fallback }),
    };`, harness.context)
    expect(harness.state().patchedConfigs).toBeGreaterThan(0)
    expect(harness.state().localeReads).toBe(0)
    expect(vm.runInContext('globalThis.__STATSIG__.firstInstance.getDynamicConfig("72216192").get("locale_source", "REMOTE")', harness.context)).toBe('SYSTEM')
    expect(harness.state().localeReads).toBe(1)
  })

  it('continues watching after the first patched config when async initialization replaces the client', () => {
    const oldConfig = { value: {}, get: (_key: string, fallback: unknown) => fallback }
    const root = { instances: { first: { getLayer: () => oldConfig } } }
    const harness = runtimeHarness(root)
    harness.run()
    harness.tick(50)
    const newConfig = { value: {}, get: (_key: string, fallback: unknown) => fallback }
    root.instances.first = { getLayer: () => newConfig }
    harness.tick(50)
    expect(root.instances.first.getLayer().get('enable_i18n', false)).toBe(true)
    expect(harness.state().patchedClients).toBe(2)
  })

  it('allows SDK method replacement and reapplies locale overrides after asynchronous initialization', () => {
    const config = { value: {}, get: (_key: string, fallback: unknown) => fallback }
    const root = { getLayer: () => config }
    const harness = runtimeHarness(root)
    harness.run()
    root.getLayer = () => config
    config.get = (_key: string, fallback: unknown) => fallback
    harness.tick(50)
    expect(root.getLayer().get('enable_i18n', false)).toBe(true)
  })

  it('does not report a frozen config as patched when assignments silently fail', () => {
    const config = Object.freeze({
      value: Object.freeze({ enable_i18n: false, locale_source: 'REMOTE' }),
      get: (_key: string, fallback: unknown) => fallback,
    })
    const harness = runtimeHarness({ getLayer: () => config })
    harness.run()
    expect(harness.state().patchedClients).toBe(1)
    expect(harness.state().patchedConfigs).toBe(0)
    expect(harness.state().localeReads).toBe(0)
  })

  it('keeps existing Statsig accessor semantics and makes reinjection idempotent', () => {
    const root = { getLayer: () => ({ value: {}, get: (_key: string, fallback: unknown) => fallback }) }
    const harness = runtimeHarness()
    let reads = 0
    Object.defineProperty(harness.context, '__STATSIG__', { configurable: true, get: () => { reads += 1; return root } })
    const getter = Object.getOwnPropertyDescriptor(harness.context, '__STATSIG__')?.get
    harness.run()
    const firstState = harness.state()
    harness.run()
    expect(Object.getOwnPropertyDescriptor(harness.context, '__STATSIG__')?.get).toBe(getter)
    expect(harness.state()).toBe(firstState)
    expect(reads).toBeGreaterThan(0)
    expect(harness.state().localeReads).toBe(0)
  })

  it('restores tracked SDK wrappers if the runtime state is lost in the same document', () => {
    const config = { value: {}, get: (_key: string, fallback: unknown) => fallback }
    const root = { getLayer: () => config }
    const harness = runtimeHarness(root)
    harness.run()
    const previousState = harness.state()
    vm.runInContext('delete globalThis.__xingmangCodexChineseLocaleState', harness.context)
    harness.run()
    expect(harness.state()).not.toBe(previousState)
    expect(harness.state().patchedClients).toBe(1)
    expect(harness.state().patchedConfigs).toBe(1)
    expect(harness.state().localeReads).toBe(0)
    expect(root.getLayer().get('enable_i18n', false)).toBe(true)
    expect(harness.state().localeReads).toBe(1)
  })

  it('registers the patch for future documents and evaluates it in the current page', async () => {
    const { socket, sent, isClosed } = mockCdpSocket()
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => socket,
      delay: async () => undefined,
    })

    expect(result).toEqual({ injectedTargets: 1, attempts: 1 })
    expect(sent.map((entry) => entry.method)).toEqual([
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
      'Runtime.evaluate',
    ])
    expect(String(sent[1]?.params.source)).toBe(codexChineseRuntimeScript.replace(/\(false\);$/, '(true);'))
    expect(String(sent[2]?.params.expression)).toContain('enable_i18n')
    expect(String(sent[2]?.params.expression)).toContain('locale_source')
    expect(isClosed()).toBe(true)
  })

  it('waits for late Statsig and document readiness, then verifies actual locale reads after one reload on the same session', async () => {
    let probes = 0
    let connections = 0
    const { socket, sent, isClosed } = mockCdpSocket(() => {
      probes += 1
      if (probes === 1) return { ...readyProbe, patchReady: false, localeReadObserved: false }
      if (probes === 2) return { ...readyProbe, documentReady: false, localeReadObserved: false }
      return { ...readyProbe, documentIdentity: probes >= 4 ? 2_000 : 1_000, localeReadObserved: probes >= 4 }
    })
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => { connections += 1; return socket },
      delay: async () => { expect(isClosed()).toBe(false) },
    })
    expect(result).toEqual({ injectedTargets: 1, attempts: 4 })
    expect(connections).toBe(1)
    expect(sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(1)
    expect(sent.filter((entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1)
    expect(isClosed()).toBe(true)
  })

  it('runs the registered hook before application initialization in a replacement document', async () => {
    let page = runtimeHarness({ getLayer: () => ({ value: {}, get: (_key: string, fallback: unknown) => fallback }) })
    let registeredScript = ''
    let reloaded = 0
    const listeners = new Map<string, Set<(event: any) => void>>()
    const prepareDocument = () => {
      Object.assign(page.context, {
        document: { readyState: 'complete', body: { innerText: 'Codex desktop is ready' }, querySelector: () => ({}) },
        electronBridge: { sendMessageFromView() {} },
        performance: { timeOrigin: 1_000 + reloaded },
      })
    }
    prepareDocument()
    const socket = {
      readyState: 1,
      send(payload: string) {
        const request = JSON.parse(payload) as { id: number; method: string; params: Record<string, unknown> }
        let result: Record<string, unknown> = {}
        if (request.method === 'Page.addScriptToEvaluateOnNewDocument') registeredScript = String(request.params.source)
        if (request.method === 'Runtime.evaluate') result = { result: { value: vm.runInContext(String(request.params.expression), page.context) } }
        if (request.method === 'Page.reload') {
          reloaded += 1
          page = runtimeHarness()
          prepareDocument()
          vm.runInContext(registeredScript, page.context)
          expect(vm.runInContext(`
            globalThis.__STATSIG__ = { firstInstance: {
              getLayer: () => ({ value: {}, get: (_key, fallback) => fallback }),
            }};
            globalThis.__STATSIG__.firstInstance.getLayer("72216192").get("enable_i18n", false);
          `, page.context)).toBe(true)
        }
        listeners.get('message')?.forEach((listener) => listener({ data: JSON.stringify({ id: request.id, result }) }))
      },
      close() { socket.readyState = 3 },
      addEventListener(type: string, listener: (event: any) => void) {
        const values = listeners.get(type) ?? new Set()
        values.add(listener)
        listeners.set(type, values)
      },
      removeEventListener(type: string, listener: (event: any) => void) { listeners.get(type)?.delete(listener) },
    }
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => socket,
      delay: async () => undefined,
    })
    expect(result).toEqual({ injectedTargets: 1, attempts: 2 })
    expect(page.state().localeReads).toBe(1)
    expect(reloaded).toBe(1)
    expect(socket.readyState).toBe(3)
  })

  it('reinjects when a replacement document keeps the same target and endpoint but has no runtime state', async () => {
    let documentIdentity = 1_000
    let patchInstalled = false
    let runtimeApplications = 0
    let connections = 0
    const { socket, sent } = mockCdpSocket(() => ({
      ...readyProbe,
      documentIdentity,
      patchInstalled,
      patchReady: patchInstalled && documentIdentity === 2_000,
      localeReadObserved: patchInstalled && documentIdentity === 2_000,
    }), (command) => {
      if (command.method === 'Runtime.evaluate' && String(command.params.expression).includes('const configId')) {
        runtimeApplications += 1
        patchInstalled = true
      }
    })
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => { connections += 1; return socket },
      delay: async () => { documentIdentity = 2_000; patchInstalled = false },
    })
    expect(result).toEqual({ injectedTargets: 1, attempts: 2 })
    expect(connections).toBe(1)
    expect(runtimeApplications).toBe(2)
    expect(sent.filter((entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1)
    expect(sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(0)
  })

  it('waits for a new document after reload even when the old document begins reading the forced locale', async () => {
    let probes = 0
    const { socket, sent } = mockCdpSocket(() => {
      probes += 1
      return {
        ...readyProbe,
        documentIdentity: probes >= 4 ? 2_000 : 1_000,
        localeReadObserved: probes >= 2,
      }
    })
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => socket,
      delay: async () => undefined,
    })
    expect(result).toEqual({ injectedTargets: 1, attempts: 4 })
    expect(sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(1)
  })

  it('retains the pending document replacement check across a socket reconnection', async () => {
    const first = mockCdpSocket(() => ({ ...readyProbe, localeReadObserved: false }))
    let documentIdentity = 1_000
    const second = mockCdpSocket(() => ({ ...readyProbe, documentIdentity }))
    let connections = 0
    let delays = 0
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => ++connections === 1 ? first.socket : second.socket,
      delay: async () => {
        delays += 1
        first.socket.close()
        if (delays >= 3) documentIdentity = 2_000
      },
    })
    expect(result).toEqual({ injectedTargets: 2, attempts: 4 })
    expect(first.sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(1)
    expect(second.sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(0)
    expect(second.isClosed()).toBe(true)
  })

  it('bounds recovery when a renderer keeps losing the runtime state', async () => {
    const { socket, sent, isClosed } = mockCdpSocket(() => ({
      ...readyProbe,
      patchInstalled: false,
      patchReady: false,
      localeReadObserved: false,
    }))
    let discoveries = 0
    await expect(injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => { discoveries += 1; return new Response(JSON.stringify([target()])) },
      createWebSocket: () => socket,
      delay: async () => undefined,
    })).rejects.toThrow('未确认中文配置生效')
    expect(discoveries).toBe(30)
    expect(sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(0)
    expect(isClosed()).toBe(true)
  })

  it('prioritizes the main page over an auxiliary webview returned first by discovery', async () => {
    const { socket } = mockCdpSocket()
    const connections: string[] = []
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([
        target({ id: 'aux', type: 'webview', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/aux' }),
        target(),
      ])),
      createWebSocket: (url) => { connections.push(url); return socket },
      delay: async () => undefined,
    })
    expect(result).toEqual({ injectedTargets: 1, attempts: 1 })
    expect(connections).toEqual([target().webSocketDebuggerUrl])
  })

  it('does not treat an auxiliary webview without the application bridge as success or reload it', async () => {
    const { socket, sent } = mockCdpSocket(() => ({ ...readyProbe, hasBridge: false }))
    await expect(injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target({ type: 'webview' })])),
      createWebSocket: () => socket,
      delay: async () => undefined,
    })).rejects.toThrow('未找到可注入的页面')
    expect(sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(0)
  })

  it('does not report renderer readiness or a forced but unused config as locale success', async () => {
    const { socket, sent, isClosed } = mockCdpSocket(() => ({ ...readyProbe, localeReadObserved: false }))
    await expect(injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => socket,
      delay: async () => undefined,
    })).rejects.toThrow('未确认中文配置生效')
    expect(sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(1)
    expect(isClosed()).toBe(true)
  })

  it('does not reload an incompatible renderer that never exposes the locale config', async () => {
    const { socket, sent } = mockCdpSocket(() => ({ ...readyProbe, patchReady: false, localeReadObserved: false }))
    await expect(injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => socket,
      delay: async () => undefined,
    })).rejects.toThrow('未确认中文配置生效')
    expect(sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(0)
  })

  it('closes a replaced target and registers the patch on the new renderer', async () => {
    const first = mockCdpSocket(() => ({ ...readyProbe, patchReady: false, localeReadObserved: false }))
    const second = mockCdpSocket()
    let discovery = 0
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => {
        discovery += 1
        return new Response(JSON.stringify([discovery === 1 ? target() : target({ id: 'page-2', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-2' })]))
      },
      createWebSocket: (url) => url.endsWith('page-1') ? first.socket : second.socket,
      delay: async () => undefined,
    })
    expect(result).toEqual({ injectedTargets: 2, attempts: 2 })
    expect(first.isClosed()).toBe(true)
    expect(second.isClosed()).toBe(true)
    expect(second.sent.some((entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument')).toBe(true)
  })

  it('reconnects and registers again when a target keeps its id after a disconnected session', async () => {
    const first = mockCdpSocket(() => ({ ...readyProbe, patchReady: false, localeReadObserved: false }))
    const second = mockCdpSocket()
    let connections = 0
    const result = await injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => ++connections === 1 ? first.socket : second.socket,
      delay: async () => { first.socket.close() },
    })
    expect(result).toEqual({ injectedTargets: 2, attempts: 3 })
    expect(second.sent.filter((entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1)
    expect(second.isClosed()).toBe(true)
  })

  it('keeps discovery bounded when Codex exposes no page yet', async () => {
    let attempts = 0
    await expect(injectCodexDesktopChineseLocale(9222, {
      ...codexPortOwner,
      fetch: async () => {
        attempts += 1
        return new Response('[]')
      },
      delay: async () => undefined,
    })).rejects.toThrow('未找到可注入的页面')
    expect(attempts).toBe(30)
  })
})

describe('Codex Desktop CDP debugging port ownership', () => {
  it('reads only the rows listening on the port from the netstat table', () => {
    // The accepted connection, the one closing in TIME_WAIT, the client end
    // pointing at the port and another process's outgoing connection that
    // happens to use 9222 on another address all share the number without
    // listening on it; 19222 and the UDP rows are different sockets altogether.
    expect(parseCodexDesktopCdpPortOwners(netstatTable, 9222)).toEqual([4321])
    expect(parseCodexDesktopCdpPortOwners(netstatTable, 135)).toEqual([1060])
    expect(parseCodexDesktopCdpPortOwners(netstatTable, 50123)).toEqual([])
  })

  it('names every process listening on the port, on any address', () => {
    const squatted = [
      '  TCP    0.0.0.0:9222           0.0.0.0:0              LISTENING       7788',
      '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       4321',
      '  TCP    [::]:9222              [::]:0                 LISTENING       9999',
      '  TCP    [fe80::1c2d:3e4f:5a6b:7c8d%12]:9222  [::]:0                 LISTENING       1111',
    ].join('\r\n')
    const owners = parseCodexDesktopCdpPortOwners(squatted, 9222)
    expect(owners).toEqual([7788, 4321, 9999, 1111])
    expect(classifyCodexDesktopCdpPortOwnership(owners ?? [], 4321)).toBe('foreign')
  })

  it('reads a Simplified Chinese table the way execFile hands it over', () => {
    // The header arrives as replacement characters; nothing read depends on it.
    expect(chineseNetstat).toContain('\uFFFD')
    expect(parseCodexDesktopCdpPortOwners(chineseNetstat, 9222)).toEqual([4321])
    expect(parseCodexDesktopCdpPortOwners(chineseNetstat, 135)).toEqual([1060])
  })

  it('recognises a listener by its addresses when the state column is translated', () => {
    expect(germanNetstat).toContain('ABH\uFFFDREN')
    expect(parseCodexDesktopCdpPortOwners(germanNetstat, 9222)).toEqual([4321])
    expect(parseCodexDesktopCdpPortOwners(germanNetstat, 135)).toEqual([1060])
    // A second listener is still caught although no row says LISTENING.
    const squatted = germanNetstat + decodedAsExecFileDoes([
      ['  TCP    [::]:9222              [::]:0                 ', ...abhoeren, '         7788'],
    ])
    const owners = parseCodexDesktopCdpPortOwners(squatted, 9222)
    expect(owners).toEqual([4321, 7788])
    expect(classifyCodexDesktopCdpPortOwnership(owners ?? [], 4321)).toBe('foreign')
    // Should a translation ever run to several words, the PID is still the last column.
    expect(parseCodexDesktopCdpPortOwners([
      '  TCP    [::1]:9222             [::]:0                 EN ESCUCHA      4321',
      '  TCP    127.0.0.1:9222         127.0.0.1:50124        EN ESPERA       0',
    ].join('\r\n'), 9222)).toEqual([4321])
  })

  it('fails the lookup on output it cannot read as a TCP table', () => {
    // Windows always listens somewhere, so none of these is an idle machine.
    expect(parseCodexDesktopCdpPortOwners('', 9222)).toBeNull()
    expect(parseCodexDesktopCdpPortOwners(chineseNetstat.split('\r\n').slice(0, 4).join('\r\n'), 9222)).toBeNull()
    expect(parseCodexDesktopCdpPortOwners('  UDP    0.0.0.0:9222           *:*                                    8888', 9222)).toBeNull()
    expect(parseCodexDesktopCdpPortOwners('Access is denied.', 9222)).toBeNull()
  })

  it('refuses to answer for a listener whose process it cannot read', () => {
    // Dropping such a row could pass a port another process also listens on.
    expect(parseCodexDesktopCdpPortOwners([
      '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       4321',
      '  TCP    [::1]:9222             [::]:0                 LISTENING',
    ].join('\r\n'), 9222)).toBeNull()
    expect(parseCodexDesktopCdpPortOwners('  TCP    0.0.0.0:9222    0.0.0.0:0    LISTENING    0', 9222)).toBeNull()
    expect(() => parseCodexDesktopCdpPortOwners(netstatTable, 0)).toThrow('端口无效')
  })

  it('reads the table with the system netstat.exe under the trusted environment', async () => {
    const calls: Array<{ executable: string; argv: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const owners = await resolveCodexDesktopCdpPortOwners(9222, {
      platform: 'win32',
      machinePaths: windowsMachinePaths,
      env: { Path: 'C:\\Users\\Tester\\bin;C:\\Windows\\System32', NODE_OPTIONS: '--require C:\\Users\\Tester\\hook.js' },
      run: async (executable, argv, env) => {
        calls.push({ executable, argv, env })
        return netstatTable
      },
    })
    expect(owners).toEqual([4321])
    expect(calls.map(({ executable, argv }) => ({ executable, argv }))).toEqual([
      { executable: 'C:\\Windows\\System32\\netstat.exe', argv: ['-a', '-n', '-o'] },
    ])
    expect(codexDesktopCdpPortOwnerArguments).toEqual(['-a', '-n', '-o'])
    expect(Object.values(calls[0].env).join('\n')).not.toContain('Tester')
  })

  it('fails the lookup instead of guessing when a listener cannot be attributed', async () => {
    await expect(resolveCodexDesktopCdpPortOwners(9222, {
      platform: 'win32',
      machinePaths: windowsMachinePaths,
      run: async () => '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING',
    })).rejects.toThrow('监听进程无法识别')
    await expect(resolveCodexDesktopCdpPortOwners(9222, { platform: 'linux' })).rejects.toThrow('仅支持 Windows')
  })

  it('treats an empty listener table as a port Codex has not bound yet', () => {
    expect(classifyCodexDesktopCdpPortOwnership([], 4321)).toBe('unbound')
    expect(classifyCodexDesktopCdpPortOwnership([4321], 4321)).toBe('owned')
    expect(classifyCodexDesktopCdpPortOwnership([7788], 4321)).toBe('foreign')
    expect(classifyCodexDesktopCdpPortOwnership([4321, 7788], 4321)).toBe('foreign')
  })

  it('sends nothing to a debugging port held by another local process', async () => {
    let discoveries = 0
    await expect(injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: 4321,
      resolvePortOwnerProcessIds: async () => [7788],
      fetch: async () => { discoveries += 1; return new Response(JSON.stringify([target()])) },
      delay: async () => undefined,
    })).rejects.toThrow('被其他进程占用')
    expect(discoveries).toBe(0)
  })

  it('refuses to inject when activation reported no Codex process id', async () => {
    let discoveries = 0
    await expect(injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: null,
      resolvePortOwnerProcessIds: async () => [4321],
      fetch: async () => { discoveries += 1; return new Response(JSON.stringify([target()])) },
      delay: async () => undefined,
    })).rejects.toThrow('无法确认调试端口归属')
    expect(discoveries).toBe(0)
  })

  it('waits for Codex to bind the port instead of probing an unbound one', async () => {
    const { socket } = mockCdpSocket()
    let lookups = 0
    const result = await injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: 4321,
      resolvePortOwnerProcessIds: async () => {
        lookups += 1
        return lookups > 2 ? [4321] : []
      },
      fetch: async () => {
        expect(lookups).toBeGreaterThan(2)
        return new Response(JSON.stringify([target()]))
      },
      createWebSocket: () => socket,
      delay: async () => undefined,
    })
    expect(result).toEqual({ injectedTargets: 1, attempts: 3 })
    expect(lookups).toBe(3)
  })

  it('asks again when an owner lookup fails or runs out of time instead of giving up on the language', async () => {
    const { socket } = mockCdpSocket()
    let lookups = 0
    const result = await injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: 4321,
      resolvePortOwnerProcessIds: async () => {
        lookups += 1
        if (lookups === 1) throw new Error(`Command failed: ${ownerLookupCommandLine}`)
        return [4321]
      },
      fetch: async () => {
        // Nothing reaches the port before an answered lookup names Codex.
        expect(lookups).toBe(2)
        return new Response(JSON.stringify([target()]))
      },
      createWebSocket: () => socket,
      delay: async () => undefined,
    })
    expect(result).toEqual({ injectedTargets: 1, attempts: 2 })
  })

  it('stops after three unanswered lookups in a row without touching the port or quoting the command', async () => {
    let lookups = 0
    let discoveries = 0
    await expect(injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: 4321,
      resolvePortOwnerProcessIds: async () => {
        lookups += 1
        throw new Error(`Command failed: ${ownerLookupCommandLine}`)
      },
      fetch: async () => { discoveries += 1; return new Response(JSON.stringify([target()])) },
      delay: async () => undefined,
    })).rejects.toThrow(/^这次没能确认 Codex 已经准备好$/)
    expect(lookups).toBe(3)
    expect(discoveries).toBe(0)
  })

  it('counts only unanswered lookups in a row, so an answer in between keeps the retries going', async () => {
    const { socket } = mockCdpSocket()
    const answers: Array<number[] | null> = [null, null, [], null, null, [4321]]
    let lookups = 0
    const result = await injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: 4321,
      resolvePortOwnerProcessIds: async () => {
        const answer = answers[lookups]
        lookups += 1
        if (!answer) throw new Error(`Command failed: ${ownerLookupCommandLine}`)
        return answer
      },
      fetch: async () => new Response(JSON.stringify([target()])),
      createWebSocket: () => socket,
      delay: async () => undefined,
    })
    expect(result).toEqual({ injectedTargets: 1, attempts: 6 })
    expect(lookups).toBe(6)
  })

  it('still refuses a port another process holds even after lookups failed', async () => {
    let lookups = 0
    let discoveries = 0
    await expect(injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: 4321,
      resolvePortOwnerProcessIds: async () => {
        lookups += 1
        if (lookups === 1) throw new Error(`Command failed: ${ownerLookupCommandLine}`)
        return [7788]
      },
      fetch: async () => { discoveries += 1; return new Response(JSON.stringify([target()])) },
      delay: async () => undefined,
    })).rejects.toThrow('被其他进程占用')
    expect(lookups).toBe(2)
    expect(discoveries).toBe(0)
  })

  it('confirms Codex and switches the language on Chinese and German Windows alike', async () => {
    for (const table of [chineseNetstat, germanNetstat]) {
      const { socket } = mockCdpSocket()
      const result = await injectCodexDesktopChineseLocale(9222, {
        expectedProcessId: 4321,
        resolvePortOwnerProcessIds: (port) => resolveCodexDesktopCdpPortOwners(port, {
          platform: 'win32',
          machinePaths: windowsMachinePaths,
          run: async () => table,
        }),
        fetch: async () => new Response(JSON.stringify([target()])),
        createWebSocket: () => socket,
        delay: async () => undefined,
      })
      expect(result).toEqual({ injectedTargets: 1, attempts: 1 })
    }
  })

  it('gives up after three unreadable tables instead of waiting out the deadline as if nothing listened', async () => {
    let lookups = 0
    let discoveries = 0
    await expect(injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: 4321,
      resolvePortOwnerProcessIds: (port) => resolveCodexDesktopCdpPortOwners(port, {
        platform: 'win32',
        machinePaths: windowsMachinePaths,
        run: async () => { lookups += 1; return '' },
      }),
      fetch: async () => { discoveries += 1; return new Response(JSON.stringify([target()])) },
      delay: async () => undefined,
    })).rejects.toThrow(/^这次没能确认 Codex 已经准备好$/)
    expect(lookups).toBe(3)
    expect(discoveries).toBe(0)
  })

  it('reuses a confirmed owner across the attempts of one bounded discovery', async () => {
    let lookups = 0
    await expect(injectCodexDesktopChineseLocale(9222, {
      expectedProcessId: 4321,
      resolvePortOwnerProcessIds: async () => { lookups += 1; return [4321] },
      fetch: async () => new Response('[]'),
      delay: async () => undefined,
    })).rejects.toThrow('未找到可注入的页面')
    expect(lookups).toBe(1)
  })
})

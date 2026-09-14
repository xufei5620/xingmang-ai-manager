import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  buildCodexDesktopCdpArguments,
  codexChineseRuntimeScript,
  filterCodexDesktopCdpTargets,
  injectCodexDesktopChineseLocale,
  parseCodexDesktopActivationProcessId,
  validateCodexDesktopAppUserModelId,
  validateCodexDesktopCdpPort,
  validateCodexDesktopCdpTarget,
  type CodexDesktopCdpTarget,
} from './codex-desktop-cdp'

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
      fetch: async () => new Response(JSON.stringify([target({ type: 'webview' })])),
      createWebSocket: () => socket,
      delay: async () => undefined,
    })).rejects.toThrow('未找到可注入的页面')
    expect(sent.filter((entry) => entry.method === 'Page.reload')).toHaveLength(0)
  })

  it('does not report renderer readiness or a forced but unused config as locale success', async () => {
    const { socket, sent, isClosed } = mockCdpSocket(() => ({ ...readyProbe, localeReadObserved: false }))
    await expect(injectCodexDesktopChineseLocale(9222, {
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
      fetch: async () => {
        attempts += 1
        return new Response('[]')
      },
      delay: async () => undefined,
    })).rejects.toThrow('未找到可注入的页面')
    expect(attempts).toBe(30)
  })
})

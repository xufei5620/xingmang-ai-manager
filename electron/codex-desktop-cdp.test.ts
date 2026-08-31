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

  it('registers the patch for future documents and evaluates it in the current page', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = []
    const listeners = new Map<string, Set<(event: any) => void>>()
    const socket = {
      readyState: 1,
      send(payload: string) {
        const message = JSON.parse(payload) as { id: number; method: string; params: Record<string, unknown> }
        sent.push({ method: message.method, params: message.params })
        const result = message.method === 'Runtime.evaluate' && String(message.params.expression).includes('codexRendererProbe')
          ? { result: { value: JSON.stringify({ codexRendererProbe: true, hasBridge: true, hasAppRoot: true, textLength: 120 }) } }
          : {}
        const event = { data: JSON.stringify({ id: message.id, result }) }
        listeners.get('message')?.forEach((listener) => listener(event))
      },
      close() {},
      addEventListener(type: string, listener: (event: any) => void) {
        const values = listeners.get(type) ?? new Set()
        values.add(listener)
        listeners.set(type, values)
      },
      removeEventListener(type: string, listener: (event: any) => void) {
        listeners.get(type)?.delete(listener)
      },
    }
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
    expect(sent[1]?.params.source).toBe(codexChineseRuntimeScript)
    expect(String(sent[2]?.params.expression)).toContain('enable_i18n')
    expect(String(sent[2]?.params.expression)).toContain('locale_source')
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

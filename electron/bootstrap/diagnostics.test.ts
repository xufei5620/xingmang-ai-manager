import { beforeEach, describe, expect, it, vi } from 'vitest'
import { providerIds, type ProviderId } from '../catalog'
import type { NativeConfigInspection } from '../config-files'
import type { DiagnosticsDependencies, DiagnosticsReport } from '../diagnostics'
import { redactDiagnosticText } from '../diagnostics-redaction'
import { buildFeedbackSelfCheckLines } from '../feedback-self-check'
import type { RuntimeLogStore } from '../runtime-log'
import type { SystemSnapshot } from '../system-service'
import { createDiagnostics, inspectConfiguredApiKeys, type DiagnosticsWiringOptions } from './diagnostics'

const mocks = vi.hoisted(() => ({
  inspectProviderConfig: vi.fn(),
  runDiagnostics: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0', getPath: () => '/tmp', runningUnderARM64Translation: false, getLocale: () => 'zh-CN' },
  session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
}))
vi.mock('../config-files', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config-files')>(),
  inspectProviderConfig: mocks.inspectProviderConfig,
}))
vi.mock('../diagnostics', async (importOriginal) => ({
  ...await importOriginal<typeof import('../diagnostics')>(),
  runDiagnostics: mocks.runDiagnostics,
}))

function create(overrides: Partial<DiagnosticsWiringOptions> = {}) {
  const runtimeLog = {
    log: vi.fn(),
    exception: vi.fn(),
    attachEnvironmentDescriber: vi.fn(),
    attachHostDescriber: vi.fn(),
    attachSelfCheckDescriber: vi.fn(),
  }
  // Nothing here runs a diagnosis or a connection check, so the services the
  // checks would call stay empty: a call into one of them fails the test.
  const diagnostics = createDiagnostics({
    routes: {} as DiagnosticsWiringOptions['routes'],
    systemService: {} as DiagnosticsWiringOptions['systemService'],
    rootedOptions: {} as DiagnosticsWiringOptions['rootedOptions'],
    codexContext: {} as DiagnosticsWiringOptions['codexContext'],
    managerDataDirectory: '/tmp/xingmang-diagnostics-test',
    windowsCliExecution: { mode: 'same-user', elapsedMs: 0 } as DiagnosticsWiringOptions['windowsCliExecution'],
    readAccelerationBundleStatus: async () => null,
    accelerationRunning: async () => false,
    readDocumentsDirectory: () => null,
    runtimeLog: runtimeLog as unknown as RuntimeLogStore,
    readBillingAccountScope: () => 'xm-account:1',
    currentBusiness: () => ({ aiOutputPlacement: { root: '/tmp', movedFromDocuments: false, earlierWorksLeftInDocuments: false } }) as unknown as ReturnType<DiagnosticsWiringOptions['currentBusiness']>,
    assetStore: () => ({ assertWritable: async () => undefined }),
    ...overrides,
  })
  return { diagnostics, runtimeLog }
}

describe('diagnostics wiring', () => {
  it('has nothing to export or report before the first diagnosis', () => {
    const { diagnostics } = create()
    expect(() => diagnostics.diagnosticsService.exportLatest()).toThrow('请先运行一次健康诊断')
    expect(diagnostics.diagnosticsService.hasSelfCheckResult()).toBe(false)
  })

  it('refuses a paid Codex probe confirmed for another account', () => {
    const { diagnostics } = create()
    expect(() => diagnostics.diagnosticsService.probeCodexResponses('xm-account:2')).toThrow('当前账号已变更，请重新勾选确认后再检测')
  })

  it('attaches the three feedback sections without reading the scan snapshot until a report is built', async () => {
    const { diagnostics, runtimeLog } = create()
    const latestTraySystem = vi.fn((): SystemSnapshot | null => null)
    const readPrivacySwitches = vi.fn(() => ({ crashReporting: true, anonymousUsage: false }))
    diagnostics.attachFeedbackDescribers({ latestTraySystem, readPrivacySwitches })
    expect(runtimeLog.attachEnvironmentDescriber).toHaveBeenCalledTimes(1)
    expect(runtimeLog.attachHostDescriber).toHaveBeenCalledTimes(1)
    expect(runtimeLog.attachSelfCheckDescriber).toHaveBeenCalledTimes(1)
    expect(latestTraySystem).not.toHaveBeenCalled()
    // 开关跟扫描快照一样，生成报告时才问：设置里刚关掉的，下一份报告就写「关」。
    expect(readPrivacySwitches).not.toHaveBeenCalled()

    const [describeSelfCheck] = runtimeLog.attachSelfCheckDescriber.mock.calls[0] as [() => Promise<string[]>]
    expect(await describeSelfCheck()).toEqual(buildFeedbackSelfCheckLines({ report: null, readConnection: () => null, now: new Date() }))
  })
})

// Plain words on purpose: the generic secret shapes leave them alone, so only
// the per-tool Key list can hide them.
const keys: Record<ProviderId, string> = {
  claude: 'claude-plain-key-one',
  codex: 'codex-plain-key-two',
  grok: 'grok-plain-key-three',
  gemini: '',
}
const roots = { userHome: '/home/customer', codexHome: '/home/customer/.codex' }

function useConfigs(unreadable: ProviderId[]): void {
  mocks.inspectProviderConfig.mockImplementation((provider: ProviderId) => {
    if (unreadable.includes(provider)) throw new Error('配置文件位置不安全，已拒绝读取')
    return { apiKey: keys[provider] } as unknown as NativeConfigInspection
  })
}

// Every item pretends a Key slipped into its text, so the export has to hide
// each one no matter which read found it.
function leakyReport(): DiagnosticsReport {
  const items: DiagnosticsReport['items'] = (['claude', 'codex', 'grok'] as const).map((provider) => ({
    code: `CONFIG_${provider.toUpperCase()}`,
    title: `${provider} 连接设置`,
    state: 'pass',
    summary: `读到 ${keys[provider]}`,
    durationMs: 1,
  }))
  return { version: 1, generatedAt: '2026-11-20T00:00:00.000Z', durationMs: 3, counts: { pass: 3, warn: 0, fail: 0, error: 0 }, items }
}

function runnable(): Partial<DiagnosticsWiringOptions> {
  // A site that is neither account site keeps the line-switching wiring out of the run.
  const site = { id: 'custom', providerBaseUrls: {} }
  return {
    routes: { relayRouting: { resolve: () => site }, toolRouting: { resolve: () => site } } as unknown as DiagnosticsWiringOptions['routes'],
    systemService: { readStoredConfig: () => ({}), inspectWindowsProcessor: async () => null } as unknown as DiagnosticsWiringOptions['systemService'],
    rootedOptions: {
      diagnostics: { providerRoots: roots, env: {} },
      system: { providerRoots: roots },
      diagnosticExport: roots,
    } as unknown as DiagnosticsWiringOptions['rootedOptions'],
  }
}

// Reads every tool's config the way the real run does: a tool that cannot be
// read only fails its own check.
async function runOnce(diagnostics: ReturnType<typeof create>['diagnostics'], unreadable: ProviderId[]): Promise<void> {
  useConfigs(unreadable)
  mocks.runDiagnostics.mockImplementationOnce(async (dependencies: DiagnosticsDependencies) => {
    for (const provider of providerIds) {
      try {
        dependencies.inspectProvider?.(provider, roots)
      } catch {
        // surfaces as that tool's own error item in the real run
      }
    }
    return leakyReport()
  })
  await diagnostics.diagnosticsService.run()
}

function unreadableWarnings(runtimeLog: ReturnType<typeof create>['runtimeLog']) {
  return runtimeLog.log.mock.calls.filter(([level, , event]) => level === 'warn' && event === 'sensitive-keys.unreadable')
}

describe('diagnostics export with an unreadable tool config', () => {
  beforeEach(() => {
    mocks.inspectProviderConfig.mockReset()
    mocks.runDiagnostics.mockReset()
  })

  it('keeps the other tools\' Keys when one tool\'s config cannot be read', () => {
    const result = inspectConfiguredApiKeys((provider) => {
      if (provider === 'codex') throw new Error('denied')
      return keys[provider]
    })
    expect(result.values).toEqual([keys.claude, keys.grok])
    expect(result.unreadable.map((entry) => entry.provider)).toEqual(['codex'])
  })

  it('exports the finished report with every item when a config turns unreadable, still hiding every Key', async () => {
    expect(keys.codex).toBe(redactDiagnosticText(keys.codex))
    const { diagnostics, runtimeLog } = create(runnable())
    // Grok cannot be read during the run; Codex stops being readable afterwards.
    await runOnce(diagnostics, ['grok'])
    useConfigs(['codex'])

    const exported = diagnostics.diagnosticsService.exportLatest()

    for (const item of leakyReport().items) expect(exported).toContain(item.title)
    // Codex is hidden by what the run read, Grok by what the export reads now.
    for (const key of [keys.claude, keys.codex, keys.grok]) expect(exported).not.toContain(key)
    expect(unreadableWarnings(runtimeLog)).toHaveLength(1)
    expect(unreadableWarnings(runtimeLog)[0][4]).toMatchObject({ provider: 'codex', purpose: 'export' })
  })

  it('keeps the feedback self-check section and reads the configs once per report', async () => {
    const { diagnostics, runtimeLog } = create(runnable())
    await runOnce(diagnostics, [])
    useConfigs(['codex'])
    diagnostics.attachFeedbackDescribers({ latestTraySystem: () => null, readPrivacySwitches: () => ({ crashReporting: true, anonymousUsage: false }) })
    mocks.inspectProviderConfig.mockClear()

    const [describeSelfCheck] = runtimeLog.attachSelfCheckDescriber.mock.calls[0] as [() => Promise<string[]>]
    const text = (await describeSelfCheck()).join('\n')

    for (const item of leakyReport().items) expect(text).toContain(item.title)
    for (const key of [keys.claude, keys.codex, keys.grok]) expect(text).not.toContain(key)
    expect(mocks.inspectProviderConfig).toHaveBeenCalledTimes(providerIds.length)
    expect(unreadableWarnings(runtimeLog)).toHaveLength(1)
    expect(unreadableWarnings(runtimeLog)[0][4]).toMatchObject({ provider: 'codex', purpose: 'feedback' })
  })
})

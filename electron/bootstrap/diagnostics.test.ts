import { describe, expect, it, vi } from 'vitest'
import { buildFeedbackSelfCheckLines } from '../feedback-self-check'
import type { RuntimeLogStore } from '../runtime-log'
import type { SystemSnapshot } from '../system-service'
import { createDiagnostics, type DiagnosticsWiringOptions } from './diagnostics'

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0', getPath: () => '/tmp', runningUnderARM64Translation: false, getLocale: () => 'zh-CN' },
  session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
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
    accelerationBundleStatus: Promise.resolve(null),
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
    expect(() => diagnostics.diagnosticsService.probeCodexResponses('xm-account:2')).toThrow('当前账号变了，请重新勾选确认后再检查')
  })

  it('attaches the three feedback sections without reading the scan snapshot until a report is built', async () => {
    const { diagnostics, runtimeLog } = create()
    const latestTraySystem = vi.fn((): SystemSnapshot | null => null)
    diagnostics.attachFeedbackDescribers({ latestTraySystem })
    expect(runtimeLog.attachEnvironmentDescriber).toHaveBeenCalledTimes(1)
    expect(runtimeLog.attachHostDescriber).toHaveBeenCalledTimes(1)
    expect(runtimeLog.attachSelfCheckDescriber).toHaveBeenCalledTimes(1)
    expect(latestTraySystem).not.toHaveBeenCalled()

    const [describeSelfCheck] = runtimeLog.attachSelfCheckDescriber.mock.calls[0] as [() => Promise<string[]>]
    expect(await describeSelfCheck()).toEqual(buildFeedbackSelfCheckLines({ report: null, readConnection: () => null, now: new Date() }))
  })
})

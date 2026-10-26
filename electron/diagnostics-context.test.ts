import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { providerIds, type ProviderId } from './catalog'
import type { NativeConfigInspection } from './config-files'
import type { DiagnosticsDependencies, DiagnosticsRelayRoute, DiagnosticsScanSnapshot, DiagnosticToolId } from './diagnostics'
import { createDiagnosticsContext } from './diagnostics-context'
import { requireRelaySite } from './relay-sites'

// #1070 第 9 步把 runDiagnostics 开头那段搬成了 createDiagnosticsContext。这里钉住各类检查都会拿去用、搬家时
// 最容易悄悄变样的几条：工具线路缺省跟着应用线路走、各家工具配置先读一遍（下线的 Gemini 也读，它的 Key 报告里
// 一样要遮掉）、读不了的那家不拦着别家、首页扫描探到了的就不再探。

const home = path.join(os.tmpdir(), 'xingmang-diagnostics-context')

function inspection(provider: ProviderId): NativeConfigInspection {
  return {
    baseUrl: 'https://xm.solov.cc',
    actualBaseUrl: 'https://xm.solov.cc',
    exists: true,
    hasApiKey: true,
    matchesRelay: true,
    apiKey: `sk-${provider}-secret-value`,
    model: '',
    dataDirectory: path.join(home, `.${provider}`),
    dataDirectoryExists: true,
    files: [],
    updatedAt: null,
  }
}

function dependencies(overrides: Partial<DiagnosticsDependencies> = {}): DiagnosticsDependencies {
  return {
    app: { name: '星芒AI管理工具', version: '1.0.0', packaged: false },
    homeDirectory: home,
    platform: 'win32',
    env: {},
    inspectProvider: inspection,
    ...overrides,
  }
}

describe('diagnostics context', () => {
  it('lets the tool route follow the app route unless the host gives one', () => {
    const relaySite = requireRelaySite('solov', 'direct')
    const relayRoute: DiagnosticsRelayRoute = {
      line: 'direct',
      automatic: true,
      settled: true,
      primarySite: requireRelaySite('solov', 'primary'),
      reportLineFailure: () => undefined,
    }
    const same = createDiagnosticsContext(dependencies({ relaySite, relayRoute }))
    expect(same.toolSite).toBe(relaySite)
    expect(same.toolRoute).toBe(relayRoute)

    const toolSite = requireRelaySite('solov', 'primary')
    const split = createDiagnosticsContext(dependencies({ relaySite, relayRoute, toolRoute: { site: toolSite } }))
    expect(split.relaySite).toBe(relaySite)
    expect(split.toolSite).toBe(toolSite)
    expect(split.toolRoute).toBeUndefined()
  })

  it('reads every provider config once, retired ones too, and hides their keys from report text', () => {
    const inspectProvider = vi.fn((provider: ProviderId) => {
      if (provider === 'grok') throw new Error('读不了')
      return inspection(provider)
    })
    const context = createDiagnosticsContext(dependencies({ inspectProvider }))

    expect(inspectProvider.mock.calls.map(([provider]) => provider)).toEqual([...providerIds])
    expect([...context.providerInspections.keys()]).toEqual(providerIds.filter((provider) => provider !== 'grok'))
    expect(context.sanitize(`sk-gemini-secret-value sk-claude-secret-value ${home} ${path.join(home, '.codex')}`))
      .toBe('[REDACTED] [REDACTED] ~ [CODEX_HOME]')
  })

  it('answers a tool from the home page scan and probes only what the scan could not detect', async () => {
    const inspectTool = vi.fn(async (_tool: DiagnosticToolId) => ({ installed: true, version: 'probed', path: null }))
    const recentScan = {
      runtime: {
        node: { installed: true, version: '22.12.0', path: 'C:\\tools\\node.exe', installDirectory: null },
        git: { installed: false, version: null, path: null, installDirectory: null, detectionFailed: true },
      },
    } as unknown as DiagnosticsScanSnapshot
    const context = createDiagnosticsContext(dependencies({ inspectTool, recentScan }))
    const signal = new AbortController().signal

    expect(await context.inspectTool('node', signal)).toEqual({ installed: true, version: '22.12.0', path: 'C:\\tools\\node.exe' })
    expect(await context.inspectTool('git', signal)).toEqual({ installed: true, version: 'probed', path: null })
    expect(inspectTool.mock.calls.map(([tool]) => tool)).toEqual(['git'])
  })
})

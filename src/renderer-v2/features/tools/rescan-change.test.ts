import { describe, expect, it } from 'vitest'
import type { ExternalClientStatus } from '../../../../electron/ipc-contract'
import type { ToolboxSnapshot } from './model'
import { rescanFingerprint } from './rescan-change'

const cliStatus = {
  installed: true, version: '1.2.3', path: 'C:\\fixture\\bin', installDirectory: 'C:\\fixture',
  latestVersion: '1.2.3', updateAvailable: false,
  uninstall: { available: true, reason: null, manualCommand: null },
}
const providerConfig = {
  exists: true, hasApiKey: true, matchesRelay: true, configurationOwnership: 'account',
  baseUrl: 'https://xm.solov.cc/v1', actualBaseUrl: 'https://xm.solov.cc/v1', model: 'fixture-model',
  apiKeyPreview: 'sk-***', dataDirectory: 'C:\\fixture', dataDirectoryExists: true, files: [], updatedAt: null,
}
const runtime = { installed: true, version: '22.0.0', detectionFailed: false }

function snapshot(overrides: { claude?: Record<string, unknown>; checkedAt?: string; node?: Record<string, unknown> } = {}): ToolboxSnapshot {
  return {
    config: { providers: { claude: providerConfig, codex: providerConfig, grok: providerConfig, gemini: providerConfig } },
    platform: { codexDesktop: { launch: false } },
    system: {
      checkedAt: overrides.checkedAt ?? '2026-10-15T00:00:00.000Z',
      runtime: { node: { ...runtime, ...overrides.node }, npm: runtime, git: runtime, python: runtime },
      clis: { claude: { ...cliStatus, ...overrides.claude }, codex: cliStatus, grok: cliStatus, gemini: cliStatus },
      desktopApps: { codex: { ...cliStatus, appVersion: '1.0.0' } },
    },
  } as unknown as ToolboxSnapshot
}

function client(overrides: Partial<ExternalClientStatus> = {}): ExternalClientStatus {
  return { tool: 'workbuddy', installed: true, version: '1.0.0', configured: true, configurationSource: 'xingmang', detectionError: null, ...overrides } as ExternalClientStatus
}

describe('home rescan fingerprint', () => {
  it('has nothing to compare before the first scan', () => {
    expect(rescanFingerprint(null, [])).toBeNull()
  })

  // 每次检测时间都不一样，但首页上看不出来：只差检测时间就算「没有变化」。
  it('treats a rescan that only moved the check time as unchanged', () => {
    expect(rescanFingerprint(snapshot({ checkedAt: '2026-10-15T09:00:00.000Z' }), [client()]))
      .toBe(rescanFingerprint(snapshot({ checkedAt: '2026-10-15T09:05:00.000Z' }), [client()]))
  })

  it('notices a tool that was installed, updated or got a new version offer', () => {
    const before = rescanFingerprint(snapshot(), [])
    expect(rescanFingerprint(snapshot({ claude: { installed: false, version: null } }), [])).not.toBe(before)
    expect(rescanFingerprint(snapshot({ claude: { version: '1.2.4' } }), [])).not.toBe(before)
    expect(rescanFingerprint(snapshot({ claude: { latestVersion: '1.3.0', updateAvailable: true } }), [])).not.toBe(before)
    expect(rescanFingerprint(snapshot({ claude: { detectionFailed: true, detectionError: '命令入口无法安全执行' } }), [])).not.toBe(before)
  })

  it('notices a runtime that appeared or changed version', () => {
    const before = rescanFingerprint(snapshot(), [])
    expect(rescanFingerprint(snapshot({ node: { version: '24.0.0' } }), [])).not.toBe(before)
    expect(rescanFingerprint(snapshot({ node: { installed: false, version: null } }), [])).not.toBe(before)
  })

  it('notices a desktop client that was installed or connected', () => {
    const before = rescanFingerprint(snapshot(), [client({ installed: false, version: null, configured: false })])
    expect(rescanFingerprint(snapshot(), [client({ configured: false })])).not.toBe(before)
    expect(rescanFingerprint(snapshot(), [client()])).not.toBe(rescanFingerprint(snapshot(), [client({ configured: false })]))
    expect(rescanFingerprint(snapshot(), [client({ detectionError: '读不到安装位置' })])).not.toBe(rescanFingerprint(snapshot(), [client()]))
  })
})

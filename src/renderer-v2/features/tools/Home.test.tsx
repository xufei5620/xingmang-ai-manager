import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Home, type HomeProps } from './Home'
import type { ToolboxSnapshot } from './model'
import type { ToolsApi } from './api'
import type { ToolJob } from './useToolbox'

const cliStatus: Record<string, unknown> = {
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

function snapshot(clis: Record<string, unknown>): ToolboxSnapshot {
  return {
    config: { providers: { claude: providerConfig, codex: providerConfig, grok: providerConfig, gemini: providerConfig } },
    platform: { codexDesktop: { launch: false } },
    system: {
      checkedAt: '2026-09-18T00:00:00.000Z',
      runtime: { node: runtime, npm: runtime, python: runtime },
      clis, desktopApps: { codex: { ...cliStatus, appVersion: '1.0.0' } },
    },
  } as unknown as ToolboxSnapshot
}

function render(jobs: Record<string, ToolJob>, clis = { claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus }): string {
  const noop = () => undefined
  const props: HomeProps = {
    api: {} as ToolsApi, snapshot: snapshot(clis), loading: false, error: '', account: null,
    balance: null, jobs, externalClients: [], externalLoading: false, externalError: '',
    onScan: noop, onInstall: noop, onLaunch: noop, onConfigure: noop, onConfigureExternal: noop,
    onInstallExternal: noop, onLaunchExternal: noop, onCodexModels: noop, onUninstall: noop,
    onRuntime: noop, onNavigate: noop, onGuide: noop,
  }
  return renderToStaticMarkup(<Home {...props} />)
}

describe('renderer-v2 home install progress', () => {
  it('shows the phase text the main process sends instead of leaving the row on its version line', () => {
    const label = '正在从 npm 官方源解析完整依赖图并校验 SHA-512 完整性'
    const markup = render({ claude: { label, percent: undefined, log: [label] } })
    expect(markup).toContain(label)
  })

  it('renders the reported download percentage on the installing row', () => {
    const markup = render({ grok: { label: 'Grok CLI 下载 45%（4 / 9 MiB）', percent: 45, log: [] } })
    expect(markup).toContain('aria-valuenow="45"')
    expect(markup).toContain('安装中 45%')
  })

  it('keeps the version line when nothing is running', () => {
    const markup = render({})
    expect(markup).toContain('v1.2.3')
    expect(markup).not.toContain('aria-valuenow')
  })

  it('states why a probe failed instead of only saying 检测失败', () => {
    const markup = render({}, {
      claude: { ...cliStatus, detectionFailed: true, detectionError: '命令入口无法安全执行' },
      codex: cliStatus, grok: cliStatus, gemini: cliStatus,
    })
    expect(markup).toContain('命令入口无法安全执行')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Home, type HomeProps } from './Home'
import type { ToolboxSnapshot } from './model'
import type { ToolboxPartitionFailure, ToolsApi } from './api'
import type { ToolJob } from './useToolbox'
import { networkFailureMessages } from '../../../../electron/network-failure'
import type { AccountBootstrapResult } from './account-bootstrap'

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

function render(
  jobs: Record<string, ToolJob>,
  clis = { claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus },
  overrides: Partial<HomeProps> = {},
): string {
  const noop = () => undefined
  const props: HomeProps = {
    api: {} as ToolsApi, snapshot: snapshot(clis), loading: false, error: '', account: null,
    balance: null, jobs, externalClients: [], externalLoading: false, externalError: '',
    onScan: noop, onInstall: noop, onCancelInstall: noop, onLaunch: noop, onConfigure: noop, onConfigureExternal: noop,
    onInstallExternal: noop, onLaunchExternal: noop, onCodexModels: noop, onUninstall: noop,
    onRuntime: noop, onNavigate: noop, onGuide: noop,
    ...overrides,
  }
  return renderToStaticMarkup(<Home {...props} />)
}

const configFailure: ToolboxPartitionFailure[] = [{ partition: 'config', message: '~/.codex/config.toml 解析失败' }]

/** 配置那一块单独读失败时的降级快照：工具状态照旧，配置全部落到未配置。 */
function unreadableConfig(): ToolboxSnapshot {
  const blank = {
    exists: false, hasApiKey: false, matchesRelay: false, baseUrl: '', actualBaseUrl: '', model: '',
    apiKeyPreview: null, dataDirectory: '', dataDirectoryExists: false, files: [], updatedAt: null,
  }
  return {
    ...snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus }),
    config: { workspace: '', providers: { claude: blank, codex: blank, grok: blank, gemini: blank } },
  } as unknown as ToolboxSnapshot
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

describe('renderer-v2 home partial read failures (R-S8)', () => {
  it('still lists every tool when only the configuration partition failed', () => {
    const markup = render({}, undefined, { snapshot: unreadableConfig(), failures: configFailure })
    for (const tool of ['claude', 'codex', 'grok', 'gemini']) {
      expect(markup).toContain(`data-testid="tool-row-${tool}"`)
    }
    expect(markup).toContain('data-testid="home-rescan"')
  })

  it('names the failing partition and its reason instead of leaving the page blank', () => {
    const markup = render({}, undefined, { snapshot: unreadableConfig(), failures: configFailure })
    expect(markup).toContain('data-testid="home-config-failure"')
    expect(markup).toContain('~/.codex/config.toml 解析失败')
  })

  it('marks the connection column unknown rather than claiming the key is missing', () => {
    const markup = render({}, undefined, { snapshot: unreadableConfig(), failures: configFailure })
    expect(markup).toContain('配置暂未读到')
    expect(markup).not.toContain('还没配 Key')
    expect(markup).toContain('重新配置')
  })

  it('keeps the untouched partitions rendering exactly as before', () => {
    const markup = render({}, undefined, { snapshot: unreadableConfig(), failures: configFailure })
    // 版本行来自 system 那一块，配置读失败不该把它一起抹掉。
    expect(markup).toContain('v1.2.3')
    // 配置读不到不是「还没开始用」，不该退回四步引导卡。
    expect(markup).not.toContain('data-testid="home-setup"')
  })

  it('leaves the healthy read untouched', () => {
    const markup = render({})
    expect(markup).not.toContain('data-testid="home-config-failure"')
    expect(markup).not.toContain('配置暂未读到')
  })
})

describe('renderer-v2 home install cancellation', () => {
  it('offers 取消 on the row whose install can still be stopped', () => {
    const markup = render({ claude: { label: '正在安装', log: [], cancellable: true } })
    expect(markup).toContain('data-testid="tool-claude-cancel"')
    expect(markup).toContain('取消')
  })

  it('reports that the cancel request is still being handled', () => {
    const markup = render({ claude: { label: '正在安装', log: [], cancellable: true, cancelling: true } })
    expect(markup).toContain('data-testid="tool-claude-cancel"')
    expect(markup).toContain('取消中')
  })

  it('leaves an install that cannot be cancelled without the button', () => {
    const markup = render({ claude: { label: '正在安装', log: [] } })
    expect(markup).not.toContain('data-testid="tool-claude-cancel"')
  })

  it('does not offer 取消 on a row that is idle', () => {
    const markup = render({})
    expect(markup).not.toContain('data-testid="tool-claude-cancel"')
  })

  it('keeps 取消 off the launch job, which is not an install', () => {
    const markup = render({ 'launch:claude': { label: '正在打开工具', log: [], cancellable: true } })
    expect(markup).not.toContain('data-testid="tool-claude-cancel"')
  })
})

describe('renderer-v2 home first-run suggestion', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function dismissedStorage(value: string) {
    return { localStorage: { getItem: () => value, setItem: () => undefined, removeItem: () => undefined } }
  }

  it('offers the first command and prompt once a tool is installed and connected', () => {
    const markup = render({})
    expect(markup).toContain('data-testid="home-first-run"')
    expect(markup).toContain('试试第一条命令')
    expect(markup).toContain('data-testid="home-first-run-steps-command"')
    expect(markup).toContain('>claude<')
    expect(markup).toContain('data-testid="home-first-run-steps-copy-command"')
    expect(markup).toContain('data-testid="home-first-run-steps-copy-prompt"')
    expect(markup).toContain('data-testid="home-first-run-dismiss"')
  })

  it('moves on to the next tool once its card has been closed', () => {
    vi.stubGlobal('window', dismissedStorage('["claude"]'))
    const markup = render({})
    expect(markup).toContain('data-testid="home-first-run"')
    expect(markup).toContain('Codex CLI')
    expect(markup).toContain('>codex<')
    expect(markup).not.toContain('>claude<')
  })

  it('stays gone once every tool has been closed', () => {
    vi.stubGlobal('window', dismissedStorage('["claude","codex","gemini","grok"]'))
    expect(render({})).not.toContain('data-testid="home-first-run"')
  })

  // 还没配 Key 时第一条命令敲下去只会报错，那不是「可以试试」。
  it('waits until the tool is actually connected', () => {
    const markup = render({}, { claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus },
      { snapshot: unreadableConfig(), failures: configFailure })
    expect(markup).not.toContain('data-testid="home-first-run"')
  })

  it('keeps the card off a tool that is still installing', () => {
    const markup = render({ claude: { label: '正在安装', log: [] } })
    expect(markup).toContain('data-testid="home-first-run"')
    expect(markup).not.toContain('>claude<')
    expect(markup).toContain('>codex<')
  })
})

// 打开过的目录来自会话记录，只有读到记录之后才有下拉（N7）。静态渲染里
// 那次读取还没发生，正好是「这个工具从来没打开过」应该走的那条路。
describe('renderer-v2 home launch button without a remembered directory (N7)', () => {
  it('keeps the plain 打开 button so the directory picker still opens', () => {
    const markup = render({})
    expect(markup).toContain('data-testid="tool-claude-primary"')
    expect(markup).toContain('>打开<')
  })

  it('offers no directory dropdown at all', () => {
    const markup = render({})
    expect(markup).not.toContain('data-testid="tool-claude-workspaces"')
    expect(markup).not.toContain('data-testid="tool-claude-launch"')
    expect(markup).not.toContain('选择其他目录')
  })
})

// 官方安装器/其他来源装的 CLI：如实标源，且不给 npm 更新按钮，改用被动提示。
describe('renderer-v2 home native install source', () => {
  const nativeClaude = { ...cliStatus, installSource: 'native', updateAvailable: true, latestVersion: '9.9.9' }
  const npmClaude = { ...cliStatus, installSource: 'npm', updateAvailable: true, latestVersion: '9.9.9' }

  it('replaces the npm 更新 button with a passive hint for a native install', () => {
    const markup = render({}, { claude: nativeClaude, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    expect(markup).toContain('data-testid="tool-claude-external-managed"')
    expect(markup).toContain('该版本由官方安装器管理，请用它自己的方式更新')
    // 那条 external-managed 提示顶掉了 npm 更新按钮。
    expect(markup).not.toContain('>更新<')
  })

  it('still offers the npm 更新 button for an npm install', () => {
    const markup = render({}, { claude: npmClaude, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    expect(markup).toContain('>更新<')
    expect(markup).not.toContain('data-testid="tool-claude-external-managed"')
  })
})


describe('renderer-v2 home account key bootstrap notice', () => {
  function bootstrapResult(overrides: Partial<AccountBootstrapResult> = {}): AccountBootstrapResult {
    return { readyKeys: [], configured: [], failed: [], skipped: [], warnings: [], networkBlocked: false, ...overrides }
  }
  const offline = '当前网络不可用，已装好的工具照常能用；联网后会自动补写 Key。'

  it('tells the user the client will write the keys itself once the network returns', () => {
    const markup = render({}, undefined, {
      bootstrap: {
        phase: 'verifying', label: 'Key 同步完成，部分工具待处理', percent: 100, scope: 'scope',
        result: bootstrapResult({ networkBlocked: true, failed: [{ provider: 'claude', message: networkFailureMessages.offline }] }),
      },
      onBootstrapRetry: () => undefined,
    })
    expect(markup).toContain(offline)
    // 「账号 Key 已同步」与一串网络失败原文同时出现过，自相矛盾，这里钉住它不再回来。
    expect(markup).not.toContain('账号 Key 已同步')
    expect(markup).toContain('>重新同步<')
  })

  it('keeps the original wording when the failure is not a network one', () => {
    const markup = render({}, undefined, {
      bootstrap: {
        phase: 'verifying', label: 'Key 同步完成，部分工具待处理', percent: 100, scope: 'scope',
        result: bootstrapResult({ failed: [{ provider: 'claude', message: '当前分组未返回可用模型' }] }),
      },
      onBootstrapRetry: () => undefined,
    })
    expect(markup).toContain('当前分组未返回可用模型')
    expect(markup).not.toContain(offline)
  })

  it('uses the same wording when the whole bootstrap threw a network failure', () => {
    const markup = render({}, undefined, {
      bootstrap: { phase: 'syncing', label: 'Key 初始化没有完成', percent: 100, scope: 'scope', error: `账号 Key 初始化没有完成：${networkFailureMessages.dns}` },
      onBootstrapRetry: () => undefined,
    })
    expect(markup).toContain(offline)
    expect(markup).not.toContain('账号 Key 初始化没有完成：')
  })

  it('still names a non-network bootstrap failure', () => {
    const markup = render({}, undefined, {
      bootstrap: { phase: 'syncing', label: 'Key 初始化没有完成', percent: 100, scope: 'scope', error: '星芒账号已变化，已停止本次 Key 配置' },
      onBootstrapRetry: () => undefined,
    })
    expect(markup).toContain('账号 Key 初始化没有完成：星芒账号已变化，已停止本次 Key 配置')
    expect(markup).not.toContain(offline)
  })
})

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

  it('shows a running account switch on the row and hides its menu so it cannot be clicked twice', () => {
    const markup = render({ 'switch:claude': { label: '正在切回官方账号', log: [] } })
    expect(markup).toContain('切换中')
    expect(markup).toContain('正在切回官方账号')
    expect(markup).not.toContain('data-testid="tool-claude-cancel"')
    expect(markup).not.toContain('安装中')
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

  it('shows a tool the account has not enabled as not enabled instead of waiting for a key', () => {
    const failure = { provider: 'gemini' as const, message: '分组不存在、不可用或名称重复，请确认账号可用分组' }
    const waiting = render({})
    // The fixture's Gemini config carries no auth type, so without a failure it reads as keyless.
    expect(waiting).toContain('还没配 Key')
    const markup = render({}, undefined, {
      bootstrap: {
        phase: 'verifying', label: 'Key 同步完成，部分工具待处理', percent: 100, scope: 'scope',
        result: bootstrapResult({ failed: [failure] }),
      },
      onBootstrapRetry: () => undefined,
    })
    expect(markup).toContain('Gemini CLI：当前账号还不能用，需要的话请联系客服开通')
    expect(markup).toContain('账号未开通')
    expect(markup).not.toContain('还没配 Key')
    expect(markup).not.toContain('分组')
    // Re-syncing cannot enable a tool on the account, so the banner offers no button for it.
    expect(markup).not.toContain('>重新同步<')
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

/**
 * 第三批候选 10：macOS 上 Node / Python 归客户自己装，原来那颗按钮直接把人丢到
 * 英文官网。Darwin-only 的分支在 Linux 沙箱里只能靠注入平台能力来演，这里演的是
 * 渲染层拿到 external 能力后的表现，不是真机行为。
 */
describe('renderer-v2 home missing runtime guidance on macOS', () => {
  function runtimeSnapshot(platform: 'windows' | 'macos', missing: { node?: boolean; python?: boolean }): ToolboxSnapshot {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    const external = platform === 'macos' ? 'external' : 'managed'
    return {
      ...base,
      platform: { ...base.platform, platform, nodeRuntimeInstall: external, pythonRuntimeInstall: external },
      system: {
        ...base.system,
        runtime: {
          ...base.system.runtime,
          node: missing.node ? { installed: false, version: null, detectionFailed: false } : runtime,
          python: missing.python ? { installed: false, version: null, detectionFailed: false } : runtime,
        },
      },
    } as unknown as ToolboxSnapshot
  }

  it('walks a Mac customer through both install routes instead of only opening nodejs.org', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('macos', { node: true }) })
    expect(markup).toContain('data-testid="home-runtime-guide-node"')
    expect(markup).toContain('这台 Mac 上没有找到 Node.js')
    expect(markup).toContain('brew install node')
    expect(markup).toContain('data-testid="home-runtime-copy-node"')
    // 装完回哪儿点一下，必须写在步骤里。
    expect(markup).toContain('重新检测')
    // 官网那条路保留成按钮，只是文案说清它是开网页。
    expect(markup).toContain('去官网下载 Node.js')
    expect(markup).not.toContain('准备 Node.js')
    expect(markup).toContain('data-testid="home-runtime-tutorial"')
  })

  it('gives Python its own block, including why the bundled one is not enough', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('macos', { python: true }) })
    expect(markup).toContain('data-testid="home-runtime-guide-python"')
    expect(markup).toContain('brew install python')
    expect(markup).toContain('Gemini CLI')
    expect(markup).toContain('去官网下载 Python（可选环境）')
    // Node 没缺就不该多出一段 Node 的步骤。
    expect(markup).not.toContain('data-testid="home-runtime-guide-node"')
  })

  it('leaves Windows exactly as it was: the app installs both, so no extra steps', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('windows', { node: true, python: true }) })
    expect(markup).not.toContain('data-testid="home-runtime-guide-node"')
    expect(markup).not.toContain('data-testid="home-runtime-guide-python"')
    expect(markup).not.toContain('data-testid="home-runtime-tutorial"')
    expect(markup).toContain('准备 Node.js')
    expect(markup).toContain('装 Python（可选环境）')
  })

  it('says the UAC prompt is coming before the Windows user presses install', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('windows', { node: true, python: true }) })
    expect(markup).toContain('data-testid="home-runtime-node-elevation"')
    expect(markup).toContain('这一步需要管理员授权')
    // Python 按当前用户装，不提权，所以这句只出现一次。
    expect(markup.match(/这一步需要管理员授权/g)).toHaveLength(1)
    expect(markup).not.toContain('Python 才装得上')
  })

  it('warns on the Codex desktop row too, because its Appx install elevates as well', () => {
    const base = runtimeSnapshot('windows', {})
    const windowsDesktopMissing = {
      ...base,
      platform: { ...base.platform, codexDesktop: { ...base.platform.codexDesktop, launch: true, install: 'managed' } },
      system: {
        ...base.system,
        desktopApps: { codex: { installed: false, detectionFailed: false, appVersion: null } },
      },
    } as unknown as ToolboxSnapshot
    const markup = render({}, undefined, { snapshot: windowsDesktopMissing })
    expect(markup).toContain('安装时需要管理员授权')
  })

  it('keeps the elevation notice off macOS, where nothing here elevates', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('macos', { node: true }) })
    expect(markup).not.toContain('data-testid="home-runtime-node-elevation"')
    expect(markup).not.toContain('这一步需要管理员授权')
  })

  it('stays quiet when the probe failed, because then nobody knows whether it is installed', () => {
    const base = runtimeSnapshot('macos', { node: true })
    const failed = {
      ...base,
      system: { ...base.system, runtime: { ...base.system.runtime, node: { installed: false, version: null, detectionFailed: true } } },
    } as unknown as ToolboxSnapshot
    const markup = render({}, undefined, { snapshot: failed })
    expect(markup).not.toContain('data-testid="home-runtime-guide-node"')
    expect(markup).not.toContain('这台 Mac 上没有找到 Node.js')
    // 按钮照旧在，用户想自己去官网还是能去。
    expect(markup).toContain('去官网下载 Node.js')
  })

  it('says nothing about installing runtimes once both are present', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('macos', {}) })
    expect(markup).not.toContain('data-testid="home-runtime-guide-node"')
    expect(markup).not.toContain('data-testid="home-runtime-guide-python"')
    expect(markup).not.toContain('data-testid="home-runtime-tutorial"')
    expect(markup).not.toContain('brew install')
  })

  describe('a tool whose configuration was edited outside the app', () => {
    function editedSnapshot(): ToolboxSnapshot {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      return {
        ...base,
        config: {
          ...base.config,
          providers: { ...base.config.providers, claude: { ...providerConfig, configurationOwnership: 'changed' } },
        },
      } as unknown as ToolboxSnapshot
    }

    it('says so on the row and offers to write the account Key back', () => {
      const markup = render({}, undefined, { snapshot: editedSnapshot(), onRewriteKey: () => undefined, onKeepConfig: () => undefined })
      expect(markup).toContain('配置被改过')
      expect(markup).toContain('配置在软件之外被改动过')
      expect(markup).toContain('data-testid="tool-claude-rewrite-key"')
      expect(markup).toContain('重新写入 Key')
      // 站点名永远不上屏，文案以「当前账号」为主语。
      expect(markup).not.toContain('solov')
    })

    it('leaves the other tools on their usual state', () => {
      const markup = render({}, undefined, { snapshot: editedSnapshot(), onRewriteKey: () => undefined })
      expect(markup).not.toContain('data-testid="tool-codex-rewrite-key"')
      expect(markup).toContain('已配好')
    })

    it('keeps the old row untouched when the host offers no rewrite action', () => {
      const markup = render({}, undefined, { snapshot: editedSnapshot() })
      expect(markup).toContain('配置被改过')
      expect(markup).not.toContain('data-testid="tool-claude-rewrite-key"')
    })
  })

  // 以前用 CC Switch 配过的电脑：登录后软件不改来源没确认的配置，工具还连着以前那家，
  // 以前首页只挂一个中性的「用的是别处的配置」。现在要说清是 CC Switch，并给一颗按钮。
  describe('a tool still configured by CC Switch', () => {
    function ccSwitchSnapshot(leftover: 'proxy' | 'provider', extra: Record<string, unknown> = {}): ToolboxSnapshot {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      return {
        ...base,
        config: {
          ...base.config,
          providers: { ...base.config.providers, claude: {
            ...providerConfig, matchesRelay: false, actualBaseUrl: 'https://elsewhere.example', configurationOwnership: 'unknown', ccSwitchLeftover: leftover, ...extra,
          } },
        },
      } as unknown as ToolboxSnapshot
    }

    it('names CC Switch and offers to switch the tool to the current account', () => {
      const markup = render({}, undefined, { snapshot: ccSwitchSnapshot('provider'), onSwitchAccount: () => undefined, onKeepConfig: () => undefined })
      expect(markup).toContain('CC Switch 的设置')
      expect(markup).toContain('还在用 CC Switch 里选的连接，没有用当前账号')
      expect(markup).toContain('data-testid="tool-claude-replace-cc-switch"')
      expect(markup).toContain('改用当前账号')
      expect(markup).not.toContain('用的是别处的配置')
      expect(markup).not.toContain('solov')
    })

    it('warns that a proxy takeover only works while CC Switch is running', () => {
      const markup = render({}, undefined, { snapshot: ccSwitchSnapshot('proxy'), onSwitchAccount: () => undefined })
      expect(markup).toContain('CC Switch 一关就用不了')
    })

    it('does not second-guess a configuration the account already owns', () => {
      const markup = render({}, undefined, { snapshot: ccSwitchSnapshot('provider', { matchesRelay: true, actualBaseUrl: providerConfig.baseUrl, configurationOwnership: 'account' }), onSwitchAccount: () => undefined })
      expect(markup).not.toContain('CC Switch')
    })

    it('keeps the old neutral row when the host offers no switch action', () => {
      const markup = render({}, undefined, { snapshot: ccSwitchSnapshot('provider') })
      expect(markup).toContain('CC Switch 的设置')
      expect(markup).not.toContain('data-testid="tool-claude-replace-cc-switch"')
    })
  })

  // 开机账号恢复超过启动画面的等待上限时先进首页，这时读到的配置没有账号可比。
  // 恢复完补读之前，一行都不许说「配置被改过」或「用的是别处的配置」。
  describe('while the account is still being restored at startup', () => {
    function pendingSnapshot(ownership: 'unknown' | 'changed', extra: Record<string, unknown> = {}): ToolboxSnapshot {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      const pending = { ...providerConfig, configurationOwnership: ownership, ...extra }
      return {
        ...base,
        config: { ownershipPending: true, providers: { claude: pending, codex: pending, grok: pending, gemini: { ...pending, authType: 'gemini-api-key' } } },
      } as unknown as ToolboxSnapshot
    }

    it.each(['unknown', 'changed'] as const)('shows a relay-matching %s configuration as ready, not as edited or third-party', (ownership) => {
      const markup = render({}, undefined, { snapshot: pendingSnapshot(ownership), onRewriteKey: () => undefined, onKeepConfig: () => undefined })
      expect(markup).not.toContain('配置被改过')
      expect(markup).not.toContain('用的是别处的配置')
      expect(markup).not.toContain('rewrite-key')
      expect(markup).toContain('已配好')
    })

    it('still reports a configuration pointing somewhere else, which no account could claim', () => {
      const markup = render({}, undefined, { snapshot: pendingSnapshot('unknown', { matchesRelay: false, actualBaseUrl: 'https://elsewhere.example/v1' }) })
      expect(markup).toContain('用的是别处的配置')
    })

    it('goes back to the real verdict once the re-read config no longer carries the pending mark', () => {
      const base = pendingSnapshot('changed')
      const settled = { ...base, config: { ...base.config, ownershipPending: undefined } } as ToolboxSnapshot
      expect(render({}, undefined, { snapshot: settled })).toContain('配置被改过')
    })
  })
})

describe('renderer-v2 home manual desktop install on macOS', () => {
  const missingStatus = { installed: false, version: null, detectionFailed: false, uninstall: { available: false, reason: null, manualCommand: null } }
  function macSnapshot(): ToolboxSnapshot {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    return {
      ...base,
      platform: {
        platform: 'macos', isMac: true, nodeRuntimeInstall: 'external', pythonRuntimeInstall: 'external',
        cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' },
        codexDesktop: { install: 'external', launch: true, uninstall: false, windowsStore: false },
      },
      system: { ...base.system, desktopApps: { codex: missingStatus } },
    } as unknown as ToolboxSnapshot
  }
  /** 只截某一行的主按钮：整页搜文案会被别的行顶掉，分不清改的是哪一颗。 */
  function rowButton(markup: string, tool: string): string {
    const index = markup.indexOf(`data-testid="tool-${tool}-primary"`)
    expect(index, `没有渲染出 ${tool} 那一行的主按钮`).toBeGreaterThan(-1)
    return markup.slice(markup.lastIndexOf('<button', index), markup.indexOf('</button>', index))
  }
  function clientButton(markup: string): string {
    return rowButton(markup, 'workbuddy')
  }
  const macClient = {
    tool: 'workbuddy', installed: false, version: null, path: null, installDirectory: null, running: false,
    installSupported: false, launchSupported: false, detectionError: null,
    installHint: 'macOS 请先从客户端官网下载并将应用移入 Applications，然后重新检测',
  } as unknown as HomeProps['externalClients'][number]

  it('labels the Codex desktop button as a guide instead of promising an install', () => {
    // macOS 上这颗按钮点下去只能把人带到教程，写「安装」是假的（第七批 3）。
    const markup = render({}, undefined, { snapshot: macSnapshot() })
    expect(rowButton(markup, 'codexDesktop')).toContain('安装指南')
  })

  it('turns the dead 「暂不支持」 client button into a working guide link', () => {
    const markup = render({}, undefined, { snapshot: macSnapshot(), externalClients: [macClient] })
    const button = clientButton(markup)
    expect(button).toContain('安装指南')
    expect(button).not.toContain('disabled')
    expect(markup).not.toContain('暂不支持')
  })

  it('keeps 「暂不支持」 where no guide can help, such as Windows arm64', () => {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    const windows = {
      ...base,
      platform: {
        platform: 'windows', isMac: false, nodeRuntimeInstall: 'managed', pythonRuntimeInstall: 'managed',
        cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' },
        codexDesktop: { install: 'managed', launch: true, uninstall: true, windowsStore: true },
      },
    } as unknown as ToolboxSnapshot
    const markup = render({}, undefined, {
      snapshot: windows,
      externalClients: [{ ...macClient, installHint: '当前处理器架构没有可用的官方 Windows 安装包' } as typeof macClient],
    })
    expect(clientButton(markup)).toContain('暂不支持')
    expect(markup).not.toContain('安装指南')
  })
})

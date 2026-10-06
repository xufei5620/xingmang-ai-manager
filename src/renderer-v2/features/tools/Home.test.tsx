import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Home, lowBalanceText, pickFirstRunTool, recentResumeOffered, type HomeProps } from './Home'
import { presentTools, type ToolboxSnapshot } from './model'
import type { ProviderId } from '../../../../electron/ipc-contract'
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
    expect(markup).toContain('正在停止')
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

  const claudeDesktop = {
    tool: 'claudeDesktop', installed: false, version: null, path: null, installDirectory: null, running: false,
    installSupported: true, launchSupported: false, detectionError: null, installHint: null,
  } as unknown as HomeProps['externalClients'][number]

  it('offers 取消 on a desktop client row while its install can still be stopped', () => {
    const noop = () => undefined
    const markup = render({ claudeDesktop: { label: '正在从 Claude 官网下载离线安装包（42%）', log: [], cancellable: true } }, undefined, {
      externalClients: [claudeDesktop], onCancelInstallExternal: noop,
    })
    expect(markup).toContain('data-testid="tool-claudeDesktop-cancel"')
    const cancelling = render({ claudeDesktop: { label: '正在安装', log: [], cancellable: true, cancelling: true } }, undefined, {
      externalClients: [claudeDesktop], onCancelInstallExternal: noop,
    })
    expect(cancelling).toContain('正在停止')
  })

  it('leaves the desktop client row without 取消 when the host gives no cancel channel or the client is idle', () => {
    const job = { claudeDesktop: { label: '正在安装', log: [], cancellable: true } }
    expect(render(job, undefined, { externalClients: [claudeDesktop] })).not.toContain('data-testid="tool-claudeDesktop-cancel"')
    expect(render({}, undefined, { externalClients: [claudeDesktop], onCancelInstallExternal: () => undefined })).not.toContain('data-testid="tool-claudeDesktop-cancel"')
    expect(render({ 'launch:claudeDesktop': { label: '正在打开客户端', log: [], cancellable: true } }, undefined, {
      externalClients: [claudeDesktop], onCancelInstallExternal: () => undefined,
    })).not.toContain('data-testid="tool-claudeDesktop-cancel"')
  })
})

describe('renderer-v2 home first-run suggestion', () => {
  const allTools = { claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus }
  const noRecords = new Set<ProviderId>()
  function installedTools(clis: Record<string, unknown> = allTools, from = snapshot(clis)) {
    return presentTools(from, null).filter((tool) => tool.status.installed)
  }

  // 记录还没读回来就先给卡，读完发现早就用过又收走，老用户会看到它一闪而过。
  it('waits for the records before offering the card', () => {
    expect(pickFirstRunTool(installedTools(), {}, [], null)).toBeUndefined()
    expect(render({})).not.toContain('data-testid="home-first-run"')
  })

  it('offers the first command once a tool is installed and connected', () => {
    expect(pickFirstRunTool(installedTools(), {}, [], noRecords)?.id).toBe('claude')
  })

  it('moves on to the next tool once its card has been closed', () => {
    expect(pickFirstRunTool(installedTools(), {}, ['claude'], noRecords)?.id).toBe('codex')
  })

  it('stays gone once every tool has been closed', () => {
    expect(pickFirstRunTool(installedTools(), {}, ['claude', 'codex', 'gemini', 'grok'], noRecords)).toBeUndefined()
  })

  // 还没配 Key 时第一条命令敲下去只会报错，那不是「可以试试」。
  it('waits until the tool is actually connected', () => {
    expect(pickFirstRunTool(installedTools(allTools, unreadableConfig()), {}, [], noRecords)).toBeUndefined()
  })

  it('keeps the card off a tool that is still installing', () => {
    expect(pickFirstRunTool(installedTools(), { claude: { label: '正在安装', log: [] } as unknown as ToolJob }, [], noRecords)?.id).toBe('codex')
  })

  // 「最近」里已经有它的记录，说明早就用起来了。
  it('skips a tool that already shows up in the records', () => {
    expect(pickFirstRunTool(installedTools(), {}, [], new Set<ProviderId>(['claude', 'codex']))?.id).toBe('grok')
  })
})

// 「最近」卡在静态渲染里还没读到记录，按钮本身由 app-check.mjs 的浏览器用例盯着；这里只盯判断。
describe('renderer-v2 home recent resume for tools that are not installed (第四十一批 A)', () => {
  const allTools = { claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus }
  const missing = { ...cliStatus, installed: false, version: null, path: null }

  it('offers it for an installed tool', () => {
    expect(recentResumeOffered(presentTools(snapshot(allTools), null), 'claude')).toBe(true)
  })

  // 点下去走的是同一个「打开」，只会弹「工具尚未安装，请先完成准备。」。
  it('drops it for a tool that is not installed', () => {
    expect(recentResumeOffered(presentTools(snapshot({ ...allTools, claude: missing }), null), 'claude')).toBe(false)
  })

  // 只装了 Codex 桌面端：记录在 Codex 名下，接着聊开的却是 Codex CLI。
  it('looks at Codex CLI rather than the desktop app for a Codex record', () => {
    const desktopOnly = { ...snapshot({ ...allTools, codex: missing }), platform: { codexDesktop: { launch: true } } } as unknown as ToolboxSnapshot
    const tools = presentTools(desktopOnly, null)
    expect(tools.find((tool) => tool.id === 'codexDesktop')?.status.installed).toBe(true)
    expect(recentResumeOffered(tools, 'codex')).toBe(false)
  })

  // 检测失败不当没装（A4）：按钮照旧给，点了说检测失败的原因。
  it('keeps it when detection failed instead of calling the tool missing', () => {
    const failed = { ...missing, detectionFailed: true, detectionError: 'npm 查询超时' }
    expect(recentResumeOffered(presentTools(snapshot({ ...allTools, claude: failed }), null), 'claude')).toBe(true)
  })

  // 检测结果还没回来：照旧摆着、灰着等，回来是没装的再收走。
  it('keeps it while the scan has not come back yet', () => {
    expect(recentResumeOffered([], 'claude')).toBe(true)
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

// 这个工具还没有会话记录时，用上次在本软件里选过的文件夹，四个工具只问一次。
describe('renderer-v2 home launch button with a folder picked earlier', () => {
  function withRemembered(rememberedWorkspace: string): string {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    return render({}, undefined, { snapshot: { ...base, config: { ...base.config, rememberedWorkspace } } as ToolboxSnapshot })
  }

  it('names that folder on the button instead of asking again', () => {
    const markup = withRemembered('D:\\projects\\my-project')
    expect(markup).toMatch(/data-testid="tool-claude-primary"[^>]*>(?:<[^>]+>)*打开 my-project/)
    expect(markup).toContain('title="在 D:\\projects\\my-project 打开"')
  })

  it('keeps the dropdown for picking another folder or starting a new one', () => {
    const markup = withRemembered('D:\\projects\\my-project')
    expect(markup).toContain('data-testid="tool-claude-workspaces"')
  })
})

// 第三十一批 A：开机先摆的是上次的检测结果（cachedAt），真结果还在路上。这时只放开
// 「打开」这一类：点下去配置现读、工具由主进程现找；别的按钮照旧等真结果。
describe('renderer-v2 home before the startup scan finishes', () => {
  const account = { userId: 17, username: 'fixture-user', group: 'default', role: 1, quota: 6_200_000, usedQuota: 0 } as HomeProps['account']
  function cached(base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })): ToolboxSnapshot {
    return { ...base, system: { ...base.system, cachedAt: '2026-09-21T10:00:00.000Z' } } as ToolboxSnapshot
  }
  /** 带这个 testid 的那颗按钮（或这个 testid 下面的第一颗）的开始标签。 */
  function buttonTag(markup: string, testId: string): string {
    const index = markup.indexOf(`data-testid="${testId}"`)
    expect(index, `没有渲染出 ${testId}`).toBeGreaterThan(-1)
    const opening = markup.lastIndexOf('<', index)
    const start = markup.startsWith('<button', opening) ? opening : markup.indexOf('<button', index)
    return markup.slice(start, markup.indexOf('>', start) + 1)
  }
  function disabled(markup: string, testId: string): boolean {
    return buttonTag(markup, testId).includes(' disabled=""')
  }
  function whileChecking(overrides: Partial<HomeProps> = {}): string {
    return render({}, undefined, { snapshot: cached(), loading: true, ...overrides })
  }

  it('opens a connected tool from the last saved scan', () => {
    const markup = whileChecking()
    expect(markup).toContain('data-testid="home-cached-scan"')
    expect(markup).toMatch(/data-testid="tool-claude-primary"[^>]*>(?:<[^>]+>)*打开/)
    expect(disabled(markup, 'tool-claude-primary')).toBe(false)
    expect(disabled(markup, 'tool-codex-primary')).toBe(false)
  })

  it('keeps every button waiting during an ordinary rescan', () => {
    const markup = render({}, undefined, { loading: true })
    expect(disabled(markup, 'tool-claude-primary')).toBe(true)
    expect(disabled(markup, 'tool-codex-primary')).toBe(true)
  })

  it('keeps install, retry and connect waiting for the real result', () => {
    const missing = { ...cliStatus, installed: false, version: null, path: null, installDirectory: null }
    const failed = { ...cliStatus, detectionFailed: true, detectionError: '命令入口无法安全执行' }
    const base = snapshot({ claude: cliStatus, codex: failed, grok: missing, gemini: cliStatus })
    const platform = { ...base.platform, cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' } }
    const markup = render({}, undefined, { snapshot: cached({ ...base, platform } as ToolboxSnapshot), loading: true })
    expect(markup).toMatch(/data-testid="tool-grok-primary"[^>]*>(?:<[^>]+>)*安装/)
    expect(disabled(markup, 'tool-grok-primary')).toBe(true)
    expect(markup).toMatch(/data-testid="tool-codex-primary"[^>]*>(?:<[^>]+>)*重新检测/)
    expect(disabled(markup, 'tool-codex-primary')).toBe(true)
    // 夹具里的 Gemini 没配 API Key 模式，算没连上：「连接账号」照旧等。
    expect(markup).toMatch(/data-testid="tool-gemini-primary"[^>]*>(?:<[^>]+>)*连接账号/)
    expect(disabled(markup, 'tool-gemini-primary')).toBe(true)
    expect(disabled(markup, 'tool-claude-primary')).toBe(false)
  })

  it('keeps 重新配置 waiting when the configuration could not be read', () => {
    const markup = render({}, undefined, { snapshot: cached(unreadableConfig()), loading: true, failures: configFailure })
    expect(markup).toMatch(/data-testid="tool-claude-primary"[^>]*>(?:<[^>]+>)*重新配置/)
    expect(disabled(markup, 'tool-claude-primary')).toBe(true)
  })

  it('lets the folder dropdown open next to an enabled 打开', () => {
    const base = cached()
    const markup = whileChecking({ snapshot: { ...base, config: { ...base.config, rememberedWorkspace: 'D:\\projects\\my-project' } } as ToolboxSnapshot })
    expect(disabled(markup, 'tool-claude-primary')).toBe(false)
    expect(disabled(markup, 'tool-claude-workspaces')).toBe(false)
  })

  it('keeps 打开 waiting while another tool is being opened', () => {
    const markup = whileChecking({ jobs: { 'launch:codex': { label: '正在打开', log: [] } } })
    expect(disabled(markup, 'tool-claude-primary')).toBe(true)
  })

  it('waits while the saved login is still being restored', () => {
    expect(disabled(whileChecking({ accountRestoring: true }), 'tool-claude-primary')).toBe(true)
  })

  it('waits while the account key sync has not said which tools change their key', () => {
    expect(disabled(whileChecking({ account }), 'tool-claude-primary')).toBe(true)
    const syncing = { phase: 'syncing' as const, label: '正在同步账号专属 Key', percent: 15, scope: 'scope' }
    expect(disabled(whileChecking({ account, bootstrap: syncing }), 'tool-claude-primary')).toBe(true)
  })

  it('waits only on the tool whose account key changes this startup', () => {
    const bootstrap = { phase: 'inspecting' as const, label: '正在检查已安装工具和连接来源', percent: 40, scope: 'scope', connectedKeyChanges: ['claude' as const] }
    const markup = whileChecking({ account, bootstrap })
    expect(disabled(markup, 'tool-claude-primary')).toBe(true)
    expect(disabled(markup, 'tool-codex-primary')).toBe(false)
  })

  it.each(['configuring', 'verifying'] as const)('keeps only the changing tool and its workspace menu waiting after the scan while %s', (phase) => {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    const current = { ...base, config: { ...base.config, rememberedWorkspace: 'D:\\projects\\my-project' } }
    const bootstrap = { phase, label: '正在更新连接', percent: 65, scope: 'scope', connectedKeyChanges: ['claude' as const] }
    const markup = render({}, undefined, { snapshot: current, loading: false, account, bootstrap })
    expect(disabled(markup, 'tool-claude-primary')).toBe(true)
    expect(disabled(markup, 'tool-claude-workspaces')).toBe(true)
    expect(disabled(markup, 'tool-codex-primary')).toBe(false)
    expect(disabled(markup, 'tool-codex-workspaces')).toBe(false)
  })

  it.each(['official', 'manual'] as const)('keeps an existing %s connection openable during another account sync after the scan', (source) => {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    const current = { ...base, config: { ...base.config, rememberedWorkspace: 'D:\\projects\\my-project', providers: {
      ...base.config.providers,
      claude: { ...base.config.providers.claude, ...(source === 'official'
        ? { hasApiKey: false, matchesRelay: false, actualBaseUrl: '' }
        : { configurationOwnership: 'manual' as const }) },
    } } }
    const bootstrap = { phase: 'syncing' as const, label: '正在同步账号专属 Key', percent: 15, scope: 'scope' }
    const markup = render({}, undefined, { snapshot: current, loading: false, account, bootstrap })
    expect(disabled(markup, 'tool-claude-primary')).toBe(false)
    expect(disabled(markup, 'tool-claude-workspaces')).toBe(false)
  })

  it.each([
    ['after switching saved accounts', { account }],
    ['while a startup restore keeps retrying', { accountRestoring: true }],
  ] as const)('keeps account tools openable after the scan with no key sync running %s', (_case, state) => {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    const current = { ...base, config: { ...base.config, rememberedWorkspace: 'D:\\projects\\my-project' } }
    const markup = render({}, undefined, { snapshot: current, loading: false, bootstrap: null, ...state })
    expect(disabled(markup, 'tool-claude-primary')).toBe(false)
    expect(disabled(markup, 'tool-claude-workspaces')).toBe(false)
  })

  it('releases the migrated tool and its workspace menu after verification finishes', () => {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    const current = { ...base, config: { ...base.config, rememberedWorkspace: 'D:\\projects\\my-project' } }
    const bootstrap = {
      phase: 'verifying' as const, label: '连接已更新', percent: 100, scope: 'scope', connectedKeyChanges: ['claude' as const],
      result: { readyKeys: [], configured: ['claude' as const], failed: [], skipped: [], warnings: [], networkBlocked: false },
    }
    const markup = render({}, undefined, { snapshot: current, loading: false, account, bootstrap })
    expect(disabled(markup, 'tool-claude-primary')).toBe(false)
    expect(disabled(markup, 'tool-claude-workspaces')).toBe(false)
  })

  it('opens once the account key round has finished', () => {
    const bootstrap = {
      phase: 'verifying' as const, label: 'Key 已写入，正在刷新工具状态', percent: 100, scope: 'scope',
      result: { readyKeys: [], configured: [], failed: [], skipped: [], warnings: [], networkBlocked: false },
    }
    expect(disabled(whileChecking({ account, bootstrap }), 'tool-claude-primary')).toBe(false)
  })
})

// 官方安装器/其他来源装的 CLI：如实标源，且不给 npm 更新按钮，改用被动提示。
// 官方安装器装的 Claude Code 例外：星芒卸得掉，按钮照给，点了先问再换成星芒装的。
describe('renderer-v2 home native install source', () => {
  const nativeClaude = { ...cliStatus, installSource: 'native', updateAvailable: true, latestVersion: '9.9.9' }
  const npmClaude = { ...cliStatus, installSource: 'npm', updateAvailable: true, latestVersion: '9.9.9' }
  const nativeCodex = { ...nativeClaude, uninstall: { available: false, reason: '请用它原来的方式卸载', manualCommand: null } }

  it('replaces the npm 更新 button with a passive hint for a native install the app cannot uninstall', () => {
    const markup = render({}, { claude: cliStatus, codex: nativeCodex, grok: cliStatus, gemini: cliStatus })
    expect(markup).toContain('data-testid="tool-codex-external-managed"')
    expect(markup).toContain('该版本由官方安装器管理，请用它自己的方式更新')
    // 那条 external-managed 提示顶掉了 npm 更新按钮。
    expect(markup).not.toContain('>更新<')
  })

  it('keeps the passive hint for a Claude Code installed some other way', () => {
    const markup = render({}, { claude: { ...nativeClaude, installSource: 'path' }, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    expect(markup).toContain('data-testid="tool-claude-external-managed"')
    expect(markup).toContain('该版本不是通过本工具安装的，更新请用它原本的安装方式')
    expect(markup).not.toContain('>更新<')
  })

  it('gives the official-installer Claude Code the same update button instead of the hint', () => {
    const markup = render({}, { claude: nativeClaude, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    expect(markup).toContain('>更新<')
    expect(markup).not.toContain('data-testid="tool-claude-external-managed"')
    expect(markup).not.toContain('该版本由官方安装器管理')
  })

  it('offers a known-problem official-installer Claude Code the recommended version', () => {
    const blockedReason = '这个版本每次提问都会失败，换到推荐版本就好'
    const markup = render({}, { claude: { ...nativeClaude, version: '2.1.276', latestVersion: '2.1.288',
      versionAdvice: { recommendedVersion: '2.1.277', blockedReason, onRecommended: false, pinned: true, rollbackAvailable: true, recommendedIsNewer: true } },
    codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    expect(markup).toContain('data-testid="tool-claude-rollback"')
    expect(markup).toContain('>更新到推荐版本<')
    expect(markup).toContain(`title="${blockedReason}"`)
    expect(markup).not.toContain('data-testid="tool-claude-external-managed"')
  })

  it('still offers the npm 更新 button for an npm install', () => {
    const markup = render({}, { claude: npmClaude, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    expect(markup).toContain('>更新<')
    expect(markup).not.toContain('data-testid="tool-claude-external-managed"')
  })
})

describe('renderer-v2 home pinned update direction', () => {
  const advice = { recommendedVersion: '0.156.1', blockedReason: null, onRecommended: false, pinned: true, rollbackAvailable: true }

  it('does not render an update button for a Codex version ahead of its pinned recommendation', () => {
    const markup = render({}, {
      claude: cliStatus, grok: cliStatus, gemini: cliStatus,
      codex: { ...cliStatus, version: '0.157.0', latestVersion: '0.158.0', updateAvailable: true, versionAdvice: advice },
    })
    expect(markup).not.toContain('>更新<')
  })

  it('still renders an update for an older pinned Codex version', () => {
    const markup = render({}, {
      claude: cliStatus, grok: cliStatus, gemini: cliStatus,
      codex: { ...cliStatus, version: '0.150.0', latestVersion: '0.158.0', updateAvailable: true,
        versionAdvice: { ...advice, recommendedIsNewer: true } },
    })
    expect(markup).toContain('>更新<')
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
 * 第三批候选 10：macOS 上 Python 归客户自己装，原来那颗按钮直接把人丢到英文官网。
 * 第十六批 2 起 Mac 上的 Node.js 由应用准备（managed）。Darwin-only 的分支在 Linux
 * 沙箱里只能靠注入平台能力来演，这里演的是渲染层拿到这组能力后的表现，不是真机行为。
 */
describe('renderer-v2 home missing runtime guidance on macOS', () => {
  function runtimeSnapshot(platform: 'windows' | 'macos' | 'linux', missing: { node?: boolean; python?: boolean }): ToolboxSnapshot {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    const python = platform === 'windows' ? 'managed' : 'external'
    return {
      ...base,
      platform: { ...base.platform, platform, nodeRuntimeInstall: 'managed', pythonRuntimeInstall: python },
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

  it('lets a Mac customer prepare Node.js with one button instead of Terminal steps', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('macos', { node: true }) })
    expect(markup).toContain('data-testid="home-runtime-node-managed"')
    expect(markup).toContain('这台 Mac 上还没有 Node.js')
    expect(markup).toContain('不用输开机密码')
    expect(markup).toContain('准备 Node.js')
    // 终端和 Homebrew 那套挪进教程，首页不再放。
    expect(markup).not.toContain('data-testid="home-runtime-guide-node"')
    expect(markup).not.toContain('brew install node')
    expect(markup).not.toContain('去官网下载 Node.js')
    // Mac 上不提权，Windows 那句管理员授权不能出现。
    expect(markup).not.toContain('data-testid="home-runtime-node-elevation"')
  })

  // Linux 版拆分 ②：原来这里是「去官网下载 Node.js」加一段「用系统自带的包管理器装上」。
  it('lets a Linux customer prepare Node.js with one button instead of a website', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('linux', { node: true }) })
    expect(markup).toContain('data-testid="home-runtime-node-managed"')
    expect(markup).toContain('这台电脑上还没有能用的 Node.js')
    expect(markup).toContain('准备 Node.js')
    expect(markup).not.toContain('data-testid="home-runtime-guide-node"')
    expect(markup).not.toContain('去官网下载 Node.js')
    expect(markup).not.toContain('包管理器')
    expect(markup).not.toContain('data-testid="home-runtime-node-elevation"')
  })

  it('shows the Mac Node.js notice only while Node.js is missing', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('macos', {}) })
    expect(markup).not.toContain('data-testid="home-runtime-node-managed"')
  })

  it('still offers the manual route for a Mac that insists on installing Node.js by hand', () => {
    // 渲染层拿到 external（例如以后某个平台又改回让客户自己装）时，步骤照旧给全。
    const base = runtimeSnapshot('macos', { node: true })
    const external = { ...base, platform: { ...base.platform, nodeRuntimeInstall: 'external' } } as ToolboxSnapshot
    const markup = render({}, undefined, { snapshot: external })
    expect(markup).toContain('data-testid="home-runtime-guide-node"')
    expect(markup).toContain('brew install node')
    expect(markup).not.toContain('data-testid="home-runtime-node-managed"')
  })

  function gitMissingOn(platform: 'windows' | 'macos'): ToolboxSnapshot {
    const base = runtimeSnapshot(platform, {})
    return {
      ...base,
      system: { ...base.system, runtime: { ...base.system.runtime, git: { installed: false, version: null, detectionFailed: false } } },
    } as unknown as ToolboxSnapshot
  }

  it('offers the Install Git button on a Mac and says Apple will show its own window', () => {
    const markup = render({}, undefined, { snapshot: gitMissingOn('macos') })
    expect(markup).toContain('data-testid="home-runtime-git"')
    const hint = markup.slice(markup.indexOf('data-testid="home-runtime-git-hint"'))
    expect(hint.slice(0, hint.indexOf('</p>'))).toContain('在苹果弹出的窗口里点“安装”')
    expect(markup).not.toMatch(/xcode-select|brew install git/)
  })

  it('tells the Mac customer what to click while the Apple installer is open', () => {
    const job = { label: '正在准备安装 Git', log: [] } as unknown as ToolJob
    const markup = render({ git: job }, undefined, { snapshot: gitMissingOn('macos') })
    expect(markup).toContain('data-testid="home-runtime-git-waiting"')
    expect(markup).toContain('在苹果的窗口里点“安装”')
    expect(markup).not.toContain('data-testid="home-runtime-git-hint"')
    // Windows 代装全程在软件里完成，没有这一句。
    const windows = render({ git: job }, undefined, { snapshot: gitMissingOn('windows') })
    expect(windows).not.toContain('data-testid="home-runtime-git-waiting"')
  })

  // 第二十八批 C：四个命令行工具都不用 Python 了，这段改说「要装的话」，不再说 Gemini 要它、劝另装一份。
  it('gives Python its own block, saying none of the four command-line tools needs it', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('macos', { python: true }) })
    expect(markup).toContain('data-testid="home-runtime-guide-python"')
    expect(markup).toContain('brew install python')
    expect(markup).toContain('四个命令行工具都用不到它，外接工具里个别要用它的才需要')
    expect(markup).toContain('要装的话下面两种装法选一种就行')
    expect(markup).not.toContain('Gemini CLI 需要它')
    expect(markup).not.toContain('版本可能过旧')
    expect(markup).toContain('去官网下载 Python（可选环境）')
    expect(markup).toContain('data-testid="home-runtime-python"')
    expect(markup).toContain('data-testid="home-runtime-tutorial"')
    expect(markup).toContain('装 Python 的完整步骤在教程里也有一份')
    // Node 没缺就不该多出一段 Node 的步骤。
    expect(markup).not.toContain('data-testid="home-runtime-guide-node"')
  })

  // Linux 版拆分 ③：Linux 上四个命令行工具都用不到 Python。原来这里写「Gemini CLI 需要它；macOS 自带的…」，
  // 按钮把人送去 python.org（那里给 Linux 的只有源码包），「看教程」进的是 Mac 的章节。
  it('tells a Linux customer Python is optional and never sends them to python.org or the Mac chapter', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('linux', { python: true }) })
    expect(markup).toContain('data-testid="home-runtime-guide-python"')
    expect(markup).toContain('四个命令行工具都用不到它')
    expect(markup).toContain('sudo apt install python3')
    expect(markup).not.toContain('data-testid="home-runtime-python"')
    expect(markup).not.toContain('去官网下载 Python')
    expect(markup).not.toContain('data-testid="home-runtime-tutorial"')
    expect(markup).not.toContain('完整步骤在教程里')
    expect(markup).not.toContain('Gemini CLI 需要它')
    expect(markup).not.toContain('macOS')
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

  it('says on the Codex desktop row that the installed version is known not to start', () => {
    const base = runtimeSnapshot('windows', {})
    const brokenDesktop = {
      ...base,
      platform: { ...base.platform, codexDesktop: { ...base.platform.codexDesktop, launch: true, install: 'managed' } },
      system: {
        ...base.system,
        desktopApps: { codex: { installed: true, detectionFailed: false, version: '26.924.2738.0', appVersion: '26.924.2738', path: 'C:\\fixture' } },
      },
    } as unknown as ToolboxSnapshot
    const markup = render({}, undefined, { snapshot: brokenDesktop })
    expect(markup).toContain('这一版（26.924.2738.0）在一些电脑上打不开')
    expect(markup).toContain('急用先用 Codex 命令行版')
  })

  it('keeps the elevation notice off macOS, where nothing here elevates', () => {
    const markup = render({}, undefined, { snapshot: runtimeSnapshot('macos', { node: true }) })
    expect(markup).not.toContain('data-testid="home-runtime-node-elevation"')
    expect(markup).not.toContain('这一步需要管理员授权')
  })

  it('keeps the elevation notices off a Windows app that already runs with administrator rights', () => {
    // 已知19：自带 Administrator 之类，装 Node.js 和 Codex 桌面端都不弹授权窗口。
    const base = runtimeSnapshot('windows', { node: true })
    const elevated = {
      ...base,
      platform: { ...base.platform, processElevated: true, codexDesktop: { ...base.platform.codexDesktop, launch: true, install: 'managed' } },
      system: { ...base.system, desktopApps: { codex: { installed: false, detectionFailed: false, appVersion: null } } },
    } as unknown as ToolboxSnapshot
    const markup = render({}, undefined, { snapshot: elevated })
    expect(markup).toContain('准备 Node.js')
    expect(markup).not.toContain('data-testid="home-runtime-node-elevation"')
    expect(markup).not.toContain('管理员授权')
    expect(markup).not.toContain('授权窗口')
  })

  it('stays quiet when the probe failed, because then nobody knows whether it is installed', () => {
    const base = runtimeSnapshot('macos', { node: true })
    const failed = {
      ...base,
      system: { ...base.system, runtime: { ...base.system.runtime, node: { installed: false, version: null, detectionFailed: true } } },
    } as unknown as ToolboxSnapshot
    const markup = render({}, undefined, { snapshot: failed })
    expect(markup).not.toContain('data-testid="home-runtime-guide-node"')
    expect(markup).not.toContain('data-testid="home-runtime-node-managed"')
    // 检测失败给「重新检测」：说不准装没装，不先劝人去装。
    expect(markup).toContain('data-testid="home-runtime-rescan"')
    expect(markup).not.toContain('data-testid="home-runtime-node"')
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

  // Codex 老配置把当前账号写在它不认的 openai 名下：原来首页照样显示已配好，打开才报 Key 无效。
  describe('a Codex configuration Codex itself ignores', () => {
    function shadowedSnapshot(): ToolboxSnapshot {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      return {
        ...base,
        config: {
          ...base.config,
          providers: { ...base.config.providers, codex: { ...providerConfig, configurationOwnership: 'account', codexProviderShadowed: true } },
        },
      } as unknown as ToolboxSnapshot
    }

    it('stops calling the row ready and offers to fix it', () => {
      const markup = render({}, undefined, { snapshot: shadowedSnapshot(), onSwitchAccount: () => undefined })
      expect(markup).toContain('连接设置要修')
      expect(markup).toContain('这份配置里有一处 Codex 认不出，打开会连不上')
      expect(markup).toContain('data-testid="tool-codex-repair-codex"')
      expect(markup).toContain('修好它')
      // 修完就能用，「打开」照旧给，点下去先修再打开。
      expect(markup).toMatch(/data-testid="tool-codex-primary"[^>]*>(?:<[^>]+>)*打开/)
      // 来源仍是当前账号，「切回官方账号」那一项不能丢。
      expect(markup).not.toContain('solov')
    })

    it('leaves Claude Code on its usual state', () => {
      const markup = render({}, undefined, { snapshot: shadowedSnapshot(), onSwitchAccount: () => undefined })
      expect(markup).not.toContain('data-testid="tool-claude-repair-codex"')
      expect(markup).toContain('已配好')
    })
  })

  // 卸载后换了文件夹重装、挪了软件、换装了 Node.js：写进工具里的提醒设置还指着旧位置，每一轮都报一行错。
  describe('reminder settings that point at an old location', () => {
    function staleSnapshot(): ToolboxSnapshot {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      return {
        ...base,
        config: {
          ...base.config,
          providers: { ...base.config.providers, claude: { ...providerConfig, configurationOwnership: 'account', cliHooksStale: true } },
        },
      } as unknown as ToolboxSnapshot
    }

    it('says the reminder settings need fixing, offers the fix and still opens the tool', () => {
      const markup = render({}, undefined, { snapshot: staleSnapshot(), onRepairHooks: () => undefined })
      expect(markup).toContain('提醒设置要修')
      expect(markup).toContain('工具里的提醒设置指向了旧位置，每次都会多报一行错')
      expect(markup).toContain('data-testid="tool-claude-repair-hooks"')
      expect(markup).toMatch(/data-testid="tool-claude-primary"[^>]*>(?:<[^>]+>)*打开/)
      expect(markup).not.toContain('data-testid="tool-codex-repair-hooks"')
    })

    it('shows no fix button when the host offers none', () => {
      const markup = render({}, undefined, { snapshot: staleSnapshot() })
      expect(markup).not.toContain('data-testid="tool-claude-repair-hooks"')
    })

    // 第十八批 1b：打开软件时已经替客户改好了，只在工具行上轻轻说一句，不改状态、不给按钮。
    it('mentions quietly that the reminder settings were fixed on startup', () => {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      const repaired = {
        ...base,
        config: {
          ...base.config,
          providers: { ...base.config.providers, claude: { ...providerConfig, configurationOwnership: 'account', cliHooksStale: false, cliHooksAutoRepaired: true } },
        },
      } as unknown as ToolboxSnapshot
      const markup = render({}, undefined, { snapshot: repaired, onRepairHooks: () => undefined })
      expect(markup).toContain('提醒设置指向了旧位置，打开软件时已经自动改好，原来的设置在「备份」里')
      expect(markup).not.toContain('提醒设置要修')
      expect(markup).not.toContain('data-testid="tool-claude-repair-hooks"')
      expect(markup).toMatch(/data-testid="tool-claude-primary"[^>]*>(?:<[^>]+>)*打开/)
    })

    // 客户自己装了 Git 或 PowerShell 7，Windows 版 Grok 换了命令行，写下去的那种写法跑不起来了。
    it('says Grok switched its command line when that is why the hooks need fixing', () => {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      const shellChanged = {
        ...base,
        config: {
          ...base.config,
          providers: { ...base.config.providers, grok: { ...providerConfig, configurationOwnership: 'account', cliHooksStale: true, cliHooksShellChanged: true } },
        },
      } as unknown as ToolboxSnapshot
      const markup = render({}, undefined, { snapshot: shellChanged, onRepairHooks: () => undefined })
      expect(markup).toContain('Grok 换了命令行，星芒写的提醒设置要跟着改一下，不然每次都会多报一行错')
      expect(markup).not.toContain('工具里的提醒设置指向了旧位置')
      expect(markup).toContain('data-testid="tool-grok-repair-hooks"')
    })

    // Windows 上只装 Grok 时没有运行环境，做完提醒和防睡写不上：说缺什么，给「补上」，Grok 照样能打开。
    function missingSnapshot(nodeInstalled: boolean): ToolboxSnapshot {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      return {
        ...base,
        system: { ...base.system, runtime: { ...base.system.runtime, node: { installed: nodeInstalled, version: nodeInstalled ? '24.6.0' : null, detectionFailed: false } } },
        config: {
          ...base.config,
          providers: { ...base.config.providers, grok: { ...providerConfig, configurationOwnership: 'account', cliHooksStale: false, cliHooksMissing: true } },
        },
      } as unknown as ToolboxSnapshot
    }

    it('says which two things Grok is missing and offers to add them without technical words', () => {
      const markup = render({}, undefined, { snapshot: missingSnapshot(false), onRepairHooks: () => undefined })
      expect(markup).toContain('做完、出错时的提醒和干活时不让电脑睡着这两项还没开，点「补上」准备好运行环境就有')
      expect(markup).toContain('data-testid="tool-grok-add-hooks"')
      expect(markup).not.toContain('data-testid="tool-grok-repair-hooks"')
      expect(markup).not.toContain('提醒设置要修')
      expect(markup).toMatch(/data-testid="tool-grok-primary"[^>]*>(?:<[^>]+>)*打开/)
      expect(markup).not.toContain('data-testid="tool-claude-add-hooks"')
    })

    it('offers to add them straight away once the computer already has what they need', () => {
      const markup = render({}, undefined, { snapshot: missingSnapshot(true), onRepairHooks: () => undefined })
      expect(markup).toContain('做完、出错时的提醒和干活时不让电脑睡着这两项还没开，点「补上」就有')
      expect(markup).toContain('data-testid="tool-grok-add-hooks"')
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

  // 来源没确认的 Key（方案盘查 2026-09-25）：只分「不是当前账号的站」和「当前站上认不出
  // 是谁的」，不显示对方是谁；两种都给一颗写着账号名的「改用」。
  describe('a tool whose key the current account did not write', () => {
    function foreignSnapshot(extra: Record<string, unknown>): ToolboxSnapshot {
      const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
      return {
        ...base,
        config: { ...base.config, providers: { ...base.config.providers, claude: { ...providerConfig, configurationOwnership: 'unknown', ...extra } } },
      } as unknown as ToolboxSnapshot
    }

    it('says a key from another site is not the current account\'s and offers to switch by name', () => {
      const markup = render({}, undefined, { snapshot: foreignSnapshot({ matchesRelay: false, actualBaseUrl: 'https://elsewhere.example/v1' }), onSwitchAccount: () => undefined })
      expect(markup).toContain('不是当前账号的 Key')
      expect(markup).toContain('在这里打不开，改用你的账号就能用')
      expect(markup).toContain('data-testid="tool-claude-use-account"')
      expect(markup).not.toContain('elsewhere.example')
      expect(markup).not.toContain('用的是别处的配置')
    })

    it('warns that a key on the current site may bill another account', () => {
      const markup = render({}, undefined, { snapshot: foreignSnapshot({}), onSwitchAccount: () => undefined })
      expect(markup).toContain('Key 可能不是当前账号的')
      expect(markup).toContain('用量可能算到别的账号上')
      expect(markup).toContain('data-testid="tool-claude-use-account"')
    })

    it('leaves the switch button out when the host offers no switch action', () => {
      const markup = render({}, undefined, { snapshot: foreignSnapshot({ matchesRelay: false, actualBaseUrl: 'https://elsewhere.example/v1' }) })
      expect(markup).toContain('不是当前账号的 Key')
      expect(markup).not.toContain('data-testid="tool-claude-use-account"')
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
      expect(markup).not.toContain('不是当前账号的')
      expect(markup).not.toContain('rewrite-key')
      expect(markup).toContain('已配好')
    })

    it('still reports a configuration pointing somewhere else, which no account could claim', () => {
      const markup = render({}, undefined, { snapshot: pendingSnapshot('unknown', { matchesRelay: false, actualBaseUrl: 'https://elsewhere.example/v1' }) })
      expect(markup).toContain('不是当前账号的 Key')
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
  /** 'external' 是主进程认不出芯片的那台 Mac；认得出的两种芯片都是 'managed'。 */
  function macSnapshot(codexDesktopInstall: 'managed' | 'external' = 'external'): ToolboxSnapshot {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    return {
      ...base,
      platform: {
        platform: 'macos', isMac: true, nodeRuntimeInstall: 'external', pythonRuntimeInstall: 'external',
        cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' },
        codexDesktop: { install: codexDesktopInstall, launch: true, uninstall: false, windowsStore: false },
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
    // 主进程认不出芯片的 Mac 上这颗按钮点下去只能把人带到教程，写「安装」是假的（第七批 3）。
    const markup = render({}, undefined, { snapshot: macSnapshot() })
    expect(rowButton(markup, 'codexDesktop')).toContain('安装指南')
  })

  it('offers a real install of the Codex desktop app and Claude Desktop on a Mac the main process can install them on', () => {
    const claudeDesktop = { ...macClient, tool: 'claudeDesktop', installSupported: true, installHint: null } as typeof macClient
    const markup = render({}, undefined, { snapshot: macSnapshot('managed'), externalClients: [macClient, claudeDesktop] })
    for (const tool of ['codexDesktop', 'claudeDesktop']) {
      const button = rowButton(markup, tool)
      expect(button, tool).toContain('安装')
      expect(button, tool).not.toContain('安装指南')
      expect(button, tool).not.toContain('disabled')
    }
    // WorkBuddy 还没有可核对的 Mac 官方包，照旧带去教程。
    expect(clientButton(markup)).toContain('安装指南')
  })

  it('turns the dead 「暂不支持」 client button into a working guide link', () => {
    const markup = render({}, undefined, { snapshot: macSnapshot(), externalClients: [macClient] })
    const button = clientButton(markup)
    expect(button).toContain('安装指南')
    expect(button).not.toContain('disabled')
    expect(markup).not.toContain('暂不支持')
  })

  it('offers a real install on a Mac for a client whose official Mac package the main process can fetch', () => {
    const opencode = { ...macClient, tool: 'opencode', installSupported: true, installHint: null } as typeof macClient
    const markup = render({}, undefined, { snapshot: macSnapshot(), externalClients: [macClient, opencode] })
    const button = rowButton(markup, 'opencode')
    expect(button).toContain('安装')
    expect(button).not.toContain('安装指南')
    expect(button).not.toContain('disabled')
    // 其余没有可核对官方包的，照旧带去教程。
    expect(clientButton(markup)).toContain('安装指南')
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

  it('offers the official download page when Windows cannot install the client in one click', () => {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    const windows = {
      ...base,
      platform: {
        platform: 'windows', isMac: false, nodeRuntimeInstall: 'managed', pythonRuntimeInstall: 'managed',
        cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' },
        codexDesktop: { install: 'managed', launch: true, uninstall: true, windowsStore: true },
      },
    } as unknown as ToolboxSnapshot
    const opencode = {
      ...macClient, tool: 'opencode', installHint: '这台电脑缺少系统自带的应用安装组件，不能一键安装；点「去官网下载」装好后回来重新检测',
      officialDownloadUrl: 'https://opencode.ai/download',
    } as typeof macClient
    const withDownload = render({}, undefined, { snapshot: windows, externalClients: [opencode], onOpenExternalDownload: () => undefined })
    expect(rowButton(withDownload, 'opencode')).toContain('去官网下载')
    expect(rowButton(withDownload, 'opencode')).not.toContain('disabled')
    expect(withDownload).not.toContain('暂不支持')
    expect(withDownload).not.toMatch(/winget|ENOENT/i)
    // 没接下载入口的宿主仍是旧行为：点不动的「暂不支持」。
    expect(rowButton(render({}, undefined, { snapshot: windows, externalClients: [opencode] }), 'opencode')).toContain('暂不支持')
  })
})

describe('renderer-v2 home balance for subscription customers', () => {
  const empty = { quota: 0, usedQuota: 0, quotaPerUnit: 500_000, quotaDisplayType: 'USD', usdExchangeRate: 7.3, displayAmount: 0 }
  const endsAt = new Date(2026, 9, 3, 12).toISOString()
  const subscription = { name: '月卡', remainingUsd: 8, endsAt, expiringSoon: false, lowRemaining: false, subscriptionOnly: false }

  it('keeps the low-balance warning for wallet-only customers', () => {
    const markup = render({}, undefined, { balance: empty })
    expect(markup).toContain('data-testid="home-low-balance"')
    expect(markup).toContain('当前账号余额是 $0，充值后 AI 工具才能用。')
    expect(markup).not.toContain('余额只剩')
    expect(markup).not.toContain('home-subscription')
  })

  it('tells a brand-new account to top up first instead of saying the balance ran low', () => {
    expect(lowBalanceText(0)).toBe('当前账号余额是 $0，充值后 AI 工具才能用。付完马上生效，不用重新设置。')
    expect(lowBalanceText(-0.2)).toMatch(/^当前账号余额是 \$0/)
    expect(lowBalanceText(3.456)).toBe('余额只剩 $3.46，充值后可继续使用。')
  })

  it('drops the empty-wallet warning and shows the subscription while one is usable', () => {
    const markup = render({}, undefined, { balance: empty, subscription })
    expect(markup).not.toContain('home-low-balance')
    expect(markup).toContain('订阅：月卡 · 剩余 $8.00 · 10 月 3 日到期')
    expect(markup).not.toContain('tone-bad')
  })

  it('warns about renewal when the subscription is about to end and the wallet cannot take over', () => {
    const markup = render({}, undefined, { balance: empty, subscription: { ...subscription, expiringSoon: true } })
    expect(markup).toContain('订阅 10 月 3 日到期，到期后会从余额扣费。')
    expect(markup).toContain('去续费')
    expect(markup).not.toContain('home-low-balance')
  })
})

describe('renderer-v2 home runtime card', () => {
  function withNpm(npm: Record<string, unknown>): ToolboxSnapshot {
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: cliStatus })
    return { ...base, system: { ...base.system, runtime: { ...base.system.runtime, npm } } } as unknown as ToolboxSnapshot
  }

  it('does not list npm as its own row', () => {
    const markup = render({})
    expect(markup).toContain('data-testid="home-runtime-row-node"')
    expect(markup).not.toContain('data-testid="home-runtime-row-npm"')
    expect(markup).not.toContain('<strong>npm</strong>')
  })

  it('says on the Node.js row when the part that installs tools is missing', () => {
    const markup = render({}, undefined, { snapshot: withNpm({ installed: false, version: null, detectionFailed: false }) })
    expect(markup).toContain('22.0.0 · 少了装工具用的组件，重装一次 Node.js 就好')
  })

  it('stays quiet when the check itself failed rather than the part being missing', () => {
    const markup = render({}, undefined, { snapshot: withNpm({ installed: false, version: null, detectionFailed: true }) })
    expect(markup).not.toContain('少了装工具用的组件')
  })
})

/**
 * 第二十七批 B（A014 截图）：只装了 Codex 桌面端的客户。桌面端自带运行环境，Node.js 和 Python、Git
 * 一样只是可选；缺 Git 那段讲的是 Claude Code。装了或正在装命令行工具时照旧。
 */
describe('renderer-v2 home runtime card when only the Codex desktop app is in use', () => {
  const missing = { installed: false, version: null, detectionFailed: false }
  const notInstalled = { ...cliStatus, installed: false, version: null, path: null, installDirectory: null }
  const optionalElevation = 'Node.js 是命令行工具需要的运行环境，装工具时会自动准备，一般不用单独点。准备时 Windows 会弹一次授权窗口，请选「是」；如果这台电脑登录的是普通账号，还要输入一个管理员账号的密码。'
  const requiredElevation = '这一步需要管理员授权：准备 Node.js 时 Windows 会弹一次授权窗口，请选「是」，Node.js 才装得上；如果这台电脑登录的是普通账号，还要输入一个管理员账号的密码。'

  function machine(platform: 'windows' | 'macos', clis: Record<string, unknown> = {}): ToolboxSnapshot {
    const base = snapshot({ claude: notInstalled, codex: notInstalled, grok: notInstalled, gemini: notInstalled, ...clis })
    return {
      ...base,
      platform: {
        ...base.platform, platform, nodeRuntimeInstall: 'managed', pythonRuntimeInstall: platform === 'windows' ? 'managed' : 'external',
        cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' },
        codexDesktop: { launch: true, install: platform === 'windows' ? 'managed' : 'external' },
      },
      system: { ...base.system, runtime: { node: missing, npm: missing, python: missing, git: missing } },
    } as unknown as ToolboxSnapshot
  }

  function opening(markup: string, testId: string, close: string): string {
    const at = markup.indexOf(`data-testid="${testId}"`)
    if (at < 0) return ''
    const start = markup.lastIndexOf('<', at)
    return markup.slice(start, markup.indexOf(close, at))
  }

  it('shows Node.js as optional and drops the Claude Code Git paragraph on a Windows desktop-only machine', () => {
    const markup = render({}, undefined, { snapshot: machine('windows') })
    const node = opening(markup, 'home-runtime-row-node', '</div>')
    expect(node).toContain('可选 · 未装')
    expect(node).not.toContain('is-warn')
    expect(markup).not.toContain('data-testid="home-runtime-git-hint"')
    expect(markup).not.toContain('Claude Code 的部分功能')
    const elevation = opening(markup, 'home-runtime-node-elevation', '</p>')
    expect(elevation).toContain('is-quiet')
    expect(elevation).toContain(optionalElevation)
    expect(markup).not.toContain('这一步需要管理员授权')
    // 按钮一颗不少：想先准备好的照样能点。
    expect(markup).toContain('data-testid="home-runtime-node"')
    expect(markup).toContain('data-testid="home-runtime-python"')
    expect(markup).toContain('data-testid="home-runtime-git"')
  })

  it('keeps the warning and names the step by the home button once Claude Code is installed', () => {
    const markup = render({}, undefined, { snapshot: machine('windows', { claude: cliStatus }) })
    const node = opening(markup, 'home-runtime-row-node', '</div>')
    expect(node).toContain('未安装')
    expect(node).not.toContain('可选')
    expect(node).toContain('is-warn')
    expect(markup).toContain('data-testid="home-runtime-git-hint"')
    expect(markup).toContain('Claude Code 的部分功能')
    const elevation = opening(markup, 'home-runtime-node-elevation', '</p>')
    expect(elevation).not.toContain('is-quiet')
    expect(elevation).toContain(requiredElevation)
    expect(markup).not.toContain('点「安装」后')
  })

  it('treats a tool that is still installing as in use, so the UAC sentence is orange when the prompt is about to appear', () => {
    const job = { label: '正在准备 Node.js 运行环境（1/2）', log: [] } as unknown as ToolJob
    const markup = render({ claude: job }, undefined, { snapshot: machine('windows') })
    expect(opening(markup, 'home-runtime-row-node', '</div>')).toContain('is-warn')
    const elevation = opening(markup, 'home-runtime-node-elevation', '</p>')
    expect(elevation).not.toContain('is-quiet')
    expect(elevation).toContain(requiredElevation)
    expect(markup).toContain('data-testid="home-runtime-git-hint"')
  })

  it('keeps the Git paragraph for Claude Code only, but still warns about Node.js for any other command-line tool', () => {
    const markup = render({}, undefined, { snapshot: machine('windows', { codex: cliStatus }) })
    expect(opening(markup, 'home-runtime-row-node', '</div>')).toContain('is-warn')
    expect(opening(markup, 'home-runtime-node-elevation', '</p>')).toContain(requiredElevation)
    expect(markup).not.toContain('data-testid="home-runtime-git-hint"')
  })

  it('does not take a failed probe for an uninstalled tool (A4)', () => {
    const failed = { ...notInstalled, detectionFailed: true, detectionError: '本地探针暂时不可用' }
    const markup = render({}, undefined, { snapshot: machine('windows', { claude: failed }) })
    expect(opening(markup, 'home-runtime-row-node', '</div>')).toContain('is-warn')
    expect(markup).toContain('data-testid="home-runtime-git-hint"')
  })

  it('greys out the Mac Node.js paragraph without changing a word when nothing needs it', () => {
    const quiet = render({}, undefined, { snapshot: machine('macos') })
    const managed = opening(quiet, 'home-runtime-node-managed', '</p>')
    expect(managed).toContain('is-quiet')
    expect(managed).toContain('这台 Mac 上还没有 Node.js')
    expect(opening(quiet, 'home-runtime-row-node', '</div>')).toContain('可选 · 未装')
    expect(quiet).not.toContain('data-testid="home-runtime-git-hint"')
    expect(quiet).not.toContain('data-testid="home-runtime-node-elevation"')

    const inUse = render({}, undefined, { snapshot: machine('macos', { claude: cliStatus }) })
    const warned = opening(inUse, 'home-runtime-node-managed', '</p>')
    expect(warned).not.toContain('is-quiet')
    expect(warned).toContain('这台 Mac 上还没有 Node.js')
    expect(inUse).toContain('data-testid="home-runtime-git-hint"')
  })
})

describe('Home balance card while a saved login is being restored', () => {
  it('does not ask the user to sign in when the login is still on this computer', () => {
    // 开机恢复联不上时登录还在，「登录后查看用量」会让人以为掉线了要重新登录。
    const restoring = render({}, undefined, { accountRestoring: true })
    expect(restoring).toContain('登录恢复后自动显示用量')
    expect(restoring).not.toContain('登录后查看用量')
    expect(render({})).toContain('登录后查看用量')
  })
})

describe('Home sections and balance labels', () => {
  function section(markup: string, testId: string): string {
    const at = markup.indexOf(`data-testid="${testId}"`)
    if (at < 0) return ''
    return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('</section>', at))
  }

  it('keeps a tool whose detection failed under 你的工具 and says how many were not detected', () => {
    // 主进程探测失败时回的就是 installed:false + detectionFailed（buildToolStatusFromSettled）。
    const failed = { ...cliStatus, installed: false, version: null, path: null, installDirectory: null, detectionFailed: true, detectionError: '命令入口无法安全执行' }
    const base = snapshot({ claude: cliStatus, codex: cliStatus, grok: cliStatus, gemini: failed })
    const platform = { ...base.platform, cliInstall: { claude: 'managed', codex: 'managed', gemini: 'managed', grok: 'managed' } }
    const markup = render({}, undefined, { snapshot: { ...base, platform } as ToolboxSnapshot })
    const yours = section(markup, 'home-your-tools')
    expect(yours).toContain('data-testid="tool-row-gemini"')
    expect(yours).toMatch(/\d+ 个已装 · \d+ 个已连接 · 1 个没检测出来/)
    expect(section(markup, 'home-available')).not.toContain('data-testid="tool-row-gemini"')
  })

  it('says what the balance card is waiting for instead of claiming nothing was read', () => {
    const account = { id: 7, username: 'peaker', displayName: 'peaker', group: 'default', quota: 0, usedQuota: 0, requestCount: 0 } as unknown as HomeProps['account']
    const reading = render({}, undefined, { account })
    expect(section(reading, 'home-balance')).toContain('—')
    expect(reading).toContain('正在读取余额')
    expect(reading).not.toContain('暂时没有读到')
    expect(render({}, undefined, { accountRestoring: true })).toContain('正在恢复登录')
  })
})

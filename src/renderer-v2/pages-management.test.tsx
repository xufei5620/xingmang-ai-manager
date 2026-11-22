import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { V2Bridge } from './types'
import { BackupCard } from './features/settings/BackupCard'
import { SessionsPage, sessionRowMeta, sessionToolCounts } from './pages-management'
import {
  CuratedDetails,
  curatedRuntimeCommand,
  curatedVersionText,
  customMcpProblem,
  extensionToolChoices,
  extensionToolName,
  extensionToolNames,
  extensionUpdateStatus,
  extensionUsableTools,
  extensionFailureTarget,
  extensionFormOffersProject,
  extensionInstallNeedsTrust,
  extensionRowState,
  fillCuratedPlaceholders,
  findNativeSkill,
  mcpCommandRuntime,
  mcpAuthorized,
  mcpHealthView,
  mcpNeedsLogin,
  mcpNamesInScope,
  preferredExtensionProvider,
  parseCommandArguments,
  parseEnvironmentVariables,
  mcpRuntimeNotice,
  officialMarketplaceNotice,
  runExtensionAction,
  submitMcpInstall,
  unresolvedInstallPlaceholders,
} from './features/extensions/extensions-common'
import { PluginsHub } from './features/extensions/PluginsHub'
import { HubToolPicker } from './features/extensions/PluginsHubDialogs'
import {
  curatedDisclaimer,
  curatedExtensions,
} from './registry/curated-extensions'
import * as sessionsPage from './features/sessions/SessionsPage'

function item(id: string) {
  const found = curatedExtensions.find((entry) => entry.id === id)
  if (!found) throw new Error(`精选清单里没有 ${id}`)
  return found
}

// submitMcpInstall 只收 MCP 那两种形态，精选里还有插件：这个夹具替编译器把类型收窄掉。
function mcpInstall(id: string) {
  const install = item(id).install
  if (install.type === 'plugin') throw new Error(`${id} 不是 MCP 条目`)
  return install
}

// 精选条目点「+」后安装框里那一段（「插件」页的安装框，原来精选页、外接工具页的确认框也是它）。
describe('curated entry details', () => {
  // 要不要联网放在这里说：列表上每一行都写一遍会把说明挤长。
  it('says in the details whether the entry needs the network', () => {
    expect(renderToStaticMarkup(<CuratedDetails item={item('files')} />)).toContain('第一次使用时需要联网下载')
    expect(renderToStaticMarkup(<CuratedDetails item={item('code-review')} />)).toContain('安装时需要联网下载一次')
  })

  // 用户点「安装」之后看到的就是这一段，所以「将要执行的确切命令」必须原样出现在里面，
  // 免责说明也不能因为条目不同而漏掉。
  it('states the exact command, the risk and the disclaimer before anything is installed', () => {
    const markup = renderToStaticMarkup(<CuratedDetails item={item('files')} />)
    expect(markup).toContain('npx -y @modelcontextprotocol/server-filesystem@2026.8.31 {{directory}}')
    expect(markup).toContain('<dt>提供方</dt><dd>MCP 官方</dd>')
    expect(markup).toContain('会修改本地文件')
    expect(markup).toContain('改动不进回收站')
    expect(markup).toContain('装到哪里')
    expect(markup).toContain('用的是星芒装好的运行环境')
    expect(markup).not.toContain('Node.js')
    expect(markup).toContain(curatedDisclaimer)
  })

  // 安装框下面另有「装到哪里」那一组，不再写「当前这个工具」装在哪一层。
  it('leaves out the fixed scope line when the dialog picks the tools itself', () => {
    const markup = renderToStaticMarkup(<CuratedDetails item={item('files')} hideScope />)
    expect(markup).not.toContain('装到哪里')
    expect(markup).toContain('将写进配置、由工具启动时执行的命令')
  })

  it('shows the remote address and the login requirement for an online service', () => {
    const markup = renderToStaticMarkup(<CuratedDetails item={item('github')} />)
    expect(markup).toContain('将写进配置的服务地址')
    expect(markup).toContain('https://api.githubcopilot.com/mcp/')
    expect(markup).toContain('需要先登录')
    expect(markup).toContain('每次使用都需要联网')
  })

  it('says so plainly when an entry carries no particular risk', () => {
    const markup = renderToStaticMarkup(<CuratedDetails item={item('sequential-thinking')} />)
    expect(markup).toContain('无特殊风险')
    expect(markup).toContain('用掉的额度比平时多')
  })

  // Mac 验收 R10：每个风险标签在 registry 里都配了一句说明（11-10 已批），原来哪儿都没上屏。现在鼠标停在标签上能看到，
  // 标签下面也按标签先后原样写出来。随包清单里眼下没有带「第三方维护」的条目，这里拿 github 换上两个标签来测。
  it('spells out what each risk tag means on hover and right under the tags', () => {
    const markup = renderToStaticMarkup(<CuratedDetails item={{ ...item('github'), risks: ['remote-exec', 'third-party'] }} hideScope />)
    expect(markup).toContain('<span title="由该软件的作者维护，不随星芒一起更新。">第三方维护</span>')
    expect(markup).toContain('<span title="请求由提供方在他们的服务器上处理，不在你电脑上。">内容会发到对方服务器</span>')
    expect(markup).toContain('data-testid="curated-risk-details-github">请求由提供方在他们的服务器上处理，不在你电脑上。由该软件的作者维护，不随星芒一起更新。</p>')
    // 说明紧跟在标签那一行后面，排在提供方、命令那几行前面。
    expect(markup.indexOf('curated-risk-details-github')).toBeLessThan(markup.indexOf('<dt>提供方</dt>'))
  })

  it('adds no risk sentence when the entry carries no risk tag', () => {
    expect(renderToStaticMarkup(<CuratedDetails item={item('sequential-thinking')} />)).not.toContain('curated-risk-details')
  })

  // 装插件要先保证官方市场在册，所以确认框里是两条命令；钉不住版本这件事也必须写出来。
  it('lists both plugin commands and says which version will land', () => {
    const markup = renderToStaticMarkup(<CuratedDetails item={item('code-review')} />)
    expect(markup).toContain('将要执行的命令')
    expect(markup).toContain('claude plugin marketplace add anthropics/claude-plugins-official')
    expect(markup).toContain('claude plugin install code-review@claude-plugins-official')
    expect(markup).toContain('安装的是官方市场当前的版本')
    expect(markup).toContain('c447c3207a42')
    expect(markup).toContain('只给工具本身加命令和技能')
    expect(markup).toContain(curatedDisclaimer)
  })

  it('says which version a plugin declares for itself when it declares one', () => {
    expect(curatedVersionText(item('claude-md-management'))).toContain('插件自己声明的版本是 1.0.0')
    expect(curatedVersionText(item('browser'))).toBe('固定在 0.0.82')
    expect(curatedVersionText(item('github'))).toBe('由服务方在线提供，无本地版本')
  })
})

describe('MCP install submission', () => {
  it('refuses a configuration whose placeholders were never filled in', () => {
    expect(unresolvedInstallPlaceholders(['-y', 'pkg', '{{directory}}'], {})).toEqual(['{{directory}}'])
    expect(unresolvedInstallPlaceholders([], { MEMORY_FILE_PATH: '{{directory}}/a.jsonl' })).toEqual([
      '{{directory}}',
    ])
    expect(unresolvedInstallPlaceholders(['-y', 'pkg', 'D:\\work'], {})).toEqual([])
  })

  // Codex 有自己的 MCP 原生接口，其余三家走 mutateProviderExtension。精选与手填表单共用
  // 这一个出口，主进程那侧的命令与参数校验对两个入口同样生效。
  it('routes Codex to its native interface and everyone else to the shared mutation', async () => {
    const addMcpServer = vi.fn(async () => [])
    const mutateProviderExtension = vi.fn(async () => ({}))
    const api = { addMcpServer, mutateProviderExtension } as unknown as Parameters<
      typeof submitMcpInstall
    >[0]
    const install = mcpInstall('files')
    await submitMcpInstall(api, 'claude', 'files', install, 'user')
    expect(mutateProviderExtension).toHaveBeenCalledWith({
      provider: 'claude',
      kind: 'mcp',
      action: 'install',
      id: 'files',
      scope: 'user',
      mcp: install,
    })
    await submitMcpInstall(api, 'codex', 'files', install, 'user')
    expect(addMcpServer).toHaveBeenCalledWith({ name: 'files', ...install })
    expect(mutateProviderExtension).toHaveBeenCalledTimes(1)
  })

  it('only forwards the advanced Codex auth fields on an http connection', async () => {
    const addMcpServer = vi.fn(async () => [])
    const api = { addMcpServer, mutateProviderExtension: vi.fn() } as unknown as Parameters<
      typeof submitMcpInstall
    >[0]
    await submitMcpInstall(api, 'codex', 'github', mcpInstall('github'), 'user', {
      bearerTokenEnvVar: 'TOKEN',
    })
    expect(addMcpServer).toHaveBeenCalledWith({
      name: 'github',
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      bearerTokenEnvVar: 'TOKEN',
    })
    await submitMcpInstall(api, 'codex', 'files', mcpInstall('files'), 'user', {
      bearerTokenEnvVar: 'TOKEN',
    })
    expect(addMcpServer).toHaveBeenLastCalledWith({ name: 'files', ...mcpInstall('files') })
  })
})

describe('official plugin marketplace notice', () => {
  it('says nothing for a tool that has no official marketplace', () => {
    expect(officialMarketplaceNotice(undefined)).toBeNull()
  })

  it('asks the user to add the marketplace when it is missing, and explains the Git requirement', () => {
    const notice = officialMarketplaceNotice({
      name: 'claude-plugins-official',
      registered: false,
      reason: null,
    })
    expect(notice).toMatchObject({ tone: 'warn', needsAction: true })
    expect(notice?.body).toContain('Git')
  })

  it('prefers the reason the main process reported over the generic explanation', () => {
    expect(officialMarketplaceNotice({
      name: 'claude-plugins-official',
      registered: false,
      reason: 'Claude Code 插件市场列表读取失败：命令超时',
    })?.body).toBe('Claude Code 插件市场列表读取失败：命令超时')
  })

  it('offers to download the Codex catalog in plain words, without asking for Git', () => {
    const notice = officialMarketplaceNotice({
      name: 'openai-api-curated',
      registered: false,
      reason: null,
    })
    expect(notice).toMatchObject({ tone: 'warn', needsAction: true, actionLabel: '下载插件目录' })
    expect(notice?.body).not.toContain('Git')
    expect(officialMarketplaceNotice({ name: 'openai-api-curated', registered: true, reason: null }))
      .toMatchObject({ tone: 'neutral', needsAction: false, title: '官方插件目录已就绪' })
  })

  it('stops asking once the marketplace is registered', () => {
    expect(officialMarketplaceNotice({
      name: 'claude-plugins-official',
      registered: true,
      reason: null,
    })).toMatchObject({ tone: 'neutral', needsAction: false })
  })
})

function healthReport(
  entries: Array<{ id: string; state: 'connected' | 'failed' | 'unknown'; detail: string | null }>,
  reason: string | null = null,
) {
  return { provider: 'claude' as const, checkedAt: '2026-09-22T00:00:00.000Z', supported: true, reason, entries }
}

describe('MCP connection health pill', () => {
  it('draws nothing before the first check, so an old result never looks fresh', () => {
    expect(mcpHealthView(null, 'files')).toBeNull()
  })

  it('says it is checking while the probe runs, rather than showing the previous answer', () => {
    const stale = healthReport([{ id: 'files', state: 'connected', detail: null }])
    expect(mcpHealthView(stale, 'files', true)).toEqual({
      tone: 'neutral',
      label: '检测中',
      detail: null,
    })
  })

  it('maps the three answers onto the three tones', () => {
    const report = healthReport([
      { id: 'files', state: 'connected', detail: null },
      { id: 'browser', state: 'failed', detail: '启动失败' },
      { id: 'memory', state: 'unknown', detail: '这条连接已在工具里停用，本次没有检测' },
    ])
    expect(mcpHealthView(report, 'files')).toEqual({ tone: 'ok', label: '连接正常', detail: null })
    expect(mcpHealthView(report, 'browser')).toEqual({ tone: 'warn', label: '无法连接', detail: '启动失败' })
    expect(mcpHealthView(report, 'memory')).toEqual({
      tone: 'neutral',
      label: '未检测',
      detail: '这条连接已在工具里停用，本次没有检测',
    })
  })

  // 工具压根没回这一条时，原因只能用整份报告那一句；工具什么都没说就什么都不写。
  it('falls back to the report reason for a connection the tool did not answer for', () => {
    expect(mcpHealthView(healthReport([], '当前工具没有提供连接状态'), 'files')).toEqual({
      tone: 'neutral',
      label: '未检测',
      detail: '当前工具没有提供连接状态',
    })
    expect(mcpHealthView(healthReport([]), 'files')).toEqual({
      tone: 'neutral',
      label: '未检测',
      detail: null,
    })
  })
})

describe('Python runtime notice before adding a connection', () => {
  const managed = 'managed' as const
  const external = 'external' as const

  it('recognizes the Python-family launchers, including a full path and a Windows suffix', () => {
    expect(mcpCommandRuntime('uvx')).toBe('uv')
    expect(mcpCommandRuntime('C:\\Users\\me\\.local\\bin\\uv.exe')).toBe('uv')
    expect(mcpCommandRuntime('/usr/bin/python3')).toBe('python')
    expect(mcpCommandRuntime('pipx')).toBe('python')
    expect(mcpCommandRuntime('npx')).toBeNull()
  })

  it('says nothing when the machine already has what the command needs', () => {
    expect(mcpRuntimeNotice('uvx', { python: false, uv: true }, managed)).toBeNull()
    expect(mcpRuntimeNotice('python3', { python: true, uv: false }, managed)).toBeNull()
    expect(mcpRuntimeNotice('npx', { python: false, uv: false }, managed)).toBeNull()
  })

  // 主进程还没给这一块时（旧版本）保持旧行为：不提示。
  it('says nothing when the main process did not report the runtimes', () => {
    expect(mcpRuntimeNotice('uvx', undefined, managed)).toBeNull()
  })

  it('offers the Python installer on the platform that installs it, and says it can still be added', () => {
    const notice = mcpRuntimeNotice('python3', { python: false, uv: false }, managed)
    expect(notice?.installPython).toBe(true)
    expect(notice?.body).toContain('需 Python 运行')
    expect(notice?.body).toContain('仍可直接添加')
  })

  it('gives the command instead of a button where the application does not install Python', () => {
    const notice = mcpRuntimeNotice('python3', { python: false, uv: false }, external)
    expect(notice?.installPython).toBe(false)
    expect(notice?.body).toContain('brew install python')
  })

  // 装 Python 装不出 uv，所以缺 uv 时那颗按钮只在同时缺 Python 才有意义。
  it('does not pretend the Python installer fixes a missing uv', () => {
    const missingBoth = mcpRuntimeNotice('uvx', { python: false, uv: false }, managed)
    expect(missingBoth?.body).toContain('未找到 uv')
    expect(missingBoth?.body).toContain('也未找到 Python')
    expect(missingBoth?.installPython).toBe(true)
    const pythonOnly = mcpRuntimeNotice('uvx', { python: true, uv: false }, managed)
    expect(pythonOnly?.installPython).toBe(false)
    // Python 已经在了，就不该再说「Python 装好之后」。
    expect(pythonOnly?.body).not.toContain('Python 装好之后')
  })

  // D20：客户不会开命令行敲 pip，缺 uv 时交给客服教，不管 Python 在不在都是同一句，并给「联系客服」。
  it('sends a missing uv to customer support instead of a pip command', () => {
    const sentence = '该工具还需安装 uv 组件，请点击「联系客服」获取安装指导。'
    for (const python of [true, false]) {
      for (const management of [managed, external]) {
        const notice = mcpRuntimeNotice('uvx', { python, uv: false }, management)
        expect(notice?.body).toContain(sentence)
        expect(notice?.body).not.toContain('pip')
        expect(notice?.body).not.toContain('命令行')
        expect(notice?.support).toBe(true)
      }
    }
    expect(mcpRuntimeNotice('python3', { python: false, uv: false }, managed)?.support).toBe(false)
  })

  it('checks a curated entry by its own launch command', () => {
    expect(curatedRuntimeCommand(item('files'))).toBe('npx')
    expect(curatedRuntimeCommand(item('github'))).toBe('')
  })
})

type ListItem = Parameters<typeof extensionRowState>[0]
type NativeSkillEntry = NonNullable<Parameters<typeof extensionRowState>[1]>

function listItem(overrides: Partial<ListItem>): ListItem {
  return {
    provider: 'claude',
    kind: 'plugin',
    id: 'demo@market',
    name: 'demo',
    description: '',
    installed: true,
    enabled: true,
    scope: 'user',
    currentVersion: null,
    latestVersion: null,
    source: { kind: 'native', locator: null, reference: null },
    update: { state: 'unsupported', reason: '', checkedAt: null },
    operations: { install: true, uninstall: true, enable: true, disable: true, update: true },
    ...overrides,
  }
}

function nativeSkill(overrides: Partial<NativeSkillEntry>): NativeSkillEntry {
  return {
    id: '/home/me/.agents/skills/quiet/skill.md',
    name: 'Quiet',
    description: '',
    path: '/home/me/.agents/skills/quiet/SKILL.md',
    scope: 'user',
    source: 'agents',
    enabled: false,
    managed: true,
    ...overrides,
  }
}

function extensionApi() {
  return {
    mutateProviderExtension: vi.fn().mockResolvedValue({}),
    toggleSkill: vi.fn().mockResolvedValue({ skills: [] }),
    uninstallSkill: vi.fn().mockResolvedValue({ skills: [], trashPath: '' }),
    togglePlugin: vi.fn().mockResolvedValue({ plugins: [], marketplaces: [] }),
    removeMcpServer: vi.fn().mockResolvedValue([]),
  }
}

describe('extension failure wording', () => {
  it('treats every extension change as a config write except installing Python', () => {
    // 已知29：MCP、技能、插件改的都是工具自己的配置；「安装 Python」装的是运行环境。
    for (const failed of ['enable', 'uninstall', 'curated', 'add', 'marketplace-ensure', 'market-update', 'market-delete', 'delete', 'auth'])
      expect([failed, extensionFailureTarget(failed)]).toEqual([failed, 'config'])
    expect(extensionFailureTarget('python')).toBeUndefined()
    expect(extensionFailureTarget('')).toBeUndefined()
  })
})

describe('Grok plugin trust prompt', () => {
  it('asks before installing a Grok plugin and never for any other tool or kind', () => {
    // Grok refuses a plugin install without --trust, and the flag lets the plugin's commands run on every start.
    expect(extensionInstallNeedsTrust('grok', 'plugin')).toBe(true)
    for (const provider of ['claude', 'codex'] as const)
      expect([provider, extensionInstallNeedsTrust(provider, 'plugin')]).toEqual([provider, false])
    for (const kind of ['mcp', 'skill'] as const)
      expect([kind, extensionInstallNeedsTrust('grok', kind)]).toEqual([kind, false])
  })
})

// #1092：用户层和项目层可以各有一条同名的连接，撞名只看要装进去的那一层。
describe('the name clash check for a custom connection', () => {
  it('only counts connections in the layer being added to', () => {
    const items = [
      listItem({ provider: 'grok', kind: 'mcp', id: 'db', scope: 'user' }),
      listItem({ provider: 'grok', kind: 'mcp', id: 'repo-db', scope: 'project' }),
      listItem({ provider: 'grok', kind: 'mcp', id: 'bare', scope: null }),
      listItem({ provider: 'grok', kind: 'plugin', id: 'plugin-db', scope: 'user' }),
    ]
    expect(mcpNamesInScope(items, 'user')).toEqual(['db', 'bare'])
    expect(mcpNamesInScope(items, 'project')).toEqual(['repo-db'])
  })
})

// #1092：Grok 的插件命令没有范围参数，选「当前项目」也装进全局，所以表单不给这一项。
describe('the 当前项目 choice in the add form', () => {
  it('is offered only where the CLI can install into the project', () => {
    expect(extensionFormOffersProject('claude', 'plugin')).toBe(true)
    for (const provider of ['codex', 'grok'] as const)
      expect([provider, extensionFormOffersProject(provider, 'plugin')]).toEqual([provider, false])
    for (const provider of ['claude', 'codex', 'grok'] as const)
      expect([provider, extensionFormOffersProject(provider, 'skill')]).toEqual([provider, true])
  })
})

describe('extension row actions', () => {
  it('sends the scope a project copy was listed under, so the user copy is left alone', async () => {
    const api = extensionApi()
    await runExtensionAction(api, listItem({ scope: 'project' }), 'uninstall')
    await runExtensionAction(api, listItem({ kind: 'mcp', id: 'shared', scope: 'local' }), 'uninstall')
    await runExtensionAction(api, listItem({ scope: 'user', enabled: false }), 'enable')

    expect(api.mutateProviderExtension.mock.calls.map(([input]) => input)).toEqual([
      { provider: 'claude', kind: 'plugin', action: 'uninstall', id: 'demo@market', scope: 'project' },
      { provider: 'claude', kind: 'mcp', action: 'uninstall', id: 'shared', scope: 'local' },
      { provider: 'claude', kind: 'plugin', action: 'enable', id: 'demo@market', scope: 'user' },
    ])
  })

  it('leaves the scope out for built-in or unknown layers and lets the main process pick', async () => {
    const api = extensionApi()
    await runExtensionAction(
      api,
      listItem({ provider: 'grok', kind: 'skill', id: '/cli/builtin/x/SKILL.md', scope: 'builtin' }),
      'disable',
    )
    await runExtensionAction(api, listItem({ provider: 'codex', kind: 'mcp', id: 'docs', scope: 'project' }), 'uninstall')

    expect(api.mutateProviderExtension.mock.calls.map(([input]) => input)).toEqual([
      { provider: 'grok', kind: 'skill', action: 'disable', id: '/cli/builtin/x/SKILL.md' },
      { provider: 'codex', kind: 'mcp', action: 'uninstall', id: 'docs', scope: 'project' },
    ])
  })

  // 只装了 Codex 桌面端时，删和加一样走 Codex 自己那一边，那边没有 CLI 就直接改 config.toml。
  it('removes a Codex connection the same way it was added', async () => {
    const api = extensionApi()
    await runExtensionAction(api, listItem({ provider: 'codex', kind: 'mcp', id: 'docs', scope: 'user' }), 'uninstall')
    await runExtensionAction(api, listItem({ provider: 'codex', kind: 'mcp', id: 'shared', scope: null }), 'uninstall')

    expect(api.removeMcpServer.mock.calls).toEqual([['docs'], ['shared']])
    expect(api.mutateProviderExtension).not.toHaveBeenCalled()
  })

  // 外接工具的开关跟着主进程给的 operations 走：Grok 有命令，Codex 由主进程改 config.toml，Claude Code 不给。
  it('switches a connection where the main process offers it and draws no switch where it does not', async () => {
    const api = extensionApi()
    const operations = { install: true, uninstall: true, enable: true, disable: true, update: false }
    const codex = listItem({ provider: 'codex', kind: 'mcp', id: 'docs', scope: 'user', operations })
    const grok = listItem({ provider: 'grok', kind: 'mcp', id: 'repo-db', scope: 'project', enabled: false, operations })
    const claude = listItem({ provider: 'claude', kind: 'mcp', id: 'files', operations: { ...operations, enable: false, disable: false } })

    expect(extensionRowState(codex)).toMatchObject({ enabled: true, canToggle: true })
    expect(extensionRowState(grok)).toMatchObject({ enabled: false, canToggle: true })
    expect(extensionRowState(claude)).toMatchObject({ enabled: true, canToggle: false })
    await runExtensionAction(api, codex, 'disable')
    await runExtensionAction(api, grok, 'enable')

    expect(api.mutateProviderExtension.mock.calls.map(([input]) => input)).toEqual([
      { provider: 'codex', kind: 'mcp', action: 'disable', id: 'docs', scope: 'user' },
      { provider: 'grok', kind: 'mcp', action: 'enable', id: 'repo-db', scope: 'project' },
    ])
    expect(api.removeMcpServer).not.toHaveBeenCalled()
  })

  it('manages a user Codex skill through the native interface and shows it disabled', async () => {
    const api = extensionApi()
    const skill = nativeSkill({})
    const row = listItem({
      provider: 'codex',
      kind: 'skill',
      id: skill.path,
      name: 'Quiet',
      enabled: true,
      operations: { install: false, uninstall: false, enable: false, disable: false, update: false },
    })

    expect(extensionRowState(row, skill)).toEqual({
      readonly: false,
      enabled: false,
      canToggle: true,
      canUninstall: true,
      canUpdate: false,
    })
    await runExtensionAction(api, row, 'enable', skill)
    await runExtensionAction(api, row, 'uninstall', skill)
    expect(api.toggleSkill).toHaveBeenCalledWith(skill.path, true)
    expect(api.uninstallSkill).toHaveBeenCalledWith(skill.path)
    expect(api.mutateProviderExtension).not.toHaveBeenCalled()
  })

  it('switches an installed Codex plugin through its own interface, since the Codex CLI has no command for it', async () => {
    const api = extensionApi()
    const row = listItem({
      provider: 'codex',
      id: 'sample@openai-api-curated',
      name: 'sample',
      scope: null,
      // 主进程给 Codex 插件的启停照旧是 false：旧界面靠它不画开关。
      operations: { install: true, uninstall: true, enable: false, disable: false, update: false },
    })

    expect(extensionRowState(row)).toEqual({
      readonly: false,
      enabled: true,
      canToggle: true,
      canUninstall: true,
      canUpdate: false,
    })
    expect(extensionRowState({ ...row, enabled: false })).toMatchObject({ enabled: false, canToggle: true })
    await runExtensionAction(api, row, 'disable')
    await runExtensionAction(api, { ...row, enabled: false }, 'enable')
    await runExtensionAction(api, row, 'uninstall')
    await runExtensionAction(api, listItem({ provider: 'grok', id: 'demo', enabled: false }), 'enable')

    expect(api.togglePlugin.mock.calls).toEqual([
      ['sample@openai-api-curated', false],
      ['sample@openai-api-curated', true],
    ])
    expect(api.mutateProviderExtension.mock.calls.map(([input]) => input)).toEqual([
      { provider: 'codex', kind: 'plugin', action: 'uninstall', id: 'sample@openai-api-curated' },
      { provider: 'grok', kind: 'plugin', action: 'enable', id: 'demo', scope: 'user' },
    ])
  })

  it('offers no switch for a Codex plugin that is only in the catalog', () => {
    const row = listItem({
      provider: 'codex',
      id: 'game-studio@openai-api-curated',
      installed: false,
      enabled: false,
      scope: null,
      operations: { install: true, uninstall: true, enable: false, disable: false, update: false },
    })
    expect(extensionRowState(row).canToggle).toBe(false)
  })

  it('keeps only the Codex system skills read-only', () => {
    const row = listItem({ provider: 'codex', kind: 'skill', id: '/codex/skills/.system/x/SKILL.md' })
    expect(extensionRowState(row, nativeSkill({ path: row.id, scope: 'system', managed: false, enabled: true }))).toMatchObject({
      readonly: true,
      canToggle: false,
      canUninstall: false,
    })
  })

  it('matches a Codex skill by its path when two installed skills share a name', () => {
    const user = nativeSkill({ path: '/home/me/.agents/skills/dup/SKILL.md', name: 'Dup', scope: 'user' })
    const repo = nativeSkill({ path: '/work/.agents/skills/dup/SKILL.md', name: 'Dup', scope: 'repo' })
    const row = listItem({ provider: 'codex', kind: 'skill', id: repo.path, name: 'Dup' })

    expect(findNativeSkill([user, repo], row)).toBe(repo)
  })

  it.each(['enable', 'disable', 'uninstall'] as const)('refuses to %s a missing path instead of changing the same-named skill', async (action) => {
    const api = extensionApi()
    const other = nativeSkill({ path: '/home/me/.agents/skills/b/SKILL.md', name: 'Dup' })
    const row = listItem({ provider: 'codex', kind: 'skill', id: '/work/.agents/skills/a/SKILL.md', name: 'Dup' })
    const matched = findNativeSkill([other], row)

    expect(matched).toBeUndefined()
    expect(extensionRowState(row, matched)).toMatchObject({ canToggle: false, canUninstall: false })
    await expect(runExtensionAction(api, row, action, matched)).rejects.toThrow('刷新')
    expect(api.toggleSkill).not.toHaveBeenCalled()
    expect(api.uninstallSkill).not.toHaveBeenCalled()
    expect(api.mutateProviderExtension).not.toHaveBeenCalled()
    expect(other.enabled).toBe(false)
  })

  it('rejects a mismatched native path even if a stale caller supplies it directly', async () => {
    const api = extensionApi()
    const other = nativeSkill({ path: '/home/me/.agents/skills/b/SKILL.md', name: 'Dup' })
    const row = listItem({ provider: 'codex', kind: 'skill', id: '/work/.agents/skills/a/SKILL.md', name: 'Dup' })

    expect(extensionRowState(row, other)).toMatchObject({ canToggle: false, canUninstall: false })
    await expect(runExtensionAction(api, row, 'uninstall', other)).rejects.toThrow('刷新')
    expect(api.uninstallSkill).not.toHaveBeenCalled()
  })

  it('uses name compatibility only for a pathless legacy id with one candidate', async () => {
    const api = extensionApi()
    const user = nativeSkill({ path: '/home/me/.agents/skills/dup/SKILL.md', name: 'Dup' })
    const repo = nativeSkill({ path: '/work/.agents/skills/dup/SKILL.md', name: 'Dup', scope: 'repo' })
    const row = listItem({ provider: 'codex', kind: 'skill', id: 'legacy-id', name: 'Dup' })

    expect(findNativeSkill([user], row)).toBe(user)
    expect(findNativeSkill([user, repo], row)).toBeUndefined()
    await runExtensionAction(api, row, 'enable', findNativeSkill([user], row))
    expect(api.toggleSkill).toHaveBeenCalledWith(user.path, true)
  })

  it.each([
    ['C:/Users/Me/.agents/skills/demo/SKILL.md', 'c:\\users\\me\\.agents\\skills\\demo\\skill.md'],
    ['\\\\server\\share\\skills\\demo\\SKILL.md', '//SERVER/share/skills/demo/skill.md'],
    ['\\\\?\\C:\\Users\\Me\\skills\\demo\\SKILL.md', 'C:/Users/Me/skills/demo/SKILL.md'],
  ])('preserves Windows path identity across supported spelling differences: %s', (id, nativePath) => {
    const skill = nativeSkill({ path: nativePath })
    const row = listItem({ provider: 'codex', kind: 'skill', id, name: skill.name })

    expect(findNativeSkill([skill], row)).toBe(skill)
  })

  it('does not case-fold POSIX paths into a different same-named skill', () => {
    const skill = nativeSkill({ path: '/work/alpha/SKILL.md', name: 'Dup' })
    const row = listItem({ provider: 'codex', kind: 'skill', id: '/work/Alpha/SKILL.md', name: 'Dup' })

    expect(findNativeSkill([skill], row)).toBeUndefined()
  })

  it('still treats a built-in row as read-only for the other tools', () => {
    expect(extensionRowState(listItem({ provider: 'grok', kind: 'skill', scope: 'builtin' }))).toMatchObject({
      readonly: true,
      canToggle: false,
      canUninstall: false,
      canUpdate: false,
    })
  })
})

describe('extension page default tool', () => {
  it('opens on the first installed command-line tool in navigation order', () => {
    expect(preferredExtensionProvider(['grok', 'codex'])).toBe('codex')
    expect(preferredExtensionProvider(['gemini', 'grok'])).toBe('grok')
  })
  // Gemini CLI 已下线（yoyo 2026-10-14）：只装着它也不算，扩展页不会停在一个不再显示的工具上。
  it('never opens on the retired Gemini CLI', () => {
    expect(preferredExtensionProvider(['gemini'])).toBe('claude')
  })
  it('falls back to Claude when nothing is installed or detection has not finished', () => {
    expect(preferredExtensionProvider([])).toBe('claude')
    expect(preferredExtensionProvider(undefined)).toBe('claude')
    expect(preferredExtensionProvider(['codexDesktop'])).toBe('claude')
  })
})

describe('the 给这些工具用 picker', () => {
  it('lists every tool and says why the ones it cannot pick are grey', () => {
    expect(extensionToolChoices(['claude'], ['claude', 'codex'], [])).toEqual([
      { id: 'claude', name: 'Claude Code', note: null },
      { id: 'codex', name: 'Codex CLI', note: '不支持' },
      { id: 'grok', name: 'Grok CLI', note: '不支持' },
    ])
    expect(extensionToolChoices(['claude', 'codex', 'grok'], ['claude', 'codex'], ['codex']).map((choice) => choice.note)).toEqual([
      null,
      '已添加',
      '未安装',
    ])
  })

  it('treats every tool as installed while detection has not finished', () => {
    expect(extensionToolChoices(['claude', 'codex', 'grok'], undefined).every((choice) => choice.note === null)).toBe(true)
  })

  it('names the tools in navigation order whatever order they were picked in', () => {
    expect(extensionToolNames(['grok', 'claude'])).toBe('Claude Code、Grok CLI')
  })
})

// 「扩展改」第 1 条（10-24）：外接工具没有「更新」按钮，详情里说清楚怎么换新版本。
describe('the update state of a connection', () => {
  const update = { state: 'update-available' as const, reason: '检测到更高的远端版本', checkedAt: '2026-10-24T00:00:00Z' }

  it('tells how a newer connection version is taken instead of offering an update', () => {
    const npm = listItem({
      kind: 'mcp',
      latestVersion: '1.2.0',
      source: { kind: 'npm', locator: '@acme/mcp', reference: '1.1.0' },
      update,
    })
    expect(extensionUpdateStatus(npm)).toBe(
      '有新版本 1.2.0。此项不在此处更新：推荐项使用经星芒核验的版本，无需处理；自行添加的如需更新，请先移除，再按新版本号重新添加。',
    )
    // Git 来源的「版本」是一串提交号，不往句子里放。
    const git = listItem({
      kind: 'mcp',
      latestVersion: 'f'.repeat(40),
      source: { kind: 'git', locator: 'https://github.com/acme/mcp.git', reference: 'a'.repeat(40) },
      update,
    })
    expect(extensionUpdateStatus(git)).toMatch(/^有新版本。此项不在此处更新/)
  })

  it('keeps the main process wording everywhere else', () => {
    expect(extensionUpdateStatus(listItem({ kind: 'plugin', update }))).toBe('检测到更高的远端版本')
    expect(extensionUpdateStatus(listItem({ kind: 'mcp', update: { state: 'up-to-date', reason: '已是最新', checkedAt: null } }))).toBe('已是最新')
    expect(extensionUpdateStatus(listItem({ kind: 'mcp' }))).toBe('尚未检查')
  })
})

// 只装了 Codex 桌面端：外接工具和技能照样在 Codex 那一格管，名字写「Codex 桌面端」；插件要 CLI，不算。
describe('Codex desktop without the Codex CLI', () => {
  it('counts Codex as usable through the desktop app for connections and skills, not for plugins', () => {
    expect(extensionUsableTools(['claude'], true)).toEqual({ usable: ['claude', 'codex'], codexViaDesktop: true })
    expect(extensionUsableTools(['claude'], true, 'plugin')).toEqual({ usable: ['claude'], codexViaDesktop: true })
    expect(extensionUsableTools(['claude', 'codex'], true)).toEqual({ usable: ['claude', 'codex'], codexViaDesktop: false })
    expect(extensionUsableTools(['claude'], false)).toEqual({ usable: ['claude'], codexViaDesktop: false })
    expect(extensionUsableTools(undefined, true)).toEqual({ usable: undefined, codexViaDesktop: false })
    expect(preferredExtensionProvider(extensionUsableTools([], true).usable)).toBe('codex')
  })

  it('calls the Codex slot by the desktop app in names and the tool picker', () => {
    expect(extensionToolName('codex', true)).toBe('Codex 桌面端')
    expect(extensionToolName('codex')).toBe('Codex CLI')
    expect(extensionToolName('grok', true)).toBe('Grok CLI')
    expect(extensionToolNames(['codex', 'claude'], true)).toBe('Claude Code、Codex 桌面端')
    expect(extensionToolChoices(['claude', 'codex', 'grok'], ['codex'], [], true)).toEqual([
      { id: 'claude', name: 'Claude Code', note: '未安装' },
      { id: 'codex', name: 'Codex 桌面端', note: null },
      { id: 'grok', name: 'Grok CLI', note: '未安装' },
    ])
  })
})

// Codex 0.163.0 `mcp list --json` 报的五个词：只有 not_logged_in 要他去登录，只有 o_auth 能退出授权。
describe('Codex MCP sign-in states', () => {
  it('asks for a sign-in only when Codex says nobody signed in', () => {
    expect(['unknown', 'unsupported', 'not_logged_in', 'bearer_token', 'o_auth'].map((status) => [status, mcpNeedsLogin(status), mcpAuthorized(status)]))
      .toEqual([
        ['unknown', false, false],
        ['unsupported', false, false],
        ['not_logged_in', true, false],
        ['bearer_token', false, false],
        ['o_auth', false, true],
      ])
  })
})

describe('custom connection checks', () => {
  const valid = { name: 'my-database', transport: 'stdio', source: 'npx -y pkg' }
  it('passes a well-formed connection', () => {
    expect(customMcpProblem(valid)).toBeNull()
    expect(customMcpProblem({ ...valid, transport: 'http', source: 'https://example.com/mcp' })).toBeNull()
  })
  it('reports the first problem from the top of the form', () => {
    expect(customMcpProblem({ ...valid, name: '  ' })).toBe('请为此连接命名')
    expect(customMcpProblem({ ...valid, name: '我的数据库' })).toBe('名称只能用字母、数字和 - _，最多 40 位')
    expect(customMcpProblem({ ...valid, name: 'a'.repeat(41) })).toBe('名称只能用字母、数字和 - _，最多 40 位')
    expect(customMcpProblem({ ...valid, existing: ['my-database'] })).toBe('已存在名为「my-database」的连接，请更换名称')
    expect(customMcpProblem({ ...valid, source: ' ' })).toBe('请填写启动命令')
    expect(customMcpProblem({ ...valid, transport: 'http', source: 'example.com/mcp' })).toBe('服务地址需以 http:// 或 https:// 开头')
  })
})

describe('curated folder placeholders', () => {
  it('fills the chosen folder into parsed arguments and environment without JSON escaping', () => {
    const folder = 'C:\\Users\\张三\\项目'
    expect(fillCuratedPlaceholders(['-y', 'pkg', '{{directory}}'], { MEMORY_FILE_PATH: '{{directory}}/ai-memory.jsonl' }, { directory: folder })).toEqual({
      args: ['-y', 'pkg', folder],
      env: { MEMORY_FILE_PATH: `${folder}/ai-memory.jsonl` },
    })
  })
  it('leaves a placeholder in place until a folder is chosen', () => {
    expect(fillCuratedPlaceholders(['{{directory}}'], {}, { directory: '  ' }).args).toEqual(['{{directory}}'])
  })
  it('explains a pasted Windows path in Chinese instead of surfacing the JSON parser error', () => {
    expect(() => parseCommandArguments('["C:\\Users"]')).toThrow('选择文件夹')
    expect(() => parseEnvironmentVariables('{"A": "C:\\x"}')).toThrow('附加设置格式不正确')
  })
})

// Gemini CLI 下线（yoyo 2026-10-14）：会话、「插件」页、备份几处的工具选单都不再有它。
describe('management pages without the retired Gemini CLI', () => {
  const api = {} as V2Bridge
  it('offers no Gemini CLI on the plugins page or in its 装到哪里 choices', () => {
    const page = renderToStaticMarkup(<PluginsHub api={api} installedProviders={['gemini', 'grok']} />)
    expect(page).toContain('data-testid="page-extensions"')
    expect(page).not.toContain('Gemini')
    const picker = renderToStaticMarkup(
      <HubToolPicker
        entry={{ key: 'mcp:browser', kind: 'mcp', name: '浏览器', summary: '', group: 'common', supported: ['claude', 'codex', 'grok'], installs: [], available: {} }}
        context={{ tools: ['gemini', 'grok'] }}
        selected={[]}
        onToggle={() => {}}
        testId="picker"
      />,
    )
    expect(picker).toContain('Grok CLI')
    expect(picker).not.toContain('Gemini')
  })

  it('offers no Gemini CLI on the sessions page or the backup card', () => {
    for (const markup of [renderToStaticMarkup(<SessionsPage api={api} />), renderToStaticMarkup(<BackupCard api={api} />)]) {
      expect(markup).toContain('Claude Code')
      expect(markup).not.toContain('Gemini')
    }
  })
})

describe('sessions table', () => {
  it('counts sessions per tool chip and sums them for the all chip', () => {
    expect(sessionToolCounts({ claude: 3, codex: 1, gemini: 5 })).toMatchObject({ all: 4, claude: 3, codex: 1, grok: 0 })
    // 没读到统计就不显示数字，不能显示成一排 0。
    expect(sessionToolCounts(undefined)).toBeNull()
  })

  it('shows model and message count under the title and leaves the time to its own column', () => {
    expect(sessionRowMeta({ model: 'gpt-5', messageCount: 12, archived: false })).toBe('gpt-5 · 12 条消息')
    expect(sessionRowMeta({ model: '', messageCount: null, archived: true })).toBe('未记录模型 · 已归档')
  })

  it('renders the records page as a table with tool chips and no drawer', () => {
    const markup = renderToStaticMarkup(<SessionsPage api={{} as V2Bridge} />)
    expect(markup).toContain('aria-label="按工具筛选"')
    expect(markup).toContain('data-testid="sessions-tool-all"')
    expect(markup).toContain('placeholder="搜索标题、文件夹或模型"')
    expect(markup).toContain('aria-label="重新加载"')
    expect(markup).not.toContain('本软件已把保留期放长到一年')
    expect(markup).not.toContain('xm-drawer')
  })
})

// #1070 第 11 步把记录页搬出去以后 pages-management 只做转出：转出的就是页面文件里那一份；搬出去的文件也不反过来
// 从它那里 import，免得几个文件绕着圈 import，谁先求值谁拿到一半。
describe('pages-management as a re-export of the split pages', () => {
  it('re-exports the very functions the page files define', () => {
    expect(SessionsPage).toBe(sessionsPage.SessionsPage)
    expect(sessionToolCounts).toBe(sessionsPage.sessionToolCounts)
  })

  it('keeps the moved files from importing back out of it', () => {
    for (const file of ['features/sessions/SessionsPage.tsx', 'features/extensions/PluginsHub.tsx', 'features/extensions/extensions-common.tsx', 'features/tools/provider-options.ts']) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toMatch(/from '[./]*pages-management'/)
    }
  })
})

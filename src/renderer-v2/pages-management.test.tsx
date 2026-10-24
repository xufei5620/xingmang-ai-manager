import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { V2Bridge } from './types'
import { BackupCard } from './features/settings/BackupCard'
import {
  CuratedDetails,
  CuratedShelf,
  ExtensionsPage,
  SessionsPage,
  curatedRuntimeCommand,
  curatedVersionText,
  customMcpProblem,
  extensionNoToolInstalled,
  extensionShowsUpdatePill,
  extensionToolChoices,
  extensionToolName,
  extensionToolNames,
  extensionUpdateStatus,
  extensionUsableTools,
  groupExtensionItems,
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
  sessionRowMeta,
  sessionToolCounts,
  submitMcpInstall,
  unresolvedInstallPlaceholders,
} from './pages-management'
import {
  curatedDisclaimer,
  curatedExtensions,
  curatedItemsFor,
} from './registry/curated-extensions'
import { extensionScopeGroups } from './registry/extensions'
import * as sessionsPage from './features/sessions/SessionsPage'
import * as extensionsPage from './features/extensions/ExtensionsPage'
import * as extensionsCommon from './features/extensions/extensions-common'

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

describe('curated extension shelf', () => {
  // 联网说明以前在每一行右边各写一遍，把说明挤成两行；点「添加」后的确认框里本来就有。
  it('lists one card per curated entry with its risk badges and leaves the network need to the confirm dialog', () => {
    const markup = renderToStaticMarkup(
      <CuratedShelf items={curatedItemsFor('mcp', 'claude')} toolName="Claude Code" onPick={() => {}} />,
    )
    expect(markup).toContain('星芒精选')
    expect(markup).toContain('我们挑过的，装之前会先给你看它要什么权限')
    expect(markup).toContain('data-testid="curated-row-files"')
    expect(markup).toContain('data-testid="curated-install-browser"')
    expect(markup).toContain('会修改本地文件')
    expect(markup).toContain('需要先登录')
    // 外接工具的卡上是「添加」，插件的才是「安装」。
    expect(markup).toMatch(/data-testid="curated-install-browser"[^>]*>(?:(?!<\/button>).)*<span>添加<\/span><\/button>/)
    expect(markup).not.toContain('第一次使用时需要联网下载')
    expect(markup).not.toContain('点「安装」会先让你确认一次')
    expect(renderToStaticMarkup(<CuratedDetails item={item('files')} />)).toContain('第一次使用时需要联网下载')
  })

  it('renders nothing on the pages that have no curated entries yet', () => {
    expect(renderToStaticMarkup(<CuratedShelf items={[]} toolName="Claude Code" onPick={() => {}} />)).toBe('')
  })

  // 用户点「安装」之后看到的就是这一段，所以「将要执行的确切命令」必须原样出现在里面，
  // 免责说明也不能因为条目不同而漏掉。
  it('states the exact command, the risk and the disclaimer before anything is installed', () => {
    const markup = renderToStaticMarkup(<CuratedDetails item={item('files')} />)
    expect(markup).toContain('npx -y @modelcontextprotocol/server-filesystem@2026.8.31 {{directory}}')
    expect(markup).toContain('<dt>提供方</dt><dd>Model Context Protocol 官方</dd>')
    expect(markup).toContain('会修改本地文件')
    expect(markup).toContain('改动不进回收站')
    expect(markup).toContain('装到哪里')
    expect(markup).toContain('用的是本应用装好的运行环境')
    expect(markup).not.toContain('Node.js')
    expect(markup).toContain(curatedDisclaimer)
  })

  // 精选页的确认框下面另有「给这些工具用」，不再写「当前这个工具」装在哪一层。
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
    expect(markup).toContain('没有特别的风险')
    expect(markup).toContain('用掉的额度比平时多')
  })

  // 插件精选与 MCP 精选是同一张卡：形态一致，只是图标、命令与版本那一行不同。
  it('lists the curated plugins with what each one costs the user', () => {
    const markup = renderToStaticMarkup(
      <CuratedShelf items={curatedItemsFor('plugin', 'claude')} toolName="Claude Code" onPick={() => {}} />,
    )
    expect(markup).toContain('data-testid="curated-row-code-review"')
    expect(markup).toContain('data-testid="curated-install-commit-commands"')
    expect(markup).toMatch(/data-testid="curated-install-commit-commands"[^>]*>(?:(?!<\/button>).)*<span>安装<\/span><\/button>/)
    expect(markup).toContain('会多消耗额度')
    expect(markup).toContain('会提交到 Git')
    expect(markup).not.toContain('安装时需要联网下载一次')
    expect(renderToStaticMarkup(<CuratedDetails item={item('code-review')} />)).toContain('安装时需要联网下载一次')
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
    expect(curatedVersionText(item('github'))).toBe('由对方在线提供，没有本地版本')
  })

  // 已经装上的还给一个「安装」按钮，点下去只会换来一句 CLI 的英文报错。
  it('marks an entry that is already installed instead of offering it again', () => {
    const markup = renderToStaticMarkup(
      <CuratedShelf
        items={curatedItemsFor('plugin', 'claude')}
        toolName="Claude Code"
        installedIds={['code-review@claude-plugins-official']}
        onPick={() => {}}
      />,
    )
    expect(markup).toContain('已装到 Claude Code')
    expect(markup).not.toContain('data-testid="curated-install-code-review"')
    expect(markup).toContain('data-testid="curated-install-feature-dev"')
  })

  // 工具还没装时精选照样摆出来看，只是不给按钮：装好工具再来添加。
  it('shows the entries without any button while the tool is not installed', () => {
    const markup = renderToStaticMarkup(
      <CuratedShelf items={curatedItemsFor('mcp', 'grok')} toolName="Grok CLI" toolMissing onPick={() => {}} />,
    )
    expect(markup).toContain('data-testid="curated-row-files"')
    expect(markup).not.toContain('data-testid="curated-install-')
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
    expect(mcpHealthView(report, 'files')).toEqual({ tone: 'ok', label: '能连上', detail: null })
    expect(mcpHealthView(report, 'browser')).toEqual({ tone: 'warn', label: '连不上', detail: '启动失败' })
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
    expect(notice?.body).toContain('要靠 Python 运行')
    expect(notice?.body).toContain('仍然可以直接添加')
  })

  it('gives the command instead of a button where the application does not install Python', () => {
    const notice = mcpRuntimeNotice('python3', { python: false, uv: false }, external)
    expect(notice?.installPython).toBe(false)
    expect(notice?.body).toContain('brew install python')
  })

  // 装 Python 装不出 uv，所以缺 uv 时那颗按钮只在同时缺 Python 才有意义。
  it('does not pretend the Python installer fixes a missing uv', () => {
    const missingBoth = mcpRuntimeNotice('uvx', { python: false, uv: false }, managed)
    expect(missingBoth?.body).toContain('没有找到 uv')
    expect(missingBoth?.body).toContain('也没有找到 Python')
    expect(missingBoth?.installPython).toBe(true)
    const pythonOnly = mcpRuntimeNotice('uvx', { python: true, uv: false }, managed)
    expect(pythonOnly?.installPython).toBe(false)
    expect(pythonOnly?.body).toContain('pip install uv')
    // Python 已经在了，就不该再说「Python 装好之后」。
    expect(pythonOnly?.body).not.toContain('Python 装好之后')
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

// v4 批12：「范围」筛选换成按范围分组，分组标题和说明在 registry/extensions.ts。
describe('installed extension groups', () => {
  it('files each item under the layer it was installed in, in the order of the table', () => {
    const groups = groupExtensionItems(
      [
        listItem({ id: 'local-one', scope: 'local' }),
        listItem({ id: 'user-one', scope: 'user' }),
        listItem({ id: 'user-two', scope: 'user' }),
      ],
      extensionScopeGroups.mcp.claude,
    )
    expect(groups.map((group) => [group.title, group.description, group.items.map((item) => item.id)])).toEqual([
      ['用户', '你的所有项目都能用', ['user-one', 'user-two']],
      ['本地', '只在当前项目、只给你自己', ['local-one']],
    ])
  })

  it('puts everything in the one group of a tool that has a single layer', () => {
    const groups = groupExtensionItems(
      [listItem({ provider: 'codex', id: 'a', scope: null }), listItem({ provider: 'codex', id: 'b', scope: 'user' })],
      extensionScopeGroups.plugin.codex,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ title: '已安装', description: '所有项目都能用' })
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'b'])
  })

  // #1092：Codex 只往全局加连接，但受信任项目里写的它也列出来，主进程对照配置文件标成 project。
  it('files Codex connections from a trusted project under 项目', () => {
    const groups = groupExtensionItems(
      [listItem({ provider: 'codex', kind: 'mcp', id: 'repo-db', scope: 'project' }), listItem({ provider: 'codex', kind: 'mcp', id: 'mine', scope: 'user' })],
      extensionScopeGroups.mcp.codex,
    )
    expect(groups.map((group) => [group.title, group.description, group.items.map((entry) => entry.id)])).toEqual([
      ['全局', '所有项目共用', ['mine']],
      ['项目', '只在这个项目里用', ['repo-db']],
    ])
  })

  it('puts the read-only Codex skills under 系统内置 whatever scope the list gave them', () => {
    const groups = groupExtensionItems(
      [listItem({ provider: 'codex', kind: 'skill', id: 'mine', scope: 'user' }), listItem({ provider: 'codex', kind: 'skill', id: 'system', scope: 'user' })],
      extensionScopeGroups.skill.codex,
      (item) => item.id === 'system',
    )
    expect(groups.map((group) => [group.title, group.items.map((item) => item.id)])).toEqual([
      ['用户', ['mine']],
      ['系统内置', ['system']],
    ])
  })

  // #1092：Grok 的连接列表带回 user / project 两层，插件只有用户一层、列表不带 scope。
  it('splits Grok connections by the layer the CLI reports and keeps Grok plugins in one group', () => {
    const connections = groupExtensionItems(
      [
        listItem({ provider: 'grok', kind: 'mcp', id: 'repo-db', scope: 'project' }),
        listItem({ provider: 'grok', kind: 'mcp', id: 'mine', scope: 'user' }),
      ],
      extensionScopeGroups.mcp.grok,
    )
    expect(connections.map((group) => [group.title, group.description, group.items.map((entry) => entry.id)])).toEqual([
      ['用户', '所有项目都能用', ['mine']],
      ['项目', '只在这个项目里用', ['repo-db']],
    ])
    const plugins = groupExtensionItems(
      [listItem({ provider: 'grok', kind: 'plugin', id: 'demo', scope: 'user' }), listItem({ provider: 'grok', kind: 'plugin', id: 'bare', scope: null })],
      extensionScopeGroups.plugin.grok,
    )
    expect(plugins.map((group) => [group.title, group.items.map((entry) => entry.id)])).toEqual([['用户', ['demo', 'bare']]])
  })

  // 表里没有的层不能被分组弄丢：另起一组，标题用详情里那套范围叫法。
  it('keeps an item whose layer the table does not list in a group of its own', () => {
    const groups = groupExtensionItems(
      [listItem({ provider: 'grok', kind: 'skill', id: 'repo', scope: 'project' }), listItem({ provider: 'grok', kind: 'skill', id: 'bare', scope: null })],
      extensionScopeGroups.skill.grok,
    )
    expect(groups.map((group) => [group.title, group.description, group.items.map((item) => item.id)])).toEqual([
      ['当前项目', '', ['repo']],
      ['未提供', '', ['bare']],
    ])
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

// 「扩展改」第 3 条（10-24）：勾选框全是「未安装」时，添加框里那条「还没装能用它的工具」。
describe('the 还没装能用它的工具 notice', () => {
  it('names the supported tools when none of them is installed', () => {
    expect(extensionNoToolInstalled(extensionToolChoices(['claude', 'codex', 'grok'], [], []))).toBe('Claude Code、Codex CLI、Grok CLI')
    expect(extensionNoToolInstalled(extensionToolChoices(['claude'], [], []))).toBe('Claude Code')
    expect(extensionNoToolInstalled(extensionToolChoices(['claude', 'codex', 'grok'], [], [], true))).toBe('Claude Code、Codex 桌面端、Grok CLI')
  })

  it('stays quiet once one of them can be picked or already has it', () => {
    expect(extensionNoToolInstalled(extensionToolChoices(['claude', 'codex', 'grok'], ['grok'], []))).toBeNull()
    expect(extensionNoToolInstalled(extensionToolChoices(['claude'], ['claude'], ['claude']))).toBeNull()
    // 还没检测完：都当装了，不出这一条。
    expect(extensionNoToolInstalled(extensionToolChoices(['claude', 'codex'], undefined))).toBeNull()
    expect(extensionNoToolInstalled([])).toBeNull()
  })
})

// 「扩展改」第 1 条（10-24）：外接工具没有「更新」按钮，行上不挂「可更新」，详情里说清楚。
describe('the update state of a connection', () => {
  const update = { state: 'update-available' as const, reason: '检测到更高的远端版本', checkedAt: '2026-10-24T00:00:00Z' }

  it('keeps the 可更新 pill for skills and plugins only', () => {
    expect(extensionShowsUpdatePill(listItem({ kind: 'plugin', update }))).toBe(true)
    expect(extensionShowsUpdatePill(listItem({ kind: 'skill', update }))).toBe(true)
    expect(extensionShowsUpdatePill(listItem({ kind: 'mcp', update }))).toBe(false)
    expect(extensionShowsUpdatePill(listItem({ kind: 'plugin' }))).toBe(false)
  })

  it('tells how a newer connection version is taken instead of offering an update', () => {
    const npm = listItem({
      kind: 'mcp',
      latestVersion: '1.2.0',
      source: { kind: 'npm', locator: '@acme/mcp', reference: '1.1.0' },
      update,
    })
    expect(extensionUpdateStatus(npm)).toBe(
      '有新版本 1.2.0。外接工具不在这里更新：精选里加的用的是星芒核过的版本，不用管它；自己加的想换新版本，先移除，再按新版本号加一次。',
    )
    // Git 来源的「版本」是一串提交号，不往句子里放。
    const git = listItem({
      kind: 'mcp',
      latestVersion: 'f'.repeat(40),
      source: { kind: 'git', locator: 'https://github.com/acme/mcp.git', reference: 'a'.repeat(40) },
      update,
    })
    expect(extensionUpdateStatus(git)).toMatch(/^有新版本。外接工具不在这里更新/)
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
    expect(customMcpProblem({ ...valid, name: '  ' })).toBe('请给这个连接起个名字')
    expect(customMcpProblem({ ...valid, name: '我的数据库' })).toBe('名称只能用字母、数字和 - _，最多 40 位')
    expect(customMcpProblem({ ...valid, name: 'a'.repeat(41) })).toBe('名称只能用字母、数字和 - _，最多 40 位')
    expect(customMcpProblem({ ...valid, existing: ['my-database'] })).toBe('已经有叫「my-database」的连接了，换个名字')
    expect(customMcpProblem({ ...valid, source: ' ' })).toBe('请填写启动命令')
    expect(customMcpProblem({ ...valid, transport: 'http', source: 'example.com/mcp' })).toBe('服务地址要以 http:// 或 https:// 开头')
  })
})

describe('extension page layout', () => {
  const api = {} as V2Bridge
  it('switches tools with tabs and names what the tool itself calls this kind', () => {
    const markup = renderToStaticMarkup(<ExtensionsPage api={api} kind="mcp" installedProviders={['claude', 'codex']} />)
    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('Claude Code 官方叫「MCP 服务器」')
    // 没装的工具在页签上直说，不去读它的列表。
    expect(markup).toMatch(/Grok CLI<span class="v2-ext-tab-note">未安装<\/span>/)
    expect(markup).toContain('自定义连接')
    expect(markup).not.toContain('添加连接')
  })

  it('offers to install the tool in place of the list when it is not installed', () => {
    const markup = renderToStaticMarkup(
      <ExtensionsPage api={api} kind="plugin" installedProviders={['codex']} installTool={async () => 'installed'} />,
    )
    // 一进来按导航次序选第一个装好的：Codex CLI；Claude Code 没装，选它时才出安装那一条。
    expect(markup).toContain('Codex CLI 官方叫「插件（Plugins）」')
    const missing = renderToStaticMarkup(<ExtensionsPage api={api} kind="skill" installedProviders={[]} installTool={async () => 'installed'} />)
    expect(missing).toContain('还没有安装 Claude Code')
    expect(missing).toContain('装好后就能添加下面的技能。')
    expect(missing).toContain('data-testid="skills-install-tool"')
    expect(missing).not.toContain('data-testid="skills-list"')
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
    expect(() => parseEnvironmentVariables('{"A": "C:\\x"}')).toThrow('附加设置的格式不对')
  })
})

// Gemini CLI 下线（yoyo 2026-10-14）：会话、外接工具、技能、插件、备份几页的工具选单都不再有它。
describe('management pages without the retired Gemini CLI', () => {
  const api = {} as V2Bridge
  it.each(['mcp', 'skill', 'plugin'] as const)('offers no Gemini CLI on the %s page', (kind) => {
    const markup = renderToStaticMarkup(<ExtensionsPage api={api} kind={kind} installedProviders={['gemini', 'grok']} />)
    expect(markup).toContain('Grok CLI')
    expect(markup).not.toContain('Gemini')
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

// #1070 第 11 步把两页搬出去以后 pages-management 只做转出：转出的就是页面文件里那一份；搬出去的文件也不反过来
// 从它那里 import，免得几个文件绕着圈 import，谁先求值谁拿到一半。
describe('pages-management as a re-export of the split pages', () => {
  it('re-exports the very functions the page files define', () => {
    expect(SessionsPage).toBe(sessionsPage.SessionsPage)
    expect(sessionToolCounts).toBe(sessionsPage.sessionToolCounts)
    expect(ExtensionsPage).toBe(extensionsPage.ExtensionsPage)
    expect(CuratedShelf).toBe(extensionsCommon.CuratedShelf)
    expect(submitMcpInstall).toBe(extensionsCommon.submitMcpInstall)
  })

  it('keeps the moved files from importing back out of it', () => {
    for (const file of ['features/sessions/SessionsPage.tsx', 'features/extensions/ExtensionsPage.tsx', 'features/extensions/extensions-common.tsx', 'features/tools/provider-options.ts']) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toMatch(/from '[./]*pages-management'/)
    }
  })

  it('keeps the business stylesheet in the order it had before the split', () => {
    // 业务页那份样式表里，教程页那几份排在 extensions.css 前面，跟拆之前一样；先后由 import 的先后定（#1335 第 6 条）。
    // ExtensionsPage 先从 pages-maintenance 拿装工具那两句（顺带带进教程页的样式），再 import extensions-common 和
    // extensions.css；pages-management 头一个转出的又是 ExtensionsPage。改成直接从 features/tools/install-result 拿，
    // 构建出来这两段样式就对调了：眼下没有同级选择器冲突，界面看不出来，所以只能在这里钉住。
    function specifiers(file: string) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      return [...source.matchAll(/(?:\bfrom\s+|^import\s+)'([^']+)'/gm)].map((match) => match[1])
    }
    const page = specifiers('features/extensions/ExtensionsPage.tsx')
    expect(page.indexOf('../../pages-maintenance')).toBeGreaterThan(-1)
    expect(page.indexOf('../../pages-maintenance')).toBeLessThan(page.indexOf('./extensions-common'))
    expect(page.indexOf('../../pages-maintenance')).toBeLessThan(page.indexOf('../../extensions.css'))
    expect(readFileSync(new URL('./features/extensions/ExtensionsPage.tsx', import.meta.url), 'utf8'))
      .toMatch(/import \{[^}]*\binstallJobRunning\b[^}]*\binstallResultMessage\b[^}]*\} from '\.\.\/\.\.\/pages-maintenance'/)
    expect(specifiers('pages-management.tsx')[0]).toBe('./features/extensions/ExtensionsPage')
  })
})

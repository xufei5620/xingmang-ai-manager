import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CuratedDetails,
  CuratedShelf,
  curatedPlaceholderField,
  curatedRuntimeCommand,
  curatedVersionText,
  mcpCommandRuntime,
  mcpHealthView,
  mcpRuntimeNotice,
  officialMarketplaceNotice,
  submitMcpInstall,
  unresolvedInstallPlaceholders,
} from './pages-management'
import {
  curatedDisclaimer,
  curatedExtensions,
  curatedItemsFor,
} from './registry/curated-extensions'

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
  it('lists one row per curated entry with its risk badges and network need', () => {
    const markup = renderToStaticMarkup(
      <CuratedShelf items={curatedItemsFor('mcp', 'claude')} onPick={() => {}} />,
    )
    expect(markup).toContain('星芒精选')
    expect(markup).toContain('data-testid="curated-row-files"')
    expect(markup).toContain('data-testid="curated-install-browser"')
    expect(markup).toContain('会改你的文件')
    expect(markup).toContain('需要先登录')
    expect(markup).toContain('第一次使用时需要联网下载')
  })

  it('renders nothing on the pages that have no curated entries yet', () => {
    expect(renderToStaticMarkup(<CuratedShelf items={[]} onPick={() => {}} />)).toBe('')
  })

  // 用户点「安装」之后看到的就是这一段，所以「将要执行的确切命令」必须原样出现在里面，
  // 免责说明也不能因为条目不同而漏掉。
  it('states the exact command, the risk and the disclaimer before anything is installed', () => {
    const markup = renderToStaticMarkup(<CuratedDetails item={item('files')} />)
    expect(markup).toContain('npx -y @modelcontextprotocol/server-filesystem@2026.8.31 {{directory}}')
    expect(markup).toContain('Model Context Protocol 官方')
    expect(markup).toContain('会改你的文件')
    expect(markup).toContain('改动不进回收站')
    expect(markup).toContain('装到哪里')
    expect(markup).toContain(curatedDisclaimer)
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
      <CuratedShelf items={curatedItemsFor('plugin', 'claude')} onPick={() => {}} />,
    )
    expect(markup).toContain('data-testid="curated-row-code-review"')
    expect(markup).toContain('data-testid="curated-install-commit-commands"')
    expect(markup).toContain('会多用额度')
    expect(markup).toContain('会动 Git 仓库')
    expect(markup).toContain('安装时需要联网下载一次')
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
        installedIds={['code-review@claude-plugins-official']}
        onPick={() => {}}
      />,
    )
    expect(markup).toContain('已安装')
    expect(markup).not.toContain('data-testid="curated-install-code-review"')
    expect(markup).toContain('data-testid="curated-install-feature-dev"')
  })

  it('points the form at the field that actually holds the placeholder', () => {
    expect(curatedPlaceholderField(item('files'), 'directory')).toBe('参数')
    expect(curatedPlaceholderField(item('memory'), 'directory')).toBe('环境变量')
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

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CuratedDetails,
  CuratedShelf,
  curatedPlaceholderField,
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
    const install = item('files').install
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
    await submitMcpInstall(api, 'codex', 'github', item('github').install, 'user', {
      bearerTokenEnvVar: 'TOKEN',
    })
    expect(addMcpServer).toHaveBeenCalledWith({
      name: 'github',
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      bearerTokenEnvVar: 'TOKEN',
    })
    await submitMcpInstall(api, 'codex', 'files', item('files').install, 'user', {
      bearerTokenEnvVar: 'TOKEN',
    })
    expect(addMcpServer).toHaveBeenLastCalledWith({ name: 'files', ...item('files').install })
  })
})

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { V2Bridge } from './types'
import { FeaturedPage, featuredAddedFrom, featuredAddedTools, featuredFullyAdded } from './pages-featured'
import { curatedExtensions } from './registry/curated-extensions'

type Snapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>

function item(id: string) {
  const found = curatedExtensions.find((entry) => entry.id === id)
  if (!found) throw new Error(`精选清单里没有 ${id}`)
  return found
}

function snapshot(provider: Snapshot['provider'], items: Array<{ kind: 'mcp' | 'plugin'; id: string; installed?: boolean }>): Snapshot {
  return {
    provider,
    checkedAt: '2026-10-15T00:00:00.000Z',
    capabilities: {
      mcp: { list: true, reason: null },
      skill: { list: true, reason: null },
      plugin: { list: true, reason: null },
    },
    warnings: [],
    items: items.map((entry) => ({
      provider,
      kind: entry.kind,
      id: entry.id,
      name: entry.id,
      description: '',
      installed: entry.installed ?? true,
      enabled: true,
      scope: 'user',
      currentVersion: null,
      latestVersion: null,
      source: { kind: 'native', locator: null, reference: null },
      update: { state: 'unsupported', reason: '', checkedAt: null },
      operations: { install: true, uninstall: true, enable: true, disable: true, update: false },
    })),
  }
}

describe('featured entries already added', () => {
  const added = featuredAddedFrom([
    snapshot('claude', [{ kind: 'mcp', id: 'browser' }, { kind: 'plugin', id: 'code-review@claude-plugins-official' }]),
    snapshot('codex', [{ kind: 'mcp', id: 'browser' }, { kind: 'mcp', id: 'files', installed: false }]),
  ])

  it('records what each tool has installed, keyed by kind so a plugin never stands in for a connection', () => {
    expect(featuredAddedTools(item('browser'), added)).toEqual(['claude', 'codex'])
    expect(featuredAddedTools(item('code-review'), added)).toEqual(['claude'])
    // 列表里有、但没装上的不算。
    expect(featuredAddedTools(item('files'), added)).toEqual([])
  })

  it('says 已添加 only when every installed tool that supports it has it', () => {
    expect(featuredFullyAdded(item('browser'), ['claude', 'codex'], added)).toBe(true)
    // Grok CLI 装了但没读到 / 没装上：照旧给按钮。
    expect(featuredFullyAdded(item('browser'), ['claude', 'codex', 'grok'], added)).toBe(false)
    expect(featuredFullyAdded(item('code-review'), ['claude', 'codex'], added)).toBe(true)
  })

  it('keeps offering the button when none of the tools it supports is installed', () => {
    expect(featuredFullyAdded(item('code-review'), ['codex'], added)).toBe(false)
  })
})

describe('featured page', () => {
  const api = {} as V2Bridge
  it('shows every curated entry with its kind, the tools it works with and one button', () => {
    const markup = renderToStaticMarkup(<FeaturedPage api={api} installedProviders={['claude']} onRecommend={() => {}} />)
    expect(markup).toContain('data-testid="page-featured"')
    expect(markup).toContain('推荐一个')
    expect(markup).not.toContain('上传作品')
    for (const entry of curatedExtensions) expect(markup).toContain(`data-testid="featured-card-${entry.id}"`)
    expect(markup).toContain('全部类型')
    expect(markup).toContain('>外接工具<')
    expect(markup).toContain('>插件<')
    // 清单里没有技能，就不放一个点进去永远是空的「技能」。
    expect(markup).not.toContain('>技能<')
    expect(markup).toContain('aria-label="能用的工具：Claude Code、Codex CLI、Grok CLI"')
    expect(markup).toContain('aria-label="能用的工具：Claude Code"')
    expect(markup).toMatch(/data-testid="featured-install-browser"[^>]*>(?:(?!<\/button>).)*<span>添加<\/span><\/button>/)
    expect(markup).toMatch(/data-testid="featured-install-code-review"[^>]*>(?:(?!<\/button>).)*<span>安装<\/span><\/button>/)
  })

  it('leaves out 推荐一个 when there is nowhere to send it', () => {
    expect(renderToStaticMarkup(<FeaturedPage api={api} />)).not.toContain('推荐一个')
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { V2Bridge } from '../../types'
import { hubRowLabel } from './PluginsHub'
import { familyNames, hubChoiceNote, hubInstallLabel, HubToolPicker } from './PluginsHubDialogs'
import type { HubEntry } from './plugins-hub-model'

type Item = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>['items'][number]

function installed(provider: 'claude' | 'codex' | 'grok'): { provider: 'claude' | 'codex' | 'grok'; item: Item } {
  return {
    provider,
    item: {
      provider, kind: 'mcp', id: 'browser', name: 'browser', description: '', installed: true, enabled: true, scope: 'user',
      currentVersion: null, latestVersion: null, source: { kind: 'native', locator: null, reference: null },
      update: { state: 'unsupported', reason: '', checkedAt: null },
      operations: { install: true, uninstall: true, enable: true, disable: true, update: false },
    },
  }
}

const browser: HubEntry = {
  key: 'mcp:browser', kind: 'mcp', name: '浏览器', summary: '让 AI 自己打开网页', group: 'common',
  supported: ['claude', 'codex', 'grok'], installs: [installed('claude'), installed('codex')], available: {},
}

describe('plugins hub', () => {
  it('reads each row as its name, where it can go and where it already is', () => {
    expect(hubRowLabel(browser)).toBe('浏览器，能装到：Claude、GPT、Grok；已装到：Claude、GPT')
    expect(hubRowLabel({ ...browser, installs: [] })).toBe('浏览器，能装到：Claude、GPT、Grok')
  })

  it('names the families in sidebar order and counts the targets on the install button', () => {
    expect(familyNames(['grok', 'claude', 'codex'])).toBe('Claude、GPT、Grok')
    expect(hubInstallLabel(1)).toBe('安装')
    expect(hubInstallLabel(2)).toBe('装到 2 个')
  })

  it('says why a family cannot be ticked in the approved words', () => {
    expect(hubChoiceNote({ state: 'installed', installs: [] }, 'claude')).toBe('已安装')
    expect(hubChoiceNote({ state: 'tool-missing' }, 'grok')).toBe('本机尚未安装 Grok CLI')
    expect(hubChoiceNote({ state: 'vendor-only', vendor: 'claude' }, 'codex')).toBe('插件各家格式不通用，这一条只有 Claude 版')
    expect(hubChoiceNote({ state: 'addable' }, 'codex')).toBeNull()
  })

  it('ticks installed families greyed, offers the home page for a missing tool and leaves the rest to pick', () => {
    const html = renderToStaticMarkup(createElement(HubToolPicker, {
      entry: { ...browser, installs: [installed('claude')], curated: undefined },
      context: { tools: ['claude', 'codex'] },
      selected: ['codex'],
      onToggle: () => undefined,
      onOpenHome: () => undefined,
      testId: 'picker',
    }))
    expect(html).toContain('aria-label="装到哪里"')
    expect(html).toMatch(/aria-pressed="true" disabled="" data-testid="picker-claude"/)
    expect(html).toMatch(/aria-pressed="true" data-testid="picker-codex"/)
    expect(html).toMatch(/aria-pressed="false" disabled="" data-testid="picker-grok"/)
    expect(html).toContain('Claude Code，以及 Claude 桌面端里的 Claude Code')
    expect(html).toContain('Codex CLI 和 Codex 桌面端，两边都能用')
    expect(html).toContain('已安装')
    expect(html).toContain('本机尚未安装 Grok CLI')
    expect(html).toContain('data-testid="picker-grok-home"')
  })
})

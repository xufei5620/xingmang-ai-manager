import { describe, expect, it } from 'vitest'
import { curatedExtensions } from '../../registry/curated-extensions'
import type { V2Bridge } from '../../types'
import {
  buildPluginEntries,
  buildSkillEntries,
  entryAddableTargets,
  entryMatches,
  entryTargetState,
  entryVisible,
  installScopeSentence,
  installedProviders,
  officialPluginVendor,
  pluginMarket,
  pluginShortName,
  skillSourceDirectory,
  type HubEntry,
  type HubSnapshots,
} from './plugins-hub-model'

type Snapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>
type Item = Snapshot['items'][number]
type Provider = 'claude' | 'codex' | 'grok'

function item(provider: Provider, kind: Item['kind'], id: string, overrides: Partial<Item> = {}): Item {
  return {
    provider,
    kind,
    id,
    name: id,
    description: '',
    installed: true,
    enabled: true,
    scope: 'user',
    currentVersion: '1.0.0',
    latestVersion: '1.0.0',
    source: { kind: 'native', locator: null, reference: null },
    update: { state: 'unsupported', reason: '', checkedAt: null },
    operations: { install: true, uninstall: true, enable: true, disable: true, update: false },
    ...overrides,
  }
}

function snapshot(provider: Provider, items: Item[]): Snapshot {
  return {
    provider,
    checkedAt: '2026-11-20T00:00:00Z',
    items,
    warnings: [],
    capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
  }
}

function find(entries: HubEntry[], key: string): HubEntry {
  const entry = entries.find((candidate) => candidate.key === key)
  if (!entry) throw new Error(`missing ${key}`)
  return entry
}

const everything = { tools: ['claude', 'codex', 'grok'], pluginTools: ['claude', 'codex', 'grok'] }

describe('plugins hub model', () => {
  it('reads the market of a plugin id and tells the two official markets apart', () => {
    expect(pluginMarket('supabase@claude-plugins-official')).toBe('claude-plugins-official')
    expect(pluginMarket('local-plugin')).toBeNull()
    expect(pluginShortName('sentry@openai-api-curated')).toBe('sentry')
    expect(officialPluginVendor('claude', 'supabase@claude-plugins-official')).toBe('claude')
    expect(officialPluginVendor('codex', 'sentry@openai-api-curated')).toBe('codex')
    // 同一个市场名挂在别家下面不算那家官方的。
    expect(officialPluginVendor('codex', 'supabase@claude-plugins-official')).toBeNull()
    expect(officialPluginVendor('codex', 'tool@my-market')).toBeNull()
  })

  it('puts the curated entries first, in catalog order, grouped as common and coding', () => {
    const entries = buildPluginEntries({}, curatedExtensions)
    const curated = curatedExtensions.filter((entry) => entry.kind !== 'skill')
    expect(entries.map((entry) => entry.curated?.id)).toEqual(curated.map((entry) => entry.id))
    expect(find(entries, 'mcp:browser').group).toBe('common')
    // 逐步思考是写代码时用的，挪到「写代码」（registry/extensions.ts 的 curatedHubGroups）。
    expect(find(entries, 'mcp:sequential-thinking').group).toBe('coding')
    expect(find(entries, 'plugin:code-review@claude-plugins-official').group).toBe('coding')
    expect(find(entries, 'mcp:browser').supported).toEqual(['claude', 'codex', 'grok'])
    expect(find(entries, 'plugin:code-review@claude-plugins-official').supported).toEqual(['claude'])
  })

  it('merges the same connection or plugin from every tool into one entry and records where it is installed', () => {
    const snapshots: HubSnapshots = {
      claude: snapshot('claude', [item('claude', 'mcp', 'browser'), item('claude', 'plugin', 'code-review@claude-plugins-official')]),
      codex: snapshot('codex', [item('codex', 'mcp', 'browser', { scope: 'user' })]),
    }
    const entries = buildPluginEntries(snapshots, curatedExtensions)
    expect(entries.filter((entry) => entry.key === 'mcp:browser')).toHaveLength(1)
    expect(installedProviders(find(entries, 'mcp:browser'))).toEqual(['claude', 'codex'])
    expect(installedProviders(find(entries, 'plugin:code-review@claude-plugins-official'))).toEqual(['claude'])
  })

  it('files official market plugins under their vendor, keeps uninstalled ones as available, and skips tools without a CLI', () => {
    const snapshots: HubSnapshots = {
      claude: snapshot('claude', [item('claude', 'plugin', 'supabase@claude-plugins-official', { installed: false, name: 'Supabase', description: 'Database' })]),
      codex: snapshot('codex', [
        item('codex', 'plugin', 'sentry@openai-api-curated'),
        item('codex', 'plugin', 'linear@openai-api-curated', { installed: false }),
        item('codex', 'plugin', 'tool@my-market', { installed: false }),
      ]),
    }
    const entries = buildPluginEntries(snapshots, [])
    expect(find(entries, 'plugin:supabase@claude-plugins-official')).toMatchObject({ group: 'claude', name: 'Supabase', summary: 'Database', installs: [] })
    expect(find(entries, 'plugin:supabase@claude-plugins-official').available.claude?.id).toBe('supabase@claude-plugins-official')
    expect(find(entries, 'plugin:sentry@openai-api-curated').group).toBe('codex')
    expect(find(entries, 'plugin:tool@my-market').group).toBe('custom')
    // 只装了 Codex 桌面端：Codex 的插件不收，免得给一个装不上的「+」。
    const desktopOnly = buildPluginEntries(snapshots, [], ['claude'])
    expect(desktopOnly.some((entry) => entry.key.endsWith('@openai-api-curated'))).toBe(false)
    expect(desktopOnly.some((entry) => entry.key === 'plugin:supabase@claude-plugins-official')).toBe(true)
  })

  it('lets a connection the customer added in Claude Code or Codex be copied to every tool, but not one only Grok has', () => {
    const custom = buildPluginEntries({ claude: snapshot('claude', [item('claude', 'mcp', 'docs')]) }, [])
    expect(find(custom, 'mcp:docs')).toMatchObject({ group: 'custom', supported: ['claude', 'codex', 'grok'] })
    expect(entryAddableTargets(find(custom, 'mcp:docs'), everything)).toEqual(['codex', 'grok'])
    const grokOnly = buildPluginEntries({ grok: snapshot('grok', [item('grok', 'mcp', 'docs')]) }, [])
    expect(find(grokOnly, 'mcp:docs').supported).toEqual(['grok'])
    expect(entryAddableTargets(find(grokOnly, 'mcp:docs'), everything)).toEqual([])
    // 项目里那份不复制（同外接工具页的「也装到别的工具」）。
    const project = buildPluginEntries({ claude: snapshot('claude', [item('claude', 'mcp', 'docs', { scope: 'project' })]) }, [])
    expect(entryAddableTargets(find(project, 'mcp:docs'), everything)).toEqual([])
  })

  it('says for each tool whether an entry is installed, addable, missing the tool, or only made for another vendor', () => {
    const snapshots: HubSnapshots = {
      claude: snapshot('claude', [item('claude', 'mcp', 'browser')]),
      codex: snapshot('codex', [item('codex', 'plugin', 'linear@openai-api-curated', { installed: false })]),
    }
    const entries = buildPluginEntries(snapshots, curatedExtensions)
    const browser = find(entries, 'mcp:browser')
    const context = { tools: ['claude', 'codex'], pluginTools: ['claude', 'codex'] }
    expect(entryTargetState(browser, 'claude', context).state).toBe('installed')
    expect(entryTargetState(browser, 'codex', context).state).toBe('addable')
    expect(entryTargetState(browser, 'grok', context).state).toBe('tool-missing')
    expect(entryAddableTargets(browser, context)).toEqual(['codex'])
    const linear = find(entries, 'plugin:linear@openai-api-curated')
    expect(entryTargetState(linear, 'codex', context).state).toBe('addable')
    expect(entryTargetState(linear, 'claude', context)).toEqual({ state: 'vendor-only', vendor: 'codex' })
    const review = find(entries, 'plugin:code-review@claude-plugins-official')
    expect(entryTargetState(review, 'codex', context)).toEqual({ state: 'vendor-only', vendor: 'claude' })
    // 还没检测完（缺省）时当作都装了。
    expect(entryAddableTargets(browser, {})).toEqual(['codex', 'grok'])
  })

  it('merges skills by name, keeps Codex built-ins apart and only offers to copy a skill whose folder is known', () => {
    const snapshots: HubSnapshots = {
      claude: snapshot('claude', [item('claude', 'skill', 'pdf', { name: 'pdf', source: { kind: 'local', locator: 'C:/skills/pdf', reference: null } })]),
      codex: snapshot('codex', [
        item('codex', 'skill', 'C:/Users/me/.codex/skills/pdf/SKILL.md', { name: 'pdf' }),
        item('codex', 'skill', 'C:/codex/system/imagegen/SKILL.md', { name: 'imagegen', scope: 'builtin' }),
        item('codex', 'skill', 'C:/Users/me/.codex/skills/old/SKILL.md', { name: 'old', installed: false }),
      ]),
      grok: snapshot('grok', [item('grok', 'skill', 'notes', { name: 'notes', source: { kind: 'git', locator: 'https://example.test/notes.git', reference: null } })]),
    }
    const entries = buildSkillEntries(snapshots)
    expect(entries.map((entry) => entry.key)).toEqual(['builtin:imagegen', 'skill:notes', 'skill:pdf'])
    expect(installedProviders(find(entries, 'skill:pdf'))).toEqual(['claude', 'codex'])
    expect(find(entries, 'builtin:imagegen')).toMatchObject({ group: 'builtin', supported: ['codex'] })
    expect(entryAddableTargets(find(entries, 'skill:pdf'), everything)).toEqual(['grok'])
    expect(entryAddableTargets(find(entries, 'skill:pdf'), { ...everything, skillImport: { grok: false } })).toEqual([])
    expect(entryAddableTargets(find(entries, 'builtin:imagegen'), everything)).toEqual([])
    // Git 来的说不准文件夹在哪，不给「+」。
    expect(entryAddableTargets(find(entries, 'skill:notes'), everything)).toEqual([])
  })

  it('finds the folder of a skill only where it is certain', () => {
    expect(skillSourceDirectory(item('codex', 'skill', 'C:\\Users\\me\\.codex\\skills\\pdf\\SKILL.md'))).toBe('C:\\Users\\me\\.codex\\skills\\pdf')
    expect(skillSourceDirectory(item('claude', 'skill', 'pdf', { source: { kind: 'local', locator: '/Users/me/skills/pdf', reference: null } }))).toBe('/Users/me/skills/pdf')
    expect(skillSourceDirectory(item('claude', 'skill', 'pdf'))).toBeNull()
    expect(skillSourceDirectory(item('claude', 'mcp', 'pdf', { source: { kind: 'local', locator: '/x', reference: null } }))).toBeNull()
  })

  it('filters by the picked tool and searches names, summaries and the kind words customers use', () => {
    const entries = buildPluginEntries({ claude: snapshot('claude', [item('claude', 'mcp', 'docs', { name: '公司知识库', description: '查内部文档' })]) }, curatedExtensions)
    const review = find(entries, 'plugin:code-review@claude-plugins-official')
    expect(entryVisible(review, 'all')).toBe(true)
    expect(entryVisible(review, 'claude')).toBe(true)
    expect(entryVisible(review, 'codex')).toBe(false)
    const docs = find(entries, 'mcp:docs')
    for (const word of ['知识库', '内部', 'docs', 'MCP', '外接工具', '连接']) expect(entryMatches(docs, word), word).toBe(true)
    expect(entryMatches(docs, '插件')).toBe(false)
    expect(entryMatches(review, '插件')).toBe(true)
    expect(entryMatches(review, '   ')).toBe(true)
    expect(entryMatches(docs, '知识库 文档')).toBe(true)
    expect(entryMatches(docs, '知识库 浏览器')).toBe(false)
  })

  it('describes where each copy lives with the sentence the installed list already uses', () => {
    expect(installScopeSentence({ provider: 'codex', item: item('codex', 'mcp', 'docs', { scope: 'user' }) })).toBe('所有项目共用')
    expect(installScopeSentence({ provider: 'codex', item: item('codex', 'plugin', 'sentry@openai-api-curated', { scope: null }) })).toBe('适用于所有项目')
    expect(installScopeSentence({ provider: 'codex', item: item('codex', 'skill', 'x', { scope: null }) }, true)).toBe('Codex 自带，随版本更新')
  })
})

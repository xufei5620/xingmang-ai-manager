// 「插件」页（精选、外接工具、技能、插件合成的那一页，扩展合并方案第二版）的纯逻辑：三家、三类的列表怎么合成一张表，
// 每一条能装进谁、装在了谁那里，「推荐」「自己加的」「已安装」各放哪些。页面只管画和点，判断都在这里，好单测。
import { activeProviderIds, type ActiveProviderId } from '../../../../electron/catalog'
import {
  curatedInstallTarget,
  type CuratedExtension,
} from '../../registry/curated-extensions'
import {
  curatedHubGroups,
  extensionKindLabels,
  extensionScopeGroups,
  officialPluginMarkets,
} from '../../registry/extensions'
import type { V2Bridge } from '../../types'
import { extensionScopeLabel, mcpCopyOffered } from './extensions-common'

type Provider = ActiveProviderId
type ExtensionSnapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>
type ExtensionItem = ExtensionSnapshot['items'][number]

export type HubSnapshots = Partial<Record<Provider, ExtensionSnapshot>>
export type HubView = 'plugins' | 'skills'
/** 「装到」下拉：全部，或只看能装进某一家的。 */
export type HubFilter = 'all' | Provider
/** 一条落在哪一组：常用、写代码、两家官方、自己加的；技能分装在这台电脑上的和 Codex 自带的。 */
export type HubGroup = 'common' | 'coding' | 'claude' | 'codex' | 'custom' | 'skill' | 'builtin'

export interface HubInstall {
  provider: Provider
  item: ExtensionItem
}

export interface HubEntry {
  /** 合并用的键：外接工具按连接名、插件按「插件名@市场名」、技能按名字，三家同键的算一条。 */
  key: string
  kind: ExtensionItem['kind']
  name: string
  summary: string
  publisher?: string
  curated?: CuratedExtension
  group: HubGroup
  /** 能装进哪几家，次序同导航。 */
  supported: Provider[]
  /** 已经装上的那几份；同一家装了两层（用户和项目）就是两份。 */
  installs: HubInstall[]
  /** 市场里列着、还没装的那一份，按家放（官方目录、自己加的市场里的插件）。 */
  available: Partial<Record<Provider, ExtensionItem>>
}

function entryKey(kind: ExtensionItem['kind'], id: string) {
  return `${kind}:${id}`
}

/** 插件 id 是「插件名@市场名」；没有 @ 的（Grok 自己装的）没有市场。 */
export function pluginMarket(id: string): string | null {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(at + 1) : null
}

export function pluginShortName(id: string): string {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(0, at) : id
}

/** 从哪家的官方市场来的插件；别的市场、没有市场的回 null。 */
export function officialPluginVendor(provider: Provider, id: string): Provider | null {
  const market = pluginMarket(id)
  return market && officialPluginMarkets[provider] === market ? provider : null
}

function curatedGroup(item: CuratedExtension): HubGroup {
  return curatedHubGroups[item.id] ?? (item.kind === 'plugin' ? 'coding' : 'common')
}

function ordered(providers: Iterable<Provider>): Provider[] {
  const set = new Set(providers)
  return activeProviderIds.filter((id) => set.has(id))
}

/**
 * 插件页那张表：精选在前（按清单次序），再按读回来的次序放三家列表里的外接工具和插件。三家里同一个连接名、
 * 同一个「插件名@市场名」的合成一条，装上的记进 installs，市场里还没装的记进 available。
 * pluginTools：插件要命令行工具才管得了（只装了 Codex 桌面端时 Codex 不算），不在里面的那家的插件不收，
 * 免得给一个点了也装不上的「+」。
 */
export function buildPluginEntries(
  snapshots: HubSnapshots,
  curated: readonly CuratedExtension[],
  pluginTools?: readonly string[],
): HubEntry[] {
  const entries = new Map<string, HubEntry>()
  for (const item of curated) {
    if (item.kind === 'skill') continue
    const key = entryKey(item.kind, curatedInstallTarget(item))
    entries.set(key, {
      key,
      kind: item.kind,
      name: item.name,
      summary: item.summary,
      publisher: item.publisher,
      curated: item,
      group: curatedGroup(item),
      supported: ordered(item.providers),
      installs: [],
      available: {},
    })
  }
  for (const provider of activeProviderIds) {
    const snapshot = snapshots[provider]
    if (!snapshot) continue
    for (const item of snapshot.items) {
      if (item.kind === 'skill') continue
      if (item.kind === 'plugin' && pluginTools && !pluginTools.includes(provider)) continue
      const key = entryKey(item.kind, item.id)
      const existing = entries.get(key)
      const vendor = item.kind === 'plugin' ? officialPluginVendor(provider, item.id) : null
      const entry: HubEntry = existing ?? {
        key,
        kind: item.kind,
        name: item.name,
        summary: item.description,
        group: vendor === 'claude' || vendor === 'codex' ? vendor : 'custom',
        supported: [provider],
        installs: [],
        available: {},
      }
      if (!existing) entries.set(key, entry)
      else if (!entry.curated && !entry.supported.includes(provider)) entry.supported = ordered([...entry.supported, provider])
      if (item.installed) entry.installs.push({ provider, item })
      else if (item.operations.install) entry.available[provider] = item
      if (!entry.summary && item.description) entry.summary = item.description
    }
  }
  // 自己加的连接能「也装到别的工具」时（Claude Code、Codex 全局那份里自己加的），三家都算能装。
  for (const entry of entries.values()) {
    if (entry.kind === 'mcp' && !entry.curated && entry.installs.some((install) => mcpCopyOffered(install.provider, install.item)))
      entry.supported = [...activeProviderIds]
  }
  return [...entries.values()]
}

/** Codex 技能 id 是 SKILL.md 的路径。 */
function skillManifestPath(id: string) {
  return /[\\/]SKILL\.md$/i.test(id)
}

/**
 * 技能文件夹在哪，「+」靠它把同一个文件夹再导进别的工具。只认两种说得准的：Codex 那边 id 就是 SKILL.md 的路径，
 * 取它所在的文件夹；别家来源是本地文件夹的，来源就是那个文件夹。Git 来的、说不准的回 null，不给「+」。
 */
export function skillSourceDirectory(item: ExtensionItem): string | null {
  if (item.kind !== 'skill') return null
  if (item.provider === 'codex' && skillManifestPath(item.id)) return item.id.replace(/[\\/]SKILL\.md$/i, '')
  if (item.source.kind === 'local' && item.source.locator) return item.source.locator
  return null
}

/**
 * 技能页那张表：三家装的技能按名字合成一条（同名的算一个）。Codex 自带、只读的单放「Codex 自带」。
 * builtin 由页面按原生列表判断（同 extensionRowState 的 readonly），这里只按它分组。
 */
export function buildSkillEntries(
  snapshots: HubSnapshots,
  builtin: (install: HubInstall) => boolean = (install) => install.item.scope === 'builtin',
): HubEntry[] {
  const entries = new Map<string, HubEntry>()
  for (const provider of activeProviderIds) {
    const snapshot = snapshots[provider]
    if (!snapshot) continue
    for (const item of snapshot.items) {
      if (item.kind !== 'skill' || !item.installed) continue
      const install = { provider, item }
      const own = builtin(install)
      const key = `${own ? 'builtin' : 'skill'}:${item.name}`
      const entry: HubEntry = entries.get(key) ?? {
        key,
        kind: 'skill',
        name: item.name,
        summary: item.description,
        group: own ? 'builtin' : 'skill',
        supported: own ? [provider] : [...activeProviderIds],
        installs: [],
        available: {},
      }
      entries.set(key, entry)
      entry.installs.push(install)
      if (!entry.summary && item.description) entry.summary = item.description
    }
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function installedProviders(entry: HubEntry): Provider[] {
  return ordered(entry.installs.map((install) => install.provider))
}

/** 「装到」选了某一家时只放能装进那家的；选全部都放。 */
export function entryVisible(entry: HubEntry, filter: HubFilter): boolean {
  return filter === 'all' || entry.supported.includes(filter)
}

/** 搜索：名字、说明、提供方、连接名；搜「MCP」「外接工具」「插件」按类型筛。 */
export function entryMatches(entry: HubEntry, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const kindWords = entry.kind === 'mcp' ? ['mcp', 'mcp 服务器', '外接工具', '连接'] : entry.kind === 'plugin' ? ['plugin', '插件'] : ['skill', '技能']
  const haystack = [
    entry.name,
    entry.summary,
    entry.publisher ?? '',
    entry.key.slice(entry.key.indexOf(':') + 1),
    extensionKindLabels[entry.kind],
    ...kindWords,
  ].join(' ').toLocaleLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** 每一家对这一条是什么情况：装了、能装、这台电脑没装那个工具、插件只有别家版、说不上来（不给按钮）。 */
export type HubTargetState =
  | { state: 'installed'; installs: HubInstall[] }
  | { state: 'addable' }
  | { state: 'tool-missing' }
  | { state: 'vendor-only'; vendor: Provider }
  | { state: 'unsupported' }

export interface HubTargetContext {
  /** 能管外接工具和技能的工具（只装了 Codex 桌面端时 Codex 也算）；缺省 = 还没检测完，当作都装了。 */
  tools?: readonly string[]
  /** 能管插件的工具（要命令行工具）；缺省同上。 */
  pluginTools?: readonly string[]
  /** 技能能不能从文件夹导进去（Claude Code、Grok CLI 由主进程说；缺省 = 能）。 */
  skillImport?: Partial<Record<Provider, boolean>>
}

function toolReady(entry: HubEntry, provider: Provider, context: HubTargetContext) {
  const tools = entry.kind === 'plugin' ? context.pluginTools : context.tools
  return !tools || tools.includes(provider)
}

/** 这一条能不能装进 provider：精选照清单；市场里的要有那一份；自己加的连接要能复制；技能要有说得准的文件夹。 */
function canAdd(entry: HubEntry, provider: Provider, context: HubTargetContext): boolean {
  if (entry.curated) return entry.curated.providers.includes(provider)
  if (entry.kind === 'plugin') return Boolean(entry.available[provider])
  if (entry.kind === 'mcp') return entry.installs.some((install) => install.provider !== provider && mcpCopyOffered(install.provider, install.item))
  if (entry.group === 'builtin') return false
  if (context.skillImport?.[provider] === false) return false
  return entry.installs.some((install) => skillSourceDirectory(install.item) !== null)
}

export function entryTargetState(entry: HubEntry, provider: Provider, context: HubTargetContext): HubTargetState {
  const installs = entry.installs.filter((install) => install.provider === provider)
  if (installs.length) return { state: 'installed', installs }
  if (entry.kind === 'plugin' && !entry.supported.includes(provider) && entry.supported.length === 1)
    return { state: 'vendor-only', vendor: entry.supported[0] }
  if (!entry.supported.includes(provider)) return { state: 'unsupported' }
  if (!toolReady(entry, provider, context)) return { state: 'tool-missing' }
  return canAdd(entry, provider, context) ? { state: 'addable' } : { state: 'unsupported' }
}

/** 还能装进哪几家（「+」给不给、详情页右上那颗按钮写什么、安装框默认勾哪几个）。 */
export function entryAddableTargets(entry: HubEntry, context: HubTargetContext): Provider[] {
  return activeProviderIds.filter((provider) => entryTargetState(entry, provider, context).state === 'addable')
}

/** 官方目录一组先放几个，点标题展开成全部。 */
export const collapsedOfficialCount = 4

/**
 * 详情页每一份装在哪一层那句：用已装列表分组的那句说明（「你的所有项目都能用」「随项目共享给协作者」……），
 * 这家只有一层的用那一层的说明；表里没有的层用详情里那套范围叫法。
 */
export function installScopeSentence(install: HubInstall, builtin = false): string {
  const groups = extensionScopeGroups[install.item.kind][install.provider]
  if (builtin) return groups.find((group) => group.scope === 'builtin')?.description ?? extensionScopeLabel('builtin')
  const scope = install.item.scope
  const match = groups.find((group) => group.scope === scope) ?? groups.find((group) => group.scope === 'all')
  return match?.description ?? extensionScopeLabel(scope)
}

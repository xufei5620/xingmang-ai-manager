// 扩展三页（外接工具、技能、插件）和「星芒精选」页共用的那一份（#1070 第 11 步，从 pages-management.tsx 原样搬来）：
// 列表按页签和安装位置怎么分、官方市场要不要提醒、Codex 插件目录、每一行能点什么、添加连接时的检查和解析、要 Python
// 或 uv 时那句提示、精选条目的卡片和详情。pages-management.tsx 照旧转出这里原来导出的名字；扩展页还要用的三样
// （RowAction、activeTools、mcpAuthorized）原来不导出，搬过来只加了 export。
import type { ReactNode } from 'react'
import { Check, Globe, Package, Plus, Server } from 'lucide-react'
import { Button, Pill } from '../../ui'
import { scopeOptions } from '../../registry/business'
import {
  curatedCommandLines,
  curatedDisclaimer,
  curatedInstallTarget,
  curatedNetworkLabels,
  curatedRiskLabels,
  curatedRuntimeLabels,
  type CuratedExtension,
} from '../../registry/curated-extensions'
import type { ExtensionScopeGroup } from '../../registry/extensions'
import { tools } from '../../registry/tools'
import { runtimeHomebrewCommand } from '../tools/runtime-install-guide'
import type { OperationTarget } from '../../operation-error'
import type { V2Bridge } from '../../types'
import type { ActiveProviderId } from '../../../../electron/catalog'
import { isProvider, providerOptions } from '../tools/provider-options'
import '../../extensions.css'

// 已下线的 CLI（Gemini，yoyo 2026-10-14）不在这里：管理页不再列它的扩展、会话和备份。
type Provider = ActiveProviderId
type ExtensionSnapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>
type ExtensionItem = ExtensionSnapshot['items'][number]
type ExtensionKind = ExtensionItem['kind']
type ExtensionRuntimes = NonNullable<ExtensionSnapshot['runtimes']>
type McpHealthReport = Awaited<ReturnType<V2Bridge['checkProviderMcpHealth']>>
type RuntimeInstallManagement = Awaited<
  ReturnType<V2Bridge['getPlatformCapabilities']>
>['pythonRuntimeInstall']
type Mutation = Parameters<V2Bridge['mutateProviderExtension']>[0]
type McpConfig = NonNullable<Mutation['mcp']>
type CodexExtensionApi = Pick<
  V2Bridge,
  'listMcpServers' | 'listSkills' | 'listPlugins'
>
type ExtensionMarket = Awaited<
  ReturnType<V2Bridge['listPlugins']>
>['marketplaces'][number]
export type CodexExtensionMetadata = {
  mcp: Awaited<ReturnType<V2Bridge['listMcpServers']>>
  skills: Awaited<ReturnType<V2Bridge['listSkills']>>
  plugins: Awaited<ReturnType<V2Bridge['listPlugins']>>
}
type ExtensionView = 'installed' | 'market'

/**
 * Provider CLIs return installed and available plugins together when queried
 * with `--available`. Keep the installed tab restricted to actual installs.
 */
export function extensionItemsForView(
  items: readonly ExtensionItem[],
  kind: ExtensionKind,
  view: ExtensionView,
): ExtensionItem[] {
  return items.filter(
    (item) =>
      item.kind === kind &&
      (kind !== 'plugin' || view !== 'installed' || item.installed),
  )
}

/** Codex 用 Key（接当前账号）登录时，官方插件目录的市场名。与主进程同名常量一致。 */
const codexOfficialCatalogName = 'openai-api-curated'

/**
 * Claude Code 只在自己首次交互式启动时注册官方市场，而本软件一律非交互调用
 * 它，所以没在终端用过的机器上可装清单永远是空的。界面必须能分辨「这里没有
 * 可装的」和「市场还没加进来」，否则用户看到空列表也无从下手。
 *
 * Codex 同理：它的官方插件目录要在启动时从国外网站同步，国内常常同步不下来，
 * 由本软件替它下载（主进程 codex-plugin-catalog.ts）。
 */
export function officialMarketplaceNotice(
  marketplace: ExtensionSnapshot['marketplace'],
): {
  tone: 'neutral' | 'warn'
  title: string
  body: string
  needsAction: boolean
  actionLabel: string
} | null {
  if (!marketplace) return null
  if (marketplace.name === codexOfficialCatalogName) {
    return marketplace.registered
      ? {
          tone: 'neutral',
          title: '官方插件目录已就绪',
          body: '下面是 Codex 可以安装的插件，安装前确认插件来源。要登录 ChatGPT 账号才能用的插件不在其中。',
          needsAction: false,
          actionLabel: '下载插件目录',
        }
      : {
          tone: 'warn',
          title: '官方插件目录还没下载',
          body:
            marketplace.reason ||
            '下载之后这里才会出现可以安装的插件，网络慢时要等一会儿。',
          needsAction: true,
          actionLabel: '下载插件目录',
        }
  }
  if (marketplace.registered) {
    return {
      tone: 'neutral',
      title: '官方插件市场已添加',
      body: '下面是可以安装的插件，安装前确认插件来源。',
      needsAction: false,
      actionLabel: '添加官方市场',
    }
  }
  return {
    tone: 'warn',
    title: '还没有添加官方插件市场',
    body:
      marketplace.reason ||
      '添加之后这里才会出现可以安装的插件。添加需要这台电脑上装有 Git。',
    needsAction: true,
    actionLabel: '添加官方市场',
  }
}

export function filterExtensionMarkets(
  markets: readonly ExtensionMarket[],
  query: string,
): ExtensionMarket[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...markets]
  return markets.filter((market) =>
    `${market.name} ${market.root}`.toLowerCase().includes(normalized),
  )
}

/**
 * Codex has a richer legacy API for auth badges and marketplace roots. Those
 * details are optional enrichment because the provider snapshot already
 * contains the authoritative extension rows.
 */
export async function readCodexExtensionMetadata(
  api: CodexExtensionApi,
): Promise<CodexExtensionMetadata> {
  const [mcp, skills, plugins] = await Promise.allSettled([
    api.listMcpServers(),
    api.listSkills(),
    api.listPlugins(),
  ])
  return {
    mcp: mcp.status === 'fulfilled' ? mcp.value : [],
    skills: skills.status === 'fulfilled' ? skills.value : [],
    plugins:
      plugins.status === 'fulfilled'
        ? plugins.value
        : { plugins: [], marketplaces: [] },
  }
}
type NativeSkill = CodexExtensionMetadata['skills'][number]
export type RowAction = 'enable' | 'disable' | 'uninstall' | 'update' | 'install'

function nativeSkillPathKey(value: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
  if (!windowsPath) return value
  return value.replaceAll('\\', '/')
    .replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '')
    .toLowerCase()
}

/**
 * 通用列表里的 Codex 技能 ID 是 SKILL.md 的路径；按路径对上原生列表那一条，
 * 对不上就停止，不能把已消失的 A 配成同名的 B（#601）。只有无路径的旧 ID
 * 才兼容名字，并且整份原生列表里必须只有一个候选。
 */
export function findNativeSkill(
  skills: readonly NativeSkill[],
  item: ExtensionItem,
): NativeSkill | undefined {
  if (!item.id.trim()) return undefined
  const hasPath = /[\\/]/.test(item.id) || /^[A-Za-z]:/.test(item.id)
  const candidates = hasPath
    ? skills.filter((entry) => nativeSkillPathKey(entry.path) === nativeSkillPathKey(item.id))
    : skills.filter((entry) => entry.name === item.name)
  return candidates.length === 1 ? candidates[0] : undefined
}

export interface ExtensionRowState {
  /** 系统自带、不许改的那些。 */
  readonly: boolean
  enabled: boolean
  canToggle: boolean
  canUninstall: boolean
  canUpdate: boolean
}

/**
 * Codex 没有插件启停命令：启停由主进程直接改 config.toml 的 `[plugins."名字@市场"] enabled`
 * （plugins:toggle，codex-extensions.ts 的 setPluginEnabled，装着才让改，改完再对一遍）。
 * 通用 mutate 对 Codex 插件只认装和卸，operations 里的启停照旧是 false：旧界面拿它决定画不画开关，
 * 拿到 true 就会把启停交给 mutate。所以这里单独放开，不去动 operations。
 */
function codexPluginToggle(item: ExtensionItem): boolean {
  return item.provider === 'codex' && item.kind === 'plugin'
}

/**
 * Codex 技能不走通用的 mutate：启停写 config.toml、移除挪进回收站，都由原生
 * 接口完成。原生接口里 managed=true 恰恰是「用户自己的、可以管」，只有
 * system 那一层才是内置只读（#490）。
 */
export function extensionRowState(
  item: ExtensionItem,
  nativeSkill?: NativeSkill,
): ExtensionRowState {
  if (item.provider === 'codex' && item.kind === 'skill') {
    const matched = nativeSkill && findNativeSkill([nativeSkill], item)
    // Metadata may have been read after this path disappeared. Leave the old
    // row visible for refresh, but never enable an action on an uncertain target.
    if (!matched) return { readonly: false, enabled: item.enabled, canToggle: false, canUninstall: false, canUpdate: false }
    const readonly = !matched.managed || matched.scope === 'system'
    return {
      readonly,
      enabled: matched.enabled,
      canToggle: !readonly,
      canUninstall: !readonly,
      canUpdate: false,
    }
  }
  const readonly = item.scope === 'builtin'
  return {
    readonly,
    enabled: item.enabled,
    canToggle: !readonly && (
      codexPluginToggle(item) ? item.installed : item.operations[item.enabled ? 'disable' : 'enable']
    ),
    canUninstall: !readonly && item.operations.uninstall,
    canUpdate: !readonly && item.operations.update,
  }
}

/**
 * scope 是 CLI 自己的英文叫法，「范围」筛选和详情按同一套归类：local 是只在这个项目里用的那一份，
 * 归「当前项目」；扩展自带的技能装在用户目录里，哪个文件夹打开都能用，归「我的（全局）」。
 */
function extensionShownScope(scope: ExtensionItem['scope'] | undefined) {
  return scope === 'local' ? 'project' : scope === 'extension' ? 'user' : scope
}

/** 详情里的「范围」，界面上只放中文；没带 scope 的写「未提供」。 */
export function extensionScopeLabel(scope: ExtensionItem['scope'] | undefined): string {
  const shown = extensionShownScope(scope)
  return scopeOptions.find((option) => option.value === shown)?.label ?? '未提供'
}

export interface ExtensionGroup {
  key: string
  title: string
  description: string
  items: ExtensionItem[]
}

/**
 * 已装的按范围分组（registry/extensions.ts 那张表，分组标题替代了以前的「范围」筛选）。表里只有一组 all 的
 * 工具全放进那一组；builtin 判为真的（Codex 自带、只读的技能）进「系统内置」；其余按 scope 对上那一组。
 * 对不上的层（表里没有的、没带 scope 的）不丢，各自另起一组，标题用详情里那套范围叫法、不带说明。空组不画。
 */
export function groupExtensionItems(
  items: readonly ExtensionItem[],
  groups: readonly ExtensionScopeGroup[],
  builtin: (item: ExtensionItem) => boolean = () => false,
): ExtensionGroup[] {
  const single = groups.some((group) => group.scope === 'all')
  const hasBuiltin = groups.some((group) => group.scope === 'builtin')
  const result: ExtensionGroup[] = groups.map((group) => ({
    key: group.scope,
    title: group.title,
    description: group.description,
    items: [],
  }))
  for (const item of items) {
    const key = single ? 'all' : hasBuiltin && builtin(item) ? 'builtin' : item.scope ?? ''
    let group = result.find((candidate) => candidate.key === key)
    if (!group) {
      group = { key, title: extensionScopeLabel(item.scope), description: '', items: [] }
      result.push(group)
    }
    group.items.push(item)
  }
  return result.filter((group) => group.items.length > 0)
}

/** 列表里带回来的 scope 原样交回去；内置、扩展自带或不知道的不带，由主进程按缺省处理。 */
export function extensionMutationScope(
  scope: ExtensionItem['scope'],
): Mutation['scope'] {
  return scope === 'user' ||
    scope === 'project' ||
    scope === 'local' ||
    scope === 'workspace'
    ? scope
    : undefined
}

/**
 * Grok 装插件不带 --trust 一律拒绝（1.0.52、1.0.62 实测，有没有终端都一样）；带上以后插件里的
 * 命令和外接工具每次打开 Grok 都会自己跑。所以先弹框问，用户点了「信任并安装」才带（yoyo 10-17 定）。
 * 别家装插件没有这一问。
 */
export function extensionInstallNeedsTrust(provider: Provider, kind: ExtensionKind): boolean {
  return provider === 'grok' && kind === 'plugin'
}

/**
 * 技能、插件的「添加」表单给不给「当前项目」。Codex 的插件只有全局一层；Grok 的插件命令没有范围参数，
 * 选了项目照样装进 ~/.grok（1.0.52、1.0.62 实测，#1092）。外接工具按勾了哪几个工具另算（mcpGlobalOnly）。
 */
export function extensionFormOffersProject(provider: Provider, kind: ExtensionKind): boolean {
  return kind !== 'plugin' || (provider !== 'codex' && provider !== 'grok')
}

/**
 * 「自定义连接」撞名只看要装进去的那一层：Claude Code、Grok 都允许用户层和项目层各有一条同名的，
 * 在这个项目里项目那条盖过用户那条（#1092）。没带 scope 的按用户层算。
 */
export function mcpNamesInScope(items: readonly ExtensionItem[], scope: 'user' | 'project'): string[] {
  return items
    .filter((item) => item.kind === 'mcp' && (item.scope ?? 'user') === scope)
    .map((item) => item.id)
}

/**
 * 扩展页的动作改的都是工具自己的配置（MCP、技能、插件、插件市场），没权限时说「写不进配置文件」
 * （已知29）。只有「安装 Python」装的是运行环境，照旧按原话认。
 */
export function extensionFailureTarget(failed: string): OperationTarget | undefined {
  return failed && failed !== 'python' ? 'config' : undefined
}

/**
 * 列表行上的一次操作。项目里装的那一份必须带着它自己的 scope 回去，否则 CLI
 * 按缺省的 user 去找，项目里的删不掉，同名的全局那份反倒被改了（#488）。
 */
export async function runExtensionAction(
  api: Pick<V2Bridge, 'mutateProviderExtension' | 'toggleSkill' | 'uninstallSkill' | 'togglePlugin'>,
  item: ExtensionItem,
  action: RowAction,
  nativeSkill?: NativeSkill,
): Promise<void> {
  if (codexPluginToggle(item) && (action === 'enable' || action === 'disable')) {
    await api.togglePlugin(item.id, action === 'enable')
    return
  }
  if (item.provider === 'codex' && item.kind === 'skill') {
    const matched = nativeSkill && findNativeSkill([nativeSkill], item)
    if (!matched) throw new Error('这个技能的文件位置已经变化，请刷新列表后再操作。')
    if (!matched.managed || matched.scope === 'system') throw new Error('这个技能是只读的，不能在这里修改。')
    if (action === 'enable' || action === 'disable')
      await api.toggleSkill(matched.path, action === 'enable')
    else if (action === 'uninstall') await api.uninstallSkill(matched.path)
    else throw new Error('Codex 技能不支持这个操作。')
    return
  }
  const scope = extensionMutationScope(item.scope)
  await api.mutateProviderExtension({
    provider: item.provider,
    kind: item.kind,
    action,
    id: item.id,
    ...(scope ? { scope } : {}),
  })
}
/**
 * 扩展三页一进来先显示哪个工具：按导航里的顺序挑第一个装好的。以前固定是 Claude，
 * 只装了 Codex 的人一进来看到的是 Claude 那边读不到的内容（新手引导梳理 9-25 第 3 条）。
 * 一个都没装或还没检测完时仍是 Claude（旧行为）。
 */
export function preferredExtensionProvider(installed: readonly string[] | undefined): Provider {
  const first = providerOptions.find((option) => installed?.includes(option.value))
  return first && isProvider(first.value) ? first.value : 'claude'
}
// 扩展几页按工具分的页签和「给这些工具用」那一排，次序同导航。
export const activeTools = tools.flatMap((tool) =>
  tool.kind === 'cli' && isProvider(tool.id) ? [{ id: tool.id, name: tool.name }] : [],
)
/** 「给 A、B 使用」里那一串工具名，次序同导航。 */
export function extensionToolNames(ids: readonly string[]): string {
  return activeTools
    .filter((tool) => ids.includes(tool.id))
    .map((tool) => tool.name)
    .join('、')
}

export interface ExtensionToolChoice {
  id: Provider
  name: string
  /** 为什么点不了；能点的为 null。 */
  note: '不支持' | '未安装' | '已添加' | null
}

/**
 * 「给这些工具用」那一排，三个工具都列出来。不支持的、没装的灰着并写明为什么；已经装过的也灰着写「已添加」，
 * 免得再装一遍换来一句 CLI 的英文报错。installedProviders 缺省 = 还没检测完，当作都装了。
 */
export function extensionToolChoices(
  supported: readonly string[],
  installedProviders: readonly string[] | undefined,
  added: readonly string[] = [],
): ExtensionToolChoice[] {
  return activeTools.map(({ id, name }) => ({
    id,
    name,
    note: !supported.includes(id)
      ? '不支持'
      : installedProviders && !installedProviders.includes(id)
        ? '未安装'
        : added.includes(id)
          ? '已添加'
          : null,
  }))
}

export function ExtensionToolPicker({
  choices,
  selected,
  onToggle,
  disabled,
  testId,
}: {
  choices: readonly ExtensionToolChoice[]
  selected: readonly string[]
  onToggle: (id: Provider) => void
  disabled?: boolean
  testId: string
}) {
  return (
    <div className="xm-field">
      {/* 读屏从按钮组自己的名字读到它，这里只给眼睛看。 */}
      <label aria-hidden="true">给这些工具用</label>
      <div className="v2-ext-tool-picker" role="group" aria-label="给这些工具用" data-testid={testId}>
        {choices.map((choice) => {
          const on = choice.note === null && selected.includes(choice.id)
          return (
            <button
              key={choice.id}
              type="button"
              aria-pressed={on}
              disabled={disabled || choice.note !== null}
              onClick={() => onToggle(choice.id)}
              data-testid={`${testId}-${choice.id}`}
            >
              <span className="v2-ext-tool-picker-check" aria-hidden="true">
                {on && <Check size={10} strokeWidth={3.4} />}
              </span>
              {choice.name}
              {choice.note && <span className="v2-ext-tool-picker-note">{choice.note}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 「自定义连接」点「添加」时先查的几样，按表单从上往下报第一处不对。名称照 Codex 的规矩只收字母、数字和 - _
 * （Claude Code 那边主进程放得更宽，这里取几个工具都认的那部分，一个名字才能同时给几个工具用）。
 * existing 是当前工具已经有的连接名：重名时 CLI 只回一句英文报错。
 */
export function customMcpProblem(input: {
  name: string
  transport: string
  source: string
  existing?: readonly string[]
}): string | null {
  const name = input.name.trim()
  if (!name) return '请给这个连接起个名字'
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return '名称只能用字母、数字和 - _，最多 40 位'
  if (input.existing?.includes(name)) return `已经有叫「${name}」的连接了，换个名字`
  const source = input.source.trim()
  if (input.transport === 'stdio') return source ? null : '请填写启动命令'
  return /^https?:\/\/\S/i.test(source) ? null : '服务地址要以 http:// 或 https:// 开头'
}
export function mcpAuthorized(status: string) {
  return ['authenticated', 'logged_in'].includes(status.toLowerCase())
}
/**
 * 「能连上 / 连不上 / 未检测」这一行小标。没有报告 = 这一轮还没检测过，
 * 这时一颗小标都不画，免得旧结果看起来像刚测的。
 */
export function mcpHealthView(
  report: McpHealthReport | null,
  id: string,
  checking = false,
): { tone: 'ok' | 'warn' | 'neutral'; label: string; detail: string | null } | null {
  if (checking) return { tone: 'neutral', label: '检测中', detail: null }
  if (!report) return null
  const entry = report.entries.find((candidate) => candidate.id === id)
  if (entry?.state === 'connected') return { tone: 'ok', label: '能连上', detail: entry.detail }
  if (entry?.state === 'failed') return { tone: 'warn', label: '连不上', detail: entry.detail }
  // 报告里没有这一条时，原因用整份报告那一句（工具不支持、或这次没测完），
  // 而不是留空让用户猜。工具给不出原因就什么都不写，不替它编。
  return { tone: 'neutral', label: '未检测', detail: entry?.detail ?? report.reason }
}

/** 会用到 Python 生态的启动命令。带路径、带 Windows 后缀的写法也要认出来。 */
const pythonCommandNames = ['uvx', 'uv', 'pipx', 'python', 'python3', 'py']

export function mcpCommandRuntime(command: string): 'uv' | 'python' | null {
  const executable = (command.trim().split(/[\\/]/).pop() ?? '')
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
    .toLowerCase()
  if (!pythonCommandNames.includes(executable)) return null
  return executable === 'uvx' || executable === 'uv' ? 'uv' : 'python'
}

/**
 * 精选条目要检查的那条命令。远程服务没有本地命令，但清单里把它标成 python 型时
 * 一样要提示，所以那种情况退回一个代表性的命令名。
 */
export function curatedRuntimeCommand(item: CuratedExtension): string {
  if (item.install.type === 'stdio') return item.install.command
  return item.runtime === 'python' ? 'python' : ''
}

export interface McpRuntimeNotice {
  title: string
  body: string
  /** 只有真的缺 Python 才给按钮：装 Python 解决不了缺 uv。 */
  installPython: boolean
}

/**
 * 社区里一半的 MCP 是 `uvx` 起的，而本应用把 Python 定义成可选环境，多数机器上
 * 没有。装完才发现跑不起来是这一页最常见的投诉，所以添加之前先说一句。
 * 说完仍然可以照常添加——用户可能自己装了 conda 一类探不到的 Python。
 */
export function mcpRuntimeNotice(
  command: string,
  runtimes: ExtensionRuntimes | undefined,
  management: RuntimeInstallManagement,
): McpRuntimeNotice | null {
  // 主进程没给这一块（旧版本）时什么都不提示，保持旧行为。
  if (!runtimes) return null
  const needs = mcpCommandRuntime(command)
  if (!needs) return null
  if (needs === 'uv' && runtimes.uv) return null
  if (needs === 'python' && runtimes.python) return null
  const sentences = [
    needs === 'uv'
      ? `这条连接要用 uv 启动，这台电脑上没有找到 uv${runtimes.python ? '' : '，也没有找到 Python'}。`
      : '这条连接要靠 Python 运行，这台电脑上还没有装。',
  ]
  if (!runtimes.python) {
    sentences.push(management === 'managed'
      ? '可以先装好 Python 再回来添加。'
      : `可以在终端里执行 ${runtimeHomebrewCommand('python')} 装好 Python，再回来添加。`)
  }
  // uv 不是本应用装得了的，所以缺它的时候只能把办法说清楚，不给按钮。
  if (needs === 'uv') {
    sentences.push(runtimes.python
      ? 'uv 要自己装：在命令行里执行 pip install uv。'
      : 'uv 也要自己装：Python 装好之后在命令行里执行 pip install uv。')
  }
  sentences.push('仍然可以直接添加，但工具用到它的时候会连不上。')
  return {
    title: '这条连接还差一样东西',
    body: sentences.join(''),
    installPython: !runtimes.python && management === 'managed',
  }
}
/**
 * JSON.parse 的报错是一句英文，新手最常见的是把 Windows 路径直接贴进去（`C:\Users` 里的
 * 单个反斜杠在 JSON 里不合法）。换成中文，并指向不用手填的那条路。
 */
function parseJsonField(value: string, fallback: string, label: string): unknown {
  try {
    return JSON.parse(value || fallback)
  } catch {
    throw new Error(`${label}的格式不对。填文件夹时请用上面的「选择文件夹」，软件会替你填好；手填路径时每个 \\ 要写成两个。`)
  }
}
export function parseCommandArguments(value: string): string[] {
  const result: unknown = parseJsonField(value, '[]', '附加参数')
  if (
    !Array.isArray(result) ||
    !result.every((item): item is string => typeof item === 'string')
  )
    throw new Error('附加参数需填写为字符串数组，例如 ["-y", "工具包名称"]。')
  return result
}
export function parseEnvironmentVariables(
  value: string,
): Record<string, string> {
  const result: unknown = parseJsonField(value, '{}', '附加设置')
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !Object.entries(result).every(
      ([name, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof entry === 'string',
    )
  )
    throw new Error('附加设置需填写为名称和值均有效的 JSON 对象。')
  return result as Record<string, string>
}

/**
 * 手填表单与「星芒精选」共用同一条提交路径：精选不另开一条通道，命令与参数照样过主进程
 * 的 safeIdentifier / argv 校验（I1、I5）。Codex 的 MCP 走它自己的原生接口，其余三家走
 * mutateProviderExtension，这个分叉本来就在表单里，这里只是把它抽出来让两个入口共用。
 */
export async function submitMcpInstall(
  api: Pick<V2Bridge, 'addMcpServer' | 'mutateProviderExtension'>,
  provider: Provider,
  name: string,
  mcp: McpConfig,
  scope: 'user' | 'project',
  advanced: {
    bearerTokenEnvVar?: string
    oauthClientId?: string
    oauthResource?: string
  } = {},
) {
  if (provider === 'codex') {
    if (mcp.type === 'http') await api.addMcpServer({ name, ...mcp, ...advanced })
    else await api.addMcpServer({ name, ...mcp })
    return
  }
  await api.mutateProviderExtension({
    provider,
    kind: 'mcp',
    action: 'install',
    id: name,
    scope,
    mcp,
  })
}

/**
 * 精选里需要用户自己指定路径的条目（本地文件的允许目录、记忆的存放位置）会把 `{{名字}}`
 * 原样填进表单，等用户替换。没替换就提交等于写进一条起不来的连接，而 CLI 只会在下次启动
 * 时静默失败，所以提交前当场拦住并说清该换哪一项。
 */
export function unresolvedInstallPlaceholders(
  args: readonly string[],
  env: Record<string, string>,
): string[] {
  const found = new Set<string>()
  for (const value of [...args, ...Object.values(env)])
    for (const match of value.matchAll(/\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g))
      found.add(match[0])
  return [...found]
}

/**
 * 把精选条目里的 {{directory}} 换成用户选好的文件夹。换的是解析之后的字符串，不是
 * JSON 文本，所以路径里的反斜杠不用转义（新手引导梳理 9-25 第 3 条）。没填的原样留着，
 * 由 unresolvedInstallPlaceholders 拦下来。
 */
export function fillCuratedPlaceholders(
  args: readonly string[],
  env: Record<string, string>,
  values: Record<string, string>,
): { args: string[]; env: Record<string, string> } {
  const fill = (text: string) => text.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (match, key: string) => values[key]?.trim() || match)
  return {
    args: args.map(fill),
    env: Object.fromEntries(Object.entries(env).map(([name, value]) => [name, fill(value)])),
  }
}

/**
 * 插件市场的 `plugin install` 没有钉版本的开关，装到的就是市场当下那一份。既然改不了，
 * 那至少要在用户点确认之前说清楚，并把复核时的市场 commit 摆出来当参照。
 */
export function curatedVersionText(item: CuratedExtension): string {
  if (item.install.type !== 'plugin')
    return item.pinnedVersion ? `固定在 ${item.pinnedVersion}` : '由对方在线提供，没有本地版本'
  const commit = item.marketplaceCommit ? `，我们复核过的是 ${item.marketplaceCommit.slice(0, 12)} 那一版` : ''
  const declared = item.pinnedVersion ? `插件自己声明的版本是 ${item.pinnedVersion}。` : ''
  return `${declared}安装的是官方市场当前的版本${commit}。`
}

/** hideScope：精选页的确认框下面另有「给这些工具用」，那里不再写「当前这个工具」装在哪一层。 */
export function CuratedDetails({ item, hideScope }: { item: CuratedExtension; hideScope?: boolean }) {
  const network = curatedNetworkLabels[item.network]
  return (
    <div data-testid={`curated-details-${item.id}`}>
      <p>{item.summary}</p>
      <div className="v2-curated-tags">
        {item.requiresAccount && <Pill tone="accent">需要先登录</Pill>}
        {item.risks.length === 0 ? (
          <Pill tone="ok">没有特别的风险</Pill>
        ) : (
          item.risks.map((risk) => (
            <Pill key={risk} tone="warn">
              {curatedRiskLabels[risk].label}
            </Pill>
          ))
        )}
      </div>
      <dl className="v2-business-kv">
        <dt>提供方</dt>
        <dd>{item.publisher}</dd>
        <dt>怎么运行</dt>
        <dd>
          {curatedRuntimeLabels[item.runtime]}
          {network ? `，${network}` : ''}
        </dd>
        <dt>
          {item.install.type === 'http'
            ? '将写进配置的服务地址'
            : item.install.type === 'plugin'
              ? '将要执行的命令'
              : '将写进配置、由工具启动时执行的命令'}
        </dt>
        <dd className="v2-business-path">
          {curatedCommandLines(item).map((line) => (
            <div key={line}>{line}</div>
          ))}
        </dd>
        <dt>装的是哪一版</dt>
        <dd>{curatedVersionText(item)}</dd>
        {!hideScope && (
          <>
            <dt>装到哪里</dt>
            <dd>我的（全局），当前这个工具在任何文件夹里打开都能用</dd>
          </>
        )}
      </dl>
      <p>{item.riskNote}</p>
      {item.note && <p>{item.note}</p>}
      <p>{curatedDisclaimer}</p>
    </div>
  )
}

export function curatedIcon(item: CuratedExtension) {
  return item.install.type === 'plugin' ? Package : item.install.type === 'http' ? Globe : Server
}

/** 精选和官方目录里的一张卡：图标、名字和提供方一行，说明，小标，底下一行放状态或按钮。 */
export function ExtensionCard({
  icon: Icon,
  name,
  byline,
  badge,
  summary,
  tags,
  footer,
  testId,
}: {
  icon: typeof Package
  name: string
  byline?: string
  badge?: ReactNode
  summary: ReactNode
  tags?: ReactNode
  footer?: ReactNode
  testId: string
}) {
  return (
    <article className="v2-ext-card" data-testid={testId}>
      <div className="v2-ext-card-head">
        <span className="v2-ext-tile">
          <Icon size={16} aria-hidden="true" />
        </span>
        <div className="v2-ext-card-name">
          <div>
            <strong>{name}</strong>
            {badge}
          </div>
          {byline && <small>{byline}</small>}
        </div>
      </div>
      <p className="v2-ext-card-summary">{summary}</p>
      {tags && <div className="v2-ext-card-tags">{tags}</div>}
      {footer && <div className="v2-ext-card-foot">{footer}</div>}
    </article>
  )
}

export function curatedTags(item: CuratedExtension) {
  if (!item.requiresAccount && item.risks.length === 0) return undefined
  return (
    <>
      {item.requiresAccount && <Pill tone="accent">需要先登录</Pill>}
      {item.risks.map((risk) => (
        <Pill key={risk} tone="warn">
          {curatedRiskLabels[risk].label}
        </Pill>
      ))}
    </>
  )
}

/**
 * 外接工具页和 Claude Code 插件页底下的「星芒精选」，一张条目一张卡。工具还没装时只摆出来看，
 * 不给按钮（装好工具再来添加）。
 */
export function CuratedShelf({
  items,
  toolName,
  disabled,
  toolMissing,
  installedIds,
  onPick,
}: {
  items: readonly CuratedExtension[]
  /** 已经装上的那张写「已装到 {工具名}」。 */
  toolName: string
  disabled?: boolean
  toolMissing?: boolean
  installedIds?: readonly string[]
  onPick: (item: CuratedExtension) => void
}) {
  if (items.length === 0) return null
  return (
    <section className="v2-ext-section" data-testid="curated-shelf">
      <div className="v2-ext-section-head">
        <h2>星芒精选</h2>
        <span>我们挑过的，装之前会先给你看它要什么权限</span>
      </div>
      <div className="v2-ext-grid">
        {items.map((item) => {
          // 已经装上的还给一个「添加」按钮，点下去只会换来一句 CLI 的英文报错。
          const installed = (installedIds ?? []).includes(curatedInstallTarget(item))
          return (
            <ExtensionCard
              key={item.id}
              icon={curatedIcon(item)}
              name={item.name}
              byline={item.publisher}
              summary={item.summary}
              tags={curatedTags(item)}
              // 要不要联网只在点「添加」后的确认框里说：每张卡都写一遍会把说明挤长。
              footer={
                installed ? (
                  <Pill tone="ok">{`已装到 ${toolName}`}</Pill>
                ) : toolMissing ? undefined : (
                  <Button
                    size="sm"
                    icon={Plus}
                    disabled={disabled}
                    onClick={() => onPick(item)}
                    testId={`curated-install-${item.id}`}
                  >
                    {item.install.type === 'plugin' ? '安装' : '添加'}
                  </Button>
                )
              }
              testId={`curated-row-${item.id}`}
            />
          )
        })}
      </div>
    </section>
  )
}

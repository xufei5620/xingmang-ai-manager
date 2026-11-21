// 「插件」页：精选、外接工具、技能、插件四页合成的一页（扩展合并方案第二版，yoyo 11-20 回「改」），照 GPT 桌面端插件页的
// 版式套 v4 的颜色和组件。左边一窄栏放「插件」「技能」和「已安装」清单，右边按「常用」「写代码」「Claude 官方」「GPT 官方」
// 分组列出来，点「+」勾几家一次装好。读、装、卸、启停全走原来那几条（listProviderExtensions、submitMcpInstall、
// mutateProviderExtension、Codex 自己那几个接口），不加新的通道。合并、分组、每家什么情况的判断在 plugins-hub-model.ts。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Package,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Server,
  Sparkles,
  Store,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { BrandIcon, Button, Dialog, Empty, Menu, Notice, PluginIcon, SearchInput, Switch, useToast } from '../../ui'
import { errorMessage, ResultNotice, useOperation, useReloadWhenShown, useResource } from '../../business-common'
import { curatedDisclaimer, curatedExtensions, curatedRuntimeLabels, curatedNetworkLabels } from '../../registry/curated-extensions'
import { extensionFamilies, extensionOfficialTerms, pluginCatalogTitles } from '../../registry/extensions'
import { curatedPluginIcon, officialPluginIcon, type PluginIconSource } from '../../registry/plugin-icons'
import { subscribeExtensionsView, takeExtensionsView } from '../app/extension-tool-intent'
import { useLatestRequest } from '../../latest-request'
import type { V2Bridge } from '../../types'
import { activeProviderIds, type ActiveProviderId } from '../../../../electron/catalog'
import {
  curatedIcon,
  curatedTags,
  curatedVersionText,
  extensionFailureTarget,
  extensionRowState,
  extensionToolName,
  extensionToolNames,
  extensionUpdateStatus,
  extensionUsableTools,
  findNativeSkill,
  mcpAuthorized,
  mcpHealthView,
  mcpNeedsLogin,
  officialMarketplaceNotice,
  preferredExtensionProvider,
  readCodexExtensionMetadata,
  runExtensionAction,
  type McpRuntimeNotice,
  type RowAction,
} from './extensions-common'
import { ExtensionAddDialog, type ExtensionAddRequest } from './ExtensionAddDialog'
import { HubInstallDialog, HubSkillImportDialog, HubToolChooser, familyNames } from './PluginsHubDialogs'
import {
  buildPluginEntries,
  buildSkillEntries,
  collapsedOfficialCount,
  entryAddableTargets,
  entryMatches,
  entryTargetState,
  entryVisible,
  installedProviders as entryInstalledProviders,
  installScopeSentence,
  pluginShortName,
  type HubEntry,
  type HubFilter,
  type HubGroup,
  type HubInstall,
  type HubSnapshots,
  type HubTargetContext,
  type HubView,
} from './plugins-hub-model'
import '../../extensions.css'

type Provider = ActiveProviderId
type McpHealthReport = Awaited<ReturnType<V2Bridge['checkProviderMcpHealth']>>
type CodexMetadata = Awaited<ReturnType<typeof readCodexExtensionMetadata>>

/**
 * 连接状态只在进这一页和点「重新加载」时读一次，不后台轮询：这条命令会把每个本地连接真的拉起来一次（同外接工具页）。
 * 几家一起测，各自回来各自落；又点了一次时上一轮还没回来的作废（T6）。
 */
function useHubMcpHealth(api: V2Bridge) {
  const [reports, setReports] = useState<Partial<Record<Provider, McpHealthReport>>>({})
  const [checking, setChecking] = useState<Provider[]>([])
  const latest = useLatestRequest()
  const check = useCallback(
    async (providers: readonly Provider[]) => {
      const current = latest.begin()
      setReports({})
      setChecking([...providers])
      await Promise.all(
        providers.map(async (provider) => {
          let report: McpHealthReport
          try {
            report = await api.checkProviderMcpHealth(provider)
          } catch (cause) {
            report = { provider, checkedAt: new Date().toISOString(), supported: true, reason: errorMessage(cause), entries: [] }
          }
          if (!current()) return
          setReports((existing) => ({ ...existing, [provider]: report }))
          setChecking((existing) => existing.filter((entry) => entry !== provider))
        }),
      )
    },
    [api, latest],
  )
  return { reports, checking, check }
}

function entryIcon(entry: HubEntry): PluginIconSource | null {
  if (entry.curated) return curatedPluginIcon(entry.curated.id)
  if (entry.kind === 'plugin' && (entry.group === 'claude' || entry.group === 'codex'))
    return officialPluginIcon(entry.group, pluginShortName(entry.key.slice(entry.key.indexOf(':') + 1)))
  return null
}

function entryFallback(entry: HubEntry): LucideIcon {
  if (entry.curated) return curatedIcon(entry.curated)
  return entry.kind === 'skill' ? Sparkles : entry.kind === 'plugin' ? Package : Server
}

/** 能装进哪几家的小标志：装上了的右下角一个绿点，这台电脑没装那个工具的变淡。 */
function HubMarks({ entry, context }: { entry: HubEntry; context: HubTargetContext }) {
  return (
    <span className="v2-hub-marks" aria-hidden="true">
      {entry.supported.map((id) => {
        const state = entryTargetState(entry, id, context).state
        return (
          <span key={id} className={`v2-hub-mark${state === 'installed' ? ' is-done' : ''}${state === 'tool-missing' ? ' is-na' : ''}`}>
            <BrandIcon tool={id} size={14} variant="xs" />
          </span>
        )
      })}
    </span>
  )
}

/** 读屏读的那一句：「浏览器，能装到：Claude、GPT、Grok；已装到：Claude、GPT」。 */
export function hubRowLabel(entry: HubEntry): string {
  const installed = entryInstalledProviders(entry)
  return `${entry.name}，能装到：${familyNames(entry.supported)}${installed.length ? `；已装到：${familyNames(installed)}` : ''}`
}

export function PluginsHub({
  api,
  installedProviders,
  codexDesktopInstalled,
  onOpenHelp,
  onSystemChanged,
  onOpenHome,
  onRecommend,
  active,
}: {
  api: V2Bridge
  /** 这台电脑上装好的命令行工具；缺省 = 还没检测完，三家都去读、都当作装了。 */
  installedProviders?: readonly string[]
  /** 装没装 Codex 桌面端：只装了它时外接工具和技能照样能加给 GPT（同外接工具页）；插件要 Codex CLI。 */
  codexDesktopInstalled?: boolean
  onOpenHelp?: () => void
  /** 「自动安装 Python」装好以后叫一声，首页「运行环境」跟着变。 */
  onSystemChanged?: () => void
  /** 「去首页安装」；缺省 = 不给这颗按钮。 */
  onOpenHome?: () => void
  /** 「没找到想要的？告诉我们」：去「反馈与客服」；缺省 = 不放。 */
  onRecommend?: () => void
  /** 同 BusinessActions.active：再显示时重读一遍。 */
  active?: boolean
}) {
  const { usable, codexViaDesktop } = extensionUsableTools(installedProviders, codexDesktopInstalled)
  const pluginTools = installedProviders
  const [view, setView] = useState<HubView>('plugins')
  const [tab, setTab] = useState<'recommended' | 'custom'>('recommended')
  const [filter, setFilter] = useState<HubFilter>('all')
  const [query, setQuery] = useState('')
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Partial<Record<HubGroup, boolean>>>({})
  const main = useRef<HTMLDivElement>(null)
  // 老页面名（精选、外接工具、技能、插件）跳过来时落到哪一栏：挂上时取一次，已经挂着就等它叫。
  useLayoutEffect(() => {
    function take() {
      const requested = takeExtensionsView()
      if (!requested) return
      setView(requested)
      setDetailKey(null)
      setQuery('')
    }
    take()
    return subscribeExtensionsView(take)
  }, [])
  const usableKey = usable?.join(',')
  const load = useCallback(async () => {
    const targets = activeProviderIds.filter((id) => usableKey === undefined || usableKey.split(',').includes(id))
    const [results, platform, codex] = await Promise.all([
      Promise.allSettled(targets.map((id) => api.listProviderExtensions(id))),
      api.getPlatformCapabilities().catch(() => null),
      targets.includes('codex') ? readCodexExtensionMetadata(api) : Promise.resolve<CodexMetadata | null>(null),
    ])
    const snapshots: HubSnapshots = {}
    const failures: string[] = []
    targets.forEach((id, index) => {
      const result = results[index]
      if (result?.status === 'fulfilled') snapshots[id] = result.value
      else if (result) failures.push(errorMessage(result.reason))
    })
    return { snapshots, failures, platform, codex }
  }, [api, usableKey])
  const resource = useResource(load)
  useReloadWhenShown(active, () => {
    if (!resource.loading) void resource.reload()
  })
  const data = resource.data
  const snapshots = useMemo<HubSnapshots>(() => data?.snapshots ?? {}, [data])
  const health = useHubMcpHealth(api)
  const operation = useOperation()
  const toast = useToast()
  // 进页面读到第一份列表、点「重新加载」读回来以后，各家有连接的测一遍。
  const healthPending = useRef(true)
  useEffect(() => {
    if (!data || !healthPending.current) return
    healthPending.current = false
    const providers = activeProviderIds.filter((id) => data.snapshots[id]?.items.some((item) => item.kind === 'mcp' && item.installed))
    if (providers.length) void health.check(providers)
  }, [data, health])
  const reload = async () => {
    await resource.reload()
  }
  const reloadAll = () => {
    healthPending.current = true
    void resource.reload()
  }
  const nativeSkill = useCallback(
    (install: HubInstall) => (install.provider === 'codex' && data?.codex ? findNativeSkill(data.codex.skills, install.item) : undefined),
    [data],
  )
  const rowState = (install: HubInstall) => extensionRowState(install.item, nativeSkill(install))
  const pluginEntries = useMemo(() => buildPluginEntries(snapshots, curatedExtensions, pluginTools), [snapshots, pluginTools])
  const skillEntries = useMemo(
    () => buildSkillEntries(snapshots, (install) => extensionRowState(install.item, nativeSkill(install)).readonly),
    [snapshots, nativeSkill],
  )
  const context: HubTargetContext = {
    tools: usable,
    pluginTools,
    skillImport: {
      claude: snapshots.claude?.capabilities.skill.install !== false,
      grok: snapshots.grok?.capabilities.skill.install !== false,
    },
  }
  const entries = view === 'skills' ? skillEntries : pluginEntries
  const detail = detailKey ? entries.find((entry) => entry.key === detailKey) ?? null : null
  // 详情页那一条已经不在了（自己加的从所有工具里移除了），回列表。
  useEffect(() => {
    if (detailKey && data && !entries.some((entry) => entry.key === detailKey)) setDetailKey(null)
  }, [detailKey, data, entries])
  const installedEntries = entries.filter((entry) => entry.installs.length > 0)
  const shown = entries.filter((entry) => entryVisible(entry, filter) && entryMatches(entry, query))
  const runtimes = Object.values(snapshots).find((snapshot) => snapshot?.runtimes)?.runtimes
  const pythonInstall = data?.platform?.pythonRuntimeInstall ?? 'external'
  const nativeMcp = (install: HubInstall) =>
    install.provider === 'codex' && install.item.kind === 'mcp'
      ? data?.codex?.mcp.find((entry) => entry.name === install.item.id || entry.name === install.item.name)
      : undefined
  const installHealth = (install: HubInstall) =>
    install.item.kind === 'mcp' ? mcpHealthView(health.reports[install.provider] ?? null, install.item.id, health.checking.includes(install.provider)) : null
  const installNeedsAuth = (install: HubInstall) => {
    const native = nativeMcp(install)
    return Boolean(native && mcpNeedsLogin(native.authStatus))
  }
  /** 已安装清单上那颗橙点：连不上、要登录授权的，鼠标停上去说是哪种。 */
  const entryWarning = (entry: HubEntry) => {
    if (entry.installs.some((install) => installHealth(install)?.label === '连不上')) return '连不上'
    if (entry.installs.some(installNeedsAuth)) return '需要登录授权'
    return null
  }
  // ——对话框——
  const [installing, setInstalling] = useState<{ entry: HubEntry; initial: Provider[]; key: number } | null>(null)
  const [removing, setRemoving] = useState<HubEntry | null>(null)
  const [deletion, setDeletion] = useState<{ entry: HubEntry; install: HubInstall } | null>(null)
  const [addRequest, setAddRequest] = useState<(ExtensionAddRequest & { kind: 'mcp' | 'plugin'; provider: Provider; key: number }) | null>(null)
  const [choosingTool, setChoosingTool] = useState(false)
  const [importing, setImporting] = useState(0)
  // 「从所有工具里移除」时哪一家没卸掉：记在那一行下面，别的照卸。
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const authCancel = useRef('')
  const [authStopping, setAuthStopping] = useState('')
  const [marketRemoval, setMarketRemoval] = useState<string | null>(null)
  const openInstall = (entry: HubEntry, initial = entryAddableTargets(entry, context)) => {
    operation.clear()
    setInstalling((current) => ({ entry, initial, key: (current?.key ?? 0) + 1 }))
  }
  const openAdd = (form: ExtensionAddRequest['form'], kind: 'mcp' | 'plugin', provider: Provider) => {
    operation.clear()
    setAddRequest((current) => ({ form, kind, provider, key: (current?.key ?? 0) + 1 }))
  }
  const openDetail = (entry: HubEntry) => {
    setDetailKey(entry.key)
    main.current?.scrollTo({ top: 0 })
  }
  const act = (install: HubInstall, action: RowAction) => {
    const state = rowState(install)
    const allowed = action === 'update' ? state.canUpdate : action === 'uninstall' ? state.canUninstall : state.canToggle
    if (!allowed) return
    void operation.execute(
      action,
      async () => {
        await runExtensionAction(api, install.item, action, nativeSkill(install))
        await reload()
      },
      action === 'enable' ? `已启用「${install.item.name}」` : action === 'disable' ? `已停用「${install.item.name}」` : undefined,
    )
  }
  const updateAll = (entry: HubEntry) =>
    void operation.execute('update', async () => {
      for (const install of entry.installs) if (rowState(install).canUpdate) await runExtensionAction(api, install.item, 'update', nativeSkill(install))
      await reload()
    })
  const logout = (install: HubInstall) => {
    const native = nativeMcp(install)
    if (!native) return
    void operation.execute(`auth:${install.item.id}`, async () => {
      await api.logoutMcpServer(native.name)
      await reload()
    })
  }
  const login = (install: HubInstall) => {
    const native = nativeMcp(install)
    if (!native) return
    const authKey = `auth:${install.item.id}`
    authCancel.current = ''
    setAuthStopping('')
    void operation.execute(
      authKey,
      async () => {
        const servers = await api.loginMcpServer(native.name)
        await reload()
        return servers
      },
      (servers) => {
        if (authCancel.current !== authKey) return `${install.item.name} 已授权`
        const server = servers.find((entry) => entry.name === native.name)
        if (server && mcpAuthorized(server.authStatus)) return `${install.item.name} 已授权`
        toast.show(`已取消，${install.item.name} 还没有授权`, 'neutral')
        return null
      },
    )
  }
  const removable = (entry: HubEntry) => entry.installs.filter((install) => rowState(install).canUninstall)
  const removeAll = (entry: HubEntry) =>
    void operation.execute(
      'hub-remove',
      async () => {
        const done: Provider[] = []
        const failed: Record<string, string> = {}
        for (const install of removable(entry)) {
          try {
            await runExtensionAction(api, install.item, 'uninstall', nativeSkill(install))
            if (!done.includes(install.provider)) done.push(install.provider)
          } catch (cause) {
            failed[`${entry.key}|${install.provider}`] = errorMessage(cause)
          }
        }
        setRowErrors(failed)
        setRemoving(null)
        await reload()
        // 有没卸掉的就进详情页，那一家那一行下面写着为什么。
        if (Object.keys(failed).length) {
          setDetailKey(entry.key)
          return null
        }
        return done
      },
      (done) => (done && done.length ? `已从 ${extensionToolNames(done, codexViaDesktop && entry.kind !== 'plugin')} 移除「${entry.name}」` : null),
    )
  // Codex 的目录缺了就直接替用户下载（同插件页），每次进到这一页只自动下一次；失败了留着按钮。
  const ensureMarketplace = (provider: Provider, automatic = false) =>
    void operation.execute(
      'marketplace-ensure',
      async () => {
        await api.ensureProviderMarketplace(provider)
        await reload()
      },
      automatic ? () => null : provider === 'codex' ? '插件目录已下载，下面就是可以安装的插件。' : '官方插件市场已添加，下面就是可以安装的插件。',
    )
  const codexCatalogAutoTried = useRef(false)
  const codexCatalogMissing = (!pluginTools || pluginTools.includes('codex')) && snapshots.codex?.marketplace?.registered === false
  useEffect(() => {
    if (!codexCatalogMissing || codexCatalogAutoTried.current || operation.busy) return
    codexCatalogAutoTried.current = true
    ensureMarketplace('codex', true)
  })
  const installPython = () =>
    void operation.execute(
      'python',
      async () => {
        await api.installPythonRuntime()
        onSystemChanged?.()
        await reload()
      },
      'Python 已经装好了，可以继续添加这条连接',
    )
  function runtimeNoticeActions(notice: McpRuntimeNotice) {
    const help = notice.support ? onOpenHelp : undefined
    if (!notice.installPython && !help) return undefined
    return (
      <>
        {notice.installPython && (
          <Button size="sm" icon={Download} loading={operation.busy === 'python'} disabled={Boolean(operation.busy)} onClick={installPython} testId="mcp-install-python">
            自动安装 Python
          </Button>
        )}
        {help && (
          <Button size="sm" onClick={help} testId="mcp-runtime-support">
            找客服
          </Button>
        )}
      </>
    )
  }
  const defaultProvider = filter === 'all' ? preferredExtensionProvider(usable) : filter
  const filterLabel = filter === 'all' ? '全部' : extensionFamilies[filter].name
  const toolsReady = (id: Provider) => !usable || usable.includes(id)
  const warnings = [
    ...(data?.failures ?? []),
    ...activeProviderIds.flatMap((id) => snapshots[id]?.warnings ?? []),
  ].filter((warning, index, all) => all.indexOf(warning) === index)
  const readonlyNotices = activeProviderIds.flatMap((id) => {
    const capabilities = snapshots[id]?.capabilities
    if (!capabilities) return []
    const kinds = view === 'skills' ? (['skill'] as const) : (['mcp', 'plugin'] as const)
    return kinds.flatMap((kind) => (capabilities[kind].list === false ? [capabilities[kind].reason || '请在工具里管理。'] : []))
  }).filter((reason, index, all) => all.indexOf(reason) === index)

  function renderRow(entry: HubEntry) {
    const addable = entryAddableTargets(entry, context)
    const installed = entry.installs.length > 0
    const builtin = entry.group === 'builtin'
    // testId 用合并键：外接工具按连接名、插件按「插件名@市场名」、技能按名字（技能名可以是中文，照留）。
    const id = entry.key.replace(/[^\p{L}\p{N}_-]+/gu, '-')
    return (
      <div key={entry.key} className="v2-hub-row" data-testid={`hub-row-${id}`}>
        <button type="button" className="v2-hub-row-open" aria-label={hubRowLabel(entry)} onClick={() => openDetail(entry)} data-testid={`hub-open-${id}`}>
          <PluginIcon source={entryIcon(entry)} fallback={entryFallback(entry)} size={38} />
          <span className="v2-hub-row-main">
            <strong>{entry.name}</strong>
            <span>{entry.summary}</span>
          </span>
          <HubMarks entry={entry} context={context} />
        </button>
        {builtin ? (
          <span className="v2-hub-act" title="自带" aria-label="自带" role="img">
            <Lock size={16} aria-hidden="true" />
          </span>
        ) : addable.length > 0 ? (
          <button
            type="button"
            className="xm-icon-btn v2-hub-act"
            title="安装"
            aria-label={`安装 ${entry.name}`}
            disabled={Boolean(operation.busy)}
            onClick={() => openInstall(entry)}
            data-testid={`hub-add-${id}`}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        ) : installed ? (
          <Menu
            label={`${entry.name} 更多操作`}
            anchor={
              <button type="button" className="xm-icon-btn v2-hub-act" title="更多操作" aria-label={`${entry.name} 更多操作`}>
                <MoreHorizontal size={18} aria-hidden="true" />
              </button>
            }
            testId={`hub-menu-${id}`}
            items={[
              { label: '查看详情', icon: FileText, onSelect: () => openDetail(entry) },
              ...(entry.installs.some((install) => rowState(install).canUpdate)
                ? [{ label: '更新', icon: RefreshCw, onSelect: () => updateAll(entry) }]
                : []),
              ...entry.installs.flatMap((install) => {
                const native = nativeMcp(install)
                return native && native.editable && native.transportType === 'http' && mcpAuthorized(native.authStatus)
                  ? [{ label: '退出授权', icon: Plug, onSelect: () => logout(install) }]
                  : []
              }),
              ...(removable(entry).length
                ? [{ label: '从所有工具里移除', icon: Trash2, danger: true, onSelect: () => { operation.clear(); setRemoving(entry) } }]
                : []),
            ]}
          />
        ) : (
          <span className="v2-hub-act" aria-hidden="true" />
        )}
      </div>
    )
  }

  function renderSection(group: HubGroup, title: string, note?: string, extra?: ReactNode) {
    const items = shown.filter((entry) => entry.group === group)
    const official = group === 'claude' || group === 'codex'
    const open = Boolean(expanded[group]) || Boolean(query.trim())
    const visible = official && !open ? items.slice(0, collapsedOfficialCount) : items
    if (!items.length && !extra) return null
    return (
      <section className="v2-hub-section" data-testid={`hub-section-${group}`} key={group}>
        <h2>
          {official && items.length > collapsedOfficialCount ? (
            <button type="button" aria-expanded={open} onClick={() => setExpanded((current) => ({ ...current, [group]: !current[group] }))} data-testid={`hub-section-${group}-toggle`}>
              {title}
              {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            </button>
          ) : (
            <span>{title}</span>
          )}
          {note && <small>{note}</small>}
        </h2>
        {extra}
        {visible.length > 0 && <div className="v2-hub-grid">{visible.map(renderRow)}</div>}
      </section>
    )
  }

  function officialExtra(vendor: 'claude' | 'codex') {
    if (pluginTools && !pluginTools.includes(vendor))
      return (
        <div className="v2-hub-missing" data-testid={`hub-${vendor}-missing`}>
          <span>{vendor === 'codex' ? '装好 Codex CLI 才能看 GPT 官方插件。' : '装好 Claude Code 才能看 Claude 官方插件。'}</span>
          {onOpenHome && (
            <Button size="sm" icon={Download} onClick={onOpenHome} testId={`hub-${vendor}-open-home`}>
              去首页安装
            </Button>
          )}
        </div>
      )
    const notice = officialMarketplaceNotice(snapshots[vendor]?.marketplace)
    if (!notice?.needsAction) return undefined
    return (
      <Notice
        tone={notice.tone}
        title={notice.title}
        body={notice.body}
        testId={`hub-${vendor}-marketplace`}
        actions={
          <Button
            variant="primary"
            icon={Plus}
            loading={operation.busy === 'marketplace-ensure'}
            disabled={Boolean(operation.busy)}
            onClick={() => ensureMarketplace(vendor)}
            testId={`hub-${vendor}-marketplace-add`}
          >
            {notice.actionLabel}
          </Button>
        }
      />
    )
  }

  const markets = data?.codex?.plugins.marketplaces ?? []

  function renderPluginList() {
    const searching = Boolean(query.trim())
    if (tab === 'custom') {
      const items = shown.filter((entry) => entry.group === 'custom')
      return (
        <>
          {items.length ? (
            <div className="v2-hub-grid v2-hub-grid-top">{items.map(renderRow)}</div>
          ) : searching ? (
            <Empty icon={Puzzle} title={`没有找到「${query.trim()}」`} description="换个词试试。" action={<Button size="sm" onClick={() => setQuery('')} testId="hub-clear">清除搜索</Button>} testId="hub-search-empty" />
          ) : (
            <p className="v2-hub-empty" data-testid="hub-custom-empty">还没自己加过。服务方给了连接配置时，点右上角「添加」。</p>
          )}
          {markets.length > 0 && (!pluginTools || pluginTools.includes('codex')) && (filter === 'all' || filter === 'codex') && (
            <section className="v2-hub-section" data-testid="plugins-custom-markets">
              <h2><span>自己添加的市场</span></h2>
              <div className="v2-hub-markets">
                {markets.map((market) => (
                  <div key={market.name} className="v2-hub-market">
                    <PluginIcon source={null} fallback={Store} size={32} />
                    <span className="v2-hub-row-main">
                      <strong>{market.name}</strong>
                      <span className="v2-business-path">{market.root}</span>
                    </span>
                    <Button
                      size="sm"
                      icon={RefreshCw}
                      disabled={Boolean(operation.busy)}
                      onClick={() =>
                        void operation.execute('market-update', async () => {
                          await api.upgradeMarketplace(market.name)
                          await reload()
                        })
                      }
                    >
                      更新
                    </Button>
                    <Menu
                      label={`市场 ${market.name} 的更多操作`}
                      anchor={<MoreHorizontal size={18} />}
                      items={[{ label: '移除市场', icon: Trash2, danger: true, onSelect: () => { operation.clear(); setMarketRemoval(market.name) } }]}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )
    }
    const sections = [
      renderSection('common', '常用'),
      renderSection('coding', '写代码'),
      filter === 'all' || filter === 'claude' ? renderSection('claude', 'Claude 官方', 'Anthropic 官方市场，只能装进 Claude', officialExtra('claude')) : null,
      filter === 'all' || filter === 'codex' ? renderSection('codex', 'GPT 官方', 'OpenAI 插件目录，只能装进 GPT', officialExtra('codex')) : null,
    ].filter(Boolean)
    return (
      <>
        {sections.length ? sections : searching ? (
          <Empty icon={Puzzle} title={`没有找到「${query.trim()}」`} description="换个词试试。" action={<Button size="sm" onClick={() => setQuery('')} testId="hub-clear">清除搜索</Button>} testId="hub-search-empty" />
        ) : null}
        <p className="v2-hub-note">{curatedDisclaimer}</p>
        {onRecommend && (
          <button type="button" className="v2-hub-link" onClick={onRecommend} data-testid="featured-recommend">
            <MessageSquare size={14} aria-hidden="true" />
            没找到想要的？告诉我们
          </button>
        )}
      </>
    )
  }

  function renderSkillList() {
    const local = shown.filter((entry) => entry.group === 'skill')
    const builtin = shown.filter((entry) => entry.group === 'builtin')
    const searching = Boolean(query.trim())
    return (
      <>
        {!local.length && !builtin.length ? (
          searching ? (
            <Empty icon={Sparkles} title={`没有找到「${query.trim()}」`} description="换个词试试。" action={<Button size="sm" onClick={() => setQuery('')} testId="hub-clear">清除搜索</Button>} testId="hub-search-empty" />
          ) : data ? (
            <p className="v2-hub-empty" data-testid="hub-skills-empty">还没装技能。拿到别人给的技能文件夹时，点右上角「添加」导入。</p>
          ) : null
        ) : null}
        {local.length > 0 && (
          <section className="v2-hub-section" data-testid="hub-section-skill">
            <h2><span>装在这台电脑上</span></h2>
            <div className="v2-hub-grid">{local.map(renderRow)}</div>
          </section>
        )}
        {builtin.length > 0 && (
          <section className="v2-hub-section" data-testid="hub-section-builtin">
            <h2>
              <span>Codex 自带</span>
              <small>随 Codex 一起更新，不能删</small>
            </h2>
            <div className="v2-hub-grid">{builtin.map(renderRow)}</div>
          </section>
        )}
        <p className="v2-hub-note" data-testid="skills-codex-official">
          OpenAI 的官方技能现在放在插件里，去「插件」页的「
          <button
            type="button"
            className="v2-hub-inline-link"
            onClick={() => {
              setView('plugins')
              setTab('recommended')
              setDetailKey(null)
              setQuery('')
              setExpanded((current) => ({ ...current, codex: true }))
              requestAnimationFrame(() => document.querySelector('[data-testid="hub-section-codex"]')?.scrollIntoView({ block: 'start' }))
            }}
            data-testid="skills-codex-plugins"
          >
            GPT 官方
          </button>
          」里找。
        </p>
      </>
    )
  }

  function renderInstallRow(entry: HubEntry, provider: Provider) {
    const state = entryTargetState(entry, provider, context)
    const family = extensionFamilies[provider]
    const brand = <BrandIcon tool={provider} size={18} variant="xs" />
    if (state.state === 'installed')
      return state.installs.map((install) => {
        const status = rowState(install)
        const healthView = installHealth(install)
        const needsAuth = installNeedsAuth(install)
        const native = nativeMcp(install)
        const canAuth = Boolean(native?.editable && native.transportType === 'http')
        const authKey = `auth:${install.item.id}`
        const parts = [
          '已装好',
          installScopeSentence(install, entry.group === 'builtin'),
          ...(needsAuth ? ['需要登录授权'] : healthView ? [healthView.label] : []),
          ...(!status.enabled ? ['已停用'] : []),
        ]
        const error = rowErrors[`${entry.key}|${provider}`]
        return (
          <div key={`${provider}:${install.item.scope ?? ''}:${install.item.id}`} className="v2-hub-where" data-testid={`hub-where-${provider}`}>
            {brand}
            <div className="v2-hub-where-text">
              <strong>{family.name}</strong>
              <span>{parts.join(' · ')}</span>
              {healthView?.detail && <span className="v2-business-note">{healthView.detail}</span>}
              {error && <span className="v2-hub-where-error" role="alert">{error}</span>}
            </div>
            {status.canUpdate && install.item.update.state === 'update-available' && (
              <Button size="sm" icon={RefreshCw} loading={operation.busy === 'update'} disabled={Boolean(operation.busy)} onClick={() => act(install, 'update')}>
                更新
              </Button>
            )}
            {native && needsAuth && canAuth && (
              <>
                <Button size="sm" loading={operation.busy === authKey} disabled={Boolean(operation.busy)} onClick={() => login(install)} testId={`hub-auth-${provider}`}>
                  {operation.busy === authKey ? '等你在浏览器里授权' : '登录授权'}
                </Button>
                {operation.busy === authKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={X}
                    loading={authStopping === authKey}
                    aria-label={`停止等待 ${install.item.name} 授权`}
                    onClick={() => {
                      authCancel.current = authKey
                      setAuthStopping(authKey)
                      void api.cancelMcpLogin(native.name).catch((cause: unknown) => {
                        authCancel.current = ''
                        setAuthStopping('')
                        toast.show(errorMessage(cause), 'bad')
                      })
                    }}
                  >
                    {authStopping === authKey ? '正在停止' : '取消'}
                  </Button>
                )}
              </>
            )}
            {status.canToggle && (
              <Switch
                aria-label={`${status.enabled ? '停用' : '启用'} ${install.item.name}`}
                checked={status.enabled}
                onChange={() => {
                  if (!operation.busy) act(install, status.enabled ? 'disable' : 'enable')
                }}
                testId={`hub-toggle-${provider}`}
              />
            )}
            {(status.canUninstall || (native && canAuth && mcpAuthorized(native.authStatus))) && (
              <Menu
                label={`${install.item.name} 更多操作`}
                anchor={<MoreHorizontal size={18} />}
                testId={`hub-where-menu-${provider}`}
                items={[
                  ...(native && canAuth && mcpAuthorized(native.authStatus) ? [{ label: '退出授权', icon: Plug, onSelect: () => logout(install) }] : []),
                  ...(status.canUninstall
                    ? [{
                        label: install.item.kind === 'plugin' ? '卸载…' : `从 ${extensionToolName(provider, codexViaDesktop)} 移除…`,
                        icon: Trash2,
                        danger: true,
                        onSelect: () => {
                          operation.clear()
                          setDeletion({ entry, install })
                        },
                      }]
                    : []),
                ]}
              />
            )}
          </div>
        )
      })
    const text =
      state.state === 'tool-missing'
        ? `这台电脑还没装 ${extensionToolName(provider)}`
        : state.state === 'vendor-only'
          ? `插件各家格式不通用，这一条只有 ${extensionFamilies[state.vendor].name} 版`
          : '还没装'
    return (
      <div key={provider} className={`v2-hub-where${state.state === 'tool-missing' || state.state === 'vendor-only' ? ' is-off' : ''}`} data-testid={`hub-where-${provider}`}>
        {brand}
        <div className="v2-hub-where-text">
          <strong>{family.name}</strong>
          <span>{text}</span>
        </div>
        {state.state === 'addable' && (
          <Button size="sm" disabled={Boolean(operation.busy)} onClick={() => openInstall(entry, [provider])} testId={`hub-where-add-${provider}`}>
            装上
          </Button>
        )}
        {state.state === 'tool-missing' && onOpenHome && (
          <Button size="sm" icon={Download} onClick={onOpenHome} testId={`hub-where-home-${provider}`}>
            去首页安装
          </Button>
        )}
      </div>
    )
  }

  function renderDetail(entry: HubEntry) {
    const addable = entryAddableTargets(entry, context)
    const curated = entry.curated
    const firstInstall = entry.installs[0]
    const termProvider = firstInstall?.provider ?? entry.supported[0] ?? 'claude'
    const publisher = curated?.publisher ?? (entry.group === 'claude' || entry.group === 'codex' ? pluginCatalogTitles[entry.group] : undefined)
    const network = curated ? curatedNetworkLabels[curated.network] : null
    return (
      <div className="v2-hub-detail" data-testid="hub-detail">
        <button type="button" className="v2-hub-back" onClick={() => setDetailKey(null)} data-testid="hub-back">
          <ChevronLeft size={16} aria-hidden="true" />
          {view === 'skills' ? '技能' : '插件'}
        </button>
        <div className="v2-hub-detail-head">
          <PluginIcon source={entryIcon(entry)} fallback={entryFallback(entry)} size={52} />
          <div className="v2-hub-detail-title">
            <h2>{entry.name}</h2>
            {publisher && <small>{publisher}</small>}
            {curated && curatedTags(curated) && <div className="v2-curated-tags">{curatedTags(curated)}</div>}
          </div>
          {addable.length > 0 && (
            <Button variant="primary" icon={Plus} disabled={Boolean(operation.busy)} onClick={() => openInstall(entry)} testId="hub-detail-add">
              {addable.length === 1 ? `装到 ${extensionFamilies[addable[0] as Provider].name}` : '装到更多'}
            </Button>
          )}
        </div>
        <section className="v2-hub-card" data-testid="hub-detail-where">
          <h3>装在哪里</h3>
          {activeProviderIds.map((provider) => renderInstallRow(entry, provider))}
        </section>
        <section className="v2-hub-card" data-testid="hub-detail-about">
          <h3>它会做什么</h3>
          {/* resource-detail-drawer 是旧外接工具页详情框留下的 testid（再往前是旧界面的 ResourceDetails），旧页删了以后挂在
              新页详情的这一块上：同样是说明加提供方、来源那几行，check:v2 要求旧 testid 不丢。 */}
          <div className="v2-hub-about" data-testid="resource-detail-drawer">
            {entry.summary && <p>{entry.summary}</p>}
            <dl className="v2-business-kv">
              {publisher && (
                <>
                  <dt>提供方</dt>
                  <dd>{publisher}</dd>
                </>
              )}
              {curated && (
                <>
                  <dt>怎么运行</dt>
                  <dd>
                    {curatedRuntimeLabels[curated.runtime]}
                    {network ? `，${network}` : ''}
                  </dd>
                </>
              )}
              {!curated && firstInstall && (
                <>
                  <dt>来源</dt>
                  <dd className="v2-business-path">{firstInstall.item.source.locator || '未提供'}</dd>
                </>
              )}
              <dt>装的是哪一版</dt>
              <dd>{curated ? curatedVersionText(curated) : firstInstall?.item.currentVersion || entry.available[termProvider]?.latestVersion || '未提供'}</dd>
              {!curated && firstInstall && (
                <>
                  <dt>更新状态</dt>
                  <dd>{extensionUpdateStatus(firstInstall.item)}</dd>
                </>
              )}
              <dt>官方叫法</dt>
              <dd>{extensionOfficialTerms[entry.kind][termProvider]}</dd>
            </dl>
            {curated && <p>{curated.riskNote}</p>}
            {curated?.note && <p>{curated.note}</p>}
            {entry.kind !== 'skill' && <p>{curatedDisclaimer}</p>}
          </div>
        </section>
        {removable(entry).length > 0 && (
          <div className="v2-hub-remove">
            <Button icon={Trash2} disabled={Boolean(operation.busy)} onClick={() => { operation.clear(); setRemoving(entry) }} testId="hub-remove-all">
              从所有工具里移除
            </Button>
          </div>
        )}
      </div>
    )
  }

  const addMenu =
    view === 'skills'
      ? [{ label: '从文件夹导入', icon: FolderOpen, testId: 'hub-add-skill', onSelect: () => { operation.clear(); setImporting((current) => current + 1) } }]
      : [
          { label: '自定义连接', icon: Plug, testId: 'hub-add-mcp', onSelect: () => openAdd('add', 'mcp', defaultProvider) },
          {
            label: '添加插件',
            icon: Package,
            testId: 'hub-add-plugin',
            onSelect: () => {
              if (filter === 'all') setChoosingTool(true)
              else openAdd('add', 'plugin', filter)
            },
          },
          {
            label: '添加插件市场',
            icon: Store,
            testId: 'hub-add-market',
            disabled: Boolean(pluginTools && !pluginTools.includes('codex')),
            onSelect: () => openAdd('market', 'plugin', 'codex'),
          },
        ]
  const skillImportable = Object.fromEntries(
    activeProviderIds.map((id) => [id, !toolsReady(id) ? 'tool-missing' : context.skillImport?.[id] === false ? 'unsupported' : 'ready']),
  ) as Record<Provider, 'ready' | 'tool-missing' | 'unsupported'>
  const addSnapshot = addRequest ? snapshots[addRequest.provider] : undefined
  return (
    <section className="v2-hub" data-page-id="extensions" data-testid="page-extensions">
      <aside className="v2-hub-side" aria-label="插件">
        <nav className="v2-hub-nav">
          {(['plugins', 'skills'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={view === value ? 'is-on' : undefined}
              aria-current={view === value ? 'page' : undefined}
              onClick={() => {
                setView(value)
                setDetailKey(null)
                setQuery('')
              }}
              data-testid={`hub-nav-${value}`}
            >
              {value === 'plugins' ? <Puzzle size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
              {value === 'plugins' ? '插件' : '技能'}
            </button>
          ))}
        </nav>
        <div className="v2-hub-side-label">
          <span>已安装</span>
          <span>{installedEntries.length}</span>
        </div>
        {installedEntries.length ? (
          <ul className="v2-hub-installed" data-testid="hub-installed">
            {installedEntries.map((entry) => {
              const warning = entryWarning(entry)
              return (
                <li key={entry.key}>
                  <button type="button" className={detailKey === entry.key ? 'is-on' : undefined} onClick={() => openDetail(entry)}>
                    <PluginIcon source={entryIcon(entry)} fallback={entryFallback(entry)} size={20} />
                    <span className="v2-hub-installed-name">{entry.name}</span>
                    {warning && <i className="v2-hub-warn" title={warning} aria-label={warning} role="img" />}
                    <span className="v2-hub-marks" aria-hidden="true">
                      {entryInstalledProviders(entry).map((id) => <BrandIcon key={id} tool={id} size={12} variant="xs" />)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          data && <p className="v2-hub-side-empty">{view === 'skills' ? '还没装技能' : '还没装插件'}</p>
        )}
      </aside>
      <div className="v2-hub-main" ref={main}>
        <div className="v2-hub-inner">
          <ResultNotice {...operation} onSupport={onOpenHelp} target={extensionFailureTarget(operation.failed)} />
          {warnings.map((warning) => (
            <Notice key={warning} tone="warn" title="部分信息需要确认" body={warning} />
          ))}
          {readonlyNotices.map((reason) => (
            <Notice key={reason} tone="warn" title="当前工具未提供管理能力" body={reason} />
          ))}
          {detail ? (
            renderDetail(detail)
          ) : (
            <>
              <header className="v2-hub-head">
                <div className="v2-hub-head-copy">
                  <h1>{view === 'skills' ? '技能' : '插件'}</h1>
                  <p>{view === 'skills' ? '教 AI 做好某类事的说明书，几家 AI 通用。' : '装上插件，Claude 和 GPT 就能帮你做更多事。'}</p>
                </div>
                <div className="v2-hub-tools">
                  <SearchInput value={query} onChange={setQuery} placeholder={view === 'skills' ? '搜索技能' : '搜索插件'} testId="hub-search" />
                  <Menu
                    label="装到"
                    align="end"
                    anchor={<Button iconRight={ChevronDown} testId="hub-filter">{`装到：${filterLabel}`}</Button>}
                    items={(['all', ...activeProviderIds] as const).map((value) => ({
                      label: value === 'all' ? '全部' : extensionFamilies[value].name,
                      checked: filter === value,
                      hint: value !== 'all' && !toolsReady(value) ? '还没装' : undefined,
                      testId: `hub-filter-${value}`,
                      onSelect: () => setFilter(value),
                    }))}
                  />
                  <button
                    type="button"
                    className="xm-icon-btn v2-hub-reload"
                    title="重新加载"
                    aria-label="重新加载"
                    disabled={resource.loading || health.checking.length > 0}
                    onClick={reloadAll}
                    data-testid="hub-reload"
                  >
                    <RefreshCw size={16} aria-hidden="true" className={resource.loading || health.checking.length > 0 ? 'xm-spin' : undefined} />
                  </button>
                  <Menu
                    label="添加"
                    align="end"
                    anchor={<Button variant="primary" iconRight={ChevronDown} disabled={Boolean(operation.busy)} testId="hub-add">添加</Button>}
                    items={addMenu}
                  />
                </div>
              </header>
              {view === 'plugins' && (
                <div className="v2-hub-tabs" role="tablist" aria-label="插件">
                  {(['recommended', 'custom'] as const).map((value) => (
                    <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'is-on' : undefined} onClick={() => setTab(value)} data-testid={`hub-tab-${value}`}>
                      {value === 'recommended' ? '推荐' : '自己加的'}
                    </button>
                  ))}
                </div>
              )}
              {resource.error && !data ? (
                <Notice tone="warn" title="部分信息需要确认" body={resource.error} actions={<Button size="sm" onClick={reloadAll}>重新加载</Button>} />
              ) : null}
              <div className="v2-hub-list" data-testid={`hub-${view}`}>{view === 'skills' ? renderSkillList() : renderPluginList()}</div>
            </>
          )}
        </div>
      </div>
      {installing && (
        <HubInstallDialog
          key={installing.key}
          api={api}
          entry={pluginEntries.concat(skillEntries).find((entry) => entry.key === installing.entry.key) ?? installing.entry}
          initial={installing.initial}
          context={context}
          runtimes={runtimes}
          pythonInstall={pythonInstall}
          operation={operation}
          onClose={() => setInstalling(null)}
          onChanged={reload}
          onOpenHome={onOpenHome}
          onOpenHelp={onOpenHelp}
          onSystemChanged={onSystemChanged}
          codexViaDesktop={codexViaDesktop}
        />
      )}
      {importing > 0 && (
        <HubSkillImportDialog
          key={importing}
          api={api}
          tools={activeProviderIds.filter((id) => skillImportable[id] === 'ready')}
          importable={skillImportable}
          operation={operation}
          onClose={() => setImporting(0)}
          onChanged={reload}
        />
      )}
      {choosingTool && (
        <HubToolChooser
          tools={pluginTools}
          onClose={() => setChoosingTool(false)}
          onChoose={(id) => {
            setChoosingTool(false)
            openAdd('add', 'plugin', id)
          }}
        />
      )}
      {addRequest && (
        <ExtensionAddDialog
          key={addRequest.key}
          api={api}
          kind={addRequest.kind}
          provider={addRequest.provider}
          request={addRequest}
          items={addSnapshot?.items ?? []}
          runtimes={addSnapshot?.runtimes ?? runtimes}
          pythonInstall={pythonInstall}
          usable={addRequest.kind === 'plugin' ? pluginTools : usable}
          codexViaDesktop={codexViaDesktop}
          operation={operation}
          runtimeNoticeActions={runtimeNoticeActions}
          onClose={() => setAddRequest(null)}
          onChanged={reload}
        />
      )}
      <Dialog
        open={Boolean(removing)}
        title={`从所有工具里移除「${removing?.name ?? ''}」？`}
        testId="hub-remove-dialog"
        busy={operation.busy === 'hub-remove'}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'hub-remove'}
              disabled={Boolean(operation.busy) && operation.busy !== 'hub-remove'}
              onClick={() => {
                if (removing) removeAll(removing)
              }}
              testId="hub-remove-confirm"
            >
              移除
            </Button>
          </>
        }
      >
        <p>{`会从 ${removing ? extensionToolNames(removable(removing).map((install) => install.provider), codexViaDesktop && removing.kind !== 'plugin') : ''} 里一起移除。以后想用再装回来就行。`}</p>
        {/* 别的改动（开关、更新）还没回来时「移除」灰着：说一句为什么，不让按钮干转（同原来外接工具页）。 */}
        {operation.busy && operation.busy !== 'hub-remove' && <p role="status" data-testid="hub-remove-busy">上一个操作还没完成，完成后才能移除。</p>}
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
      </Dialog>
      <Dialog
        open={Boolean(deletion)}
        title={
          deletion?.install.item.kind === 'plugin'
            ? `卸载「${deletion.install.item.name}」？`
            : `从 ${deletion ? extensionToolName(deletion.install.provider, codexViaDesktop) : ''} 移除「${deletion?.install.item.name ?? ''}」？`
        }
        onClose={() => setDeletion(null)}
        footer={
          <>
            <Button onClick={() => setDeletion(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'delete'}
              disabled={Boolean(operation.busy) && operation.busy !== 'delete'}
              onClick={() => {
                const open = deletion
                if (!open) return
                const toolName = extensionToolName(open.install.provider, codexViaDesktop)
                void operation.execute(
                  'delete',
                  async () => {
                    await runExtensionAction(api, open.install.item, 'uninstall', nativeSkill(open.install))
                    setDeletion(null)
                    await reload()
                  },
                  open.install.item.kind === 'plugin' ? `已卸载「${open.install.item.name}」` : `已从 ${toolName} 移除「${open.install.item.name}」`,
                )
              }}
              testId="hub-delete-confirm"
            >
              {deletion?.install.item.kind === 'plugin' ? '卸载' : '移除'}
            </Button>
          </>
        }
      >
        <p>
          {deletion?.install.item.kind === 'plugin'
            ? '插件里带的技能、命令和连接会一起移除。'
            : deletion?.install.item.kind === 'skill'
              ? '其他工具里的不受影响。以后要用，再「从文件夹导入」一次。'
              : deletion?.entry.group === 'custom'
                ? '其他工具里的不受影响。自己加的要重新填一遍。'
                : '其他工具里的不受影响。以后想用再装回来就行。'}
        </p>
        {operation.busy && operation.busy !== 'delete' && (
          <p role="status" data-testid="hub-delete-busy">
            {deletion?.install.item.kind === 'plugin' ? '上一个操作还没完成，完成后才能卸载。' : '上一个操作还没完成，完成后才能移除。'}
          </p>
        )}
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
      </Dialog>
      <Dialog
        open={marketRemoval !== null}
        title={`移除市场「${marketRemoval ?? ''}」？`}
        onClose={() => setMarketRemoval(null)}
        testId="plugins-market-delete-dialog"
        footer={
          <>
            <Button onClick={() => setMarketRemoval(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'market-delete'}
              disabled={Boolean(operation.busy) && operation.busy !== 'market-delete'}
              onClick={() => {
                if (marketRemoval !== null)
                  void operation.execute('market-delete', async () => {
                    await api.removeMarketplace(marketRemoval)
                    setMarketRemoval(null)
                    await reload()
                  })
              }}
              testId="plugins-market-delete-confirm"
            >
              移除
            </Button>
          </>
        }
      >
        <p>移除后，这个市场就不在列表里了，要用时得重新添加。</p>
        {operation.busy && operation.busy !== 'market-delete' && (
          <p role="status" data-testid="plugins-market-delete-busy">上一个操作还没完成，完成后才能移除。</p>
        )}
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
      </Dialog>
    </section>
  )
}

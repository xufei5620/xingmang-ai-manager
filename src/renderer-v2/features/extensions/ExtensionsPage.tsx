// 扩展三页：外接工具（MCP）、技能、插件（#1070 第 11 步，从 pages-management.tsx 原样搬来）。和「星芒精选」页共用的
// 判断、解析和卡片在 extensions-common.tsx；装工具那几句结果照旧从 pages-maintenance 拿（拆之前就这样，样式表的先后
// 也靠它，见 pages-management.tsx 开头）。pages-management.tsx 照旧转出 ExtensionsPage。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  FileText,
  FolderOpen,
  Globe,
  MoreHorizontal,
  Package,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import {
  BrandIcon,
  Button,
  Card,
  Dialog,
  Input,
  ListRow,
  Menu,
  Notice,
  PageHead,
  Pill,
  Progress,
  SearchInput,
  Segment,
  Select,
  Switch,
  Tabs,
  Textarea,
  Toolbar,
  useToast,
} from '../../ui'
import {
  RelativeTime,
  errorMessage,
  ListState,
  ResultNotice,
  useOperation,
  useReloadWhenShown,
  useResource,
} from '../../business-common'
import {
  curatedInstallTarget,
  curatedItemsFor,
  curatedNeedsInput,
  type CuratedExtension,
} from '../../registry/curated-extensions'
import {
  extensionKindLabels,
  extensionOfficialTerms,
  extensionScopeGroups,
  pluginCatalogTitles,
} from '../../registry/extensions'
import { requestExtensionTool, subscribeExtensionTool, takeExtensionTool } from '../app/extension-tool-intent'
import { installJobRunning, installResultMessage, type BusinessActions } from '../../pages-maintenance'
import { useLatestRequest } from '../../latest-request'
import type { V2Bridge } from '../../types'
import type { ActiveProviderId } from '../../../../electron/catalog'
import {
  CuratedDetails,
  CuratedShelf,
  ExtensionCard,
  ExtensionToolPicker,
  activeTools,
  curatedRuntimeCommand,
  customMcpProblem,
  extensionFailureTarget,
  extensionFormOffersProject,
  extensionInstallNeedsTrust,
  extensionItemsForView,
  extensionRowState,
  extensionScopeLabel,
  extensionShowsUpdatePill,
  extensionToolChoices,
  extensionToolName,
  extensionToolNames,
  extensionUpdateStatus,
  extensionUsableTools,
  fillCuratedPlaceholders,
  filterExtensionMarkets,
  findNativeSkill,
  groupExtensionItems,
  mcpAuthorized,
  mcpHealthView,
  mcpNamesInScope,
  mcpNeedsLogin,
  mcpRuntimeNotice,
  officialMarketplaceNotice,
  parseCommandArguments,
  parseEnvironmentVariables,
  preferredExtensionProvider,
  readCodexExtensionMetadata,
  runExtensionAction,
  submitMcpInstall,
  unresolvedInstallPlaceholders,
  type RowAction,
} from './extensions-common'
import { isProvider } from '../tools/provider-options'
import '../../extensions.css'

// 已下线的 CLI（Gemini，yoyo 2026-10-14）不在这里：管理页不再列它的扩展、会话和备份。
type Provider = ActiveProviderId
type ExtensionSnapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>
type ExtensionItem = ExtensionSnapshot['items'][number]
type ExtensionKind = ExtensionItem['kind']
type McpHealthReport = Awaited<ReturnType<V2Bridge['checkProviderMcpHealth']>>
/**
 * 连接状态只在进入外接工具页、换工具或用户点「重新检测」时读一次，不后台轮询：
 * 这条命令会把每个本地 MCP 真的拉起来一次。换工具时旧结果必须立刻作废，
 * 否则慢响应会盖到新工具的列表上（T6）。
 */
function useMcpHealth(api: V2Bridge, provider: Provider, enabled: boolean) {
  const [report, setReport] = useState<McpHealthReport | null>(null)
  const [checking, setChecking] = useState(false)
  const sequence = useLatestRequest()
  const check = useCallback(async () => {
    const id = sequence.begin()
    setReport(null)
    setChecking(true)
    try {
      const result = await api.checkProviderMcpHealth(provider)
      if (id()) setReport(result)
    } catch (cause) {
      if (id()) {
        setReport({
          provider,
          checkedAt: new Date().toISOString(),
          supported: true,
          reason: errorMessage(cause),
          entries: [],
        })
      }
    } finally {
      if (id()) setChecking(false)
    }
  }, [api, provider, sequence])
  useEffect(() => {
    if (!enabled) {
      sequence.invalidate()
      setReport(null)
      setChecking(false)
      return
    }
    void check()
    return sequence.invalidate
  }, [check, enabled, sequence])
  return { report, checking, check }
}

/**
 * 扩展页的操作要等工具自己跑完，这期间可以换到别的工具。换过去那一下红条
 * 已经清了，跑完才落下来的失败却照样挂在页顶，摆到了新工具下面。所以结果记着是哪个工具下点的，只在那个
 * 工具下面摆出来：换走以后才落下的先收着，换回去再出来。clear() 只清屏上摆着的那条，换工具时清掉的是正
 * 离开的那个工具的红条，收着的那条不跟着丢；再点一次操作照旧整个换掉。
 */
function useToolOperation(provider: Provider) {
  const operation = useOperation()
  const [owner, setOwner] = useState(provider)
  const shown = owner === provider
  const execute: typeof operation.execute = (name, action, success) =>
    operation.execute(
      name,
      () => {
        setOwner(provider)
        return action()
      },
      success,
    )
  return {
    ...operation,
    message: shown ? operation.message : '',
    revealPath: shown ? operation.revealPath : '',
    error: shown ? operation.error : '',
    detail: shown ? operation.detail : '',
    failed: shown ? operation.failed : '',
    execute,
    clear: () => {
      if (shown) operation.clear()
    },
  }
}

export function ExtensionsPage({
  api,
  kind,
  onOpenHelp,
  installedProviders,
  codexDesktopInstalled,
  onSystemChanged,
  active,
  installTool,
  toolJobs,
  onOpenPlugins,
}: {
  api: V2Bridge
  kind: ExtensionKind
  onOpenHelp?: () => void
  /** 这台电脑上装好的命令行工具；缺省 = 不知道，默认选 Claude、当作都装了（旧行为）。 */
  installedProviders?: readonly string[]
  /**
   * 装没装 Codex 桌面端。没装 Codex CLI 只装了它时，外接工具和技能照样在 Codex 那一格管（主进程直接改它和 CLI
   * 共用的那份配置），插件那一格指去桌面端自己的插件页。缺省 = 当没装（旧行为）。
   */
  codexDesktopInstalled?: boolean
  /**
   * 「自动安装 Python」装好以后叫一声，由 App 重新检测，首页「运行环境」跟着变（同 BusinessActions.onSystemChanged）。
   * 缺省 = 只刷新本页（旧行为）。
   */
  onSystemChanged?: () => void
  /**
   * 外壳说的「现在显示的是这一页」（同 BusinessActions.active）：再显示时重读列表；
   * 缺省 = 只在第一次进来时读（旧行为）。
   */
  active?: boolean
  /**
   * 选着的工具还没装时，页上那颗「安装 {工具名}」走首页那条完整的安装（同 BusinessActions.installTool），
   * 缺运行环境先装、装完写 Key。缺省 = 只说还没装，不给按钮。
   */
  installTool?: BusinessActions['installTool']
  /** 首页那份正在跑的任务：在首页或这里点的安装，这一页都画进度（同 BusinessActions.toolJobs）。 */
  toolJobs?: BusinessActions['toolJobs']
  /** Codex 技能页「去看插件」：插件页已经替他选好 Codex CLI，这里只管跳过去；缺省 = 不放那一块。 */
  onOpenPlugins?: () => void
}) {
  const page =
    kind === 'skill' ? 'skills' : kind === 'plugin' ? 'plugins' : 'mcp'
  const title = extensionKindLabels[kind]
  const { usable, codexViaDesktop } = extensionUsableTools(installedProviders, codexDesktopInstalled)
  const [provider, setProvider] = useState<Provider>(() => preferredExtensionProvider(usable))
  // 检测结果比页面晚到时跟上去；用户自己点过工具之后就不再替他换。
  const providerTouched = useRef(false)
  const preferredProvider = preferredExtensionProvider(usable)
  useEffect(() => {
    if (!providerTouched.current) setProvider(preferredProvider)
  }, [preferredProvider])
  const [query, setQuery] = useState('')
  // 别的页点名要落在哪个工具上（技能页「去看插件」）：挂上时取一次，已经挂着就等它叫。
  useLayoutEffect(() => {
    function take() {
      const requested = takeExtensionTool(page)
      if (!requested) return
      providerTouched.current = true
      setProvider(requested)
      setQuery('')
    }
    take()
    return subscribeExtensionTool(take)
  }, [page])
  // 已经知道没装的工具不去问它：问了也只换来一句找不到命令。还没检测完的照旧去读（旧行为）。
  const missing = usable !== undefined && !usable.includes(provider)
  // 只装了 Codex 桌面端时插件要 CLI 才管得了，这一格只放一句话指去桌面端，不读列表、不替他下插件目录。
  const desktopPlugins = kind === 'plugin' && provider === 'codex' && codexViaDesktop
  const load = useCallback(
    async () => {
      if (missing || desktopPlugins) return null
      // 平台能力只决定缺 Python 时那颗按钮给不给，读不出来不该让整页空着：
      // 失败就当成「本应用不代装」，提示照出，只是不给按钮。
      const [snapshot, platform] = await Promise.all([
        api.listProviderExtensions(provider),
        kind === 'mcp'
          ? api.getPlatformCapabilities().catch(() => null)
          : Promise.resolve(null),
      ])
      if (provider !== 'codex') return { snapshot, platform, codex: null }

      return {
        snapshot,
        platform,
        codex: await readCodexExtensionMetadata(api),
      }
    },
    [api, kind, provider, missing, desktopPlugins],
  )
  const resource = useResource(load)
  // 去过的页面只藏不卸：在首页、检查页或终端里装好、删掉东西，回来还是第一次进来时那份，
  // 要自己点「重新加载」（已知5）。再显示时重读列表；读列表要问一遍工具本身，还在读就不再起一轮。
  // 外接工具的连接检测要挨个连一遍，比读列表重得多，照旧只在进页、换工具和点「重新检测」时做。
  useReloadWhenShown(active, () => {
    if (!resource.loading) void resource.reload()
  })
  // 装插件、改连接、重新检测都要等工具自己跑完，这期间可以换到别的工具。换过去那一下页面已经在读新工具的
  // 列表和连接状态，跑完以后再照原来那个工具读一遍，就把上一个工具的东西摆到了新工具下面（逆向报告 B4）。
  // 所以跑完先看一眼还是不是那个工具，换走了就不再读，留给新工具自己那一轮。
  const shownProvider = useRef(provider)
  useLayoutEffect(() => { shownProvider.current = provider })
  const reloadList = async () => {
    if (shownProvider.current === provider) await resource.reload()
  }
  const health = useMcpHealth(api, provider, kind === 'mcp' && !missing)
  const operation = useToolOperation(provider)
  const toast = useToast()
  // 「登录授权」旁那颗「取消」点在了哪一行（authKey）；停没停下来，要等那次登录自己回来才知道（#1099 第 1 条）。
  const authCancel = useRef('')
  const [authStopping, setAuthStopping] = useState('')
  const [form, setForm] = useState<'add' | 'market' | null>(null)
  const [formName, setFormName] = useState('')
  const [source, setSource] = useState('')
  const [transport, setTransport] = useState('stdio')
  const [args, setArgs] = useState('[]')
  const [environment, setEnvironment] = useState('{}')
  const [bearerEnv, setBearerEnv] = useState('')
  const [oauthClient, setOauthClient] = useState('')
  const [oauthResource, setOauthResource] = useState('')
  const [formScope, setFormScope] = useState<'user' | 'project'>('user')
  // 「自定义连接」给哪几个工具加；打开时只勾当前这个。
  const [formTools, setFormTools] = useState<Provider[]>([])
  const [deletion, setDeletion] = useState<ExtensionItem | null>(null)
  // 「添加插件」表单点了「添加」、等用户在确认框里点「信任并安装」（只有 Grok 有这一步）。
  const [trusting, setTrusting] = useState(false)
  const [selected, setSelected] = useState<ExtensionItem | null>(null)
  // 待确认的精选条目，以及已经把表单填好、等用户补上路径的那一条。
  const [curated, setCurated] = useState<CuratedExtension | null>(null)
  const [curatedForm, setCuratedForm] = useState<CuratedExtension | null>(null)
  const [curatedValues, setCuratedValues] = useState<Record<string, string>>({})
  const curatedItems = useMemo(() => curatedItemsFor(kind, provider), [kind, provider])
  const normalizedQuery = query.trim().toLowerCase()
  // 搜索时精选、官方目录也按同一个词筛；一条都不匹配，那一块就不出来（CuratedShelf 遇到空列表不画）。
  const shownCurated = normalizedQuery
    ? curatedItems.filter((item) =>
        `${item.name} ${item.summary}`.toLowerCase().includes(normalizedQuery),
      )
    : curatedItems
  const toolName = extensionToolName(provider, codexViaDesktop)
  const snapshot = resource.data?.snapshot
  const installedItems = extensionItemsForView(snapshot?.items ?? [], kind, 'installed')
  const matches = (item: ExtensionItem) =>
    `${item.name} ${item.description} ${item.source.locator ?? ''}`
      .toLowerCase()
      .includes(normalizedQuery)
  const list = installedItems.filter(matches)
  // 页签上的数：去过的工具才有（每个工具都问一遍太重），没去过的只写名字。
  const [counts, setCounts] = useState<Partial<Record<Provider, number>>>({})
  useEffect(() => {
    if (!snapshot || !isProvider(snapshot.provider)) return
    const owner = snapshot.provider
    const count = extensionItemsForView(snapshot.items, kind, 'installed').length
    setCounts((current) => (current[owner] === count ? current : { ...current, [owner]: count }))
  }, [snapshot, kind])
  // 精选卡用它判断「这条已经装上了」，所以看的是整份快照，而不是被搜索框过滤过的 list。
  const installedIds = (snapshot?.items ?? [])
    .filter((item) => item.kind === kind && item.installed)
    .map((item) => item.id)
  // 插件页合成一页以后，没装的插件（官方目录里可以装的那些）摆在已装列表下面。
  const catalogItems = kind === 'plugin'
    ? (snapshot?.items ?? []).filter((item) => item.kind === 'plugin' && !item.installed && matches(item))
    : []
  const catalogTitle = kind === 'plugin' ? pluginCatalogTitles[provider] : undefined
  const capability = snapshot?.capabilities[kind]
  const pythonInstall = resource.data?.platform?.pythonRuntimeInstall ?? 'external'
  const addFormRuntimeNotice = kind === 'mcp' && transport === 'stdio'
    ? mcpRuntimeNotice(source, snapshot?.runtimes, pythonInstall)
    : null
  const curatedRuntimeNotice = curated
    ? mcpRuntimeNotice(curatedRuntimeCommand(curated), snapshot?.runtimes, pythonInstall)
    : null
  const installPython = () =>
    void operation.execute(
      'python',
      async () => {
        await api.installPythonRuntime()
        // 不叫的话回首页，「运行环境」里 Python 还写「可选 · 未装」、还给安装按钮。先叫、再读本页：
        // 本页那次读接上 App 刚起的那一轮检测。
        onSystemChanged?.()
        await reloadList()
      },
      'Python 已经装好了，可以继续添加这条连接',
    )
  const job = toolJobs?.[provider]
  const installingTool = installJobRunning(job)
  const installMissingTool = () =>
    void operation.execute(
      'install-tool',
      async () => (installTool ? installTool(provider) : 'skipped' as const),
      (outcome) => installResultMessage(outcome),
    )
  // Claude Code、Grok CLI 的技能导入是主进程照 Codex 那套复制进它们自己的技能文件夹，主进程说不行（install: false）才不给。
  const supportsInstall =
    kind !== 'skill' || provider === 'codex' || capability?.install !== false
  const nativeSkillFor = (item: ExtensionItem) =>
    kind === 'skill' && resource.data?.codex
      ? findNativeSkill(resource.data.codex.skills, item)
      : undefined
  const groups = groupExtensionItems(
    list,
    extensionScopeGroups[kind][provider],
    (item) => extensionRowState(item, nativeSkillFor(item)).readonly,
  )
  const act = (item: ExtensionItem, action: RowAction) => {
    const native = nativeSkillFor(item)
    const state = extensionRowState(item, native)
    const allowed =
      action === 'install'
        ? item.operations.install
        : action === 'update'
          ? state.canUpdate
          : action === 'uninstall'
            ? state.canUninstall
            : state.canToggle
    if (!allowed) return
    void operation.execute(
      action,
      async () => {
        await runExtensionAction(api, item, action, native)
        await reloadList()
      },
      action === 'enable'
        ? `已启用「${item.name}」`
        : action === 'disable'
          ? `已停用「${item.name}」`
          : action === 'install' && kind === 'plugin'
            ? `已安装「${item.name}」，给 ${toolName} 使用`
            : undefined,
    )
  }
  const showForm = () => {
    setFormScope('user')
    setFormName('')
    setSource('')
    setTransport('stdio')
    setArgs('[]')
    setEnvironment('{}')
    setBearerEnv('')
    setOauthClient('')
    setOauthResource('')
    setFormTools([provider])
    setCuratedForm(null)
    setCuratedValues({})
    setForm('add')
    operation.clear()
  }
  // 需要用户自己指定路径的精选条目不直接装，先把表单填好，把该替换的那一项留在附加参数里。
  const prefillCurated = (item: CuratedExtension) => {
    // 插件条目没有占位符，永远走不到这条路；写在最前面是为了让类型收窄到 MCP 那两种。
    if (item.install.type === 'plugin') return
    showForm()
    setFormName(item.id)
    setTransport(item.install.type === 'http' ? 'http' : 'stdio')
    setSource(
      item.install.type === 'http' ? item.install.url : item.install.command,
    )
    if (item.install.type === 'stdio') {
      setArgs(JSON.stringify(item.install.args))
      setEnvironment(JSON.stringify(item.install.env))
    }
    setCuratedForm(item)
  }
  // 空列表里的「看看精选」把焦点交给精选卡的第一个「添加」，键盘用户不用自己找上去；
  // 精选都装过了就只滚到那一块。
  const seeCurated = () => {
    const button = document.querySelector<HTMLElement>(
      '[data-testid="curated-shelf"] [data-testid^="curated-install-"]',
    )
    const target = button ?? document.querySelector<HTMLElement>('[data-testid="curated-shelf"]')
    target?.scrollIntoView({ block: 'center' })
    button?.focus()
  }
  // 插件精选走的是页面上「添加插件」那条出口：主进程会先保证官方市场在册，再执行
  // `plugin install <插件名>@<市场名>`。精选不另开通道，校验与手填来源完全同一套。
  const installCurated = (item: CuratedExtension) =>
    void operation.execute(
      'curated',
      async () => {
        if (item.install.type === 'plugin')
          await api.mutateProviderExtension({
            provider,
            kind: 'plugin',
            action: 'install',
            source: curatedInstallTarget(item),
          })
        else await submitMcpInstall(api, provider, item.id, item.install, 'user')
        setCurated(null)
        await reloadList()
      },
      `${item.install.type === 'plugin' ? '已安装' : '已添加'}「${item.name}」，给 ${toolName} 使用`,
    )
  const formChoices = extensionToolChoices(
    activeTools.map((tool) => tool.id),
    usable,
    [],
    codexViaDesktop,
  )
  // 勾选按导航次序装，成功提示里的工具名也按这个次序。
  const formTargets = formChoices
    .filter((choice) => choice.note === null && formTools.includes(choice.id))
    .map((choice) => choice.id)
  // Codex CLI 的连接只有全局一层，submitMcpInstall 给它的范围会被丢掉。勾上它时整张表就只能装到「我的（全局）」，
  // 不然框里写着装进当前项目，Codex CLI 那边其实是全局的。
  const mcpGlobalOnly = kind === 'mcp' && formTargets.includes('codex')
  // OAuth 那两项是 `codex mcp add` 当场去登录时用的，没装 Codex CLI 时写不进配置，不给填。
  const oauthUnavailable = codexViaDesktop && formTargets.includes('codex')
  const formOffersProject = kind === 'mcp' ? !mcpGlobalOnly : extensionFormOffersProject(provider, kind)
  const shownScope = formOffersProject ? formScope : 'user'
  const addMcp = async () => {
    const name = formName.trim()
    const problem = customMcpProblem({
      name,
      transport,
      source,
      existing: formTargets.includes(provider)
        ? mcpNamesInScope(snapshot?.items ?? [], shownScope)
        : [],
    })
    if (problem) throw new Error(problem)
    const mcp =
      transport === 'http'
        ? { type: 'http' as const, url: source.trim() }
        : {
            type: 'stdio' as const,
            command: source.trim(),
            args: parseCommandArguments(args),
            env: parseEnvironmentVariables(environment),
          }
    if (mcp.type === 'stdio') {
      const filled = fillCuratedPlaceholders(mcp.args, mcp.env, curatedValues)
      mcp.args = filled.args
      mcp.env = filled.env
      const pending = unresolvedInstallPlaceholders(mcp.args, mcp.env)
      if (pending.length)
        throw new Error(
          `${pending.join('、')} 还没换成真实内容，请先填好再添加。`,
        )
    }
    const advanced = {
      ...(bearerEnv ? { bearerTokenEnvVar: bearerEnv.trim() } : {}),
      ...(oauthClient && !oauthUnavailable ? { oauthClientId: oauthClient.trim() } : {}),
      ...(oauthResource && !oauthUnavailable ? { oauthResource: oauthResource.trim() } : {}),
    }
    const done: Provider[] = []
    try {
      for (const target of formTargets) {
        await submitMcpInstall(api, target, name, mcp, shownScope, advanced)
        done.push(target)
      }
    } finally {
      // 一个工具没加上就停在那里：已经加上的从勾选里拿掉，改好再点一次只补剩下的，不会在加过的工具上撞名。
      if (done.length && done.length < formTargets.length) {
        setFormTools(formTargets.filter((target) => !done.includes(target)))
        await reloadList()
      }
    }
    return { name, tools: done }
  }
  const add = (trusted = false) => {
    // 来源空着照旧在表单里报「请填写来源」，不先弹一个没有来源的确认框。
    if (!trusted && form === 'add' && extensionInstallNeedsTrust(provider, kind) && source.trim()) {
      operation.clear()
      setTrusting(true)
      return
    }
    void operation.execute(
      'add',
      async () => {
        if (kind === 'mcp' && form !== 'market') {
          const added = await addMcp()
          setForm(null)
          await reloadList()
          return added
        }
        if (!source.trim()) throw new Error('请填写来源。')
        if (form === 'market')
          await api.addMarketplace({ source: source.trim() })
        else if (kind === 'skill' && provider === 'codex')
          await api.importSkill({
            sourcePath: source.trim(),
            scope: formScope === 'project' ? 'repo' : 'user',
          })
        else if (kind === 'plugin' && provider === 'codex')
          await api.addPlugin(source.trim())
        else
          await api.mutateProviderExtension({
            provider,
            kind,
            action: 'install',
            source: source.trim(),
            scope: shownScope,
            ...(trusted ? { trust: true } : {}),
          })
        setTrusting(false)
        setForm(null)
        await reloadList()
        return null
      },
      (added) =>
        added
          ? `已添加「${added.name}」，给 ${extensionToolNames(added.tools, codexViaDesktop)} 使用，下次打开工具时生效`
          : '已添加，列表已更新',
    )
  }
  const addButton = (
    <Button
      variant={kind === 'plugin' ? 'primary' : 'secondary'}
      icon={kind === 'skill' ? FolderOpen : Plus}
      disabled={missing || !supportsInstall || capability?.list === false || Boolean(operation.busy)}
      title={supportsInstall ? undefined : `${toolName} 不支持在这里导入`}
      onClick={showForm}
      testId={`${page}-add`}
    >
      {kind === 'mcp' ? '自定义连接' : kind === 'skill' ? '从文件夹导入' : '添加插件'}
    </Button>
  )
  const marketplace = officialMarketplaceNotice(snapshot?.marketplace)
  // 检测命令跑起来了却没跑完才算「没检测成」；工具本来就不报连接状态的不算，「上次检测」照旧。
  const healthFailed = Boolean(
    health.report?.supported && health.report.reason && !health.checking,
  )
  // 「重新检测」先把列表重新读一遍：在别处加过、删过的连接要先出现在列表里，检测才有对象。
  const recheck = async () => {
    await resource.reload()
    if (shownProvider.current === provider) await health.check()
  }
  // 进页面时替用户自动下的那一次不另弹「已下载」：列表直接出来就是结果。自己点的照旧提示。
  const addOfficialMarketplace = (automatic = false) =>
    void operation.execute(
      'marketplace-ensure',
      async () => {
        await api.ensureProviderMarketplace(provider)
        await reloadList()
      },
      automatic
        ? () => null
        : provider === 'codex'
          ? '插件目录已下载，下面就是可以安装的插件。'
          : '官方插件市场已添加，下面就是可以安装的插件。',
    )
  // Codex 的目录缺了就直接替用户下载，不让他先看一句「还没下载」再去点。每次进到
  // 这一页只自动下一次；失败了留着按钮，由用户换网或开加速后自己再点。
  const codexCatalogAutoTried = useRef(false)
  const codexCatalogMissing =
    kind === 'plugin' &&
    provider === 'codex' &&
    snapshot?.marketplace?.registered === false
  useEffect(() => {
    if (!codexCatalogMissing || codexCatalogAutoTried.current || operation.busy) return
    codexCatalogAutoTried.current = true
    addOfficialMarketplace(true)
  })
  const officialMarketplaceButton = (
    <Button
      variant="primary"
      icon={Plus}
      loading={operation.busy === 'marketplace-ensure'}
      disabled={Boolean(operation.busy)}
      onClick={() => addOfficialMarketplace()}
      testId="plugins-official-marketplace-add"
    >
      {marketplace?.actionLabel ?? '添加官方市场'}
    </Button>
  )
  const headerAction = desktopPlugins ? undefined : (
    <>
      {kind === 'plugin' && provider === 'codex' && (
        <Button
          icon={Plus}
          disabled={missing || Boolean(operation.busy)}
          onClick={() => {
            setSource('')
            setForm('market')
            operation.clear()
          }}
          testId="plugins-market-add"
        >
          添加市场
        </Button>
      )}
      {addButton}
    </>
  )
  const markets = resource.data?.codex?.plugins.marketplaces ?? []
  const filteredMarkets = filterExtensionMarkets(markets, query)
  // 列表真的空着时这一页自己的那句话；没有官方目录的插件页（Grok CLI）照旧用通用的那句。
  const emptyDescription =
    kind === 'mcp'
      ? '装下面「星芒精选」里的，或点右上角「自定义连接」接你自己的。'
      : kind === 'skill'
        ? '点「从文件夹导入」，选一个技能文件夹。'
        : catalogTitle
          ? '从下面的官方目录里挑一个。'
          : undefined
  const renderRow = (item: ExtensionItem) => {
    const nativeMcp = resource.data?.codex?.mcp.find(
      (entry) => entry.name === item.id || entry.name === item.name,
    )
    const rowState = extensionRowState(item, nativeSkillFor(item))
    const { readonly, enabled } = rowState
    const mcpHealth = kind === 'mcp'
      ? mcpHealthView(health.report, item.id, health.checking)
      : null
    const authorized = nativeMcp ? mcpAuthorized(nativeMcp.authStatus) : false
    // 「已授权」「无需登录」不再画，只在真要他去登录时说一句。
    const needsAuth = Boolean(nativeMcp && mcpNeedsLogin(nativeMcp.authStatus))
    const canAuth = Boolean(nativeMcp?.editable && nativeMcp.transportType === 'http')
    const authKey = `auth:${item.id}`
    return (
      <ListRow
        key={`${item.scope ?? ''}:${item.id}`}
        icon={
          kind === 'mcp'
            ? item.source.kind === 'native'
              ? Server
              : Globe
            : kind === 'skill'
              ? Sparkles
              : Package
        }
        title={item.name}
        badge={
          <>
            {needsAuth && <Pill tone="warn">需要登录授权</Pill>}
            {mcpHealth && (
              <Pill
                tone={mcpHealth.tone}
                testId={`mcp-health-${item.id}`}
              >
                {mcpHealth.label}
              </Pill>
            )}
            {extensionShowsUpdatePill(item) && (
              <Pill tone="warn">可更新</Pill>
            )}
            {item.installed && !enabled && <Pill>已停用</Pill>}
          </>
        }
        desc={
          <>
            {item.description}
            <span className="v2-business-path">
              {item.source.locator ||
                item.currentVersion ||
                '来源未提供'}
            </span>
            {mcpHealth?.detail && (
              <span className="v2-business-note">
                {mcpHealth.detail}
              </span>
            )}
          </>
        }
        meta={item.currentVersion || undefined}
        // 市场里没装的那些本来就谈不上启用与否，别把它们画成停用的。
        off={item.installed && !enabled}
        testId={`${page}-row-${item.id}`}
        actions={
          <>
            {/* 行上写着「可更新」，更新就放在行上，不用再去「…」里找；菜单里那项照留。 */}
            {kind !== 'mcp' &&
              item.installed &&
              rowState.canUpdate &&
              item.update.state === 'update-available' && (
                <Button
                  size="sm"
                  icon={RefreshCw}
                  loading={operation.busy === 'update'}
                  disabled={Boolean(operation.busy)}
                  onClick={() => act(item, 'update')}
                  testId={`${page}-update-${item.id}`}
                >
                  更新
                </Button>
              )}
            {nativeMcp && needsAuth && canAuth && (
              <>
                <Button
                  size="sm"
                  loading={operation.busy === authKey}
                  disabled={Boolean(operation.busy)}
                  onClick={() => {
                    authCancel.current = ''
                    setAuthStopping('')
                    void operation.execute(
                      authKey,
                      async () => {
                        const servers = await api.loginMcpServer(nativeMcp.name)
                        await reloadList()
                        return servers
                      },
                      (servers) => {
                        if (authCancel.current !== authKey) return `${item.name} 已授权`
                        // 点取消的那一下，浏览器里也可能刚好授权完了：按登录回来的列表说。
                        const server = servers.find((entry) => entry.name === nativeMcp.name)
                        if (server && mcpAuthorized(server.authStatus)) return `${item.name} 已授权`
                        toast.show(`已取消，${item.name} 还没有授权`, 'neutral')
                        return null
                      },
                    )
                  }}
                  testId={`${page}-auth-${item.id}`}
                >
                  {operation.busy === authKey ? '等你在浏览器里授权' : '登录授权'}
                </Button>
                {/* 不去浏览器里授权的话，原来要干等 3 分钟、整页的按钮都是灰的。取消由主进程停掉登录命令，
                    停下以后那次登录照常回来，不算失败，不弹红条。 */}
                {operation.busy === authKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={X}
                    loading={authStopping === authKey}
                    aria-label={`停止等待 ${item.name} 授权`}
                    onClick={() => {
                      authCancel.current = authKey
                      setAuthStopping(authKey)
                      // 主进程那边已经没有在等的（登录刚好自己结束了）回 false，什么都不用做：那次登录马上自己回来。
                      void api.cancelMcpLogin(nativeMcp.name).catch((cause: unknown) => {
                        authCancel.current = ''
                        setAuthStopping('')
                        toast.show(errorMessage(cause), 'bad')
                      })
                    }}
                    testId={`${page}-auth-cancel-${item.id}`}
                  >
                    {authStopping === authKey ? '正在停止' : '取消'}
                  </Button>
                )}
              </>
            )}
            {!item.installed && item.operations.install && (
              <Button
                size="sm"
                icon={Download}
                loading={operation.busy === 'install'}
                disabled={Boolean(operation.busy)}
                onClick={() => act(item, 'install')}
                testId={`${page}-install-${item.id}`}
              >
                安装
              </Button>
            )}
            {readonly && <span className="v2-ext-row-note">系统自带</span>}
            <Menu
              label={`${item.name} 更多操作`}
              anchor={<MoreHorizontal size={18} />}
              testId={`${page}-menu-${item.id}`}
              items={[
                {
                  label: '查看详情',
                  icon: FileText,
                  onSelect: () => setSelected(item),
                },
                ...(nativeMcp && canAuth && authorized
                  ? [
                      {
                        label: '退出授权',
                        icon: Plug,
                        onSelect: () =>
                          void operation.execute(authKey, async () => {
                            await api.logoutMcpServer(nativeMcp.name)
                            await reloadList()
                          }),
                      },
                    ]
                  : []),
                ...(rowState.canUpdate
                  ? [
                      {
                        label: '更新',
                        icon: RefreshCw,
                        onSelect: () => act(item, 'update'),
                      },
                    ]
                  : []),
                ...(rowState.canUninstall
                  ? [
                      {
                        label: kind === 'plugin' ? '卸载…' : `从 ${toolName} 移除…`,
                        icon: Trash2,
                        danger: true,
                        onSelect: () => setDeletion(item),
                      },
                    ]
                  : []),
              ]}
            />
            {item.installed && rowState.canToggle && (
              <Switch
                aria-label={`${enabled ? '停用' : '启用'} ${item.name}`}
                checked={enabled}
                onChange={() => {
                  if (!operation.busy)
                    act(item, enabled ? 'disable' : 'enable')
                }}
                testId={`${page}-toggle-${item.id}`}
              />
            )}
          </>
        }
      />
    )
  }
  return (
    <section
      className="v2-page v2-ext-page"
      data-page-id={page}
      data-testid={`page-${page}`}
    >
      <PageHead
        title={title}
        lead={
          kind === 'mcp'
            ? '让 AI 用上文件、浏览器、GitHub 这些外部能力。'
            : kind === 'skill'
              ? '教 AI 做好某类事的说明书。'
              : '打包好的功能合集，各家格式不通用。'
        }
        actions={headerAction}
      />
      <div className="v2-ext-tools">
        <Tabs
          items={activeTools.map((tool) => {
            const count = counts[tool.id]
            const toolMissing = usable !== undefined && !usable.includes(tool.id)
            return {
              value: tool.id,
              label: extensionToolName(tool.id, codexViaDesktop),
              leading: (
                <span className="v2-ext-tab-brand" aria-hidden="true">
                  <BrandIcon tool={tool.id} size={18} variant="xs" />
                </span>
              ),
              meta: toolMissing ? (
                <span className="v2-ext-tab-note">未安装</span>
              ) : count === undefined ? undefined : (
                <span className="v2-ext-tab-count">{count}</span>
              ),
            }
          })}
          value={provider}
          onChange={(next) => {
            if (!isProvider(next)) return
            providerTouched.current = true
            setProvider(next)
            setQuery('')
            // 上一个工具的红条不跟到下一个工具上。
            operation.clear()
          }}
          testId={`${page}-tools`}
        />
      </div>
      <div className="v2-ext-official" data-testid={`${page}-official-term`}>
        <span aria-hidden="true">
          <BrandIcon tool={provider} size={18} variant="xs" />
        </span>
        <strong>{`${toolName} 官方叫「${extensionOfficialTerms[kind][provider]}」`}</strong>
      </div>
      {provider === 'codex' && codexDesktopInstalled && installedProviders?.includes('codex') && (
        <div className="v2-skill-import-note" data-testid={`${page}-codex-shared`}>
          <span>Codex 桌面端和 Codex CLI 共用这些设置，在这里加的两边都能用。</span>
        </div>
      )}
      <ResultNotice {...operation} onSupport={onOpenHelp} target={extensionFailureTarget(operation.failed)} />
      {snapshot?.warnings.map((warning) => (
        <Notice
          key={warning}
          tone="warn"
          title="部分信息需要确认"
          body={warning}
        />
      ))}
      {capability?.list === false && (
        <Notice
          tone="warn"
          title="当前工具未提供管理能力"
          body={capability.reason || '请在工具里管理。'}
          testId={`${page}-readonly`}
        />
      )}
      {missing ? (
        <section className="v2-ext-install-bar" data-testid={`${page}-tool-missing`}>
          <Download size={18} aria-hidden="true" />
          <div className="v2-ext-install-copy">
            <strong>{`还没有安装 ${toolName}`}</strong>
            <span>{`装好后就能添加下面的${title}。`}</span>
          </div>
          {installingTool && job ? (
            <div className="v2-ext-install-progress" data-testid={`${page}-tool-installing`}>
              <span>{job.label}</span>
              {typeof job.percent === 'number' && <Progress value={job.percent} />}
            </div>
          ) : installTool ? (
            <Button
              size="sm"
              loading={operation.busy === 'install-tool'}
              disabled={Boolean(operation.busy) || Boolean(job)}
              onClick={installMissingTool}
              testId={`${page}-install-tool`}
            >
              {`安装 ${toolName}`}
            </Button>
          ) : null}
        </section>
      ) : desktopPlugins ? (
        <Notice
          tone="neutral"
          title="插件请在 Codex 桌面端里装"
          body="没装 Codex CLI 时，星芒管不了 Codex 的插件。打开 Codex 桌面端，在它自己的插件页里装、卸载或停用。"
          testId="plugins-codex-desktop"
        />
      ) : (
        <div className="v2-ext-installed">
          <Toolbar
            left={<h2 className="v2-ext-section-title">{`已装到 ${toolName}`}</h2>}
            search={
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder={kind === 'mcp' ? '搜索名称或地址' : '搜索名称或说明'}
                testId={`${page}-search`}
              />
            }
            right={
              <>
                {resource.data && !resource.error && installedItems.length > 0 && (
                  <span>{`共 ${installedItems.length} 个`}</span>
                )}
                {kind === 'mcp' ? (
                  <>
                    {healthFailed ? (
                      <span data-testid="mcp-health-failed">这次没检测成</span>
                    ) : (
                      health.report?.checkedAt &&
                      !health.checking && (
                        <span>上次检测 <RelativeTime value={health.report.checkedAt} /></span>
                      )
                    )}
                    <Button
                      size="sm"
                      icon={RefreshCw}
                      loading={health.checking || resource.loading}
                      disabled={health.checking || resource.loading}
                      onClick={() => void recheck()}
                      testId="mcp-health-recheck"
                    >
                      重新检测
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    icon={RefreshCw}
                    loading={resource.loading}
                    disabled={resource.loading}
                    onClick={() => void resource.reload()}
                    testId={`${page}-reload`}
                  >
                    重新加载
                  </Button>
                )}
              </>
            }
          />
          <Card padding="none" testId={`${page}-list`}>
            <ListState
              page={page}
              noun={title}
              loading={resource.loading}
              error={resource.error}
              count={list.length}
              query={query}
              filtered={Boolean(query)}
              retry={() => void resource.reload()}
              clear={() => setQuery('')}
              emptyTitle={`还没有给 ${toolName} 装${title}`}
              emptyDescription={emptyDescription}
              action={
                kind === 'skill' && !supportsInstall ? (
                  <Button
                    size="sm"
                    icon={RefreshCw}
                    loading={resource.loading}
                    onClick={() => void resource.reload()}
                    testId={`${page}-empty-reload`}
                  >
                    重新加载
                  </Button>
                ) : curatedItems.length > 0 ? (
                  <>
                    {addButton}
                    {/* 和旁边的添加按钮一样大。 */}
                    <Button
                      icon={Sparkles}
                      onClick={seeCurated}
                      testId={`${page}-see-curated`}
                    >
                      看看精选
                    </Button>
                  </>
                ) : (
                  addButton
                )
              }
            >
              {groups.map((group) => (
                <div className="v2-ext-group" key={group.key} data-testid={`${page}-group-${group.key || 'none'}`}>
                  <div className="v2-ext-group-head">
                    <strong>{group.title}</strong>
                    {group.description && <span>{group.description}</span>}
                    <small>{`${group.items.length} 个`}</small>
                  </div>
                  {group.items.map(renderRow)}
                </div>
              ))}
            </ListState>
          </Card>
        </div>
      )}
      {kind === 'skill' && provider === 'codex' && onOpenPlugins && (
        <Notice
          tone="neutral"
          title="OpenAI 的官方技能现在放在插件里"
          body="OpenAI 出品的技能都打包进了插件。"
          actions={
            <Button
              size="sm"
              onClick={() => {
                requestExtensionTool('plugins', 'codex')
                onOpenPlugins()
              }}
              testId="skills-codex-plugins"
            >
              去看插件
            </Button>
          }
          testId="skills-codex-official"
        />
      )}
      {/* 推荐区放在自己的列表下面：读取中、读不到、搜不到都在上面那张卡里，第一屏就看得到。 */}
      {(kind === 'mcp' || kind === 'plugin') && (
        <CuratedShelf
          items={shownCurated}
          toolName={toolName}
          toolMissing={missing}
          disabled={capability?.list === false || Boolean(operation.busy)}
          installedIds={installedIds}
          onPick={setCurated}
        />
      )}
      {kind === 'plugin' && catalogTitle && !missing && !desktopPlugins && (marketplace || catalogItems.length > 0) && (
        <section className="v2-ext-section" data-testid="plugins-catalog">
          <div className="v2-ext-section-head">
            <h2>{catalogTitle}</h2>
          </div>
          {marketplace && (
            <Notice
              tone={marketplace.tone}
              title={marketplace.title}
              body={marketplace.body}
              actions={marketplace.needsAction ? officialMarketplaceButton : undefined}
              testId="plugins-official-marketplace"
            />
          )}
          {catalogItems.length > 0 && (
            <div className="v2-ext-grid">
              {catalogItems.map((item) => (
                <ExtensionCard
                  key={item.id}
                  icon={Package}
                  name={item.name}
                  summary={item.description}
                  footer={
                    item.operations.install ? (
                      <Button
                        size="sm"
                        icon={Download}
                        loading={operation.busy === 'install'}
                        disabled={Boolean(operation.busy)}
                        onClick={() => act(item, 'install')}
                        testId={`plugins-install-${item.id}`}
                      >
                        安装
                      </Button>
                    ) : undefined
                  }
                  testId={`plugins-row-${item.id}`}
                />
              ))}
            </div>
          )}
        </section>
      )}
      {/* 自己加的市场还在，只是退到官方目录下面：这里管的是市场本身（更新、移除），
          市场里的插件已经和官方目录一起列在上面了。 */}
      {kind === 'plugin' && provider === 'codex' && !missing && !desktopPlugins && markets.length > 0 && (
        <Card padding="none" title="自己添加的市场" testId="plugins-custom-markets">
          <ListState
            page="plugins-market"
            noun="市场"
            loading={resource.loading}
            error={resource.error}
            count={filteredMarkets.length}
            query={query}
            filtered={Boolean(query)}
            retry={() => void resource.reload()}
            clear={() => setQuery('')}
          >
            {filteredMarkets.map((market) => (
              <ListRow
                key={market.name}
                icon={Package}
                title={market.name}
                desc={market.root}
                descMono
                actions={
                  <>
                    <Button
                      size="sm"
                      icon={RefreshCw}
                      disabled={Boolean(operation.busy)}
                      onClick={() =>
                        void operation.execute(
                          'market-update',
                          async () => {
                            await api.upgradeMarketplace(market.name)
                            await reloadList()
                          },
                        )
                      }
                    >
                      更新
                    </Button>
                    <Menu
                      label={`市场 ${market.name} 的更多操作`}
                      anchor={<MoreHorizontal size={18} />}
                      items={[
                        {
                          label: '移除市场',
                          icon: Trash2,
                          danger: true,
                          onSelect: () =>
                            void operation.execute(
                              'market-delete',
                              async () => {
                                await api.removeMarketplace(market.name)
                                await reloadList()
                              },
                            ),
                        },
                      ]}
                    />
                  </>
                }
              />
            ))}
          </ListState>
        </Card>
      )}
      {/* 工具没装时上面没有列表，「在上面的列表里管理」就落空了，等装好再说。 */}
      {kind === 'plugin' && !catalogTitle && !missing && (
        <Notice
          tone="neutral"
          title={`${toolName} 没有插件市场`}
          body="它的插件装好后在上面的列表里管理。"
          testId="plugins-market-unavailable"
        />
      )}
      <Dialog
        open={Boolean(form)}
        title={
          form === 'market'
            ? '添加插件市场'
            : kind === 'mcp'
              ? '自定义连接'
              : kind === 'skill'
                ? `给 ${toolName} 导入技能`
                : `给 ${toolName} 添加插件`
        }
        onClose={() => {
          if (!operation.busy) setForm(null)
        }}
        dirty={Boolean(operation.busy)}
        footer={
          <>
            <Button
              onClick={() => setForm(null)}
              disabled={Boolean(operation.busy)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => add()}
              loading={operation.busy === 'add'}
              disabled={kind === 'mcp' && form === 'add' && formTargets.length === 0}
              testId={`${page}-form-submit`}
            >
              添加
            </Button>
          </>
        }
      >
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
        {curatedForm?.inputs.map((input) => (
          <Notice
            key={input.key}
            tone={curatedValues[input.key]?.trim() ? 'ok' : 'warn'}
            title={curatedValues[input.key]?.trim() ? `${input.label}：${curatedValues[input.key]}` : `还缺一样：${input.label}`}
            body={`点「选择文件夹」挑一个，软件会替你填好，不用手改。${input.hint}`}
            testId={`curated-input-${input.key}`}
            actions={
              <Button
                size="sm"
                icon={FolderOpen}
                disabled={Boolean(operation.busy)}
                onClick={() => void operation.execute('choose-directory', async () => {
                  const chosen = await api.chooseExtensionDirectory()
                  if (chosen) setCuratedValues((values) => ({ ...values, [input.key]: chosen }))
                }, () => null)}
                testId={`curated-choose-${input.key}`}
              >
                选择文件夹
              </Button>
            }
          />
        ))}
        {addFormRuntimeNotice && (
          <Notice
            tone="warn"
            title={addFormRuntimeNotice.title}
            body={addFormRuntimeNotice.body}
            testId="mcp-runtime-notice"
            actions={addFormRuntimeNotice.installPython ? (
              <Button
                size="sm"
                icon={Download}
                loading={operation.busy === 'python'}
                disabled={Boolean(operation.busy)}
                onClick={installPython}
                testId="mcp-install-python"
              >
                自动安装 Python
              </Button>
            ) : undefined}
          />
        )}
        {kind === 'mcp' && form === 'add' && (
          <>
            <Input
              label="名称"
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              placeholder="比如：my-database"
              hint="只能用字母、数字和 - _"
              testId="mcp-name"
            />
            <div className="xm-field">
              {/* 读屏从按钮组自己的名字读到它，这里只给眼睛看。 */}
              <label aria-hidden="true">类型</label>
              <Segment
                label="类型"
                options={[
                  { value: 'stdio', label: '本地程序' },
                  { value: 'http', label: '网络服务' },
                ]}
                value={transport}
                onChange={setTransport}
              />
            </div>
          </>
        )}
        <Input
          label={
            form === 'market'
              ? '市场来源'
              : kind === 'mcp'
                ? transport === 'http'
                  ? '服务地址'
                  : '启动命令'
                : kind === 'skill'
                  ? '技能文件夹路径'
                  : '来源'
          }
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder={
            kind === 'mcp' && form === 'add'
              ? transport === 'http'
                ? 'https://example.com/mcp'
                : '比如：从提供方说明里复制的启动命令'
              : undefined
          }
          mono
          testId={`${page}-source`}
        />
        {kind === 'mcp' && form === 'add' && transport === 'stdio' && (
          <details className="v2-ext-more">
            <summary>更多设置</summary>
            <Textarea
              label="附加参数"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              mono
              hint="按提供方说明原样粘贴"
            />
            <Textarea
              label="附加设置"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              mono
              hint="按提供方说明原样粘贴"
            />
          </details>
        )}
        {kind === 'mcp' && form === 'add' && transport === 'http' && formTargets.includes('codex') && (
          <details className="v2-ext-more">
            <summary>高级认证设置</summary>
            <Input
              label="登录信息的名称"
              value={bearerEnv}
              onChange={(event) => setBearerEnv(event.target.value)}
            />
            {!oauthUnavailable && (
              <>
                <Input
                  label="OAuth Client ID"
                  value={oauthClient}
                  onChange={(event) => setOauthClient(event.target.value)}
                />
                <Input
                  label="OAuth Resource"
                  value={oauthResource}
                  onChange={(event) => setOauthResource(event.target.value)}
                />
              </>
            )}
          </details>
        )}
        {form !== 'market' && (
          // 外接工具的弹框照清单加小标题「装到哪里」；技能、插件的弹框只改了标题，下拉照旧不带字。
          <Select
            label={kind === 'mcp' ? '装到哪里' : undefined}
            aria-label={kind === 'mcp' ? undefined : '添加范围'}
            options={[
              { value: 'user', label: '我的（全局）' },
              // Codex 的连接和插件、Grok 的插件只有全局一层；几个工具一起加连接时，勾了 Codex CLI 就不给这一项。
              ...(formOffersProject ? [{ value: 'project', label: '当前项目' }] : []),
            ]}
            value={shownScope}
            onChange={(event) =>
              setFormScope(
                event.target.value === 'project' ? 'project' : 'user',
              )
            }
          />
        )}
        {kind === 'mcp' && form === 'add' && (
          <ExtensionToolPicker
            choices={formChoices}
            selected={formTools}
            disabled={Boolean(operation.busy)}
            onToggle={(id) =>
              setFormTools((current) =>
                current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
              )
            }
            testId="mcp-form-tools"
          />
        )}
      </Dialog>
      <Dialog
        open={Boolean(curated)}
        title={`${curated?.install.type === 'plugin' ? '安装' : '添加'}「${curated?.name ?? ''}」`}
        testId="curated-confirm"
        busy={operation.busy === 'curated'}
        onClose={() => setCurated(null)}
        footer={
          <>
            <Button
              onClick={() => setCurated(null)}
              disabled={operation.busy === 'curated'}
            >
              取消
            </Button>
            <Button
              variant="primary"
              icon={Plus}
              loading={operation.busy === 'curated'}
              onClick={() => {
                if (!curated) return
                if (curatedNeedsInput(curated)) {
                  const item = curated
                  setCurated(null)
                  prefillCurated(item)
                } else installCurated(curated)
              }}
              testId="curated-confirm-submit"
            >
              {curated && curatedNeedsInput(curated)
                ? '继续填写'
                : curated?.install.type === 'plugin'
                  ? '安装'
                  : '添加'}
            </Button>
          </>
        }
      >
        {curated && <CuratedDetails item={curated} />}
        {curatedRuntimeNotice && (
          <Notice
            tone="warn"
            title={curatedRuntimeNotice.title}
            body={curatedRuntimeNotice.body}
            testId="curated-runtime-notice"
            actions={curatedRuntimeNotice.installPython ? (
              <Button
                size="sm"
                icon={Download}
                loading={operation.busy === 'python'}
                disabled={Boolean(operation.busy)}
                onClick={installPython}
                testId="mcp-install-python"
              >
                自动安装 Python
              </Button>
            ) : undefined}
          />
        )}
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
      </Dialog>
      {/* 叠在「添加插件」表单上面：点「先不装」回到表单，填过的来源还在。 */}
      <Dialog
        open={trusting}
        title={`给 ${toolName} 装这个插件？`}
        testId="plugins-trust-confirm"
        busy={operation.busy === 'add'}
        onClose={() => setTrusting(false)}
        footer={
          <>
            <Button
              onClick={() => setTrusting(false)}
              disabled={operation.busy === 'add'}
            >
              先不装
            </Button>
            <Button
              variant="primary"
              icon={Download}
              loading={operation.busy === 'add'}
              onClick={() => add(true)}
              testId="plugins-trust-confirm-submit"
            >
              信任并安装
            </Button>
          </>
        }
      >
        <p>
          插件里带的技能、命令和外接工具，装好后每次打开 {toolName} 都会自动运行，能像你本人一样读写这台电脑上的文件。
        </p>
        <dl className="v2-business-kv">
          <dt>来源</dt>
          <dd>{source.trim()}</dd>
        </dl>
        <p>只装你认识、信得过的来源；拿不准就先别装。</p>
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
      </Dialog>
      <Dialog
        open={Boolean(deletion)}
        title={
          kind === 'plugin'
            ? `卸载「${deletion?.name ?? ''}」？`
            : `从 ${toolName} 移除「${deletion?.name ?? ''}」？`
        }
        onClose={() => setDeletion(null)}
        footer={
          <>
            <Button onClick={() => setDeletion(null)}>取消</Button>
            {/* 只有删除自己在跑才转圈；页面上别的操作（安装、更新、授权……）还没完时按钮灰着，正文下面说一句为什么（#1099 第 3 条）。 */}
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'delete'}
              disabled={Boolean(operation.busy) && operation.busy !== 'delete'}
              onClick={() => {
                if (deletion)
                  void operation.execute(
                    'delete',
                    async () => {
                      await runExtensionAction(
                        api,
                        deletion,
                        'uninstall',
                        nativeSkillFor(deletion),
                      )
                      setDeletion(null)
                      await reloadList()
                    },
                    kind === 'plugin'
                      ? `已卸载「${deletion.name}」`
                      : `已从 ${toolName} 移除「${deletion.name}」`,
                  )
              }}
              testId={`${page}-delete-confirm`}
            >
              {kind === 'plugin' ? '卸载' : '移除'}
            </Button>
          </>
        }
      >
        <p>
          {kind === 'plugin'
            ? '插件里带的技能、命令和外接工具会一起移除。'
            : '其他工具里的不受影响。以后可以在官方目录或精选里重新添加。'}
        </p>
        {operation.busy && operation.busy !== 'delete' && (
          <p role="status" data-testid={`${page}-delete-busy`}>
            {kind === 'plugin'
              ? '上一个操作还没完成，完成后才能卸载。'
              : '上一个操作还没完成，完成后才能移除。'}
          </p>
        )}
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
      </Dialog>
      {/* 详情从抽屉换成弹窗（v4 不用抽屉），testId 沿用。 */}
      <Dialog
        open={Boolean(selected)}
        title={selected?.name ?? '详情'}
        testId="resource-detail-drawer"
        onClose={() => setSelected(null)}
      >
        <dl className="v2-business-kv">
          <dt>工具</dt>
          <dd>{toolName}</dd>
          <dt>范围</dt>
          <dd>{extensionScopeLabel(selected?.scope)}</dd>
          <dt>来源</dt>
          <dd>{selected?.source.locator || '未提供'}</dd>
          <dt>当前版本</dt>
          <dd>{selected?.currentVersion || '未提供'}</dd>
          <dt>更新状态</dt>
          <dd>{selected ? extensionUpdateStatus(selected) : '尚未检查'}</dd>
        </dl>
      </Dialog>
    </section>
  )
}

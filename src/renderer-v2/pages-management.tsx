import { useCallback, useMemo, useState } from 'react'
import {
  Archive,
  Download,
  FileText,
  Globe,
  History,
  MoreHorizontal,
  Package,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  BrandIcon,
  Button,
  Card,
  Dialog,
  Drawer,
  Input,
  ListRow,
  Menu,
  Notice,
  PageHead,
  Pill,
  SearchInput,
  Segment,
  Select,
  Switch,
  Tabs,
  Textarea,
  Toolbar,
} from './ui'
import {
  displayDate,
  errorMessage,
  ListState,
  Pagination,
  ResultNotice,
  useOperation,
  useResource,
} from './business-common'
import { scopeOptions } from './registry/business'
import {
  curatedCommandLines,
  curatedDisclaimer,
  curatedInstallTarget,
  curatedItemsFor,
  curatedNeedsInput,
  curatedNetworkLabels,
  curatedRiskLabels,
  curatedRuntimeLabels,
  type CuratedExtension,
} from './registry/curated-extensions'
import { tools } from './registry/tools'
import { latestSessionIdsByWorkspace } from './features/tools/recent-workspaces'
import type { V2Bridge } from './types'
type Provider = Parameters<V2Bridge['listProviderExtensions']>[0]
type ExtensionSnapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>
type ExtensionItem = ExtensionSnapshot['items'][number]
type ExtensionKind = ExtensionItem['kind']
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
type Session = Awaited<
  ReturnType<V2Bridge['listProviderSessions']>
>['items'][number]
type SessionDetail = Awaited<ReturnType<V2Bridge['getProviderSessionDetail']>>
type Backup = Awaited<ReturnType<V2Bridge['listBackups']>>[number]
type Preview = Awaited<ReturnType<V2Bridge['inspectBackup']>>
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

/**
 * Claude Code 只在自己首次交互式启动时注册官方市场，而本软件一律非交互调用
 * 它，所以没在终端用过的机器上可装清单永远是空的。界面必须能分辨「这里没有
 * 可装的」和「市场还没加进来」，否则用户看到空列表也无从下手。
 */
export function officialMarketplaceNotice(
  marketplace: ExtensionSnapshot['marketplace'],
): { tone: 'neutral' | 'warn'; title: string; body: string; needsAction: boolean } | null {
  if (!marketplace) return null
  if (marketplace.registered) {
    return {
      tone: 'neutral',
      title: '官方插件市场已添加',
      body: '下面是可以安装的插件，安装前确认插件来源。',
      needsAction: false,
    }
  }
  return {
    tone: 'warn',
    title: '还没有添加官方插件市场',
    body:
      marketplace.reason ||
      '添加之后这里才会出现可以安装的插件。添加需要这台电脑上装有 Git。',
    needsAction: true,
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
function isProvider(id: string): id is Provider {
  return ['claude', 'codex', 'gemini', 'grok'].includes(id)
}
const providerOptions = tools
  .filter((tool) => tool.kind === 'cli' && isProvider(tool.id))
  .map((tool) => ({ value: tool.id, label: tool.name }))
function providerName(id: string) {
  return tools.find((tool) => tool.id === id)?.name ?? id
}
function mcpAuthorized(status: string) {
  return ['authenticated', 'logged_in'].includes(status.toLowerCase())
}
function ProviderFilter({
  value,
  onChange,
  all = false,
}: {
  value: string
  onChange: (value: Provider | 'all') => void
  all?: boolean
}) {
  return (
    <Segment
      options={
        all
          ? [{ value: 'all', label: '全部工具' }, ...providerOptions]
          : providerOptions
      }
      value={value}
      onChange={(next) => {
        if (isProvider(next) || (all && next === 'all')) onChange(next)
      }}
    />
  )
}
export function parseCommandArguments(value: string): string[] {
  const result: unknown = JSON.parse(value || '[]')
  if (
    !Array.isArray(result) ||
    !result.every((item): item is string => typeof item === 'string')
  )
    throw new Error('参数需填写为字符串数组，例如 ["-y", "工具包名称"]。')
  return result
}
export function parseEnvironmentVariables(
  value: string,
): Record<string, string> {
  const result: unknown = JSON.parse(value || '{}')
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !Object.entries(result).every(
      ([name, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof entry === 'string',
    )
  )
    throw new Error('环境变量需填写为名称和值均有效的 JSON 对象。')
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

/** 占位符可能落在参数里（本地文件的目录），也可能落在环境变量里（记忆的存放位置）。 */
export function curatedPlaceholderField(
  item: CuratedExtension,
  key: string,
): '参数' | '环境变量' {
  if (
    item.install.type === 'stdio' &&
    Object.values(item.install.env).some((value) =>
      value.includes(`{{${key}}}`),
    )
  )
    return '环境变量'
  return '参数'
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

export function CuratedDetails({ item }: { item: CuratedExtension }) {
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
        <dt>维护者</dt>
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
        <dt>装到哪里</dt>
        <dd>我的（全局），当前这个工具在任何文件夹里打开都能用</dd>
      </dl>
      <p>{item.riskNote}</p>
      {item.note && <p>{item.note}</p>}
      <p>{curatedDisclaimer}</p>
    </div>
  )
}

export function CuratedShelf({
  items,
  disabled,
  installedIds,
  onPick,
}: {
  items: readonly CuratedExtension[]
  disabled?: boolean
  installedIds?: readonly string[]
  onPick: (item: CuratedExtension) => void
}) {
  if (items.length === 0) return null
  return (
    <Card
      title="星芒精选"
      meta={`${items.length} 项`}
      padding="none"
      testId="curated-shelf"
    >
      <p className="v2-curated-lead">
        这几项是我们挑过的，都写清了它能让 AI 多做什么、要拿到什么权限。点「安装」会先让你确认一次。
      </p>
      {items.map((item) => {
        // 已经装上的还给一个「安装」按钮，点下去只会换来一句 CLI 的英文报错。
        const installed = (installedIds ?? []).includes(curatedInstallTarget(item))
        return (
          <ListRow
            key={item.id}
            icon={
              item.install.type === 'plugin'
                ? Package
                : item.install.type === 'http'
                  ? Globe
                  : Server
            }
            title={item.name}
            badge={
              <>
                {installed && <Pill tone="ok">已安装</Pill>}
                {item.requiresAccount && <Pill tone="accent">需要先登录</Pill>}
                {item.risks.map((risk) => (
                  <Pill key={risk} tone="warn">
                    {curatedRiskLabels[risk].label}
                  </Pill>
                ))}
              </>
            }
            desc={item.summary}
            meta={curatedNetworkLabels[item.network] ?? undefined}
            actions={
              installed ? (
                <Pill>已在列表里</Pill>
              ) : (
                <Button
                  size="sm"
                  icon={Plus}
                  disabled={disabled}
                  onClick={() => onPick(item)}
                  testId={`curated-install-${item.id}`}
                >
                  安装
                </Button>
              )
            }
            testId={`curated-row-${item.id}`}
          />
        )
      })}
    </Card>
  )
}
export function SessionsPage({ api }: { api: V2Bridge }) {
  const [provider, setProvider] = useState<Provider | 'all'>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const load = useCallback(
    () =>
      api.listProviderSessions({ provider, search: query, page, pageSize: 20 }),
    [api, provider, query, page],
  )
  const resource = useResource(load)
  // 「接着聊」只能出现在每个(工具 × 目录)组合最近的那一条上,而当前这一页是
  // 过滤加分页之后的切片,判断不出全局最近。所以另取一份不带过滤的最新记录来
  // 定这件事,上限就是主进程允许的一页最大条数;更老的组合不给按钮(宁可少给)。
  const latestLoad = useCallback(
    () => api.listProviderSessions({ provider: 'all', page: 1, pageSize: 100 }),
    [api],
  )
  const latestResource = useResource(latestLoad)
  const resumable = useMemo(
    () => latestSessionIdsByWorkspace(latestResource.data?.items ?? []),
    [latestResource.data],
  )
  const operation = useOperation()
  const [selected, setSelected] = useState<Session | null>(null)
  const detailLoad = useCallback(
    () =>
      selected
        ? api.getProviderSessionDetail(selected.id)
        : Promise.resolve(null),
    [api, selected?.id],
  )
  const detailResource = useResource(detailLoad)
  const detail = detailResource.data
  const view = (session: Session) => {
    setSelected(session)
  }
  const capability = selected
    ? resource.data?.capabilities[selected.provider]
    : undefined
  const archive = () => {
    if (
      !selected ||
      !capability?.operations[selected.archived ? 'restore' : 'archive']
    )
      return
    void operation.execute(
      'archive',
      async () => {
        if (selected.archived) await api.restoreSession(selected.nativeId)
        else await api.archiveSession(selected.nativeId)
        setSelected(null)
        await resource.reload()
      },
      selected.archived ? '会话已恢复' : '会话已归档',
    )
  }
  /**
   * 四家 CLI 的续接参数都是「按当前工作目录找最近一条」,不是按会话 id 挑。
   * 所以按钮只长在每个(工具 × 目录)组合最近的那一条上(resumable),点到的
   * 就是接上的。按会话 id 精确挑选另算一步。归档过的记录已经被移出 CLI
   * 自己的目录,它找不到,所以对归档记录置灰。
   */
  const resume = (session: Session) => {
    if (!resumable.has(session.id) || session.archived) return
    void operation.execute(
      'resume',
      () => api.launchCli(session.provider, session.cwd, 'resumeLast'),
      `已打开${providerName(session.provider)}，接着 ${session.cwd} 里最近的一条对话`,
    )
  }
  return (
    <section
      className="v2-page"
      data-page-id="sessions"
      data-testid="page-sessions"
    >
      <PageHead
        title="记录"
        lead="接着记录所在文件夹里最近的对话继续聊，也可以导出或整理本机记录。"
        actions={
          <Button
            icon={RefreshCw}
            loading={resource.loading}
            onClick={() => void resource.reload()}
          >
            重新加载
          </Button>
        }
      />
      <Toolbar
        left={
          <ProviderFilter
            value={provider}
            all
            onChange={(value) => {
              setProvider(value)
              setPage(1)
            }}
          />
        }
        search={
          <SearchInput
            value={query}
            onChange={(value) => {
              setQuery(value)
              setPage(1)
            }}
            placeholder="搜索标题、文件夹或模型"
            testId="sessions-search"
          />
        }
        right={<span>{resource.data?.total ?? 0} 条记录</span>}
      />
      <ResultNotice {...operation} />
      <Card padding="none">
        <ListState
          page="sessions"
          noun="记录"
          {...resource}
          error={resource.error}
          count={resource.data?.items.length ?? 0}
          filtered={Boolean(query)}
          retry={() => void resource.reload()}
          clear={() => setQuery('')}
        >
          {resource.data?.items.map((session) => (
            <ListRow
              key={session.id}
              title={
                <>
                  <BrandIcon tool={session.provider} size={24} />
                  {session.title || '未命名会话'}
                </>
              }
              badge={session.archived ? <Pill>已归档</Pill> : undefined}
              desc={session.cwd || '未记录文件夹'}
              descMono
              meta={
                <span>
                  {session.model || '未记录模型'} ·{' '}
                  {session.messageCount ?? '未知'} 条 ·{' '}
                  {displayDate(session.updatedAt)}
                </span>
              }
              actions={
                <>
                  {resumable.has(session.id) && !session.archived && (
                    <Button
                      size="sm"
                      icon={Play}
                      disabled={Boolean(operation.busy)}
                      onClick={() => resume(session)}
                      title="接着这个文件夹里最近一次对话"
                      testId={`sessions-resume-${session.id}`}
                    >
                      接着聊
                    </Button>
                  )}
                  <Button
                    size="sm"
                    icon={History}
                    disabled={!session.detailAvailable}
                    onClick={() => view(session)}
                  >
                    查看记录
                  </Button>
                </>
              }
              testId={`sessions-row-${session.id}`}
            />
          ))}
        </ListState>
      </Card>
      <Pagination
        page={page}
        total={resource.data?.total ?? 0}
        onChange={setPage}
      />
      <Drawer
        open={Boolean(selected)}
        title={selected?.title || '记录详情'}
        icon={History}
        onClose={() => {
          setSelected(null)
        }}
        testId="session-detail-drawer"
        footer={
          <>
            <Button
              icon={Download}
              disabled={
                !capability?.operations.exportMarkdown ||
                Boolean(operation.busy)
              }
              onClick={() =>
                selected &&
                void operation.execute(
                  'export',
                  () => api.exportProviderSession(selected.id),
                  (result) =>
                    result
                      ? `已导出 ${result.messages} 条消息：${result.outputPath}${result.truncated ? '；源记录不完整，已在文件中标记' : ''}`
                      : null,
                )
              }
            >
              导出 Markdown
            </Button>
            {selected && resumable.has(selected.id) && !selected.archived && (
              <Button
                icon={Play}
                disabled={Boolean(operation.busy)}
                onClick={() => resume(selected)}
                title="接着这个文件夹里最近一次对话"
                testId="session-detail-resume"
              >
                接着上次对话
              </Button>
            )}
            {capability?.operations[
              selected?.archived ? 'restore' : 'archive'
            ] && (
              <Button
                icon={Archive}
                disabled={Boolean(operation.busy)}
                onClick={archive}
              >
                {selected?.archived ? '恢复记录' : '归档记录'}
              </Button>
            )}
          </>
        }
      >
        <ResultNotice {...operation} />
        {selected && (
          <dl className="v2-business-kv">
            <dt>工具</dt>
            <dd>{providerName(selected.provider)}</dd>
            <dt>工作文件夹</dt>
            <dd>{selected.cwd}</dd>
            <dt>模型</dt>
            <dd>{selected.model || '未记录'}</dd>
          </dl>
        )}
        <ResultNotice error={detailResource.error} />
        {detailResource.error && (
          <Button
            size="sm"
            icon={RefreshCw}
            loading={detailResource.loading}
            onClick={() => void detailResource.reload()}
          >
            重试读取
          </Button>
        )}
        {detailResource.loading ? (
          <p role="status">正在读取对话…</p>
        ) : (
          detail?.messages.map((message, i) => (
            <section className="v2-transcript-message" key={i}>
              <Pill>
                {message.role === 'user'
                  ? '你'
                  : message.role === 'assistant'
                    ? 'AI'
                    : message.role}
              </Pill>
              <p>{message.text}</p>
            </section>
          ))
        )}
        {detail?.messagesTruncated && (
          <Notice
            tone="warn"
            title="已限制预览长度"
            body="完整内容请通过导出记录查看。"
          />
        )}
      </Drawer>
    </section>
  )
}
export function ExtensionsPage({
  api,
  kind,
}: {
  api: V2Bridge
  kind: ExtensionKind
}) {
  const page =
    kind === 'skill' ? 'skills' : kind === 'plugin' ? 'plugins' : 'mcp'
  const title = kind === 'mcp' ? '外接工具' : kind === 'skill' ? '技能' : '插件'
  const [provider, setProvider] = useState<Provider>('claude')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [view, setView] = useState('installed')
  const load = useCallback(
    async () => {
      const snapshot = await api.listProviderExtensions(provider)
      if (provider !== 'codex') return { snapshot, codex: null }

      return {
        snapshot,
        codex: await readCodexExtensionMetadata(api),
      }
    },
    [api, provider],
  )
  const resource = useResource(load)
  const operation = useOperation()
  const [form, setForm] = useState<'add' | 'market' | null>(null)
  const [formName, setFormName] = useState('')
  const [source, setSource] = useState('')
  const [transport, setTransport] = useState('http')
  const [args, setArgs] = useState('[]')
  const [environment, setEnvironment] = useState('{}')
  const [bearerEnv, setBearerEnv] = useState('')
  const [oauthClient, setOauthClient] = useState('')
  const [oauthResource, setOauthResource] = useState('')
  const [formScope, setFormScope] = useState<'user' | 'project'>('user')
  const [deletion, setDeletion] = useState<ExtensionItem | null>(null)
  const [selected, setSelected] = useState<ExtensionItem | null>(null)
  // 待确认的精选条目，以及已经把表单填好、等用户补上路径的那一条。
  const [curated, setCurated] = useState<CuratedExtension | null>(null)
  const [curatedForm, setCuratedForm] = useState<CuratedExtension | null>(null)
  const curatedItems = useMemo(() => curatedItemsFor(kind, provider), [kind, provider])
  const snapshot = resource.data?.snapshot
  const all = extensionItemsForView(
    snapshot?.items ?? [],
    kind,
    view as ExtensionView,
  )
  const list = all.filter(
    (item) =>
      (scope === 'all' || item.scope === scope) &&
      `${item.name} ${item.description} ${item.source.locator ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  )
  // 精选卡用它判断「这条已经装上了」，所以看的是整份快照，而不是被搜索框过滤过的 list。
  const installedIds = (snapshot?.items ?? [])
    .filter((item) => item.kind === kind && item.installed)
    .map((item) => item.id)
  const capability = snapshot?.capabilities[kind]
  const supportsInstall =
    kind !== 'skill' || provider === 'codex' || provider === 'gemini'
  const act = (item: ExtensionItem, action: Mutation['action']) => {
    if (!item.operations[action]) return
    void operation.execute(action, async () => {
      await api.mutateProviderExtension({ provider, kind, action, id: item.id })
      await resource.reload()
    })
  }
  const showForm = () => {
    setFormScope('user')
    setFormName('')
    setSource('')
    setArgs('[]')
    setEnvironment('{}')
    setBearerEnv('')
    setOauthClient('')
    setOauthResource('')
    setCuratedForm(null)
    setForm('add')
    operation.clear()
  }
  // 需要用户自己指定路径的精选条目不直接装，先把表单填好，把该替换的那一项留在参数里。
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
  // 空列表里的「看看精选」把焦点交给精选卡的第一个「安装」，键盘用户不用自己找上去。
  const focusCuratedShelf = () => {
    const target = document.querySelector<HTMLElement>(
      '[data-testid="curated-shelf"] [data-testid^="curated-install-"]',
    )
    target?.scrollIntoView({ block: 'center' })
    target?.focus()
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
        await resource.reload()
      },
      `${item.name} 已添加，可以在下面的列表里看到`,
    )
  const add = () =>
    void operation.execute(
      'add',
      async () => {
        if (!source.trim())
          throw new Error(
            kind === 'mcp' ? '请填写连接地址或本地程序。' : '请填写来源。',
          )
        if (form === 'market')
          await api.addMarketplace({ source: source.trim() })
        else if (kind === 'mcp') {
          if (!formName.trim()) throw new Error('请填写连接名称。')
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
            const pending = unresolvedInstallPlaceholders(mcp.args, mcp.env)
            if (pending.length)
              throw new Error(
                `${pending.join('、')} 还没换成真实内容，请先填好再添加。`,
              )
          }
          await submitMcpInstall(api, provider, formName.trim(), mcp, formScope, {
            ...(bearerEnv ? { bearerTokenEnvVar: bearerEnv.trim() } : {}),
            ...(oauthClient ? { oauthClientId: oauthClient.trim() } : {}),
            ...(oauthResource ? { oauthResource: oauthResource.trim() } : {}),
          })
        } else if (kind === 'skill' && provider === 'codex')
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
            scope: formScope,
          })
        setForm(null)
        await resource.reload()
      },
      '已添加，列表已更新',
    )
  const addButton = (
    <Button
      variant="primary"
      icon={Plus}
      disabled={!supportsInstall || capability?.list === false || Boolean(operation.busy)}
      onClick={showForm}
      testId={`${page}-add`}
    >
      {kind === 'mcp' ? '添加连接' : kind === 'skill' ? '导入技能' : '添加插件'}
    </Button>
  )
  const marketplace = officialMarketplaceNotice(snapshot?.marketplace)
  const officialMarketplacePage =
    kind === 'plugin' && view === 'market' && provider === 'claude'
  const addOfficialMarketplace = () =>
    void operation.execute(
      'marketplace-ensure',
      async () => {
        await api.ensureProviderMarketplace(provider)
        await resource.reload()
      },
      '官方插件市场已添加，下面就是可以安装的插件。',
    )
  const officialMarketplaceButton = (
    <Button
      variant="primary"
      icon={Plus}
      loading={operation.busy === 'marketplace-ensure'}
      disabled={Boolean(operation.busy)}
      onClick={addOfficialMarketplace}
      testId="plugins-official-marketplace-add"
    >
      添加官方市场
    </Button>
  )
  const headerAction =
    kind === 'plugin' && view === 'market' && provider === 'codex' ? (
      <Button
        variant="primary"
        icon={Plus}
        disabled={provider !== 'codex' || Boolean(operation.busy)}
        onClick={() => {
          setSource('')
          setForm('market')
        }}
        testId="plugins-market-add"
      >
        添加市场
      </Button>
    ) : officialMarketplacePage && marketplace?.needsAction ? (
      officialMarketplaceButton
    ) : addButton
  const markets = resource.data?.codex?.plugins.marketplaces ?? []
  const filteredMarkets = filterExtensionMarkets(markets, query)
  return (
    <section
      className="v2-page"
      data-page-id={page}
      data-testid={`page-${page}`}
    >
      <PageHead
        title={title}
        lead={
          kind === 'mcp'
            ? '让 AI 使用浏览器、文件或其他服务。先选工具，再添加它需要的连接。'
            : kind === 'skill'
              ? '把常用做法交给 AI。内置技能随应用维护，也可以添加自己的技能。'
              : '为工具增加能力，安装前确认插件来源。'
        }
        actions={headerAction}
      />
      {kind === 'plugin' && (
        <Tabs
          items={[
            { value: 'installed', label: '已安装' },
            { value: 'market', label: '市场' },
          ]}
          value={view}
          onChange={(next) => {
            setView(next)
            if (next === 'market') setScope('all')
          }}
          testId="plugins-tabs"
        />
      )}
      <Toolbar
        left={
          <ProviderFilter
            value={provider}
            onChange={(value) => {
              if (value !== 'all') {
                setProvider(value)
                setQuery('')
                setScope('all')
              }
            }}
          />
        }
        search={
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={kind === 'mcp' ? '搜索名称或地址' : '搜索名称或说明'}
            testId={`${page}-search`}
          />
        }
        right={
          <span>
            {kind === 'plugin' && view === 'market' && !officialMarketplacePage
              ? filteredMarkets.length
              : list.length}{' '}
            {kind === 'mcp' ? '个连接' : '项'}
          </span>
        }
      />
      {kind !== 'mcp' && !(kind === 'plugin' && view === 'market') && (
        <Segment
          options={scopeOptions}
          value={scope}
          onChange={setScope}
          testId={`${page}-scope`}
        />
      )}
      <ResultNotice {...operation} />
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
      {kind === 'skill' && !supportsInstall && (
        <Notice
          tone="neutral"
          title="当前工具未提供技能导入能力"
          body="请在该工具中管理技能，或切换到 Codex CLI / Gemini CLI。"
        />
      )}
      {/* 插件页的「市场」页签本身就是一整份可装清单，精选只放在「已安装」那一侧。 */}
      {(kind === 'mcp' || (kind === 'plugin' && view === 'installed')) && (
        <CuratedShelf
          items={curatedItems}
          disabled={capability?.list === false || Boolean(operation.busy)}
          installedIds={installedIds}
          onPick={setCurated}
        />
      )}
      {officialMarketplacePage && marketplace && (
        <Notice
          tone={marketplace.tone}
          title={marketplace.title}
          body={marketplace.body}
          actions={marketplace.needsAction ? officialMarketplaceButton : undefined}
          testId="plugins-official-marketplace"
        />
      )}
      {view === 'market' && kind === 'plugin' && !officialMarketplacePage ? (
        <>
          <Card padding="none">
            {provider !== 'codex' ? (
              <Notice
                tone="neutral"
                title="当前工具未提供市场管理接口"
                body="已安装插件仍可在上一页管理。"
              />
            ) : (
              <ListState
                page="plugins-market"
                noun="市场"
                loading={resource.loading}
                error={resource.error}
                count={filteredMarkets.length}
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
                                await resource.reload()
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
                                    await resource.reload()
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
            )}
          </Card>
        </>
      ) : (
        <Card padding="none">
          <ListState
            page={page}
            noun={title}
            loading={resource.loading}
            error={resource.error}
            count={list.length}
            filtered={Boolean(query || scope !== 'all')}
            retry={() => void resource.reload()}
            clear={() => {
              setQuery('')
              setScope('all')
            }}
            action={
              curatedItems.length > 0 ? (
                <>
                  {addButton}
                  <Button
                    size="sm"
                    icon={Sparkles}
                    onClick={focusCuratedShelf}
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
            {list.map((item) => {
              const nativeMcp = resource.data?.codex?.mcp.find(
                (entry) => entry.name === item.id || entry.name === item.name,
              )
              const nativeSkill = resource.data?.codex?.skills.find(
                (entry) => entry.path === item.id || entry.name === item.name,
              )
              const readonly =
                item.scope === 'builtin' || nativeSkill?.managed === true
              const togglable =
                !readonly &&
                item.operations[item.enabled ? 'disable' : 'enable']
              return (
                <ListRow
                  key={item.id}
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
                      {readonly && <Pill tone="accent">系统内置</Pill>}
                      {nativeMcp && (
                        <Pill
                          tone={
                            mcpAuthorized(nativeMcp.authStatus)
                              ? 'ok'
                              : 'neutral'
                          }
                        >
                          {mcpAuthorized(nativeMcp.authStatus)
                            ? '已授权'
                            : nativeMcp.authStatus === 'unsupported'
                              ? '无需登录'
                              : '尚未登录'}
                        </Pill>
                      )}
                      {item.update.state === 'update-available' && (
                        <Pill tone="warn">可更新</Pill>
                      )}
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
                    </>
                  }
                  meta={item.currentVersion || undefined}
                  // 市场里没装的那些本来就谈不上启用与否，别把它们画成停用的。
                  off={item.installed && !item.enabled}
                  testId={`${page}-row-${item.id}`}
                  actions={
                    <>
                      {!item.installed && item.operations.install ? (
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
                      ) : togglable ? (
                        <Switch
                          label={item.enabled ? '已启用' : '已停用'}
                          checked={item.enabled}
                          onChange={() => {
                            if (!operation.busy)
                              act(item, item.enabled ? 'disable' : 'enable')
                          }}
                          testId={`${page}-toggle-${item.id}`}
                        />
                      ) : (
                        <Pill>
                          {readonly
                            ? '只读'
                            : item.enabled
                              ? '已启用'
                              : '已停用'}
                        </Pill>
                      )}
                      <Menu
                        label={`${item.name} 的更多操作`}
                        anchor={<MoreHorizontal size={18} />}
                        testId={`${page}-menu-${item.id}`}
                        items={[
                          {
                            label: '查看详情',
                            icon: FileText,
                            onSelect: () => setSelected(item),
                          },
                          ...(nativeMcp?.editable &&
                          nativeMcp.transportType === 'http'
                            ? [
                                {
                                  label:
                                    mcpAuthorized(nativeMcp.authStatus)
                                      ? '退出授权'
                                      : '登录授权',
                                  icon: Plug,
                                  onSelect: () =>
                                    void operation.execute('auth', async () => {
                                      if (
                                        mcpAuthorized(nativeMcp.authStatus)
                                      )
                                        await api.logoutMcpServer(
                                          nativeMcp.name,
                                        )
                                      else
                                        await api.loginMcpServer(nativeMcp.name)
                                      await resource.reload()
                                    }),
                                },
                              ]
                            : []),
                          ...(item.operations.update && !readonly
                            ? [
                                {
                                  label: '更新',
                                  icon: RefreshCw,
                                  onSelect: () => act(item, 'update'),
                                },
                              ]
                            : []),
                          ...(item.operations.uninstall && !readonly
                            ? [
                                {
                                  label: '移除',
                                  icon: Trash2,
                                  danger: true,
                                  onSelect: () => setDeletion(item),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </>
                  }
                />
              )
            })}
          </ListState>
        </Card>
      )}
      <Dialog
        open={Boolean(form)}
        title={
          form === 'market'
            ? '添加插件市场'
            : kind === 'mcp'
              ? '添加连接'
              : kind === 'skill'
                ? '导入技能'
                : '添加插件'
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
              onClick={add}
              loading={operation.busy === 'add'}
              testId={`${page}-form-submit`}
            >
              添加
            </Button>
          </>
        }
      >
        <ResultNotice error={operation.error} />
        {curatedForm?.inputs.map((input) => (
          <Notice
            key={input.key}
            tone="warn"
            title={`还缺一样：${input.label}`}
            body={`请把下面「${curatedPlaceholderField(curatedForm, input.key)}」里的 {{${input.key}}} 换成${input.label}的完整路径。${input.hint}`}
            testId={`curated-input-${input.key}`}
          />
        ))}
        {kind === 'mcp' && (
          <>
            <Input
              label="连接名称"
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              testId="mcp-name"
            />
            <Segment
              options={[
                { value: 'http', label: '网络服务' },
                { value: 'stdio', label: '本地程序' },
              ]}
              value={transport}
              onChange={setTransport}
            />
          </>
        )}
        <Input
          label={
            form === 'market'
              ? '市场来源'
              : kind === 'mcp'
                ? transport === 'http'
                  ? '服务地址'
                  : '本地程序'
                : provider === 'codex' && kind === 'skill'
                  ? '技能文件夹路径'
                  : '来源'
          }
          value={source}
          onChange={(event) => setSource(event.target.value)}
          mono
          testId={`${page}-source`}
        />
        {kind === 'mcp' && transport === 'stdio' && (
          <>
            <Textarea
              label="参数"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              mono
              hint="使用 JSON 字符串数组，路径作为单独一项。"
            />
            <Textarea
              label="环境变量"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              mono
              hint={'使用 JSON 对象，例如 {"NAME": "value"}。'}
            />
          </>
        )}
        {kind === 'mcp' && transport === 'http' && provider === 'codex' && (
          <details>
            <summary>高级认证设置</summary>
            <Input
              label="认证令牌环境变量名"
              value={bearerEnv}
              onChange={(event) => setBearerEnv(event.target.value)}
            />
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
          </details>
        )}
        {form !== 'market' && (
          <Select
            aria-label="添加范围"
            options={[
              { value: 'user', label: '我的（全局）' },
              ...(provider === 'codex' && kind !== 'skill'
                ? []
                : [{ value: 'project', label: '当前项目' }]),
            ]}
            value={formScope}
            onChange={(event) =>
              setFormScope(
                event.target.value === 'project' ? 'project' : 'user',
              )
            }
          />
        )}
      </Dialog>
      <Dialog
        open={Boolean(curated)}
        title={`装上「${curated?.name ?? ''}」？`}
        icon={Sparkles}
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
              {curated && curatedNeedsInput(curated) ? '继续填写' : '确认安装'}
            </Button>
          </>
        }
      >
        {curated && <CuratedDetails item={curated} />}
        <ResultNotice error={operation.error} />
      </Dialog>
      <Dialog
        open={Boolean(deletion)}
        title={`移除${deletion?.name ?? ''}？`}
        onClose={() => setDeletion(null)}
        footer={
          <>
            <Button onClick={() => setDeletion(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={Boolean(operation.busy)}
              onClick={() => {
                if (deletion)
                  void operation.execute(
                    'delete',
                    async () => {
                      await api.mutateProviderExtension({
                        provider,
                        kind,
                        action: 'uninstall',
                        id: deletion.id,
                      })
                      setDeletion(null)
                      await resource.reload()
                    },
                    '已移除',
                  )
              }}
            >
              确认移除
            </Button>
          </>
        }
      >
        <p>此操作会从当前工具中移除该项。需要时可从原来源重新添加。</p>
        <ResultNotice error={operation.error} />
      </Dialog>
      <Drawer
        open={Boolean(selected)}
        title={selected?.name ?? '详情'}
        testId="resource-detail-drawer"
        onClose={() => setSelected(null)}
      >
        <dl className="v2-business-kv">
          <dt>工具</dt>
          <dd>{providerName(provider)}</dd>
          <dt>范围</dt>
          <dd>{selected?.scope || '未提供'}</dd>
          <dt>来源</dt>
          <dd>{selected?.source.locator || '未提供'}</dd>
          <dt>当前版本</dt>
          <dd>{selected?.currentVersion || '未提供'}</dd>
          <dt>更新状态</dt>
          <dd>{selected?.update.reason || '尚未检查'}</dd>
        </dl>
      </Drawer>
    </section>
  )
}
export function BackupsPage({ api }: { api: V2Bridge }) {
  const load = useCallback(() => api.listBackups(), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const [provider, setProvider] = useState<Provider | 'all'>('all')
  const [backupProvider, setBackupProvider] = useState<Provider>('claude')
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [restore, setRestore] = useState(false)
  const [deletion, setDeletion] = useState<Backup | null>(null)
  const list = useMemo(
    () =>
      resource.data?.filter(
        (item) =>
          (provider === 'all' || item.provider === provider) &&
          `${item.id} ${item.createdAt}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ) ?? [],
    [resource.data, provider, query],
  )
  const inspect = (backup: Backup) =>
    void operation.execute(
      'inspect',
      async () => {
        setPreview(await api.inspectBackup(backup.id))
      },
      '',
    )
  const create = () =>
    void operation.execute(
      'create',
      async () => {
        await api.createBackup(backupProvider)
        await resource.reload()
      },
      '备份已保存到本机',
    )
  return (
    <section
      className="v2-page"
      data-page-id="backups"
      data-testid="page-backups"
    >
      <PageHead
        title="备份"
        lead="修改配置前留一份，恢复时先确认工具和文件范围。"
        actions={
          <Button
            icon={RefreshCw}
            loading={resource.loading}
            onClick={() => void resource.reload()}
          >
            重新加载
          </Button>
        }
      />
      <Toolbar
        left={<ProviderFilter value={provider} all onChange={setProvider} />}
        search={
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="搜索日期或备份编号"
            testId="backups-search"
          />
        }
        right={<span>{list.length} 份备份</span>}
      />
      <ResultNotice {...operation} />
      <div className="v2-business-backup-grid">
        <Card padding="none">
          <ListState
            page="backups"
            noun="备份"
            loading={resource.loading}
            error={resource.error}
            count={list.length}
            filtered={Boolean(query)}
            retry={() => void resource.reload()}
            clear={() => setQuery('')}
            action={
              <Button icon={Archive} onClick={create}>
                创建第一份备份
              </Button>
            }
          >
            {list.map((backup) => (
              <ListRow
                key={backup.id}
                title={
                  <>
                    <BrandIcon tool={backup.provider ?? ''} size={24} />
                    {backup.provider
                      ? providerName(backup.provider)
                      : '无法识别的备份'}
                  </>
                }
                desc={displayDate(backup.createdAt)}
                badge={
                  <Pill tone={backup.valid ? 'neutral' : 'bad'}>
                    {backup.valid
                      ? backup.reason === 'manual'
                        ? '手工备份'
                        : backup.reason === 'pre-restore'
                          ? '恢复前备份'
                          : '配置前备份'
                      : '校验失败'}
                  </Pill>
                }
                meta={`${backup.fileCount} 个文件 · ${(backup.totalSize / 1024).toFixed(1)} KB`}
                actions={
                  <>
                    <Button
                      size="sm"
                      icon={FileText}
                      onClick={() => inspect(backup)}
                    >
                      预览
                    </Button>
                    <Menu
                      label={`${backup.provider ? providerName(backup.provider) : '无法识别的备份'} 的备份更多操作`}
                      anchor={<MoreHorizontal size={18} />}
                      items={[
                        {
                          label: '删除备份',
                          icon: Trash2,
                          danger: true,
                          onSelect: () => setDeletion(backup),
                        },
                      ]}
                    />
                  </>
                }
                testId={`backups-row-${backup.id}`}
              />
            ))}
          </ListState>
        </Card>
        <aside>
          <Card title="马上备份">
            <Select
              aria-label="选择备份工具"
              options={providerOptions}
              value={backupProvider}
              onChange={(event) => {
                if (isProvider(event.target.value))
                  setBackupProvider(event.target.value)
              }}
            />
            <p>备份保存在本机，可能包含配置凭据。请妥善保管。</p>
            <Button
              variant="primary"
              icon={Archive}
              loading={operation.busy === 'create'}
              onClick={create}
              testId="backups-create"
            >
              创建备份
            </Button>
          </Card>
        </aside>
      </div>
      <Drawer
        open={Boolean(preview)}
        title="备份预览"
        icon={Archive}
        onClose={() => setPreview(null)}
        testId="backup-preview-drawer"
        footer={
          <Button
            variant="primary"
            icon={RefreshCw}
            disabled={!preview?.valid}
            onClick={() => setRestore(true)}
          >
            恢复这份配置
          </Button>
        }
      >
        {preview && (
          <>
            <dl className="v2-business-kv">
              <dt>工具</dt>
              <dd>{providerName(preview.provider ?? '')}</dd>
              <dt>时间</dt>
              <dd>{displayDate(preview.createdAt)}</dd>
              <dt>校验</dt>
              <dd>{preview.valid ? '已通过' : preview.error}</dd>
            </dl>
            {preview.files.map((file) => (
              <ListRow
                key={file.targetRelativePath}
                icon={FileText}
                title={file.targetRelativePath}
                desc={
                  file.existed
                    ? `${file.size} 字节`
                    : '原来不存在，恢复后将移除该文件'
                }
              />
            ))}
          </>
        )}
      </Drawer>
      <Dialog
        open={restore}
        title="确认恢复配置？"
        onClose={() => setRestore(false)}
        footer={
          <>
            <Button onClick={() => setRestore(false)}>取消</Button>
            <Button
              variant="primary"
              icon={RefreshCw}
              loading={operation.busy === 'restore'}
              onClick={() => {
                if (preview)
                  void operation.execute(
                    'restore',
                    async () => {
                      const result = await api.restoreBackup(preview.id)
                      setRestore(false)
                      setPreview(null)
                      await resource.reload()
                      if (!result.preRestoreBackupId)
                        throw new Error(
                          '恢复结果缺少恢复前备份信息，请查看反馈日志。',
                        )
                    },
                    '配置已恢复，恢复前备份已保留',
                  )
              }}
            >
              备份当前配置并恢复
            </Button>
          </>
        }
      >
        <p>仅恢复预览中列出的工具配置。正在运行的工具需要重新打开后生效。</p>
        <ResultNotice error={operation.error} />
      </Dialog>
      <Dialog
        open={Boolean(deletion)}
        title="删除这份备份？"
        onClose={() => setDeletion(null)}
        footer={
          <>
            <Button onClick={() => setDeletion(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'delete'}
              onClick={() => {
                if (deletion)
                  void operation.execute(
                    'delete',
                    async () => {
                      await api.deleteBackup(deletion.id)
                      setDeletion(null)
                      await resource.reload()
                    },
                    '备份已删除',
                  )
              }}
            >
              删除备份
            </Button>
          </>
        }
      >
        <p>当前工具配置不受影响。这份备份删除后无法恢复。</p>
        <ResultNotice error={operation.error} />
      </Dialog>
    </section>
  )
}

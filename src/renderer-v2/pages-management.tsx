import { useCallback, useMemo, useState } from 'react'
import {
  Archive,
  Download,
  FileText,
  Globe,
  History,
  MoreHorizontal,
  Package,
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
import { mcpQuickLinks, scopeOptions } from './registry/business'
import { tools } from './registry/tools'
import type { V2Bridge } from './types'
type Provider = Parameters<V2Bridge['listProviderExtensions']>[0]
type ExtensionSnapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>
type ExtensionItem = ExtensionSnapshot['items'][number]
type ExtensionKind = ExtensionItem['kind']
type Mutation = Parameters<V2Bridge['mutateProviderExtension']>[0]
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
const isProvider = (id: string): id is Provider =>
  ['claude', 'codex', 'gemini', 'grok'].includes(id)
const providerOptions = tools
  .filter((tool) => tool.kind === 'cli' && isProvider(tool.id))
  .map((tool) => ({ value: tool.id, label: tool.name }))
const providerName = (id: string) =>
  tools.find((tool) => tool.id === id)?.name ?? id
const mcpAuthorized = (status: string) => ['authenticated', 'logged_in'].includes(status.toLowerCase())
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
  return (
    <section
      className="v2-page"
      data-page-id="sessions"
      data-testid="page-sessions"
    >
      <PageHead
        title="记录"
        lead="继续之前的对话，也可以导出或整理本机记录。"
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
                <Button
                  size="sm"
                  icon={History}
                  disabled={!session.detailAvailable}
                  onClick={() => view(session)}
                >
                  查看记录
                </Button>
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
                  '导出操作已结束',
                )
              }
            >
              导出 Markdown
            </Button>
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
    setForm('add')
    operation.clear()
  }
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
          if (provider === 'codex') {
            if (mcp.type === 'http')
              await api.addMcpServer({
                name: formName.trim(),
                ...mcp,
                ...(bearerEnv ? { bearerTokenEnvVar: bearerEnv.trim() } : {}),
                ...(oauthClient ? { oauthClientId: oauthClient.trim() } : {}),
                ...(oauthResource
                  ? { oauthResource: oauthResource.trim() }
                  : {}),
              })
            else await api.addMcpServer({ name: formName.trim(), ...mcp })
          } else
            await api.mutateProviderExtension({
              provider,
              kind,
              action: 'install',
              id: formName.trim(),
              scope: formScope,
              mcp,
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
            {kind === 'plugin' && view === 'market'
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
      {kind === 'mcp' && (
        <div className="v2-business-suggestions">
          <span>常用连接：</span>
          {mcpQuickLinks.map((quick) => (
            <Button
              size="sm"
              icon={Plus}
              key={quick.id}
              disabled={capability?.list === false}
              onClick={() => {
                showForm()
                setFormName(quick.id)
                setTransport('url' in quick ? 'http' : 'stdio')
                setSource(('url' in quick ? quick.url : quick.command) ?? '')
                setArgs(('args' in quick ? quick.args : '[]') ?? '[]')
              }}
              testId={`mcp-quick-${quick.id}`}
            >
              {quick.name}
            </Button>
          ))}
        </div>
      )}
      {view === 'market' && kind === 'plugin' ? (
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
            action={addButton}
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
                  off={!item.enabled}
                  testId={`${page}-row-${item.id}`}
                  actions={
                    <>
                      {togglable ? (
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

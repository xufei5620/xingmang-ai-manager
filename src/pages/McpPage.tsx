import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Cable,
  Eye,
  Globe2,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../components/Dialog'
import { errorMessage } from '../error-message'
import {
  managementProviderLabels,
  ProviderTabs,
} from '../components/ProviderTabs'
import { createLatestRequestTracker } from '../latest-request'
import { managementProviderIds } from '../provider-registry'
import type { ExtensionSnapshot, ProviderId } from '../types'
import { Button } from '../components/ui'
import { useNavigationState } from '../components/shell/NavigationState'
import { ResourceDetails, type ResourceDetailsValue } from './ResourceDetails'
import '../styles/management-v3.css'

type ProviderExtensionItem = ExtensionSnapshot['items'][number]

export interface McpServerView {
  name: string
  enabled: boolean
  disabledReason: string | null
  transportType: 'stdio' | 'http'
  command: string | null
  args: string[]
  cwd: string | null
  url: string | null
  envNames: string[]
  inheritedEnvNames: string[]
  httpHeaderNames: string[]
  inheritedHttpHeaderNames: string[]
  bearerTokenEnvVar: string | null
  startupTimeoutSec: number | null
  toolTimeoutSec: number | null
  authStatus: string
  origin: 'user' | 'plugin' | 'system'
  editable: boolean
}

export type McpCreateRequest =
  | {
      type: 'stdio'
      name: string
      command: string
      args: string[]
      env: Record<string, string>
    }
  | {
      type: 'http'
      name: string
      url: string
      bearerTokenEnvVar?: string
      oauthClientId?: string
      oauthResource?: string
    }

export interface McpPageProps {
  servers: readonly McpServerView[]
  loading: boolean
  error?: string | null
  onRefresh: () => Promise<void>
  onAdd: (request: McpCreateRequest) => Promise<void>
  onRemove: (name: string) => Promise<void>
  onLogin: (name: string) => Promise<void>
  onLogout: (name: string) => Promise<void>
}

function originLabel(origin: McpServerView['origin']): string {
  if (origin === 'user') return '用户配置'
  if (origin === 'plugin') return 'Plugin 提供'
  return '系统提供'
}

function transportSummary(server: McpServerView): string {
  if (server.transportType === 'http') return server.url ?? 'HTTP MCP'
  return [server.command, ...server.args].filter(Boolean).join(' ')
}

function parseEnvLines(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`环境变量格式无效：${line}`)
    result[line.slice(0, separator).trim()] = line.slice(separator + 1)
  }
  return result
}

function AddMcpDialog({
  provider,
  busy,
  onSubmit,
  onCancel,
}: {
  provider: ProviderId
  busy: boolean
  onSubmit: (request: McpCreateRequest) => Promise<void>
  onCancel: () => void
}) {
  const [type, setType] = useState<'stdio' | 'http'>('http')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [bearerTokenEnvVar, setBearerTokenEnvVar] = useState('')
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthResource, setOauthResource] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFormError(null)
    try {
      if (type === 'stdio') {
        await onSubmit({
          type,
          name: name.trim(),
          command: command.trim(),
          args: args.split(/\r?\n/).filter((entry) => entry.length > 0),
          env: parseEnvLines(env),
        })
      } else {
        await onSubmit({
          type,
          name: name.trim(),
          url: url.trim(),
          bearerTokenEnvVar: bearerTokenEnvVar.trim() || undefined,
          oauthClientId: oauthClientId.trim() || undefined,
          oauthResource: oauthResource.trim() || undefined,
        })
      }
    } catch (error) {
      setFormError(errorMessage(error))
    }
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={busy ? () => undefined : onCancel}>
      <form className="extension-dialog" onSubmit={submit} {...dialogAriaProps('add-mcp-title')}>
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon"><Cable size={19} /></span>
            <div><h2 id="add-mcp-title">添加连接</h2><small>{managementProviderLabels[provider]}</small></div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onCancel} disabled={busy}>
            <X size={17} />
          </button>
        </header>

        <div className="extension-dialog-body">
          <div className="segmented-control" role="group" aria-label="传输方式">
            <button type="button" className={type === 'http' ? 'active' : ''} onClick={() => setType('http')}>
              <Globe2 size={15} /> HTTP
            </button>
            <button type="button" className={type === 'stdio' ? 'active' : ''} onClick={() => setType('stdio')}>
              <Server size={15} /> stdio
            </button>
          </div>

          <label className="field extension-field">
            <span>名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="my_mcp" required />
          </label>

          {type === 'http' ? (
            <>
              <label className="field extension-field">
                <span>服务 URL</span>
                <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" required />
              </label>
              {provider === 'codex' && (
                <>
                  <div className="extension-field-grid">
                    <label className="field extension-field">
                      <span>Bearer Token 环境变量</span>
                      <input value={bearerTokenEnvVar} onChange={(event) => setBearerTokenEnvVar(event.target.value)} placeholder="MCP_TOKEN" />
                    </label>
                    <label className="field extension-field">
                      <span>OAuth Client ID</span>
                      <input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} />
                    </label>
                  </div>
                  <label className="field extension-field">
                    <span>OAuth Resource</span>
                    <input value={oauthResource} onChange={(event) => setOauthResource(event.target.value)} />
                  </label>
                </>
              )}
            </>
          ) : (
            <>
              <label className="field extension-field">
                <span>启动命令</span>
                <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="node" required />
              </label>
              <div className="extension-field-grid">
                <label className="field extension-field">
                  <span>参数（每行一项）</span>
                  <textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={4} placeholder={'server.mjs\n--port=3000'} />
                </label>
                <label className="field extension-field">
                  <span>环境变量（KEY=VALUE）</span>
                  <textarea value={env} onChange={(event) => setEnv(event.target.value)} rows={4} placeholder={'API_TOKEN=...\nMODE=production'} />
                </label>
              </div>
            </>
          )}
          {formError && <div className="extension-error" role="alert">{formError}</div>}
        </div>

        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" type="submit" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} 添加服务
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}

function RemoveDialog({ name, provider, busy, onConfirm, onCancel }: {
  name: string
  provider: ProviderId
  busy: boolean
  onConfirm: () => Promise<void>
  onCancel: () => void
}) {
  const [confirmError, setConfirmError] = useState<string | null>(null)

  const confirm = async () => {
    setConfirmError(null)
    try {
      await onConfirm()
    } catch (error) {
      setConfirmError(errorMessage(error))
    }
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={busy ? () => undefined : onCancel}>
      <section className="extension-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-mcp-title">
        <span className="extension-confirm-icon danger"><Trash2 size={20} /></span>
        <h2 id="remove-mcp-title">删除 {name}</h2>
        <p>该操作会从 {managementProviderLabels[provider]} 配置中移除此 MCP 服务。</p>
        {confirmError && <div className="extension-error extension-confirm-error" role="alert">{confirmError}</div>}
        <div className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="danger-button" type="button" onClick={() => void confirm()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} 确认删除
          </button>
        </div>
      </section>
    </DialogBackdrop>
  )
}

function updateLabel(item: ProviderExtensionItem): string {
  switch (item.update.state) {
    case 'update-available': return '可更新'
    case 'up-to-date': return '已是最新'
    case 'check-failed': return '检测失败'
    case 'source-unknown': return '来源未知'
    case 'unsupported': return '不支持检测'
  }
}

function updateBadgeClass(item: ProviderExtensionItem): string {
  if (item.update.state === 'up-to-date' || item.update.state === 'update-available') return 'success'
  return 'muted'
}

function sourceLabel(item: ProviderExtensionItem): string {
  if (item.source.kind === 'source-unknown') return '来源未知'
  return item.source.kind.toUpperCase()
}

export function McpPage({
  servers,
  loading,
  error,
  onRefresh,
  onAdd,
  onRemove,
  onLogin,
  onLogout,
}: McpPageProps) {
  const [provider, setProvider] = useNavigationState<ProviderId>('mcp.provider', 'codex')
  const [providerSnapshots, setProviderSnapshots] = useState<Partial<Record<ProviderId, ExtensionSnapshot>>>({})
  const [providerErrors, setProviderErrors] = useState<Partial<Record<ProviderId, string>>>({})
  const [loadingProviders, setLoadingProviders] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [query, setQuery] = useNavigationState('mcp.query', '')
  const [details, setDetails] = useState<ResourceDetailsValue | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ name: string; item?: ProviderExtensionItem } | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const providerRequests = useRef(createLatestRequestTracker<ProviderId>()).current

  const loadProvider = useCallback(async (target: ProviderId) => {
    const requestId = providerRequests.begin(target)
    setLoadingProviders((current) => ({ ...current, [target]: true }))
    setProviderErrors((current) => ({ ...current, [target]: undefined }))
    try {
      const snapshot = await window.xingmang.listProviderExtensions(target)
      if (providerRequests.isCurrent(target, requestId)) {
        setProviderSnapshots((current) => ({ ...current, [target]: snapshot }))
      }
    } catch (nextError) {
      if (providerRequests.isCurrent(target, requestId)) {
        setProviderErrors((current) => ({
          ...current,
          [target]: errorMessage(nextError),
        }))
      }
    } finally {
      if (providerRequests.isCurrent(target, requestId)) {
        setLoadingProviders((current) => ({ ...current, [target]: false }))
      }
    }
  }, [providerRequests])

  useEffect(() => () => providerRequests.invalidateAll(), [providerRequests])

  useEffect(() => {
    if (!providerSnapshots[provider]) void loadProvider(provider)
  }, [loadProvider, provider, providerSnapshots])

  const snapshot = providerSnapshots[provider]
  const providerItems = useMemo(
    () => snapshot?.items.filter((item) => item.kind === 'mcp') ?? [],
    [snapshot],
  )
  const filteredCodex = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return [...servers]
    return servers.filter((server) => (
      server.name.toLowerCase().includes(normalized)
      || transportSummary(server).toLowerCase().includes(normalized)
    ))
  }, [query, servers])
  const filteredProvider = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return providerItems
    return providerItems.filter((item) => [
      item.name,
      item.description,
      item.source.locator ?? '',
      item.currentVersion ?? '',
      item.latestVersion ?? '',
    ].some((value) => value.toLowerCase().includes(normalized)))
  }, [providerItems, query])
  const codexUpdateByName = useMemo(
    () => new Map(providerItems.map((item) => [item.name.toLowerCase(), item])),
    [providerItems],
  )
  const selectedLoading = (provider === 'codex' && loading) || Boolean(loadingProviders[provider])
  const selectedReady = Boolean(snapshot) && !selectedLoading
  const selectedError = provider === 'codex' ? error ?? providerErrors.codex : providerErrors[provider]
  const selectedCount = provider === 'codex' ? servers.length : providerItems.length
  const selectedEnabled = provider === 'codex'
    ? servers.filter((server) => server.enabled).length
    : providerItems.filter((item) => item.enabled).length
  const unavailable = useMemo(() => new Set<ProviderId>(
    managementProviderIds.filter((id) => (
      Boolean(providerErrors[id]) || providerSnapshots[id]?.capabilities.mcp.list === false
    )),
  ), [providerErrors, providerSnapshots])

  const perform = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key)
    setActionError(null)
    try {
      await action()
    } catch (nextError) {
      setActionError(errorMessage(nextError))
      throw nextError
    } finally {
      setBusyKey(null)
    }
  }

  const mutate = async (item: ProviderExtensionItem, action: 'uninstall' | 'enable' | 'disable' | 'update') => {
    const target = provider
    const requestId = providerRequests.begin(target)
    try {
      const next = await window.xingmang.mutateProviderExtension({
        provider: target,
        kind: 'mcp',
        action,
        id: item.id,
        scope: 'user',
      })
      if (providerRequests.isCurrent(target, requestId)) {
        setProviderSnapshots((current) => ({ ...current, [target]: next }))
        setProviderErrors((current) => ({ ...current, [target]: undefined }))
      }
    } finally {
      // begin() 顶掉的在途 loadProvider 不会再执行自己 finally 里的 loading
      // 复位（isCurrent 已假）——不在这里收掉的话该 provider 的加载态卡死，
      // 工具栏被 selectedLoading 永久锁住。isCurrent 守卫保证不会误清更新
      // 的请求自己管理的 loading。
      if (providerRequests.isCurrent(target, requestId)) {
        setLoadingProviders((current) => (current[target] ? { ...current, [target]: false } : current))
      }
    }
  }

  const refresh = provider === 'codex'
    ? async () => { await Promise.all([onRefresh(), loadProvider('codex')]) }
    : () => loadProvider(provider)

  return (
    <div className="page workspace-page management-page management-v3" data-page-id="mcp">
      <header className="page-header workspace-page-header">
        <div>
          <h1>外接工具</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="MCP 工具栏">
          <ProviderTabs
            value={provider}
            onChange={(next) => { setProvider(next); setQuery(''); setActionError(null) }}
            disabled={selectedLoading || busyKey !== null}
            unavailable={unavailable}
            label="选择 MCP Provider"
          />
          <button className="icon-button" type="button" title="刷新" onClick={() => void perform('refresh', refresh).catch(() => undefined)} disabled={selectedLoading || busyKey !== null}>
            <RefreshCw size={18} className={selectedLoading || busyKey === 'refresh' ? 'spin' : ''} />
          </button>
          <button className="primary-button" type="button" onClick={() => setAddOpen(true)} disabled={!selectedReady || busyKey !== null}>
            <Plus size={17} /> 添加连接
          </button>
        </div>
      </header>

      <section className="management-toolbar">
        <label className="management-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或地址" aria-label="搜索 MCP" />
        </label>
        <div className="management-counts">
          <span><i className={`status-dot ${snapshot?.capabilities.mcp.list === false ? '' : 'configured'}`} /> {selectedEnabled} 已启用</span>
          <span>{selectedCount} 个服务</span>
        </div>
      </section>

      {(selectedError || actionError) && <div className="management-error" role="alert"><span>{actionError ?? selectedError}</span><Button size="sm" disabled={selectedLoading || busyKey !== null} onClick={() => void perform('refresh', refresh).catch(() => undefined)}>重试</Button></div>}
      {snapshot?.capabilities.mcp.list === false && (
        <div className="management-error" role="status">{snapshot.capabilities.mcp.reason ?? 'MCP 列表不可用'}</div>
      )}
      {snapshot?.warnings.filter((warning) => warning.includes('MCP')).length ? (
        <div className="management-error" role="status">
          {snapshot.warnings.filter((warning) => warning.includes('MCP')).join('；')}
        </div>
      ) : null}

      <section className="extension-list" aria-busy={selectedLoading}>
        {selectedLoading && selectedCount === 0 ? (
          <div className="workspace-empty"><LoaderCircle className="spin" size={24} /><h2>正在读取外接工具</h2></div>
        ) : provider === 'codex' ? filteredCodex.length ? filteredCodex.map((server) => {
          const authReady = ['authenticated', 'logged_in'].includes(server.authStatus.toLowerCase())
          const updateItem = codexUpdateByName.get(server.name.toLowerCase())
          return (
            <article className="extension-row" key={server.name}>
              <div className={`extension-row-icon ${server.transportType}`}>
                {server.transportType === 'http' ? <Globe2 size={19} /> : <Server size={19} />}
              </div>
              <div className="extension-row-main">
                <div className="extension-row-title">
                  <strong>{server.name}</strong>
                  <span className={`extension-badge ${server.enabled ? 'success' : 'muted'}`}>{server.enabled ? '已启用' : '已停用'}</span>
                  <span className="extension-badge">{originLabel(server.origin)}</span>
                  {updateItem && <span className={`extension-badge ${updateBadgeClass(updateItem)}`} title={updateItem.update.reason}>{updateLabel(updateItem)}</span>}
                </div>
                <div className="extension-row-subtitle" title={transportSummary(server)}>{transportSummary(server)}</div>
                <div className="extension-row-meta">
                  {server.envNames.length > 0 && <span><KeyRound size={13} /> {server.envNames.join('、')}</span>}
                  {server.httpHeaderNames.length > 0 && <span><ShieldCheck size={13} /> {server.httpHeaderNames.join('、')}</span>}
                  <span>{server.transportType === 'http' ? 'HTTP' : 'stdio'}</span>
                  {updateItem?.currentVersion && <span>当前 {updateItem.currentVersion}</span>}
                  {updateItem?.latestVersion && <span>远端 {updateItem.latestVersion}</span>}
                </div>
              </div>
              <div className="extension-row-actions">
                <button className="icon-button compact" type="button" title="查看详情" aria-label={`查看 ${server.name}`} onClick={() => setDetails({ title: server.name, fields: [
                  ['工具', managementProviderLabels[provider]], ['传输方式', server.transportType], ['启动信息', transportSummary(server)], ['来源', originLabel(server.origin)],
                  ['状态', server.enabled ? '已启用' : server.disabledReason || '已停用'], ['工作目录', server.cwd ?? '未指定'], ['环境变量名称', [...server.envNames, ...server.inheritedEnvNames].join('、') || '无'],
                  ['请求头名称', [...server.httpHeaderNames, ...server.inheritedHttpHeaderNames].join('、') || '无'], ['认证状态', server.authStatus],
                ] })}><Eye size={16} /></button>
                {server.transportType === 'http' && (
                  <button className="secondary-button square" type="button" title={authReady ? '退出登录' : 'OAuth 登录'} disabled={busyKey !== null}
                    onClick={() => void perform(`auth:${server.name}`, authReady ? () => onLogout(server.name) : () => onLogin(server.name)).catch(() => undefined)}>
                    {busyKey === `auth:${server.name}` ? <LoaderCircle className="spin" size={16} /> : authReady ? <LogOut size={16} /> : <LogIn size={16} />}
                  </button>
                )}
                {server.editable && (
                  <button className="danger-button square" type="button" title="删除" onClick={() => setRemoveTarget({ name: server.name })} disabled={busyKey !== null}>
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </article>
          )
        }) : (
          <div className="workspace-empty"><Cable size={24} /><h2>{selectedError ? '连接列表暂不可用' : query ? '没有找到这个连接' : '还没有外接工具'}</h2>{query && <Button onClick={() => setQuery('')}>清除筛选</Button>}</div>
        ) : filteredProvider.length ? filteredProvider.map((item) => (
          <article className="extension-row" key={item.id}>
            <div className={`extension-row-icon ${item.description.startsWith('http') ? 'http' : 'stdio'}`}>
              {item.description.startsWith('http') ? <Globe2 size={19} /> : <Server size={19} />}
            </div>
            <div className="extension-row-main">
              <div className="extension-row-title">
                <strong>{item.name}</strong>
                <span className={`extension-badge ${item.enabled ? 'success' : 'muted'}`}>{item.enabled ? '已启用' : '已停用'}</span>
                <span className={`extension-badge ${updateBadgeClass(item)}`} title={item.update.reason}>{updateLabel(item)}</span>
              </div>
              <div className="extension-row-subtitle" title={item.description}>{item.description || '未提供启动信息'}</div>
              <div className="extension-row-meta">
                <span>{sourceLabel(item)}</span>
                {item.currentVersion && <span>当前 {item.currentVersion}</span>}
                {item.latestVersion && <span>远端 {item.latestVersion}</span>}
              </div>
            </div>
            <div className="extension-row-actions">
              <button className="icon-button compact" type="button" title="查看详情" aria-label={`查看 ${item.name}`} onClick={() => setDetails({ title: item.name, fields: [
                ['工具', managementProviderLabels[item.provider]], ['启动信息', item.description], ['来源', item.source.locator ?? sourceLabel(item)], ['范围', item.scope ?? '未提供'],
                ['状态', item.enabled ? '已启用' : '已停用'], ['更新', `${updateLabel(item)}：${item.update.reason}`],
              ] })}><Eye size={16} /></button>
              {item.update.state === 'update-available' && item.operations.update && (
                <button className="secondary-button square" type="button" title="更新" disabled={busyKey !== null}
                  onClick={() => void perform(`update:${item.id}`, () => mutate(item, 'update')).catch(() => undefined)}>
                  {busyKey === `update:${item.id}` ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                </button>
              )}
              {((item.enabled && item.operations.disable) || (!item.enabled && item.operations.enable)) && (
                <button className="secondary-button square" type="button" title={item.enabled ? '停用' : '启用'} disabled={busyKey !== null}
                  onClick={() => void perform(`toggle:${item.id}`, () => mutate(item, item.enabled ? 'disable' : 'enable')).catch(() => undefined)}>
                  {busyKey === `toggle:${item.id}` ? <LoaderCircle className="spin" size={16} /> : <Power size={16} />}
                </button>
              )}
              {item.operations.uninstall && (
                <button className="danger-button square" type="button" title="删除" onClick={() => setRemoveTarget({ name: item.name, item })} disabled={busyKey !== null}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </article>
        )) : (
          <div className="workspace-empty"><Cable size={24} /><h2>{selectedError ? '连接列表暂不可用' : query ? '没有找到这个连接' : '还没有外接工具'}</h2>{query && <Button onClick={() => setQuery('')}>清除筛选</Button>}</div>
        )}
      </section>

      <ResourceDetails value={details} onClose={() => setDetails(null)} />
      {addOpen && (
        <AddMcpDialog
          provider={provider}
          busy={busyKey === 'add'}
          onCancel={() => setAddOpen(false)}
          onSubmit={async (request) => {
            await perform('add', async () => {
              if (provider === 'codex') {
                await onAdd(request)
                await loadProvider('codex')
                return
              }
              const next = await window.xingmang.mutateProviderExtension({
                provider,
                kind: 'mcp',
                action: 'install',
                id: request.name,
                scope: 'user',
                mcp: request.type === 'http'
                  ? { type: 'http', url: request.url }
                  : { type: 'stdio', command: request.command, args: request.args, env: request.env },
              })
              providerRequests.invalidate(provider)
              setProviderSnapshots((current) => ({ ...current, [provider]: next }))
            })
            setAddOpen(false)
          }}
        />
      )}
      {removeTarget && (
        <RemoveDialog
          name={removeTarget.name}
          provider={provider}
          busy={busyKey === `remove:${removeTarget.name}`}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={async () => {
            await perform(`remove:${removeTarget.name}`, async () => {
              if (provider === 'codex') {
                await onRemove(removeTarget.name)
                await loadProvider('codex')
              }
              else if (removeTarget.item) await mutate(removeTarget.item, 'uninstall')
            })
            setRemoveTarget(null)
          }}
        />
      )}
    </div>
  )
}

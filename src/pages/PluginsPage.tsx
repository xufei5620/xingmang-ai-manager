import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Download,
  Eye,
  LoaderCircle,
  PackageOpen,
  Plus,
  RefreshCw,
  Search,
  Store,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../components/Dialog'
import { errorMessage } from '../error-message'
import { ProviderTabs } from '../components/ProviderTabs'
import { createProviderExtensionRequestCoordinator } from '../provider-extension-coordinator'
import type { ExtensionMutation, ExtensionSnapshot, ProviderId } from '../types'
import { Button } from '../components/ui'
import { useNavigationState } from '../components/shell/NavigationState'
import { ResourceDetails, type ResourceDetailsValue } from './ResourceDetails'
import '../styles/management-v3.css'

export interface PluginView {
  pluginId: string
  name: string
  marketplaceName: string
  version: string
  installed: boolean
  enabled: boolean
  installPolicy: string
  authPolicy: string
  sourceType: string
  sourcePath: string | null
}

export interface MarketplaceView {
  name: string
  root: string
}

export interface MarketplaceCreateRequest {
  source: string
  ref?: string
  sparse?: string[]
}

export interface PluginsPageProps {
  plugins: readonly PluginView[]
  marketplaces: readonly MarketplaceView[]
  loading: boolean
  error?: string | null
  onRefresh: () => Promise<void>
  onInstall: (pluginId: string) => Promise<void>
  onRemove: (pluginId: string) => Promise<void>
  onToggle: (pluginId: string, enabled: boolean) => Promise<void>
  onAddMarketplace: (request: MarketplaceCreateRequest) => Promise<void>
  onUpgradeMarketplace: (name?: string) => Promise<void>
  onRemoveMarketplace: (name: string) => Promise<void>
}

type PluginTab = 'installed' | 'available' | 'marketplaces'
type ProviderPluginView = ExtensionSnapshot['items'][number]
type ConfirmTarget =
  | { type: 'plugin'; plugin: PluginView }
  | { type: 'provider-plugin'; plugin: ProviderPluginView }
  | { type: 'marketplace'; marketplace: MarketplaceView }

const updateLabels: Record<ProviderPluginView['update']['state'], string> = {
  'update-available': '可更新',
  'up-to-date': '已是最新',
  'check-failed': '检查失败',
  'source-unknown': '来源未知',
  unsupported: '不支持检查',
}

const sourceLabels: Record<ProviderPluginView['source']['kind'], string> = {
  npm: 'npm',
  pypi: 'PyPI',
  git: 'Git',
  native: '原生',
  local: '本地',
  'source-unknown': '来源未知',
}

const providerExtensionLabels: Record<ProviderId, string> = {
  codex: 'Plugins',
  claude: 'Plugins',
  gemini: 'Extensions',
  grok: 'Plugins',
}

function AddMarketplaceDialog({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (request: MarketplaceCreateRequest) => Promise<void>
  onCancel: () => void
}) {
  const [source, setSource] = useState('')
  const [ref, setRef] = useState('')
  const [sparse, setSparse] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFormError(null)
    try {
      await onSubmit({
        source: source.trim(),
        ref: ref.trim() || undefined,
        sparse: sparse.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
      })
    } catch (error) {
      setFormError(errorMessage(error))
    }
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={busy ? () => undefined : onCancel}>
      <form className="extension-dialog compact-dialog" onSubmit={submit} {...dialogAriaProps('add-market-title')}>
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon"><Store size={19} /></span>
            <div><h2 id="add-market-title">添加 Plugin 市场</h2><small>Codex Marketplace</small></div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onCancel} disabled={busy}><X size={17} /></button>
        </header>
        <div className="extension-dialog-body">
          <label className="field extension-field">
            <span>来源</span>
            <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="owner/repo 或本地绝对路径" required />
          </label>
          <label className="field extension-field">
            <span>Git Ref</span>
            <input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" />
          </label>
          <label className="field extension-field">
            <span>Sparse 路径（每行一项）</span>
            <textarea value={sparse} onChange={(event) => setSparse(event.target.value)} rows={4} placeholder={'plugins/example\nshared'} />
          </label>
          {formError && <div className="extension-error" role="alert">{formError}</div>}
        </div>
        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" type="submit" disabled={busy || !source.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} 添加市场
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}

function RemoveExtensionDialog({ target, busy, onConfirm, onCancel }: {
  target: ConfirmTarget
  busy: boolean
  onConfirm: () => Promise<void>
  onCancel: () => void
}) {
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const name = target.type === 'marketplace' ? target.marketplace.name : target.plugin.name
  const subject = target.type === 'marketplace' ? '市场' : 'Plugin'
  const owner = target.type === 'provider-plugin' ? target.plugin.provider : 'Codex'

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
      <section className="extension-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-extension-title">
        <span className="extension-confirm-icon danger"><Trash2 size={20} /></span>
        <h2 id="remove-extension-title">删除 {name}</h2>
        <p>确认从 {owner} 中移除此 {subject}。</p>
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

export function PluginsPage({
  plugins,
  marketplaces,
  loading,
  error,
  onRefresh,
  onInstall,
  onRemove,
  onToggle,
  onAddMarketplace,
  onUpgradeMarketplace,
  onRemoveMarketplace,
}: PluginsPageProps) {
  const [tab, setTab] = useNavigationState<PluginTab>('plugins.tab', 'installed')
  const [query, setQuery] = useNavigationState('plugins.query', '')
  const [details, setDetails] = useState<ResourceDetailsValue | null>(null)
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [provider, setProvider] = useNavigationState<ProviderId>('plugins.provider', 'codex')
  const [providerSnapshot, setProviderSnapshot] = useState<ExtensionSnapshot | null>(null)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  const providerRequests = useRef(createProviderExtensionRequestCoordinator(provider)).current
  const busyRef = useRef<string | null>(null)
  const codexSelected = provider === 'codex'

  const visiblePlugins = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return plugins.filter((plugin) => {
      if (tab === 'installed' && !plugin.installed) return false
      if (tab === 'available' && plugin.installed) return false
      return !normalized
        || plugin.name.toLowerCase().includes(normalized)
        || plugin.marketplaceName.toLowerCase().includes(normalized)
        || plugin.pluginId.toLowerCase().includes(normalized)
    })
  }, [plugins, query, tab])

  const visibleMarketplaces = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return marketplaces.filter((marketplace) => (
      !normalized
      || marketplace.name.toLowerCase().includes(normalized)
      || marketplace.root.toLowerCase().includes(normalized)
    ))
  }, [marketplaces, query])

  const providerPlugins = useMemo(
    () => providerSnapshot?.items.filter((item) => item.kind === 'plugin') ?? [],
    [providerSnapshot],
  )

  const providerPluginsById = useMemo(
    () => new Map(providerPlugins.map((plugin) => [plugin.id, plugin])),
    [providerPlugins],
  )

  const visibleProviderPlugins = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return providerPlugins.filter((plugin) => {
      if (tab === 'installed' && !plugin.installed) return false
      if (tab === 'available' && plugin.installed) return false
      return !normalized
        || plugin.name.toLowerCase().includes(normalized)
        || plugin.id.toLowerCase().includes(normalized)
        || (plugin.source.locator?.toLowerCase().includes(normalized) ?? false)
    })
  }, [providerPlugins, query, tab])

  const loadProvider = async (nextProvider: ProviderId): Promise<void> => {
    const requestId = providerRequests.begin(nextProvider)
    if (requestId < 0) return
    setProviderLoading(true)
    setProviderError(null)
    try {
      const next = await window.xingmang.listProviderExtensions(nextProvider)
      if (!providerRequests.isCurrent(nextProvider, requestId)) return
      if (!providerRequests.accepts(nextProvider, requestId, next.provider)) {
        throw new Error('扩展列表返回了错误的 Provider')
      }
      setProviderSnapshot(next)
    } catch (nextError) {
      if (providerRequests.isCurrent(nextProvider, requestId)) {
        setProviderSnapshot(null)
        setProviderError(errorMessage(nextError))
      }
      throw nextError
    } finally {
      if (providerRequests.isCurrent(nextProvider, requestId)) setProviderLoading(false)
    }
  }

  useEffect(() => {
    void loadProvider(provider).catch(() => undefined)
    return () => { providerRequests.invalidate() }
  }, [])

  const selectProvider = (nextProvider: ProviderId) => {
    if (nextProvider === provider) return
    providerRequests.select(nextProvider)
    setProvider(nextProvider)
    setProviderSnapshot(null)
    setActionError(null)
    setQuery('')
    if (nextProvider !== 'codex' && tab === 'marketplaces') setTab('installed')
    void loadProvider(nextProvider).catch(() => undefined)
  }

  const perform = async (key: string, action: () => Promise<void>) => {
    if (busyRef.current) throw new Error('已有操作正在执行，请稍候')
    busyRef.current = key
    setBusyKey(key)
    setActionError(null)
    try {
      await action()
    } catch (nextError) {
      setActionError(errorMessage(nextError))
      throw nextError
    } finally {
      if (busyRef.current === key) {
        busyRef.current = null
        setBusyKey(null)
      }
    }
  }

  const refreshCodexAfter = async (action: () => Promise<void>): Promise<void> => {
    await action()
    await Promise.all([
      onRefresh(),
      loadProvider('codex').catch(() => undefined),
    ])
  }

  const mutateProviderPlugin = async (
    plugin: ProviderPluginView,
    action: ExtensionMutation['action'],
  ): Promise<void> => {
    const input: ExtensionMutation = {
      provider: plugin.provider,
      kind: 'plugin',
      action,
      id: plugin.id,
      source: action === 'install' ? plugin.id : undefined,
      scope: plugin.scope === 'workspace' || plugin.scope === 'project' || plugin.scope === 'local'
        ? plugin.scope
        : 'user',
    }
    const requestId = providerRequests.begin(plugin.provider)
    if (requestId < 0) return
    const next = await window.xingmang.mutateProviderExtension(input)
    if (!providerRequests.isCurrent(plugin.provider, requestId)) return
    if (!providerRequests.accepts(plugin.provider, requestId, next.provider)) {
      throw new Error('扩展操作返回了错误的 Provider')
    }
    setProviderSnapshot(next)
  }

  const activeLoading = codexSelected ? loading || providerLoading : providerLoading
  const installedCount = codexSelected
    ? plugins.filter((plugin) => plugin.installed).length
    : providerPlugins.filter((plugin) => plugin.installed).length
  const availableCount = codexSelected
    ? plugins.filter((plugin) => !plugin.installed).length
    : providerPlugins.filter((plugin) => !plugin.installed).length
  const visibleErrors = [...new Set([
    actionError,
    codexSelected ? error : null,
    providerError,
  ].filter((entry): entry is string => Boolean(entry)))]

  return (
    <div className="page workspace-page management-page management-v3" data-page-id="plugins">
      <header className="page-header workspace-page-header">
        <div>
          <h1>插件</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="插件工具栏">
          <button className="icon-button" type="button" title="刷新" disabled={activeLoading || busyKey !== null}
            onClick={() => void perform(
              'refresh',
              codexSelected
                ? async () => { await Promise.all([onRefresh(), loadProvider('codex')]) }
                : () => loadProvider(provider),
            ).catch(() => undefined)}>
            <RefreshCw size={18} className={activeLoading || busyKey === 'refresh' ? 'spin' : ''} />
          </button>
          {codexSelected && tab === 'marketplaces' && (
            <button className="primary-button" type="button" onClick={() => setAddMarketplaceOpen(true)}>
              <Plus size={17} /> 添加市场
            </button>
          )}
        </div>
      </header>

      <section className="management-toolbar management-toolbar-wrap">
        <ProviderTabs
          value={provider}
          onChange={selectProvider}
          disabled={busyKey !== null || confirmTarget !== null}
          label="选择 Plugin 工具"
        />
        <div className="segmented-control" role="tablist" aria-label="Plugin 视图" onKeyDown={(event) => {
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length : null
          if (next !== null) { event.preventDefault(); tabs[next]?.focus() }
        }}>
          <button type="button" role="tab" id="plugins-tab-installed" aria-controls="plugins-list-view" tabIndex={tab === 'installed' ? 0 : -1} aria-selected={tab === 'installed'} className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}>
            已安装 <span>{installedCount}</span>
          </button>
          <button type="button" role="tab" id="plugins-tab-available" aria-controls="plugins-list-view" tabIndex={tab === 'available' ? 0 : -1} aria-selected={tab === 'available'} className={tab === 'available' ? 'active' : ''} onClick={() => setTab('available')}>
            可安装 <span>{availableCount}</span>
          </button>
          {codexSelected && (
            <button type="button" role="tab" id="plugins-tab-marketplaces" aria-controls="plugins-list-view" tabIndex={tab === 'marketplaces' ? 0 : -1} aria-selected={tab === 'marketplaces'} className={tab === 'marketplaces' ? 'active' : ''} onClick={() => setTab('marketplaces')}>
              市场 <span>{marketplaces.length}</span>
            </button>
          )}
        </div>
        <label className="management-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === 'marketplaces' ? '搜索市场' : '搜索插件'} aria-label="搜索插件" />
        </label>
      </section>

      {visibleErrors.map((message) => (
        <div className="management-error" role="alert" key={message}><span>{message}</span><Button size="sm" disabled={activeLoading || busyKey !== null} onClick={() => void perform('refresh', async () => { if (codexSelected) await onRefresh(); await loadProvider(provider) }).catch(() => undefined)}>重试</Button></div>
      ))}

      <div id="plugins-list-view" role="tabpanel" aria-labelledby={`plugins-tab-${tab}`} tabIndex={0}>
      {!codexSelected ? (
        <section className="extension-grid" aria-busy={providerLoading}>
          {providerLoading && !providerSnapshot ? (
            <div className="workspace-empty extension-grid-empty">
              <LoaderCircle className="spin" size={24} />
              <h2>正在读取 {providerExtensionLabels[provider]}</h2>
            </div>
          ) : providerError && !providerSnapshot ? (
            <div className="workspace-empty extension-grid-empty">
              <PackageOpen size={24} />
              <h2>读取 {providerExtensionLabels[provider]} 失败</h2>
              <p>{providerError}</p>
              <button className="secondary-button" type="button" disabled={activeLoading || busyKey !== null}
                onClick={() => void loadProvider(provider).catch(() => undefined)}>
                <RefreshCw size={16} /> 重试
              </button>
            </div>
          ) : providerSnapshot && !providerSnapshot.capabilities.plugin.list ? (
            <div className="workspace-empty extension-grid-empty">
              <PackageOpen size={24} />
              <h2>当前工具无法读取 {providerExtensionLabels[provider]}</h2>
              <p>{providerSnapshot.capabilities.plugin.reason ?? `${providerExtensionLabels[provider]} 列表读取失败`}</p>
            </div>
          ) : visibleProviderPlugins.length ? visibleProviderPlugins.map((plugin) => {
            const toggleAction = plugin.enabled ? 'disable' : 'enable'
            const canToggle = plugin.operations[toggleAction]
            return (
              <article className="plugin-card" key={`${plugin.provider}:${plugin.id}`}>
                <header className="plugin-card-head">
                  <span className="extension-row-icon plugin"><PackageOpen size={19} /></span>
                  <div>
                    <strong>{plugin.name}</strong>
                    <small title={plugin.description}>{plugin.description || plugin.id}</small>
                  </div>
                  {plugin.installed && (plugin.operations.enable || plugin.operations.disable) && (
                    <label className="switch-control" title={canToggle ? (plugin.enabled ? '停用' : '启用') : '当前状态不支持切换'}>
                      <input
                        type="checkbox"
                        checked={plugin.enabled}
                        aria-label={`${plugin.enabled ? '停用' : '启用'} ${plugin.name}`}
                        disabled={busyKey !== null || !canToggle}
                        onChange={(event) => void perform(
                          `provider:${event.target.checked ? 'enable' : 'disable'}:${plugin.id}`,
                          () => mutateProviderPlugin(plugin, event.target.checked ? 'enable' : 'disable'),
                        ).catch(() => undefined)}
                      />
                      <span />
                    </label>
                  )}
                </header>
                <div className="plugin-card-meta">
                  <span>{plugin.currentVersion ? `v${plugin.currentVersion}` : '版本未知'}</span>
                  {plugin.latestVersion && plugin.latestVersion !== plugin.currentVersion && (
                    <span>最新 v{plugin.latestVersion}</span>
                  )}
                  <span title={plugin.source.locator ?? undefined}>{sourceLabels[plugin.source.kind]}</span>
                  <span
                    className={`extension-badge ${plugin.update.state === 'up-to-date' ? 'success' : plugin.update.state === 'update-available' ? 'success' : 'muted'}`}
                    title={plugin.update.reason}
                  >
                    {updateLabels[plugin.update.state]}
                  </span>
                </div>
                <footer className="plugin-card-footer">
                  <button className="icon-button compact" type="button" title="查看详情" aria-label={`查看 ${plugin.name}`} onClick={() => setDetails({ title: plugin.name, fields: [
                    ['工具', plugin.provider], ['说明', plugin.description], ['来源', plugin.source.locator ?? sourceLabels[plugin.source.kind]], ['范围', plugin.scope ?? '未提供'], ['版本', plugin.currentVersion ?? '未知'], ['更新', `${updateLabels[plugin.update.state]}：${plugin.update.reason}`],
                  ] })}><Eye size={16} /></button>
                  {plugin.installed ? (
                    <>
                      <span className={plugin.enabled ? 'extension-state enabled' : 'extension-state'}>
                        <i className={`status-dot ${plugin.enabled ? 'configured' : ''}`} /> {plugin.enabled ? '已启用' : '已停用'}
                      </span>
                      <div className="extension-row-actions">
                        {plugin.operations.update && plugin.update.state !== 'up-to-date' && (
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={busyKey !== null}
                            onClick={() => void perform(
                              `provider:update:${plugin.id}`,
                              () => mutateProviderPlugin(plugin, 'update'),
                            ).catch(() => undefined)}
                          >
                            {busyKey === `provider:update:${plugin.id}`
                              ? <LoaderCircle className="spin" size={16} />
                              : <UploadCloud size={16} />}
                            更新
                          </button>
                        )}
                        {plugin.operations.uninstall && (
                          <button
                            className="icon-button compact"
                            type="button"
                            title="卸载"
                            disabled={busyKey !== null}
                            onClick={() => setConfirmTarget({ type: 'provider-plugin', plugin })}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </>
                  ) : plugin.operations.install ? (
                    <button
                      className="primary-button plugin-install-button"
                      type="button"
                      disabled={busyKey !== null}
                      onClick={() => void perform(
                        `provider:install:${plugin.id}`,
                        () => mutateProviderPlugin(plugin, 'install'),
                      ).catch(() => undefined)}
                    >
                      {busyKey === `provider:install:${plugin.id}`
                        ? <LoaderCircle className="spin" size={16} />
                        : <Download size={16} />}
                      安装
                    </button>
                  ) : (
                    <span className="extension-state">当前仅支持查看</span>
                  )}
                </footer>
              </article>
            )
          }) : (
            <div className="workspace-empty extension-grid-empty">
              <PackageOpen size={24} />
              <h2>{query
                ? `没有匹配的 ${providerExtensionLabels[provider]}`
                : tab === 'installed'
                  ? `尚未安装 ${providerExtensionLabels[provider]}`
                  : `没有可安装的 ${providerExtensionLabels[provider]}`}</h2>
              {providerSnapshot?.warnings.length ? <p>{providerSnapshot.warnings.join('；')}</p> : null}
            </div>
          )}
        </section>
      ) : tab === 'marketplaces' ? (
        <section className="extension-list" aria-busy={loading}>
          {loading && !marketplaces.length ? (
            <div className="workspace-empty"><LoaderCircle className="spin" size={24} /><h2>正在读取插件来源</h2></div>
          ) : visibleMarketplaces.length ? visibleMarketplaces.map((marketplace) => (
            <article className="extension-row" key={marketplace.name}>
              <div className="extension-row-icon marketplace"><Store size={19} /></div>
              <div className="extension-row-main">
                <div className="extension-row-title"><strong>{marketplace.name}</strong><span className="extension-badge">市场</span></div>
                <div className="extension-row-subtitle" title={marketplace.root}>{marketplace.root}</div>
              </div>
              <div className="extension-row-actions">
                <button className="secondary-button" type="button" disabled={busyKey !== null}
                  onClick={() => void perform(
                    `upgrade:${marketplace.name}`,
                    () => refreshCodexAfter(() => onUpgradeMarketplace(marketplace.name)),
                  ).catch(() => undefined)}>
                  {busyKey === `upgrade:${marketplace.name}` ? <LoaderCircle className="spin" size={16} /> : <UploadCloud size={16} />} 更新
                </button>
                <button className="danger-button square" type="button" title="删除市场" disabled={busyKey !== null}
                  onClick={() => setConfirmTarget({ type: 'marketplace', marketplace })}>
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          )) : (
            <div className="workspace-empty"><Store size={24} /><h2>{query ? '没有找到这个来源' : '还没有插件来源'}</h2></div>
          )}
        </section>
      ) : (
        <section className="extension-grid" aria-busy={loading}>
          {loading && !plugins.length ? (
            <div className="workspace-empty extension-grid-empty"><LoaderCircle className="spin" size={24} /><h2>正在读取插件</h2></div>
          ) : visiblePlugins.length ? visiblePlugins.map((plugin) => {
            const unifiedPlugin = providerPluginsById.get(plugin.pluginId)
            const currentVersion = unifiedPlugin?.currentVersion ?? (plugin.version || null)
            const latestVersion = unifiedPlugin?.latestVersion ?? null
            const sourceKind = unifiedPlugin?.source.kind ?? 'source-unknown'
            const updateState = unifiedPlugin?.update.state ?? 'source-unknown'
            const updateReason = unifiedPlugin?.update.reason ?? '统一扩展快照未识别此 Plugin 的来源和更新状态'
            return (
              <article className="plugin-card" key={plugin.pluginId}>
              <header className="plugin-card-head">
                <span className="extension-row-icon plugin"><PackageOpen size={19} /></span>
                <div>
                  <strong>{plugin.name}</strong>
                  <small>{plugin.marketplaceName}</small>
                </div>
                {plugin.installed && (
                  <label className="switch-control" title={plugin.enabled ? '停用' : '启用'}>
                    <input type="checkbox" checked={plugin.enabled} disabled={busyKey !== null} aria-label={`${plugin.enabled ? '停用' : '启用'} ${plugin.name}`}
                      onChange={(event) => void perform(
                        `toggle:${plugin.pluginId}`,
                        () => refreshCodexAfter(() => onToggle(plugin.pluginId, event.target.checked)),
                      ).catch(() => undefined)} />
                    <span />
                  </label>
                )}
              </header>
              <div className="plugin-card-meta">
                <span>{currentVersion ? `v${currentVersion}` : '版本未知'}</span>
                {latestVersion && latestVersion !== currentVersion && <span>最新 v{latestVersion}</span>}
                <span title={unifiedPlugin?.source.locator ?? undefined}>{sourceLabels[sourceKind]}</span>
                <span
                  className={`extension-badge ${updateState === 'up-to-date' || updateState === 'update-available' ? 'success' : 'muted'}`}
                  title={updateReason}
                >
                  {updateLabels[updateState]}
                </span>
                <span>{plugin.authPolicy || 'DEFAULT'}</span>
              </div>
              <footer className="plugin-card-footer">
                <button className="icon-button compact" type="button" title="查看详情" aria-label={`查看 ${plugin.name}`} onClick={() => setDetails({ title: plugin.name, fields: [
                  ['工具', 'Codex'], ['标识', plugin.pluginId], ['市场', plugin.marketplaceName], ['来源', plugin.sourcePath ?? '未提供'], ['版本', currentVersion || '未知'], ['安装策略', plugin.installPolicy], ['认证策略', plugin.authPolicy], ['更新', `${updateLabels[updateState]}：${updateReason}`],
                ] })}><Eye size={16} /></button>
                {plugin.installed ? (
                  <>
                    <span className={plugin.enabled ? 'extension-state enabled' : 'extension-state'}>
                      <i className={`status-dot ${plugin.enabled ? 'configured' : ''}`} /> {plugin.enabled ? '已启用' : '已停用'}
                    </span>
                    <div className="extension-row-actions">
                      {unifiedPlugin?.operations.update && updateState !== 'up-to-date' && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() => void perform(
                            `provider:update:${plugin.pluginId}`,
                            () => mutateProviderPlugin(unifiedPlugin, 'update'),
                          ).catch(() => undefined)}
                        >
                          {busyKey === `provider:update:${plugin.pluginId}`
                            ? <LoaderCircle className="spin" size={16} />
                            : <UploadCloud size={16} />}
                          更新
                        </button>
                      )}
                      <button className="icon-button compact" type="button" title="卸载" disabled={busyKey !== null}
                        onClick={() => setConfirmTarget({ type: 'plugin', plugin })}><Trash2 size={15} /></button>
                    </div>
                  </>
                ) : (
                  <button className="primary-button plugin-install-button" type="button" disabled={busyKey !== null}
                    onClick={() => void perform(
                      `install:${plugin.pluginId}`,
                      () => refreshCodexAfter(() => onInstall(plugin.pluginId)),
                    ).catch(() => undefined)}>
                    {busyKey === `install:${plugin.pluginId}` ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} 安装
                  </button>
                )}
              </footer>
              </article>
            )
          }) : (
            <div className="workspace-empty extension-grid-empty">
              <PackageOpen size={24} />
              <h2>{query ? '没有找到这个插件' : tab === 'installed' ? '还没有插件' : '没有可安装的插件'}</h2>
            </div>
          )}
        </section>
      )}

      </div>
      <ResourceDetails value={details} onClose={() => setDetails(null)} />
      {query && <Button variant="ghost" size="sm" onClick={() => setQuery('')}>清除筛选</Button>}
      {addMarketplaceOpen && (
        <AddMarketplaceDialog
          busy={busyKey === 'add-marketplace'}
          onCancel={() => setAddMarketplaceOpen(false)}
          onSubmit={async (request) => {
            await perform('add-marketplace', () => refreshCodexAfter(() => onAddMarketplace(request)))
            setAddMarketplaceOpen(false)
          }}
        />
      )}
      {confirmTarget && (
        <RemoveExtensionDialog
          target={confirmTarget}
          busy={busyKey === 'remove-extension'}
          onCancel={() => setConfirmTarget(null)}
          onConfirm={async () => {
            await perform('remove-extension', () => {
               if (confirmTarget.type === 'plugin') {
                 return refreshCodexAfter(() => onRemove(confirmTarget.plugin.pluginId))
               }
              if (confirmTarget.type === 'provider-plugin') {
                return mutateProviderPlugin(confirmTarget.plugin, 'uninstall')
              }
               return refreshCodexAfter(() => onRemoveMarketplace(confirmTarget.marketplace.name))
            })
            setConfirmTarget(null)
          }}
        />
      )}
    </div>
  )
}

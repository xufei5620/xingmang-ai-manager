import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  FolderInput,
  GitBranch,
  LoaderCircle,
  Power,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import { dialogAriaProps, DialogBackdrop } from '../components/Dialog'
import { errorMessage } from '../error-message'
import {
  managementProviderLabels,
  ProviderTabs,
} from '../components/ProviderTabs'
import { createLatestRequestTracker } from '../latest-request'
import type { ExtensionSnapshot, ProviderId } from '../types'

type ProviderExtensionItem = ExtensionSnapshot['items'][number]
type ProviderSkillImportRequest = {
  sourcePath: string
  scope: 'user' | 'repo' | 'workspace'
}

export interface SkillView {
  id: string
  name: string
  description: string
  path: string
  scope: 'user' | 'repo' | 'system'
  source: 'agents' | 'codex'
  enabled: boolean
  managed: boolean
}

export interface SkillImportRequest {
  sourcePath: string
  scope: 'user' | 'repo'
}

export interface SkillsPageProps {
  skills: readonly SkillView[]
  loading: boolean
  error?: string | null
  repositoryAvailable?: boolean
  onRefresh: () => Promise<void>
  onImport: (request: SkillImportRequest) => Promise<void>
  onToggle: (path: string, enabled: boolean) => Promise<void>
  onUninstall: (path: string) => Promise<void>
}

function scopeLabel(scope: SkillView['scope']): string {
  if (scope === 'repo') return '仓库'
  if (scope === 'system') return '系统'
  return '用户'
}

function providerScopeLabel(scope: ProviderExtensionItem['scope']): string | null {
  if (scope === 'user') return '用户'
  if (scope === 'workspace' || scope === 'project' || scope === 'local') return '工作区'
  if (scope === 'builtin') return '内置'
  if (scope === 'extension') return '扩展'
  return null
}

function ImportSkillDialog({
  provider,
  busy,
  repositoryAvailable,
  onSubmit,
  onCancel,
}: {
  provider: ProviderId
  busy: boolean
  repositoryAvailable: boolean
  onSubmit: (request: ProviderSkillImportRequest) => Promise<void>
  onCancel: () => void
}) {
  const [sourcePath, setSourcePath] = useState('')
  const [scope, setScope] = useState<'user' | 'repo' | 'workspace'>('user')
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFormError(null)
    try {
      await onSubmit({ sourcePath: sourcePath.trim(), scope })
    } catch (error) {
      setFormError(errorMessage(error))
    }
  }

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={busy ? () => undefined : onCancel}>
      <form className="extension-dialog compact-dialog" onSubmit={submit} {...dialogAriaProps('import-skill-title')}>
        <header className="extension-dialog-head">
          <div>
            <span className="extension-dialog-icon"><FolderInput size={19} /></span>
            <div><h2 id="import-skill-title">导入 Skill</h2><small>{managementProviderLabels[provider]}</small></div>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onCancel} disabled={busy}><X size={17} /></button>
        </header>
        <div className="extension-dialog-body">
          <label className="field extension-field">
            <span>{provider === 'gemini' ? 'Git 地址或本地 Skill 目录' : '本地 Skill 目录或 SKILL.md'}</span>
            <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder={provider === 'gemini' ? 'https://github.com/owner/skill.git' : 'C:\\path\\to\\skill'} required />
          </label>
          <div className="segmented-control" role="group" aria-label="导入范围">
            <button type="button" className={scope === 'user' ? 'active' : ''} onClick={() => setScope('user')}>用户</button>
            {provider === 'gemini' ? (
              <button type="button" className={scope === 'workspace' ? 'active' : ''} onClick={() => setScope('workspace')} disabled={!repositoryAvailable}>当前工作区</button>
            ) : (
              <button type="button" className={scope === 'repo' ? 'active' : ''} onClick={() => setScope('repo')} disabled={!repositoryAvailable}>当前仓库</button>
            )}
          </div>
          {formError && <div className="extension-error" role="alert">{formError}</div>}
        </div>
        <footer className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary-button" type="submit" disabled={busy || !sourcePath.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <FolderInput size={16} />} 导入
          </button>
        </footer>
      </form>
    </DialogBackdrop>
  )
}

function UninstallSkillDialog({ name, provider, busy, onConfirm, onCancel }: {
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
      <section className="extension-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="uninstall-skill-title">
        <span className="extension-confirm-icon danger"><Trash2 size={20} /></span>
        <h2 id="uninstall-skill-title">卸载 {name}</h2>
        <p>{provider === 'codex' ? 'Skill 目录会移动到应用回收站，不会直接删除。' : `将通过 ${managementProviderLabels[provider]} CLI 卸载此 Skill。`}</p>
        {confirmError && <div className="extension-error extension-confirm-error" role="alert">{confirmError}</div>}
        <div className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="danger-button" type="button" onClick={() => void confirm()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} {provider === 'codex' ? '移到回收站' : '确认卸载'}
          </button>
        </div>
      </section>
    </DialogBackdrop>
  )
}

function providerUpdateLabel(item: ProviderExtensionItem): string {
  switch (item.update.state) {
    case 'update-available': return '可更新'
    case 'up-to-date': return '已是最新'
    case 'check-failed': return '检测失败'
    case 'source-unknown': return '来源未知'
    case 'unsupported': return '不支持检测'
  }
}

function providerUpdateBadgeClass(item: ProviderExtensionItem): string {
  return item.update.state === 'update-available' || item.update.state === 'up-to-date'
    ? 'success'
    : 'muted'
}

export function SkillsPage({
  skills,
  loading,
  error,
  repositoryAvailable = false,
  onRefresh,
  onImport,
  onToggle,
  onUninstall,
}: SkillsPageProps) {
  const [provider, setProvider] = useState<ProviderId>('codex')
  const [providerSnapshots, setProviderSnapshots] = useState<Partial<Record<ProviderId, ExtensionSnapshot>>>({})
  const [providerErrors, setProviderErrors] = useState<Partial<Record<ProviderId, string>>>({})
  const [loadingProviders, setLoadingProviders] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | SkillView['scope']>('all')
  const [importOpen, setImportOpen] = useState(false)
  const [uninstallTarget, setUninstallTarget] = useState<{ name: string; skill?: SkillView; item?: ProviderExtensionItem } | null>(null)
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
    () => snapshot?.items.filter((item) => item.kind === 'skill') ?? [],
    [snapshot],
  )
  const filteredCodex = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return skills.filter((skill) => {
      if (scope !== 'all' && skill.scope !== scope) return false
      return !normalized
        || skill.name.toLowerCase().includes(normalized)
        || skill.description.toLowerCase().includes(normalized)
        || skill.path.toLowerCase().includes(normalized)
    })
  }, [query, scope, skills])
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
  const codexUpdatesByPath = useMemo(
    () => new Map(providerItems.map((item) => [item.id.toLowerCase(), item])),
    [providerItems],
  )
  const codexUpdatesByName = useMemo(
    () => new Map(providerItems.map((item) => [item.name.toLowerCase(), item])),
    [providerItems],
  )
  const selectedLoading = (provider === 'codex' && loading) || Boolean(loadingProviders[provider])
  const selectedReady = Boolean(snapshot) && !selectedLoading
  const selectedError = provider === 'codex' ? error ?? providerErrors.codex : providerErrors[provider]
  const selectedCount = provider === 'codex' ? skills.length : providerItems.length
  const selectedEnabled = provider === 'codex'
    ? skills.filter((skill) => skill.enabled).length
    : providerItems.filter((item) => item.enabled).length
  const supportsInstall = provider === 'codex' || provider === 'gemini'
  const unavailable = useMemo(() => new Set<ProviderId>(
    (['codex', 'claude', 'gemini', 'grok'] as const).filter((id) => (
      Boolean(providerErrors[id]) || providerSnapshots[id]?.capabilities.skill.list === false
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

  const mutate = async (
    item: ProviderExtensionItem,
    action: 'uninstall' | 'enable' | 'disable' | 'update',
  ) => {
    const target = provider
    const requestId = providerRequests.begin(target)
    const next = await window.xingmang.mutateProviderExtension({
      provider: target,
      kind: 'skill',
      action,
      id: item.name,
      scope: item.scope === 'workspace' ? 'workspace' : 'user',
    })
    if (providerRequests.isCurrent(target, requestId)) {
      setProviderSnapshots((current) => ({ ...current, [target]: next }))
      setProviderErrors((current) => ({ ...current, [target]: undefined }))
    }
  }

  const refresh = provider === 'codex'
    ? async () => { await Promise.all([onRefresh(), loadProvider('codex')]) }
    : () => loadProvider(provider)

  return (
    <div className="page workspace-page management-page" data-page-id="skills">
      <header className="page-header workspace-page-header">
        <div><div className="eyebrow">SKILLS</div><h1>Skills 管理</h1></div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="Skills 工具栏">
          <ProviderTabs
            value={provider}
            onChange={(next) => { setProvider(next); setQuery(''); setScope('all'); setActionError(null) }}
            disabled={selectedLoading || busyKey !== null}
            unavailable={unavailable}
            label="选择 Skill Provider"
          />
          <button className="icon-button" type="button" title="刷新" disabled={selectedLoading || busyKey !== null}
            onClick={() => void perform('refresh', refresh).catch(() => undefined)}>
            <RefreshCw size={18} className={selectedLoading || busyKey === 'refresh' ? 'spin' : ''} />
          </button>
          {supportsInstall && (
            <button className="primary-button" type="button" onClick={() => setImportOpen(true)} disabled={!selectedReady || busyKey !== null}>
              <FolderInput size={17} /> {provider === 'codex' ? '导入 Skill' : '安装 Skill'}
            </button>
          )}
        </div>
      </header>

      <section className="management-toolbar management-toolbar-wrap">
        <label className="management-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、说明或路径" aria-label="搜索 Skills" />
        </label>
        {provider === 'codex' && (
          <div className="segmented-control compact" role="group" aria-label="Skill 范围">
            {(['all', 'user', 'repo', 'system'] as const).map((value) => (
              <button key={value} type="button" className={scope === value ? 'active' : ''} onClick={() => setScope(value)}>
                {value === 'all' ? '全部' : scopeLabel(value)}
              </button>
            ))}
          </div>
        )}
        <div className="management-counts"><span>{selectedEnabled} 已启用</span><span>{selectedCount} 个 Skill</span></div>
      </section>

      {(selectedError || actionError) && <div className="management-error" role="alert">{actionError ?? selectedError}</div>}
      {snapshot?.capabilities.skill.list === false && (
        <div className="management-error" role="status">{snapshot.capabilities.skill.reason ?? 'Skill 列表不可用'}</div>
      )}

      <section className="extension-grid" aria-busy={selectedLoading}>
        {selectedLoading && selectedCount === 0 ? (
          <div className="workspace-empty extension-grid-empty"><LoaderCircle className="spin" size={24} /><h2>正在扫描 Skills</h2></div>
        ) : provider === 'codex' ? filteredCodex.length ? filteredCodex.map((skill) => {
          const updateItem = codexUpdatesByPath.get(skill.path.toLowerCase())
            ?? codexUpdatesByName.get(skill.name.toLowerCase())
          return <article className="skill-card" key={skill.id}>
            <header className="skill-card-head">
              <span className="extension-row-icon skill"><WandSparkles size={19} /></span>
              <div>
                <strong>{skill.name}</strong>
                <span className="extension-badge">{scopeLabel(skill.scope)}</span>
                {skill.source === 'codex' && <span className="extension-badge muted">兼容目录</span>}
                {updateItem && <span className={`extension-badge ${providerUpdateBadgeClass(updateItem)}`} title={updateItem.update.reason}>{providerUpdateLabel(updateItem)}</span>}
              </div>
              <label className="switch-control" title={skill.managed ? (skill.enabled ? '停用' : '启用') : '系统 Skill 只读'}>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  disabled={!skill.managed || busyKey !== null}
                  onChange={(event) => void perform(`toggle:${skill.id}`, async () => {
                    await onToggle(skill.path, event.target.checked)
                    await loadProvider('codex')
                  }).catch(() => undefined)}
                />
                <span />
              </label>
            </header>
            <p className="skill-description">{skill.description || '未提供说明'}</p>
            <div className="skill-path" title={skill.path}>{skill.path}</div>
            {updateItem && (
              <div className="extension-row-meta">
                {updateItem.currentVersion && <span>当前 {updateItem.currentVersion}</span>}
                {updateItem.latestVersion && <span>远端 {updateItem.latestVersion}</span>}
              </div>
            )}
            <footer className="skill-card-footer">
              <span className={skill.enabled ? 'extension-state enabled' : 'extension-state'}>
                <i className={`status-dot ${skill.enabled ? 'configured' : ''}`} /> {skill.enabled ? '已启用' : '已停用'}
              </span>
              {skill.managed ? (
                <button className="icon-button compact" type="button" title="卸载" onClick={() => setUninstallTarget({ name: skill.name, skill })} disabled={busyKey !== null}>
                  <Trash2 size={15} />
                </button>
              ) : <span className="readonly-label"><Shield size={13} /> 只读</span>}
            </footer>
          </article>
        }) : (
          <div className="workspace-empty extension-grid-empty">
            <WandSparkles size={24} />
            <h2>{query || scope !== 'all' ? '没有匹配的 Skill' : '尚未发现 Skill'}</h2>
          </div>
        ) : filteredProvider.length ? filteredProvider.map((item) => {
          const canToggle = (item.enabled && item.operations.disable) || (!item.enabled && item.operations.enable)
          const readonly = !canToggle && !item.operations.uninstall && !item.operations.update
          const source = item.source.locator ?? (item.source.kind === 'source-unknown' ? '来源未知' : item.source.kind)
          const itemScope = providerScopeLabel(item.scope)
          return (
            <article className="skill-card" key={item.id}>
              <header className="skill-card-head">
                <span className="extension-row-icon skill">{item.source.kind === 'git' ? <GitBranch size={19} /> : <WandSparkles size={19} />}</span>
                <div>
                  <strong>{item.name}</strong>
                  {itemScope && <span className="extension-badge">{itemScope}</span>}
                  <span className={`extension-badge ${providerUpdateBadgeClass(item)}`} title={item.update.reason}>{providerUpdateLabel(item)}</span>
                  <span className="extension-badge">{item.source.kind === 'source-unknown' ? '来源未知' : item.source.kind.toUpperCase()}</span>
                </div>
                {canToggle && (
                  <label className="switch-control" title={item.enabled ? '停用' : '启用'}>
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      disabled={busyKey !== null}
                      onChange={() => void perform(`toggle:${item.id}`, () => mutate(item, item.enabled ? 'disable' : 'enable')).catch(() => undefined)}
                    />
                    <span />
                  </label>
                )}
              </header>
              <p className="skill-description">{item.description || '未提供说明'}</p>
              <div className="skill-path" title={source}>{source}</div>
              <div className="extension-row-meta">
                {item.currentVersion && <span>当前 {item.currentVersion}</span>}
                {item.latestVersion && <span>远端 {item.latestVersion}</span>}
              </div>
              <footer className="skill-card-footer">
                <span className={item.enabled ? 'extension-state enabled' : 'extension-state'}>
                  <i className={`status-dot ${item.enabled ? 'configured' : ''}`} /> {item.enabled ? '已启用' : '已停用'}
                </span>
                <div className="extension-row-actions">
                  {item.update.state === 'update-available' && item.operations.update && (
                    <button className="icon-button compact" type="button" title="更新" disabled={busyKey !== null}
                      onClick={() => void perform(`update:${item.id}`, () => mutate(item, 'update')).catch(() => undefined)}>
                      {busyKey === `update:${item.id}` ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                    </button>
                  )}
                  {item.operations.uninstall && (
                    <button className="icon-button compact" type="button" title="卸载" onClick={() => setUninstallTarget({ name: item.name, item })} disabled={busyKey !== null}>
                      <Trash2 size={15} />
                    </button>
                  )}
                  {readonly && <span className="readonly-label"><Shield size={13} /> 只读</span>}
                </div>
              </footer>
            </article>
          )
        }) : (
          <div className="workspace-empty extension-grid-empty">
            <WandSparkles size={24} />
            <h2>{query ? '没有匹配的 Skill' : '尚未发现 Skill'}</h2>
          </div>
        )}
      </section>

      {importOpen && (
        <ImportSkillDialog
          provider={provider}
          busy={busyKey === 'import'}
          repositoryAvailable={repositoryAvailable}
          onCancel={() => setImportOpen(false)}
          onSubmit={async (request) => {
            await perform('import', async () => {
              if (provider === 'codex') {
                await onImport({
                  sourcePath: request.sourcePath,
                  scope: request.scope === 'repo' ? 'repo' : 'user',
                })
                await loadProvider('codex')
                return
              }
              const next = await window.xingmang.mutateProviderExtension({
                provider,
                kind: 'skill',
                action: 'install',
                source: request.sourcePath,
                scope: request.scope === 'workspace' ? 'workspace' : 'user',
              })
              providerRequests.invalidate(provider)
              setProviderSnapshots((current) => ({ ...current, [provider]: next }))
            })
            setImportOpen(false)
          }}
        />
      )}
      {uninstallTarget && (
        <UninstallSkillDialog
          name={uninstallTarget.name}
          provider={provider}
          busy={busyKey === `uninstall:${uninstallTarget.name}`}
          onCancel={() => setUninstallTarget(null)}
          onConfirm={async () => {
            await perform(`uninstall:${uninstallTarget.name}`, async () => {
              if (provider === 'codex' && uninstallTarget.skill) {
                await onUninstall(uninstallTarget.skill.path)
                await loadProvider('codex')
              }
              else if (uninstallTarget.item) await mutate(uninstallTarget.item, 'uninstall')
            })
            setUninstallTarget(null)
          }}
        />
      )}
    </div>
  )
}

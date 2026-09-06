import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArchiveRestore,
  CheckCircle2,
  Eye,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { errorMessage } from '../error-message'
import { managementProviderIds } from '../provider-registry'
import type { ProviderId } from '../types'
import { Banner, Button, Drawer } from '../components/ui'
import { useNavigationState } from '../components/shell/NavigationState'
import '../styles/management-v3.css'

export type BackupReason = 'manual' | 'pre-save' | 'pre-restore'

export interface BackupSummary {
  id: string
  provider: ProviderId | null
  reason: BackupReason | null
  createdAt: string | null
  fileCount: number
  existingFileCount: number
  totalSize: number
  valid: boolean
  error: string | null
}

export interface BackupFilePreview {
  targetRelativePath: string
  backupRelativePath: string | null
  existed: boolean
  size: number
  sha256: string | null
}

export interface BackupPreview extends BackupSummary {
  files: BackupFilePreview[]
}

export interface BackupsPageApi {
  list(): Promise<BackupSummary[]>
  create(provider: ProviderId): Promise<BackupSummary>
  inspect(id: string): Promise<BackupPreview>
  restore(id: string): Promise<{ preRestoreBackupId: string }>
  // 可选：App 侧未注入时回退到 window.xingmang.deleteBackup。
  delete?(id: string): Promise<void>
}

export interface BackupsPageProps {
  api: BackupsPageApi
}

const providerLabels: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  grok: 'Grok CLI',
}
const reasonLabels: Record<BackupReason, string> = {
  manual: '手工备份',
  'pre-save': '保存前',
  'pre-restore': '恢复前',
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function BackupsPage({ api }: BackupsPageProps) {
  const [backups, setBackups] = useState<BackupSummary[]>([])
  const [provider, setProvider] = useNavigationState<ProviderId>('backups.provider', 'codex')
  const [query, setQuery] = useNavigationState('backups.query', '')
  const [filterProvider, setFilterProvider] = useNavigationState<ProviderId | 'all'>('backups.filterProvider', 'all')
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // React 18 对离散事件同步 flush，双击的第二次 click 已能看到确认态，需要最短间隔挡住击穿。
  const armedAt = useRef(0)
  const listRequest = useRef(0)
  const previewRequest = useRef(0)
  const previewTrigger = useRef<HTMLElement | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const requestId = ++listRequest.current
    setLoading(true)
    setError(null)
    try {
      const next = await api.list()
      if (requestId !== listRequest.current) return
      setBackups(next)
      setConfirmDeleteId(null)
    } catch (cause) {
      if (requestId === listRequest.current) setError(errorMessage(cause))
    } finally {
      if (requestId === listRequest.current) setLoading(false)
    }
  }, [api])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false; listRequest.current += 1; previewRequest.current += 1 }
  }, [refresh])

  const closePreview = () => {
    previewRequest.current += 1
    setPreviewId(null)
    setPreview(null)
    setPreviewError(null)
    if (busy?.startsWith('inspect:')) setBusy(null)
  }

  const create = async () => {
    setBusy('create')
    setError(null)
    setNotice(null)
    try {
      const created = await api.create(provider)
      setNotice(`已创建 ${providerLabels[provider]} 备份 ${created.id}`)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const inspect = async (id: string) => {
    if (!previewId && document.activeElement instanceof HTMLElement) previewTrigger.current = document.activeElement
    const requestId = ++previewRequest.current
    setPreviewId(id)
    setPreview(null)
    setPreviewError(null)
    setBusy(`inspect:${id}`)
    setError(null)
    try {
      const next = await api.inspect(id)
      if (requestId === previewRequest.current) setPreview(next)
    } catch (cause) {
      if (requestId === previewRequest.current) setPreviewError(errorMessage(cause))
    } finally {
      if (requestId === previewRequest.current) setBusy(null)
    }
  }

  const restore = async () => {
    if (!preview?.valid) return
    setBusy(`restore:${preview.id}`)
    setError(null)
    setPreviewError(null)
    setNotice(null)
    try {
      const result = await api.restore(preview.id)
      if (!mounted.current) return
      closePreview()
      setNotice(`恢复完成，当前配置已保存为 ${result.preRestoreBackupId}`)
      await refresh()
    } catch (cause) {
      if (mounted.current) setPreviewError(errorMessage(cause))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredBackups = backups.filter((backup) => (filterProvider === 'all' || backup.provider === filterProvider)
    && (!normalizedQuery || [backup.id, backup.provider ? providerLabels[backup.provider] : '', backup.reason ? reasonLabels[backup.reason] : ''].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))))

  const remove = async (id: string) => {
    // 二次确认：第一次点击只切换为「确认删除」，再次点击才真正删除。
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      armedAt.current = Date.now()
      return
    }
    if (Date.now() - armedAt.current < 600) return
    setBusy(`delete:${id}`)
    setError(null)
    setNotice(null)
    try {
      await (api.delete ?? window.xingmang.deleteBackup)(id)
      setConfirmDeleteId(null)
      if (preview?.id === id) setPreview(null)
      setNotice(`已删除备份 ${id}`)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page workspace-page operations-page management-v3" data-page-id="backups">
      <header className="page-header workspace-page-header">
        <div>
          <h1>备份</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="备份工具栏">
          <button className="icon-button" type="button" title="刷新" aria-label="刷新" onClick={refresh} disabled={loading || busy !== null}>
            <RefreshCw className={loading ? 'spin' : undefined} size={18} />
          </button>
        </div>
      </header>

      {error && <Banner title="备份操作未完成" tone="bad" live="assertive" actions={<Button size="sm" onClick={() => void refresh()} disabled={loading}>重试</Button>}>{error}</Banner>}
      {notice && <div className="operation-notice" role="status"><CheckCircle2 size={16} />{notice}</div>}

      <section className="environment-section backup-create" aria-labelledby="backup-create-title">
        <div className="section-heading">
          <div>
            <h2 id="backup-create-title">马上备份</h2>
            <span>只备份本软件管的配置，不碰你的项目文件</span>
          </div>
          <div className="config-actions">
            <select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)} disabled={busy !== null} aria-label="选择 AI 工具">
              {managementProviderIds.map((id) => <option value={id} key={id}>{providerLabels[id]}</option>)}
            </select>
            <button className="primary-button" type="button" onClick={create} disabled={busy !== null || loading}>
              {busy === 'create' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              备份这个工具
            </button>
          </div>
        </div>
      </section>

      <section className="environment-section backup-list-section" aria-labelledby="backup-list-title">
        <div className="section-heading">
          <div>
            <h2 id="backup-list-title">以前的备份</h2>
            <span>{loading ? '正在读取' : `共 ${backups.length} 个快照`}</span>
          </div>
        </div>
        <div className="management-toolbar">
          <label className="management-search"><Search size={16} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索备份" aria-label="搜索备份" /></label>
          <select aria-label="筛选备份工具" value={filterProvider} onChange={(event) => setFilterProvider(event.target.value as ProviderId | 'all')}>
            <option value="all">全部工具</option>{managementProviderIds.map((id) => <option key={id} value={id}>{providerLabels[id]}</option>)}
          </select>
        </div>
        {loading ? (
          <div className="operation-loading"><LoaderCircle className="spin" size={18} />正在读取备份清单</div>
        ) : filteredBackups.length ? (
          <div className="operations-list" role="list">
            {filteredBackups.map((backup) => (
              <article className={`operation-row backup-row ${backup.valid ? '' : 'is-error'}`} key={backup.id} role="listitem">
                <div className="operation-status-icon">
                  {backup.valid ? <ShieldCheck size={17} /> : <AlertCircle size={17} />}
                </div>
                <div className="operation-row-copy">
                  <div className="operation-row-title">
                    <strong>{backup.provider ? providerLabels[backup.provider] : '无效备份'}</strong>
                    {backup.reason && <span className="operation-state">{reasonLabels[backup.reason]}</span>}
                  </div>
                  <p>{backup.createdAt ? new Date(backup.createdAt).toLocaleString() : backup.error}</p>
                  <span className="operation-meta">{backup.existingFileCount}/{backup.fileCount} 个文件 · {fileSize(backup.totalSize)}</span>
                </div>
                <div className="backup-row-actions">
                <button className="secondary-button" type="button" onClick={() => inspect(backup.id)} disabled={!backup.valid || busy !== null}>
                  {busy === `inspect:${backup.id}` ? <LoaderCircle className="spin" size={15} /> : <Eye size={15} />}
                  预览恢复
                </button>
                <button
                  className={confirmDeleteId === backup.id ? 'danger-button' : 'secondary-button'}
                  type="button"
                  onClick={() => remove(backup.id)}
                  disabled={busy !== null}
                >
                  {busy === `delete:${backup.id}` ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                  {confirmDeleteId === backup.id ? '确认删除' : '删除'}
                </button>
                {confirmDeleteId === backup.id && <Button size="sm" disabled={busy !== null} onClick={() => setConfirmDeleteId(null)}>取消</Button>}
                </div>
              </article>
            ))}
          </div>
        ) : !error ? (
          <div className="operation-empty"><ArchiveRestore size={20} />{query || filterProvider !== 'all' ? '没有匹配的备份' : '还没有备份'}
            {(query || filterProvider !== 'all') && <Button onClick={() => { setQuery(''); setFilterProvider('all') }}>清除筛选</Button>}
          </div>
        ) : null}
      </section>

      <Drawer open={previewId !== null} title={`恢复预览${preview?.provider ? ` · ${providerLabels[preview.provider]}` : ''}`} subtitle={previewId}
        onClose={closePreview} closeLabel="关闭预览" busy={Boolean(busy?.startsWith('restore:'))} testId="backup-preview-drawer" returnFocus={previewTrigger}
        footer={preview && <>
          <Button onClick={closePreview} disabled={busy !== null}>取消</Button>
          <Button variant="danger" icon={RotateCcw} onClick={() => void restore()} disabled={!preview.valid || Boolean(busy)} loading={busy === `restore:${preview.id}`}>确认恢复</Button>
        </>}>
        {busy?.startsWith('inspect:') && <div className="operation-loading" role="status"><LoaderCircle className="spin" size={18} />正在读取备份详情</div>}
        {previewError && <Banner title="备份操作未完成" tone="bad" live="assertive" actions={!preview && previewId ? <Button size="sm" onClick={() => void inspect(previewId)}>重试</Button> : undefined}>{previewError}</Banner>}
        {preview && <section className="restore-preview">
          <Banner title="当前配置会先备份" tone="info">恢复时会重新校验清单、路径和文件完整性。</Banner>
          <div className="operations-list" role="list">
            {preview.files.map((file) => (
              <div className="operation-row backup-file-row" key={file.targetRelativePath} role="listitem">
                <div className="operation-row-copy">
                  <strong>~/{file.targetRelativePath}</strong>
                  <p>{file.existed ? `${fileSize(file.size)} · SHA-256 ${file.sha256?.slice(0, 12)}...` : '快照时不存在，恢复时将移除当前文件'}</p>
                </div>
              </div>
            ))}
          </div>
        </section>}
      </Drawer>
    </div>
  )
}

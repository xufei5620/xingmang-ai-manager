import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArchiveRestore,
  CheckCircle2,
  Eye,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { errorMessage } from '../error-message'
import { managementProviderIds } from '../provider-registry'
import type { ProviderId } from '../types'

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
  const [provider, setProvider] = useState<ProviderId>('codex')
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // React 18 对离散事件同步 flush，双击的第二次 click 已能看到确认态，需要最短间隔挡住击穿。
  const armedAt = useRef(0)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      setBackups(await api.list())
      setConfirmDeleteId(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [api])

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
    setBusy(`inspect:${id}`)
    setError(null)
    try {
      setPreview(await api.inspect(id))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const restore = async () => {
    if (!preview?.valid) return
    setBusy(`restore:${preview.id}`)
    setError(null)
    setNotice(null)
    try {
      const result = await api.restore(preview.id)
      setPreview(null)
      setNotice(`恢复完成，当前配置已保存为 ${result.preRestoreBackupId}`)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

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
    <div className="page workspace-page operations-page" data-page-id="backups">
      <header className="page-header workspace-page-header">
        <div>
          <div className="eyebrow">CONFIGURATION</div>
          <h1>配置备份</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="备份工具栏">
          <button className="icon-button" type="button" title="刷新" aria-label="刷新" onClick={refresh} disabled={loading || busy !== null}>
            <RefreshCw className={loading ? 'spin' : undefined} size={18} />
          </button>
        </div>
      </header>

      {error && <div className="operation-error" role="alert"><AlertCircle size={16} />{error}</div>}
      {notice && <div className="operation-notice" role="status"><CheckCircle2 size={16} />{notice}</div>}

      <section className="environment-section backup-create" aria-labelledby="backup-create-title">
        <div className="section-heading">
          <div>
            <h2 id="backup-create-title">创建手工备份</h2>
            <span>仅备份星芒管理的本机 AI 工具配置文件</span>
          </div>
          <div className="config-actions">
            <select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)} disabled={busy !== null} aria-label="选择 AI 工具">
              {managementProviderIds.map((id) => <option value={id} key={id}>{providerLabels[id]}</option>)}
            </select>
            <button className="primary-button" type="button" onClick={create} disabled={busy !== null || loading}>
              {busy === 'create' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              创建备份
            </button>
          </div>
        </div>
      </section>

      <section className="environment-section backup-list-section" aria-labelledby="backup-list-title">
        <div className="section-heading">
          <div>
            <h2 id="backup-list-title">备份记录</h2>
            <span>{loading ? '正在读取' : `共 ${backups.length} 个快照`}</span>
          </div>
        </div>
        {loading ? (
          <div className="operation-loading"><LoaderCircle className="spin" size={18} />正在读取备份清单</div>
        ) : backups.length ? (
          <div className="operations-list" role="list">
            {backups.map((backup) => (
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
              </article>
            ))}
          </div>
        ) : (
          <div className="operation-empty"><ArchiveRestore size={20} />还没有配置备份</div>
        )}
      </section>

      {preview && (
        <section className="environment-section restore-preview" aria-labelledby="restore-preview-title">
          <div className="section-heading">
            <div>
              <h2 id="restore-preview-title">恢复预览 · {preview.provider && providerLabels[preview.provider]}</h2>
              <span>恢复前会先备份当前配置，并重新校验清单、路径和 SHA-256</span>
            </div>
            <button className="icon-button" type="button" title="关闭预览" aria-label="关闭预览" onClick={() => setPreview(null)} disabled={busy !== null}>
              <X size={17} />
            </button>
          </div>
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
          <div className="config-actions restore-actions">
            <button className="secondary-button" type="button" onClick={() => setPreview(null)} disabled={busy !== null}>取消</button>
            <button className="danger-button" type="button" onClick={restore} disabled={!preview.valid || busy !== null}>
              {busy === `restore:${preview.id}` ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}
              确认恢复
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

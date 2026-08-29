import { CheckCircle2, Download, FileText, RefreshCw, RotateCw, ShieldCheck } from 'lucide-react'
import type { UpdateSnapshot } from '../types'

interface UpdatePageProps {
  state: UpdateSnapshot | null
  busy: boolean
  onCheck: () => void
  onDownload: () => void
  onInstall: () => void
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

const phaseLabels: Record<UpdateSnapshot['phase'], string> = {
  disabled: '本地开发包不检查更新',
  idle: '等待检查',
  checking: '正在检查更新',
  available: '发现新版本',
  'not-available': '当前已是最新版本',
  downloading: '正在下载并校验',
  downloaded: '更新已就绪',
  cancelled: '下载已取消',
  error: '更新失败',
}

export function UpdatePage({ state, busy, onCheck, onDownload, onInstall }: UpdatePageProps) {
  const phase = state?.phase ?? 'idle'
  const canCheck = !busy
    && phase !== 'disabled'
    && phase !== 'checking'
    && phase !== 'downloading'
    && !(phase === 'downloaded' && !state?.error)
  const canDownload = !busy && phase === 'available'
  const canInstall = !busy && phase === 'downloaded' && !state?.development
  const showReleaseNotes = phase === 'available' || phase === 'downloading' || phase === 'downloaded'

  return (
    <div className="page workspace-page update-page" data-page-id="updates">
      <header className="page-header workspace-page-header">
        <div>
          <div className="eyebrow">系统</div>
          <h1>检查更新</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="更新工具栏">
          <button className="secondary-button" type="button" disabled={!canCheck} onClick={onCheck}>
            <RefreshCw size={16} className={phase === 'checking' ? 'spin' : ''} />
            检查更新
          </button>
        </div>
      </header>

      <section className="management-panel update-status-panel">
        <div className="management-panel-heading">
          <span className={`status-dot ${phase === 'error' ? 'error' : ''}`} />
          <div>
            <h2>{phaseLabels[phase]}</h2>
            <p>
              当前版本 {state?.currentVersion ?? '-'}
              {phase === 'disabled' && ' · 免费分发包会启用自动更新，需同步发布完整更新文件'}
            </p>
          </div>
          <ShieldCheck size={20} />
        </div>

        {state?.availableVersion && (
          <div className="update-version-row">
            <span>可用版本</span>
            <strong>{state.availableVersion}</strong>
          </div>
        )}

        {state?.progress && (
          <div className="update-progress" aria-label="更新下载进度">
            <div><span>下载进度</span><strong>{state.progress.percent.toFixed(1)}%</strong></div>
            <progress max="100" value={state.progress.percent} />
            <small>
              {formatBytes(state.progress.transferred)} / {formatBytes(state.progress.total)}
              {' · '}{formatBytes(state.progress.bytesPerSecond)}/s
            </small>
          </div>
        )}

        {showReleaseNotes && (
          <div className="update-release-notes" aria-label="更新日志">
            <div className="update-release-notes-heading">
              <FileText size={16} />
              <div>
                <span>更新日志</span>
                <strong>{state?.releaseName || `版本 ${state?.availableVersion ?? '-'}`}</strong>
              </div>
            </div>
            <pre>{state?.releaseNotesText?.trim() || '本次更新暂未提供更新日志'}</pre>
          </div>
        )}

        {state?.error && <div className="inline-error">{state.error.message}</div>}

        <div className="management-actions">
          <button type="button" className="secondary-button" disabled={!canDownload} onClick={onDownload}>
            <Download size={16} /> 下载更新
          </button>
          <button type="button" className="primary-button" disabled={!canInstall} onClick={onInstall}>
            {phase === 'downloaded' ? <RotateCw size={16} /> : <CheckCircle2 size={16} />}
            重启并安装
          </button>
        </div>
      </section>

    </div>
  )
}

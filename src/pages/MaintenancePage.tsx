import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  LoaderCircle,
  MonitorDown,
  PackageCheck,
  RefreshCw,
  Store,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { DialogBackdrop } from '../components/Dialog'
import { errorMessage } from '../error-message'
import type {
  CodexDesktopInstallProgress,
  CodexDesktopInstallResult,
  ToolUninstallResult,
} from '../types'

export const CODEX_DESKTOP_STORE_URI = 'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS'

export type MaintenanceProviderId = 'claude' | 'codex' | 'grok' | 'gemini'
export type MaintenanceJobState = 'idle' | 'queued' | 'running' | 'success' | 'error'

export interface MaintenanceVersionStatus {
  installed: boolean
  appVersion?: string | null
  version: string | null
  mirrorVersion?: string | null
  mirrorUpdateAvailable?: boolean | null
  mirrorError?: string | null
  installDirectory: string | null
  latestVersion?: string | null
  updateAvailable?: boolean | null
  updateSource?: 'npm' | 'native' | 'windows-appx' | 'official-manifest' | 'winget' | null
  updateCheck?: 'checked' | 'failed' | 'skipped'
  updateState?: 'available' | 'latest' | 'unknown'
  updateCheckedAt?: string | null
  updateError?: string | null
}

export interface MaintenanceCliStatus extends MaintenanceVersionStatus {
  latestVersion: string | null
  updateAvailable: boolean
  uninstall: {
    available: boolean
    reason: string | null
    manualCommand: string | null
    delegated?: boolean
  }
}

export interface MaintenanceSnapshot {
  checkedAt: string
  clis: Record<MaintenanceProviderId, MaintenanceCliStatus>
  codexDesktop: MaintenanceVersionStatus & { running: boolean }
}

export interface MaintenanceProgress {
  provider: MaintenanceProviderId
  state: 'started' | 'output' | 'success' | 'error'
  message: string
}

export interface MaintenancePageApi {
  scan(forceRefresh?: boolean): Promise<MaintenanceSnapshot>
  maintainCli(provider: MaintenanceProviderId): Promise<void>
  uninstallCli(provider: MaintenanceProviderId): Promise<ToolUninstallResult>
  checkCli(provider: MaintenanceProviderId): Promise<MaintenanceCliStatus>
  installCodexDesktop(): Promise<CodexDesktopInstallResult>
  uninstallCodexDesktop(): Promise<ToolUninstallResult>
  checkCodexDesktop(): Promise<MaintenanceVersionStatus & { running: boolean }>
  openCodexDesktopStore(): Promise<void>
  onProgress?(listener: (progress: MaintenanceProgress) => void): () => void
  onDesktopProgress?(listener: (progress: CodexDesktopInstallProgress) => void): () => void
}

export interface MaintenancePageProps {
  api: MaintenancePageApi
}

const providerIds: readonly MaintenanceProviderId[] = ['codex', 'claude', 'gemini', 'grok']
const providerLabels: Record<MaintenanceProviderId, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  grok: 'Grok CLI',
}

function updateStateLabel(status: MaintenanceVersionStatus): string {
  if (!status.installed) return '未安装'
  if (status.updateState === 'available') return '可更新'
  if (status.updateState === 'latest') return '已是最新'
  if (status.updateCheck === 'failed') return '检测失败'
  return '未完成检测'
}

function updateStateClass(status: MaintenanceVersionStatus): string {
  if (status.updateState === 'latest') return 'is-pass'
  if (status.updateState === 'available') return 'is-warn'
  return 'is-warn'
}

function cliMaintenanceAction(status: MaintenanceVersionStatus): 'install' | 'update' | 'check' {
  if (!status.installed) return 'install'
  return status.updateState === 'available' ? 'update' : 'check'
}

export function cliUninstallPresentation(status: MaintenanceCliStatus): {
  available: boolean
  guidance: string | null
} {
  if (!status.installed) return { available: false, guidance: null }
  // 委派卸载同样可用，只是会另开一个以当前用户身份运行的窗口，需要先说清楚。
  if (status.uninstall.available && status.uninstall.delegated) {
    return { available: true, guidance: '将以普通用户权限打开命令窗口执行卸载，完成后请刷新' }
  }
  if (status.uninstall.available) return { available: true, guidance: null }
  const detail = [
    status.uninstall.reason,
    status.uninstall.manualCommand ? `普通 PowerShell：${status.uninstall.manualCommand}` : null,
  ].filter((value): value is string => Boolean(value))
  return {
    available: false,
    guidance: detail.join('；') || '当前安装不能由本工具安全卸载',
  }
}

function desktopProgressLabel(progress: CodexDesktopInstallProgress): string {
  if (progress.phase === 'downloading') {
    return progress.percent === null ? '正在下载安装包' : `正在下载安装包 ${Math.round(progress.percent)}%`
  }
  if (progress.phase === 'validating') return '正在校验安装包'
  if (progress.phase === 'closing') return '正在关闭 Codex 桌面端'
  if (progress.phase === 'installing') return '正在安装最新版'
  if (progress.phase === 'completed') return '安装已完成'
  return progress.message || '安装失败'
}

export function CodexDesktopInstallSourceDialog({
  installedVersion,
  latestVersion,
  mirrorVersion,
  mirrorUpdateAvailable,
  mirrorError,
  onInstall,
  onOpenStore,
  onCancel,
}: {
  installedVersion: string | null | undefined
  latestVersion: string | null | undefined
  mirrorVersion: string | null | undefined
  mirrorUpdateAvailable: boolean | null | undefined
  mirrorError: string | null | undefined
  onInstall: () => void
  onOpenStore: () => void
  onCancel: () => void
}) {
  const mirrorBlocked = Boolean(installedVersion && mirrorVersion && mirrorUpdateAvailable === false)
  const mirrorCurrent = mirrorBlocked && installedVersion === mirrorVersion
  const mirrorVersionLabel = mirrorVersion
    ? `可下载版本 ${mirrorVersion}${mirrorCurrent ? ' · 当前已安装' : mirrorBlocked ? ' · 低于当前版本' : ''}`
    : mirrorError ? '镜像版本检测失败，点击安装时会重新检测' : '镜像版本待检测'
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onCancel])

  return (
    <DialogBackdrop className="save-mode-backdrop install-source-backdrop" onDismiss={onCancel}>
      <section className="save-mode-dialog install-source-dialog" role="dialog" aria-modal="true" aria-labelledby="install-source-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon install-source-icon"><MonitorDown size={20} /></div>
            <div>
              <h3 id="install-source-title">选择 Codex 桌面端安装方式</h3>
              <p>请选择下载来源，应用内安装会显示实时进度。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" aria-label="关闭安装方式选择" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>

        <div className="install-source-options">
          <button
            type="button"
            className="install-source-option mirror-source-option"
            onClick={onInstall}
            disabled={mirrorBlocked}
            title={mirrorError ?? undefined}
          >
            <span className="install-source-option-icon"><Download size={21} /></span>
            <span className="install-source-option-copy">
              <span className="install-source-option-title">
                <strong>国内镜像</strong>
                <span className="install-source-badge">推荐</span>
              </span>
              <small>在管理工具内下载、校验并安装 Codex 桌面端</small>
              <span className="install-source-version">{mirrorVersionLabel}</span>
            </span>
            <span className="install-source-action">
              {mirrorCurrent ? '已是镜像最新版' : mirrorBlocked ? '当前版本更高' : '应用内安装'}
            </span>
          </button>

          <button type="button" className="install-source-option store-source-option" onClick={onOpenStore}>
            <span className="install-source-option-icon"><Store size={21} /></span>
            <span className="install-source-option-copy">
              <span className="install-source-option-title"><strong>微软商店</strong></span>
              <small>直接打开 Windows 本机 Microsoft Store，由商店完成安装或更新</small>
              <span className="install-source-version">官方最新 {latestVersion ?? '待检测'}</span>
            </span>
            <span className="install-source-action">打开本机微软商店 <ExternalLink size={14} /></span>
          </button>
        </div>

        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}

function ToolUninstallDialog({
  label,
  desktop,
  busy,
  onConfirm,
  onCancel,
}: {
  label: string
  desktop: boolean
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onCancel])

  return (
    <DialogBackdrop className="save-mode-backdrop" onDismiss={busy ? () => undefined : onCancel}>
      <section className="save-mode-dialog tool-uninstall-dialog" role="alertdialog" aria-modal="true" aria-labelledby="tool-uninstall-title">
        <header className="save-mode-head">
          <div>
            <div className="save-mode-icon danger-icon"><Trash2 size={20} /></div>
            <div>
              <h3 id="tool-uninstall-title">卸载 {label}？</h3>
              <p>{desktop ? '运行中的窗口会先关闭。' : ''}只移除程序本体，不删除配置、会话、Skills、Plugins 和备份。</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="取消" disabled={busy} onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <footer className="save-mode-footer">
          <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button className="danger-button" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
            {busy ? '正在卸载' : '确认卸载'}
          </button>
        </footer>
      </section>
    </DialogBackdrop>
  )
}

export function MaintenancePage({ api }: MaintenancePageProps) {
  const [snapshot, setSnapshot] = useState<MaintenanceSnapshot | null>(null)
  const [selected, setSelected] = useState<Set<MaintenanceProviderId>>(new Set())
  const [jobs, setJobs] = useState<Record<MaintenanceProviderId, { state: MaintenanceJobState; message: string }>>(() => (
    Object.fromEntries(providerIds.map((id) => [id, { state: 'idle', message: '' }])) as Record<MaintenanceProviderId, { state: MaintenanceJobState; message: string }>
  ))
  const [loading, setLoading] = useState(true)
  const [batchRunning, setBatchRunning] = useState(false)
  const [desktopInstalling, setDesktopInstalling] = useState(false)
  const [desktopProgress, setDesktopProgress] = useState<CodexDesktopInstallProgress | null>(null)
  const [desktopInstallDialogOpen, setDesktopInstallDialogOpen] = useState(false)
  const [checkingTarget, setCheckingTarget] = useState<MaintenanceProviderId | 'desktop' | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<MaintenanceProviderId | 'desktop' | null>(null)
  const [uninstallingTarget, setUninstallingTarget] = useState<MaintenanceProviderId | 'desktop' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = async (forceRefresh = false, selectionMode: 'auto' | 'preserve' = 'auto') => {
    setLoading(true)
    setError(null)
    try {
      const next = await api.scan(forceRefresh)
      setSnapshot(next)
      if (selectionMode === 'auto') {
        setSelected(new Set(providerIds.filter((provider) => cliMaintenanceAction(next.clis[provider]) !== 'check')))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [api])

  useEffect(() => api.onProgress?.((progress) => {
    setJobs((current) => ({
      ...current,
      [progress.provider]: {
        state: progress.state === 'started' || progress.state === 'output' ? 'running' : progress.state,
        message: progress.message,
      },
    }))
  }), [api])

  useEffect(() => api.onDesktopProgress?.((progress) => {
    setDesktopProgress(progress)
    if (progress.phase === 'error') setError(progress.message)
  }), [api])

  const busy = batchRunning || desktopInstalling || checkingTarget !== null || uninstallingTarget !== null
  const selectedIds = useMemo(() => providerIds.filter((id) => (
    selected.has(id)
    && snapshot
    && cliMaintenanceAction(snapshot.clis[id]) !== 'check'
  )), [selected, snapshot])

  const toggle = (provider: MaintenanceProviderId) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  const maintain = async (ids: readonly MaintenanceProviderId[]) => {
    if (!ids.length) return
    setBatchRunning(true)
    setError(null)
    setJobs((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, { state: 'queued', message: '等待执行' }])),
    }))
    for (const provider of ids) {
      setJobs((current) => ({ ...current, [provider]: { state: 'running', message: '正在安装最新版本' } }))
      try {
        await api.maintainCli(provider)
        setJobs((current) => ({ ...current, [provider]: { state: 'success', message: '已完成' } }))
      } catch (cause) {
        setJobs((current) => ({ ...current, [provider]: { state: 'error', message: errorMessage(cause) } }))
      }
    }
    await refresh(true)
    setBatchRunning(false)
  }

  const checkCli = async (provider: MaintenanceProviderId) => {
    setCheckingTarget(provider)
    setError(null)
    setJobs((current) => ({ ...current, [provider]: { state: 'running', message: '正在检查此工具的更新' } }))
    try {
      const status = await api.checkCli(provider)
      setSnapshot((current) => current ? {
        ...current,
        checkedAt: new Date().toISOString(),
        clis: { ...current.clis, [provider]: status },
      } : current)
      setJobs((current) => ({
        ...current,
        [provider]: {
          state: status.updateCheck === 'failed' ? 'error' : 'success',
          message: status.updateError ?? (status.updateState === 'available' ? `检测到新版本 ${status.latestVersion}` : '当前已是最新版'),
        },
      }))
    } catch (cause) {
      setJobs((current) => ({ ...current, [provider]: { state: 'error', message: errorMessage(cause) } }))
    } finally {
      setCheckingTarget(null)
    }
  }

  const checkDesktop = async () => {
    setCheckingTarget('desktop')
    setError(null)
    try {
      const status = await api.checkCodexDesktop()
      setSnapshot((current) => current ? {
        ...current,
        checkedAt: new Date().toISOString(),
        codexDesktop: status,
      } : current)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCheckingTarget(null)
    }
  }

  const uninstall = async (target: MaintenanceProviderId | 'desktop') => {
    setUninstallingTarget(target)
    setError(null)
    setNotice(null)
    try {
      const result = target === 'desktop'
        ? await api.uninstallCodexDesktop()
        : await api.uninstallCli(target)
      if (result.outcome === 'delegated') {
        // 卸载在另一个以当前用户身份运行的窗口里进行，此处刷新只会读到旧状态。
        setUninstallTarget(null)
        setNotice('已打开卸载窗口，请在其中完成卸载后回到本页点击刷新')
        return
      }
      if (target === 'desktop') {
        setDesktopProgress(null)
      } else {
        setJobs((current) => ({ ...current, [target]: { state: 'idle', message: '' } }))
        setSelected((current) => {
          const next = new Set(current)
          next.delete(target)
          return next
        })
      }
      setUninstallTarget(null)
      await refresh(false, 'preserve')
    } catch (cause) {
      // 关掉确认弹窗，否则错误横幅会被模态遮住
      setUninstallTarget(null)
      setError(errorMessage(cause))
    } finally {
      setUninstallingTarget(null)
    }
  }

  const installDesktopFromMirror = async () => {
    setDesktopInstalling(true)
    setDesktopProgress(null)
    setError(null)
    try {
      await api.installCodexDesktop()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      await refresh(true)
      setDesktopInstalling(false)
    }
  }

  const maintainDesktop = async () => {
    if (!snapshot) return
    const action = cliMaintenanceAction(snapshot.codexDesktop)
    if (action === 'check') {
      await refresh(true)
      return
    }
    setDesktopInstallDialogOpen(true)
  }

  const openDesktopStore = async () => {
    setDesktopInstallDialogOpen(false)
    setError(null)
    try {
      await api.openCodexDesktopStore()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="page workspace-page operations-page" data-page-id="maintenance">
      <header className="page-header workspace-page-header">
        <div>
          <div className="eyebrow">MAINTENANCE</div>
          <h1>安装维护</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="维护工具栏">
          <button className="icon-button" type="button" title="检查更新" aria-label="检查更新" onClick={() => void refresh(true)} disabled={loading || busy}>
            <RefreshCw className={loading ? 'spin' : undefined} size={18} />
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => selectedIds.length ? void maintain(selectedIds) : void refresh(true)}
            disabled={busy || loading || !snapshot}
          >
            {batchRunning
              ? <LoaderCircle className="spin" size={16} />
              : selectedIds.length ? <Wrench size={16} /> : <RefreshCw size={16} />}
            {selectedIds.length ? `批量安装 (${selectedIds.length})` : '检查更新'}
          </button>
        </div>
      </header>

      {error && <div className="operation-error" role="alert"><AlertCircle size={16} />{error}</div>}
      {notice && <div className="operation-notice" role="status"><CheckCircle2 size={16} />{notice}</div>}

      <section className="environment-section maintenance-cli-section" aria-labelledby="maintenance-cli-title">
        <div className="section-heading">
          <div>
            <h2 id="maintenance-cli-title">AI CLI</h2>
            <span>{snapshot ? `最后检测 ${new Date(snapshot.checkedAt).toLocaleString()}` : '等待本机检测'}</span>
          </div>
        </div>
        {loading ? (
          <div className="operation-loading"><LoaderCircle className="spin" size={18} />正在检测 CLI 版本</div>
        ) : snapshot ? (
          <div className="operations-list" role="list">
            {providerIds.map((provider) => {
              const status = snapshot.clis[provider]
              const job = jobs[provider]
              const active = job.state === 'queued' || job.state === 'running'
              const action = cliMaintenanceAction(status)
              const uninstall = cliUninstallPresentation(status)
              return (
                <article className="operation-row maintenance-row" key={provider} role="listitem">
                  <label className="maintenance-select">
                    <input
                      type="checkbox"
                      checked={selected.has(provider)}
                      onChange={() => toggle(provider)}
                      disabled={busy || action === 'check'}
                      aria-label={`选择 ${providerLabels[provider]}`}
                    />
                  </label>
                  <div className="operation-status-icon">
                    {active ? <LoaderCircle className="spin" size={17} /> : status.installed ? <PackageCheck size={17} /> : <Download size={17} />}
                  </div>
                  <div className="operation-row-copy">
                    <div className="operation-row-title">
                      <strong>{providerLabels[provider]}</strong>
                      <span className={`operation-state ${updateStateClass(status)}`} title={status.updateError ?? undefined}>
                        {updateStateLabel(status)}
                      </span>
                    </div>
                    <p>当前 {status.version ?? '-'} · 最新 {status.latestVersion ?? '未知'}</p>
                    {status.updateError && <span className="operation-meta job-error">{status.updateError}</span>}
                    {uninstall.guidance && (
                      <span className="operation-meta uninstall-guidance" id={`uninstall-guidance-${provider}`}>
                        {uninstall.guidance}
                      </span>
                    )}
                    {job.message && <span className={`operation-meta job-${job.state}`}>{job.message}</span>}
                  </div>
                  <div className="maintenance-row-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => action === 'check' ? void checkCli(provider) : void maintain([provider])}
                      disabled={busy || loading}
                    >
                      {active || checkingTarget === provider
                        ? <LoaderCircle className="spin" size={15} />
                        : action === 'check' ? <RefreshCw size={15} /> : <Download size={15} />}
                      {action === 'install' ? '安装' : action === 'update' ? '安装最新版' : '检查更新'}
                    </button>
                    <button
                      className="danger-button maintenance-uninstall-button"
                      type="button"
                      title={uninstall.available
                        ? `卸载 ${providerLabels[provider]}`
                        : uninstall.guidance ?? `${providerLabels[provider]} 未安装`}
                      aria-describedby={uninstall.guidance ? `uninstall-guidance-${provider}` : undefined}
                      onClick={() => setUninstallTarget(provider)}
                      disabled={busy || loading || !uninstall.available}
                    >
                      {uninstall.available ? <Trash2 size={15} /> : <AlertCircle size={15} />}
                      {status.installed && !uninstall.available ? '需手动卸载' : '卸载'}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="operation-empty"><AlertCircle size={20} />未能获取 CLI 状态</div>
        )}
      </section>

      <section className="environment-section maintenance-desktop-section" aria-labelledby="maintenance-desktop-title">
        <div className="section-heading">
          <div>
            <h2 id="maintenance-desktop-title">Codex 桌面端</h2>
            <span>Appx 本机版本 · Codex 官方更新清单</span>
          </div>
        </div>
        <div className="operation-row maintenance-row">
          <div className="operation-status-icon"><MonitorDown size={17} /></div>
          <div className="operation-row-copy">
            <div className="operation-row-title">
              <strong>Codex 桌面端</strong>
              {snapshot && (
                <span
                  className={`operation-state ${updateStateClass(snapshot.codexDesktop)}`}
                  title={snapshot.codexDesktop.updateError ?? undefined}
                >
                  {updateStateLabel(snapshot.codexDesktop)}
                </span>
              )}
            </div>
            <p>
              应用版本 {snapshot?.codexDesktop.appVersion ?? '未知'}
              {snapshot?.codexDesktop.running ? ' · 正在运行' : ''}
            </p>
            <span className="operation-meta">
              MSIX 包：当前 {snapshot?.codexDesktop.version ?? '未知'} · 官方最新 {snapshot?.codexDesktop.latestVersion ?? '未知'}
            </span>
            {snapshot?.codexDesktop.updateError && <span className="operation-meta job-error">{snapshot.codexDesktop.updateError}</span>}
            {desktopProgress && (
              <div className={`desktop-install-progress phase-${desktopProgress.phase}`} role="status" aria-live="polite">
                <div>
                  <span>{desktopProgressLabel(desktopProgress)}</span>
                  {desktopProgress.percent !== null && <strong>{Math.round(desktopProgress.percent)}%</strong>}
                </div>
                {desktopProgress.percent !== null && <progress max="100" value={desktopProgress.percent} />}
              </div>
            )}
          </div>
          <div className="maintenance-row-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => snapshot && cliMaintenanceAction(snapshot.codexDesktop) === 'check' ? void checkDesktop() : void maintainDesktop()}
              disabled={busy || loading || !snapshot}
            >
              {desktopInstalling || checkingTarget === 'desktop'
                ? <LoaderCircle className="spin" size={15} />
                : snapshot && cliMaintenanceAction(snapshot.codexDesktop) === 'check'
                  ? <RefreshCw size={15} />
                  : <Download size={15} />}
              {!snapshot
                ? '检查更新'
                : cliMaintenanceAction(snapshot.codexDesktop) === 'install'
                  ? '一键安装'
                  : cliMaintenanceAction(snapshot.codexDesktop) === 'update' ? '安装最新版' : '检查更新'}
            </button>
            <button
              className="danger-button maintenance-uninstall-button"
              type="button"
              title="卸载 Codex 桌面端"
              onClick={() => setUninstallTarget('desktop')}
              disabled={busy || loading || !snapshot?.codexDesktop.installed}
            >
              <Trash2 size={15} />卸载
            </button>
          </div>
        </div>
      </section>
      {desktopInstallDialogOpen && (
        <CodexDesktopInstallSourceDialog
          installedVersion={snapshot?.codexDesktop.version}
          latestVersion={snapshot?.codexDesktop.latestVersion}
          mirrorVersion={snapshot?.codexDesktop.mirrorVersion}
          mirrorUpdateAvailable={snapshot?.codexDesktop.mirrorUpdateAvailable}
          mirrorError={snapshot?.codexDesktop.mirrorError}
          onInstall={() => {
            setDesktopInstallDialogOpen(false)
            void installDesktopFromMirror()
          }}
          onOpenStore={() => void openDesktopStore()}
          onCancel={() => setDesktopInstallDialogOpen(false)}
        />
      )}
      {uninstallTarget && (
        <ToolUninstallDialog
          label={uninstallTarget === 'desktop' ? 'Codex 桌面端' : providerLabels[uninstallTarget]}
          desktop={uninstallTarget === 'desktop'}
          busy={uninstallingTarget === uninstallTarget}
          onConfirm={() => void uninstall(uninstallTarget)}
          onCancel={() => setUninstallTarget(null)}
        />
      )}
    </div>
  )
}

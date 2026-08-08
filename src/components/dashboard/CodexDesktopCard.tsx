import { AppWindow, Download, LoaderCircle, Settings2 } from 'lucide-react'
import { codexDesktopInstallLabel } from '../../app-shared'
import { platformPresentation } from '../../platform-presentation'
import { providers } from '../../provider-meta'
import type {
  CodexDesktopInstallProgress,
  DesktopAppStatus,
  PlatformCapabilities,
} from '../../types'
import { StatusMark } from '../StatusMark'

export function CodexDesktopCard({
  platform,
  status,
  configured,
  configExists,
  model,
  scanning,
  launchPhase,
  installing,
  installProgress,
  onConfigure,
  onInstall,
  onLaunch,
}: {
  platform: PlatformCapabilities
  status: DesktopAppStatus
  configured: boolean
  configExists: boolean
  model: string
  scanning: boolean
  launchPhase: 'idle' | 'closing' | 'opening'
  installing: boolean
  installProgress: CodexDesktopInstallProgress | null
  onConfigure: () => void
  onInstall: () => void
  onLaunch: () => void
}) {
  const busy = scanning || installing || launchPhase !== 'idle'
  const presentation = platformPresentation(platform)
  return (
    <article className="cli-card desktop-card">
      <div className="cli-card-top">
        <div className="provider-icon" style={{ color: providers.codex.color, backgroundColor: providers.codex.tint }}>
          <img src={providers.codex.icon} alt="" aria-hidden="true" />
        </div>
        <div className="cli-identity">
          <h3>Codex 桌面端</h3>
          <span>{presentation.codexDesktopCompany}</span>
        </div>
        <StatusMark installed={status.installed} loading={scanning || installing} />
      </div>
      <div className="cli-meta-row">
        <code>Codex App</code>
        <span className={
          !status.installed
            ? 'version-pill missing'
            : launchPhase !== 'idle'
              ? 'version-pill update'
              : status.running ? 'version-pill running' : 'version-pill idle'
        }>
          {installing
            ? codexDesktopInstallLabel(installProgress)
            : launchPhase === 'closing'
            ? '正在关闭'
            : launchPhase === 'opening'
              ? '正在启动'
              : scanning
            ? '检测中'
            : !status.installed
              ? '未安装'
              : status.running ? '窗口已打开' : '窗口未打开'}
        </span>
      </div>
      <div className="config-state">
        <span className={configured ? 'config-dot configured' : 'config-dot'} />
        {configured
          ? '与 Codex CLI 共用星芒配置'
          : configExists ? '共用配置需要重新配置' : '共用配置文件未创建'}
      </div>
      {status.installed && presentation.showWindowsPackages && (
        <div
          className="config-model"
          title={status.updateError ?? [
            status.appVersion ? `应用版本 ${status.appVersion}` : null,
            status.version ? `MSIX 包版本 ${status.version}` : null,
            status.latestVersion ? `官方最新包版本 ${status.latestVersion}` : null,
          ].filter(Boolean).join('；')}
        >
          <span className={`config-dot ${status.updateState === 'latest' ? 'configured' : ''}`} />
          <code>{status.version ?? '版本未知'}</code>
          <span>
            {status.updateState === 'available'
              ? `可更新至 ${status.latestVersion}`
              : status.updateState === 'latest' ? '已检查，当前最新' : status.updateError ?? '更新状态未知'}
          </span>
        </div>
      )}
      {configured && model && (
        <div className="config-model configured-model" title={model}>
          <span className="config-dot configured" />
          <code>{model}</code>
        </div>
      )}
      {installing && installProgress && (
        <div className={`desktop-install-progress phase-${installProgress.phase}`} role="status" aria-live="polite">
          <div>
            <span>{installProgress.message}</span>
            {installProgress.percent !== null && <strong>{Math.round(installProgress.percent)}%</strong>}
          </div>
          {installProgress.percent !== null && <progress max="100" value={installProgress.percent} />}
        </div>
      )}
      <div className="cli-actions">
        {!status.installed ? (
          <button className="primary-button full" onClick={presentation.codexDesktopAction === 'launch' ? onLaunch : onInstall} disabled={busy || presentation.codexDesktopAction === 'unsupported'}>
            {installing ? <LoaderCircle size={16} className="spin" /> : presentation.codexDesktopAction === 'launch' ? <AppWindow size={16} /> : <Download size={16} />}
            {installing ? '正在安装' : presentation.codexDesktopActionLabel}
          </button>
        ) : (
          <>
            {status.updateState === 'available' && (
              <button className="secondary-button grow update-button" onClick={onInstall} disabled={busy} title={`安装 Codex Desktop ${status.latestVersion}`}>
                {installing ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                {installing ? '更新中' : '安装最新版'}
              </button>
            )}
            <button className="secondary-button grow" onClick={onConfigure} disabled={busy}>
              <Settings2 size={16} />
              配置
            </button>
            <button
              className="primary-button grow launch-button"
              title="打开 Codex 桌面端"
              onClick={onLaunch}
              disabled={busy}
            >
              {launchPhase !== 'idle' ? <LoaderCircle size={16} className="spin" /> : <AppWindow size={16} />}
              {launchPhase === 'closing' ? '关闭中' : launchPhase === 'opening' ? '启动中' : '打开'}
            </button>
          </>
        )}
      </div>
    </article>
  )
}

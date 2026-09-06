import { AppWindow, Download, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react'
import { codexDesktopInstallLabel, isDetectionFailed, shortVersion } from '../../app-shared'
import { platformPresentation } from '../../platform-presentation'
import { providers } from '../../provider-meta'
import type { CodexDesktopInstallProgress, DesktopAppStatus, OfficialChatGptAccount, PlatformCapabilities } from '../../types'
import { StatusMark } from '../StatusMark'
import { OfficialChatGptMeter } from './OfficialChatGptMeter'
import { officialCodexModelHint, providerModelLabel } from '../../account-source'
import { codexDesktopUpdateDetail, codexDesktopUpdateKind } from '../../codex-desktop-update'
import { ToolRow } from './ToolRow'

export function CodexDesktopCard({
  platform, status, configured, configExists, officialLoggedIn, officialMode, officialAccountEmail,
  officialAccountPlan, officialAccountRenewsAt, officialUsage, usageRefreshing, onRefreshUsage,
  model, scanning, launchPhase, installing, installProgress, onConfigure, onInstall, onLaunch, onRetry,
}: {
  platform: PlatformCapabilities
  status: DesktopAppStatus
  configured: boolean
  configExists: boolean
  officialLoggedIn?: boolean
  officialMode?: boolean
  officialAccountEmail?: string | null
  officialAccountPlan?: string | null
  officialAccountRenewsAt?: string | null
  officialUsage?: OfficialChatGptAccount | null
  usageRefreshing?: boolean
  onRefreshUsage?: () => void
  model: string
  scanning: boolean
  launchPhase: 'idle' | 'closing' | 'opening'
  installing: boolean
  installProgress: CodexDesktopInstallProgress | null
  onConfigure: () => void
  onInstall: () => void
  onLaunch: () => void
  onRetry: () => void
}) {
  const busy = scanning || installing || launchPhase !== 'idle'
  // A confirmed install remains launchable when only the version probe failed.
  const failed = isDetectionFailed(status) && !status.installed
  const updateKind = codexDesktopUpdateKind(status)
  const presentation = platformPresentation(platform)
  const modelName = providerModelLabel(model)
  const sourceDetail = configured ? '与 Codex CLI 共用星芒配置'
    : officialLoggedIn ? `共用 ChatGPT 账号已登录${officialAccountEmail ? ` · ${officialAccountEmail}` : ''}`
      : officialMode ? '共用 ChatGPT 账号未登录'
        : configExists ? '共用配置需要重新配置' : '共用配置文件未创建'
  const launchLabel = installing ? codexDesktopInstallLabel(installProgress)
    : launchPhase === 'closing' ? '正在关闭'
      : launchPhase === 'opening' ? '正在启动'
        : scanning ? '检测中'
          : failed ? '检测失败'
            : !status.installed ? '未安装'
              : status.running ? '窗口已打开' : '窗口未打开'
  const primaryAction = failed ? (
    <button type="button" className="secondary-button" onClick={onRetry} disabled={scanning}><RefreshCw size={16} className={scanning ? 'spin' : ''} aria-hidden="true" />重试</button>
  ) : !status.installed ? (
    <button type="button" className="primary-button" onClick={presentation.codexDesktopAction === 'launch' ? onLaunch : onInstall} disabled={busy || presentation.codexDesktopAction === 'unsupported'}>
      {installing ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : presentation.codexDesktopAction === 'launch' ? <AppWindow size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
      {installing ? '正在安装' : presentation.codexDesktopActionLabel}
    </button>
  ) : (
    <button type="button" className="primary-button launch-button" title="打开 Codex 桌面端" onClick={onLaunch} disabled={busy}>
      {launchPhase !== 'idle' ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <AppWindow size={16} aria-hidden="true" />}
      {launchPhase === 'closing' ? '关闭中' : launchPhase === 'opening' ? '启动中' : '打开'}
    </button>
  )

  return <ToolRow
    providerId="codex-desktop"
    installState={installing ? 'installing' : failed ? 'failed' : status.installed ? 'installed' : 'missing'}
    identity={<>
      <div className="provider-icon" style={{ color: providers.codex.color, backgroundColor: providers.codex.tint }}><img src={providers.codex.icon} alt="" aria-hidden="true" /></div>
      <div className="cli-identity"><h3>Codex 桌面端</h3><span>{presentation.codexDesktopCompany}</span></div>
    </>}
    version={<>
      <code title={status.appVersion ?? status.version ?? undefined}>{status.installed ? shortVersion(status.appVersion ?? status.version) : '--'}</code>
      {status.installed && presentation.showWindowsPackages && (updateKind === 'installable' || updateKind === 'unknown') && <span className={`version-pill ${updateKind === 'unknown' ? 'error' : 'update'}`} title={status.updateError ?? [status.version, status.latestVersion].filter(Boolean).join(' → ')}>{codexDesktopUpdateDetail(status)}</span>}
    </>}
    source={<span title={sourceDetail}>{configured ? '星芒中转' : officialMode || officialLoggedIn ? 'ChatGPT 账号' : configExists ? '已有第三方配置' : '未连接'}</span>}
    status={<><StatusMark installed={status.installed} loading={scanning || installing} failed={failed} /><span title={status.detectionError ?? sourceDetail}>{launchLabel}</span></>}
    primaryAction={primaryAction}
    moreActions={<>
      {status.installed && <button type="button" className="icon-button" aria-label="配置 Codex 桌面端" title="配置 Codex 桌面端" onClick={onConfigure} disabled={busy}><Settings2 size={16} aria-hidden="true" /></button>}
      {status.installed && updateKind === 'installable' && <button type="button" className="icon-button" aria-label="安装 Codex 桌面端最新版" title={`安装 Codex Desktop ${status.latestVersion}`} onClick={onInstall} disabled={busy}><RefreshCw size={16} className={installing ? 'spin' : ''} aria-hidden="true" /></button>}
    </>}
  >
    {modelName ? <div className="config-model" title={modelName}><code>{modelName}</code></div> : officialLoggedIn ? <div className="config-model">{officialCodexModelHint}</div> : null}
    {officialLoggedIn && <OfficialChatGptMeter planLabel={officialAccountPlan} renewsAt={officialAccountRenewsAt} usage={officialUsage} refreshing={usageRefreshing} onRefresh={onRefreshUsage} />}
    {installing && installProgress && <div className={`desktop-install-progress phase-${installProgress.phase}`} role="status" aria-live="polite">
      <div><span>{installProgress.message}</span>{installProgress.percent !== null && <strong>{Math.round(installProgress.percent)}%</strong>}</div>
      {installProgress.percent !== null && <progress max="100" value={installProgress.percent} />}
    </div>}
  </ToolRow>
}

import { AppWindow, Download, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react'
import { codexDesktopInstallLabel, isDetectionFailed } from '../../app-shared'
import { platformPresentation } from '../../platform-presentation'
import { providers } from '../../provider-meta'
import type {
  CodexDesktopInstallProgress,
  DesktopAppStatus,
  PlatformCapabilities,
} from '../../types'
import { StatusMark } from '../StatusMark'
import { OfficialChatGptMeter } from './OfficialChatGptMeter'
import { officialCodexModelHint, providerModelLabel } from '../../account-source'
import { codexDesktopUpdateDetail, codexDesktopUpdateKind } from '../../codex-desktop-update'
import type { OfficialChatGptAccount } from '../../types'

export function CodexDesktopCard({
  platform,
  status,
  configured,
  configExists,
  officialLoggedIn,
  officialMode,
  officialAccountEmail,
  officialAccountPlan,
  officialAccountRenewsAt,
  officialUsage,
  usageRefreshing,
  onRefreshUsage,
  model,
  scanning,
  launchPhase,
  installing,
  installProgress,
  onConfigure,
  onInstall,
  onLaunch,
  onRetry,
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
  // A start-menu match or a running process can confirm `installed: true`
  // even when the Appx package probe that fills in version details rejected.
  // Only override the card when detection could not confirm installed at
  // all; a confirmed install with an incomplete version read still gets the
  // normal launch/configure actions, with the gap surfaced via updateError.
  const failed = isDetectionFailed(status) && !status.installed
  const updateKind = codexDesktopUpdateKind(status)
  const presentation = platformPresentation(platform)
  const modelName = providerModelLabel(model)
  return (
    <article
      className="cli-card desktop-card"
      data-provider-id="codex-desktop"
      data-install-state={installing ? 'installing' : failed ? 'failed' : status.installed ? 'installed' : 'missing'}
    >
      <div className="cli-card-top">
        <div className="provider-icon" style={{ color: providers.codex.color, backgroundColor: providers.codex.tint }}>
          <img src={providers.codex.icon} alt="" aria-hidden="true" />
        </div>
        <div className="cli-identity">
          <h3>Codex 桌面端</h3>
          <span>{presentation.codexDesktopCompany}</span>
        </div>
        <StatusMark installed={status.installed} loading={scanning || installing} failed={failed} />
      </div>
      <div className="cli-meta-row">
        <code>Codex App</code>
        <span
          className={
            failed
              ? 'version-pill error'
              : !status.installed
                ? 'version-pill missing'
                : launchPhase !== 'idle'
                  ? 'version-pill update'
                  : status.running ? 'version-pill running' : 'version-pill idle'
          }
          title={failed ? status.detectionError ?? undefined : undefined}
        >
          {installing
            ? codexDesktopInstallLabel(installProgress)
            : launchPhase === 'closing'
            ? '正在关闭'
            : launchPhase === 'opening'
              ? '正在启动'
              : scanning
            ? '检测中'
            : failed
              ? '检测失败'
              : !status.installed
                ? '未安装'
                : status.running ? '窗口已打开' : '窗口未打开'}
        </span>
      </div>
      <div className="config-state">
        <span className={configured || officialLoggedIn ? 'config-dot configured' : 'config-dot'} />
        {configured
          ? '与 Codex CLI 共用星芒配置'
          : officialLoggedIn
            ? officialAccountEmail
              ? `共用 ChatGPT 账号已登录 · ${officialAccountEmail}`
              : '共用 ChatGPT 账号已登录'
            : officialMode
              ? '共用 ChatGPT 账号未登录'
              : configExists ? '共用配置需要重新配置' : '共用配置文件未创建'}
      </div>
      {status.installed && presentation.showWindowsPackages && (updateKind === 'installable' || updateKind === 'unknown') && (
        <div
          className="config-model"
          title={status.updateError ?? [
            status.appVersion ? `应用版本 ${status.appVersion}` : null,
            status.version ? `MSIX 包版本 ${status.version}` : null,
            status.latestVersion ? `官方最新包版本 ${status.latestVersion}` : null,
          ].filter(Boolean).join('；')}
        >
          <span className="config-dot" />
          <code>{status.version ?? '版本未知'}</code>
          <span>{codexDesktopUpdateDetail(status)}</span>
        </div>
      )}
      {modelName ? (
        <div className="config-model configured-model" title={modelName}>
          <span className="config-dot configured" />
          <code>{modelName}</code>
        </div>
      ) : officialLoggedIn ? (
        <div className="config-model" title="官方登录不会把模型写进 config.toml，切换模型请在 Codex 窗口里操作">
          {officialCodexModelHint}
        </div>
      ) : null}
      {officialLoggedIn && (
        <OfficialChatGptMeter
          planLabel={officialAccountPlan}
          renewsAt={officialAccountRenewsAt}
          usage={officialUsage}
          refreshing={usageRefreshing}
          onRefresh={onRefreshUsage}
        />
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
        {failed ? (
          <button className="secondary-button full" onClick={onRetry} disabled={scanning}>
            <RefreshCw size={16} className={scanning ? 'spin' : ''} />
            {scanning ? '正在重新检测' : '检测失败，点击重试'}
          </button>
        ) : !status.installed ? (
          <button className="primary-button full" onClick={presentation.codexDesktopAction === 'launch' ? onLaunch : onInstall} disabled={busy || presentation.codexDesktopAction === 'unsupported'}>
            {installing ? <LoaderCircle size={16} className="spin" /> : presentation.codexDesktopAction === 'launch' ? <AppWindow size={16} /> : <Download size={16} />}
            {installing ? '正在安装' : presentation.codexDesktopActionLabel}
          </button>
        ) : (
          <>
            {updateKind === 'installable' && (
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

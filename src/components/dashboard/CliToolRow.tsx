import { Download, FolderOpen, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react'
import { isDetectionFailed, shortVersion, updateFailureLabel } from '../../app-shared'
import { officialAccountLabel, officialCodexModelHint, officialCodexSignedIn, providerConfigReadiness, providerConfigReadinessLabel, providerModelLabel } from '../../account-source'
import { platformPresentation } from '../../platform-presentation'
import { providers } from '../../provider-meta'
import type { CliStatus, OfficialChatGptAccount, PlatformCapabilities, ProviderConfigSummary, ProviderId } from '../../types'
import { StatusMark } from '../StatusMark'
import { OfficialChatGptMeter } from './OfficialChatGptMeter'
import { ToolRow } from './ToolRow'

export function CliToolRow({ provider, platform, status, config, scanning, installing, launching, runtimeReady, officialUsage, officialUsageRefreshing, onRefreshOfficialUsage, onScan, onInstall, onInstallNode, onConfigure, onLaunch }: {
  provider: ProviderId
  platform: PlatformCapabilities
  status: CliStatus
  config: ProviderConfigSummary | undefined
  scanning: boolean
  installing: boolean
  launching: ProviderId | null
  runtimeReady: boolean
  officialUsage?: OfficialChatGptAccount | null
  officialUsageRefreshing?: boolean
  onRefreshOfficialUsage?: () => void
  onScan: () => void
  onInstall: (provider: ProviderId) => void
  onInstallNode: () => void
  onConfigure: (provider: ProviderId) => void
  onLaunch: (provider: ProviderId) => void
}) {
  const meta = providers[provider]
  const presentation = platformPresentation(platform)
  const failed = isDetectionFailed(status)
  const readiness = providerConfigReadiness(config)
  const officialReady = readiness === 'official' && provider === 'codex' && officialCodexSignedIn(config)
  const officialSource = readiness === 'official' && officialAccountLabel(provider) !== null
  const modelName = providerModelLabel(config?.model)
  const sourceLabel = readiness === 'relay' ? '星芒中转'
    : readiness === 'unknown' ? '已有第三方配置'
      : officialSource ? officialAccountLabel(provider) : '未连接'
  const configLabel = officialSource && provider !== 'codex'
    ? `${officialAccountLabel(provider)} · 在工具中确认登录`
    : providerConfigReadinessLabel(config, provider, 'dashboard')
  const actionBusy = scanning || installing
  const needsConnection = readiness === 'missing' || readiness === 'unknown' || (provider === 'grok' && readiness !== 'relay')

  const primaryAction = failed ? (
    <button type="button" className="secondary-button" disabled={scanning} onClick={onScan}>
      <RefreshCw size={16} className={scanning ? 'spin' : ''} aria-hidden="true" />重试
    </button>
  ) : !status.installed ? (
    <button type="button" className="primary-button" disabled={actionBusy} onClick={() => runtimeReady ? onInstall(provider) : onInstallNode()}>
      {installing ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
      {installing ? '安装中' : !runtimeReady ? '准备环境' : presentation.grokAction === 'external-guidance' && provider === 'grok' ? presentation.grokActionLabel : '一键安装'}
    </button>
  ) : needsConnection ? (
    <button type="button" className="primary-button" disabled={installing} onClick={() => onConfigure(provider)}>
      <Settings2 size={16} aria-hidden="true" />{readiness === 'unknown' ? '检查配置' : '连接账号'}
    </button>
  ) : (
    <button type="button" className="primary-button launch-button" disabled={installing || launching !== null} onClick={() => onLaunch(provider)}>
      {launching === provider ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <FolderOpen size={16} aria-hidden="true" />}
      {launching === provider ? '启动中' : '打开'}
    </button>
  )

  return <ToolRow
    providerId={provider}
    installState={installing ? 'installing' : failed ? 'failed' : status.installed ? 'installed' : 'missing'}
    identity={<>
      <div className="provider-icon" style={{ color: meta.color, backgroundColor: meta.tint }}><img src={meta.icon} alt="" aria-hidden="true" /></div>
      <div className="cli-identity"><h3>{meta.name}</h3><span>{meta.company}</span></div>
    </>}
    version={<>
      <code title={status.version ?? undefined}>{status.installed ? shortVersion(status.version) : '--'}</code>
      {status.updateState === 'available' && <span className="version-pill update" title={`最新版本 ${status.latestVersion}`}>可更新</span>}
      {status.updateCheck === 'failed' && <span className="version-pill error" title={status.updateError ?? undefined}>{updateFailureLabel(status.updateError)}</span>}
    </>}
    source={<span title={[configLabel, config?.officialAccountEmail].filter(Boolean).join(' · ')}>{sourceLabel}</span>}
    status={<><StatusMark installed={status.installed} loading={scanning || installing} failed={failed} /><span title={status.detectionError ?? configLabel}>{installing ? '安装中' : scanning ? '检测中' : failed ? '检测失败' : !status.installed ? '未安装' : needsConnection ? '待配置' : officialSource && !officialReady ? '官方来源' : '已就绪'}</span></>}
    primaryAction={primaryAction}
    moreActions={<>
      {status.installed && <button type="button" className="icon-button" aria-label={`配置 ${meta.name}`} title={`配置 ${meta.name}`} disabled={installing} onClick={() => onConfigure(provider)}><Settings2 size={16} aria-hidden="true" /></button>}
      {status.installed && status.updateAvailable && <button type="button" className="icon-button" aria-label={`更新 ${meta.name}`} title={`更新到 ${status.latestVersion}`} disabled={actionBusy} onClick={() => onInstall(provider)}><RefreshCw size={16} className={installing ? 'spin' : ''} aria-hidden="true" /></button>}
    </>}
  >
    {modelName ? <div className="config-model" title={modelName}><code>{modelName}</code></div> : officialReady ? <div className="config-model">{officialCodexModelHint}</div> : null}
    {officialReady && <OfficialChatGptMeter planLabel={config?.officialAccountPlan} renewsAt={config?.officialAccountRenewsAt} usage={officialUsage} refreshing={officialUsageRefreshing} onRefresh={onRefreshOfficialUsage} />}
  </ToolRow>
}

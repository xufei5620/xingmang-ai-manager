import {
  BookOpen,
  Download,
  FolderOpen,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Settings2,
} from 'lucide-react'
import { isDetectionFailed, networkLocationLabel, shortVersion, updateFailureLabel } from '../../app-shared'
import { platformPresentation } from '../../platform-presentation'
import { providers } from '../../provider-meta'
import { dashboardProviderIds } from '../../provider-registry'
import type {
  AppConfigSummary,
  CodexDesktopInstallProgress,
  NodeRuntimeInstallProgress,
  PlatformCapabilities,
  ProviderId,
  SystemSnapshot,
} from '../../types'
import { RuntimeCell } from '../RuntimeCell'
import { StatusMark } from '../StatusMark'
import { CodexDesktopCard } from './CodexDesktopCard'

export function Dashboard({
  platform,
  snapshot,
  config,
  scanning,
  installing,
  cliLaunching,
  codexLaunchPhase,
  codexDesktopInstalling,
  codexDesktopInstallProgress,
  nodeRuntimeInstalling,
  nodeRuntimeInstallProgress,
  runtimeReady,
  installedCliCount,
  installedToolCount,
  onScan,
  onInstallNode,
  onOpenNodeGuide,
  onInstall,
  onInstallAll,
  onConfigure,
  onConfigureCodexDesktop,
  onInstallCodexDesktop,
  onLaunch,
  onLaunchCodexDesktop,
}: {
  platform: PlatformCapabilities
  snapshot: SystemSnapshot
  config: AppConfigSummary | null
  scanning: boolean
  installing: Set<ProviderId>
  cliLaunching: ProviderId | null
  codexLaunchPhase: 'idle' | 'closing' | 'opening'
  codexDesktopInstalling: boolean
  codexDesktopInstallProgress: CodexDesktopInstallProgress | null
  nodeRuntimeInstalling: boolean
  nodeRuntimeInstallProgress: NodeRuntimeInstallProgress | null
  runtimeReady: boolean
  installedCliCount: number
  installedToolCount: number
  onScan: () => void
  onInstallNode: () => void
  onOpenNodeGuide: () => void
  onInstall: (provider: ProviderId) => void
  onInstallAll: () => void
  onConfigure: (provider: ProviderId) => void
  onConfigureCodexDesktop: () => void
  onInstallCodexDesktop: () => void
  onLaunch: (provider: ProviderId) => void
  onLaunchCodexDesktop: () => void
}) {
  const presentation = platformPresentation(platform)
  return (
    <div className="page dashboard-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">SYSTEM OVERVIEW</div>
          <h1>工具概览</h1>
        </div>
        <div className="header-actions">
          {installedCliCount < 4 && (
            <button className="secondary-button" disabled={!runtimeReady || installing.size > 0} onClick={onInstallAll}>
              <Download size={16} />
              安装全部缺失项
            </button>
          )}
          <div
            className={`network-location${snapshot.network.region === 'unknown' ? ' unknown' : ''}`}
            title={snapshot.network.error ?? networkLocationLabel(snapshot.network)}
          >
            <Globe2 size={14} />
            <span>{networkLocationLabel(snapshot.network)}</span>
          </div>
          <button className="icon-button" title="重新检测" aria-label="重新检测" onClick={onScan} disabled={scanning}>
            <RefreshCw size={18} className={scanning ? 'spin' : ''} />
          </button>
        </div>
      </header>

      <section className="environment-section">
        <div className="section-heading">
          <div>
            <h2>本机环境</h2>
            <span>最后检测 {snapshot.checkedAt ? new Date(snapshot.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'}</span>
          </div>
          <div className="environment-heading-actions">
            {!runtimeReady && (
              <button className="runtime-guide-button" disabled={nodeRuntimeInstalling} onClick={onOpenNodeGuide}>
                <BookOpen size={13} /> 安装教程
              </button>
            )}
            <div className={runtimeReady ? 'readiness ready' : 'readiness blocked'}>
              <span />
              {runtimeReady ? '可安装 CLI' : nodeRuntimeInstalling ? '正在安装 Node.js' : '需补全前置环境'}
            </div>
          </div>
        </div>
        <div className="runtime-grid">
          <RuntimeCell label="Node.js" status={snapshot.runtime.node} loading={scanning || nodeRuntimeInstalling} busyLabel={nodeRuntimeInstalling ? '安装中...' : undefined} actionLabel={presentation.nodeAction === 'open-website' ? presentation.nodeActionLabel : snapshot.runtime.node.installed ? '升级' : '一键安装'} onInstall={onInstallNode} onRetry={onScan} />
          <RuntimeCell label="npm" status={snapshot.runtime.npm} loading={scanning || nodeRuntimeInstalling} busyLabel={nodeRuntimeInstalling ? '安装中...' : undefined} actionLabel={presentation.nodeAction === 'open-website' ? presentation.nodeActionLabel : '一键安装'} onInstall={onInstallNode} onRetry={onScan} />
          <RuntimeCell label="Python" status={snapshot.runtime.python} loading={scanning} optional onInstall={() => void window.xingmang.openExternal('https://www.python.org/downloads/')} onRetry={onScan} />
        </div>
        {nodeRuntimeInstallProgress && nodeRuntimeInstalling && (
          <div className={`node-runtime-progress dashboard-node-progress phase-${nodeRuntimeInstallProgress.phase}`} role="status" aria-live="polite">
            <div>
              <span>{nodeRuntimeInstallProgress.message}</span>
              {nodeRuntimeInstallProgress.percent !== null && <strong>{Math.round(nodeRuntimeInstallProgress.percent)}%</strong>}
            </div>
            <progress max="100" value={nodeRuntimeInstallProgress.percent ?? undefined} />
          </div>
        )}
      </section>

      <section className="cli-section">
        <div className="section-heading">
          <div>
            <h2>AI 工具</h2>
            <span>{installedToolCount}/5 个已安装</span>
          </div>
        </div>
        <div className="cli-grid">
          <CodexDesktopCard
            platform={platform}
            status={snapshot.desktopApps.codex}
            configured={Boolean(config?.providers.codex.hasApiKey && config.providers.codex.matchesRelay)}
            configExists={Boolean(config?.providers.codex.exists)}
            model={config?.providers.codex.model ?? ''}
            scanning={scanning}
            launchPhase={codexLaunchPhase}
            installing={codexDesktopInstalling}
            installProgress={codexDesktopInstallProgress}
            onConfigure={onConfigureCodexDesktop}
            onInstall={onInstallCodexDesktop}
            onLaunch={onLaunchCodexDesktop}
            onRetry={onScan}
          />
          {dashboardProviderIds.map((provider) => {
            const meta = providers[provider]
            const status = snapshot.clis[provider]
            const failed = isDetectionFailed(status)
            const isInstalling = installing.has(provider)
            const providerConfig = config?.providers[provider]
            const isConfigured = Boolean(providerConfig?.hasApiKey && providerConfig.matchesRelay)
            return (
              <article className="cli-card" key={provider}>
                <div className="cli-card-top">
                  <div className="provider-icon" style={{ color: meta.color, backgroundColor: meta.tint }}>
                    <img src={meta.icon} alt="" aria-hidden="true" />
                  </div>
                  <div className="cli-identity">
                    <h3>{meta.name}</h3>
                    <span>{meta.company}</span>
                  </div>
                  <StatusMark installed={status.installed} loading={scanning || isInstalling} failed={failed} />
                </div>
                <div className="cli-meta-row">
                  <code>{meta.command}</code>
                  <span
                    className={failed
                      ? 'version-pill error'
                      : status.updateCheck === 'failed'
                        ? 'version-pill error'
                        : status.updateState === 'available'
                          ? 'version-pill update'
                          : status.installed ? 'version-pill' : 'version-pill missing'}
                    title={failed
                      ? status.detectionError ?? undefined
                      : status.updateError ?? (status.latestVersion ? `最新版 ${status.latestVersion}` : undefined)}
                  >
                    {isInstalling
                      ? status.installed ? '更新中' : '安装中'
                      : scanning ? '检测中'
                        : failed ? '检测失败'
                          : status.updateState === 'available' ? `可更新 ${status.latestVersion}`
                            : status.updateState === 'latest' ? '已是最新'
                              : status.updateCheck === 'failed' ? updateFailureLabel(status.updateError)
                                : status.installed ? shortVersion(status.version) : '未安装'}
                  </span>
                </div>
                <div className="config-state">
                  <span className={isConfigured ? 'config-dot configured' : 'config-dot'} />
                  {providerConfig?.exists
                    ? isConfigured ? '星芒 AI 已配置' : '需要重新配置'
                    : '配置文件未创建'}
                </div>
                {isConfigured && providerConfig?.model && (
                  <div className="config-model configured-model" title={providerConfig.model}>
                    <span className="config-dot configured" />
                    <code>{providerConfig.model}</code>
                  </div>
                )}
                <div className="cli-actions">
                  {failed ? (
                    <button className="secondary-button full" disabled={scanning} onClick={onScan}>
                      <RefreshCw size={16} className={scanning ? 'spin' : ''} />
                      {scanning ? '正在重新检测' : '检测失败，点击重试'}
                    </button>
                  ) : !status.installed ? (
                    <button className="primary-button full" disabled={!runtimeReady || isInstalling || scanning} onClick={() => onInstall(provider)}>
                      {isInstalling ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                      {isInstalling ? '正在安装' : presentation.grokAction === 'external-guidance' && provider === 'grok' ? presentation.grokActionLabel : '一键安装'}
                    </button>
                  ) : (
                    <>
                      {status.updateAvailable && (
                        <button
                          className="secondary-button grow update-button"
                          disabled={isInstalling || scanning}
                          title={`更新到 ${status.latestVersion}`}
                          onClick={() => onInstall(provider)}
                        >
                          {isInstalling ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                          更新
                        </button>
                      )}
                      <button className="secondary-button grow" disabled={isInstalling} onClick={() => onConfigure(provider)}>
                        <Settings2 size={16} />
                        配置
                      </button>
                      <button
                        className="primary-button grow launch-button"
                        disabled={isInstalling || cliLaunching !== null}
                        onClick={() => onLaunch(provider)}
                      >
                        {cliLaunching === provider ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}
                        {cliLaunching === provider ? '启动中' : '打开'}
                      </button>
                    </>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}

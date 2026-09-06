import { ArrowRight, BookOpen, Download, Globe2, History, RefreshCw, UserRound } from 'lucide-react'
import { networkLocationLabel } from '../../app-shared'
import { canRefreshOfficialChatGptUsage, officialCodexSignedIn, providerConfigReadiness } from '../../account-source'
import { platformPresentation } from '../../platform-presentation'
import { dashboardProviderIds } from '../../provider-registry'
import type { AppConfigSummary, CodexDesktopInstallProgress, NodeRuntimeInstallProgress, PythonRuntimeInstallProgress, PlatformCapabilities, ProviderId, SystemSnapshot } from '../../types'
import { RuntimeCell } from '../RuntimeCell'
import { CodexDesktopCard } from './CodexDesktopCard'
import { CliToolRow } from './CliToolRow'
import { NextStepsCard, type NextStepsNudgeState } from './NextStepsCard'
import './dashboard-v3.css'

export interface DashboardAccountSummary {
  label: string
  balanceLabel: string
  usageLabel?: string
}

export function dashboardGreeting(hour: number): string {
  if (hour >= 5 && hour < 11) return '早上好'
  if (hour >= 11 && hour < 14) return '中午好'
  if (hour >= 14 && hour < 18) return '下午好'
  return '晚上好'
}

export function Dashboard({
  platform, snapshot, config, scanning, installing, cliLaunching, codexLaunchPhase,
  codexDesktopInstalling, codexDesktopInstallProgress, nodeRuntimeInstalling, nodeRuntimeInstallProgress,
  pythonRuntimeInstalling, pythonRuntimeInstallProgress, runtimeReady, installedCliCount, installedToolCount,
  nextStepsNudge, onScan, officialUsageRefreshing, onRefreshOfficialUsage, onInstallNode, onInstallPython,
  onOpenNodeGuide, onInstall, onInstallAll, onConfigure, onConfigureCodexDesktop, onInstallCodexDesktop,
  onLaunch, onLaunchCodexDesktop, onNextStepsConfigureFirstCli, onNextStepsTryLaunch,
  onNextStepsGoMaintenance, onNextStepsExploreMcp, accountSummary, onOpenAccount, onOpenHistory,
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
  pythonRuntimeInstalling: boolean
  pythonRuntimeInstallProgress: PythonRuntimeInstallProgress | null
  runtimeReady: boolean
  installedCliCount: number
  installedToolCount: number
  nextStepsNudge: NextStepsNudgeState
  onScan: () => void
  officialUsageRefreshing?: boolean
  onRefreshOfficialUsage?: () => void
  onInstallNode: () => void
  onInstallPython: () => void
  onOpenNodeGuide: () => void
  onInstall: (provider: ProviderId) => void
  onInstallAll: () => void
  onConfigure: (provider: ProviderId) => void
  onConfigureCodexDesktop: () => void
  onInstallCodexDesktop: () => void
  onLaunch: (provider: ProviderId) => void
  onLaunchCodexDesktop: () => void
  onNextStepsConfigureFirstCli: () => void
  onNextStepsTryLaunch: (provider: ProviderId | null) => void
  onNextStepsGoMaintenance: () => void
  onNextStepsExploreMcp: () => void
  accountSummary?: DashboardAccountSummary
  onOpenAccount?: () => void
  onOpenHistory?: () => void
}) {
  const presentation = platformPresentation(platform)
  const officialUsageRefresh = canRefreshOfficialChatGptUsage(config?.providers.codex) ? onRefreshOfficialUsage : undefined
  const orderedTools: Array<{ id: ProviderId | 'codexDesktop'; installed: boolean }> = [
    { id: 'claude', installed: snapshot.clis.claude.installed },
    { id: 'codex', installed: snapshot.clis.codex.installed },
    ...(platform.codexDesktop.launch ? [{ id: 'codexDesktop' as const, installed: snapshot.desktopApps.codex.installed }] : []),
    { id: 'gemini', installed: snapshot.clis.gemini.installed },
    { id: 'grok', installed: snapshot.clis.grok.installed },
  ]
  const renderTool = (entry: { id: ProviderId | 'codexDesktop'; installed: boolean }) => entry.id === 'codexDesktop' ? (
    <CodexDesktopCard key={entry.id}
      platform={platform} status={snapshot.desktopApps.codex}
      configured={Boolean(config?.providers.codex.hasApiKey && config.providers.codex.matchesRelay)} configExists={Boolean(config?.providers.codex.exists)} officialLoggedIn={officialCodexSignedIn(config?.providers.codex)}
      officialMode={providerConfigReadiness(config?.providers.codex) === 'official'} officialAccountEmail={config?.providers.codex.officialAccountEmail ?? null} officialAccountPlan={config?.providers.codex.officialAccountPlan ?? null} officialAccountRenewsAt={config?.providers.codex.officialAccountRenewsAt ?? null}
      officialUsage={snapshot.officialChatGpt} usageRefreshing={officialUsageRefreshing} onRefreshUsage={officialUsageRefresh} model={config?.providers.codex.model ?? ''} scanning={scanning} launchPhase={codexLaunchPhase} installing={codexDesktopInstalling} installProgress={codexDesktopInstallProgress} onConfigure={onConfigureCodexDesktop} onInstall={onInstallCodexDesktop} onLaunch={onLaunchCodexDesktop} onRetry={onScan} />
  ) : (
    <CliToolRow key={entry.id} provider={entry.id} platform={platform} status={snapshot.clis[entry.id]} config={config?.providers[entry.id]} scanning={scanning} installing={installing.has(entry.id)} launching={cliLaunching} runtimeReady={runtimeReady} officialUsage={snapshot.officialChatGpt} officialUsageRefreshing={officialUsageRefreshing} onRefreshOfficialUsage={officialUsageRefresh} onScan={onScan} onInstall={onInstall} onInstallNode={onInstallNode} onConfigure={onConfigure} onLaunch={onLaunch} />
  )

  return (
    <div className="page dashboard-page dashboard-v3" data-page-id="overview">
      <header className="page-header">
        <div>
          <h1>{dashboardGreeting(new Date().getHours())}{accountSummary?.label ? `，${accountSummary.label}` : ''}</h1>
          <p className="page-lead">{installedToolCount}/5 个工具已安装</p>
        </div>
        <div className="header-actions">
          <div className={`network-location${snapshot.network.region === 'unknown' ? ' unknown' : ''}`} title={snapshot.network.error ?? networkLocationLabel(snapshot.network)}>
            <Globe2 size={14} aria-hidden="true" /><span>{networkLocationLabel(snapshot.network)}</span>
          </div>
          <button type="button" className="icon-button" title="重新检测" aria-label="重新检测" onClick={onScan} disabled={scanning}>
            <RefreshCw size={18} className={scanning ? 'spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="dashboard-workspace">
        <div className="dashboard-main">
          <section className="cli-section" data-dashboard-section="tools" aria-labelledby="dashboard-tools-heading">
            <h2 id="dashboard-tools-heading" className="dashboard-visually-hidden">你的工具</h2>
            <div className="dashboard-tool-table" role="table" aria-label="AI 工具" aria-colcount={6} tabIndex={0}>
              {orderedTools.some((entry) => entry.installed) && <div className="dashboard-tool-group dashboard-tool-group-installed">
                <div className="dashboard-tool-group-heading"><div><h2>你的工具</h2><span>{installedToolCount} 个已装</span></div>{installedCliCount < dashboardProviderIds.length && <button type="button" className="secondary-button" disabled={!runtimeReady || installing.size > 0 || scanning} onClick={onInstallAll}><Download size={16} aria-hidden="true" />一键装好还缺的</button>}</div>
                <div role="rowgroup"><div className="dashboard-tool-row dashboard-tool-head" role="row">
                  {['', '工具', '来源', '状态', '操作', '更多'].map((label, index) => <span role="columnheader" key={label || `column-${index}`}>{label}</span>)}
                </div></div>
              {orderedTools.filter((entry) => entry.installed).map(renderTool)}
              </div>}
              {(orderedTools.some((entry) => !entry.installed)) && (
                <div className="dashboard-tool-group dashboard-tool-group-available">
                  <div className="dashboard-tool-group-heading"><strong>还可以装</strong><span>{orderedTools.filter((entry) => !entry.installed).length} 个</span></div>
                  <div role="rowgroup"><div className="dashboard-tool-row dashboard-tool-head" role="row">
                    {['', '工具', '来源', '状态', '操作', '更多'].map((label, index) => <span role="columnheader" key={label || `column-${index}`}>{label}</span>)}
                  </div></div>
                  {orderedTools.filter((entry) => !entry.installed).map(renderTool)}
                </div>
              )}
            </div>
          </section>
          <NextStepsCard snapshot={snapshot} config={config} nudgeState={nextStepsNudge}
            onConfigureFirstCli={onNextStepsConfigureFirstCli} onTryLaunch={onNextStepsTryLaunch}
            onGoMaintenance={onNextStepsGoMaintenance} onExploreMcp={onNextStepsExploreMcp} />
          {onOpenHistory && <section className="dashboard-recent" aria-labelledby="dashboard-history-heading">
            <div className="section-heading"><h2 id="dashboard-history-heading">使用记录</h2>
              <button type="button" className="secondary-button" onClick={onOpenHistory}><History size={16} aria-hidden="true" />查看记录<ArrowRight size={14} aria-hidden="true" /></button>
            </div>
          </section>}
        </div>
        <aside className="dashboard-aside" aria-label="环境与账号摘要">
          <section className="environment-section" data-dashboard-section="runtime" aria-labelledby="dashboard-runtime-heading">
            <div className="section-heading"><div><h2 id="dashboard-runtime-heading">运行环境</h2>
              <span>上次检查 {snapshot.checkedAt ? new Date(snapshot.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'}</span>
            </div></div>
            <div className="environment-heading-actions">
              <div className={runtimeReady ? 'readiness ready' : 'readiness blocked'}><span />{runtimeReady ? 'CLI 环境已就绪' : nodeRuntimeInstalling ? '正在安装 Node.js' : 'CLI 环境待准备'}</div>
              {!runtimeReady && <button type="button" className="runtime-guide-button" disabled={nodeRuntimeInstalling} onClick={onOpenNodeGuide}><BookOpen size={13} aria-hidden="true" />安装教程</button>}
            </div>
            <div className="runtime-grid">
              <RuntimeCell label="Node.js" status={snapshot.runtime.node} loading={scanning || nodeRuntimeInstalling} busyLabel={nodeRuntimeInstalling ? '安装中...' : undefined} actionLabel={presentation.nodeAction === 'open-website' ? presentation.nodeActionLabel : snapshot.runtime.node.installed ? '升级' : '一键安装'} onInstall={onInstallNode} onRetry={onScan} />
              <RuntimeCell label="npm" status={snapshot.runtime.npm} loading={scanning || nodeRuntimeInstalling} busyLabel={nodeRuntimeInstalling ? '安装中...' : undefined} actionLabel={presentation.nodeAction === 'open-website' ? presentation.nodeActionLabel : '一键安装'} onInstall={onInstallNode} onRetry={onScan} />
              <RuntimeCell label="Python" status={snapshot.runtime.python} loading={scanning || pythonRuntimeInstalling} busyLabel={pythonRuntimeInstalling ? '安装中...' : undefined} optional actionLabel={platform.pythonRuntimeInstall === 'managed' ? '一键安装' : '打开官网'} onInstall={onInstallPython} onRetry={onScan} />
            </div>
            {nodeRuntimeInstallProgress && nodeRuntimeInstalling && <div className={`node-runtime-progress dashboard-node-progress phase-${nodeRuntimeInstallProgress.phase}`} role="status" aria-live="polite">
              <div><span>{nodeRuntimeInstallProgress.message}</span>{nodeRuntimeInstallProgress.percent !== null && <strong>{Math.round(nodeRuntimeInstallProgress.percent)}%</strong>}</div>
              <progress max="100" value={nodeRuntimeInstallProgress.percent ?? undefined} />
            </div>}
            {pythonRuntimeInstallProgress && pythonRuntimeInstalling && <div className={`node-runtime-progress dashboard-node-progress phase-${pythonRuntimeInstallProgress.phase}`} role="status" aria-live="polite">
              <div><span>{pythonRuntimeInstallProgress.message}</span>{pythonRuntimeInstallProgress.percent !== null && <strong>{Math.round(pythonRuntimeInstallProgress.percent)}%</strong>}</div>
              <progress max="100" value={pythonRuntimeInstallProgress.percent ?? undefined} />
            </div>}
          </section>
          <section className="dashboard-account-summary" aria-labelledby="dashboard-account-heading">
            <h2 id="dashboard-account-heading">星芒账号</h2>
            <p>{accountSummary?.label ?? '账号摘要暂未获取'}</p>
            <strong className="dashboard-account-balance">{accountSummary?.balanceLabel ?? '--'}</strong>
            {accountSummary?.usageLabel && <p>{accountSummary.usageLabel}</p>}
            {onOpenAccount && <button type="button" className="secondary-button" onClick={onOpenAccount}><UserRound size={16} aria-hidden="true" />我的账号</button>}
          </section>
        </aside>
      </div>
    </div>
  )
}

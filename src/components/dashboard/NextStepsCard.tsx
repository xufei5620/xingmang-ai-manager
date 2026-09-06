import type { LucideIcon } from 'lucide-react'
import { Blocks, CheckCircle2, ChevronDown, Circle, FolderOpen, KeyRound, Sparkles, Wrench } from 'lucide-react'
import { officialAccountLabel, officialCodexSignedIn, providerConfigReadiness } from '../../account-source'
import { dashboardProviderIds } from '../../provider-registry'
import { providerIds, type AppConfigSummary, type ProviderId, type SystemSnapshot } from '../../types'

export type NextStepId =
  | 'install-first-cli'
  | 'configure-first-cli'
  | 'try-launch'
  | 'install-second-tool'
  | 'explore-mcp'

/**
 * The two milestones with no snapshot/config signal to derive from (方案 B
 * 推导表). Callers keep this in memory only (e.g. a couple of `useState`
 * booleans lifted above the page-switch ternary so navigating away and back
 * doesn't reset it) — it is never written to disk and resets on app restart.
 */
export interface NextStepsNudgeState {
  triedLaunch: boolean
  exploredMcp: boolean
}

export interface NextStepStatus {
  id: NextStepId
  done: boolean
}

export interface NextStepsSummary {
  /** Optional exploration steps never block completing the first tool setup. */
  visible: boolean
  steps: NextStepStatus[]
}

/**
 * Derive readiness from an installed tool and its own source configuration.
 * A second tool and MCP are optional; official accounts and Desktop count.
 */
export function computeNextSteps(
  snapshot: SystemSnapshot,
  config: AppConfigSummary | null,
  nudgeState: NextStepsNudgeState,
): NextStepsSummary {
  const installedCliCount = providerIds.filter((id) => snapshot.clis[id].installed).length
  const installedToolCount = installedCliCount + Number(snapshot.desktopApps.codex.installed)
  const installedFirstCli = installedToolCount >= 1
  const configuredFirstCli = config
    ? providerIds.some((id) => (snapshot.clis[id].installed || (id === 'codex' && snapshot.desktopApps.codex.installed)) && providerReady(config, id))
    : false
  const installedSecondTool = installedToolCount >= 2

  return {
    visible: !(installedFirstCli && configuredFirstCli),
    steps: [
      { id: 'install-first-cli', done: installedFirstCli },
      { id: 'configure-first-cli', done: configuredFirstCli },
      { id: 'try-launch', done: nudgeState.triedLaunch },
      { id: 'install-second-tool', done: installedSecondTool },
      { id: 'explore-mcp', done: nudgeState.exploredMcp },
    ],
  }
}

function providerReady(config: AppConfigSummary, provider: ProviderId): boolean {
  const summary = config.providers[provider]
  const readiness = providerConfigReadiness(summary)
  if (readiness === 'relay') return true
  return readiness === 'official' && officialAccountLabel(provider) !== null
    && (provider !== 'codex' || officialCodexSignedIn(summary))
}

/**
 * First installed-and-configured provider, in the same order
 * the CLI rows render (see provider-registry.ts), or null if none
 * qualify yet. Lets the "一键启动" nudge reuse the existing per-card launch
 * path without the caller having to pick a provider itself.
 */
export function resolveLaunchableProvider(
  snapshot: SystemSnapshot,
  config: AppConfigSummary | null,
): ProviderId | null {
  if (!config) return null
  return dashboardProviderIds.find((id) => {
    return snapshot.clis[id].installed && providerReady(config, id)
  }) ?? null
}

interface NextStepCopy {
  title: string
  hint?: string
  action?: {
    label: string
    icon: LucideIcon
    onClick: () => void
  }
}

export function NextStepsCard({
  snapshot,
  config,
  nudgeState,
  onConfigureFirstCli,
  onTryLaunch,
  onGoMaintenance,
  onExploreMcp,
}: {
  snapshot: SystemSnapshot
  config: AppConfigSummary | null
  nudgeState: NextStepsNudgeState
  onConfigureFirstCli: () => void
  onTryLaunch: (provider: ProviderId | null) => void
  onGoMaintenance: () => void
  onExploreMcp: () => void
}) {
  const summary = computeNextSteps(snapshot, config, nudgeState)
  if (!summary.visible) return null

  const doneCount = summary.steps.filter((step) => step.done).length
  const launchTarget = resolveLaunchableProvider(snapshot, config)

  const copy: Record<NextStepId, NextStepCopy> = {
    'install-first-cli': {
      title: '先装一个工具',
    },
    'configure-first-cli': {
      title: '连接账号或保留官方来源',
      action: { label: '连接账号', icon: KeyRound, onClick: onConfigureFirstCli },
    },
    'try-launch': {
      title: '打开试试看',
      action: { label: '打开', icon: FolderOpen, onClick: () => onTryLaunch(launchTarget) },
    },
    'install-second-tool': {
      title: '其他工具（可选）',
      action: { label: '去安装卸载', icon: Wrench, onClick: onGoMaintenance },
    },
    'explore-mcp': {
      title: '需要时再加外接工具',
      action: { label: '去外接工具', icon: Blocks, onClick: onExploreMcp },
    },
  }

  return (
    <details className="next-steps-card" aria-labelledby="next-steps-title">
      <summary className="next-steps-heading">
        <div className="next-steps-heading-icon"><Sparkles size={16} /></div>
        <div>
          <h2 id="next-steps-title">工具准备</h2>
          <span>{doneCount}/{summary.steps.length} 项已完成，扩展步骤可选</span>
        </div>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <ul className="next-steps-list">
        {summary.steps.map((step) => {
          const meta = copy[step.id]
          const ActionIcon = meta.action?.icon
          return (
            <li className={`next-steps-item${step.done ? ' is-done' : ''}`} key={step.id}>
              <span className="next-steps-status" aria-hidden="true">
                {step.done ? <CheckCircle2 size={17} /> : <Circle size={17} />}
              </span>
              <span className="next-steps-copy">
                <strong>{meta.title}</strong>
                {!step.done && meta.hint && <small>{meta.hint}</small>}
              </span>
              {!step.done && meta.action && ActionIcon && (
                <button className="secondary-button next-steps-action" type="button" onClick={meta.action.onClick}>
                  <ActionIcon size={14} />
                  {meta.action.label}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

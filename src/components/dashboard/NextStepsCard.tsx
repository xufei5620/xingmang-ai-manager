import type { LucideIcon } from 'lucide-react'
import { Blocks, CheckCircle2, Circle, FolderOpen, KeyRound, Sparkles, Wrench } from 'lucide-react'
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
  /** false once every *derivable* milestone is met — the two nudges never gate this. */
  visible: boolean
  steps: NextStepStatus[]
}

/**
 * Re-derives all five milestones from SystemSnapshot/AppConfigSummary (plus
 * the caller's session-only nudge memory) on every call — this card carries
 * zero persisted state of its own. Mirrors the derivation table in
 * docs/PROPOSAL-nav-onboarding.md 方案 B 第 3 节.
 *
 * `installedCliCount`/`installedToolCount` intentionally use the same
 * formula App.tsx already computes for its own same-named locals (a CLI
 * counts once `snapshot.clis[id].installed`; the Codex desktop app is a
 * separate, additive unit) so the two stay in lockstep by construction
 * instead of drifting apart as two independently-maintained formulas.
 */
export function computeNextSteps(
  snapshot: SystemSnapshot,
  config: AppConfigSummary | null,
  nudgeState: NextStepsNudgeState,
): NextStepsSummary {
  const installedCliCount = providerIds.filter((id) => snapshot.clis[id].installed).length
  const installedToolCount = installedCliCount + Number(snapshot.desktopApps.codex.installed)
  const installedFirstCli = installedCliCount >= 1
  const configuredFirstCli = config
    ? Object.values(config.providers).some((provider) => provider.hasApiKey && provider.matchesRelay)
    : false
  const installedSecondTool = installedToolCount >= 2

  return {
    visible: !(installedFirstCli && configuredFirstCli && installedSecondTool),
    steps: [
      { id: 'install-first-cli', done: installedFirstCli },
      { id: 'configure-first-cli', done: configuredFirstCli },
      { id: 'try-launch', done: nudgeState.triedLaunch },
      { id: 'install-second-tool', done: installedSecondTool },
      { id: 'explore-mcp', done: nudgeState.exploredMcp },
    ],
  }
}

/**
 * First installed-and-configured provider, in the same left-to-right order
 * the CLI cards render below (see provider-registry.ts), or null if none
 * qualify yet. Lets the "一键启动" nudge reuse the existing per-card launch
 * path without the caller having to pick a provider itself.
 */
export function resolveLaunchableProvider(
  snapshot: SystemSnapshot,
  config: AppConfigSummary | null,
): ProviderId | null {
  if (!config) return null
  return dashboardProviderIds.find((id) => {
    const providerConfig = config.providers[id]
    return snapshot.clis[id].installed && providerConfig.hasApiKey && providerConfig.matchesRelay
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
  // True on a manual-key site (relay-sites.ts) -- the "配上星芒 AI" step then
  // routes to the 粘贴 Key dialog instead of account login, so its copy must
  // not say "登录星芒账号" or the label would contradict what the button does.
  manualKeySite = false,
}: {
  snapshot: SystemSnapshot
  config: AppConfigSummary | null
  nudgeState: NextStepsNudgeState
  onConfigureFirstCli: () => void
  onTryLaunch: (provider: ProviderId | null) => void
  onGoMaintenance: () => void
  onExploreMcp: () => void
  manualKeySite?: boolean
}) {
  const summary = computeNextSteps(snapshot, config, nudgeState)
  if (!summary.visible) return null

  const doneCount = summary.steps.filter((step) => step.done).length
  const launchTarget = resolveLaunchableProvider(snapshot, config)

  const copy: Record<NextStepId, NextStepCopy> = {
    'install-first-cli': {
      title: '装好第一个 AI 工具',
      hint: '在下方选择一个工具，一键安装',
    },
    'configure-first-cli': {
      title: '给它配上星芒 AI',
      hint: manualKeySite ? '粘贴该站点的 Key，一键配到已装工具' : '登录星芒账号，一键把 Key 配到已装工具',
      action: { label: manualKeySite ? '粘贴 Key' : '一键配置', icon: KeyRound, onClick: onConfigureFirstCli },
    },
    'try-launch': {
      title: '打开终端试一下',
      hint: '一键启动已配置好的工具，直接开始对话',
      action: { label: '一键启动', icon: FolderOpen, onClick: () => onTryLaunch(launchTarget) },
    },
    'install-second-tool': {
      title: '再装一个工具，多个备选',
      hint: '不同工具各有所长，多装一个更从容',
      action: { label: '去维护', icon: Wrench, onClick: onGoMaintenance },
    },
    'explore-mcp': {
      title: '了解 MCP，扩展 AI 能力',
      hint: '让 AI 连接数据库、浏览器等外部工具和数据',
      action: { label: '去 MCP', icon: Blocks, onClick: onExploreMcp },
    },
  }

  return (
    <section className="next-steps-card" aria-labelledby="next-steps-title">
      <div className="next-steps-heading">
        <div className="next-steps-heading-icon"><Sparkles size={16} /></div>
        <div>
          <h2 id="next-steps-title">下一步</h2>
          <span>完成这些，把星芒 AI 用起来 · {doneCount}/{summary.steps.length}</span>
        </div>
      </div>
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
    </section>
  )
}

import type { AppConfigSummary, CliStatus, CliVersionAdvice, DesktopAppStatus, PlatformCapabilities, ProviderConfigSummary, ProviderId, SystemSnapshot, ToolStatus } from '../../../../electron/ipc-contract'
import { snapshotErrorMessage } from '../../business-common'
import { tools } from '../../registry/tools'
import {
  getSourceMarkerStorage,
  readManualSourceMarker,
  type SourceMarkerStorage,
} from './source-marker'

export type ToolId = ProviderId | 'codexDesktop'
export type ToolSource = 'account' | 'official' | 'manual' | 'unknown' | 'missing'
export interface ToolboxSnapshot {
  system: SystemSnapshot
  config: AppConfigSummary
  platform: PlatformCapabilities
}
export interface ToolPresentation {
  id: ToolId
  provider: ProviderId
  name: string
  vendor: string
  status: ToolStatus
  source: ToolSource
  model: string
  configured: boolean
  updateAvailable: boolean
  currentVersion: string | null
  latestVersion: string | null
  /** 已验证版本名单(N1)对这一行的建议;Codex 桌面端与没有名单的工具为 null。 */
  versionAdvice: CliVersionAdvice | null
  error: string | null
}

export type ToolAvailabilityState = 'unknown' | 'detectionFailed' | 'installed' | 'missing'

export interface ToolAvailability {
  state: ToolAvailabilityState
  /** 状态标签文案。 */
  label: string
  tone: 'ok' | 'warn' | 'bad' | 'neutral'
  /** 没有版本号时代替版本号的那句话。 */
  versionFallback: string
  /** 探测失败的原因原文;其余状态为 null。 */
  reason: string | null
}

/**
 * 装没装这件事有四种答案,不是两种。探测失败说明这次什么都没问出来,把它画成
 * 「未安装」会让用户对着一个其实装好了的工具反复点安装(issue #17 ①、#10);
 * 版本号同理,没探到不等于「未找到版本」。
 *
 * 这里刻意不引入真正的第三态 broken(装了但跑不起来):那要改主进程的探测异常
 * 分类,值得单开一条。
 */
export function toolAvailability(
  status: Pick<ToolStatus, 'installed' | 'detectionFailed' | 'detectionError'> | null | undefined,
  statusUnknown = false,
): ToolAvailability {
  if (status?.detectionFailed === true) {
    return {
      state: 'detectionFailed', label: '检测失败', tone: 'bad', versionFallback: '版本未读到',
      reason: snapshotErrorMessage(status.detectionError) ?? '检测没有完成，装没装无法确认',
    }
  }
  if (statusUnknown) {
    return { state: 'unknown', label: '状态未读到', tone: 'warn', versionFallback: '版本未读到', reason: null }
  }
  return status?.installed === true
    ? { state: 'installed', label: '已安装', tone: 'ok', versionFallback: '未找到版本', reason: null }
    : { state: 'missing', label: '未安装', tone: 'neutral', versionFallback: '未找到版本', reason: null }
}

/**
 * 更新检查失败的原因。`buildCliStatus` 早就写好了「版本号无法解析」「已安装版本
 * 高于源」两条,但渲染层一直没人读它们:用户只看到「更新」按钮不出现,不知道是
 * 已经最新还是这次根本没比出来。
 */
export function updateCheckFailure(
  status: Pick<CliStatus, 'updateCheck' | 'updateError'> | null | undefined,
): string | null {
  if (!status || status.updateCheck !== 'failed') return null
  return snapshotErrorMessage(status.updateError) ?? '这次更新检查没有完成，无法判断是否有新版本'
}

/** Whether the native status advertises a safe in-app uninstall operation. */
export function canUninstallTool(
  status: Pick<ToolStatus, 'uninstall'> | null | undefined,
  platformFallback = false,
): boolean {
  return status?.uninstall
    ? status.uninstall.available === true
    : platformFallback
}

export function isToolId(value: string): value is ToolId {
  return tools.some((tool) => tool.id === value)
}

export function providerFor(id: ToolId): ProviderId {
  return id === 'codexDesktop' ? 'codex' : id
}

export function sourceFor(
  config: ProviderConfigSummary,
  provider: ProviderId,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): ToolSource {
  if (provider === 'codex' && config.codexAuthMode === 'chatgpt') return 'official'
  if (provider === 'gemini' && config.authType === 'oauth-personal') return 'official'
  if (config.hasApiKey && config.matchesRelay) {
    if (config.configurationOwnership === 'account' || config.configurationOwnership === 'manual') return config.configurationOwnership
    if (readManualSourceMarker(storage, config.baseUrl, provider)) return 'manual'
    return config.configurationAccountMatched === true ? 'account' : 'unknown'
  }
  if (config.actualBaseUrl && !config.matchesRelay) return 'unknown'
  if (config.exists && !config.hasApiKey && provider !== 'grok') return 'official'
  return 'missing'
}

export function connectionReady(
  config: ProviderConfigSummary,
  provider: ProviderId,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): boolean {
  const source = sourceFor(config, provider, storage)
  if (source === 'official') return true
  if ((source !== 'account' && source !== 'manual' && !(source === 'unknown' && config.hasApiKey && config.matchesRelay)) || !config.model.trim()) return false
  return provider !== 'gemini' || config.authType === 'gemini-api-key'
}

export type CodexDesktopUpdateKind = 'latest' | 'installable' | 'store-current' | 'unknown'

/**
 * OpenAI's official MSIX feed can sit ahead of both the Microsoft Store
 * rollout and the domestic sideload mirror this app installs from, so
 * `updateAvailable` on its own does not mean anything can be installed.
 * After a Store update it reads as a stale nag on a row whose update button
 * has no package to fetch. Only a mirror build newer than the installed one
 * is actionable; an official version the mirror has not synced yet is
 * `store-current`, and a mirror probe that said nothing is `unknown`.
 */
export function codexDesktopUpdateKind(
  status: Pick<DesktopAppStatus, 'updateState' | 'mirrorUpdateAvailable'>,
): CodexDesktopUpdateKind {
  if (status.updateState === 'latest') return 'latest'
  if (status.updateState !== 'available') return 'unknown'
  if (status.mirrorUpdateAvailable === true) return 'installable'
  return status.mirrorUpdateAvailable === false ? 'store-current' : 'unknown'
}

export function presentTools(
  snapshot: ToolboxSnapshot,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): ToolPresentation[] {
  const result: ToolPresentation[] = []
  for (const definition of tools) {
    if (!isToolId(definition.id)) continue
    const id = definition.id
    if (id === 'codexDesktop' && !snapshot.platform.codexDesktop.launch) continue
    const provider = providerFor(id)
    const config = snapshot.config.providers[provider]
    const status = id === 'codexDesktop' ? snapshot.system.desktopApps.codex : snapshot.system.clis[id]
    const source = sourceFor(config, provider, storage)
    const version = id === 'codexDesktop' ? (status as DesktopAppStatus).appVersion ?? status.version : status.version
    // 桌面端走的是镜像分发而不是 npm,名单管不到它,所以这里只取 CLI 的建议。
    const versionAdvice = id === 'codexDesktop' ? null : snapshot.system.clis[id].versionAdvice ?? null
    // 桌面端只有镜像真的有新包才算「可更新」;官方清单领先商店时按下「更新」什么也装不上。
    const updateAvailable = id === 'codexDesktop'
      ? codexDesktopUpdateKind(status as DesktopAppStatus) === 'installable'
      : status.updateAvailable === true
    result.push({ id, provider, name: definition.name, vendor: definition.vendor, status, source,
      model: config.model, configured: connectionReady(config, provider, storage),
      updateAvailable, currentVersion: version,
      latestVersion: status.latestVersion ?? null, versionAdvice,
      error: status.detectionFailed ? snapshotErrorMessage(status.detectionError) ?? '工具检测没有完成' : null })
  }
  return result
}

/**
 * 名单要把用户往哪个方向挪。撞上已知问题的用户往往要往前走到修复版
 * (Codex 0.155.0 → 0.155.1),跟着 npm latest 跑到推荐版本前面的用户才是
 * 真的退回来——同一个按钮,两个方向,一律写「回到」会把前一种指反。方向由
 * 主进程比过版本号后给出(recommendedIsNewer),渲染层不自己比。
 */
export function recommendedVersionVerb(tool: Pick<ToolPresentation, 'versionAdvice'>): string {
  return tool.versionAdvice?.recommendedIsNewer ? '更新到' : '回到'
}

/**
 * 工具行副标题里的版本文案。推荐版本与当前版本一致时不出现,避免每一行都
 * 挂一句用户不需要读的话。站点信息永远不出现在这里(双站点对用户无感)。
 */
export function versionSubtitle(tool: Pick<ToolPresentation, 'currentVersion' | 'versionAdvice'>): string | undefined {
  if (!tool.currentVersion) return undefined
  const advice = tool.versionAdvice
  if (!advice || !advice.recommendedVersion || advice.onRecommended) return tool.currentVersion
  if (advice.blockedReason) return `${tool.currentVersion}（已知问题，建议${recommendedVersionVerb(tool)} ${advice.recommendedVersion}）`
  // 用户选了跟随最新版就别再劝他;有已知问题那一条上面已经先返回了。
  return advice.pinned ? `${tool.currentVersion}（推荐 ${advice.recommendedVersion}）` : tool.currentVersion
}

/** 可以一键切回推荐版本时给出那个版本号,否则 null。 */
export function rollbackVersion(tool: Pick<ToolPresentation, 'status' | 'versionAdvice'>): string | null {
  const advice = tool.versionAdvice
  return advice && tool.status.installed && advice.rollbackAvailable ? advice.recommendedVersion : null
}

export function greeting(hour: number): string {
  return hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
}

export function balanceTier(dollars: number): 'ok' | 'warn' | 'bad' {
  return dollars < 5 ? 'bad' : dollars < 20 ? 'warn' : 'ok'
}

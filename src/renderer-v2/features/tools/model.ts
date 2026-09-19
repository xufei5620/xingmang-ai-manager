import type { AppConfigSummary, CliVersionAdvice, DesktopAppStatus, PlatformCapabilities, ProviderConfigSummary, ProviderId, SystemSnapshot, ToolStatus } from '../../../../electron/ipc-contract'
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
    result.push({ id, provider, name: definition.name, vendor: definition.vendor, status, source,
      model: config.model, configured: connectionReady(config, provider, storage),
      updateAvailable: status.updateAvailable === true, currentVersion: version,
      latestVersion: status.latestVersion ?? null, versionAdvice,
      error: status.detectionFailed ? status.detectionError ?? '工具检测没有完成' : null })
  }
  return result
}

/**
 * 工具行副标题里的版本文案。推荐版本与当前版本一致时不出现,避免每一行都
 * 挂一句用户不需要读的话。站点信息永远不出现在这里(双站点对用户无感)。
 */
export function versionSubtitle(tool: Pick<ToolPresentation, 'currentVersion' | 'versionAdvice'>): string | undefined {
  if (!tool.currentVersion) return undefined
  const advice = tool.versionAdvice
  if (!advice || !advice.recommendedVersion || advice.onRecommended) return tool.currentVersion
  if (advice.blockedReason) return `${tool.currentVersion}（不兼容，建议回到 ${advice.recommendedVersion}）`
  // 用户选了跟随最新版就别再劝他;不兼容那一条上面已经先返回了。
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

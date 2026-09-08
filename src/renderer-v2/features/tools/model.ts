import type { AppConfigSummary, DesktopAppStatus, PlatformCapabilities, ProviderConfigSummary, ProviderId, SystemSnapshot, ToolStatus } from '../../../../electron/ipc-contract'
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
    return readManualSourceMarker(storage, config.baseUrl, provider) ? 'manual' : 'account'
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
  if ((source !== 'account' && source !== 'manual') || !config.model.trim()) return false
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
    result.push({ id, provider, name: definition.name, vendor: definition.vendor, status, source,
      model: config.model, configured: connectionReady(config, provider, storage),
      updateAvailable: status.updateAvailable === true, currentVersion: version,
      latestVersion: status.latestVersion ?? null, error: status.detectionFailed ? status.detectionError ?? '工具检测没有完成' : null })
  }
  return result
}

export function greeting(hour: number): string {
  return hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
}

export function balanceTier(dollars: number): 'ok' | 'warn' | 'bad' {
  return dollars < 5 ? 'bad' : dollars < 20 ? 'warn' : 'ok'
}

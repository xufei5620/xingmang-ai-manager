import { accountSiteId, type AccountSiteId } from '../../account-context'
import {
  providerIds,
  type AppConfigSummary,
  type AppSettingsV2,
  type ProviderId,
  type SystemSnapshot,
  type XingmangApi,
} from '../../../../electron/ipc-contract'
import { tools } from '../../registry/tools'
import { connectionReady, sourceFor } from './model'
import {
  getSourceMarkerStorage,
  writeManualSourceMarker,
  type SourceMarkerStorage,
} from './source-marker'

export type AccountBootstrapPhase =
  | 'syncing'
  | 'inspecting'
  | 'configuring'
  | 'verifying'
export type AccountBootstrapMode = 'login' | 'restore'

export interface AccountBootstrapProgress {
  phase: AccountBootstrapPhase
  label: string
  percent: number
}

export interface AccountBootstrapSkip {
  provider: ProviderId
  reason: 'not-installed' | 'detection-failed' | 'configured' | 'official' | 'manual' | 'unknown'
  message: string
}

export interface AccountBootstrapPlan {
  targets: ProviderId[]
  skipped: AccountBootstrapSkip[]
  preferredModels: Partial<Record<ProviderId, string>>
}

export interface AccountBootstrapResult {
  readyKeys: ProviderId[]
  configured: ProviderId[]
  failed: Array<{ provider: ProviderId; message: string }>
  skipped: AccountBootstrapSkip[]
  warnings: string[]
}

export type AccountBootstrapBridge = Pick<
  XingmangApi,
  | 'syncManagedCliKeys'
  | 'scanSystem'
  | 'getConfig'
  | 'getSettings'
  | 'configureManagedCliKeys'
  | 'getAccountSession'
>

const nameOf = (provider: ProviderId) =>
  tools.find((tool) => tool.id === provider)?.name ?? provider

function installedState(system: SystemSnapshot, provider: ProviderId) {
  if (provider !== 'codex') {
    const status = system.clis[provider]
    return {
      installed: status.installed,
      detectionFailed: status.detectionFailed === true,
    }
  }
  const cli = system.clis.codex
  const desktop = system.desktopApps.codex
  return {
    installed: cli.installed || desktop.installed,
    detectionFailed:
      !cli.installed &&
      !desktop.installed &&
      (cli.detectionFailed === true || desktop.detectionFailed === true),
  }
}

export function accountBootstrapPlan(
  system: SystemSnapshot,
  config: AppConfigSummary,
  settings: AppSettingsV2,
  mode: AccountBootstrapMode = 'login',
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): AccountBootstrapPlan {
  const explicitOfficial = new Set(settings.officialProviders ?? [])
  const targets: ProviderId[] = []
  const skipped: AccountBootstrapSkip[] = []
  const preferredModels: Partial<Record<ProviderId, string>> = {}

  for (const provider of providerIds) {
    const local = installedState(system, provider)
    const current = config.providers[provider]
    if (local.detectionFailed) {
      skipped.push({
        provider,
        reason: 'detection-failed',
        message: `${nameOf(provider)} 的安装状态没有检测完成，暂未改动配置`,
      })
      continue
    }
    if (!local.installed) {
      skipped.push({
        provider,
        reason: 'not-installed',
        message: `${nameOf(provider)} 尚未安装，Key 已保留在账号中`,
      })
      continue
    }

    const source = sourceFor(current, provider, storage)
    const official =
      explicitOfficial.has(provider) ||
      (provider === 'codex' && current.codexAuthMode === 'chatgpt') ||
      (provider === 'gemini' && current.authType === 'oauth-personal') ||
      source === 'official'
    if (official) {
      skipped.push({
        provider,
        reason: 'official',
        message: `${nameOf(provider)} 保留官方账号连接`,
      })
      continue
    }
    if (source === 'manual') {
      skipped.push({
        provider,
        reason: 'manual',
        message: `${nameOf(provider)} 保留手动填写的密钥`,
      })
      continue
    }
    if (source === 'unknown') {
      skipped.push({
        provider,
        reason: 'unknown',
        message: `${nameOf(provider)} 保留已有第三方配置`,
      })
      continue
    }
    if (source === 'account' && mode === 'restore' && connectionReady(current, provider, storage)) {
      skipped.push({
        provider,
        reason: 'configured',
        message: `${nameOf(provider)} 已连接星芒账号`,
      })
      continue
    }

    targets.push(provider)
    const model = current.model.trim()
    if (model) preferredModels[provider] = model
  }

  return { targets, skipped, preferredModels }
}

export function configurationFailure(
  config: AppConfigSummary,
  provider: ProviderId,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): string | null {
  const current = config.providers[provider]
  if (!current.hasApiKey) return '配置文件未检测到 API Key'
  if (!current.matchesRelay) return '服务地址尚未与当前账号匹配'
  if (!current.model.trim()) return '默认模型尚未写入'
  if (provider === 'gemini' && current.authType !== 'gemini-api-key') return 'Gemini 尚未切换到 API Key 模式'
  return connectionReady(current, provider, storage) ? null : '工具连接尚未完成'
}

export function shouldShowAccountBootstrap(config: AppConfigSummary): boolean {
  return providerIds.some(
    (provider) => sourceFor(config.providers[provider], provider) === 'missing',
  )
}

async function assertAccount(
  api: Pick<AccountBootstrapBridge, 'getAccountSession'>,
  expectedUserId: number,
  expectedSiteId?: AccountSiteId,
) {
  const session = await api.getAccountSession()
  if (!session.authenticated || session.account?.userId !== expectedUserId || (expectedSiteId !== undefined && accountSiteId(session) !== expectedSiteId)) {
    throw new Error('星芒账号已变化，已停止本次 Key 配置')
  }
  return accountSiteId(session)
}

export async function bootstrapAccountTools(
  api: AccountBootstrapBridge,
  expectedUserId: number,
  onProgress: (progress: AccountBootstrapProgress) => void = () => undefined,
  mode: AccountBootstrapMode = 'login',
  onlyProviders?: readonly ProviderId[],
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): Promise<AccountBootstrapResult> {
  const expectedSiteId = await assertAccount(api, expectedUserId)
  onProgress({ phase: 'syncing', label: '正在同步账号专属 Key', percent: 15 })

  let synchronized: Awaited<ReturnType<AccountBootstrapBridge['syncManagedCliKeys']>> | null = null
  let syncError = ''
  try {
    synchronized = await api.syncManagedCliKeys()
  } catch (error) {
    syncError = error instanceof Error ? error.message : '账号专属 Key 没有同步完成'
  }

  await assertAccount(api, expectedUserId, expectedSiteId)
  onProgress({ phase: 'inspecting', label: '正在检查已安装工具和连接来源', percent: 40 })
  const [system, config, settings] = await Promise.all([
    api.scanSystem(true),
    api.getConfig(),
    api.getSettings(),
  ])
  await assertAccount(api, expectedUserId, expectedSiteId)
  const planned = accountBootstrapPlan(system, config, settings, mode, storage)
  const permitted = onlyProviders ? new Set(onlyProviders) : null
  const plan = permitted
    ? { ...planned, targets: planned.targets.filter((provider) => permitted.has(provider)) }
    : planned

  let outcome: Awaited<ReturnType<AccountBootstrapBridge['configureManagedCliKeys']>> = {
    configured: [],
    failed: [],
  }
  if (plan.targets.length) {
    onProgress({
      phase: 'configuring',
      label: `正在为 ${plan.targets.length} 个已安装工具写入 Key`,
      percent: 65,
    })
    outcome = await api.configureManagedCliKeys({
      providers: plan.targets,
      preferredModels: plan.preferredModels,
    })
  }

  await assertAccount(api, expectedUserId, expectedSiteId)
  onProgress({ phase: 'verifying', label: '正在复核 Key、服务地址和模型', percent: 88 })
  const verified = await api.getConfig()
  await assertAccount(api, expectedUserId, expectedSiteId)

  const configured: ProviderId[] = []
  const failed: Array<{ provider: ProviderId; message: string }> = []
  for (const provider of plan.targets) {
    const problem = configurationFailure(verified, provider, storage)
    if (!problem) {
      configured.push(provider)
      if (outcome.configured.includes(provider)) {
        writeManualSourceMarker(
          storage,
          verified.providers[provider].baseUrl,
          provider,
          false,
        )
      }
    }
    else {
      const reported = outcome.failed.find((entry) => entry.provider === provider)
      failed.push({ provider, message: reported?.message || problem })
    }
  }

  const readyKeys = synchronized?.ready.map((entry) => entry.provider) ?? []
  const warnings = [
    ...(syncError ? [`Key 同步阶段：${syncError}`] : []),
    ...(synchronized?.storageWarning
      ? [`本机加密缓存：${synchronized.storageWarning}`]
      : []),
    ...(synchronized?.imageSkillWarning
      ? [synchronized.imageSkillWarning]
      : []),
    ...(synchronized?.failed ?? [])
      .filter(
        (entry) =>
          !configured.includes(entry.provider) &&
          !failed.some((item) => item.provider === entry.provider),
      )
      .map((entry) => `${nameOf(entry.provider)}：${entry.message}`),
  ]

  return { readyKeys, configured, failed, skipped: plan.skipped, warnings }
}

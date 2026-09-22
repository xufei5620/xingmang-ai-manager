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
import { userFacingErrorMessage } from '../../business-common'
import { networkBlockedFailures } from './online-resync'
import {
  applyManualSourceMarker,
  getSourceMarkerStorage,
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
  /**
   * 这一轮没写完，且拦住它的全是网络。断网启动时首页横幅要换一句话，联网之后
   * 还要据此补跑一次（online-resync.ts）。判定放在这里，是因为 Key 同步那一侧的
   * 失败（synchronized.failed）出了这个函数就被拼成 warnings 文本，调用方再想
   * 分辨哪条是网络问题就只能猜。
   */
  networkBlocked: boolean
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

function nameOf(provider: ProviderId) {
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}

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
        message: `${nameOf(provider)} 保留来源尚未确认的已有配置`,
      })
      continue
    }
    if (source === 'account' && current.configurationOwnership !== 'account') {
      // Matching a cached account key restores its badge, not permission to rewrite it.
      const ready = connectionReady(current, provider, storage)
      skipped.push({
        provider,
        reason: ready ? 'configured' : 'unknown',
        message: ready ? `${nameOf(provider)} 已连接星芒账号` : `${nameOf(provider)} 保留已有账号配置，待手动补全`,
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

/**
 * 写入账号 Key 后复核不通过的原因。集中成一份，是因为同一个失败会在首页横幅、
 * 维护页和客服脚本里被原样引用，散在判断里写就会各说各话。文案以「当前账号」
 * 为主语：用户不需要知道背后连的是哪个站点。
 */
export const configurationFailureMessages = {
  missingKey: '配置文件里没有检测到密钥',
  relayMismatch: '服务地址尚未与当前账号匹配',
  missingModel: '默认模型尚未写入配置',
  geminiAuthMode: 'Gemini 尚未切换到 API Key 模式',
  unconfirmedSource: '配置来源尚未确认属于当前账号',
  connectionIncomplete: '工具连接尚未完成',
} as const

export function configurationFailure(
  config: AppConfigSummary,
  provider: ProviderId,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): string | null {
  const current = config.providers[provider]
  if (!current.hasApiKey) return configurationFailureMessages.missingKey
  if (!current.matchesRelay) return configurationFailureMessages.relayMismatch
  if (!current.model.trim()) return configurationFailureMessages.missingModel
  if (provider === 'gemini' && current.authType !== 'gemini-api-key') return configurationFailureMessages.geminiAuthMode
  if (current.configurationOwnership !== 'account' || sourceFor(current, provider, storage) !== 'account') return configurationFailureMessages.unconfirmedSource
  return connectionReady(current, provider, storage) ? null : configurationFailureMessages.connectionIncomplete
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
    // 这条不是给用户的主提示，而是拼进 warnings 的诊断行（「Key 同步阶段：…」已交代
    // 了场景），所以只脱敏、保留原文，不替换成一句通用文案。
    syncError = userFacingErrorMessage(error) || '账号专属 Key 没有同步完成'
  }

  await assertAccount(api, expectedUserId, expectedSiteId)
  onProgress({ phase: 'inspecting', label: '正在检查已安装工具和连接来源', percent: 40 })
  const [system, config, settings] = await Promise.all([
    // 这里只读「装没装、探测有没有失败」，而 scanSystem 从不缓存安装状态——
    // force 清掉的是 npm 最新版与网络位置那几份缓存，跟这份计划无关，白清一次
    // 就是开机时多打七八个外网请求、Windows 上多读一遍 Appx 清单。
    api.scanSystem(),
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
  const markerWarnings: string[] = []
  for (const provider of plan.targets) {
    const reported = outcome.failed.find((entry) => entry.provider === provider)
    if (reported) {
      failed.push({ provider, message: reported.message || '账号 Key 配置失败' })
      continue
    }
    const problem = outcome.configured.includes(provider)
      ? configurationFailure(verified, provider, storage)
      : '账号 Key 配置未返回成功结果'
    if (problem) {
      failed.push({ provider, message: problem })
      continue
    }
    configured.push(provider)
    const markerWarning = applyManualSourceMarker(
      storage,
      verified.providers[provider].baseUrl,
      provider,
      false,
    )
    if (markerWarning) markerWarnings.push(`${nameOf(provider)}：${markerWarning}`)
  }

  const readyKeys = synchronized?.ready.map((entry) => entry.provider) ?? []
  const warnings = [
    ...(syncError ? [`Key 同步阶段：${syncError}`] : []),
    ...markerWarnings,
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

  // 只看「这次为什么没写成」的那几条：syncError（整次同步都没发出去）、逐个工具的
  // Key 签发失败、逐个工具的配置失败。加密缓存警告、来源标记警告和图片技能提示
  // 不在其列——它们换个网络也一样，拿来当断网证据会让补跑白跑。
  const failureSignals = [
    ...(syncError ? [syncError] : []),
    ...(synchronized?.failed ?? []).map((entry) => entry.message),
    ...failed.map((entry) => entry.message),
  ]

  return {
    readyKeys,
    configured,
    failed,
    skipped: plan.skipped,
    warnings,
    networkBlocked: networkBlockedFailures(failureSignals),
  }
}

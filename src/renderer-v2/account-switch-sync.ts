import { resolveRelaySite } from '../../electron/ipc-contract'
import { tools } from './registry/tools'
import { errorMessage } from './business-common'
import {
  getSourceMarkerStorage,
  readManualSourceMarker,
  writeManualSourceMarker,
  type SourceMarkerStorage,
} from './features/tools/source-marker'
import type { V2Bridge } from './types'

type Provider = Parameters<
  V2Bridge['configureManagedCliKeys']
>[0]['providers'][number]
type Config = Awaited<ReturnType<V2Bridge['getConfig']>>['providers'][Provider]
export type AccountSwitchBridge = Pick<
  V2Bridge,
  'switchSavedAccount' | 'getAccountSession' | 'configureManagedCliKeys'
> & {
  getConfig(): Promise<{ providers: AccountSyncContext['configs'] }>
  scanSystem(refresh?: boolean): Promise<{ clis: AccountSyncContext['clis'] }>
  getSettings(): Promise<{
    officialProviders?: Provider[]
    relaySiteId?: string
  }>
}
export interface AccountSyncContext {
  configs: Record<
    Provider,
    Pick<
      Config,
      | 'baseUrl'
      | 'hasApiKey'
      | 'matchesRelay'
      | 'model'
      | 'codexAuthMode'
      | 'authType'
    >
  >
  clis: Record<Provider, { installed: boolean; detectionFailed?: boolean }>
  officialProviders: readonly Provider[]
  origin: string
}
export interface AccountSyncCandidate {
  provider: Provider
  name: string
  eligible: boolean
  reason: string
  model: string
}
export interface AccountSwitchSyncResult {
  accountId: string
  userId: number
  origin: string
  configured: Provider[]
  failed: Array<{ provider: Provider; message: string }>
  skipped: Array<{ provider: Provider; message: string }>
}
const isProvider = (value: string): value is Provider =>
  ['claude', 'codex', 'gemini', 'grok'].includes(value)
export function sameAccountOrigin(actual: string, expected: string): boolean {
  try {
    const left = new URL(actual)
    const right = new URL(expected)
    return (
      left.protocol === 'https:' &&
      right.protocol === 'https:' &&
      !left.username &&
      !left.password &&
      !right.username &&
      !right.password &&
      left.origin === right.origin
    )
  } catch {
    return false
  }
}
export function accountSyncCandidates(
  context: AccountSyncContext,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): AccountSyncCandidate[] {
  return tools
    .filter((tool) => tool.kind === 'cli' && isProvider(tool.id))
    .flatMap((tool) => {
      const provider = tool.id
      if (!isProvider(provider)) return []
      const config = context.configs[provider]
      const status = context.clis[provider]
      const official =
        context.officialProviders.includes(provider) ||
        (provider === 'codex' && config.codexAuthMode === 'chatgpt') ||
        (provider === 'gemini' && config.authType === 'oauth-personal')
      const manual =
        config.hasApiKey &&
        config.matchesRelay &&
        readManualSourceMarker(storage, config.baseUrl, provider)
      const reason = status.detectionFailed
        ? '尚未完成检测'
        : !status.installed
          ? '尚未安装'
          : official
            ? '官方账号'
            : manual
              ? '手动填写密钥'
            : !config.hasApiKey
              ? '还没有配置密钥'
              : !config.matchesRelay
                ? '已有第三方配置'
                : '星芒密钥'
      return [
        {
          provider,
          name: tool.name,
          eligible: reason === '星芒密钥' || reason === '手动填写密钥',
          reason,
          model: config.model,
        },
      ]
    })
}
export async function readAccountSyncContext(
  api: Pick<AccountSwitchBridge, 'getConfig' | 'scanSystem' | 'getSettings'>,
  refresh = false,
): Promise<AccountSyncContext> {
  const [config, system, settings] = await Promise.all([
    api.getConfig(),
    api.scanSystem(refresh),
    api.getSettings(),
  ])
  const site = resolveRelaySite(settings.relaySiteId)
  return {
    configs: config.providers,
    clis: system.clis,
    officialProviders: settings.officialProviders ?? [],
    origin: new URL(site.accountBaseUrl ?? site.websiteUrl).origin,
  }
}

export async function switchAccountWithOptionalSync(
  api: AccountSwitchBridge,
  target: { id: string; userId: number; origin: string },
  selected: readonly Provider[],
  context: AccountSyncContext | null,
  activeOrigin: string,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): Promise<AccountSwitchSyncResult> {
  if (!sameAccountOrigin(target.origin, activeOrigin))
    throw new Error('这个账号属于其他站点，请先切换对应的服务站点。')
  const requested = [...new Set(selected)]
  if (requested.length && !context)
    throw new Error('工具状态尚未读取，请重新检测后再选择同步。')
  if (
    requested.length &&
    context &&
    !sameAccountOrigin(context.origin, activeOrigin)
  )
    throw new Error('服务站点已变化，请重新检测工具后再选择同步。')
  const original = context ? accountSyncCandidates(context, storage) : []
  const approved = requested.filter((id) =>
    original.some((item) => item.provider === id && item.eligible),
  )
  const session = await api.switchSavedAccount(target.id)
  if (!session.authenticated || session.account?.userId !== target.userId)
    throw new Error('账号切换结果需要确认，工具配置尚未修改。')
  const result: AccountSwitchSyncResult = {
    accountId: target.id,
    userId: target.userId,
    origin: target.origin,
    configured: [],
    failed: [],
    skipped: requested
      .filter((id) => !approved.includes(id))
      .map((provider) => ({ provider, message: '未满足同步条件，保持原配置' })),
  }
  if (!approved.length) return result
  try {
    const fresh = await readAccountSyncContext(api, true)
    const active = await api.getAccountSession()
    if (
      !active.authenticated ||
      active.account?.userId !== target.userId ||
      !sameAccountOrigin(fresh.origin, target.origin)
    )
      throw new Error('账号或服务站点已变化，已停止同步工具密钥。')
    const candidates = accountSyncCandidates(fresh, storage)
    const allowed = approved.filter((id) =>
      candidates.some((item) => item.provider === id && item.eligible),
    )
    for (const provider of approved.filter((id) => !allowed.includes(id)))
      result.skipped.push({
        provider,
        message: `${candidates.find((item) => item.provider === provider)?.reason ?? '当前状态不可用'}，保持原配置`,
      })
    if (!allowed.length) return result
    const preferredModels: Partial<Record<Provider, string>> = {}
    for (const provider of allowed) {
      const model = fresh.configs[provider].model.trim()
      if (model) preferredModels[provider] = model
    }
    const outcome = await api.configureManagedCliKeys({
      providers: allowed,
      preferredModels,
    })
    result.configured = outcome.configured.filter((id) => allowed.includes(id))
    for (const provider of result.configured) {
      writeManualSourceMarker(
        storage,
        fresh.configs[provider].baseUrl,
        provider,
        false,
      )
    }
    result.failed = outcome.failed.filter((entry) =>
      allowed.includes(entry.provider),
    )
    for (const provider of allowed)
      if (
        !result.configured.includes(provider) &&
        !result.failed.some((entry) => entry.provider === provider)
      )
        result.failed.push({
          provider,
          message: '没有收到配置完成结果，请重新检测',
        })
  } catch (error) {
    result.failed = approved
      .filter(
        (provider) =>
          !result.configured.includes(provider) &&
          !result.skipped.some((entry) => entry.provider === provider),
      )
      .map((provider) => ({ provider, message: errorMessage(error) }))
  }
  return result
}

const previousResults = new Map<string, AccountSwitchSyncResult>()
const resultKey = (origin: string, userId: number) => `${origin}:${userId}`
export function preserveAccountSwitchResult(result: AccountSwitchSyncResult) {
  previousResults.set(resultKey(result.origin, result.userId), result)
  if (previousResults.size > 16)
    previousResults.delete(previousResults.keys().next().value!)
}
export const previousAccountSwitchResult = (origin: string, userId: number) =>
  previousResults.get(resultKey(origin, userId)) ?? null

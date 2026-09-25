import { managedCliKeyProfiles, resolveManagedCliKeyProfiles, providerIds, sub2ApiManagedCliKeyProfiles, type ProviderId } from './catalog'
import { resolveDefaultCliModel } from './cli-model-defaults'
import { isKeyQuotaExhaustedMessage, managedKeyQuotaExhaustedMessage } from './account-key-quota'
import { loadManagedCliGroups, subscriptionsBindKeyGroups } from './managed-cli-groups'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import { NewApiNetworkError } from './new-api-client'
import { RealmAccountError } from './realm-account'
import type { RelayBackendClient } from './relay-backend'
import type { ConfigSavePayload, SystemService } from './system-service'

export interface ManagedCliKeyStatus {
  provider: ProviderId
  group: string
  name: string
}

export interface ManagedCliKeyFailure {
  provider: ProviderId
  group: string
  message: string
  /** 服务在维护或被防护层拦住（统一分类），不是 Key、分组或配置的问题；缺省 = 不是。 */
  serviceUnavailable?: boolean
}

export interface ManagedCliKeySyncSummary {
  ready: ManagedCliKeyStatus[]
  failed: ManagedCliKeyFailure[]
  /**
   * 这一轮 Key 换了分组的工具（买了订阅换进订阅分组、订阅到期换回来、分组改名）。
   * 已连好的工具开机时本不重写，这几家例外：配置里那把旧 Key 已经不扣该扣的额度了。
   * 缺省 = 没有。
   */
  regrouped?: ProviderId[]
  storageWarning?: string
  imageSkillWarning?: string
}

export interface ManagedCliConfigurationOutcome {
  configured: ProviderId[]
  failed: Array<{ provider: ProviderId; message: string; serviceUnavailable?: boolean }>
}

/** new-api 与 Sub2API 两条后端各自的「服务暂时不可用」错误（network-failure.ts 的统一分类）。 */
export function isServiceUnavailableError(error: unknown): boolean {
  return (error instanceof NewApiNetworkError && error.reason === 'serviceUnavailable')
    || (error instanceof RealmAccountError && error.code === 'UNAVAILABLE')
}

export interface ManagedCliKeyStoreLike {
  read(userId: number): Promise<StoredManagedCliKey[]>
  save(userId: number, keys: readonly StoredManagedCliKey[], expectedRevision?: number): Promise<void | boolean>
  remove(userId: number, keyId: number): Promise<void>
  captureRevision?: () => number
}

interface ResolvedManagedCliKeys {
  keys: StoredManagedCliKey[]
  failed: ManagedCliKeyFailure[]
  regrouped: ProviderId[]
  storageWarning?: string
}

type ManagedKeyAccountService = Pick<RelayBackendClient,
  'getSessionState' | 'provisionCliKey' | 'getSessionRevision' | 'getActiveSiteId' | 'listUsableGroups'>
  & Partial<Pick<RelayBackendClient, 'getSubscriptionSelf'>>

class AccountSessionChangedError extends Error {
  constructor() {
    super('星芒账号已切换，已停止本次 API Key 初始化')
    this.name = 'AccountSessionChangedError'
  }
}

const inFlightResolutions = new WeakMap<object, Map<string, Promise<ResolvedManagedCliKeys>>>()

interface AccountSessionCapture {
  readonly userId: number
  readonly revision: number | null
}

function authenticatedSession(accountService: ManagedKeyAccountService): AccountSessionCapture {
  const session = accountService.getSessionState()
  const userId = session.account?.userId
  if (!session.authenticated || !userId) throw new Error('请先登录星芒账号')
  const revision = accountService.getSessionRevision?.()
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new AccountSessionChangedError()
  return { userId, revision: revision ?? null }
}

function assertSameAuthenticatedUser(
  accountService: ManagedKeyAccountService,
  expected: AccountSessionCapture,
): void {
  const session = accountService.getSessionState()
  const revision = accountService.getSessionRevision?.()
  if (!session.authenticated || session.account?.userId !== expected.userId
    || (expected.revision !== null && revision !== expected.revision)) {
    throw new AccountSessionChangedError()
  }
}

function rethrowAccountSessionChange(error: unknown): void {
  if (error instanceof AccountSessionChangedError) throw error
}

function isCredentialFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/(?:服务返回|返回)\s*401\b/i.test(message)) return true
  const credential = '(?:API\\s*Key|key|token|密钥|令牌)'
  const invalid = '(?:无效|失效|过期|不存在|已撤销|invalid|expired|revoked)'
  return new RegExp(`${credential}.{0,24}${invalid}|${invalid}.{0,24}${credential}`, 'i').test(message)
}

function isShippedGroupName(provider: ProviderId, group: string): boolean {
  return group === managedCliKeyProfiles[provider].group || group === sub2ApiManagedCliKeyProfiles[provider].group
}

async function resolveManagedCliKeys(
  accountService: ManagedKeyAccountService,
  capture: AccountSessionCapture,
  keyStore?: ManagedCliKeyStoreLike,
): Promise<ResolvedManagedCliKeys> {
  const serviceKey = accountService as object
  const userId = capture.userId
  const resolutionKey = `${userId}:${capture.revision ?? 'legacy'}`
  let serviceResolutions = inFlightResolutions.get(serviceKey)
  const existing = serviceResolutions?.get(resolutionKey)
  if (existing) return existing
  if (!serviceResolutions) {
    serviceResolutions = new Map()
    inFlightResolutions.set(serviceKey, serviceResolutions)
  }

  const operation = (async (): Promise<ResolvedManagedCliKeys> => {
    assertSameAuthenticatedUser(accountService, capture)
    let cached: StoredManagedCliKey[] = []
    if (keyStore) {
      try {
        cached = await keyStore.read(userId)
      } catch (error) {
        // A damaged ciphertext or unavailable OS keychain must not trap a new
        // machine in onboarding. Keep the read API explicit for callers that
        // need to distinguish corruption, but let provisioning rebuild the
        // cache through save() (which quarantines a damaged record and
        // surfaces a transient read failure as a storage warning instead).
        // The save path below rebuilds the record after provisioning. A
        // recoverable read failure is therefore not itself a user-facing
        // storage failure.
      }
    }
    const cacheRevision = keyStore?.captureRevision?.()
    assertSameAuthenticatedUser(accountService, capture)
    const profiles = resolveManagedCliKeyProfiles(accountService.getActiveSiteId?.())
    // 本机四把 Key 全在缓存里、且分组名都还对得上时一次网络请求都不发——
    // 离线启动的行为与加入动态识别之前完全一致。只有真要去签 Key 才去问
    // 服务端现在有哪些分组。历史账号例外：订阅是在服务端买、在服务端到期的，
    // 本机缓存看不出来，每次都得问一次，否则买了订阅工具也还在扣余额。
    const everyKeyCached = !subscriptionsBindKeyGroups(accountService) && providerIds.every((provider) => (
      cached.some((entry) => entry.provider === provider && entry.group === profiles[provider].group)
    ))
    const resolvedGroups = everyKeyCached ? null : await loadManagedCliGroups(accountService)
    assertSameAuthenticatedUser(accountService, capture)
    const groupFor = (provider: ProviderId): string => resolvedGroups?.[provider].group ?? profiles[provider].group
    // A group rename on the account backend must invalidate the old local
    // entry. Otherwise a cached secret from the previous production config
    // would bypass provisioning and keep writing requests to a stale group.
    // On a history account whose groups could not be read at all, a cached key
    // in a subscription group is the best knowledge there is: dropping it would
    // re-provision into the hard-coded group, which offline fails and online
    // moves a subscribed CLI back onto the wallet on one transient read
    // failure. Keys named after either site's hard-coded groups keep the old
    // rule, so a key cached for the other site is still discarded.
    const keepUnverified = !resolvedGroups && subscriptionsBindKeyGroups(accountService)
    const keys = new Map(cached.flatMap((entry) => {
      const profile = profiles[entry.provider]
      const current = groupFor(entry.provider) === entry.group
        || (keepUnverified && !isShippedGroupName(entry.provider, entry.group))
      return profile && current ? [[entry.provider, entry] as const] : []
    }))
    const failed: ManagedCliKeyFailure[] = []
    const regrouped: ProviderId[] = []
    let fetchedFromServer = false

    for (const provider of providerIds) {
      if (keys.has(provider)) continue
      const group = groupFor(provider)
      const previousGroup = cached.find((entry) => entry.provider === provider)?.group
      try {
        assertSameAuthenticatedUser(accountService, capture)
        const result = await accountService.provisionCliKey({
          name: profiles[provider].keyName,
          group,
        })
        assertSameAuthenticatedUser(accountService, capture)
        keys.set(provider, {
          id: result.id,
          provider,
          group,
          name: result.name,
          key: result.key,
        })
        if (previousGroup !== undefined && previousGroup !== group) regrouped.push(provider)
        fetchedFromServer = true
      } catch (error) {
        rethrowAccountSessionChange(error)
        failed.push({
          provider,
          group,
          message: error instanceof Error ? error.message : 'CLI Key 初始化失败',
          ...(isServiceUnavailableError(error) ? { serviceUnavailable: true } : {}),
        })
      }
    }

    let storageWarning: string | undefined
    if (keyStore && fetchedFromServer) {
      try {
        assertSameAuthenticatedUser(accountService, capture)
        const cachedKeys = providerIds.flatMap((provider) => {
          const entry = keys.get(provider)
          return entry ? [entry] : []
        })
        const saved = cacheRevision === undefined
          ? await keyStore.save(userId, cachedKeys)
          : await keyStore.save(userId, cachedKeys, cacheRevision)
        assertSameAuthenticatedUser(accountService, capture)
        if (saved === false) storageWarning = '本地 API Key 缓存已被其他操作更新，本次保留新缓存'
      } catch (error) {
        rethrowAccountSessionChange(error)
        storageWarning = error instanceof Error ? error.message : '本地 API Key 保存失败'
      }
    }

    assertSameAuthenticatedUser(accountService, capture)
    return {
      keys: providerIds.flatMap((provider) => {
        const entry = keys.get(provider)
        return entry ? [entry] : []
      }),
      failed,
      regrouped,
      ...(storageWarning ? { storageWarning } : {}),
    }
  })()
  const trackedOperation = operation.finally(() => {
    const current = inFlightResolutions.get(serviceKey)
    if (current?.get(resolutionKey) !== trackedOperation) return
    current.delete(resolutionKey)
    if (current.size === 0) inFlightResolutions.delete(serviceKey)
  })
  serviceResolutions.set(resolutionKey, trackedOperation)
  return trackedOperation
}

export async function syncManagedCliKeySummary(
  accountService: ManagedKeyAccountService,
  keyStore?: ManagedCliKeyStoreLike,
): Promise<ManagedCliKeySyncSummary> {
  const capture = authenticatedSession(accountService)
  const result = await resolveManagedCliKeys(accountService, capture, keyStore)
  assertSameAuthenticatedUser(accountService, capture)
  return {
    ready: result.keys.map(({ provider, group, name }) => ({ provider, group, name })),
    failed: result.failed,
    ...(result.regrouped.length ? { regrouped: result.regrouped } : {}),
    ...(result.storageWarning ? { storageWarning: result.storageWarning } : {}),
  }
}

export async function configureManagedClis(
  accountService: ManagedKeyAccountService,
  systemService: Pick<SystemService, 'fetchAvailableModels' | 'saveConfig'>,
  providers: readonly ProviderId[],
  preferredModels: Partial<Record<ProviderId, string>>,
  previewOnboarding: boolean,
  keyStore?: ManagedCliKeyStoreLike,
  mode: ConfigSavePayload['mode'] = 'merge',
  intent: 'automatic' | 'explicit' = 'automatic',
): Promise<ManagedCliConfigurationOutcome> {
  if (providers.length === 0) return { configured: [], failed: [] }
  const capture = authenticatedSession(accountService)
  const userId = capture.userId
  const synchronized = await resolveManagedCliKeys(accountService, capture, keyStore)
  assertSameAuthenticatedUser(accountService, capture)
  const keys = new Map(synchronized.keys.map((entry) => [entry.provider, entry]))
  const syncFailures = new Map(synchronized.failed.map((entry) => [entry.provider, entry]))
  const outcome: ManagedCliConfigurationOutcome = { configured: [], failed: [] }

  for (const provider of providers) {
    let managedKey = keys.get(provider)
    if (!managedKey) {
      const syncFailure = syncFailures.get(provider)
      outcome.failed.push({
        provider,
        message: syncFailure?.message ?? '对应分组 Key 未就绪',
        ...(syncFailure?.serviceUnavailable ? { serviceUnavailable: true } : {}),
      })
      continue
    }
    try {
      assertSameAuthenticatedUser(accountService, capture)
      let models: string[]
      try {
        models = await systemService.fetchAvailableModels(managedKey.key, { bypassCache: true })
      } catch (error) {
        // 额度上限用完的 401 不是凭据失效：重签只会换来一把不限额的新 Key。
        if (isKeyQuotaExhaustedMessage(error instanceof Error ? error.message : String(error))) {
          throw new Error(managedKeyQuotaExhaustedMessage)
        }
        if (!isCredentialFailure(error)) throw error
        if (keyStore) await keyStore.remove(userId, managedKey.id)
        assertSameAuthenticatedUser(accountService, capture)
        const profile = resolveManagedCliKeyProfiles(accountService.getActiveSiteId?.())[provider]
        // 走到这里说明缓存里那把 Key 已经被服务端判失效，正是分组可能已经改名的时机：
        // 重签之前先问一次服务端现在有哪些分组，问不到再退回写死名单。
        const resolved = await loadManagedCliGroups(accountService)
        assertSameAuthenticatedUser(accountService, capture)
        const group = resolved?.[provider].group ?? profile.group
        const replacement = await accountService.provisionCliKey({ name: profile.keyName, group })
        assertSameAuthenticatedUser(accountService, capture)
        managedKey = {
          id: replacement.id,
          provider,
          group,
          name: replacement.name,
          key: replacement.key,
        }
        keys.set(provider, managedKey)
        if (keyStore) {
          const replacementRevision = keyStore.captureRevision?.()
          if (replacementRevision === undefined) {
            await keyStore.save(userId, [...keys.values()])
          } else {
            await keyStore.save(userId, [...keys.values()], replacementRevision)
          }
        }
        models = await systemService.fetchAvailableModels(managedKey.key, { bypassCache: true })
      }
      assertSameAuthenticatedUser(accountService, capture)
      if (models.length === 0) throw new Error('当前分组未返回可用模型')
      const model = resolveDefaultCliModel(provider, models, preferredModels[provider])
      if (!model) throw new Error('当前分组未返回可用于交互的默认模型，请选择其他分组或手动配置模型')
      const payload: ConfigSavePayload = { provider, apiKey: managedKey.key, model, mode }
      assertSameAuthenticatedUser(accountService, capture)
      await systemService.saveConfig(
        payload,
        previewOnboarding,
        () => assertSameAuthenticatedUser(accountService, capture),
        { source: 'account', automatic: intent !== 'explicit' },
      )
      assertSameAuthenticatedUser(accountService, capture)
      outcome.configured.push(provider)
    } catch (error) {
      rethrowAccountSessionChange(error)
      outcome.failed.push({
        provider,
        message: error instanceof Error ? error.message : 'CLI 配置失败',
        ...(isServiceUnavailableError(error) ? { serviceUnavailable: true } : {}),
      })
    }
  }
  return outcome
}

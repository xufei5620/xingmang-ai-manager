import { activeProviderIds, resolveManagedCliKeyProfiles, providerIds, type ProviderId } from './catalog'
import { resolveDefaultCliModel } from './cli-model-defaults'
import { isKeyQuotaExhaustedMessage, managedKeyQuotaExhaustedMessage, readAllAccountKeys } from './account-key-quota'
import {
  isRenamedAwayGroup,
  loadAccountGroupHints,
  loadManagedCliGroups,
  resolveMappedGroup,
  subscriptionsBindKeyGroups,
  type ManagedCliGroupAccountService,
} from './managed-cli-groups'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import { NewApiNetworkError } from './new-api-client'
import { RealmAccountError } from './realm-account'
import type { RelayBackendClient } from './relay-backend'
import { carryRequestDiagnostics } from './request-diagnostics'
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
  /** 技能已写好、但星芒画图没登记进某些工具时给首页的一句话（已是客户能看懂的文案）；缺省 = 没问题。 */
  imageMcpWarning?: string
  /**
   * imageMcpWarning 只是因为这台电脑没有 Node.js（画图工具靠它跑）。首页凭这个跟着运行环境卡的说法走：
   * 一个命令行工具都没装时那一行写 Node.js「可选」，这句就不上首页（yoyo 10-8）。缺省 = 不是这个原因。
   */
  imageMcpNeedsNode?: boolean
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
  getSiteId?: () => string
}

interface ResolvedManagedCliKeys {
  keys: StoredManagedCliKey[]
  failed: ManagedCliKeyFailure[]
  regrouped: ProviderId[]
  storageWarning?: string
}

type ManagedKeyAccountService = Pick<RelayBackendClient,
  'getSessionState' | 'provisionCliKey' | 'getSessionRevision' | 'getActiveSiteId' | 'listUsableGroups'>
  & Partial<Pick<RelayBackendClient, 'getSubscriptionSelf' | 'listKeys' | 'revealKey'>>
  & Pick<ManagedCliGroupAccountService, 'getAccountGroupHints'>

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

interface RenamedGroupMove {
  cache: StoredManagedCliKey[]
  regrouped: ProviderId[]
}

function isUsableAccountKey(
  key: { status: number; unlimitedQuota: boolean; remainQuota: number; expiredAt: string | null },
  now: number,
): boolean {
  if (key.status !== 1) return false
  if (key.expiredAt !== null && !(Date.parse(key.expiredAt) > now)) return false
  return key.unlimitedQuota || key.remainQuota > 0
}

/**
 * 站上改了分组本名（服务状态文件的分组对照把老名字排在后面）以后，本机记着的 Key 还在老名字下的挪到新名字下：
 * - 服务端已经把这把 Key 迁到新名字了：只改本机记的分组名，Key 不换、配置不动。
 * - 它还在老名字下（迁移之后老版本星芒在老名字下新建的）：新名字下有同名、能用的那把就换过去，
 *   开机那一轮按「换了分组」重写星芒自己写的那几份配置（account-bootstrap.ts 的 regrouped）。
 * - 都没有就接着用老的：老名字还在，照样能用，等服务端删老名字那天迁过去。
 * 只认同名的那把，不新建：provisionCliKey 会挑分组里最新的任意一把，那可能是用户自己建的、另设了额度的。
 * 原来那把设了额度上限或到期时间的也不换，换过去等于替用户放开了限制。
 * 哪一步读不到都当没这回事，照旧用本机记的，下次开机再试。
 */
async function moveKeysOffRenamedGroups(
  accountService: ManagedKeyAccountService,
  capture: AccountSessionCapture,
  cache: readonly StoredManagedCliKey[],
): Promise<RenamedGroupMove | null> {
  const { listKeys, revealKey } = accountService
  if (!cache.length || accountService.getActiveSiteId?.() === 'solov-api' || !listKeys || !revealKey) return null
  const hints = await loadAccountGroupHints(accountService)
  assertSameAuthenticatedUser(accountService, capture)
  const stale = activeProviderIds.flatMap((provider) => {
    const entry = cache.find((item) => item.provider === provider)
    return entry && isRenamedAwayGroup(provider, entry.group, hints) ? [{ provider, entry }] : []
  })
  if (!stale.length) return null
  try {
    const groups = await accountService.listUsableGroups()
    assertSameAuthenticatedUser(accountService, capture)
    const keys = await readAllAccountKeys((query) => listKeys.call(accountService, query))
    assertSameAuthenticatedUser(accountService, capture)
    const profiles = resolveManagedCliKeyProfiles(accountService.getActiveSiteId?.())
    const now = Date.now()
    const replacements = new Map<StoredManagedCliKey, StoredManagedCliKey>()
    const regrouped: ProviderId[] = []
    for (const { provider, entry } of stale) {
      const target = resolveMappedGroup(provider, groups, hints)
      const order = hints?.[provider] ?? []
      if (!target || order.indexOf(target) >= order.indexOf(entry.group)) continue
      const own = keys.find((key) => key.id === entry.id)
      if (!own) continue
      if (own.group === target) {
        replacements.set(entry, { ...entry, group: target })
        continue
      }
      if (own.group !== entry.group || !own.unlimitedQuota || own.expiredAt !== null) continue
      const twin = keys
        .filter((key) => key.name === profiles[provider].keyName && key.group === target && isUsableAccountKey(key, now))
        .reduce<(typeof keys)[number] | null>((newest, key) => (!newest || key.id > newest.id ? key : newest), null)
      if (!twin) continue
      const secret = await revealKey.call(accountService, twin.id)
      assertSameAuthenticatedUser(accountService, capture)
      if (!secret) continue
      replacements.set(entry, { id: twin.id, provider, group: target, name: twin.name, key: secret })
      regrouped.push(provider)
    }
    if (!replacements.size) return null
    return { cache: cache.map((entry) => replacements.get(entry) ?? entry), regrouped }
  } catch (error) {
    rethrowAccountSessionChange(error)
    return null
  }
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
    const activeSiteId = accountService.getActiveSiteId?.()
    const cacheSiteId = keyStore?.getSiteId?.()
    const foreignCache = cacheSiteId !== undefined && activeSiteId !== undefined && cacheSiteId !== activeSiteId
    const scopedCache = activeSiteId !== undefined && cacheSiteId === activeSiteId
    // Old/unscoped stores only prove their shipped names. The realm-bound
    // encrypted store may also prove a renamed group without going online.
    const usableCache = foreignCache ? [] : scopedCache ? cached : cached.filter((entry) => (
      entry.group === profiles[entry.provider].group
    ))
    // 站上改了分组本名：本机记着的 Key 还在老名字下的，先挪到新名字下（见 moveKeysOffRenamedGroups）。
    // 不分站点的老缓存只认写死的名字，挪过去下次读就被滤掉，所以只挪分站点的。
    const moved = scopedCache ? await moveKeysOffRenamedGroups(accountService, capture, usableCache) : null
    const currentCache = moved?.cache ?? usableCache
    // 历史账号例外：订阅是在服务端买、在服务端到期的，本机缓存看不出来，
    // 每次都得问一次，否则买了订阅工具也还在扣余额。
    const everyKeyCached = !subscriptionsBindKeyGroups(accountService) && activeProviderIds.every((provider) => (
      currentCache.some((entry) => entry.provider === provider)
    ))
    const resolvedGroups = everyKeyCached ? null : await loadManagedCliGroups(accountService)
    assertSameAuthenticatedUser(accountService, capture)
    const groupFor = (provider: ProviderId): string => {
      const resolved = resolvedGroups?.[provider]
      // A fallback means the listing did not identify a new owner. It does
      // not invalidate a group already confirmed when this key was issued.
      // 历史账号订阅到期也走这条：服务端还给得出这家工具的普通分组时会认出来、
      // 换回去；认不出时换去写死的名字只会签 Key 失败，配置里仍是这把旧 Key。
      return (resolved?.source !== 'fallback' ? resolved?.group : undefined)
        ?? currentCache.find((entry) => entry.provider === provider)?.group
        ?? profiles[provider].group
    }
    // A group rename on the account backend must invalidate the old local
    // entry. Otherwise a cached secret from the previous production config
    // would bypass provisioning and keep writing requests to a stale group.
    const keys = new Map(currentCache.flatMap((entry) => {
      const profile = profiles[entry.provider]
      return profile && groupFor(entry.provider) === entry.group ? [[entry.provider, entry] as const] : []
    }))
    const failed: ManagedCliKeyFailure[] = []
    const regrouped: ProviderId[] = [...(moved?.regrouped ?? [])]
    let fetchedFromServer = moved !== null

    // 下线的工具（Gemini CLI）不再签 Key：历史账号多半已经没有它的分组，签不出来会让每次登录都报一条失败。
    for (const provider of activeProviderIds) {
      if (keys.has(provider)) continue
      const group = groupFor(provider)
      const previousGroup = currentCache.find((entry) => entry.provider === provider)?.group
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
        // 签 Key 那次请求走的线路、状态码、请求编号跟着这条失败走，写 Key 失败的日志要用（request-diagnostics.ts）。
        failed.push(carryRequestDiagnostics(error, {
          provider,
          group,
          message: error instanceof Error ? error.message : 'CLI Key 初始化失败',
          ...(isServiceUnavailableError(error) ? { serviceUnavailable: true } : {}),
        }))
      }
    }

    let storageWarning: string | undefined
    if (keyStore && fetchedFromServer) {
      try {
        assertSameAuthenticatedUser(accountService, capture)
        // 下线工具以前签的那把还留在缓存里，不因为这次保存丢掉；只是不再交出去写配置。
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
      keys: activeProviderIds.flatMap((provider) => {
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
      outcome.failed.push(carryRequestDiagnostics(syncFailure, {
        provider,
        message: syncFailure?.message ?? '对应分组 Key 未就绪',
        ...(syncFailure?.serviceUnavailable ? { serviceUnavailable: true } : {}),
      }))
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
        // 失效也可能是分组改名；重签前先问服务端。组列表暂不可用时沿用
        // 原 Key 已确认过的组名，不把动态组误换成出厂组名。
        const resolved = await loadManagedCliGroups(accountService)
        assertSameAuthenticatedUser(accountService, capture)
        const group = (resolved?.[provider].source !== 'fallback' ? resolved?.[provider].group : undefined)
          ?? managedKey.group
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
      outcome.failed.push(carryRequestDiagnostics(error, {
        provider,
        message: error instanceof Error ? error.message : 'CLI 配置失败',
        ...(isServiceUnavailableError(error) ? { serviceUnavailable: true } : {}),
      }))
    }
  }
  return outcome
}

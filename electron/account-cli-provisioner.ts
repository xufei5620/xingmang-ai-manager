import { managedCliKeyProfiles, providerIds, type ProviderId } from './catalog'
import type { StoredManagedCliKey } from './managed-cli-key-store'
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
}

export interface ManagedCliKeySyncSummary {
  ready: ManagedCliKeyStatus[]
  failed: ManagedCliKeyFailure[]
  storageWarning?: string
}

export interface ManagedCliConfigurationOutcome {
  configured: ProviderId[]
  failed: Array<{ provider: ProviderId; message: string }>
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
  storageWarning?: string
}

type ManagedKeyAccountService = Pick<RelayBackendClient, 'getSessionState' | 'provisionCliKey'>

class AccountSessionChangedError extends Error {
  constructor() {
    super('星芒账号已切换，已停止本次 API Key 初始化')
    this.name = 'AccountSessionChangedError'
  }
}

const inFlightResolutions = new WeakMap<object, Map<number, Promise<ResolvedManagedCliKeys>>>()

function authenticatedUserId(accountService: ManagedKeyAccountService): number {
  const session = accountService.getSessionState()
  const userId = session.account?.userId
  if (!session.authenticated || !userId) throw new Error('请先登录星芒账号')
  return userId
}

function assertSameAuthenticatedUser(
  accountService: ManagedKeyAccountService,
  expectedUserId: number,
): void {
  const session = accountService.getSessionState()
  if (!session.authenticated || session.account?.userId !== expectedUserId) {
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

async function resolveManagedCliKeys(
  accountService: ManagedKeyAccountService,
  userId: number,
  keyStore?: ManagedCliKeyStoreLike,
): Promise<ResolvedManagedCliKeys> {
  const serviceKey = accountService as object
  let serviceResolutions = inFlightResolutions.get(serviceKey)
  const existing = serviceResolutions?.get(userId)
  if (existing) return existing
  if (!serviceResolutions) {
    serviceResolutions = new Map()
    inFlightResolutions.set(serviceKey, serviceResolutions)
  }

  const operation = (async (): Promise<ResolvedManagedCliKeys> => {
    assertSameAuthenticatedUser(accountService, userId)
    let cached: StoredManagedCliKey[] = []
    let cacheReadWarning: string | undefined
    if (keyStore) {
      try {
        cached = await keyStore.read(userId)
      } catch (error) {
        // A damaged ciphertext or unavailable OS keychain must not trap a new
        // machine in onboarding. Keep the read API explicit for callers that
        // need to distinguish corruption, but let provisioning rebuild the
        // cache through save() (which quarantines a damaged record).
        cacheReadWarning = error instanceof Error ? error.message : '本地 API Key 缓存读取失败'
      }
    }
    const cacheRevision = keyStore?.captureRevision?.()
    assertSameAuthenticatedUser(accountService, userId)
    const keys = new Map(cached.map((entry) => [entry.provider, entry]))
    const failed: ManagedCliKeyFailure[] = []
    let fetchedFromServer = false

    for (const provider of providerIds) {
      if (keys.has(provider)) continue
      const profile = managedCliKeyProfiles[provider]
      try {
        assertSameAuthenticatedUser(accountService, userId)
        const result = await accountService.provisionCliKey({
          name: profile.keyName,
          group: profile.group,
        })
        assertSameAuthenticatedUser(accountService, userId)
        keys.set(provider, {
          id: result.id,
          provider,
          group: profile.group,
          name: result.name,
          key: result.key,
        })
        fetchedFromServer = true
      } catch (error) {
        rethrowAccountSessionChange(error)
        failed.push({
          provider,
          group: profile.group,
          message: error instanceof Error ? error.message : 'CLI Key 初始化失败',
        })
      }
    }

    let storageWarning: string | undefined = cacheReadWarning
    if (keyStore && fetchedFromServer) {
      try {
        assertSameAuthenticatedUser(accountService, userId)
        const cachedKeys = providerIds.flatMap((provider) => {
          const entry = keys.get(provider)
          return entry ? [entry] : []
        })
        const saved = cacheRevision === undefined
          ? await keyStore.save(userId, cachedKeys)
          : await keyStore.save(userId, cachedKeys, cacheRevision)
        assertSameAuthenticatedUser(accountService, userId)
        if (saved === false) storageWarning = '本地 API Key 缓存已被其他操作更新，本次保留新缓存'
      } catch (error) {
        rethrowAccountSessionChange(error)
        storageWarning = error instanceof Error ? error.message : '本地 API Key 保存失败'
      }
    }

    assertSameAuthenticatedUser(accountService, userId)
    return {
      keys: providerIds.flatMap((provider) => {
        const entry = keys.get(provider)
        return entry ? [entry] : []
      }),
      failed,
      ...(storageWarning ? { storageWarning } : {}),
    }
  })()
  const trackedOperation = operation.finally(() => {
    const current = inFlightResolutions.get(serviceKey)
    if (current?.get(userId) !== trackedOperation) return
    current.delete(userId)
    if (current.size === 0) inFlightResolutions.delete(serviceKey)
  })
  serviceResolutions.set(userId, trackedOperation)
  return trackedOperation
}

export async function syncManagedCliKeySummary(
  accountService: ManagedKeyAccountService,
  keyStore?: ManagedCliKeyStoreLike,
): Promise<ManagedCliKeySyncSummary> {
  const userId = authenticatedUserId(accountService)
  const result = await resolveManagedCliKeys(accountService, userId, keyStore)
  assertSameAuthenticatedUser(accountService, userId)
  return {
    ready: result.keys.map(({ provider, group, name }) => ({ provider, group, name })),
    failed: result.failed,
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
): Promise<ManagedCliConfigurationOutcome> {
  if (providers.length === 0) return { configured: [], failed: [] }
  const userId = authenticatedUserId(accountService)
  const synchronized = await resolveManagedCliKeys(accountService, userId, keyStore)
  assertSameAuthenticatedUser(accountService, userId)
  const keys = new Map(synchronized.keys.map((entry) => [entry.provider, entry]))
  const syncFailures = new Map(synchronized.failed.map((entry) => [entry.provider, entry.message]))
  const outcome: ManagedCliConfigurationOutcome = { configured: [], failed: [] }

  for (const provider of providers) {
    let managedKey = keys.get(provider)
    if (!managedKey) {
      outcome.failed.push({ provider, message: syncFailures.get(provider) ?? '对应分组 Key 未就绪' })
      continue
    }
    try {
      assertSameAuthenticatedUser(accountService, userId)
      let models: string[]
      try {
        models = await systemService.fetchAvailableModels(managedKey.key, { bypassCache: true })
      } catch (error) {
        if (!isCredentialFailure(error)) throw error
        if (keyStore) await keyStore.remove(userId, managedKey.id)
        assertSameAuthenticatedUser(accountService, userId)
        const profile = managedCliKeyProfiles[provider]
        const replacement = await accountService.provisionCliKey({ name: profile.keyName, group: profile.group })
        assertSameAuthenticatedUser(accountService, userId)
        managedKey = {
          id: replacement.id,
          provider,
          group: profile.group,
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
      assertSameAuthenticatedUser(accountService, userId)
      if (models.length === 0) throw new Error('当前分组未返回可用模型')
      const preferred = preferredModels[provider]
      const model = preferred && models.includes(preferred) ? preferred : models[0]
      const payload: ConfigSavePayload = { provider, apiKey: managedKey.key, model, mode: 'merge' }
      assertSameAuthenticatedUser(accountService, userId)
      await systemService.saveConfig(
        payload,
        previewOnboarding,
        () => assertSameAuthenticatedUser(accountService, userId),
      )
      assertSameAuthenticatedUser(accountService, userId)
      outcome.configured.push(provider)
    } catch (error) {
      rethrowAccountSessionChange(error)
      outcome.failed.push({
        provider,
        message: error instanceof Error ? error.message : 'CLI 配置失败',
      })
    }
  }
  return outcome
}

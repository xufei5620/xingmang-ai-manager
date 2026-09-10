import { buildCliKeyName } from './new-api-client'
import { selectAiChatModelsForGroup } from './ai-chat-protocol'
import type { RelayBackendClient } from './relay-backend'
import type { StoredChatKey } from './chat-key-store'

export interface ChatKeyStoreLike {
  read(userId: number): Promise<StoredChatKey[]>
  captureRevision(): number
  upsert(entry: StoredChatKey, expectedRevision?: number): Promise<boolean>
  remove(userId: number, group: string): Promise<void>
}

export interface ChatModelServiceLike {
  fetchAvailableModels(apiKey: string, options?: { bypassCache?: boolean }): Promise<string[]>
}

export interface PreparedChatGroup {
  group: string
  models: string[]
  keyCreated: boolean
  storageWarning?: string
}

export interface ResolvedChatCredential extends PreparedChatGroup {
  userId: number
  apiKey: string
  keyId: number
  keyName: string
}

export interface ChatCredentialCoordinator {
  listGroups(): ReturnType<RelayBackendClient['listUsableGroups']>
  prepareGroup(group: string): Promise<PreparedChatGroup>
  resolveCredential(group: string): Promise<ResolvedChatCredential>
}

class ChatAccountChangedError extends Error {
  constructor() {
    super('星芒账号已切换，已停止本次 AI聊天初始化')
    this.name = 'ChatAccountChangedError'
  }
}

function requiredGroup(value: string): string {
  const group = value.trim()
  if (!group || group.length > 128 || /[\x00-\x1F\x7F]/.test(group)) {
    throw new Error('AI聊天分组格式错误')
  }
  return group
}

type ChatAccountService = Pick<RelayBackendClient, 'getSessionState' | 'getSessionRevision'>

function sessionRevision(accountService: Pick<RelayBackendClient, 'getSessionRevision'>): number {
  const revision = accountService.getSessionRevision?.() ?? 0
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
}

function authenticatedSession(accountService: ChatAccountService): { userId: number; revision: number } {
  const session = accountService.getSessionState()
  const userId = session.account?.userId
  if (!session.authenticated || !userId) throw new Error('请先登录星芒账号')
  return { userId, revision: sessionRevision(accountService) }
}

function assertSameSession(
  accountService: ChatAccountService,
  expectedUserId: number,
  expectedRevision: number,
): void {
  const current = authenticatedSession(accountService)
  if (current.userId !== expectedUserId || current.revision !== expectedRevision) throw new ChatAccountChangedError()
}

function isCredentialFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/(?:服务返回|返回)\s*401\b/i.test(message)) return true
  const credential = '(?:API\\s*Key|key|token|密钥|令牌)'
  const invalid = '(?:无效|失效|过期|不存在|已撤销|invalid|expired|revoked)'
  return new RegExp(`${credential}.{0,24}${invalid}|${invalid}.{0,24}${credential}`, 'i').test(message)
}

const inFlightByService = new WeakMap<object, Map<string, Promise<ResolvedChatCredential>>>()

export function createChatCredentialCoordinator(options: {
  accountService: Pick<RelayBackendClient,
    'getSessionState' | 'listUsableGroups' | 'provisionCliKey' | 'getSessionRevision' | 'getActiveSiteId'>
  modelService: ChatModelServiceLike
  keyStore: ChatKeyStoreLike
}): ChatCredentialCoordinator {
  const { accountService, modelService, keyStore } = options

  async function listGroups(): ReturnType<RelayBackendClient['listUsableGroups']> {
    authenticatedSession(accountService)
    const groups = await accountService.listUsableGroups()
    return groups.filter((entry) => requiredGroup(entry.name) === entry.name)
  }

  async function resolveOperation(userId: number, revision: number, group: string): Promise<ResolvedChatCredential> {
    assertSameSession(accountService, userId, revision)
    const usableGroups = await accountService.listUsableGroups()
    assertSameSession(accountService, userId, revision)
    if (!usableGroups.some((entry) => entry.name === group)) {
      throw new Error(`当前账号不可使用分组「${group}」`)
    }

    const cached = (await keyStore.read(userId)).find((entry) => entry.group === group)
    assertSameSession(accountService, userId, revision)
    if (cached) {
      try {
        const models = selectAiChatModelsForGroup(
          group,
          await modelService.fetchAvailableModels(cached.key, { bypassCache: true }),
        )
        assertSameSession(accountService, userId, revision)
        return {
          userId,
          group,
          models,
          keyCreated: false,
          apiKey: cached.key,
          keyId: cached.keyId,
          keyName: cached.keyName,
        }
      } catch (error) {
        if (!isCredentialFailure(error)) throw error
        // A revoked/expired server key must not poison the local cache. The
        // normal provision flow below reuses another usable key or creates a
        // replacement, and the new secret is encrypted back into the store.
        await keyStore.remove(userId, group)
        assertSameSession(accountService, userId, revision)
      }
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedRevision = keyStore.captureRevision()
      const provisioned = await accountService.provisionCliKey({
        // Sub2API reuses exact name + group. Stable names also recover a key
        // when model probing or local persistence failed after its creation.
        name: accountService.getActiveSiteId?.() === 'solov-api' ? 'xingmang-chat' : buildCliKeyName('xingmang-chat'),
        group,
      })
      assertSameSession(accountService, userId, revision)
      const models = selectAiChatModelsForGroup(
        group,
        await modelService.fetchAvailableModels(provisioned.key, { bypassCache: true }),
      )
      assertSameSession(accountService, userId, revision)

      let storageWarning: string | undefined
      try {
        const saved = await keyStore.upsert({
          userId,
          group,
          keyId: provisioned.id,
          keyName: provisioned.name,
          key: provisioned.key,
        }, expectedRevision)
        assertSameSession(accountService, userId, revision)
        if (!saved) continue
      } catch (error) {
        if (error instanceof ChatAccountChangedError) throw error
        storageWarning = error instanceof Error ? error.message : '本地分组 API Key 保存失败'
      }

      return {
        userId,
        group,
        models,
        keyCreated: true,
        apiKey: provisioned.key,
        keyId: provisioned.id,
        keyName: provisioned.name,
        ...(storageWarning ? { storageWarning } : {}),
      }
    }
    throw new Error('AI聊天分组 API Key 在初始化期间发生变更，请重试')
  }

  function resolveCredential(groupInput: string): Promise<ResolvedChatCredential> {
    const group = requiredGroup(groupInput)
    const { userId, revision } = authenticatedSession(accountService)
    const serviceKey = accountService as object
    let inFlight = inFlightByService.get(serviceKey)
    if (!inFlight) {
      inFlight = new Map()
      inFlightByService.set(serviceKey, inFlight)
    }
    const operationKey = `${userId}:${revision}:${group}`
    const existing = inFlight.get(operationKey)
    if (existing) return existing
    const operation = resolveOperation(userId, revision, group)
    const tracked = operation.finally(() => {
      const current = inFlightByService.get(serviceKey)
      if (current?.get(operationKey) !== tracked) return
      current.delete(operationKey)
      if (current.size === 0) inFlightByService.delete(serviceKey)
    })
    inFlight.set(operationKey, tracked)
    return tracked
  }

  async function prepareGroup(group: string): Promise<PreparedChatGroup> {
    const { userId: _userId, apiKey: _apiKey, keyId: _keyId, keyName: _keyName, ...safe } = (
      await resolveCredential(group)
    )
    return safe
  }

  return { listGroups, prepareGroup, resolveCredential }
}

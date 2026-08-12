import { buildCliKeyName } from './new-api-client'
import type { RelayBackendClient } from './relay-backend'
import type { StoredChatKey } from './chat-key-store'

export interface ChatKeyStoreLike {
  read(userId: number): Promise<StoredChatKey[]>
  upsert(entry: StoredChatKey): Promise<void>
}

export interface ChatModelServiceLike {
  fetchAvailableModels(apiKey: string): Promise<string[]>
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

function authenticatedUserId(accountService: Pick<RelayBackendClient, 'getSessionState'>): number {
  const session = accountService.getSessionState()
  const userId = session.account?.userId
  if (!session.authenticated || !userId) throw new Error('请先登录星芒账号')
  return userId
}

function assertSameUser(
  accountService: Pick<RelayBackendClient, 'getSessionState'>,
  expectedUserId: number,
): void {
  if (authenticatedUserId(accountService) !== expectedUserId) throw new ChatAccountChangedError()
}

const inFlightByService = new WeakMap<object, Map<string, Promise<ResolvedChatCredential>>>()

export function createChatCredentialCoordinator(options: {
  accountService: Pick<RelayBackendClient,
    'getSessionState' | 'listUsableGroups' | 'provisionCliKey'>
  modelService: ChatModelServiceLike
  keyStore: ChatKeyStoreLike
}): ChatCredentialCoordinator {
  const { accountService, modelService, keyStore } = options

  async function listGroups(): ReturnType<RelayBackendClient['listUsableGroups']> {
    authenticatedUserId(accountService)
    const groups = await accountService.listUsableGroups()
    return groups.filter((entry) => requiredGroup(entry.name) === entry.name)
  }

  async function resolveOperation(userId: number, group: string): Promise<ResolvedChatCredential> {
    assertSameUser(accountService, userId)
    const usableGroups = await accountService.listUsableGroups()
    assertSameUser(accountService, userId)
    if (!usableGroups.some((entry) => entry.name === group)) {
      throw new Error(`当前账号不可使用分组「${group}」`)
    }

    const cached = (await keyStore.read(userId)).find((entry) => entry.group === group)
    assertSameUser(accountService, userId)
    if (cached) {
      const models = await modelService.fetchAvailableModels(cached.key)
      assertSameUser(accountService, userId)
      return {
        userId,
        group,
        models,
        keyCreated: false,
        apiKey: cached.key,
        keyId: cached.keyId,
        keyName: cached.keyName,
      }
    }

    const provisioned = await accountService.provisionCliKey({
      name: buildCliKeyName('xingmang-chat'),
      group,
    })
    assertSameUser(accountService, userId)
    const models = await modelService.fetchAvailableModels(provisioned.key)
    assertSameUser(accountService, userId)

    let storageWarning: string | undefined
    try {
      await keyStore.upsert({
        userId,
        group,
        keyId: provisioned.id,
        keyName: provisioned.name,
        key: provisioned.key,
      })
      assertSameUser(accountService, userId)
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

  function resolveCredential(groupInput: string): Promise<ResolvedChatCredential> {
    const group = requiredGroup(groupInput)
    const userId = authenticatedUserId(accountService)
    const serviceKey = accountService as object
    let inFlight = inFlightByService.get(serviceKey)
    if (!inFlight) {
      inFlight = new Map()
      inFlightByService.set(serviceKey, inFlight)
    }
    const operationKey = `${userId}:${group}`
    const existing = inFlight.get(operationKey)
    if (existing) return existing
    const operation = resolveOperation(userId, group)
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


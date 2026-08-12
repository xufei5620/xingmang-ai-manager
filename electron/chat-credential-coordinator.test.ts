import { describe, expect, it, vi } from 'vitest'
import {
  createChatCredentialCoordinator,
  type ChatKeyStoreLike,
} from './chat-credential-coordinator'
import type { StoredChatKey } from './chat-key-store'
import type { RelayBackendClient } from './relay-backend'

function setup(overrides: {
  userId?: number
  cached?: StoredChatKey[]
  storeFailure?: Error
} = {}) {
  let userId = overrides.userId ?? 7
  let cached = overrides.cached ?? []
  let revision = 0
  const accountService = {
    getSessionState: vi.fn(() => ({ authenticated: true, account: { userId } })),
    listUsableGroups: vi.fn(async () => [
      { name: 'codex-pro', description: '', ratio: 1 },
      { name: '生图分组', description: '', ratio: 2 },
    ]),
    provisionCliKey: vi.fn(async (input: { name?: string; group?: string } = {}) => ({
      id: 10,
      name: input.name ?? 'generated',
      key: `sk-${userId}-${input.group}`,
    })),
  } as unknown as Pick<RelayBackendClient, 'getSessionState' | 'listUsableGroups' | 'provisionCliKey'>
  const store: ChatKeyStoreLike = {
    read: vi.fn(async (targetUserId) => cached.filter((entry) => entry.userId === targetUserId)),
    captureRevision: vi.fn(() => revision),
    remove: vi.fn(async (targetUserId, group) => {
      revision += 1
      cached = cached.filter((entry) => !(entry.userId === targetUserId && entry.group === group))
    }),
    upsert: vi.fn(async (entry, expectedRevision = revision) => {
      if (overrides.storeFailure) throw overrides.storeFailure
      if (expectedRevision !== revision) return false
      cached = [entry, ...cached.filter((candidate) => !(
        candidate.userId === entry.userId && candidate.group === entry.group
      ))]
      return true
    }),
  }
  const modelService = {
    fetchAvailableModels: vi.fn(async (key: string) => key.includes('生图')
      ? ['gpt-image-2', 'jimeng_high_aes_general_v21_L']
      : ['gpt-5.4']),
  }
  const coordinator = createChatCredentialCoordinator({ accountService, keyStore: store, modelService })
  return {
    coordinator,
    accountService,
    store,
    modelService,
    invalidate: () => { revision += 1 },
    switchUser: (next: number) => { userId = next },
  }
}

describe('chat credential coordinator', () => {
  it('uses an encrypted local cache without provisioning and returns no key from prepareGroup', async () => {
    const cached: StoredChatKey = {
      userId: 7,
      group: 'codex-pro',
      keyId: 3,
      keyName: 'cached',
      key: 'sk-cached-secret',
    }
    const { coordinator, accountService, modelService } = setup({ cached: [cached] })

    const prepared = await coordinator.prepareGroup('codex-pro')

    expect(prepared).toEqual({ group: 'codex-pro', models: ['gpt-5.4'], keyCreated: false })
    expect(JSON.stringify(prepared)).not.toContain(cached.key)
    expect(accountService.provisionCliKey).not.toHaveBeenCalled()
    expect(modelService.fetchAvailableModels).toHaveBeenCalledWith(cached.key, { bypassCache: true })
  })

  it('provisions and saves a missing group once for concurrent callers', async () => {
    const { coordinator, accountService, store } = setup()

    const [first, second] = await Promise.all([
      coordinator.resolveCredential('生图分组'),
      coordinator.resolveCredential('生图分组'),
    ])

    expect(first).toEqual(second)
    expect(first.keyCreated).toBe(true)
    expect(accountService.provisionCliKey).toHaveBeenCalledTimes(1)
    expect(accountService.provisionCliKey).toHaveBeenCalledWith(expect.objectContaining({ group: '生图分组' }))
    expect(store.upsert).toHaveBeenCalledTimes(1)
  })

  it('filters and orders the production image group models before exposing them', async () => {
    const context = setup()
    vi.mocked(context.modelService.fetchAvailableModels).mockResolvedValue([
      'gpt-image-1.5',
      'gpt-image-1',
      'gpt-image-2-2026-04-21',
      'jimeng_high_aes_general_v21_L',
      'gpt-image-2',
    ])
    const prepared = await context.coordinator.prepareGroup('生图分组')
    expect(prepared.models).toEqual([
      'gpt-image-2',
      'gpt-image-1',
      'jimeng_high_aes_general_v21_L',
    ])
  })

  it('rejects groups not returned by the server', async () => {
    const { coordinator, accountService } = setup()
    await expect(coordinator.prepareGroup('not-allowed')).rejects.toThrow('不可使用分组')
    expect(accountService.provisionCliKey).not.toHaveBeenCalled()
  })

  it('rejects a result when the account changes while models load', async () => {
    const context = setup()
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(context.modelService.fetchAvailableModels).mockImplementation(async () => {
      await blocked
      return ['gpt-5.4']
    })
    const result = context.coordinator.prepareGroup('codex-pro')
    await vi.waitFor(() => expect(context.modelService.fetchAvailableModels).toHaveBeenCalled())
    context.switchUser(9)
    release()
    await expect(result).rejects.toThrow('账号已切换')
    expect(context.store.upsert).not.toHaveBeenCalled()
  })

  it('returns a storage warning after remote success without provisioning again', async () => {
    const { coordinator, accountService } = setup({ storeFailure: new Error('磁盘只读') })
    const credential = await coordinator.resolveCredential('codex-pro')
    expect(credential.storageWarning).toBe('磁盘只读')
    expect(credential.apiKey).toContain('sk-7-codex-pro')
    expect(accountService.provisionCliKey).toHaveBeenCalledTimes(1)
  })

  it('replaces a cached key after the model endpoint reports authentication failure', async () => {
    const cached: StoredChatKey = {
      userId: 7,
      group: 'codex-pro',
      keyId: 3,
      keyName: 'expired',
      key: 'sk-expired-secret',
    }
    const context = setup({ cached: [cached] })
    vi.mocked(context.modelService.fetchAvailableModels)
      .mockRejectedValueOnce(new Error('模型查询失败，服务返回 401'))
      .mockResolvedValueOnce(['gpt-5.4'])

    const result = await context.coordinator.resolveCredential('codex-pro')

    expect(result.keyCreated).toBe(true)
    expect(result.apiKey).toContain('sk-7-codex-pro')
    expect(context.store.remove).toHaveBeenCalledWith(7, 'codex-pro')
    expect(context.accountService.provisionCliKey).toHaveBeenCalledTimes(1)
    expect(context.store.upsert).toHaveBeenCalledTimes(1)
  })

  it('keeps a cached key when model loading fails for an ordinary network error', async () => {
    const cached: StoredChatKey = {
      userId: 7,
      group: 'codex-pro',
      keyId: 3,
      keyName: 'cached',
      key: 'sk-cached-secret',
    }
    const context = setup({ cached: [cached] })
    vi.mocked(context.modelService.fetchAvailableModels)
      .mockRejectedValueOnce(new Error('模型查询失败，请检查网络连接'))

    await expect(context.coordinator.resolveCredential('codex-pro'))
      .rejects.toThrow('请检查网络连接')
    expect(context.store.remove).not.toHaveBeenCalled()
    expect(context.accountService.provisionCliKey).not.toHaveBeenCalled()
    expect(context.store.upsert).not.toHaveBeenCalled()
  })

  it('does not replace a cached key for a generic 403 permission failure', async () => {
    const cached: StoredChatKey = {
      userId: 7,
      group: 'codex-pro',
      keyId: 3,
      keyName: 'restricted',
      key: 'sk-restricted-secret',
    }
    const context = setup({ cached: [cached] })
    vi.mocked(context.modelService.fetchAvailableModels)
      .mockRejectedValueOnce(new Error('模型查询失败，服务返回 403：IP 不在访问白名单'))

    await expect(context.coordinator.resolveCredential('codex-pro'))
      .rejects.toThrow('IP 不在访问白名单')
    expect(context.store.remove).not.toHaveBeenCalled()
    expect(context.accountService.provisionCliKey).not.toHaveBeenCalled()
  })

  it('retries instead of reviving a key invalidated during first-time initialization', async () => {
    const context = setup()
    let finishFirstProvision: () => void = () => undefined
    vi.mocked(context.accountService.provisionCliKey)
      .mockReturnValueOnce(new Promise((resolve) => {
        finishFirstProvision = () => resolve({ id: 42, name: 'revoked', key: 'sk-revoked-secret' })
      }))
      .mockResolvedValueOnce({ id: 43, name: 'replacement', key: 'sk-replacement-secret' })

    const pending = context.coordinator.resolveCredential('codex-pro')
    await vi.waitFor(() => expect(context.accountService.provisionCliKey).toHaveBeenCalledTimes(1))
    context.invalidate()
    finishFirstProvision()

    await expect(pending).resolves.toMatchObject({ keyId: 43, keyName: 'replacement' })
    expect(context.accountService.provisionCliKey).toHaveBeenCalledTimes(2)
    expect(context.store.upsert).toHaveBeenCalledTimes(2)
    await expect(vi.mocked(context.store.upsert).mock.results[0].value).resolves.toBe(false)
  })

  it('lists groups only for an authenticated account', async () => {
    const { coordinator } = setup()
    await expect(coordinator.listGroups()).resolves.toHaveLength(2)
  })
})

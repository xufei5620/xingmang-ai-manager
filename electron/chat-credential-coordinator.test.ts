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
    upsert: vi.fn(async (entry) => {
      if (overrides.storeFailure) throw overrides.storeFailure
      cached = [entry, ...cached.filter((candidate) => !(
        candidate.userId === entry.userId && candidate.group === entry.group
      ))]
    }),
  }
  const modelService = {
    fetchAvailableModels: vi.fn(async (key: string) => key.includes('生图')
      ? ['gpt-image-2', 'jimeng_high_aes_general_v21_L']
      : ['gpt-5.4']),
  }
  const coordinator = createChatCredentialCoordinator({ accountService, keyStore: store, modelService })
  return { coordinator, accountService, store, modelService, switchUser: (next: number) => { userId = next } }
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
    expect(modelService.fetchAvailableModels).toHaveBeenCalledWith(cached.key)
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

  it('lists groups only for an authenticated account', async () => {
    const { coordinator } = setup()
    await expect(coordinator.listGroups()).resolves.toHaveLength(2)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { managedCliKeyProfiles, providerIds, type ProviderId } from './catalog'
import {
  configureManagedClis,
  syncManagedCliKeySummary,
  type ManagedCliKeyStoreLike,
} from './account-cli-provisioner'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import type { RelayBackendClient } from './relay-backend'
import type { SystemService } from './system-service'

type AccountService = Pick<RelayBackendClient, 'getSessionState' | 'provisionCliKey'>
type ConfigurationService = Pick<SystemService, 'fetchAvailableModels' | 'saveConfig'>

function managedKey(provider: ProviderId): StoredManagedCliKey {
  const profile = managedCliKeyProfiles[provider]
  return {
    id: providerIds.indexOf(provider) + 1,
    provider,
    group: profile.group,
    name: profile.keyName,
    key: `sk-${provider}-plaintext-secret-123456`,
  }
}

function loggedInAccountService(
  provisionCliKey: ReturnType<typeof vi.fn>,
  userId = 73,
): AccountService {
  return {
    getSessionState: vi.fn(() => ({
      authenticated: true,
      account: { userId },
    })),
    provisionCliKey,
  } as unknown as AccountService
}

function keyForGroup(group: string): StoredManagedCliKey {
  const provider = providerIds.find((candidate) => managedCliKeyProfiles[candidate].group === group)
  if (!provider) throw new Error(`unexpected group: ${group}`)
  return managedKey(provider)
}

describe('syncManagedCliKeySummary', () => {
  it('fetches and saves four missing group keys once, then uses the complete local cache', async () => {
    let cached: StoredManagedCliKey[] = []
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => cached.map((entry) => ({ ...entry }))),
      save: vi.fn(async (_userId: number, keys: readonly StoredManagedCliKey[]) => {
        cached = keys.map((entry) => ({ ...entry }))
      }),
      remove: vi.fn(async (userId: number, keyId: number) => {
        if (userId === 73) cached = cached.filter((entry) => entry.id !== keyId)
      }),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      return { id: providerIds.indexOf(entry.provider) + 1, name: input.name ?? entry.name, key: entry.key }
    })
    const accountService = loggedInAccountService(provisionCliKey)

    const first = await syncManagedCliKeySummary(accountService, store)

    expect(first.failed).toEqual([])
    expect(first.ready).toEqual(providerIds.map((provider) => {
      const entry = managedKey(provider)
      return { provider, group: entry.group, name: entry.name }
    }))
    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual(providerIds.map((provider) => ({
      name: managedCliKeyProfiles[provider].keyName,
      group: managedCliKeyProfiles[provider].group,
    })))
    expect(store.save).toHaveBeenCalledTimes(1)
    expect(store.save).toHaveBeenCalledWith(73, providerIds.map((provider) => managedKey(provider)))

    provisionCliKey.mockClear()
    vi.mocked(store.save).mockClear()
    const second = await syncManagedCliKeySummary(accountService, store)

    expect(second).toEqual(first)
    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })

  it('keeps successful providers when one server provisioning call fails and saves the partial cache', async () => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      if (entry.provider === 'grok') throw new Error('grok 分组暂不可用')
      return { id: providerIds.indexOf(entry.provider) + 1, name: entry.name, key: entry.key }
    })

    const summary = await syncManagedCliKeySummary(loggedInAccountService(provisionCliKey), store)

    expect(summary.ready.map((entry) => entry.provider)).toEqual(['claude', 'codex', 'gemini'])
    expect(summary.failed).toEqual([{
      provider: 'grok',
      group: managedCliKeyProfiles.grok.group,
      message: 'grok 分组暂不可用',
    }])
    expect(store.save).toHaveBeenCalledWith(
      73,
      ['claude', 'codex', 'gemini'].map((provider) => managedKey(provider as ProviderId)),
    )
  })

  it('returns only non-sensitive status fields and never includes plaintext keys', async () => {
    const keys = providerIds.map((provider) => managedKey(provider))
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => keys),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async () => {
      throw new Error('the complete cache must not contact the server')
    })

    const summary = await syncManagedCliKeySummary(loggedInAccountService(provisionCliKey), store)
    const serialized = JSON.stringify(summary)

    expect(summary.ready.every((entry) => !('key' in entry))).toBe(true)
    for (const entry of keys) expect(serialized).not.toContain(entry.key)
    expect(provisionCliKey).not.toHaveBeenCalled()
  })

  it('isolates in-flight synchronization by user and rejects results from an account that switched away', async () => {
    let activeUserId = 73
    let releaseFirstRead: () => void = () => undefined
    const firstReadBlocked = new Promise<void>((resolve) => { releaseFirstRead = resolve })
    const savedByUser = new Map<number, StoredManagedCliKey[]>()
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async (userId: number) => {
        if (userId === 73) await firstReadBlocked
        return savedByUser.get(userId) ?? []
      }),
      save: vi.fn(async (userId: number, keys: readonly StoredManagedCliKey[]) => {
        savedByUser.set(userId, keys.map((entry) => ({ ...entry })))
      }),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      return {
        id: 100 + providerIds.indexOf(entry.provider),
        name: input.name ?? entry.name,
        key: `sk-user-${activeUserId}-${entry.provider}-secret-123456`,
      }
    })
    const accountService = {
      getSessionState: vi.fn(() => ({
        authenticated: true,
        account: { userId: activeUserId },
      })),
      provisionCliKey,
    } as unknown as AccountService

    const firstUserSync = syncManagedCliKeySummary(accountService, store)
    activeUserId = 99
    const secondUserSync = syncManagedCliKeySummary(accountService, store)

    const secondUserSummary = await secondUserSync
    releaseFirstRead()

    expect(secondUserSummary.ready).toHaveLength(4)
    await expect(firstUserSync).rejects.toThrow('账号已切换')
    expect(savedByUser.has(73)).toBe(false)
    expect(savedByUser.get(99)?.every((entry) => entry.key.includes('user-99'))).toBe(true)
    expect(store.read).toHaveBeenCalledWith(73)
    expect(store.read).toHaveBeenCalledWith(99)
  })

  it('discards a remote key result when the account changes while provisioning', async () => {
    let activeUserId = 73
    let releaseProvision: () => void = () => undefined
    let markProvisionStarted: () => void = () => undefined
    const provisionBlocked = new Promise<void>((resolve) => { releaseProvision = resolve })
    const provisionStarted = new Promise<void>((resolve) => { markProvisionStarted = resolve })
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      markProvisionStarted()
      await provisionBlocked
      const entry = keyForGroup(input.group ?? '')
      return { id: 1, name: entry.name, key: entry.key }
    })
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: activeUserId } })),
      provisionCliKey,
    } as unknown as AccountService

    const synchronization = syncManagedCliKeySummary(accountService, store)
    await provisionStarted
    activeUserId = 99
    releaseProvision()

    await expect(synchronization).rejects.toThrow('账号已切换')
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
    expect(store.save).not.toHaveBeenCalled()
  })
})

describe('configureManagedClis', () => {
  it('uses an independent key, model lookup, and config payload for each provider', async () => {
    const keys = providerIds.map((provider) => managedKey(provider))
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => keys),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const accountService = loggedInAccountService(vi.fn(async () => {
      throw new Error('the complete cache must not contact the server')
    }))
    const modelsByKey = new Map(keys.map((entry) => [
      entry.key,
      [`${entry.provider}-primary`, `${entry.provider}-preferred`],
    ]))
    const fetchAvailableModels = vi.fn(async (key: string) => modelsByKey.get(key) ?? [])
    const saveConfig = vi.fn(async (
      _payload: Parameters<ConfigurationService['saveConfig']>[0],
      _previewOnboarding: boolean,
    ) => ({ provider: 'codex' }))
    const systemService = { fetchAvailableModels, saveConfig } as unknown as ConfigurationService

    const result = await configureManagedClis(
      accountService,
      systemService,
      providerIds,
      { codex: 'codex-preferred', gemini: 'not-returned-by-server' },
      true,
      store,
    )

    expect(result).toEqual({ configured: [...providerIds], failed: [] })
    expect(fetchAvailableModels.mock.calls.map(([key]) => key)).toEqual(keys.map((entry) => entry.key))
    expect(saveConfig.mock.calls.map(([payload, preview]) => ({ payload, preview }))).toEqual(
      keys.map((entry) => ({
        payload: {
          provider: entry.provider,
          apiKey: entry.key,
          model: entry.provider === 'codex' ? 'codex-preferred' : `${entry.provider}-primary`,
          mode: 'merge',
        },
        preview: true,
      })),
    )
  })

  it('reports per-provider model/config failures and continues configuring the others', async () => {
    const keys = providerIds.map((provider) => managedKey(provider))
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => keys),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const accountService = loggedInAccountService(vi.fn())
    const fetchAvailableModels = vi.fn(async (key: string) => {
      const provider = keys.find((entry) => entry.key === key)?.provider
      if (provider === 'codex') throw new Error('Codex 模型接口超时')
      if (provider === 'gemini') return []
      return [`${provider}-model`]
    })
    const saveConfig = vi.fn(async (payload: { provider: ProviderId }) => {
      if (payload.provider === 'grok') throw new Error('Grok 配置写入失败')
      return { provider: payload.provider }
    })

    const result = await configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      providerIds,
      {},
      false,
      store,
    )

    expect(result).toEqual({
      configured: ['claude'],
      failed: [
        { provider: 'codex', message: 'Codex 模型接口超时' },
        { provider: 'grok', message: 'Grok 配置写入失败' },
        { provider: 'gemini', message: '当前分组未返回可用模型' },
      ],
    })
    expect(fetchAvailableModels).toHaveBeenCalledTimes(4)
    expect(saveConfig.mock.calls.map(([payload]) => payload.provider)).toEqual(['claude', 'grok'])
  })

  it('stops before writing CLI config when the account changes during model lookup', async () => {
    let activeUserId = 73
    const keys = providerIds.map((provider) => managedKey(provider))
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => keys),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: activeUserId } })),
      provisionCliKey: vi.fn(),
    } as unknown as AccountService
    const fetchAvailableModels = vi.fn(async () => {
      activeUserId = 99
      return ['provider-model']
    })
    const saveConfig = vi.fn()

    await expect(configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      providerIds,
      {},
      false,
      store,
    )).rejects.toThrow('账号已切换')

    expect(fetchAvailableModels).toHaveBeenCalledTimes(1)
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('stops remaining providers when the account changes while a CLI config write is in flight', async () => {
    let activeUserId = 73
    const keys = providerIds.map((provider) => managedKey(provider))
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => keys),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: activeUserId } })),
      provisionCliKey: vi.fn(),
    } as unknown as AccountService
    const fetchAvailableModels = vi.fn(async () => ['provider-model'])
    const saveConfig = vi.fn(async () => {
      activeUserId = 99
      return { provider: 'claude' }
    })

    await expect(configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      ['claude', 'codex'],
      {},
      false,
      store,
    )).rejects.toThrow('账号已切换')

    expect(fetchAvailableModels).toHaveBeenCalledTimes(1)
    expect(saveConfig).toHaveBeenCalledTimes(1)
  })
})

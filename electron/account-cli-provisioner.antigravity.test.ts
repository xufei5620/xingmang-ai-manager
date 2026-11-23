import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { managedCliKeyProfiles, sub2ApiManagedCliKeyProfiles } from './catalog'
import {
  AntigravityServiceUnavailableError,
  resolveAntigravityManagedKey,
  type ManagedCliKeyStoreLike,
} from './account-cli-provisioner'
import { managedKeyQuotaExhaustedMessage } from './account-key-quota'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import { networkFailureMessages } from './network-failure'
import { NewApiNetworkError } from './new-api-client'
import type { RelayBackendClient } from './relay-backend'
import type { SystemService } from './system-service'

type AccountService = Parameters<typeof resolveAntigravityManagedKey>[0]
type ModelService = Pick<SystemService, 'fetchAvailableModels'>

const geminiProfile = managedCliKeyProfiles.gemini
const models = ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-hydrogen']

function storedKey(provider: StoredManagedCliKey['provider'], overrides: Partial<StoredManagedCliKey> = {}): StoredManagedCliKey {
  const profile = managedCliKeyProfiles[provider]
  return {
    id: { claude: 1, codex: 2, grok: 3, gemini: 4 }[provider],
    provider,
    group: profile.group,
    name: profile.keyName,
    key: `sk-${provider}-plaintext-secret-123456`,
    ...overrides,
  }
}

interface MemoryStore extends ManagedCliKeyStoreLike {
  cached: StoredManagedCliKey[]
}

function memoryStore(initial: StoredManagedCliKey[] = [], siteId?: string): MemoryStore {
  const store: MemoryStore = {
    cached: initial.map((entry) => ({ ...entry })),
    read: vi.fn(async () => store.cached.map((entry) => ({ ...entry }))),
    save: vi.fn(async (_userId: number, keys: readonly StoredManagedCliKey[]) => {
      store.cached = keys.map((entry) => ({ ...entry }))
    }),
    remove: vi.fn(async (_userId: number, keyId: number) => {
      store.cached = store.cached.filter((entry) => entry.id !== keyId)
    }),
    ...(siteId ? { getSiteId: () => siteId } : {}),
  }
  return store
}

interface AccountOptions {
  groups?: Array<{ name: string; platform?: string }>
  siteId?: 'solov' | 'solov-api'
  listKeys?: RelayBackendClient['listKeys']
}

function accountService(options: AccountOptions = {}) {
  const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => ({
    id: 40,
    name: input.name ?? 'unnamed',
    key: `sk-new-${input.group}-secret-123456`,
  }))
  const listUsableGroups = vi.fn(async () => options.groups ?? [{ name: 'default' }, { name: 'Gemini' }, { name: 'Claude-MAX' }])
  const session = { authenticated: true, account: { userId: 73 } }
  const service = {
    getSessionState: vi.fn(() => session),
    provisionCliKey,
    listUsableGroups,
    ...(options.siteId ? { getActiveSiteId: () => options.siteId } : {}),
    ...(options.listKeys ? { listKeys: options.listKeys } : {}),
  } as unknown as AccountService
  return { service, provisionCliKey, listUsableGroups, session }
}

function modelService(answer: (key: string) => Promise<string[]>): ModelService & { fetchAvailableModels: ReturnType<typeof vi.fn> } {
  return { fetchAvailableModels: vi.fn(answer) }
}

describe('resolveAntigravityManagedKey', () => {
  it('signs the Gemini group key on first use, caches it next to the others and answers its models', async () => {
    const { service, provisionCliKey } = accountService()
    const store = memoryStore([storedKey('claude')])
    const lister = modelService(async () => models)

    const result = await resolveAntigravityManagedKey(service, lister, store)

    expect(result).toEqual({ key: 'sk-new-Gemini-secret-123456', group: 'Gemini', models })
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
    expect(provisionCliKey).toHaveBeenCalledWith({ name: geminiProfile.keyName, group: 'Gemini' })
    expect(lister.fetchAvailableModels).toHaveBeenCalledWith('sk-new-Gemini-secret-123456', { bypassCache: true })
    expect(store.cached).toEqual([
      storedKey('claude'),
      { id: 40, provider: 'gemini', group: 'Gemini', name: geminiProfile.keyName, key: 'sk-new-Gemini-secret-123456' },
    ])
  })

  it('reuses the key an old customer signed for the retired Gemini CLI without asking for groups', async () => {
    const { service, provisionCliKey, listUsableGroups } = accountService()
    const store = memoryStore([storedKey('gemini')])
    const lister = modelService(async () => models)

    const result = await resolveAntigravityManagedKey(service, lister, store)

    expect(result).toEqual({ key: storedKey('gemini').key, group: 'Gemini', models })
    expect(lister.fetchAvailableModels).toHaveBeenCalledWith(storedKey('gemini').key, { bypassCache: true })
    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(listUsableGroups).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })

  it('signs a new key in the same group when the cached one is no longer valid, and drops the dead one', async () => {
    const { service, provisionCliKey } = accountService()
    const store = memoryStore([storedKey('claude'), storedKey('gemini')])
    const lister = modelService(async (key) => {
      if (key === storedKey('gemini').key) throw new Error('服务返回 401：无效的令牌')
      return models
    })

    const result = await resolveAntigravityManagedKey(service, lister, store)

    expect(result).toEqual({ key: 'sk-new-Gemini-secret-123456', group: 'Gemini', models })
    expect(store.remove).toHaveBeenCalledWith(73, storedKey('gemini').id)
    expect(provisionCliKey).toHaveBeenCalledWith({ name: geminiProfile.keyName, group: 'Gemini' })
    expect(store.cached.map((entry) => entry.key)).toEqual([storedKey('claude').key, 'sk-new-Gemini-secret-123456'])
  })

  it('stops at a key whose own quota is used up instead of signing an unlimited one', async () => {
    const { service, provisionCliKey } = accountService()
    const store = memoryStore([storedKey('gemini')])
    const lister = modelService(async () => {
      throw new Error('服务返回 401：该令牌额度已用尽')
    })

    await expect(resolveAntigravityManagedKey(service, lister, store)).rejects.toThrow(managedKeyQuotaExhaustedMessage)
    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('passes a service outage on unchanged and keeps the cached key', async () => {
    const { service, provisionCliKey } = accountService()
    const store = memoryStore([storedKey('gemini')])
    const outage = new NewApiNetworkError('serviceUnavailable')
    const lister = modelService(async () => {
      throw outage
    })

    await expect(resolveAntigravityManagedKey(service, lister, store)).rejects.toBe(outage)
    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('moves to the renamed Gemini group when the old one is rejected', async () => {
    const { service, provisionCliKey } = accountService({ groups: [{ name: 'default' }, { name: 'Gemini-Pro' }] })
    const store = memoryStore([storedKey('gemini')])
    const lister = modelService(async (key) => {
      if (key === storedKey('gemini').key) throw new Error('服务返回 403：无权访问 Gemini 分组')
      return models
    })

    const result = await resolveAntigravityManagedKey(service, lister, store)

    expect(result.group).toBe('Gemini-Pro')
    expect(provisionCliKey).toHaveBeenCalledWith({ name: geminiProfile.keyName, group: 'Gemini-Pro' })
    expect(store.cached).toEqual([
      { id: 40, provider: 'gemini', group: 'Gemini-Pro', name: geminiProfile.keyName, key: 'sk-new-Gemini-Pro-secret-123456' },
    ])
  })

  it('copies the old key\'s limits when it has to move groups', async () => {
    const listKeys = vi.fn(async () => ({
      page: 1,
      pageSize: 100,
      total: 1,
      keys: [{
        id: storedKey('gemini').id,
        name: geminiProfile.keyName,
        maskedKey: 'sk-****',
        group: 'Gemini',
        status: 1,
        remainQuota: 500,
        unlimitedQuota: false,
        usedQuota: 100,
        createdAt: '2026-11-01T00:00:00.000Z',
        expiredAt: null,
        accessedAt: null,
      }],
    }))
    const { service, provisionCliKey } = accountService({
      groups: [{ name: 'Gemini-Pro' }],
      listKeys,
    })
    const store = memoryStore([storedKey('gemini')])
    const lister = modelService(async (key) => {
      if (key === storedKey('gemini').key) throw new Error('服务返回 403：分组 Gemini 已被弃用')
      return models
    })

    await resolveAntigravityManagedKey(service, lister, store)

    expect(provisionCliKey).toHaveBeenCalledTimes(1)
    const input = provisionCliKey.mock.calls[0]?.[0]
    expect(input).toEqual({ name: geminiProfile.keyName, group: 'Gemini-Pro', remainQuota: 500, unlimitedQuota: false, expiredTime: -1, fresh: true })
    // The copied limits keep the old key in the cache until the new one replaces it.
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('says the service is unavailable when the group is rejected and no other Gemini group is offered', async () => {
    const { service, provisionCliKey } = accountService({ groups: [{ name: 'default' }, { name: 'Claude-MAX' }] })
    const store = memoryStore([storedKey('gemini')])
    const lister = modelService(async () => {
      throw new Error('服务返回 403：无权访问 Gemini 分组')
    })

    const failure = resolveAntigravityManagedKey(service, lister, store)

    await expect(failure).rejects.toBeInstanceOf(AntigravityServiceUnavailableError)
    await expect(failure).rejects.toThrow(networkFailureMessages.serviceUnavailable)
    expect(provisionCliKey).not.toHaveBeenCalled()
  })

  it('says the service is unavailable when the account offers no Gemini group at all', async () => {
    const { service, provisionCliKey } = accountService({ groups: [{ name: 'default' }, { name: 'Claude-MAX' }] })
    const lister = modelService(async () => models)

    await expect(resolveAntigravityManagedKey(service, lister, memoryStore()))
      .rejects.toBeInstanceOf(AntigravityServiceUnavailableError)
    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(lister.fetchAvailableModels).not.toHaveBeenCalled()
  })

  it('says the service is unavailable when the group lists no models', async () => {
    const { service } = accountService()
    const lister = modelService(async () => [])

    await expect(resolveAntigravityManagedKey(service, lister, memoryStore([storedKey('gemini')])))
      .rejects.toBeInstanceOf(AntigravityServiceUnavailableError)
    await expect(resolveAntigravityManagedKey(service, lister, memoryStore()))
      .rejects.toBeInstanceOf(AntigravityServiceUnavailableError)
  })

  it('still signs with the shipped group name when the group list cannot be read', async () => {
    const { service, provisionCliKey, listUsableGroups } = accountService()
    listUsableGroups.mockRejectedValueOnce(new Error('network down'))
    const lister = modelService(async () => models)

    const result = await resolveAntigravityManagedKey(service, lister, memoryStore())

    expect(result.group).toBe('Gemini')
    expect(provisionCliKey).toHaveBeenCalledWith({ name: geminiProfile.keyName, group: 'Gemini' })
  })

  it('uses the historical account\'s Gemini group by its upstream tag', async () => {
    const { service, provisionCliKey } = accountService({
      siteId: 'solov-api',
      groups: [{ name: 'Claude-MAX(不限客户端)', platform: 'anthropic' }, { name: 'Gemini-Ultra', platform: 'gemini' }],
    })
    const lister = modelService(async () => models)

    const result = await resolveAntigravityManagedKey(service, lister, memoryStore([], 'solov-api'))

    expect(result.group).toBe('Gemini-Ultra')
    expect(provisionCliKey).toHaveBeenCalledWith({ name: sub2ApiManagedCliKeyProfiles.gemini.keyName, group: 'Gemini-Ultra' })
  })

  it('never uses a key cached for the other account site', async () => {
    const { service, provisionCliKey } = accountService({ siteId: 'solov' })
    const store = memoryStore([storedKey('gemini')], 'solov-api')
    const lister = modelService(async () => models)

    const result = await resolveAntigravityManagedKey(service, lister, store)

    expect(result.key).toBe('sk-new-Gemini-secret-123456')
    expect(lister.fetchAvailableModels).not.toHaveBeenCalledWith(storedKey('gemini').key, expect.anything())
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
  })

  it('signs a key even when the cache cannot be read', async () => {
    const { service, provisionCliKey } = accountService()
    const store = memoryStore()
    vi.mocked(store.read).mockRejectedValueOnce(new Error('damaged'))
    const lister = modelService(async () => models)

    await expect(resolveAntigravityManagedKey(service, lister, store)).resolves.toMatchObject({ group: 'Gemini' })
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
  })

  it('refuses before anything when nobody is signed in', async () => {
    const { service, provisionCliKey, session } = accountService()
    session.authenticated = false
    const lister = modelService(async () => models)

    await expect(resolveAntigravityManagedKey(service, lister, memoryStore())).rejects.toThrow('请先登录星芒账号')
    expect(provisionCliKey).not.toHaveBeenCalled()
  })

  it('stops without caching when the account changes while the key is being signed', async () => {
    const { service, provisionCliKey, session } = accountService()
    provisionCliKey.mockImplementationOnce(async (input: { name?: string; group?: string } = {}) => {
      session.account = { userId: 74 }
      return { id: 40, name: input.name ?? 'unnamed', key: 'sk-new-Gemini-secret-123456' }
    })
    const store = memoryStore()
    const lister = modelService(async () => models)

    await expect(resolveAntigravityManagedKey(service, lister, store)).rejects.toThrow('星芒账号已切换')
    expect(store.save).not.toHaveBeenCalled()
    expect(lister.fetchAvailableModels).not.toHaveBeenCalled()
  })
})

describe('resolveAntigravityManagedKey with random inputs', () => {
  const otherProviders = ['claude', 'codex', 'grok'] as const
  const outcome = fc.constantFrom('models', 'empty', 'expired', 'rejected', 'quota', 'outage')

  it('never touches the other tools\' cached keys, whatever the server answers', async () => {
    await fc.assert(fc.asyncProperty(
      fc.subarray([...otherProviders]),
      fc.boolean(),
      outcome,
      fc.array(fc.constantFrom('default', 'Gemini', 'Gemini-Pro', 'Claude-MAX', 'GPT'), { maxLength: 4 }),
      async (others, hasGemini, answer, groupNames) => {
        const before = [...others.map((provider) => storedKey(provider)), ...(hasGemini ? [storedKey('gemini')] : [])]
        const store = memoryStore(before)
        const { service } = accountService({ groups: groupNames.map((name) => ({ name })) })
        const lister = modelService(async (key) => {
          if (key !== storedKey('gemini').key) return answer === 'empty' ? [] : models
          if (answer === 'models') return models
          if (answer === 'empty') return []
          if (answer === 'expired') throw new Error('服务返回 401：无效的令牌')
          if (answer === 'rejected') throw new Error('服务返回 403：无权访问 Gemini 分组')
          if (answer === 'quota') throw new Error('服务返回 401：该令牌额度已用尽')
          throw new NewApiNetworkError('serviceUnavailable')
        })

        const result = await resolveAntigravityManagedKey(service, lister, store).catch(() => null)

        expect(store.cached.filter((entry) => entry.provider !== 'gemini')).toEqual(others.map((provider) => storedKey(provider)))
        if (result) expect(result.models.length).toBeGreaterThan(0)
      },
    ), { numRuns: 60 })
  })
})

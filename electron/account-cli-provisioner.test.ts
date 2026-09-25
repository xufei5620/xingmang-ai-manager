import { describe, expect, it, vi } from 'vitest'
import {
  managedCliKeyProfiles,
  providerIds,
  resolveManagedCliKeyProfiles,
  type ManagedCliKeyProfile,
  type ProviderId,
} from './catalog'
import {
  configureManagedClis,
  syncManagedCliKeySummary,
  type ManagedCliKeyStoreLike,
} from './account-cli-provisioner'
import type { StoredManagedCliKey } from './managed-cli-key-store'
import { NewApiNetworkError } from './new-api-client'
import { RealmAccountError } from './realm-account'
import type { RelayBackendClient } from './relay-backend'
import type { SystemService } from './system-service'

type AccountService = Pick<RelayBackendClient, 'getSessionState' | 'provisionCliKey' | 'listUsableGroups'>
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

  it('marks provisioning failures caused by an unavailable service so a switch does not roll back or blame the key', async () => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      if (entry.provider === 'codex') throw new NewApiNetworkError('serviceUnavailable', 'HTTP 522')
      if (entry.provider === 'grok') throw new RealmAccountError('UNAVAILABLE')
      if (entry.provider === 'gemini') throw new Error('gemini 分组暂不可用')
      return { id: providerIds.indexOf(entry.provider) + 1, name: entry.name, key: entry.key }
    })
    const saveConfig = vi.fn(async () => ({ backups: [], files: [] }))
    const outcome = await configureManagedClis(
      loggedInAccountService(provisionCliKey),
      { fetchAvailableModels: vi.fn(async () => ['fixture-model']), saveConfig } as unknown as ConfigurationService,
      ['codex', 'grok', 'gemini'], {}, false, store,
    )
    expect(outcome.failed).toEqual([
      { provider: 'codex', message: '服务暂时不可用（维护或线路繁忙），你这边不用做任何改动，稍后再试就行。（HTTP 522）', serviceUnavailable: true },
      { provider: 'grok', message: '服务暂时不可用（维护或线路繁忙），你这边不用做任何改动，稍后再试就行。', serviceUnavailable: true },
      { provider: 'gemini', message: 'gemini 分组暂不可用' },
    ])
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('continues after a damaged local cache and rebuilds it without a false warning', async () => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => { throw new Error('本地托管 API Key 配置已损坏或无法解密') }),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      return { id: providerIds.indexOf(entry.provider) + 1, name: entry.name, key: entry.key }
    })

    const summary = await syncManagedCliKeySummary(loggedInAccountService(provisionCliKey), store)

    expect(summary.ready.map((entry) => entry.provider)).toEqual(providerIds)
    expect(summary.failed).toEqual([])
    expect(summary.storageWarning).toBeUndefined()
    expect(store.save).toHaveBeenCalledTimes(1)
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

  it('re-provisions cached keys whose group belongs to the previous production mapping', async () => {
    const legacyGroups: Record<ProviderId, string> = {
      claude: 'Claude-MAX(不限制客户端)-5m',
      codex: 'codex-pro',
      grok: 'grok',
      gemini: 'Gemini',
    }
    let cached = providerIds.map((provider) => ({
      ...managedKey(provider),
      group: legacyGroups[provider],
      key: `sk-legacy-${provider}-secret-123456`,
    }))
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => cached.map((entry) => ({ ...entry }))),
      save: vi.fn(async (_userId: number, keys: readonly StoredManagedCliKey[]) => {
        cached = keys.map((entry) => ({ ...entry }))
      }),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      return { id: providerIds.indexOf(entry.provider) + 10, name: entry.name ?? entry.name, key: entry.key }
    })

    const summary = await syncManagedCliKeySummary(loggedInAccountService(provisionCliKey), store)

    expect(summary.failed).toEqual([])
    expect(provisionCliKey).toHaveBeenCalledTimes(providerIds.length)
    expect(cached.map((entry) => entry.group)).toEqual(providerIds.map((provider) => managedCliKeyProfiles[provider].group))
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

  it('rejects an ABA session when the same user logs in again', async () => {
    let revision = 1
    let releaseProvision: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => { releaseProvision = resolve })
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getSessionRevision: vi.fn(() => revision),
      provisionCliKey: vi.fn(async (input: { group?: string } = {}) => {
        await blocked
        const entry = keyForGroup(input.group ?? '')
        return { id: 1, name: entry.name, key: entry.key }
      }),
    } as unknown as AccountService

    const pending = syncManagedCliKeySummary(accountService, store)
    revision = 2
    releaseProvision()

    await expect(pending).rejects.toThrow('账号已切换')
    expect(store.save).not.toHaveBeenCalled()
  })
})

describe('configureManagedClis', () => {
  it.each([
    { provider: 'codex', models: ['codex-auto-review', 'gpt-5.6-sol', 'gpt-6-astra'], preferred: undefined, expected: 'gpt-6-astra' },
    { provider: 'codex', models: ['codex-auto-review', 'gpt-5.6-sol', 'gpt-6-astra'], preferred: 'gpt-5.6-sol', expected: 'gpt-5.6-sol' },
    { provider: 'codex', models: ['codex-auto-review', 'gpt-5.6-sol'], preferred: 'gpt-6-astra', expected: 'gpt-5.6-sol' },
    { provider: 'claude', models: ['claude-opus-4-6', 'claude-opus-5'], preferred: undefined, expected: 'claude-opus-5' },
    { provider: 'gemini', models: ['gemini-3.1-pro', 'gemini-3.8-flash-high'], preferred: undefined, expected: 'gemini-3.8-flash-high' },
    { provider: 'grok', models: ['grok-4.5', 'grok-4.6'], preferred: undefined, expected: 'grok-4.6' },
  ] satisfies Array<{ provider: ProviderId; models: string[]; preferred?: string; expected: string }>)('writes $expected from the actual $provider key model list with preference $preferred', async ({ provider, models, preferred, expected }) => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => providerIds.map((provider) => managedKey(provider))),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const fetchAvailableModels = vi.fn(async () => models)
    const saveConfig = vi.fn()

    const result = await configureManagedClis(
      loggedInAccountService(vi.fn()),
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      [provider],
      preferred ? { [provider]: preferred } : {},
      false,
      store,
    )

    expect(result).toEqual({ configured: [provider], failed: [] })
    expect(fetchAvailableModels).toHaveBeenCalledWith(managedKey(provider).key, { bypassCache: true })
    expect(saveConfig).toHaveBeenCalledWith({
      provider, apiKey: managedKey(provider).key, model: expected, mode: 'merge',
    }, false, expect.any(Function), { source: 'account', automatic: true })
  })

  it('reports a missing interactive default without writing an auto-review-only group to config', async () => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => providerIds.map((provider) => managedKey(provider))),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const saveConfig = vi.fn()

    const result = await configureManagedClis(
      loggedInAccountService(vi.fn()),
      { fetchAvailableModels: vi.fn(async () => ['codex-auto-review']), saveConfig } as unknown as ConfigurationService,
      ['codex'],
      {},
      false,
      store,
    )

    expect(result).toEqual({ configured: [], failed: [{
      provider: 'codex', message: '当前分组未返回可用于交互的默认模型，请选择其他分组或手动配置模型',
    }] })
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it.each(['cached', 'provisioned'] as const)('resets the selected config in one write with a %s managed key', async (source) => {
    const keys = providerIds.map((provider) => managedKey(provider))
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => source === 'cached' ? keys : []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      return { id: entry.id, name: entry.name, key: entry.key }
    })
    const fetchAvailableModels = vi.fn(async () => ['codex-primary', 'codex-preferred'])
    const saveConfig = vi.fn(async () => ({ provider: 'codex' }))

    const result = await configureManagedClis(
      loggedInAccountService(provisionCliKey),
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      ['codex'],
      { codex: 'codex-preferred' },
      false,
      store,
      'reset',
    )

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(provisionCliKey).toHaveBeenCalledTimes(source === 'cached' ? 0 : providerIds.length)
    expect(fetchAvailableModels).toHaveBeenCalledWith(managedKey('codex').key, { bypassCache: true })
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(saveConfig).toHaveBeenCalledWith({
      provider: 'codex',
      apiKey: managedKey('codex').key,
      model: 'codex-preferred',
      mode: 'reset',
    }, false, expect.any(Function), { source: 'account', automatic: true })
  })

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

// D-02: 两个账号站点各有一张 CLI Key 分组表,而 api.solov.cc 那张此前没有
// 任何测试读到过 —— 运营在后台改一次分组名,代码里的常量没跟上,CI 照样
// 全绿,客户一键配置四个 CLI 会整体失败。下面的取值按 catalog.ts 逐字抄写,
// 故意不从那两个常量 import:从被测代码里读回它自己的值等于什么都没验。
// 改分组名时必须同步改这里,这就是本表存在的意义。
const profilesBySite = {
  solov: {
    claude: { group: 'Claude-MAX订阅', keyName: 'xingmang-desktop-claude' },
    codex: { group: 'GPT-中转/订阅', keyName: 'xingmang-desktop-codex' },
    grok: { group: 'Grok-中转/订阅', keyName: 'xingmang-desktop-grok' },
    gemini: { group: 'Gemini-中转/订阅', keyName: 'xingmang-desktop-gemini' },
  },
  'solov-api': {
    claude: { group: 'Claude-MAX(不限客户端)', keyName: 'xingmang-desktop-claude' },
    codex: { group: 'Codex_pro', keyName: 'xingmang-desktop-codex' },
    grok: { group: 'grok-heavy', keyName: 'xingmang-desktop-grok' },
    gemini: { group: 'Gemini', keyName: 'xingmang-desktop-gemini' },
  },
} satisfies Record<string, Record<ProviderId, ManagedCliKeyProfile>>

type RelaySiteId = keyof typeof profilesBySite

function siteAwareAccountService(
  provisionCliKey: ReturnType<typeof vi.fn>,
  getActiveSiteId: () => string | undefined,
  userId = 73,
): AccountService {
  return {
    getSessionState: vi.fn(() => ({ authenticated: true, account: { userId } })),
    getActiveSiteId,
    provisionCliKey,
  } as unknown as AccountService
}

function siteManagedKey(siteId: RelaySiteId, provider: ProviderId): StoredManagedCliKey {
  const profile = profilesBySite[siteId][provider]
  return {
    id: providerIds.indexOf(provider) + 1,
    provider,
    group: profile.group,
    name: profile.keyName,
    key: `sk-${siteId}-${provider}-plaintext-secret-123456`,
  }
}

function siteAwareProvisioner(siteId: RelaySiteId) {
  return vi.fn(async (input: { name?: string; group?: string } = {}) => {
    const provider = providerIds.find((candidate) => profilesBySite[siteId][candidate].group === input.group)
    if (!provider) throw new Error(`unexpected group for ${siteId}: ${input.group}`)
    const entry = siteManagedKey(siteId, provider)
    return { id: entry.id, name: input.name ?? entry.name, key: entry.key }
  })
}

function recordingKeyStore(initial: StoredManagedCliKey[] = []): ManagedCliKeyStoreLike & { cached: StoredManagedCliKey[] } {
  const state = { cached: initial.map((entry) => ({ ...entry })) }
  return {
    get cached() { return state.cached },
    read: vi.fn(async () => state.cached.map((entry) => ({ ...entry }))),
    save: vi.fn(async (_userId: number, keys: readonly StoredManagedCliKey[]) => {
      state.cached = keys.map((entry) => ({ ...entry }))
    }),
    remove: vi.fn(async (_userId: number, keyId: number) => {
      state.cached = state.cached.filter((entry) => entry.id !== keyId)
    }),
  } as ManagedCliKeyStoreLike & { cached: StoredManagedCliKey[] }
}

describe('relay-site-specific managed CLI key groups', () => {
  it.each(['solov', 'solov-api'] as const)('pins the %s key group and key name of every CLI', (siteId) => {
    expect(resolveManagedCliKeyProfiles(siteId)).toEqual(profilesBySite[siteId])
  })

  it('falls back to the xm groups for a missing or unknown site id', () => {
    expect(resolveManagedCliKeyProfiles(undefined)).toEqual(profilesBySite.solov)
    expect(resolveManagedCliKeyProfiles('sub2api')).toEqual(profilesBySite.solov)
  })

  it.each(['solov', 'solov-api'] as const)('provisions and caches every CLI key from the %s group table', async (siteId) => {
    const store = recordingKeyStore()
    const provisionCliKey = siteAwareProvisioner(siteId)
    const accountService = siteAwareAccountService(provisionCliKey, () => siteId)

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(summary.failed).toEqual([])
    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual(providerIds.map((provider) => ({
      name: profilesBySite[siteId][provider].keyName,
      group: profilesBySite[siteId][provider].group,
    })))
    expect(summary.ready).toEqual(providerIds.map((provider) => ({
      provider,
      group: profilesBySite[siteId][provider].group,
      name: profilesBySite[siteId][provider].keyName,
    })))
    expect(store.cached.map((entry) => ({ provider: entry.provider, group: entry.group }))).toEqual(
      providerIds.map((provider) => ({ provider, group: profilesBySite[siteId][provider].group })),
    )
  })

  it('re-provisions every cached key after the account moves to the other relay site', async () => {
    const store = recordingKeyStore(providerIds.map((provider) => siteManagedKey('solov', provider)))
    const provisionCliKey = siteAwareProvisioner('solov-api')
    const accountService = siteAwareAccountService(provisionCliKey, () => 'solov-api')

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(summary.failed).toEqual([])
    expect(provisionCliKey).toHaveBeenCalledTimes(providerIds.length)
    expect(summary.ready.map((entry) => entry.group)).toEqual(
      providerIds.map((provider) => profilesBySite['solov-api'][provider].group),
    )
    // 旧站点的缓存条目必须整体被丢弃,否则 xm 的 Key 会继续被写进指向
    // api.solov.cc 的 CLI 配置里。
    expect(store.cached.map((entry) => entry.key)).toEqual(
      providerIds.map((provider) => siteManagedKey('solov-api', provider).key),
    )
    const xmKeys = new Set(providerIds.map((provider) => siteManagedKey('solov', provider).key))
    for (const entry of store.cached) expect(xmKeys.has(entry.key)).toBe(false)
  })

  it('writes the sub2api group key of each CLI into its config payload', async () => {
    const keys = providerIds.map((provider) => siteManagedKey('solov-api', provider))
    const store = recordingKeyStore(keys)
    const accountService = siteAwareAccountService(
      vi.fn(async () => { throw new Error('the complete cache must not contact the server') }),
      () => 'solov-api',
    )
    const fetchAvailableModels = vi.fn(async (key: string) => {
      const provider = keys.find((entry) => entry.key === key)?.provider
      return provider ? [`${provider}-model`] : []
    })
    const saveConfig = vi.fn(async (payload: { provider: ProviderId }) => ({ provider: payload.provider }))

    const result = await configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      providerIds,
      {},
      false,
      store,
    )

    expect(result).toEqual({ configured: [...providerIds], failed: [] })
    expect(saveConfig.mock.calls.map(([payload]) => payload)).toEqual(keys.map((entry) => ({
      provider: entry.provider,
      apiKey: entry.key,
      model: `${entry.provider}-model`,
      mode: 'merge',
    })))
  })

  it('stops instead of re-provisioning when the key\'s own quota cap is used up', async () => {
    const capped = { ...siteManagedKey('solov', 'claude'), key: 'sk-solov-claude-capped-1234567' }
    const store = recordingKeyStore([capped])
    const provisionCliKey = siteAwareProvisioner('solov')
    const accountService = siteAwareAccountService(provisionCliKey, () => 'solov')
    const fetchAvailableModels = vi.fn(async () => {
      throw new Error('模型查询失败，服务返回 401：该令牌额度已用尽 TokenStatusExhausted[sk-***]')
    })
    const saveConfig = vi.fn()

    const result = await configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      ['claude'],
      {},
      false,
      store,
      'merge',
      'explicit',
    )

    expect(result.configured).toEqual([])
    expect(result.failed).toEqual([{ provider: 'claude', message: expect.stringContaining('这个工具的额度用完了') }])
    expect(store.remove).not.toHaveBeenCalled()
    // The other three tools were never cached, so the sync signs those; the
    // capped one is the only key that must not be re-signed.
    expect(provisionCliKey).not.toHaveBeenCalledWith(expect.objectContaining({ name: profilesBySite.solov.claude.keyName }))
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('re-provisions a rejected sub2api key from the same site group instead of the xm one', async () => {
    const stale = { ...siteManagedKey('solov-api', 'codex'), key: 'sk-solov-api-codex-revoked-123456' }
    const store = recordingKeyStore([stale])
    const provisionCliKey = siteAwareProvisioner('solov-api')
    const accountService = siteAwareAccountService(provisionCliKey, () => 'solov-api')
    const fetchAvailableModels = vi.fn(async (key: string) => {
      if (key === stale.key) throw new Error('模型查询失败，服务返回 401')
      return ['codex-model']
    })
    const saveConfig = vi.fn(async (payload: Parameters<ConfigurationService['saveConfig']>[0]) => ({ provider: payload.provider }))

    const result = await configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      ['codex'],
      {},
      false,
      store,
    )

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(store.remove).toHaveBeenCalledWith(73, stale.id)
    expect(provisionCliKey).toHaveBeenCalledWith({
      name: profilesBySite['solov-api'].codex.keyName,
      group: profilesBySite['solov-api'].codex.group,
    })
    expect(saveConfig.mock.calls[0][0]).toEqual({
      provider: 'codex',
      apiKey: siteManagedKey('solov-api', 'codex').key,
      model: 'codex-model',
      mode: 'merge',
    })
  })
})

describe('managed CLI groups resolved from the account backend', () => {
  const renamedGroups: Record<ProviderId, string> = {
    claude: 'Claude 高级订阅',
    codex: 'Codex 专用通道',
    gemini: 'Gemini 专用通道',
    grok: 'Grok 专用通道',
  }

  function memoryStore(initial: StoredManagedCliKey[] = []): ManagedCliKeyStoreLike & { cached: StoredManagedCliKey[] } {
    const state = { cached: initial.map((entry) => ({ ...entry })) }
    return {
      get cached() { return state.cached },
      read: vi.fn(async () => state.cached.map((entry) => ({ ...entry }))),
      save: vi.fn(async (_userId: number, keys: readonly StoredManagedCliKey[]) => {
        state.cached = keys.map((entry) => ({ ...entry }))
      }),
      remove: vi.fn(async () => undefined),
    } as ManagedCliKeyStoreLike & { cached: StoredManagedCliKey[] }
  }

  function groupAwareAccountService(listUsableGroups: ReturnType<typeof vi.fn>) {
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => ({
      id: 100 + providerIds.findIndex((provider) => renamedGroups[provider] === input.group),
      name: input.name ?? 'xingmang-desktop',
      key: `sk-${input.group}-plaintext-secret-123456`,
    }))
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      provisionCliKey,
      listUsableGroups,
    } as unknown as AccountService
    return { accountService, provisionCliKey }
  }

  it('signs keys into the renamed groups the backend actually offers', async () => {
    const listUsableGroups = vi.fn(async () => (
      ['default', ...providerIds.map((provider) => renamedGroups[provider])].map((name) => ({ name }))
    ))
    const { accountService, provisionCliKey } = groupAwareAccountService(listUsableGroups)

    const summary = await syncManagedCliKeySummary(accountService, memoryStore())

    expect(summary.failed).toEqual([])
    expect(summary.ready.map((entry) => entry.group).sort())
      .toEqual(providerIds.map((provider) => renamedGroups[provider]).sort())
    for (const provider of providerIds) {
      expect(provisionCliKey).toHaveBeenCalledWith({
        name: managedCliKeyProfiles[provider].keyName,
        group: renamedGroups[provider],
      })
    }
    expect(listUsableGroups).toHaveBeenCalledTimes(1)
  })

  it('keeps the shipped names when the backend still offers them', async () => {
    const listUsableGroups = vi.fn(async () => (
      providerIds.map((provider) => ({ name: managedCliKeyProfiles[provider].group }))
    ))
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      return { id: providerIds.indexOf(entry.provider) + 1, name: input.name ?? entry.name, key: entry.key }
    })
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      provisionCliKey,
      listUsableGroups,
    } as unknown as AccountService

    const summary = await syncManagedCliKeySummary(accountService, memoryStore())

    expect(summary.ready.map((entry) => entry.group).sort())
      .toEqual(providerIds.map((provider) => managedCliKeyProfiles[provider].group).sort())
  })

  it('falls back to the shipped names when the group list cannot be read', async () => {
    const listUsableGroups = vi.fn(async () => { throw new Error('连接服务器失败') })
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      return { id: providerIds.indexOf(entry.provider) + 1, name: input.name ?? entry.name, key: entry.key }
    })
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      provisionCliKey,
      listUsableGroups,
    } as unknown as AccountService

    const summary = await syncManagedCliKeySummary(accountService, memoryStore())

    expect(summary.failed).toEqual([])
    expect(summary.ready.map((entry) => entry.group).sort())
      .toEqual(providerIds.map((provider) => managedCliKeyProfiles[provider].group).sort())
  })

  it('asks the backend for nothing when every key is already cached', async () => {
    const listUsableGroups = vi.fn(async () => [])
    const provisionCliKey = vi.fn()
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      provisionCliKey,
      listUsableGroups,
    } as unknown as AccountService
    const store = memoryStore(providerIds.map((provider) => managedKey(provider)))

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(summary.failed).toEqual([])
    expect(listUsableGroups).not.toHaveBeenCalled()
    expect(provisionCliKey).not.toHaveBeenCalled()
  })

  it('discards a cached key whose group the backend no longer offers', async () => {
    const listUsableGroups = vi.fn(async () => (
      ['default', ...providerIds.map((provider) => renamedGroups[provider])].map((name) => ({ name }))
    ))
    const { accountService, provisionCliKey } = groupAwareAccountService(listUsableGroups)
    // 缓存里三把还在，claude 那把是改名前签的：它必须被丢掉重签，否则请求会继续
    // 打到一个服务端已经不认的分组上。
    const store = memoryStore([managedKey('claude')])

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(summary.ready.find((entry) => entry.provider === 'claude')?.group).toBe(renamedGroups.claude)
    expect(provisionCliKey).toHaveBeenCalledWith({
      name: managedCliKeyProfiles.claude.keyName,
      group: renamedGroups.claude,
    })
  })
})

describe('history-account subscriptions decide the managed key group', () => {
  const sub2Api = profilesBySite['solov-api']
  const platforms: Record<ProviderId, string> = { claude: 'anthropic', codex: 'openai', gemini: 'gemini', grok: 'grok' }

  function subscriptionAccountService(state: { subscribed: string[]; groupsFail?: boolean }) {
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => ({
      id: input.group === 'Claude 包月' ? 900 : 100,
      name: input.name ?? 'xingmang-desktop',
      key: `sk-${input.group}-plaintext-secret-123456`,
    }))
    const getSubscriptionSelf = vi.fn(async () => ({
      billingPreference: null,
      activeSubscriptions: state.subscribed.map((groupName, index) => ({
        id: index + 1, planId: index + 1, status: 'active', source: 'sub2api', groupName,
        amountTotal: null, amountUsed: null, startedAt: '', endsAt: '', nextResetAt: null,
      })),
      allSubscriptions: [],
    }))
    const listUsableGroups = vi.fn(async () => {
      if (state.groupsFail) throw new Error('连接服务器失败')
      return [
        ...providerIds.map((provider) => ({ name: sub2Api[provider].group, description: '', ratio: 1, platform: platforms[provider] })),
        ...state.subscribed.map((name) => ({ name, description: '', ratio: 1, platform: 'anthropic' })),
      ]
    })
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: () => 'solov-api',
      provisionCliKey,
      listUsableGroups,
      getSubscriptionSelf,
    } as unknown as AccountService
    return { accountService, provisionCliKey, listUsableGroups }
  }

  it('moves only the subscribed CLI into its subscription group and reports it as regrouped', async () => {
    const store = recordingKeyStore(providerIds.map((provider) => siteManagedKey('solov-api', provider)))
    const { accountService, provisionCliKey, listUsableGroups } = subscriptionAccountService({ subscribed: ['Claude 包月'] })

    const summary = await syncManagedCliKeySummary(accountService, store)

    // The complete cache does not short-circuit here: a purchase is invisible locally.
    expect(listUsableGroups).toHaveBeenCalledTimes(1)
    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual([{ name: sub2Api.claude.keyName, group: 'Claude 包月' }])
    expect(summary.regrouped).toEqual(['claude'])
    expect(summary.ready.find((entry) => entry.provider === 'claude')?.group).toBe('Claude 包月')
    expect(store.cached.find((entry) => entry.provider === 'codex')?.key).toBe(siteManagedKey('solov-api', 'codex').key)
  })

  it('moves the CLI back to its usual group once the subscription is gone', async () => {
    const store = recordingKeyStore([
      { ...siteManagedKey('solov-api', 'claude'), id: 900, group: 'Claude 包月', key: 'sk-subscription-plaintext-secret-123456' },
      ...providerIds.filter((provider) => provider !== 'claude').map((provider) => siteManagedKey('solov-api', provider)),
    ])
    const { accountService, provisionCliKey } = subscriptionAccountService({ subscribed: [] })

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual([{ name: sub2Api.claude.keyName, group: sub2Api.claude.group }])
    expect(summary.regrouped).toEqual(['claude'])
  })

  it('keeps a cached subscription key when the groups cannot be read', async () => {
    const store = recordingKeyStore([
      { ...siteManagedKey('solov-api', 'claude'), id: 900, group: 'Claude 包月', key: 'sk-subscription-plaintext-secret-123456' },
      ...providerIds.filter((provider) => provider !== 'claude').map((provider) => siteManagedKey('solov-api', provider)),
    ])
    const { accountService, provisionCliKey } = subscriptionAccountService({ subscribed: ['Claude 包月'], groupsFail: true })

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(summary.failed).toEqual([])
    expect(summary.regrouped).toBeUndefined()
    expect(summary.ready.find((entry) => entry.provider === 'claude')?.group).toBe('Claude 包月')
  })

  it('leaves the xm account alone: its subscriptions do not depend on the key group', async () => {
    const store = recordingKeyStore(providerIds.map((provider) => siteManagedKey('solov', provider)))
    const getSubscriptionSelf = vi.fn()
    const listUsableGroups = vi.fn()
    const provisionCliKey = vi.fn()
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: () => 'solov',
      provisionCliKey,
      listUsableGroups,
      getSubscriptionSelf,
    } as unknown as AccountService

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(summary.regrouped).toBeUndefined()
    expect(getSubscriptionSelf).not.toHaveBeenCalled()
    expect(listUsableGroups).not.toHaveBeenCalled()
    expect(provisionCliKey).not.toHaveBeenCalled()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activeProviderIds,
  managedCliKeyProfiles,
  providerIds,
  resolveManagedCliKeyProfiles,
  type ManagedCliKeyProfile,
  type ProviderId,
} from './catalog'
import {
  accountGroupHintsFingerprint,
  configureManagedClis,
  isCachedGroupCheckDue,
  isManagedToolKeyName,
  movesFullyCachedKey,
  retiresReplacedKey,
  syncManagedCliKeySummary,
  type ManagedCliKeyStoreLike,
} from './account-cli-provisioner'
import type { AccountGroupHints } from './managed-cli-groups'
import { ManagedCliKeyStore, managedKeyDigest, type StoredManagedCliKey } from './managed-cli-key-store'
import type { SafeStorageLike } from './account-session-store'
import { NewApiNetworkError } from './new-api-client'
import { RealmAccountError } from './realm-account'
import type { RelayBackendClient } from './relay-backend'
import type { SystemService } from './system-service'
import type { CliModelHints } from './cli-model-defaults'

type AccountService = Pick<RelayBackendClient, 'getSessionState' | 'provisionCliKey' | 'listUsableGroups' | 'getActiveSiteId'>
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
  it('fetches and saves the missing group key of every active tool once, then uses the complete local cache', async () => {
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
    expect(first.ready).toEqual(activeProviderIds.map((provider) => {
      const entry = managedKey(provider)
      return { provider, group: entry.group, name: entry.name }
    }))
    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual(activeProviderIds.map((provider) => ({
      name: managedCliKeyProfiles[provider].keyName,
      group: managedCliKeyProfiles[provider].group,
    })))
    expect(store.save).toHaveBeenCalledTimes(1)
    expect(store.save).toHaveBeenCalledWith(73, activeProviderIds.map((provider) => managedKey(provider)))

    provisionCliKey.mockClear()
    vi.mocked(store.save).mockClear()
    const second = await syncManagedCliKeySummary(accountService, store)

    expect(second).toEqual(first)
    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })

  it('never signs or hands out a key for the retired Gemini CLI but keeps its cached one', async () => {
    const gemini = managedKey('gemini')
    let cached: StoredManagedCliKey[] = [gemini, managedKey('claude')]
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => cached.map((entry) => ({ ...entry }))),
      save: vi.fn(async (_userId: number, keys: readonly StoredManagedCliKey[]) => {
        cached = keys.map((entry) => ({ ...entry }))
      }),
      remove: vi.fn(async () => undefined),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const entry = keyForGroup(input.group ?? '')
      return { id: providerIds.indexOf(entry.provider) + 1, name: input.name ?? entry.name, key: entry.key }
    })

    const summary = await syncManagedCliKeySummary(loggedInAccountService(provisionCliKey), store)

    expect(summary.failed).toEqual([])
    expect(summary.ready.map((entry) => entry.provider)).toEqual(['claude', 'codex', 'grok'])
    expect(provisionCliKey.mock.calls.map(([input]) => input?.group)).toEqual([
      managedCliKeyProfiles.codex.group,
      managedCliKeyProfiles.grok.group,
    ])
    expect(cached.map((entry) => entry.provider)).toEqual(['claude', 'codex', 'grok', 'gemini'])
    expect(cached.find((entry) => entry.provider === 'gemini')).toEqual(gemini)

    const saveConfig = vi.fn()
    const outcome = await configureManagedClis(
      loggedInAccountService(provisionCliKey),
      { fetchAvailableModels: vi.fn(async () => ['gemini-3.8-flash-high']), saveConfig } as unknown as ConfigurationService,
      ['gemini'], {}, false, store,
    )
    expect(outcome.configured).toEqual([])
    expect(saveConfig).not.toHaveBeenCalled()
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

    expect(summary.ready.map((entry) => entry.provider)).toEqual(['claude', 'codex'])
    expect(summary.failed).toEqual([{
      provider: 'grok',
      group: managedCliKeyProfiles.grok.group,
      message: 'grok 分组暂不可用',
    }])
    expect(store.save).toHaveBeenCalledWith(
      73,
      ['claude', 'codex'].map((provider) => managedKey(provider as ProviderId)),
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
      if (entry.provider === 'claude') throw new Error('claude 分组暂不可用')
      return { id: providerIds.indexOf(entry.provider) + 1, name: entry.name, key: entry.key }
    })
    const saveConfig = vi.fn(async () => ({ backups: [], files: [] }))
    const outcome = await configureManagedClis(
      loggedInAccountService(provisionCliKey),
      { fetchAvailableModels: vi.fn(async () => ['fixture-model']), saveConfig } as unknown as ConfigurationService,
      ['codex', 'grok', 'claude'], {}, false, store,
    )
    expect(outcome.failed).toEqual([
      { provider: 'codex', message: '服务暂时不可用（维护或线路繁忙），你这边不用做任何改动，稍后再试就行。（HTTP 522）', serviceUnavailable: true },
      { provider: 'grok', message: '服务暂时不可用（维护或线路繁忙），你这边不用做任何改动，稍后再试就行。', serviceUnavailable: true },
      { provider: 'claude', message: 'claude 分组暂不可用' },
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

    expect(summary.ready.map((entry) => entry.provider)).toEqual(activeProviderIds)
    expect(summary.failed).toEqual([])
    expect(summary.storageWarning).toBeUndefined()
    expect(store.save).toHaveBeenCalledTimes(1)
  })

  it('returns only non-sensitive status fields and never includes plaintext keys', async () => {
    const keys = activeProviderIds.map((provider) => managedKey(provider))
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
    let cached = activeProviderIds.map((provider) => ({
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
    expect(provisionCliKey).toHaveBeenCalledTimes(activeProviderIds.length)
    expect(cached.map((entry) => entry.group)).toEqual(activeProviderIds.map((provider) => managedCliKeyProfiles[provider].group))
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

    expect(secondUserSummary.ready).toHaveLength(activeProviderIds.length)
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
    { provider: 'grok', models: ['grok-4.5', 'grok-4.6'], preferred: undefined, expected: 'grok-4.6' },
  ] satisfies Array<{ provider: ProviderId; models: string[]; preferred?: string; expected: string }>)('writes $expected from the actual $provider key model list with preference $preferred', async ({ provider, models, preferred, expected }) => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => activeProviderIds.map((provider) => managedKey(provider))),
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

  it('picks the default from the published model table, and from the bundled one when that cannot be read', async () => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => activeProviderIds.map((provider) => managedKey(provider))),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const fetchAvailableModels = vi.fn(async () => ['gpt-6-astra', 'gpt-7'])
    async function configureWith(getCliModelHints: () => Promise<CliModelHints | null>) {
      const saveConfig = vi.fn()
      const accountService = Object.assign(loggedInAccountService(vi.fn()), { getCliModelHints })
      await configureManagedClis(accountService, { fetchAvailableModels, saveConfig } as unknown as ConfigurationService, ['codex'], {}, false, store)
      return saveConfig.mock.calls[0]?.[0]
    }

    await expect(configureWith(async () => ({ codex: { default: 'gpt-7' } }))).resolves.toMatchObject({ provider: 'codex', model: 'gpt-7' })
    await expect(configureWith(async () => null)).resolves.toMatchObject({ provider: 'codex', model: 'gpt-6-astra' })
    await expect(configureWith(async () => { throw new Error('offline') })).resolves.toMatchObject({ provider: 'codex', model: 'gpt-6-astra' })
  })

  it('reports a missing interactive default without writing an auto-review-only group to config', async () => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => activeProviderIds.map((provider) => managedKey(provider))),
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
    const keys = activeProviderIds.map((provider) => managedKey(provider))
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
    expect(provisionCliKey).toHaveBeenCalledTimes(source === 'cached' ? 0 : activeProviderIds.length)
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
    const keys = activeProviderIds.map((provider) => managedKey(provider))
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
      activeProviderIds,
      { codex: 'codex-preferred', grok: 'not-returned-by-server' },
      true,
      store,
    )

    expect(result).toEqual({ configured: [...activeProviderIds], failed: [] })
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
    const keys = activeProviderIds.map((provider) => managedKey(provider))
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => keys),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const accountService = loggedInAccountService(vi.fn())
    const fetchAvailableModels = vi.fn(async (key: string) => {
      const provider = keys.find((entry) => entry.key === key)?.provider
      if (provider === 'codex') throw new Error('Codex 模型接口超时')
      return [`${provider}-model`]
    })
    const saveConfig = vi.fn(async (payload: { provider: ProviderId }) => {
      if (payload.provider === 'grok') throw new Error('Grok 配置写入失败')
      return { provider: payload.provider }
    })

    const result = await configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      activeProviderIds,
      {},
      false,
      store,
    )

    expect(result).toEqual({
      configured: ['claude'],
      failed: [
        { provider: 'codex', message: 'Codex 模型接口超时' },
        { provider: 'grok', message: 'Grok 配置写入失败' },
      ],
    })
    expect(fetchAvailableModels).toHaveBeenCalledTimes(3)
    expect(saveConfig.mock.calls.map(([payload]) => payload.provider)).toEqual(['claude', 'grok'])
  })

  it('reports a group that returns no models without writing its config', async () => {
    const store: ManagedCliKeyStoreLike = {
      read: vi.fn(async () => activeProviderIds.map((provider) => managedKey(provider))),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }
    const saveConfig = vi.fn()

    const result = await configureManagedClis(
      loggedInAccountService(vi.fn()),
      { fetchAvailableModels: vi.fn(async () => []), saveConfig } as unknown as ConfigurationService,
      ['grok'],
      {},
      false,
      store,
    )

    expect(result).toEqual({ configured: [], failed: [{ provider: 'grok', message: '当前分组未返回可用模型' }] })
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('stops before writing CLI config when the account changes during model lookup', async () => {
    let activeUserId = 73
    const keys = activeProviderIds.map((provider) => managedKey(provider))
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
      activeProviderIds,
      {},
      false,
      store,
    )).rejects.toThrow('账号已切换')

    expect(fetchAvailableModels).toHaveBeenCalledTimes(1)
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('stops remaining providers when the account changes while a CLI config write is in flight', async () => {
    let activeUserId = 73
    const keys = activeProviderIds.map((provider) => managedKey(provider))
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
  // xm 站 2026-10-16 删了「Claude-MAX订阅」「GPT-中转/订阅」这些老名字。
  solov: {
    claude: { group: 'Claude-MAX', keyName: 'xingmang-desktop-claude' },
    codex: { group: 'GPT', keyName: 'xingmang-desktop-codex' },
    grok: { group: 'Grok', keyName: 'xingmang-desktop-grok' },
    gemini: { group: 'Gemini', keyName: 'xingmang-desktop-gemini' },
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

function recordingKeyStore(
  initial: StoredManagedCliKey[] = [],
  siteId?: 'solov' | 'solov-api',
): ManagedCliKeyStoreLike & { cached: StoredManagedCliKey[] } {
  const state = { cached: initial.map((entry) => ({ ...entry })) }
  return {
    ...(siteId ? { getSiteId: () => siteId } : {}),
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
    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual(activeProviderIds.map((provider) => ({
      name: profilesBySite[siteId][provider].keyName,
      group: profilesBySite[siteId][provider].group,
    })))
    expect(summary.ready).toEqual(activeProviderIds.map((provider) => ({
      provider,
      group: profilesBySite[siteId][provider].group,
      name: profilesBySite[siteId][provider].keyName,
    })))
    expect(store.cached.map((entry) => ({ provider: entry.provider, group: entry.group }))).toEqual(
      activeProviderIds.map((provider) => ({ provider, group: profilesBySite[siteId][provider].group })),
    )
  })

  it('re-provisions every cached key after the account moves to the other relay site', async () => {
    const store = recordingKeyStore(activeProviderIds.map((provider) => siteManagedKey('solov', provider)))
    const provisionCliKey = siteAwareProvisioner('solov-api')
    const accountService = siteAwareAccountService(provisionCliKey, () => 'solov-api')

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(summary.failed).toEqual([])
    expect(provisionCliKey).toHaveBeenCalledTimes(activeProviderIds.length)
    expect(summary.ready.map((entry) => entry.group)).toEqual(
      activeProviderIds.map((provider) => profilesBySite['solov-api'][provider].group),
    )
    // 旧站点的缓存条目必须整体被丢弃,否则 xm 的 Key 会继续被写进指向
    // api.solov.cc 的 CLI 配置里。
    expect(store.cached.map((entry) => entry.key)).toEqual(
      activeProviderIds.map((provider) => siteManagedKey('solov-api', provider).key),
    )
    const xmKeys = new Set(activeProviderIds.map((provider) => siteManagedKey('solov', provider).key))
    for (const entry of store.cached) expect(xmKeys.has(entry.key)).toBe(false)
  })

  it('rejects a cache bound to another site even when its group names match', async () => {
    const foreignKeys = activeProviderIds.map((provider) => siteManagedKey('solov', provider))
    const store = { ...recordingKeyStore(foreignKeys), getSiteId: () => 'solov-api' }
    const provisionCliKey = siteAwareProvisioner('solov')
    const accountService = siteAwareAccountService(provisionCliKey, () => 'solov')

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(summary.failed).toEqual([])
    expect(provisionCliKey).toHaveBeenCalledTimes(activeProviderIds.length)
  })

  it('writes the sub2api group key of each CLI into its config payload', async () => {
    const keys = activeProviderIds.map((provider) => siteManagedKey('solov-api', provider))
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
      activeProviderIds,
      {},
      false,
      store,
    )

    expect(result).toEqual({ configured: [...activeProviderIds], failed: [] })
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

  it('replaces only the rejected entry in the cache and keeps the retired Gemini key', async () => {
    const stale = { ...siteManagedKey('solov', 'codex'), id: 20, key: 'sk-solov-codex-revoked-123456' }
    const gemini = siteManagedKey('solov', 'gemini')
    const store = recordingKeyStore([siteManagedKey('solov', 'claude'), stale, siteManagedKey('solov', 'grok'), gemini])
    const provisionCliKey = siteAwareProvisioner('solov')
    const fetchAvailableModels = vi.fn(async (key: string) => {
      if (key === stale.key) throw new Error('模型查询失败，服务返回 401')
      return ['codex-model']
    })

    const result = await configureManagedClis(
      siteAwareAccountService(provisionCliKey, () => 'solov'),
      { fetchAvailableModels, saveConfig: vi.fn(async () => ({ backups: [], files: [] })) } as unknown as ConfigurationService,
      ['codex'], {}, false, store,
    )

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
    expect(store.cached).toEqual([
      siteManagedKey('solov', 'claude'),
      siteManagedKey('solov', 'codex'),
      siteManagedKey('solov', 'grok'),
      gemini,
    ])
  })

  it('still writes the replacement key into the config when the local cache cannot be updated', async () => {
    const stale = { ...siteManagedKey('solov', 'codex'), id: 20, key: 'sk-solov-codex-revoked-123456' }
    const store = recordingKeyStore([siteManagedKey('solov', 'claude'), stale, siteManagedKey('solov', 'grok')])
    vi.mocked(store.remove).mockRejectedValue(new Error('系统安全存储不可用，无法持久化托管 API Key'))
    vi.mocked(store.save).mockRejectedValue(new Error('系统安全存储不可用，无法持久化托管 API Key'))
    const provisionCliKey = siteAwareProvisioner('solov')
    const fetchAvailableModels = vi.fn(async (key: string) => {
      if (key === stale.key) throw new Error('模型查询失败，服务返回 401')
      return ['codex-model']
    })
    const saveConfig = vi.fn(async () => ({ backups: [], files: [] }))

    const result = await configureManagedClis(
      siteAwareAccountService(provisionCliKey, () => 'solov'),
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      ['codex'], {}, false, store,
    )

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(store.save).toHaveBeenCalledTimes(1)
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', apiKey: siteManagedKey('solov', 'codex').key }),
      false, expect.any(Function), expect.any(Object),
    )
  })

  it('stops when the account changes while the replacement is being cached', async () => {
    const stale = { ...siteManagedKey('solov', 'codex'), id: 20, key: 'sk-solov-codex-revoked-123456' }
    const store = recordingKeyStore([siteManagedKey('solov', 'claude'), stale, siteManagedKey('solov', 'grok')])
    let userId = 73
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId } })),
      getActiveSiteId: () => 'solov',
      provisionCliKey: siteAwareProvisioner('solov'),
    } as unknown as AccountService
    let reads = 0
    vi.mocked(store.read).mockImplementation(async () => {
      reads += 1
      // The first read belongs to the sync; the second is the replacement's re-read.
      if (reads === 2) userId = 74
      return store.cached.map((entry) => ({ ...entry }))
    })
    const saveConfig = vi.fn()

    await expect(configureManagedClis(
      accountService,
      {
        fetchAvailableModels: vi.fn(async (key: string) => {
          if (key === stale.key) throw new Error('模型查询失败，服务返回 401')
          return ['codex-model']
        }),
        saveConfig,
      } as unknown as ConfigurationService,
      ['codex'], {}, false, store,
    )).rejects.toThrow('星芒账号已切换')
    expect(store.save).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
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
      ['default', ...activeProviderIds.map((provider) => renamedGroups[provider])].map((name) => ({ name }))
    ))
    const { accountService, provisionCliKey } = groupAwareAccountService(listUsableGroups)

    const summary = await syncManagedCliKeySummary(accountService, memoryStore())

    expect(summary.failed).toEqual([])
    expect(summary.ready.map((entry) => entry.group).sort())
      .toEqual(activeProviderIds.map((provider) => renamedGroups[provider]).sort())
    for (const provider of activeProviderIds) {
      expect(provisionCliKey).toHaveBeenCalledWith({
        name: managedCliKeyProfiles[provider].keyName,
        group: renamedGroups[provider],
      })
    }
    expect(listUsableGroups).toHaveBeenCalledTimes(1)
  })

  it('keeps the shipped names when the backend still offers them', async () => {
    const listUsableGroups = vi.fn(async () => (
      activeProviderIds.map((provider) => ({ name: managedCliKeyProfiles[provider].group }))
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
      .toEqual(activeProviderIds.map((provider) => managedCliKeyProfiles[provider].group).sort())
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
      .toEqual(activeProviderIds.map((provider) => managedCliKeyProfiles[provider].group).sort())
  })

  it('asks the backend for the groups at most once a day when every key is already cached', async () => {
    const listUsableGroups = vi.fn(async () => [])
    const provisionCliKey = vi.fn()
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      provisionCliKey,
      listUsableGroups,
    } as unknown as AccountService
    const store = memoryStore(activeProviderIds.map((provider) => managedKey(provider)))

    const summary = await syncManagedCliKeySummary(accountService, store)
    await syncManagedCliKeySummary(accountService, store)

    expect(summary.failed).toEqual([])
    expect(listUsableGroups).toHaveBeenCalledTimes(1)
    expect(provisionCliKey).not.toHaveBeenCalled()
  })

  it('discards a cached key whose group the backend no longer offers', async () => {
    const listUsableGroups = vi.fn(async () => (
      ['default', ...activeProviderIds.map((provider) => renamedGroups[provider])].map((name) => ({ name }))
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

  function subscriptionAccountService(state: { subscribed: string[]; groupsFail?: boolean; listed?: string[]; withoutUsual?: ProviderId[] }) {
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
        ...activeProviderIds.filter((provider) => !state.withoutUsual?.includes(provider))
          .map((provider) => ({ name: sub2Api[provider].group, description: '', ratio: 1, platform: platforms[provider] })),
        ...(state.listed ?? state.subscribed).map((name) => ({ name, description: '', ratio: 1, platform: 'anthropic' })),
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
    const store = recordingKeyStore(activeProviderIds.map((provider) => siteManagedKey('solov-api', provider)), 'solov-api')
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
      ...activeProviderIds.filter((provider) => provider !== 'claude').map((provider) => siteManagedKey('solov-api', provider)),
    ], 'solov-api')
    const { accountService, provisionCliKey } = subscriptionAccountService({ subscribed: [] })

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual([{ name: sub2Api.claude.keyName, group: sub2Api.claude.group }])
    expect(summary.regrouped).toEqual(['claude'])
  })

  it('keeps a cached subscription key when the groups cannot be read', async () => {
    const store = recordingKeyStore([
      { ...siteManagedKey('solov-api', 'claude'), id: 900, group: 'Claude 包月', key: 'sk-subscription-plaintext-secret-123456' },
      ...activeProviderIds.filter((provider) => provider !== 'claude').map((provider) => siteManagedKey('solov-api', provider)),
    ], 'solov-api')
    const { accountService, provisionCliKey } = subscriptionAccountService({ subscribed: ['Claude 包月'], groupsFail: true })

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(summary.failed).toEqual([])
    expect(summary.regrouped).toBeUndefined()
    expect(summary.ready.find((entry) => entry.provider === 'claude')?.group).toBe('Claude 包月')
  })

  it('keeps an expired subscription key when the account offers no other group for that CLI', async () => {
    // 服务端还列着这个分组、却再给不出这家工具的普通分组时，换去写死的名字只会签 Key 失败，
    // 配置里照样是这把旧 Key；留着它，用户至少看到服务端「订阅已到期」的原话。
    const store = recordingKeyStore([
      { ...siteManagedKey('solov-api', 'claude'), id: 900, group: 'Claude 包月', key: 'sk-subscription-plaintext-secret-123456' },
      ...activeProviderIds.filter((provider) => provider !== 'claude').map((provider) => siteManagedKey('solov-api', provider)),
    ], 'solov-api')
    const { accountService, provisionCliKey } = subscriptionAccountService({
      subscribed: [], listed: ['Claude 包月'], withoutUsual: ['claude'],
    })

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(summary.regrouped).toBeUndefined()
    expect(summary.ready.find((entry) => entry.provider === 'claude')?.group).toBe('Claude 包月')
  })

  it('leaves the xm account alone: its subscriptions do not depend on the key group', async () => {
    const store = recordingKeyStore(activeProviderIds.map((provider) => siteManagedKey('solov', provider)), 'solov')
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
    // Only the daily group check, which cannot read this list and keeps the cache.
    expect(listUsableGroups).toHaveBeenCalledTimes(1)
    expect(provisionCliKey).not.toHaveBeenCalled()
  })
})

describe('dynamic groups with the encrypted managed key store', () => {
  const directories: string[] = []
  const groups: Record<ProviderId, string> = {
    claude: 'Claude-Pro-Relay',
    codex: 'Codex-Professional-Relay',
    gemini: 'Gemini-Pro-Relay',
    grok: 'Grok-Pro-Relay',
  }

  function storage(): SafeStorageLike {
    return {
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => Buffer.from(`fixture-cipher:${plainText}`),
      decryptString: (ciphertext) => {
        const encoded = ciphertext.toString('utf8')
        if (!encoded.startsWith('fixture-cipher:')) throw new Error('unknown fixture ciphertext')
        return encoded.slice('fixture-cipher:'.length)
      },
    }
  }

  function storePath(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-dynamic-cli-group-'))
    directories.push(directory)
    return path.join(directory, 'managed-cli-keys.dat')
  }

  function provisioner() {
    return vi.fn(async (input: { name?: string; group?: string } = {}) => {
      const provider = providerIds.find((candidate) => groups[candidate] === input.group)
      if (!provider) throw new Error(`unexpected group: ${input.group}`)
      return {
        id: providerIds.indexOf(provider) + 1,
        name: input.name ?? managedCliKeyProfiles[provider].keyName,
        key: `sk-${provider}-dynamic-secret-123456`,
      }
    })
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })

  it('keeps a key moved into a subscription group across a restart', async () => {
    const filePath = storePath()
    const sub2Api = profilesBySite['solov-api']
    const platforms: Record<ProviderId, string> = { claude: 'anthropic', codex: 'openai', gemini: 'gemini', grok: 'grok' }
    const listUsableGroups = vi.fn(async () => [
      ...activeProviderIds.map((provider) => ({ name: sub2Api[provider].group, platform: platforms[provider] })),
      { name: 'Claude 包月', platform: 'anthropic' },
    ])
    const getSubscriptionSelf = vi.fn(async () => ({
      activeSubscriptions: [{ status: 'active', groupName: 'Claude 包月', endsAt: '2999-01-01T00:00:00Z' }],
    }))
    const issueKey = vi.fn(async (input: { name?: string; group?: string } = {}) => ({
      id: input.group === 'Claude 包月' ? 900 : 100 + providerIds.findIndex((provider) => sub2Api[provider].group === input.group),
      name: input.name ?? 'xingmang-desktop',
      key: `sk-${input.group === 'Claude 包月' ? 'subscription' : 'usual'}-plaintext-secret-123456`,
    }))
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: vi.fn(() => 'solov-api'),
      provisionCliKey: issueKey,
      listUsableGroups,
      getSubscriptionSelf,
    } as unknown as AccountService

    const first = await syncManagedCliKeySummary(accountService, new ManagedCliKeyStore(filePath, storage(), 'solov-api'))
    expect(first.failed).toEqual([])
    expect(first.storageWarning).toBeUndefined()
    expect(first.ready.find((entry) => entry.provider === 'claude')?.group).toBe('Claude 包月')

    issueKey.mockClear()
    const online = await syncManagedCliKeySummary(accountService, new ManagedCliKeyStore(filePath, storage(), 'solov-api'))
    expect(online.ready).toEqual(first.ready)
    expect(online.regrouped).toBeUndefined()
    expect(issueKey).not.toHaveBeenCalled()

    const offlineService = {
      getSessionState: accountService.getSessionState,
      getActiveSiteId: accountService.getActiveSiteId,
      provisionCliKey: vi.fn(async () => { throw new Error('offline key provisioning') }),
      listUsableGroups: vi.fn(async () => { throw new Error('offline group list') }),
      getSubscriptionSelf: vi.fn(async () => { throw new Error('offline subscriptions') }),
    } as unknown as AccountService
    const offline = await syncManagedCliKeySummary(offlineService, new ManagedCliKeyStore(filePath, storage(), 'solov-api'))
    expect(offline.ready).toEqual(first.ready)
    expect(offline.failed).toEqual([])
    expect(offlineService.provisionCliKey).not.toHaveBeenCalled()
  })

  it('persists renamed groups and reuses every key after an offline restart', async () => {
    const filePath = storePath()
    const firstStore = new ManagedCliKeyStore(filePath, storage())
    const issueKey = provisioner()
    const listUsableGroups = vi.fn(async () => activeProviderIds.map((provider) => ({ name: groups[provider] })))
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: vi.fn(() => 'solov'),
      provisionCliKey: issueKey,
      listUsableGroups,
    } as unknown as AccountService

    const first = await syncManagedCliKeySummary(accountService, firstStore)
    expect(first.failed).toEqual([])
    expect(first.storageWarning).toBeUndefined()
    expect(first.ready.map((entry) => entry.group)).toEqual(activeProviderIds.map((provider) => groups[provider]))
    expect(issueKey).toHaveBeenCalledTimes(activeProviderIds.length)

    const reopened = new ManagedCliKeyStore(filePath, storage())
    const offlineService = {
      getSessionState: accountService.getSessionState,
      getActiveSiteId: accountService.getActiveSiteId,
      provisionCliKey: vi.fn(async () => { throw new Error('offline key provisioning') }),
      listUsableGroups: vi.fn(async () => { throw new Error('offline group list') }),
    } as unknown as AccountService
    const second = await syncManagedCliKeySummary(offlineService, reopened)
    expect(second).toEqual(first)
    // The daily group check fails offline; the cached keys are used as they are.
    expect(offlineService.listUsableGroups).toHaveBeenCalledTimes(1)
    expect(offlineService.provisionCliKey).not.toHaveBeenCalled()
  })

  it('keeps a partially cached renamed group when the group list is offline', async () => {
    const filePath = storePath()
    const firstStore = new ManagedCliKeyStore(filePath, storage())
    const codexKey = {
      ...managedKey('codex'),
      group: groups.codex,
      key: 'sk-codex-dynamic-secret-123456',
    }
    await firstStore.save(73, [codexKey])
    const issueKey = vi.fn(async () => { throw new Error('offline key provisioning') })
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: vi.fn(() => 'solov'),
      provisionCliKey: issueKey,
      listUsableGroups: vi.fn(async () => { throw new Error('offline group list') }),
    } as unknown as AccountService

    const result = await syncManagedCliKeySummary(accountService, new ManagedCliKeyStore(filePath, storage()))
    expect(result.ready).toContainEqual({ provider: 'codex', group: groups.codex, name: codexKey.name })
    expect(result.failed.map((entry) => entry.provider).sort()).toEqual(['claude', 'grok'])
    expect(issueKey).not.toHaveBeenCalledWith(expect.objectContaining({ group: groups.codex }))
  })

  it('keeps a key cached under a group name the xm site retired instead of signing another one', async () => {
    const filePath = storePath()
    // 0.2.18 以前签在老名字下、记在本机的那把；服务端删老名字前把它挂到了「GPT」下，Key 本身没变。
    const codexKey = { ...managedKey('codex'), id: 501, group: 'GPT-中转/订阅', key: 'sk-codex-cached-secret-123456' }
    await new ManagedCliKeyStore(filePath, storage()).save(73, [codexKey])
    const issueKey = vi.fn(async (input: { name?: string; group?: string } = {}) => ({
      id: 600 + providerIds.findIndex((provider) => managedCliKeyProfiles[provider].group === input.group),
      name: input.name ?? 'xingmang-desktop',
      key: `sk-${input.group}-fresh-secret-123456`,
    }))
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: vi.fn(() => 'solov'),
      provisionCliKey: issueKey,
      listUsableGroups: vi.fn(async () => [{ name: 'default' }, { name: 'Claude-MAX' }, { name: 'GPT' }, { name: 'Grok' }]),
    } as unknown as AccountService

    const result = await syncManagedCliKeySummary(accountService, new ManagedCliKeyStore(filePath, storage()))

    expect(result.failed).toEqual([])
    expect(result.regrouped).toBeUndefined()
    expect(result.ready).toEqual([
      { provider: 'claude', group: 'Claude-MAX', name: managedCliKeyProfiles.claude.keyName },
      { provider: 'codex', group: 'GPT', name: codexKey.name },
      { provider: 'grok', group: 'Grok', name: managedCliKeyProfiles.grok.keyName },
    ])
    expect(issueKey.mock.calls.map(([input]) => input?.group)).toEqual(['Claude-MAX', 'Grok'])
    const cached = await new ManagedCliKeyStore(filePath, storage()).read(73)
    expect(cached.find((entry) => entry.provider === 'codex')).toEqual({ ...codexKey, group: 'GPT' })
  })

  it('persists a replacement in the renamed group after a cached key receives 401', async () => {
    const filePath = storePath()
    const oldKey = { ...managedKey('codex'), group: groups.codex, key: 'sk-codex-old-secret-123456' }
    const firstStore = new ManagedCliKeyStore(filePath, storage())
    await firstStore.save(73, [oldKey])
    const issueKey = provisioner()
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: vi.fn(() => 'solov'),
      provisionCliKey: issueKey,
      listUsableGroups: vi.fn(async () => activeProviderIds.map((provider) => ({ name: groups[provider] }))),
    } as unknown as AccountService
    const fetchAvailableModels = vi.fn(async (key: string) => {
      if (key === oldKey.key) throw new Error('模型查询失败，服务返回 401')
      return ['codex-model']
    })
    const saveConfig = vi.fn(async () => ({ backups: [], files: [] }))

    const result = await configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig } as unknown as ConfigurationService,
      ['codex'], {}, false, new ManagedCliKeyStore(filePath, storage()),
    )

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(issueKey).toHaveBeenCalledWith({ name: managedCliKeyProfiles.codex.keyName, group: groups.codex })
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', apiKey: 'sk-codex-dynamic-secret-123456' }),
      false, expect.any(Function), expect.any(Object),
    )
    const stored = await new ManagedCliKeyStore(filePath, storage()).read(73)
    expect(stored.find((entry) => entry.provider === 'codex')).toMatchObject({
      group: groups.codex,
      key: 'sk-codex-dynamic-secret-123456',
    })
  })

  it('keeps the retired Gemini key in the encrypted cache after replacing a rejected key', async () => {
    const filePath = storePath()
    const dynamicKey = (provider: ProviderId) => ({
      ...managedKey(provider), group: groups[provider], key: `sk-${provider}-dynamic-secret-123456`,
    })
    const oldKey = { ...dynamicKey('codex'), id: 20, key: 'sk-codex-old-secret-123456' }
    await new ManagedCliKeyStore(filePath, storage()).save(73, [dynamicKey('claude'), oldKey, dynamicKey('grok'), dynamicKey('gemini')])
    const issueKey = provisioner()
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: vi.fn(() => 'solov'),
      provisionCliKey: issueKey,
      listUsableGroups: vi.fn(async () => activeProviderIds.map((provider) => ({ name: groups[provider] }))),
    } as unknown as AccountService
    const fetchAvailableModels = vi.fn(async (key: string) => {
      if (key === oldKey.key) throw new Error('模型查询失败，服务返回 401')
      return ['codex-model']
    })

    const result = await configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig: vi.fn(async () => ({ backups: [], files: [] })) } as unknown as ConfigurationService,
      ['codex'], {}, false, new ManagedCliKeyStore(filePath, storage()),
    )

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(issueKey).toHaveBeenCalledTimes(1)
    expect(await new ManagedCliKeyStore(filePath, storage()).read(73)).toEqual(
      providerIds.map((provider) => provider === 'codex'
        // 失效重签换掉的那把留下指纹：写配置没成的话，下次开机认得出配置里还是它（#1153）。
        ? { ...dynamicKey(provider), replacedKeyDigests: [managedKeyDigest(oldKey.key)] }
        : dynamicKey(provider)),
    )
  })

  it('remembers the key a subscription moved away from, across a restart', async () => {
    const filePath = storePath()
    const sub2Api = profilesBySite['solov-api']
    const platforms: Record<ProviderId, string> = { claude: 'anthropic', codex: 'openai', gemini: 'gemini', grok: 'grok' }
    const usual = activeProviderIds.map((provider) => ({ ...siteManagedKey('solov-api', provider), key: `sk-${provider}-usual-secret-123456` }))
    await new ManagedCliKeyStore(filePath, storage(), 'solov-api').save(73, usual)
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: vi.fn(() => 'solov-api'),
      provisionCliKey: vi.fn(async (input: { name?: string; group?: string } = {}) => ({
        id: 900, name: input.name ?? 'xingmang-desktop', key: 'sk-subscription-plaintext-secret-123456',
      })),
      listUsableGroups: vi.fn(async () => [
        ...activeProviderIds.map((provider) => ({ name: sub2Api[provider].group, platform: platforms[provider] })),
        { name: 'Claude 包月', platform: 'anthropic' },
      ]),
      getSubscriptionSelf: vi.fn(async () => ({
        activeSubscriptions: [{ status: 'active', groupName: 'Claude 包月', endsAt: '2999-01-01T00:00:00Z' }],
      })),
    } as unknown as AccountService

    const summary = await syncManagedCliKeySummary(accountService, new ManagedCliKeyStore(filePath, storage(), 'solov-api'))
    expect(summary.regrouped).toEqual(['claude'])

    const cached = await new ManagedCliKeyStore(filePath, storage(), 'solov-api').read(73)
    expect(cached.find((entry) => entry.provider === 'claude')).toMatchObject({
      key: 'sk-subscription-plaintext-secret-123456',
      replacedKeyDigests: [managedKeyDigest(usual.find((entry) => entry.provider === 'claude')!.key)],
    })
    expect(cached.find((entry) => entry.provider === 'codex')).not.toHaveProperty('replacedKeyDigests')
  })

  it('replaces a revoked dynamic-group key when the group list is temporarily unavailable', async () => {
    const filePath = storePath()
    const oldKey = { ...managedKey('codex'), group: groups.codex, key: 'sk-codex-old-secret-123456' }
    await new ManagedCliKeyStore(filePath, storage()).save(73, [oldKey])
    const issueKey = provisioner()
    const accountService = {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 73 } })),
      getActiveSiteId: vi.fn(() => 'solov'),
      provisionCliKey: issueKey,
      listUsableGroups: vi.fn(async () => { throw new Error('group endpoint unavailable') }),
    } as unknown as AccountService
    const fetchAvailableModels = vi.fn(async (key: string) => {
      if (key === oldKey.key) throw new Error('模型查询失败，服务返回 401')
      return ['codex-model']
    })

    const result = await configureManagedClis(
      accountService,
      { fetchAvailableModels, saveConfig: vi.fn(async () => ({ backups: [], files: [] })) } as unknown as ConfigurationService,
      ['codex'], {}, false, new ManagedCliKeyStore(filePath, storage()),
    )

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(issueKey).toHaveBeenCalledWith({ name: managedCliKeyProfiles.codex.keyName, group: groups.codex })
    expect((await new ManagedCliKeyStore(filePath, storage()).read(73))[0].group).toBe(groups.codex)
  })
})

describe('groups deleted or remapped while every key is cached (#1074)', () => {
  const xm = profilesBySite.solov
  const day = 24 * 60 * 60 * 1000
  const codexModels = ['gpt-6-astra']
  const deletedGroupRejection = '模型查询失败，服务返回 403：无权访问 GPT 分组'

  function xmAccountService(options: {
    listed: string[]
    hints?: AccountGroupHints | null
    username?: string
    revokeKey?: ReturnType<typeof vi.fn>
    /** 服务端此刻的 Key 列表里旧那几把的样子；缺省 = 跟本机缓存一样。 */
    serverKeys?: Array<Pick<StoredManagedCliKey, 'id' | 'name' | 'group'>>
  }) {
    let nextId = 500
    const state = {
      listed: options.listed,
      hints: options.hints ?? null,
      serverKeys: options.serverKeys ?? activeProviderIds.map((provider) => siteManagedKey('solov', provider)),
    }
    const provisionCliKey = vi.fn(async (input: { name?: string; group?: string } = {}) => ({
      id: nextId++,
      name: input.name ?? 'xingmang-desktop',
      key: `sk-${input.group}-replacement-secret-123456`,
    }))
    const listUsableGroups = vi.fn(async () => state.listed.map((name) => ({ name })))
    const revokeKey = options.revokeKey ?? vi.fn(async () => undefined)
    const accountService = {
      getSessionState: vi.fn(() => ({
        authenticated: true,
        account: { userId: 73, ...(options.username ? { username: options.username } : {}) },
      })),
      getActiveSiteId: () => 'solov',
      provisionCliKey,
      listUsableGroups,
      revokeKey,
      listKeys: vi.fn(async () => ({
        page: 1,
        pageSize: 100,
        total: state.serverKeys.length,
        keys: state.serverKeys.map(({ id, name, group }) => ({ id, name, group })),
      })),
      getAccountGroupHints: vi.fn(async () => state.hints),
    } as unknown as AccountService
    return { accountService, provisionCliKey, listUsableGroups, revokeKey, state }
  }

  function xmCache(overrides: Partial<Record<ProviderId, Partial<StoredManagedCliKey>>> = {}) {
    return recordingKeyStore(activeProviderIds.map((provider) => ({
      ...siteManagedKey('solov', provider),
      ...overrides[provider],
    })), 'solov')
  }

  function configService(options: {
    saveConfig?: ReturnType<typeof vi.fn>
    rejected?: { key: string; message: string }
  } = {}) {
    const saveConfig = options.saveConfig ?? vi.fn(async () => ({ backups: [], files: [] }))
    const fetchAvailableModels = vi.fn(async (key: string) => {
      if (key === options.rejected?.key) throw new Error(options.rejected.message)
      return codexModels
    })
    return { service: { fetchAvailableModels, saveConfig } as unknown as ConfigurationService, saveConfig }
  }

  const oldCodex = siteManagedKey('solov', 'codex')
  // GPT 被删了，站上新开的 GPT-Plus 靠工具专属词认出来。
  const afterGptDeleted = [xm.claude.group, 'GPT-Plus', xm.grok.group]

  it('moves a cached key out of a deleted group and deletes the old key only after the new one is written', async () => {
    const { accountService, provisionCliKey, revokeKey } = xmAccountService({ listed: afterGptDeleted })
    const store = xmCache()

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual([{ name: xm.codex.keyName, group: 'GPT-Plus' }])
    expect(summary.regrouped).toEqual(['codex'])
    expect(store.cached.find((entry) => entry.provider === 'codex')).toMatchObject({ group: 'GPT-Plus', id: 500 })
    expect(revokeKey).not.toHaveBeenCalled()

    const { service, saveConfig } = configService()
    const result = await configureManagedClis(accountService, service, ['codex'], {}, false, store)

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', apiKey: 'sk-GPT-Plus-replacement-secret-123456' }),
      false, expect.any(Function), expect.any(Object),
    )
    expect(revokeKey.mock.calls).toEqual([[oldCodex.id]])
    expect(saveConfig.mock.invocationCallOrder[0]).toBeLessThan(revokeKey.mock.invocationCallOrder[0])
    // 删过一次就不再删。
    await configureManagedClis(accountService, service, ['codex'], {}, false, store)
    expect(revokeKey).toHaveBeenCalledTimes(1)
  })

  it('keeps the old key while the new one has not been written into the tool', async () => {
    const { accountService, revokeKey } = xmAccountService({ listed: afterGptDeleted })
    const store = xmCache()
    await syncManagedCliKeySummary(accountService, store)

    const failing = configService({ saveConfig: vi.fn(async () => { throw new Error('配置文件被占用') }) })
    const failed = await configureManagedClis(accountService, failing.service, ['codex'], {}, false, store)
    expect(failed.failed.map((entry) => entry.message)).toEqual(['配置文件被占用'])
    expect(revokeKey).not.toHaveBeenCalled()

    const written = await configureManagedClis(accountService, configService().service, ['codex'], {}, false, store)
    expect(written.configured).toEqual(['codex'])
    expect(revokeKey.mock.calls).toEqual([[oldCodex.id]])
  })

  it('never deletes a key the customer made by hand', async () => {
    const { accountService, revokeKey } = xmAccountService({
      listed: afterGptDeleted,
      serverKeys: [{ ...oldCodex, name: '我自己建的' }],
    })
    const store = xmCache({ codex: { name: '我自己建的' } })
    await syncManagedCliKeySummary(accountService, store)

    const result = await configureManagedClis(accountService, configService().service, ['codex'], {}, false, store)

    expect(result.configured).toEqual(['codex'])
    expect(revokeKey).not.toHaveBeenCalled()
  })

  it('deletes the username-group key the xm site issued for the tool', async () => {
    const { accountService, revokeKey } = xmAccountService({
      listed: afterGptDeleted,
      username: 'yoyo',
      serverKeys: [{ ...oldCodex, name: 'yoyo-GPT' }],
    })
    const store = xmCache({ codex: { name: 'yoyo-GPT' } })
    await syncManagedCliKeySummary(accountService, store)

    await configureManagedClis(accountService, configService().service, ['codex'], {}, false, store)

    expect(revokeKey.mock.calls).toEqual([[oldCodex.id]])
  })

  it('leaves the old key alone when the site already moved it into a group that still works', async () => {
    // 站上删组前先把 Key 挪到了新分组下（xm 站以前就这么做过），本机记的还是老分组。
    const { accountService, revokeKey } = xmAccountService({
      listed: afterGptDeleted,
      serverKeys: [{ ...oldCodex, group: 'GPT-Plus' }],
    })
    const store = xmCache()
    await syncManagedCliKeySummary(accountService, store)

    const result = await configureManagedClis(accountService, configService().service, ['codex'], {}, false, store)

    expect(result.configured).toEqual(['codex'])
    expect(revokeKey).not.toHaveBeenCalled()
  })

  it('leaves the old key alone when it can no longer be found or the groups cannot be read', async () => {
    for (const trouble of ['gone', 'groups'] as const) {
      const { accountService, revokeKey, state, listUsableGroups } = xmAccountService({ listed: afterGptDeleted })
      const store = xmCache()
      await syncManagedCliKeySummary(accountService, store)
      if (trouble === 'gone') state.serverKeys = []
      else listUsableGroups.mockRejectedValue(new Error('连接服务器失败'))

      const result = await configureManagedClis(accountService, configService().service, ['codex'], {}, false, store)

      expect(result.configured).toEqual(['codex'])
      expect(revokeKey).not.toHaveBeenCalled()
    }
  })

  it('still reports the tool as configured when the old key cannot be deleted', async () => {
    const revokeKey = vi.fn(async () => { throw new Error('连接服务器失败') })
    const { accountService } = xmAccountService({ listed: afterGptDeleted, revokeKey })
    const store = xmCache()
    await syncManagedCliKeySummary(accountService, store)

    const result = await configureManagedClis(accountService, configService().service, ['codex'], {}, false, store)

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(revokeKey).toHaveBeenCalledTimes(1)
  })

  it('follows a changed group mapping but keeps the old key while its group still exists', async () => {
    const { accountService, provisionCliKey, revokeKey } = xmAccountService({
      listed: [xm.claude.group, xm.codex.group, 'GPT-新', xm.grok.group],
      hints: { codex: ['GPT-新'] },
    })
    const store = xmCache()

    const summary = await syncManagedCliKeySummary(accountService, store)
    await configureManagedClis(accountService, configService().service, ['codex'], {}, false, store)

    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual([{ name: xm.codex.keyName, group: 'GPT-新' }])
    expect(summary.regrouped).toEqual(['codex'])
    expect(revokeKey).not.toHaveBeenCalled()
  })

  it('does not move a cached key on a guess while the backend still offers its group', async () => {
    const { accountService, provisionCliKey } = xmAccountService({
      listed: [xm.claude.group, 'Pro专线', 'GPT-Plus', xm.grok.group],
    })
    const store = xmCache({ codex: { group: 'Pro专线' } })

    const summary = await syncManagedCliKeySummary(accountService, store)

    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(summary.regrouped).toBeUndefined()
    expect(summary.ready.find((entry) => entry.provider === 'codex')?.group).toBe('Pro专线')
  })

  it('keeps using the old key and retries soon when the mapped group cannot be issued yet', async () => {
    const { accountService, provisionCliKey, listUsableGroups } = xmAccountService({
      listed: [xm.claude.group, xm.codex.group, 'GPT-新', xm.grok.group],
      hints: { codex: ['GPT-新'] },
    })
    provisionCliKey.mockRejectedValueOnce(new Error('CLI Key 创建失败'))
    const store = xmCache()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const summary = await syncManagedCliKeySummary(accountService, store)

      expect(summary.failed).toEqual([])
      expect(summary.regrouped).toBeUndefined()
      expect(summary.ready.find((entry) => entry.provider === 'codex')?.group).toBe(xm.codex.group)
      expect(store.cached).toEqual(activeProviderIds.map((provider) => siteManagedKey('solov', provider)))

      clock.mockReturnValue(now + 10 * 60_000)
      const retried = await syncManagedCliKeySummary(accountService, store)
      expect(listUsableGroups).toHaveBeenCalledTimes(2)
      expect(retried.regrouped).toEqual(['codex'])
    } finally {
      clock.mockRestore()
    }
  })

  it('stops treating a key whose group is gone as connected when no replacement can be issued', async () => {
    const { accountService, provisionCliKey, listUsableGroups } = xmAccountService({ listed: afterGptDeleted })
    provisionCliKey.mockRejectedValue(new Error('当前账号不可使用分组「GPT-Plus」'))
    const store = xmCache()

    const first = await syncManagedCliKeySummary(accountService, store)
    const second = await syncManagedCliKeySummary(accountService, store)

    expect(first.failed.map((entry) => entry.provider)).toEqual(['codex'])
    expect(first.ready.map((entry) => entry.provider)).not.toContain('codex')
    expect(store.cached.map((entry) => entry.provider)).not.toContain('codex')
    // 缓存不全了，往后每一轮都照常查分组、重签、照实报。
    expect(second.failed.map((entry) => entry.provider)).toEqual(['codex'])
    expect(listUsableGroups).toHaveBeenCalledTimes(2)
  })

  it('checks again before the day is over once the published group mapping changes', async () => {
    const { accountService, listUsableGroups, state } = xmAccountService({
      listed: [xm.claude.group, xm.codex.group, xm.grok.group],
    })
    const store = xmCache()

    await syncManagedCliKeySummary(accountService, store)
    await syncManagedCliKeySummary(accountService, store)
    expect(listUsableGroups).toHaveBeenCalledTimes(1)

    state.hints = { codex: ['GPT-新', xm.codex.group] }
    await syncManagedCliKeySummary(accountService, store)
    expect(listUsableGroups).toHaveBeenCalledTimes(2)
  })

  it('moves a key the backend rejects for its group and deletes the old one after writing', async () => {
    const { accountService, provisionCliKey, revokeKey, state } = xmAccountService({
      listed: [xm.claude.group, xm.codex.group, xm.grok.group],
    })
    const store = xmCache()
    // 早上那次查分组时 GPT 还在；中午站上删了它，当天不会再查一次。
    await syncManagedCliKeySummary(accountService, store)
    state.listed = afterGptDeleted

    const { service, saveConfig } = configService({ rejected: { key: oldCodex.key, message: deletedGroupRejection } })
    const result = await configureManagedClis(accountService, service, ['codex'], {}, false, store)

    expect(result).toEqual({ configured: ['codex'], failed: [] })
    expect(provisionCliKey.mock.calls.map(([input]) => input)).toEqual([{ name: xm.codex.keyName, group: 'GPT-Plus' }])
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', apiKey: 'sk-GPT-Plus-replacement-secret-123456' }),
      false, expect.any(Function), expect.any(Object),
    )
    expect(revokeKey.mock.calls).toEqual([[oldCodex.id]])
  })

  it('reports the rejection as it is when no other group can take the key', async () => {
    const { accountService, provisionCliKey, revokeKey, state } = xmAccountService({
      listed: [xm.claude.group, xm.codex.group, xm.grok.group],
    })
    const store = xmCache()
    await syncManagedCliKeySummary(accountService, store)
    state.listed = [xm.claude.group, xm.grok.group]

    const { service, saveConfig } = configService({ rejected: { key: oldCodex.key, message: deletedGroupRejection } })
    const result = await configureManagedClis(accountService, service, ['codex'], {}, false, store)

    expect(result.failed).toEqual([{ provider: 'codex', message: deletedGroupRejection }])
    expect(provisionCliKey).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
    expect(revokeKey).not.toHaveBeenCalled()
  })

  it('times the cached group check by day, by a short retry after a failure, and by the mapping', () => {
    const now = 10 * day
    expect(isCachedGroupCheckDue(undefined, '', now)).toBe(true)
    expect(isCachedGroupCheckDue({ at: now - day + 1, succeeded: true, hints: '' }, '', now)).toBe(false)
    expect(isCachedGroupCheckDue({ at: now - day, succeeded: true, hints: '' }, '', now)).toBe(true)
    expect(isCachedGroupCheckDue({ at: now - 60_000, succeeded: false, hints: '' }, '', now)).toBe(false)
    expect(isCachedGroupCheckDue({ at: now - 10 * 60_000, succeeded: false, hints: '' }, '', now)).toBe(true)
    expect(isCachedGroupCheckDue({ at: now - 60_000, succeeded: true, hints: '' }, '[["GPT"]]', now)).toBe(true)
    // 系统时间往回拨过。
    expect(isCachedGroupCheckDue({ at: now + 60_000, succeeded: true, hints: '' }, '', now)).toBe(true)
    expect(accountGroupHintsFingerprint(null)).toBe('')
    expect(accountGroupHintsFingerprint({ codex: ['GPT'], image: ['生图'] }))
      .toBe(accountGroupHintsFingerprint({ codex: ['GPT'], image: ['画图'] }))
    expect(accountGroupHintsFingerprint({ codex: ['GPT'] })).not.toBe(accountGroupHintsFingerprint({ codex: ['GPT-新'] }))
  })

  it('moves a fully cached key only on an explicit signal or when its group is gone', () => {
    const listed = ['GPT', 'GPT-Plus']
    expect(movesFullyCachedKey({ group: 'GPT-Plus', source: 'mapped' }, 'GPT', listed)).toBe(true)
    expect(movesFullyCachedKey({ group: 'GPT', source: 'preferred' }, 'Pro专线', listed)).toBe(true)
    expect(movesFullyCachedKey({ group: 'GPT-Plus', source: 'detected' }, 'GPT', listed)).toBe(false)
    expect(movesFullyCachedKey({ group: 'GPT-Plus', source: 'alias' }, 'GPT', listed)).toBe(false)
    expect(movesFullyCachedKey({ group: 'GPT-Plus', source: 'detected' }, 'GPT-旧', listed)).toBe(true)
    expect(movesFullyCachedKey({ group: 'GPT', source: 'fallback' }, 'GPT-旧', listed)).toBe(false)
  })

  it('deletes only an app-issued key whose group is gone, and never on the history account', () => {
    const previous = { id: 2, name: 'xingmang-desktop-codex', group: 'GPT' }
    const replacement = { id: 500, group: 'GPT-Plus' }
    expect(retiresReplacedKey(previous, replacement, ['GPT-Plus'], 'solov', undefined)).toBe(true)
    expect(retiresReplacedKey(previous, replacement, ['GPT', 'GPT-Plus'], 'solov', undefined)).toBe(false)
    expect(retiresReplacedKey(previous, replacement, ['GPT-Plus'], 'solov-api', undefined)).toBe(false)
    expect(retiresReplacedKey(previous, { id: 2, group: 'GPT-Plus' }, ['GPT-Plus'], 'solov', undefined)).toBe(false)
    expect(retiresReplacedKey({ ...previous, name: '我自己建的' }, replacement, ['GPT-Plus'], 'solov', 'yoyo')).toBe(false)
    expect(isManagedToolKeyName('yoyo-GPT', 'GPT', 'yoyo')).toBe(true)
    expect(isManagedToolKeyName('yoyo-GPT', 'GPT', undefined)).toBe(false)
    expect(isManagedToolKeyName('别人-GPT', 'GPT', 'yoyo')).toBe(false)
    expect(isManagedToolKeyName('yoyo-GPT-对话', 'GPT', 'yoyo')).toBe(false)
  })
})

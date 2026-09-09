import { describe, expect, it, vi } from 'vitest'
import {
  accountSyncCandidates,
  preserveAccountSwitchResult,
  previousAccountSwitchResult,
  switchAccountWithOptionalSync,
  type AccountSwitchBridge,
  type AccountSyncContext,
} from './account-switch-sync'
import {
  readManualSourceMarker,
  writeManualSourceMarker,
  type SourceMarkerStorage,
} from './features/tools/source-marker'

function memoryStorage(): SourceMarkerStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

function setup() {
  const config = {
    baseUrl: 'https://xm.solov.cc/v1',
    hasApiKey: true,
    matchesRelay: true,
    model: 'original-model',
  }
  const context: AccountSyncContext = {
    configs: {
      claude: { ...config },
      codex: { ...config, codexAuthMode: 'chatgpt' },
      gemini: { ...config },
      grok: { ...config },
    },
    clis: {
      claude: { installed: true },
      codex: { installed: true },
      gemini: { installed: true },
      grok: { installed: false },
    },
    officialProviders: [],
    origin: 'https://xm.solov.cc',
  }
  const fresh = structuredClone(context)
  const calls: string[] = []
  const session = {
    authenticated: true,
    account: {
      userId: 8,
      username: 'target',
      group: 'default',
      quota: 100,
      usedQuota: 0,
      role: 1,
    },
  }
  const api = {
    switchSavedAccount: vi.fn<AccountSwitchBridge['switchSavedAccount']>(
      async () => {
        calls.push('switch')
        return session
      },
    ),
    getAccountSession: vi.fn<AccountSwitchBridge['getAccountSession']>(
      async () => session,
    ),
    getConfig: vi.fn(async () => {
      calls.push('config')
      return { providers: fresh.configs }
    }),
    scanSystem: vi.fn(async (_refresh?: boolean) => {
      calls.push('scan')
      return { clis: fresh.clis }
    }),
    getSettings: vi.fn(async () => ({
      officialProviders: [...fresh.officialProviders],
      relaySiteId: 'solov',
    })),
    configureManagedCliKeys: vi.fn<
      AccountSwitchBridge['configureManagedCliKeys']
    >(async (input) => {
      calls.push('configure')
      return { configured: input.providers, failed: [] }
    }),
  } satisfies AccountSwitchBridge
  return {
    api,
    context,
    fresh,
    calls,
    target: { id: 'saved-8', userId: 8, origin: context.origin },
  }
}

describe('saved account explicit CLI key sync', () => {
  for (const change of ['none', 'key', 'auth', 'timestamp'] as const) it(`preserves explicit cross-platform sync only for unchanged relay config (${change})`, async () => {
    const h = setup()
    const oldConfig = { ...h.context.configs.claude, baseUrl: 'https://xm.solov.cc', actualBaseUrl: 'https://xm.solov.cc', apiKeyPreview: 'sk-ab••••1234', updatedAt: '2026-09-09T00:00:00Z' }
    h.context.configs.claude = oldConfig
    h.fresh.configs.claude = { ...oldConfig, baseUrl: 'https://api.solov.cc', matchesRelay: false,
      ...(change === 'key' ? { apiKeyPreview: 'sk-cd••••5678' } : {}),
      ...(change === 'auth' ? { codexAuthMode: 'chatgpt' as const } : {}),
      ...(change === 'timestamp' ? { updatedAt: '2026-09-09T00:01:00Z' } : {}) }
    const active = { authenticated: true, siteId: 'solov-api' as const, account: { userId: 8 } as Awaited<ReturnType<AccountSwitchBridge['getAccountSession']>>['account'] }
    h.api.switchSavedAccount.mockResolvedValue(active)
    h.api.getAccountSession.mockResolvedValue(active)
    const result = await switchAccountWithOptionalSync(h.api, { ...h.target, origin: 'https://api.solov.cc' }, ['claude'], h.context, h.context.origin)
    expect(result.configured).toEqual(change === 'none' ? ['claude'] : [])
    expect(h.api.configureManagedCliKeys).toHaveBeenCalledTimes(change === 'none' ? 1 : 0)
  })
  it('defaults to no CLI writes and rejects another account origin before switching', async () => {
    const h = setup()
    const result = await switchAccountWithOptionalSync(
      h.api,
      h.target,
      [],
      null,
      h.context.origin,
    )
    expect(result.configured).toEqual([])
    expect(h.api.configureManagedCliKeys).not.toHaveBeenCalled()
    expect(h.api.getConfig).not.toHaveBeenCalled()
    expect(h.api.scanSystem).not.toHaveBeenCalled()
    await expect(
      switchAccountWithOptionalSync(
        h.api,
        { ...h.target, origin: 'https://other.invalid' },
        [],
        null,
        h.context.origin,
      ),
    ).rejects.toThrow('账号记录暂时无法使用')
    expect(h.api.switchSavedAccount).toHaveBeenCalledTimes(1)
  })
  it('offers only installed, detected, relay-key tools and excludes native official auth modes', () => {
    const h = setup()
    expect(
      accountSyncCandidates(h.context)
        .filter((item) => item.eligible)
        .map((item) => item.provider),
    ).toEqual(['claude', 'gemini'])
    h.context.configs.gemini.authType = 'oauth-personal'
    h.context.clis.claude.detectionFailed = true
    expect(accountSyncCandidates(h.context).some((item) => item.eligible)).toBe(
      false,
    )
  })
  it('shows a manual relay key and keeps explicit account switching available', () => {
    const h = setup()
    const storage = memoryStorage()
    writeManualSourceMarker(
      storage,
      h.context.configs.claude.baseUrl,
      'claude',
      true,
    )
    expect(accountSyncCandidates(h.context, storage)).toContainEqual(
      expect.objectContaining({
        provider: 'claude',
        eligible: true,
        reason: '手动填写密钥',
      }),
    )
  })
  it('does not inspect or write CLI configs after switching fails', async () => {
    const h = setup()
    h.api.switchSavedAccount.mockRejectedValueOnce(new Error('登录已过期'))
    await expect(
      switchAccountWithOptionalSync(
        h.api,
        h.target,
        ['claude'],
        h.context,
        h.context.origin,
      ),
    ).rejects.toThrow('登录已过期')
    expect(h.api.getConfig).not.toHaveBeenCalled()
    expect(h.api.configureManagedCliKeys).not.toHaveBeenCalled()
  })
  it('rechecks actual state after switching and passes only still-eligible selected tools with fresh models', async () => {
    const h = setup()
    h.fresh.configs.gemini.matchesRelay = false
    h.fresh.configs.claude.model = 'fresh-model'
    const result = await switchAccountWithOptionalSync(
      h.api,
      h.target,
      ['claude', 'gemini', 'codex'],
      h.context,
      h.context.origin,
    )
    expect(h.calls[0]).toBe('switch')
    expect(h.api.scanSystem).toHaveBeenCalledWith(true)
    expect(h.api.configureManagedCliKeys).toHaveBeenCalledWith({
      providers: ['claude'],
      preferredModels: { claude: 'fresh-model' },
    })
    expect(result.configured).toEqual(['claude'])
    expect(result.skipped.map((entry) => entry.provider)).toEqual([
      'codex',
      'gemini',
    ])
  })
  it('retains partial failures after the account has switched and can restore their report', async () => {
    const h = setup()
    const storage = memoryStorage()
    for (const provider of ['claude', 'gemini'] as const) {
      writeManualSourceMarker(
        storage,
        h.context.configs[provider].baseUrl,
        provider,
        true,
      )
    }
    writeManualSourceMarker(
      storage,
      'https://other.example/v1',
      'claude',
      true,
    )
    h.api.configureManagedCliKeys.mockResolvedValueOnce({
      configured: ['claude'],
      failed: [{ provider: 'gemini', message: '配置文件正在使用' }],
    })
    const result = await switchAccountWithOptionalSync(
      h.api,
      h.target,
      ['claude', 'gemini'],
      h.context,
      h.context.origin,
      storage,
    )
    expect(result.configured).toEqual(['claude'])
    expect(result.failed).toEqual([
      { provider: 'gemini', message: '配置文件正在使用' },
    ])
    expect(
      readManualSourceMarker(
        storage,
        h.context.configs.claude.baseUrl,
        'claude',
      ),
    ).toBe(false)
    expect(
      readManualSourceMarker(
        storage,
        h.context.configs.gemini.baseUrl,
        'gemini',
      ),
    ).toBe(true)
    expect(
      readManualSourceMarker(
        storage,
        'https://other.example/v1',
        'claude',
      ),
    ).toBe(true)
    preserveAccountSwitchResult(result)
    expect(previousAccountSwitchResult(h.target.origin, 8)).toEqual(result)
    expect(previousAccountSwitchResult('https://other.invalid', 8)).toBeNull()
  })
  it('stops writes if another account becomes active during revalidation', async () => {
    const h = setup()
    h.api.getAccountSession.mockResolvedValueOnce({
      authenticated: false,
      account: null,
    })
    const result = await switchAccountWithOptionalSync(
      h.api,
      h.target,
      ['claude'],
      h.context,
      h.context.origin,
    )
    expect(h.api.configureManagedCliKeys).not.toHaveBeenCalled()
    expect(result.failed).toEqual([
      {
        provider: 'claude',
        message: '账号状态已变化，已停止同步工具密钥。',
      },
    ])
  })
  it('stops writes if the same user id becomes active in the other platform after reading tool state', async () => {
    const h = setup()
    const account = { userId: 8 } as Awaited<ReturnType<AccountSwitchBridge['getAccountSession']>>['account']
    h.api.getAccountSession.mockResolvedValueOnce({ authenticated: true, account, siteId: 'solov' })
      .mockResolvedValueOnce({ authenticated: true, account, siteId: 'solov-api' })
    const result = await switchAccountWithOptionalSync(h.api, h.target, ['claude'], h.context, h.context.origin)
    expect(h.api.configureManagedCliKeys).not.toHaveBeenCalled()
    expect(result.failed[0].message).toBe('账号状态已变化，已停止同步工具密钥。')
  })
})

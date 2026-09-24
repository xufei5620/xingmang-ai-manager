import { describe, expect, it, vi } from 'vitest'
import type {
  AppConfigSummary,
  AppSettingsV2,
  ProviderId,
  SystemSnapshot,
} from '../../../../electron/ipc-contract'
import {
  KeyRewriteSkippedError,
  accountBootstrapPlan,
  bootstrapAccountTools,
  configurationFailure,
  configurationFailureMessages,
  describeAccountBootstrapFailure,
  describeAccountBootstrapResult,
  skippedNamedProviders,
  type AccountBootstrapBridge,
  type AccountBootstrapResult,
} from './account-bootstrap'
import { networkFailureMessages } from '../../../../electron/network-failure'
import {
  readManualSourceMarker,
  sourceMarkerWriteWarning,
  writeManualSourceMarker,
  type SourceMarkerStorage,
} from './source-marker'

function memoryStorage(): SourceMarkerStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

const status = (installed: boolean) => ({
  installed,
  version: installed ? '1.0.0' : null,
  path: installed ? 'C:\\bin' : null,
  installDirectory: installed ? 'C:\\bin' : null,
  latestVersion: null,
  updateAvailable: false,
  uninstall: { available: true, reason: null, manualCommand: null, delegated: false },
})
const system = (installed: ProviderId[]): SystemSnapshot => ({
  checkedAt: '2026-09-07T00:00:00Z',
  network: { region: 'unknown', publicIp: null, countryCode: null, checkedAt: '2026-09-07T00:00:00Z', error: null },
  runtime: { node: status(true), npm: status(true), python: status(true), git: status(true) },
  clis: {
    claude: status(installed.includes('claude')),
    codex: status(installed.includes('codex')),
    gemini: status(installed.includes('gemini')),
    grok: status(installed.includes('grok')),
  },
  desktopApps: { codex: { ...status(false), appVersion: null, mirrorVersion: null, mirrorUpdateAvailable: false, mirrorError: null, running: false } },
})
const missing = () => ({
  exists: false,
  hasApiKey: false,
  matchesRelay: false,
  baseUrl: 'https://xm.solov.cc/v1',
  actualBaseUrl: '',
  model: '',
  apiKeyPreview: null,
  dataDirectory: 'C:\\home',
  dataDirectoryExists: true,
  files: [],
  updatedAt: null,
})
const config = (): AppConfigSummary => ({
  workspace: 'C:\\work',
  providers: { claude: missing(), codex: missing(), gemini: missing(), grok: missing() },
})
const settings: AppSettingsV2 = { version: 2, workspace: 'C:\\work', theme: 'light', checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false }

describe('account managed Key bootstrap', () => {
  it('includes Codex when only Desktop is installed and preserves official and third-party sources', () => {
    const snapshot = system(['claude', 'gemini', 'grok'])
    snapshot.desktopApps.codex = { ...snapshot.desktopApps.codex, installed: true, appVersion: '1.0.0' }
    const current = config()
    current.providers.claude = { ...current.providers.claude, exists: true, codexAuthMode: null }
    current.providers.gemini = { ...current.providers.gemini, exists: true, authType: 'oauth-personal' }
    current.providers.grok = { ...current.providers.grok, exists: true, hasApiKey: true, actualBaseUrl: 'https://other.example/v1' }
    expect(accountBootstrapPlan(snapshot, current, { ...settings, officialProviders: ['claude'] })).toMatchObject({
      targets: ['codex'],
      skipped: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', reason: 'official' }),
        expect.objectContaining({ provider: 'gemini', reason: 'official' }),
        expect.objectContaining({ provider: 'grok', reason: 'unknown' }),
      ]),
    })
  })

  it('leaves an edited configuration alone until the user asks for a rewrite', () => {
    const current = config()
    const storage = memoryStorage()
    current.providers.claude = {
      ...current.providers.claude, exists: true, hasApiKey: true, matchesRelay: true,
      actualBaseUrl: current.providers.claude.baseUrl, model: 'edited-model',
      configurationOwnership: 'changed',
    }
    for (const mode of ['login', 'restore'] as const) {
      const plan = accountBootstrapPlan(system(['claude']), current, settings, mode, storage)
      expect(plan.targets).toEqual([])
      expect(plan.skipped).toContainEqual(expect.objectContaining({ provider: 'claude', reason: 'changed' }))
    }
    const rewrite = accountBootstrapPlan(system(['claude']), current, settings, 'rewrite', storage)
    expect(rewrite.targets).toEqual(['claude'])
    // 模型照旧沿用配置里那个，重写只换 Key，不顺手把模型改回默认。
    expect(rewrite.preferredModels).toMatchObject({ claude: 'edited-model' })
  })

  it('tells the host a rewrite is the user asking, so it may take an edited configuration back', async () => {
    const current = config()
    const storage = memoryStorage()
    current.providers.claude = {
      ...current.providers.claude, exists: true, hasApiKey: true, matchesRelay: true,
      actualBaseUrl: current.providers.claude.baseUrl, model: 'edited-model',
      configurationOwnership: 'changed',
    }
    const configure = vi.fn(async (input: Parameters<AccountBootstrapBridge['configureManagedCliKeys']>[0]) => {
      for (const provider of input.providers) current.providers[provider] = { ...current.providers[provider], configurationOwnership: 'account' as const, model: 'edited-model' }
      return { configured: [...input.providers], failed: [] }
    })
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [{ provider: 'claude' as ProviderId, group: 'group', name: 'claude' }], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: configure,
    }
    const result = await bootstrapAccountTools(api, 17, () => undefined, 'rewrite', ['claude'], storage)
    expect(result.configured).toEqual(['claude'])
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ providers: ['claude'], intent: 'explicit' }))
  })

  it('syncs first, writes every installed missing provider, and verifies the readback', async () => {
    const current = config()
    const storage = memoryStorage()
    for (const provider of ['claude', 'codex', 'grok', 'gemini'] as ProviderId[]) {
      writeManualSourceMarker(storage, current.providers[provider].baseUrl, provider, true)
    }
    const calls: string[] = []
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => { calls.push('sync'); return { ready: ['claude', 'codex', 'grok', 'gemini'].map((provider) => ({ provider: provider as ProviderId, group: 'group', name: provider })), failed: [] } }),
      scanSystem: vi.fn(async () => { calls.push('scan'); return system(['claude', 'codex', 'grok', 'gemini']) }),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async (input: Parameters<AccountBootstrapBridge['configureManagedCliKeys']>[0]) => {
        calls.push('configure')
        for (const provider of input.providers) current.providers[provider] = { ...current.providers[provider], exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers[provider].baseUrl, model: 'model', configurationOwnership: 'account', ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}) }
        return { configured: [...input.providers], failed: [] }
      }),
    }
    await expect(
      bootstrapAccountTools(api, 17, undefined, 'login', undefined, storage),
    ).resolves.toMatchObject({
      configured: ['claude', 'codex', 'grok', 'gemini'],
      failed: [],
    })
    expect(calls).toEqual(['sync', 'scan', 'configure'])
    for (const provider of ['claude', 'codex', 'grok', 'gemini'] as ProviderId[]) {
      expect(
        readManualSourceMarker(
          storage,
          current.providers[provider].baseUrl,
          provider,
        ),
      ).toBe(false)
    }
  })

  it.each([
    // 断网时 syncManagedCliKeys 本身不抛：每个工具各记一条签发失败，所以「这次是不是
    // 被网络拦住」只能从这些逐条消息里读出来。
    ['every key provisioning failed on the network', networkFailureMessages.offline, true],
    ['the key was rejected by the account service', '当前账号的密钥已失效（401）', false],
  ] as const)('reports networkBlocked when %s', async (_name, failureMessage, expected) => {
    const current = config()
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [{ provider: 'claude' as ProviderId, group: 'group', message: `CLI Key 初始化失败：${failureMessage}` }] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [{ provider: 'claude' as ProviderId, message: failureMessage }] })),
    }

    const result = await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, memoryStorage())

    expect(result.configured).toEqual([])
    expect(result.networkBlocked).toBe(expected)
  })

  it('does not report networkBlocked when a non-network warning rides along with a network failure', async () => {
    const current = config()
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({
        ready: [],
        failed: [
          { provider: 'claude' as ProviderId, group: 'group', message: networkFailureMessages.dns },
          { provider: 'codex' as ProviderId, group: 'group', message: '当前分组未返回可用模型' },
        ],
      })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [{ provider: 'claude' as ProviderId, message: networkFailureMessages.dns }] })),
    }

    await expect(
      bootstrapAccountTools(api, 17, undefined, 'restore', undefined, memoryStorage()),
    ).resolves.toMatchObject({ networkBlocked: false })
  })

  it('keeps key sync failures of tools that are not installed off the home banner', async () => {
    const current = config()
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({
        ready: [],
        failed: [
          { provider: 'claude' as ProviderId, group: 'group', message: '分组不存在、不可用或名称重复，请确认账号可用分组' },
          { provider: 'grok' as ProviderId, group: 'group', message: '分组不存在、不可用或名称重复，请确认账号可用分组' },
        ],
      })),
      scanSystem: vi.fn(async () => system(['grok'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [] })),
    }

    const result = await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, memoryStorage())

    expect(result.skipped).toContainEqual(expect.objectContaining({ provider: 'claude', reason: 'not-installed' }))
    expect(result.warnings.join('；')).not.toContain('Claude Code')
    // An installed tool's failure is still reported: only the missing one goes quiet.
    expect(result.failed.map((entry) => entry.provider)).toEqual(['grok'])
  })

  it('reports no network block when everything is written', async () => {
    const current = config()
    const storage = memoryStorage()
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [{ provider: 'claude' as ProviderId, group: 'group', name: 'claude' }], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => {
        current.providers.claude = { ...current.providers.claude, exists: true, hasApiKey: true, matchesRelay: true,
          actualBaseUrl: current.providers.claude.baseUrl, model: 'model', configurationOwnership: 'account' }
        return { configured: ['claude' as ProviderId], failed: [] }
      }),
    }

    await expect(
      bootstrapAccountTools(api, 17, undefined, 'login', undefined, storage),
    ).resolves.toMatchObject({ configured: ['claude'], networkBlocked: false })
  })

  it('protects marked manual relay keys during login and restore bootstrap', () => {
    const current = config()
    const storage = memoryStorage()
    current.providers.claude = {
      ...current.providers.claude,
      exists: true,
      hasApiKey: true,
      matchesRelay: true,
      actualBaseUrl: current.providers.claude.baseUrl,
      model: 'manual-model',
    }
    writeManualSourceMarker(
      storage,
      current.providers.claude.baseUrl,
      'claude',
      true,
    )

    for (const mode of ['login', 'restore'] as const) {
      const plan = accountBootstrapPlan(
        system(['claude']),
        current,
        settings,
        mode,
        storage,
      )
      expect(plan.targets).toEqual([])
      expect(plan.skipped).toContainEqual(
        expect.objectContaining({ provider: 'claude', reason: 'manual' }),
      )
    }
  })

  it('names the tool when a verified write cannot clear its manual source marker', async () => {
    // localStorage 满或被禁用时，Key 已经写进 CLI，只有来源标记没落地。以前这个
    // 返回值被整段丢掉，工具卡会一直显示「手动填写」而用户看不到任何提示。
    const current = config()
    const storage: SourceMarkerStorage = {
      getItem: () => 'manual',
      setItem: () => { throw new Error('storage unavailable') },
      removeItem: () => { throw new Error('storage unavailable') },
    }
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => {
        current.providers.claude = { ...current.providers.claude, exists: true, hasApiKey: true, matchesRelay: true,
          actualBaseUrl: current.providers.claude.baseUrl, model: 'model', configurationOwnership: 'account' }
        return { configured: ['claude' as ProviderId], failed: [] }
      }),
    }

    const result = await bootstrapAccountTools(api, 17, undefined, 'login', undefined, storage)

    expect(result.configured).toEqual(['claude'])
    expect(result.failed).toEqual([])
    expect(result.warnings).toEqual([`Claude Code：${sourceMarkerWriteWarning}`])
  })

  it.each([
    ['backend rejection with manual config', 'manual', false, '保留手动 Key，拒绝自动覆盖', '保留手动 Key，拒绝自动覆盖'],
    ['backend rejection with unknown config', 'unknown', false, '保留来源未确认的 Key', '保留来源未确认的 Key'],
    ['backend success with manual config', 'manual', true, null, configurationFailureMessages.unconfirmedSource],
    ['backend success with unknown config', 'unknown', true, null, configurationFailureMessages.unconfirmedSource],
    ['backend success without ownership', undefined, true, null, configurationFailureMessages.unconfirmedSource],
    ['missing backend result with account config', 'account', false, null, '账号 Key 配置未返回成功结果'],
    ['conflicting backend results with account config', 'account', true, '配置写入失败', '配置写入失败'],
  ] as const)('does not report success for %s', async (_name, ownership, reportedSuccess, backendFailure, expectedMessage) => {
    const current = config()
    const storage = memoryStorage()
    const manualMarker = ownership !== 'unknown' && ownership !== undefined
    writeManualSourceMarker(storage, current.providers.claude.baseUrl, 'claude', manualMarker)
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => {
        current.providers.claude = {
          ...current.providers.claude,
          exists: true,
          hasApiKey: true,
          matchesRelay: true,
          actualBaseUrl: current.providers.claude.baseUrl,
          model: 'current-model',
          configurationOwnership: ownership,
        }
        return {
          configured: reportedSuccess ? ['claude' as ProviderId] : [],
          failed: backendFailure ? [{ provider: 'claude' as ProviderId, message: backendFailure }] : [],
        }
      }),
    }

    const result = await bootstrapAccountTools(api, 17, undefined, 'login', undefined, storage)

    expect(api.configureManagedCliKeys).toHaveBeenCalledOnce()
    expect(result.configured).toEqual([])
    expect(result.failed).toEqual([{ provider: 'claude', message: expectedMessage }])
    expect(readManualSourceMarker(storage, current.providers.claude.baseUrl, 'claude')).toBe(manualMarker)
  })

  it('preserves a stale marker when the account write does not verify', async () => {
    const current = config()
    const storage = memoryStorage()
    writeManualSourceMarker(
      storage,
      current.providers.claude.baseUrl,
      'claude',
      true,
    )
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({
        authenticated: true,
        account: {
          userId: 17,
          username: 'member',
          quota: 0,
          usedQuota: 0,
          group: 'default',
          role: 1,
        },
      })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: ['claude' as ProviderId], failed: [] })),
    }

    const result = await bootstrapAccountTools(
      api,
      17,
      undefined,
      'login',
      undefined,
      storage,
    )
    expect(result.failed).toContainEqual(
      expect.objectContaining({ provider: 'claude' }),
    )
    expect(
      readManualSourceMarker(
        storage,
        current.providers.claude.baseUrl,
        'claude',
      ),
    ).toBe(true)
  })

  it('does not rewrite an already verified relay config on session restore', () => {
    const current = config()
    current.providers.claude = { ...current.providers.claude, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.claude.baseUrl, model: 'claude-model', configurationOwnership: 'account' }
    expect(accountBootstrapPlan(system(['claude']), current, settings, 'restore')).toMatchObject({
      targets: [],
      skipped: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude', reason: 'configured' }),
      ]),
    })
    expect(accountBootstrapPlan(system(['claude']), current, settings, 'login').targets).toEqual(['claude'])
    current.providers.claude.model = ''
    expect(accountBootstrapPlan(system(['claude']), current, settings, 'restore').targets).toEqual(['claude'])
  })

  it.each(['login', 'restore'] as const)('does not rewrite read-only matched keys during %s, even when their model or Gemini auth mode is incomplete', (mode) => {
    const current = config()
    const providers = ['claude', 'codex', 'grok', 'gemini'] as const
    for (const provider of providers) current.providers[provider] = { ...current.providers[provider], exists: true, hasApiKey: true,
      matchesRelay: true, actualBaseUrl: current.providers[provider].baseUrl, model: 'existing-model', configurationOwnership: 'unknown', configurationAccountMatched: true,
      ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}),
    }
    const installed = system([...providers])
    const readyPlan = accountBootstrapPlan(installed, current, settings, mode, null)
    expect(readyPlan.targets).toEqual([])
    expect(readyPlan.skipped).toEqual(providers.map((provider) => expect.objectContaining({ provider, reason: 'configured' })))
    for (const provider of providers) {
      expect(configurationFailure(current, provider, null)).toBe(configurationFailureMessages.unconfirmedSource)
      current.providers[provider].model = ''
    }
    const incompletePlan = accountBootstrapPlan(installed, current, settings, mode, null)
    expect(incompletePlan.targets).toEqual([])
    expect(incompletePlan.skipped).toEqual(providers.map((provider) => expect.objectContaining({ provider, reason: 'unknown' })))
    current.providers.gemini.model = 'existing-model'
    current.providers.gemini.authType = ''
    expect(accountBootstrapPlan(installed, current, settings, mode, null).targets).toEqual([])
  })

  it.each(['login', 'restore'] as const)('retains read-only matched configs without configuring when account synchronization is offline during %s', async (mode) => {
    const current = config()
    for (const provider of ['claude', 'codex', 'grok', 'gemini'] as const) current.providers[provider] = { ...current.providers[provider], exists: true, hasApiKey: true,
      matchesRelay: true, actualBaseUrl: current.providers[provider].baseUrl, model: 'existing-model', configurationOwnership: 'unknown', configurationAccountMatched: true,
      ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}),
    }
    const before = structuredClone(current)
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => { throw new Error('offline') }),
      scanSystem: vi.fn(async () => system(['claude', 'codex', 'grok', 'gemini'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => { throw new Error('must not configure') }),
    }
    const result = await bootstrapAccountTools(api, 17, undefined, mode, undefined, null)
    expect(api.configureManagedCliKeys).not.toHaveBeenCalled()
    expect(result).toMatchObject({ configured: [], failed: [], warnings: ['Key 同步阶段：offline'] })
    expect(result.skipped.every((item) => item.reason === 'configured')).toBe(true)
    expect(current).toEqual(before)
  })

  it('redacts the IPC prefix and the config path out of the sync warning', async () => {
    // The main process names the file it failed on, and on Windows that path
    // carries the account name (R-S7 / I13).
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => {
        throw new Error("Error invoking remote method 'account:sync-managed-cli-keys': Error: 写入托管 Key 失败：C:\\Users\\张三\\.codex\\auth.json")
      }),
      scanSystem: vi.fn(async () => system([])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => config()),
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [] })),
    }

    const result = await bootstrapAccountTools(api, 17, undefined, 'login', undefined, null)

    expect(result.warnings).toContain('Key 同步阶段：写入托管 Key 失败：本地配置文件')
    expect(result.warnings.join(' ')).not.toContain('张三')
    expect(result.warnings.join(' ')).not.toContain('invoking remote method')
  })

  it('does not accept read-only key matching as verification of a reported account write', async () => {
    const current = config()
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => {
        current.providers.claude = { ...current.providers.claude, exists: true, hasApiKey: true, matchesRelay: true,
          actualBaseUrl: current.providers.claude.baseUrl, model: 'existing-model', configurationOwnership: 'unknown', configurationAccountMatched: true }
        return { configured: ['claude' as ProviderId], failed: [] }
      }),
    }
    const result = await bootstrapAccountTools(api, 17, undefined, 'login', undefined, null)
    expect(result.configured).toEqual([])
    expect(result.failed).toEqual([{ provider: 'claude', message: configurationFailureMessages.unconfirmedSource }])
  })

  it('stops a stale account before writing any local configuration', async () => {
    let sessionRead = 0
    const configure = vi.fn()
    const api = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: ++sessionRead === 1 ? 17 : 18 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getConfig: vi.fn(async () => config()),
      getSettings: vi.fn(async () => settings),
      configureManagedCliKeys: configure,
    } as unknown as AccountBootstrapBridge
    await expect(bootstrapAccountTools(api, 17)).rejects.toThrow('账号已变化')
    expect(configure).not.toHaveBeenCalled()
  })
  it('reads the install scan without forcing it, so the boot scan caches survive', async () => {
    const scanSystem = vi.fn(async () => system(['claude']))
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem,
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => config()),
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [] })),
    }
    await bootstrapAccountTools(api, 17, undefined, 'restore')
    expect(scanSystem).toHaveBeenCalledTimes(1)
    // 参数为空（而不是 true）才不会清掉主进程的 npm 最新版与网络位置缓存。
    expect(scanSystem.mock.calls[0]).toEqual([])
  })
  it('rejects the same numeric user id when its platform changes during Key preparation', async () => {
    let reads = 0
    const configure = vi.fn()
    const api = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, siteId: ++reads === 1 ? 'solov' : 'solov-api', account: { userId: 17 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      configureManagedCliKeys: configure,
    } as unknown as AccountBootstrapBridge
    await expect(bootstrapAccountTools(api, 17)).rejects.toThrow('账号已变化')
    expect(configure).not.toHaveBeenCalled()
  })
})

describe('account bootstrap log lines', () => {
  function result(overrides: Partial<AccountBootstrapResult> = {}): AccountBootstrapResult {
    return {
      readyKeys: ['claude', 'codex'],
      configured: ['claude'],
      failed: [],
      skipped: [
        { provider: 'gemini', reason: 'not-installed', message: 'Gemini CLI 尚未安装，Key 已保留在账号中' },
        { provider: 'grok', reason: 'manual', message: 'Grok CLI 保留手动填写的密钥' },
      ],
      warnings: [],
      networkBlocked: false,
      ...overrides,
    }
  }

  it('says which tools were written and why the others were skipped, at info level', () => {
    expect(describeAccountBootstrapResult('login', result())).toEqual({
      level: 'info',
      message: 'Key 自动配置（登录后）：写好 Claude Code；跳过 Gemini CLI（未安装）、Grok CLI（手填密钥）',
    })
  })

  it('raises to warn and carries the failure reason when a tool was not written', () => {
    const line = describeAccountBootstrapResult('restore', result({
      configured: [],
      failed: [{ provider: 'codex', message: configurationFailureMessages.relayMismatch }],
      skipped: [],
    }))

    expect(line.level).toBe('warn')
    expect(line.message).toBe(`Key 自动配置（开机或联网后恢复）：写好 无；没写成 Codex CLI（${configurationFailureMessages.relayMismatch}）`)
  })

  it('marks a network-blocked round as warn so it stands out in the report', () => {
    const line = describeAccountBootstrapResult('restore', result({ configured: [], skipped: [], networkBlocked: true }))

    expect(line.level).toBe('warn')
    expect(line.message).toContain('被网络拦住，联网后会自动补跑')
  })

  it('never includes keys, addresses or models even though the plan knows the models', () => {
    const text = describeAccountBootstrapResult('rewrite', result()).message

    expect(text).not.toMatch(/sk-|https?:\/\/|opus|gpt-/i)
  })

  it('describes a round that did not finish at warn level', () => {
    expect(describeAccountBootstrapFailure('login', '星芒账号已变化，已停止本次 Key 配置')).toEqual({
      level: 'warn',
      message: 'Key 自动配置（登录后）没有完成：星芒账号已变化，已停止本次 Key 配置',
    })
  })
})

describe('named key rewrite outcome', () => {
  it('reports a named tool the planner skipped so a revoke never claims a fresh key', () => {
    const skipped = [
      { provider: 'claude' as const, reason: 'manual' as const, message: 'Claude Code 保留手动填写的密钥' },
      { provider: 'codex' as const, reason: 'official' as const, message: 'Codex CLI 保留官方账号连接' },
    ]
    expect(skippedNamedProviders({ skipped }, ['claude'])).toEqual([skipped[0]])
    expect(skippedNamedProviders({ skipped }, ['gemini'])).toEqual([])
    expect(skippedNamedProviders({ skipped }, undefined)).toEqual([])
    expect(skippedNamedProviders(undefined, ['claude'])).toEqual([])
    const error = new KeyRewriteSkippedError([skipped[0]])
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Claude Code 保留手动填写的密钥')
  })
})

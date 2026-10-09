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
  accountKeyChangeInProgress,
  accountKeyChangePending,
  accountRoutesPending,
  bootstrapAccountTools,
  bootstrapOnlyFollowedRoute,
  configurationFailure,
  configurationFailureMessages,
  describeAccountBootstrapFailure,
  describeAccountBootstrapResult,
  sessionChangeKeepsBootstrap,
  skippedNamedProviders,
  type AccountBootstrapBridge,
  type AccountBootstrapProgress,
  type AccountBootstrapResult,
} from './account-bootstrap'
import { networkFailureMessages } from '../../../../electron/network-failure'
import { relayProviderBaseUrls } from '../../../../electron/relay-sites'
import type { RunningToolsReport } from '../../../../electron/running-tools'
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

  it('puts an unregistered image tool on the home banner without treating it as a network failure', async () => {
    const current = config()
    const notice = '星芒画图还没装进 Claude Code：它的设置这会儿写不进去。先关掉正在用的 AI 工具，再点「重新同步」。'
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [], imageMcpWarning: notice })),
      scanSystem: vi.fn(async () => system([])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [] })),
    }

    const result = await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, memoryStorage())

    expect(result.warnings).toEqual([notice])
    expect(result.drawingNeedsNode).toBeUndefined()
    expect(result.networkBlocked).toBe(false)
  })

  it('keeps the missing-Node.js drawing notice apart so the home page can follow the runtime card', async () => {
    const current = config()
    const notice = '星芒画图还没装进 AI 工具：这台电脑还缺运行环境。到首页「运行环境」装好后，点「重新同步」就能用。'
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [], imageMcpWarning: notice, imageMcpNeedsNode: true })),
      scanSystem: vi.fn(async () => system([])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [] })),
    }

    const result = await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, memoryStorage())

    expect(result.warnings).toEqual([])
    expect(result.drawingNeedsNode).toBe(notice)
    expect(result.networkBlocked).toBe(false)
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

  it('rewrites a verified config on restore only when its key just moved to another group', () => {
    const current = config()
    current.providers.claude = { ...current.providers.claude, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.claude.baseUrl, model: 'claude-model', configurationOwnership: 'account' }
    current.providers.codex = { ...current.providers.codex, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.codex.baseUrl, model: 'codex-model', configurationOwnership: 'account' }
    const plan = accountBootstrapPlan(system(['claude', 'codex']), current, settings, 'restore', undefined, ['claude'])
    expect(plan.targets).toEqual(['claude'])
    expect(plan.preferredModels).toEqual({ claude: 'claude-model' })
    expect(plan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'codex', reason: 'configured' })]))
  })

  it('repairs an owned Codex config that Codex ignores on session restore', () => {
    const current = config()
    current.providers.codex = { ...current.providers.codex, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.codex.baseUrl, model: 'gpt-model', configurationOwnership: 'account', codexProviderShadowed: true }
    expect(accountBootstrapPlan(system(['codex']), current, settings, 'restore').targets).toEqual(['codex'])
  })

  it.each(['login', 'restore'] as const)('repairs an unowned Codex config that Codex ignores during %s when it holds the cached account key', (mode) => {
    const current = config()
    current.providers.codex = { ...current.providers.codex, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.codex.baseUrl, model: 'gpt-model',
      configurationOwnership: 'unknown', configurationAccountMatched: true, codexProviderShadowed: true }
    const plan = accountBootstrapPlan(system(['codex']), current, settings, mode, null)
    expect(plan.targets).toEqual(['codex'])
    expect(plan.shadowRepairs).toEqual(['codex'])
    expect(plan.preferredModels).toMatchObject({ codex: 'gpt-model' })
  })

  it.each([
    ['the key is not the cached account key', { configurationOwnership: 'unknown' as const, configurationAccountMatched: false }, 'unknown'],
    ['the user edited a config we wrote', { configurationOwnership: 'changed' as const, configurationAccountMatched: false }, 'changed'],
    ['the user chose to keep a manual key', { configurationOwnership: 'manual' as const, configurationAccountMatched: true }, 'manual'],
  ])('leaves a Codex config that Codex ignores for the repair button when %s', (_label, fields, reason) => {
    const current = config()
    current.providers.codex = { ...current.providers.codex, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.codex.baseUrl, model: 'gpt-model',
      codexProviderShadowed: true, ...fields }
    const plan = accountBootstrapPlan(system(['codex']), current, settings, 'restore', null)
    expect(plan.targets).toEqual([])
    expect(plan.shadowRepairs).toBeUndefined()
    expect(plan.skipped).toContainEqual(expect.objectContaining({ provider: 'codex', reason }))
  })

  it('does not treat an unowned matched Codex config as a repair when Codex reads it fine', () => {
    const current = config()
    current.providers.codex = { ...current.providers.codex, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.codex.baseUrl, model: 'gpt-model',
      configurationOwnership: 'unknown', configurationAccountMatched: true, codexProviderShadowed: false }
    const plan = accountBootstrapPlan(system(['codex']), current, settings, 'restore', null)
    expect(plan.targets).toEqual([])
    expect(plan.shadowRepairs).toBeUndefined()
  })

  it('reports the Codex config it repaired without anyone clicking, and only once the readback is clean', async () => {
    const current = config()
    current.providers.codex = { ...current.providers.codex, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.codex.baseUrl, model: 'gpt-model',
      configurationOwnership: 'unknown', configurationAccountMatched: true, codexProviderShadowed: true }
    const configure = vi.fn<AccountBootstrapBridge['configureManagedCliKeys']>(async (input) => {
      for (const provider of input.providers) current.providers[provider] = { ...current.providers[provider], configurationOwnership: 'account' as const, codexProviderShadowed: false }
      return { configured: [...input.providers], failed: [] }
    })
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [{ provider: 'codex' as ProviderId, group: 'group', name: 'codex' }], failed: [] })),
      scanSystem: vi.fn(async () => system(['codex'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: configure,
    }
    const result = await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, memoryStorage())
    expect(result.configured).toEqual(['codex'])
    expect(result.repairedShadowed).toEqual(['codex'])
    // 自动那条路不带 explicit：主进程只凭同一组条件放行，不是靠「用户点名」穿闸。
    expect(configure).toHaveBeenCalledWith(expect.not.objectContaining({ intent: 'explicit' }))
    expect(describeAccountBootstrapResult('restore', result).message).toContain('顺手修好 Codex')

    current.providers.codex = { ...current.providers.codex, configurationOwnership: 'unknown', codexProviderShadowed: true }
    configure.mockImplementationOnce(async (input) => ({ configured: [], failed: input.providers.map((provider) => ({ provider, message: '已有工具配置的来源未经确认，已保留原配置；请在工具配置中明确选择账号密钥' })) }))
    const refused = await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, memoryStorage())
    expect(refused.repairedShadowed).toBeUndefined()
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
    const sync = vi.fn(async () => ({ ready: [], failed: [] }))
    const api = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, siteId: ++reads === 1 ? 'solov' : 'solov-api', account: { userId: 17 } })),
      getConfig: vi.fn(async () => config()),
      syncManagedCliKeys: sync,
      configureManagedCliKeys: configure,
    } as unknown as AccountBootstrapBridge
    await expect(bootstrapAccountTools(api, 17)).rejects.toThrow('账号已变化')
    expect(sync).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()
  })
})

// 第三十一批 A：开机检测没跑完时首页按这一轮账号会不会换 Key，决定哪几行能先「打开」。
describe('account key changes before the startup scan finishes', () => {
  const connected = () => ({
    exists: true,
    hasApiKey: true,
    matchesRelay: true,
    configurationOwnership: 'account' as const,
    baseUrl: 'https://xm.solov.cc/v1',
    actualBaseUrl: 'https://xm.solov.cc/v1',
    model: 'fixture-model',
    apiKeyPreview: 'sk-***',
    dataDirectory: 'C:\\home',
    dataDirectoryExists: true,
    files: [],
    updatedAt: null,
  })
  const syncing = { phase: 'syncing' as const, label: '正在同步账号专属 Key', percent: 15 }

  it('cannot tell yet for a signed-in or restoring account whose key sync has not started', () => {
    expect(accountKeyChangePending({ signedIn: true, restoring: false, bootstrap: null }, 'claude')).toBe(true)
    expect(accountKeyChangePending({ signedIn: false, restoring: true, bootstrap: null }, 'claude')).toBe(true)
  })

  it('has nothing to wait for without an account', () => {
    expect(accountKeyChangePending({ signedIn: false, restoring: false, bootstrap: null }, 'claude')).toBe(false)
  })

  it('waits while the key sync has not said which connected tools change', () => {
    expect(accountKeyChangePending({ signedIn: true, restoring: false, bootstrap: syncing }, 'codex')).toBe(true)
  })

  it('waits only for the connected tools whose key changes this round', () => {
    const bootstrap = { phase: 'inspecting' as const, label: '正在检查已安装工具和连接来源', percent: 40, connectedKeyChanges: ['claude' as ProviderId] }
    expect(accountKeyChangePending({ signedIn: true, restoring: false, bootstrap }, 'claude')).toBe(true)
    expect(accountKeyChangePending({ signedIn: true, restoring: false, bootstrap }, 'codex')).toBe(false)
  })

  it('stops waiting once the round has finished or failed', () => {
    const finished = { ...syncing, result: { readyKeys: [], configured: [], failed: [], skipped: [], warnings: [], networkBlocked: false } }
    expect(accountKeyChangePending({ signedIn: true, restoring: false, bootstrap: finished }, 'claude')).toBe(false)
    expect(accountKeyChangePending({ signedIn: true, restoring: false, bootstrap: { ...syncing, error: '账号 Key 初始化没有完成' } }, 'claude')).toBe(false)
  })

  it('after the scan waits only while a key sync round is actually running', () => {
    // Switching saved accounts skips the round, and a restore that cannot reach the
    // account service keeps retrying without one: neither may lock tools until a relaunch.
    expect(accountKeyChangeInProgress(null, 'claude')).toBe(false)
    expect(accountKeyChangeInProgress(syncing, 'claude')).toBe(true)
    const bootstrap = { phase: 'configuring' as const, label: '正在为 1 个已安装工具写入 Key', percent: 65, connectedKeyChanges: ['claude' as ProviderId] }
    expect(accountKeyChangeInProgress(bootstrap, 'claude')).toBe(true)
    expect(accountKeyChangeInProgress(bootstrap, 'codex')).toBe(false)
    expect(accountKeyChangeInProgress({ ...bootstrap, result: { readyKeys: [], configured: ['claude'], failed: [], skipped: [], warnings: [], networkBlocked: false } }, 'claude')).toBe(false)
    expect(accountKeyChangeInProgress({ ...bootstrap, error: '账号 Key 初始化没有完成' }, 'claude')).toBe(false)
  })

  it('names the regrouped connected tools before it waits for the scan on a restore', async () => {
    const current = config()
    current.providers.claude = connected()
    current.providers.codex = connected()
    const order: string[] = []
    const progress: AccountBootstrapProgress[] = []
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [], regrouped: ['claude' as ProviderId] })),
      scanSystem: vi.fn(async () => { order.push('scan'); return system(['claude', 'codex']) }),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: ['claude' as ProviderId], failed: [] })),
    }

    await bootstrapAccountTools(api, 17, (entry) => { order.push(entry.phase); progress.push(entry) }, 'restore', undefined, memoryStorage())

    expect(order.indexOf('inspecting')).toBeLessThan(order.indexOf('scan'))
    expect(progress.filter((entry) => entry.phase !== 'syncing').map((entry) => entry.connectedKeyChanges)).toEqual([['claude'], ['claude'], ['claude']])
    // 换了分组的那一家这一轮确实要重写，没换的照旧不动。
    expect(api.configureManagedCliKeys).toHaveBeenCalledWith(expect.objectContaining({ providers: ['claude'] }))
  })

  it('names no tool when nothing was regrouped, so every connected tool can open', async () => {
    const current = config()
    current.providers.claude = connected()
    const progress: AccountBootstrapProgress[] = []
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [] })),
    }

    await bootstrapAccountTools(api, 17, (entry) => progress.push(entry), 'restore', undefined, memoryStorage())

    expect(progress.find((entry) => entry.phase === 'inspecting')?.connectedKeyChanges).toEqual([])
    expect(api.configureManagedCliKeys).not.toHaveBeenCalled()
  })

  it('leaves the answer open on a login, which rewrites connected tools too', async () => {
    const current = config()
    current.providers.claude = connected()
    const progress: AccountBootstrapProgress[] = []
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem: vi.fn(async () => system(['claude'])),
      getSettings: vi.fn(async () => settings),
      getConfig: vi.fn(async () => structuredClone(current)),
      configureManagedCliKeys: vi.fn(async () => ({ configured: ['claude' as ProviderId], failed: [] })),
    }

    await bootstrapAccountTools(api, 17, (entry) => progress.push(entry), 'login', undefined, memoryStorage())

    expect(progress.every((entry) => !('connectedKeyChanges' in entry))).toBe(true)
    expect(api.configureManagedCliKeys).toHaveBeenCalledWith(expect.objectContaining({ providers: ['claude'] }))
  })
})

// 星芒账号默认由主进程定点改地址（xm 三线路 C9），渲染层整份重写只在服务状态切回老办法（R6 merge）时还走，
// 下面两组钉的就是那条老路；历史账号一直走它。
describe('explicit applied connection routes on restore', () => {
  const primary = relayProviderBaseUrls('solov', 'primary')
  const direct = relayProviderBaseUrls('solov', 'direct')
  const applied: AppSettingsV2 = { ...settings, relaySiteId: 'solov', toolRouteRewrite: 'merge', relayEndpointIds: { solov: 'direct' }, activeRelayEndpointIds: { solov: 'direct' } }
  function routedConfig(provider: ProviderId = 'codex'): AppConfigSummary {
    const current = config()
    current.providers[provider] = { ...current.providers[provider], exists: true, hasApiKey: true, matchesRelay: true,
      baseUrl: direct[provider], actualBaseUrl: primary[provider], model: 'kept-model', configurationOwnership: 'account',
      ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}) }
    return current
  }
  function fixture() {
    const current = routedConfig()
    // 桥上问得出 Codex 开着，这一轮也不问：开着照样改（#941），线路的事不提示（yoyo 10-8）。
    const open: RunningToolsReport = { running: ['codex'], unknown: [], codexDesktopRunning: true, canRestartCodexDesktop: true }
    const api = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, siteId: 'solov' as const, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [], failed: [] })),
      scanSystem: vi.fn(async () => system(['codex'])),
      getConfig: vi.fn(async () => structuredClone(current)),
      getSettings: vi.fn(async () => applied),
      inspectRunningTools: vi.fn(async () => open),
      configureManagedCliKeys: vi.fn(async () => {
        current.providers.codex.actualBaseUrl = current.providers.codex.baseUrl
        return { configured: ['codex' as ProviderId], failed: [] }
      }),
    }
    return { current, api }
  }

  it.each(['claude', 'codex', 'gemini', 'grok'] as const)('plans an owned %s config for the explicitly applied route and keeps its model', (provider) => {
    expect(accountBootstrapPlan(system([provider]), routedConfig(provider), applied, 'restore', null)).toMatchObject({
      targets: [provider], preferredModels: { [provider]: 'kept-model' },
    })
  })

  it('migrates the retired IP test entry even though its endpoint id is also direct', () => {
    const current = routedConfig()
    current.providers.codex.actualBaseUrl = 'https://38.147.105.28:8443/v1'
    expect(accountBootstrapPlan(system(['codex']), current, applied, 'restore', null).targets).toEqual(['codex'])
    current.providers.codex.actualBaseUrl = `${direct.codex}/`
    expect(accountBootstrapPlan(system(['codex']), current, applied, 'restore', null).targets).toEqual([])
  })

  it('migrates back only after an explicit primary choice was applied at startup', () => {
    const current = routedConfig()
    current.providers.codex = { ...current.providers.codex, baseUrl: primary.codex, actualBaseUrl: direct.codex }
    const restoredPrimary: AppSettingsV2 = { ...applied, relayEndpointIds: { solov: 'primary' }, activeRelayEndpointIds: { solov: 'primary' } }
    expect(accountBootstrapPlan(system(['codex']), current, restoredPrimary, 'restore', null).targets).toEqual(['codex'])
  })

  it.each([
    ['no explicit selection', { ...applied, relayEndpointIds: undefined }],
    ['only a pending selection', { ...applied, activeRelayEndpointIds: { solov: 'primary' as const } }],
    ['no startup route snapshot', { ...applied, activeRelayEndpointIds: undefined }],
  ])('keeps a compatible old route with %s', (_name, preferences) => {
    expect(accountBootstrapPlan(system(['codex']), routedConfig(), preferences, 'restore', null).targets).toEqual([])
  })

  it.each(['manual', 'changed', 'unknown'] as const)('does not use route selection to take over %s ownership', (ownership) => {
    const current = routedConfig()
    current.providers.codex = { ...current.providers.codex, configurationOwnership: ownership, configurationAccountMatched: true }
    expect(accountBootstrapPlan(system(['codex']), current, applied, 'restore', null).targets).toEqual([])
  })

  it('does not migrate foreign sites or a summary whose expected route disagrees with the active selection', () => {
    const current = routedConfig()
    current.providers.codex.actualBaseUrl = 'https://api.solov.cc/v1'
    current.providers.codex.matchesRelay = false
    expect(accountBootstrapPlan(system(['codex']), current, applied, 'restore', null).targets).toEqual([])
    current.providers.codex = { ...routedConfig().providers.codex, baseUrl: primary.codex, actualBaseUrl: direct.codex }
    expect(accountBootstrapPlan(system(['codex']), current, applied, 'restore', null).targets).toEqual([])
    expect(accountBootstrapPlan(system(['codex']), routedConfig(), { ...applied, officialProviders: ['codex'] }, 'restore', null).targets).toEqual([])
  })

  it('writes a route change through ordinary automatic configure and holds launch while the scan is pending', async () => {
    const { current, api } = fixture()
    const progress: AccountBootstrapProgress[] = []
    api.scanSystem.mockImplementation(async () => {
      expect(accountKeyChangePending({ signedIn: true, restoring: false, bootstrap: progress.at(-1)! }, 'codex')).toBe(true)
      return system(['codex'])
    })
    const result = await bootstrapAccountTools(api, 17, (entry) => progress.push(entry), 'restore', undefined, null)
    expect(api.configureManagedCliKeys).toHaveBeenCalledWith({ providers: ['codex'], preferredModels: { codex: 'kept-model' } })
    expect(current.providers.codex.actualBaseUrl).toBe(direct.codex)
    expect(result).toMatchObject({ configured: ['codex'], failed: [], routeFollowed: ['codex'] })
  })

  // #941：以前开着的工具先不改，客户不关工具、不点「重新同步」，它就一直停在原来那条线路上。
  it('follows the line while the tool is open without asking which tools are open', async () => {
    const { current, api } = fixture()
    const result = await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, null)
    expect(api.inspectRunningTools).not.toHaveBeenCalled()
    expect(current.providers.codex.actualBaseUrl).toBe(direct.codex)
    expect(result).toMatchObject({ configured: ['codex'], failed: [], routeFollowed: ['codex'] })
    expect(describeAccountBootstrapResult('restore', result).message).toContain('跟着换了连接线路：Codex CLI')
  })

  it('rejects a reported success that did not move the route with the ordinary address wording', async () => {
    const { current, api } = fixture()
    api.configureManagedCliKeys.mockImplementation(async () => ({ configured: ['codex' as ProviderId], failed: [] }))
    const result = await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, null)
    expect(current.providers.codex.actualBaseUrl).toBe(primary.codex)
    expect(result.configured).toEqual([])
    expect(result.failed).toEqual([{ provider: 'codex', message: configurationFailureMessages.relayMismatch }])
    expect(result).not.toHaveProperty('routeFollowed')
  })

  it('does not count a round as following the line when no route changed', async () => {
    const { current, api } = fixture()
    current.providers.codex.actualBaseUrl = direct.codex
    api.getConfig.mockImplementation(async () => structuredClone(current))
    const result = await bootstrapAccountTools(api, 17, undefined, 'login', undefined, null)
    expect(api.configureManagedCliKeys).toHaveBeenCalled()
    expect(result.configured).toEqual(['codex'])
    expect(result).not.toHaveProperty('routeFollowed')
    expect(bootstrapOnlyFollowedRoute(result)).toBe(false)
  })

  it('says a round only followed the line when every tool it wrote just changed its line', () => {
    const configured: ProviderId[] = ['claude', 'codex']
    expect(bootstrapOnlyFollowedRoute({ configured, routeFollowed: ['claude', 'codex'] })).toBe(true)
    // 有一个是真写了 Key（新装的、换了分组的），首页照常说「已完成…」。
    expect(bootstrapOnlyFollowedRoute({ configured, routeFollowed: ['codex'] })).toBe(false)
    expect(bootstrapOnlyFollowedRoute({ configured, routeFollowed: ['claude', 'codex'], regrouped: ['claude'] })).toBe(false)
    expect(bootstrapOnlyFollowedRoute({ configured })).toBe(false)
    expect(bootstrapOnlyFollowedRoute({ configured: [], routeFollowed: ['codex'] })).toBe(false)
  })
})

// 直连适配第二步：「自动」的线路由主进程查出来（relayRouteLines），查出结论以后工具配置才跟着迁。
describe('automatic connection route', () => {
  const primary = relayProviderBaseUrls('solov', 'primary')
  const direct = relayProviderBaseUrls('solov', 'direct')
  const automatic: AppSettingsV2 = {
    ...settings,
    relaySiteId: 'solov',
    toolRouteRewrite: 'merge',
    activeRelayEndpointIds: { solov: 'auto', 'solov-api': 'auto' },
    relayRouteLines: { solov: { line: 'direct', settled: true }, 'solov-api': { line: 'primary', settled: false } },
  }
  function ownedOn(expected: string, actual: string): AppConfigSummary {
    const current = config()
    current.providers.codex = { ...current.providers.codex, exists: true, hasApiKey: true, matchesRelay: true,
      baseUrl: expected, actualBaseUrl: actual, model: 'kept-model', configurationOwnership: 'account' }
    return current
  }

  it('moves an owned config to the line auto settled on', () => {
    expect(accountBootstrapPlan(system(['codex']), ownedOn(direct.codex, primary.codex), automatic, 'restore', null).targets).toEqual(['codex'])
    expect(accountRoutesPending(ownedOn(direct.codex, primary.codex), automatic, memoryStorage())).toBe(true)
  })

  it('moves it back to the default line after auto fell back', () => {
    const fellBack: AppSettingsV2 = { ...automatic, relayRouteLines: { ...automatic.relayRouteLines!, solov: { line: 'primary', settled: true } } }
    expect(accountBootstrapPlan(system(['codex']), ownedOn(primary.codex, direct.codex), fellBack, 'restore', null).targets).toEqual(['codex'])
  })

  it('leaves the old line alone until auto has settled, or while another choice waits for a restart', () => {
    const unsettled: AppSettingsV2 = { ...automatic, relayRouteLines: { ...automatic.relayRouteLines!, solov: { line: 'primary', settled: false } } }
    const pending: AppSettingsV2 = { ...automatic, relayEndpointIds: { solov: 'primary' } }
    for (const preferences of [unsettled, pending, { ...automatic, relayRouteLines: undefined }]) {
      expect(accountBootstrapPlan(system(['codex']), ownedOn(primary.codex, direct.codex), preferences, 'restore', null).targets).toEqual([])
      expect(accountRoutesPending(ownedOn(primary.codex, direct.codex), preferences, memoryStorage())).toBe(false)
    }
  })

  // xm 三线路：星芒账号的工具配置跟工具线路，和管理工具自己走的那条不一样时照常迁到工具线路。
  it('moves to the tool line when it differs from the line the app itself uses', () => {
    const split: AppSettingsV2 = { ...automatic, relayToolRouteLines: { solov: { line: 'primary', settled: true } } }
    expect(accountBootstrapPlan(system(['codex']), ownedOn(primary.codex, direct.codex), split, 'restore', null).targets).toEqual(['codex'])
    expect(accountRoutesPending(ownedOn(primary.codex, direct.codex), split, memoryStorage())).toBe(true)
    // 已经在工具线路上的不动，哪怕管理工具自己走的是另一条。
    expect(accountRoutesPending(ownedOn(primary.codex, primary.codex), split, memoryStorage())).toBe(false)
  })

  it('has nothing pending once every owned config is on the current line', () => {
    expect(accountRoutesPending(ownedOn(direct.codex, direct.codex), automatic, memoryStorage())).toBe(false)
    expect(accountRoutesPending(config(), automatic, memoryStorage())).toBe(false)
  })

  it('treats a pinned line as settled even without the live route lines', () => {
    const pinned: AppSettingsV2 = { ...settings, relaySiteId: 'solov', toolRouteRewrite: 'merge', relayEndpointIds: { solov: 'direct' }, activeRelayEndpointIds: { solov: 'direct' } }
    expect(accountRoutesPending(ownedOn(direct.codex, primary.codex), pinned, memoryStorage())).toBe(true)
  })

  it('leaves a xm route change to the main process unless the service status asks for the old merge path', () => {
    const targeted: AppSettingsV2 = { ...automatic, toolRouteRewrite: undefined }
    expect(accountBootstrapPlan(system(['codex']), ownedOn(direct.codex, primary.codex), targeted, 'restore', null).targets).toEqual([])
    expect(accountRoutesPending(ownedOn(direct.codex, primary.codex), targeted, memoryStorage())).toBe(false)
  })

  it('keeps moving the legacy account site through the renderer as before', () => {
    const legacyPrimary = relayProviderBaseUrls('solov-api', 'primary')
    const legacyDirect = relayProviderBaseUrls('solov-api', 'direct')
    const legacy: AppSettingsV2 = {
      ...settings,
      relaySiteId: 'solov-api',
      activeRelayEndpointIds: { 'solov-api': 'auto' },
      relayRouteLines: { solov: { line: 'primary', settled: false }, 'solov-api': { line: 'direct', settled: true } },
    }
    expect(accountBootstrapPlan(system(['codex']), ownedOn(legacyDirect.codex, legacyPrimary.codex), legacy, 'restore', null).targets).toEqual(['codex'])
    expect(accountRoutesPending(ownedOn(legacyDirect.codex, legacyPrimary.codex), legacy, memoryStorage())).toBe(true)
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

describe('account bootstrap configuration preflight', () => {
  it('does not issue managed Keys or change local tool config when the current config cannot be read', async () => {
    const syncManagedCliKeys = vi.fn(async () => ({ ready: [], failed: [] }))
    const configureManagedCliKeys = vi.fn(async () => ({ configured: [], failed: [] }))
    const scanSystem = vi.fn(async () => system(['claude']))
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      getConfig: vi.fn(async () => { throw new Error('本机配置暂时无法读取') }),
      getSettings: vi.fn(async () => settings), scanSystem,
      syncManagedCliKeys, configureManagedCliKeys,
    }
    await expect(bootstrapAccountTools(api, 17, undefined, 'restore', undefined, null)).rejects.toThrow('本机配置暂时无法读取')
    expect(syncManagedCliKeys).not.toHaveBeenCalled()
    expect(configureManagedCliKeys).not.toHaveBeenCalled()
    expect(scanSystem).not.toHaveBeenCalled()
  })

  it('checks the account again after the preflight read before syncing Keys', async () => {
    let accountRead = 0
    const syncManagedCliKeys = vi.fn(async () => ({ ready: [], failed: [] }))
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: ++accountRead === 1 ? 17 : 18, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      getConfig: vi.fn(async () => config()), getSettings: vi.fn(async () => settings),
      scanSystem: vi.fn(async () => system(['claude'])), syncManagedCliKeys,
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [] })),
    }
    await expect(bootstrapAccountTools(api, 17, undefined, 'restore', undefined, null)).rejects.toThrow('账号已变化')
    expect(syncManagedCliKeys).not.toHaveBeenCalled()
  })

  it('uses a fresh config read after Key sync when deciding whether to write a tool', async () => {
    const before = config()
    const after = config()
    after.providers.claude = { ...after.providers.claude, exists: true, hasApiKey: true, matchesRelay: true,
      actualBaseUrl: after.providers.claude.baseUrl, model: 'manual-model', configurationOwnership: 'manual' }
    const getConfig = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after)
      .mockResolvedValueOnce(after)
    const configureManagedCliKeys = vi.fn(async () => ({ configured: [], failed: [] }))
    const api: AccountBootstrapBridge = {
      getAccountSession: vi.fn(async () => ({ authenticated: true, account: { userId: 17, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 } })),
      getConfig, getSettings: vi.fn(async () => settings), scanSystem: vi.fn(async () => system(['claude'])),
      syncManagedCliKeys: vi.fn(async () => ({ ready: [{ provider: 'claude' as ProviderId, group: 'group', name: 'claude' }], failed: [] })),
      configureManagedCliKeys,
    }
    await bootstrapAccountTools(api, 17, undefined, 'restore', undefined, null)
    expect(getConfig).toHaveBeenCalledTimes(3)
    expect(configureManagedCliKeys).not.toHaveBeenCalled()
  })
})

describe('session changes while an account bootstrap runs', () => {
  const member = { userId: 7, username: 'member', quota: 0, usedQuota: 0, group: 'default', role: 1 }

  it('keeps the bootstrap when the event names the account it runs for', () => {
    expect(sessionChangeKeepsBootstrap('xm-account:7', { authenticated: true, siteId: 'solov', account: member })).toBe(true)
    expect(sessionChangeKeepsBootstrap('xm-account:7', { authenticated: true, account: member })).toBe(true)
    expect(sessionChangeKeepsBootstrap('api-account:7', { authenticated: true, siteId: 'solov-api', realmId: 'api-account', account: member })).toBe(true)
  })

  it('drops the bootstrap after a logout or a switch to another account or site', () => {
    expect(sessionChangeKeepsBootstrap('xm-account:7', { authenticated: false, account: null })).toBe(false)
    expect(sessionChangeKeepsBootstrap('xm-account:7', { authenticated: false, siteId: 'solov', account: member })).toBe(false)
    expect(sessionChangeKeepsBootstrap('xm-account:7', { authenticated: true, siteId: 'solov', account: { ...member, userId: 18 } })).toBe(false)
    expect(sessionChangeKeepsBootstrap('xm-account:7', { authenticated: true, siteId: 'solov-api', realmId: 'api-account', account: member })).toBe(false)
  })

  it('has nothing to keep when no bootstrap is running', () => {
    expect(sessionChangeKeepsBootstrap(undefined, { authenticated: true, siteId: 'solov', account: member })).toBe(false)
    expect(sessionChangeKeepsBootstrap(null, { authenticated: true, siteId: 'solov', account: member })).toBe(false)
  })
})

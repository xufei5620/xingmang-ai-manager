import { describe, expect, it, vi } from 'vitest'
import type {
  AppConfigSummary,
  AppSettingsV2,
  ProviderId,
  SystemSnapshot,
} from '../../../../electron/ipc-contract'
import {
  accountBootstrapPlan,
  bootstrapAccountTools,
  type AccountBootstrapBridge,
} from './account-bootstrap'
import {
  readManualSourceMarker,
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
  runtime: { node: status(true), npm: status(true), python: status(true) },
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
        for (const provider of input.providers) current.providers[provider] = { ...current.providers[provider], exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers[provider].baseUrl, model: 'model', ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}) }
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
    current.providers.claude = { ...current.providers.claude, exists: true, hasApiKey: true, matchesRelay: true, actualBaseUrl: current.providers.claude.baseUrl, model: 'claude-model' }
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
})

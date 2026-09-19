import { describe, expect, it } from 'vitest'
import type { ProviderConfigSummary, ProviderId } from '../../../../electron/ipc-contract'
import { canUninstallTool, codexDesktopUpdateKind, connectionReady, presentTools, providerFor, rollbackVersion, sourceFor, versionSubtitle, type ToolboxSnapshot, type ToolPresentation } from './model'
import {
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

const relayConfig = (): ProviderConfigSummary => ({
  exists: true,
  hasApiKey: true,
  matchesRelay: true,
  baseUrl: 'https://xm.solov.cc/v1',
  actualBaseUrl: 'https://xm.solov.cc/v1',
  model: 'fixture-model',
  apiKeyPreview: 'sk-***',
  dataDirectory: 'C:\\fixture',
  dataDirectoryExists: true,
  files: [],
  updatedAt: null,
})

describe('renderer tool source', () => {
  it('only advertises uninstall when native status confirms it is available', () => {
    expect(canUninstallTool({ uninstall: { available: true, reason: null, manualCommand: null } })).toBe(true)
    expect(canUninstallTool({ uninstall: { available: false, reason: '外部安装', manualCommand: 'manual' } })).toBe(false)
    expect(canUninstallTool({ uninstall: undefined }, true)).toBe(true)
    expect(canUninstallTool(undefined)).toBe(false)
  })

  it('distinguishes marked manual relay keys and keeps them launch-ready', () => {
    const storage = memoryStorage()
    const config = relayConfig()
    expect(sourceFor(config, 'codex', storage)).toBe('unknown')

    writeManualSourceMarker(storage, config.baseUrl, 'codex', true)
    expect(sourceFor(config, 'codex', storage)).toBe('manual')
    expect(connectionReady(config, 'codex', storage)).toBe(true)
    expect(providerFor('codexDesktop')).toBe('codex')
  })

  it('does not let a marker override official, third-party, or missing state', () => {
    const storage = memoryStorage()
    const config = relayConfig()
    writeManualSourceMarker(storage, config.baseUrl, 'codex', true)

    expect(
      sourceFor({ ...config, codexAuthMode: 'chatgpt' }, 'codex', storage),
    ).toBe('official')
    expect(
      sourceFor(
        {
          ...config,
          matchesRelay: false,
          actualBaseUrl: 'https://other.example/v1',
        },
        'codex',
        storage,
      ),
    ).toBe('unknown')
    expect(
      sourceFor(
        {
          ...config,
          exists: false,
          hasApiKey: false,
          matchesRelay: false,
          actualBaseUrl: '',
          model: '',
        },
        'codex',
        storage,
      ),
    ).toBe('missing')
  })

  it('uses durable ownership and conservatively preserves unmarked keys when browser storage fails', () => {
    const broken: SourceMarkerStorage = { getItem: () => { throw new Error('unavailable') }, setItem() {}, removeItem() {} }
    expect(sourceFor(relayConfig(), 'codex', broken)).toBe('unknown')
    expect(sourceFor({ ...relayConfig(), configurationOwnership: 'manual' }, 'codex', null)).toBe('manual')
    expect(sourceFor({ ...relayConfig(), configurationOwnership: 'account' }, 'codex', broken)).toBe('account')
    expect(connectionReady(relayConfig(), 'codex', broken)).toBe(true)
  })

  it.each(['claude', 'codex', 'grok', 'gemini'] as ProviderId[])('recognizes a read-only account match for %s without changing its persisted ownership', (provider) => {
    const config = { ...relayConfig(), configurationOwnership: 'unknown' as const, configurationAccountMatched: true, authType: 'gemini-api-key' }
    expect(sourceFor(config, provider, null)).toBe('account')
    expect(connectionReady(config, provider, null)).toBe(true)
    expect(config.configurationOwnership).toBe('unknown')
    expect(sourceFor({ ...config, configurationAccountMatched: false }, provider, null)).toBe('unknown')
    expect(sourceFor({ ...config, matchesRelay: false }, provider, null)).toBe('unknown')
    expect(sourceFor({ ...config, hasApiKey: false }, provider, null)).not.toBe('account')
    expect(connectionReady({ ...config, model: '' }, provider, null)).toBe(false)
  })

  it('keeps official and manual choices above account matching, including an unknown key with a local manual marker', () => {
    const storage = memoryStorage()
    const matched = { ...relayConfig(), configurationOwnership: 'unknown' as const, configurationAccountMatched: true }
    writeManualSourceMarker(storage, matched.baseUrl, 'codex', true)
    expect(sourceFor(matched, 'codex', storage)).toBe('manual')
    expect(sourceFor({ ...matched, configurationOwnership: 'manual' }, 'codex', null)).toBe('manual')
    expect(sourceFor({ ...matched, configurationOwnership: 'account' }, 'codex', storage)).toBe('account')
    expect(sourceFor({ ...matched, codexAuthMode: 'chatgpt' }, 'codex', storage)).toBe('official')
    expect(sourceFor({ ...matched, authType: 'oauth-personal' }, 'gemini', null)).toBe('official')
    const broken: SourceMarkerStorage = { getItem() { throw new Error('unavailable') }, setItem() {}, removeItem() {} }
    expect(sourceFor(matched, 'codex', broken)).toBe('account')
  })

  it('presents four matched provider configurations as five ready tool rows without writing source markers', () => {
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider,
      { ...relayConfig(), configurationOwnership: 'unknown', configurationAccountMatched: true, ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}) },
    ]))
    const status = { installed: true, version: '1.0.0', path: '/fixture' }
    const snapshot = { config: { providers }, platform: { codexDesktop: { launch: true } },
      system: { clis: { claude: status, codex: status, grok: status, gemini: status }, desktopApps: { codex: { ...status, appVersion: '1.0.0' } } },
    } as ToolboxSnapshot
    const before = structuredClone(snapshot)
    const storage: SourceMarkerStorage = { getItem: () => null, setItem() { throw new Error('must not write') }, removeItem() { throw new Error('must not write') } }
    const rows = presentTools(snapshot, storage)
    expect(rows.map((row) => row.id).sort()).toEqual(['claude', 'codex', 'codexDesktop', 'gemini', 'grok'])
    expect(rows.every((row) => row.source === 'account' && row.configured)).toBe(true)
    expect(snapshot).toEqual(before)
  })

  it('offers a desktop update only when the mirror has a newer package than the official feed alone claims', () => {
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider, relayConfig()]))
    const cli = { installed: true, version: '1.0.0', path: '/fixture', updateAvailable: true, latestVersion: '1.1.0' }
    const desktopRow = (desktop: Record<string, unknown>) => {
      const snapshot = { config: { providers }, platform: { codexDesktop: { launch: true } },
        system: {
          clis: { claude: cli, codex: cli, grok: cli, gemini: cli },
          desktopApps: { codex: { ...cli, appVersion: '1.0.0', ...desktop } },
        },
      } as unknown as ToolboxSnapshot
      return presentTools(snapshot, memoryStorage())
    }

    // 官方清单领先商店和国内镜像: 更新按钮装不到任何包, 所以不出现。
    const storeCurrent = desktopRow({ updateState: 'available', mirrorUpdateAvailable: false, latestVersion: '1.1.0' })
    expect(storeCurrent.find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(false)
    // CLI 走 npm, 不受镜像影响, 仍按原字段显示。
    expect(storeCurrent.find((row) => row.id === 'codex')?.updateAvailable).toBe(true)

    expect(desktopRow({ updateState: 'available', mirrorUpdateAvailable: true, latestVersion: '1.1.0' })
      .find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(true)
    expect(desktopRow({ updateState: 'latest', mirrorUpdateAvailable: false, latestVersion: '1.0.0', updateAvailable: false })
      .find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(false)
    // 探测没有结论时不催更新, 免得按钮同样装不上。
    expect(desktopRow({ updateState: 'available', mirrorUpdateAvailable: null, latestVersion: '1.1.0' })
      .find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(false)
    expect(desktopRow({ updateState: undefined, mirrorUpdateAvailable: true, latestVersion: '1.1.0' })
      .find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(false)
  })

  it('names the three desktop update states the official feed alone cannot distinguish', () => {
    expect(codexDesktopUpdateKind({ updateState: 'latest', mirrorUpdateAvailable: false })).toBe('latest')
    expect(codexDesktopUpdateKind({ updateState: 'available', mirrorUpdateAvailable: true })).toBe('installable')
    expect(codexDesktopUpdateKind({ updateState: 'available', mirrorUpdateAvailable: false })).toBe('store-current')
    expect(codexDesktopUpdateKind({ updateState: 'available', mirrorUpdateAvailable: null })).toBe('unknown')
    expect(codexDesktopUpdateKind({ updateState: 'unknown', mirrorUpdateAvailable: true })).toBe('unknown')
    expect(codexDesktopUpdateKind({ mirrorUpdateAvailable: true })).toBe('unknown')
  })

  it('carries each CLI version advice through and never attaches one to the desktop app', () => {
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider, relayConfig()]))
    const status = { installed: true, version: '2.1.276', path: '/fixture' }
    const advice = { recommendedVersion: '2.1.277', blockedReason: '每次请求都 400', onRecommended: false, pinned: true, rollbackAvailable: true }
    const snapshot = { config: { providers }, platform: { codexDesktop: { launch: true } },
      system: {
        clis: { claude: { ...status, versionAdvice: advice }, codex: status, grok: status, gemini: status },
        desktopApps: { codex: { ...status, appVersion: '1.0.0', versionAdvice: advice } },
      },
    } as unknown as ToolboxSnapshot
    const rows = presentTools(snapshot, memoryStorage())
    expect(rows.find((row) => row.id === 'claude')?.versionAdvice).toEqual(advice)
    expect(rows.find((row) => row.id === 'codex')?.versionAdvice).toBeNull()
    expect(rows.find((row) => row.id === 'codexDesktop')?.versionAdvice).toBeNull()
  })
})

describe('renderer CLI version advice', () => {
  const row = (versionAdvice: ToolPresentation['versionAdvice'], currentVersion: string | null = '2.1.276') => ({
    currentVersion,
    versionAdvice,
    status: { installed: currentVersion !== null, version: currentVersion, path: null, installDirectory: null },
  })

  it('shows only the version when no list applies or the version is already recommended', () => {
    expect(versionSubtitle(row(null))).toBe('2.1.276')
    expect(versionSubtitle(row({ recommendedVersion: '2.1.276', blockedReason: null, onRecommended: true, pinned: true, rollbackAvailable: false }))).toBe('2.1.276')
  })

  it('names the recommended version when the installed one merely differs', () => {
    expect(versionSubtitle(row({ recommendedVersion: '2.1.277', blockedReason: null, onRecommended: false, pinned: true, rollbackAvailable: true })))
      .toBe('2.1.276（推荐 2.1.277）')
  })

  it('stops recommending once the user chose to follow the latest release', () => {
    expect(versionSubtitle(row({ recommendedVersion: '2.1.277', blockedReason: null, onRecommended: false, pinned: false, rollbackAvailable: false })))
      .toBe('2.1.276')
  })

  it('says the installed version is incompatible when the list blocks it', () => {
    expect(versionSubtitle(row({ recommendedVersion: '2.1.277', blockedReason: '每次请求都 400', onRecommended: false, pinned: false, rollbackAvailable: true })))
      .toBe('2.1.276（不兼容，建议回到 2.1.277）')
  })

  it('offers a rollback target only for an installed tool the list can move', () => {
    const advice = { recommendedVersion: '2.1.277', blockedReason: null, onRecommended: false, pinned: true, rollbackAvailable: true }
    expect(rollbackVersion(row(advice) as ToolPresentation)).toBe('2.1.277')
    expect(rollbackVersion(row(advice, null) as ToolPresentation)).toBeNull()
    expect(rollbackVersion(row(null) as ToolPresentation)).toBeNull()
    expect(rollbackVersion(row({ ...advice, rollbackAvailable: false }) as ToolPresentation)).toBeNull()
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  buildProvisioningTargets,
  configureManagedCliKeysForInstalledClis,
  sanitizePreferredModels,
  filterProvisioningTargets,
  managedCliConfigsReadyForDashboard,
  resolveCliProvisioningGate,
  validateProvisionedCliConfigs,
  type ManagedCliProvisioningApi,
} from './account-provisioning'
import { EmptyStatus } from './app-shared'
import { providerIds, type ProviderId, type SystemSnapshot } from './types'

function snapshotWithInstalled(installed: readonly ProviderId[]): SystemSnapshot {
  const snapshot = EmptyStatus()
  for (const id of providerIds) {
    snapshot.clis[id] = { ...snapshot.clis[id], installed: installed.includes(id) }
  }
  return snapshot
}

describe('configureManagedCliKeysForInstalledClis', () => {
  it('does nothing when no CLI is installed', async () => {
    const api: ManagedCliProvisioningApi = { configureManagedCliKeys: vi.fn() }
    await expect(configureManagedCliKeysForInstalledClis([], {}, api)).resolves.toEqual({ configured: [], failed: [] })
    expect(api.configureManagedCliKeys).not.toHaveBeenCalled()
  })

  it('passes only provider metadata across IPC and returns the safe summary', async () => {
    const outcome = { configured: ['claude', 'codex'] as ProviderId[], failed: [] }
    const api: ManagedCliProvisioningApi = {
      configureManagedCliKeys: vi.fn(async () => outcome),
    }
    await expect(configureManagedCliKeysForInstalledClis(
      ['claude', 'codex'],
      { claude: 'claude-op-9' },
      api,
    )).resolves.toBe(outcome)
    expect(api.configureManagedCliKeys).toHaveBeenCalledWith({
      providers: ['claude', 'codex'],
      preferredModels: { claude: 'claude-op-9' },
    })
  })

  it('drops a blank preferred model so switching from ChatGPT does not fail IPC validation', async () => {
    const api: ManagedCliProvisioningApi = {
      configureManagedCliKeys: vi.fn(async () => ({ configured: ['codex'] as ProviderId[], failed: [] })),
    }
    expect(sanitizePreferredModels({ codex: '', claude: '   ', grok: 'grok-4' })).toEqual({ grok: 'grok-4' })
    await configureManagedCliKeysForInstalledClis(['codex'], { codex: '' }, api)
    expect(api.configureManagedCliKeys).toHaveBeenCalledWith({
      providers: ['codex'],
      preferredModels: {},
    })
  })
})

describe('buildProvisioningTargets', () => {
  it('returns installed providers in canonical provider order, not insertion order', () => {
    const snapshot = snapshotWithInstalled(['codex', 'claude'])
    expect(buildProvisioningTargets(snapshot)).toEqual(['claude', 'codex'])
  })

  it('returns an empty array when nothing is installed', () => {
    expect(buildProvisioningTargets(snapshotWithInstalled([]))).toEqual([])
  })

  it('includes every installed provider when all four are installed', () => {
    const snapshot = snapshotWithInstalled(providerIds)
    expect(buildProvisioningTargets(snapshot)).toEqual(providerIds)
  })

  it('does not target providers explicitly switched to official accounts', () => {
    const snapshot = snapshotWithInstalled(['claude', 'codex'])
    expect(buildProvisioningTargets(snapshot, ['codex'])).toEqual(['claude'])
  })
})

describe('validateProvisionedCliConfigs', () => {
  const validProvider = {
    hasApiKey: true,
    matchesRelay: true,
    model: 'model-1',
  }

  it('accepts every installed target only after its durable config reads back ready', () => {
    const config = {
      providers: {
        claude: validProvider,
        codex: validProvider,
      },
    } as unknown as import('./types').AppConfigSummary
    expect(validateProvisionedCliConfigs(['claude', 'codex'], config)).toEqual([])
  })

  it('reports missing key, relay mismatch, and missing model per provider', () => {
    const config = {
      providers: {
        claude: { ...validProvider, hasApiKey: false },
        codex: { ...validProvider, matchesRelay: false },
        gemini: { ...validProvider, model: '' },
      },
    } as unknown as import('./types').AppConfigSummary
    expect(validateProvisionedCliConfigs(['claude', 'codex', 'gemini'], config)).toEqual([
      { provider: 'claude', message: '配置文件未检测到 API Key' },
      { provider: 'codex', message: 'Base URL 未指向当前星芒站点' },
      { provider: 'gemini', message: '默认模型未写入配置' },
    ])
  })

  it('accepts an explicitly official provider without a relay key', () => {
    const config = {
      providers: {
        codex: { ...validProvider, hasApiKey: false, matchesRelay: false, model: '' },
      },
    } as unknown as import('./types').AppConfigSummary
    expect(validateProvisionedCliConfigs(['codex'], config, ['codex'])).toEqual([])
  })

  it('rejects Gemini when its persisted auth selector is still OAuth', () => {
    const config = {
      providers: {
        gemini: { ...validProvider, authType: 'oauth-personal' },
      },
    } as unknown as import('./types').AppConfigSummary
    expect(validateProvisionedCliConfigs(['gemini'], config)).toEqual([{
      provider: 'gemini',
      message: 'Gemini 未切换到 API Key 模式',
    }])
  })
})

describe('managedCliConfigsReadyForDashboard', () => {
  function configWithReadyProviders(ready: readonly ProviderId[]) {
    return {
      providers: Object.fromEntries(providerIds.map((provider) => [provider, {
        hasApiKey: ready.includes(provider),
        matchesRelay: ready.includes(provider),
        model: ready.includes(provider) ? 'model-1' : '',
      }])),
    } as unknown as import('./types').AppConfigSummary
  }

  it('accepts a completed machine only when every currently installed CLI still reads back ready', () => {
    const snapshot = snapshotWithInstalled(['claude', 'codex'])
    expect(managedCliConfigsReadyForDashboard(
      snapshot,
      configWithReadyProviders(['claude', 'codex']),
    )).toBe(true)
  })

  it('invalidates an old checkpoint when a newly installed CLI has not been configured', () => {
    const snapshot = snapshotWithInstalled(['claude', 'codex', 'gemini'])
    expect(managedCliConfigsReadyForDashboard(
      snapshot,
      configWithReadyProviders(['claude', 'codex']),
    )).toBe(false)
  })

  it('ignores stale config entries for CLIs that are no longer installed', () => {
    const snapshot = snapshotWithInstalled(['codex'])
    expect(managedCliConfigsReadyForDashboard(
      snapshot,
      configWithReadyProviders(['codex']),
    )).toBe(true)
  })
})

describe('resolveCliProvisioningGate', () => {
  it('requires login before anything else, even when CLIs are installed', () => {
    const snapshot = snapshotWithInstalled(['codex'])
    expect(resolveCliProvisioningGate(false, snapshot)).toBe('requires-login')
  })

  it('requires an install when signed in but nothing is installed yet', () => {
    expect(resolveCliProvisioningGate(true, snapshotWithInstalled([]))).toBe('requires-install')
  })

  it('is ready once signed in with at least one installed CLI', () => {
    const snapshot = snapshotWithInstalled(['claude'])
    expect(resolveCliProvisioningGate(true, snapshot)).toBe('ready')
  })

  it('prioritizes the login requirement over the install requirement', () => {
    expect(resolveCliProvisioningGate(false, snapshotWithInstalled([]))).toBe('requires-login')
  })
})

describe('filterProvisioningTargets', () => {
  it('keeps only the selected providers, preserving target order', () => {
    const targets: ProviderId[] = ['claude', 'codex', 'grok', 'gemini']
    const selected = new Set<ProviderId>(['gemini', 'claude'])
    expect(filterProvisioningTargets(targets, selected)).toEqual(['claude', 'gemini'])
  })

  it('returns every target when everything stays checked (default-all-checked path)', () => {
    const targets: ProviderId[] = ['claude', 'codex', 'grok']
    expect(filterProvisioningTargets(targets, new Set(targets))).toEqual(targets)
  })

  it('excludes a single unchecked provider -- e.g. the user unticking Grok', () => {
    const targets: ProviderId[] = ['claude', 'codex', 'grok', 'gemini']
    const selected = new Set<ProviderId>(['claude', 'codex', 'gemini'])
    expect(filterProvisioningTargets(targets, selected)).toEqual(['claude', 'codex', 'gemini'])
  })

  it('drops a selected id that is no longer in targets instead of writing it', () => {
    const targets: ProviderId[] = ['claude', 'codex']
    const selected = new Set<ProviderId>(['claude', 'grok'])
    expect(filterProvisioningTargets(targets, selected)).toEqual(['claude'])
  })

  it('returns an empty array when nothing is selected', () => {
    expect(filterProvisioningTargets(['claude', 'codex'], new Set())).toEqual([])
  })
})

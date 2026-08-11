import { describe, expect, it, vi } from 'vitest'
import {
  buildProvisioningTargets,
  configureManagedCliKeysForInstalledClis,
  filterProvisioningTargets,
  resolveCliProvisioningGate,
  writeCliKeyForInstalledClis,
  type CliKeyWriteApi,
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
})

// Manual-key sites still use the renderer path because the user explicitly
// enters the key there. Account-managed keys use the main-process path above.
describe('writeCliKeyForInstalledClis', () => {
  function fakeWriteApi(overrides: Partial<CliKeyWriteApi> = {}): CliKeyWriteApi {
    return {
      listModels: vi.fn(async () => ['gpt-5.6-sol', 'claude-op-9']),
      saveConfig: vi.fn(async () => ({ backups: [], files: [] })),
      ...overrides,
    }
  }

  it('does nothing when no CLI is installed, without validating the key at all', async () => {
    const api = fakeWriteApi()

    const outcome = await writeCliKeyForInstalledClis('sk-pasted-plaintext-key', [], {}, api)

    expect(outcome).toEqual({ configured: [], failed: [] })
    expect(api.listModels).not.toHaveBeenCalled()
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('writes the supplied key into every selected CLI, never minting one', async () => {
    const api = fakeWriteApi()

    const outcome = await writeCliKeyForInstalledClis('sk-pasted-plaintext-key', ['claude', 'grok'], {}, api)

    expect(outcome).toEqual({ configured: ['claude', 'grok'], failed: [] })
    expect(api.listModels).toHaveBeenCalledWith('sk-pasted-plaintext-key')
    for (const call of vi.mocked(api.saveConfig).mock.calls) {
      expect(call[0].apiKey).toBe('sk-pasted-plaintext-key')
    }
  })

  it('marks every target failed, without calling saveConfig, when the pasted key fails validation', async () => {
    const api = fakeWriteApi({ listModels: vi.fn(async () => { throw new Error('Key 无效或已过期') }) })

    const outcome = await writeCliKeyForInstalledClis('sk-bad-key', ['claude'], {}, api)

    expect(outcome).toEqual({ configured: [], failed: [{ provider: 'claude', message: 'Key 无效或已过期' }] })
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('never includes the supplied key anywhere in the returned outcome (I3)', async () => {
    const api = fakeWriteApi()

    const outcome = await writeCliKeyForInstalledClis('sk-pasted-plaintext-key', ['claude'], {}, api)

    expect(JSON.stringify(outcome)).not.toContain('sk-pasted-plaintext-key')
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

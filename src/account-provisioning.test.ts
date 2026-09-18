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

  // 主进程只对 intent === 'explicit' 的写入放行「来源未记录」的旧配置
  // （system-service.ts 的 ownership 守卫）。legacy 界面曾经一处都不发 intent，
  // 于是所有老用户点任何「配置星芒 Key」入口都只会拿到那句拒写文案。
  it('omits the intent for a background write so the ownership guard still applies', async () => {
    const api: ManagedCliProvisioningApi = {
      configureManagedCliKeys: vi.fn(async () => ({ configured: ['claude'] as ProviderId[], failed: [] })),
    }
    await configureManagedCliKeysForInstalledClis(['claude'], { claude: 'claude-op-9' }, api)
    expect(api.configureManagedCliKeys).toHaveBeenCalledWith({
      providers: ['claude'],
      preferredModels: { claude: 'claude-op-9' },
    })
  })

  it('marks a user-confirmed write explicit, one provider per call as ipc.ts requires', async () => {
    const calls: Array<{ providers: ProviderId[]; intent?: string }> = []
    const api: ManagedCliProvisioningApi = {
      configureManagedCliKeys: vi.fn(async (input) => {
        calls.push({ providers: input.providers, intent: input.intent })
        return { configured: [...input.providers], failed: [] }
      }),
    }
    await expect(configureManagedCliKeysForInstalledClis(
      ['claude', 'codex', 'grok'],
      { claude: 'claude-op-9', grok: 'grok-4' },
      api,
      'explicit',
    )).resolves.toEqual({ configured: ['claude', 'codex', 'grok'], failed: [] })
    expect(calls).toEqual([
      { providers: ['claude'], intent: 'explicit' },
      { providers: ['codex'], intent: 'explicit' },
      { providers: ['grok'], intent: 'explicit' },
    ])
    // ipc.ts 对 explicit 要求 providers.length === 1，多带一个就是整批被拒。
    expect(calls.every((call) => call.providers.length === 1)).toBe(true)
  })

  it('sends only the provider own preferred model on an explicit write', async () => {
    const api: ManagedCliProvisioningApi = {
      configureManagedCliKeys: vi.fn(async (input) => ({ configured: [...input.providers], failed: [] })),
    }
    await configureManagedCliKeysForInstalledClis(['codex'], { codex: '  gpt-5  ', claude: 'claude-op-9' }, api, 'explicit')
    expect(api.configureManagedCliKeys).toHaveBeenCalledWith({
      providers: ['codex'],
      preferredModels: { codex: 'gpt-5' },
      intent: 'explicit',
    })
  })

  it('keeps writing the remaining confirmed tools after one of them fails', async () => {
    const api: ManagedCliProvisioningApi = {
      configureManagedCliKeys: vi.fn(async (input) => {
        if (input.providers[0] === 'codex') throw new Error('Codex 配置文件被占用')
        if (input.providers[0] === 'gemini') return { configured: [], failed: [{ provider: 'gemini' as ProviderId, message: '模型不可用' }] }
        return { configured: [...input.providers], failed: [] }
      }),
    }
    await expect(configureManagedCliKeysForInstalledClis(
      ['codex', 'claude', 'gemini'],
      {},
      api,
      'explicit',
    )).resolves.toEqual({
      configured: ['claude'],
      failed: [
        { provider: 'codex', message: 'Codex 配置文件被占用' },
        { provider: 'gemini', message: '模型不可用' },
      ],
    })
    expect(api.configureManagedCliKeys).toHaveBeenCalledTimes(3)
  })

  it('reports a provider the main process neither configured nor failed instead of counting it configured', async () => {
    const api: ManagedCliProvisioningApi = {
      configureManagedCliKeys: vi.fn(async () => ({ configured: [], failed: [] })),
    }
    await expect(configureManagedCliKeysForInstalledClis(['grok'], {}, api, 'explicit')).resolves.toEqual({
      configured: [],
      failed: [{ provider: 'grok', message: '没有收到配置完成结果，请重新检测' }],
    })
  })

  it('does not write the same tool twice when the confirmed list repeats it', async () => {
    const api: ManagedCliProvisioningApi = {
      configureManagedCliKeys: vi.fn(async (input) => ({ configured: [...input.providers], failed: [] })),
    }
    await expect(configureManagedCliKeysForInstalledClis(['claude', 'claude'], {}, api, 'explicit'))
      .resolves.toEqual({ configured: ['claude'], failed: [] })
    expect(api.configureManagedCliKeys).toHaveBeenCalledTimes(1)
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
      { provider: 'codex', message: 'Base URL 未指向当前账号的服务地址' },
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

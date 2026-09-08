import { describe, expect, it } from 'vitest'
import type { ProviderConfigSummary } from '../../../../electron/ipc-contract'
import { canUninstallTool, connectionReady, providerFor, sourceFor } from './model'
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
    expect(sourceFor(config, 'codex', storage)).toBe('account')

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
})

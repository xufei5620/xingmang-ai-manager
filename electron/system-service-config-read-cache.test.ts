import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { providerIds, type ProviderId } from './catalog'
import { inspectProviderConfig, providerConfigPaths, saveProviderConfig } from './config-files'
import { relayProviderBaseUrls } from './relay-sites'
import { createSystemService, type SystemServiceOptions } from './system-service'
import { ToolConfigOwnershipStore } from './tool-config-ownership'
import { createToolRouteFollowStore } from './tool-route-follow-state'

const primary = relayProviderBaseUrls('solov', 'primary')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-read-cache-service-'))
  temporaryDirectories.push(root)
  const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'home', '.codex') }
  fs.mkdirSync(roots.userHome)
  const service = createSystemService(new AppSettingsStore(path.join(root, 'settings.json'), root), {
    providerRoots: roots,
    managerDataDirectory: root,
    configReadCacheMs: 60_000,
    ...options,
  })
  return { root, roots, service }
}

describe('config:get disk reads', () => {
  it('reuses the disk reads of the last summary within the window', () => {
    const inspect = vi.fn(inspectProviderConfig)
    const { service } = fixture({ inspectProviderConfig: inspect })
    service.getConfig(false)
    service.getConfig(false)
    expect(inspect).toHaveBeenCalledTimes(providerIds.length)
  })

  it('still reads every time when no window is configured', () => {
    const inspect = vi.fn(inspectProviderConfig)
    const { service } = fixture({ inspectProviderConfig: inspect, configReadCacheMs: undefined })
    service.getConfig(false)
    service.getConfig(false)
    expect(inspect).toHaveBeenCalledTimes(providerIds.length * 2)
  })

  it('reads again after Xingmang writes a tool config', () => {
    const { roots, service } = fixture()
    saveProviderConfig('codex', 'sk-first', 'model-a', 'reset', roots, {}, primary)
    expect(service.getConfig(false).providers.codex.model).toBe('model-a')
    saveProviderConfig('codex', 'sk-first', 'model-b', 'reset', roots, {}, primary)
    expect(service.getConfig(false).providers.codex.model).toBe('model-b')
  })

  it('reads again when a config file was changed outside Xingmang', () => {
    const { roots, service } = fixture()
    saveProviderConfig('codex', 'sk-first', 'model-a', 'reset', roots, {}, primary)
    expect(service.getConfig(false).providers.codex.model).toBe('model-a')
    const configPath = providerConfigPaths('codex', roots)[0]
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('model = "model-a"', 'model = "model-edited-by-hand"'))
    expect(service.getConfig(false).providers.codex.model).toBe('model-edited-by-hand')
  })

  it('reads again when a tool signs in by writing a new file into its folder', () => {
    const { roots, service } = fixture()
    expect(service.getConfig(false).providers.grok.grokLoginMode).toBeNull()
    const grokRoot = path.dirname(providerConfigPaths('grok', roots)[0])
    fs.mkdirSync(grokRoot, { recursive: true })
    expect(service.getConfig(false).providers.grok.grokLoginMode).toBeNull()
    fs.writeFileSync(path.join(grokRoot, 'auth.json'), JSON.stringify({ 'https://accounts.x.ai': { auth_mode: 'oauth', email: 'member@example.com' } }))
    expect(service.getConfig(false).providers.grok.grokLoginMode).toBe('oauth')
  })

  it('reads again after the ownership record is written', async () => {
    const { root, roots, service } = fixture()
    saveProviderConfig('codex', 'sk-first', 'model-a', 'reset', roots, {}, primary)
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
    await new ToolConfigOwnershipStore(path.join(root, 'tool-config-ownership'))
      .write('codex', inspectProviderConfig('codex', roots, primary), 'manual')
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('manual')
  })

  it('reads again after the route follow record is written', async () => {
    const { root, roots, service } = fixture()
    saveProviderConfig('codex', 'sk-first', 'model-a', 'reset', roots, {}, primary)
    expect(service.getConfig(false).providers.codex.relayRouteState).toBeUndefined()
    await createToolRouteFollowStore(path.join(root, 'tool-route-follow'))
      .write({ version: 1, providers: { codex: { managedElsewhere: true } } })
    expect(service.getConfig(false).providers.codex.relayRouteState).toBe('managed-elsewhere')
  })

  it('reads again for another account or another site', async () => {
    const account = { current: JSON.stringify(['solov', 9]) }
    const site = { current: 'solov' as 'solov' | 'solov-api' }
    const { root, roots, service } = fixture({
      getExternalClientAccountId: () => account.current,
      getRelaySiteId: () => site.current,
    })
    saveProviderConfig('codex', 'sk-first', 'model-a', 'reset', roots, {}, primary)
    await new ToolConfigOwnershipStore(path.join(root, 'tool-config-ownership'))
      .write('codex', inspectProviderConfig('codex', roots, primary), 'account', account.current, 2)
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
    account.current = JSON.stringify(['solov', 10])
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
    account.current = JSON.stringify(['solov', 9])
    expect(service.getConfig(false).providers.codex.matchesRelay).toBe(true)
    site.current = 'solov-api'
    expect(service.getConfig(false).providers.codex.matchesRelay).toBe(false)
  })

  it('keeps the parts that are not read from disk current', () => {
    const { roots, service } = fixture({ getExternalClientAccountId: () => JSON.stringify(['solov', 9]) })
    saveProviderConfig('claude', 'sk-claude', 'claude-model', 'reset', roots, {}, primary)
    const provider: ProviderId = 'claude'
    expect(service.getConfig(false).providers.claude.configurationAccountMatched).toBe(false)
    const matched = service.getConfig(false, [{ id: 1, provider, group: 'default', name: 'claude', key: 'sk-claude' }])
    expect(matched.providers.claude.configurationAccountMatched).toBe(true)
  })
})

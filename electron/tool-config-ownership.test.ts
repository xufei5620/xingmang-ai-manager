import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { providerBaseUrls, providerIds } from './catalog'
import { codexConfigSnapshotPaths, inspectProviderConfig, providerConfigPaths, relayTemplateRevision, saveProviderConfig } from './config-files'
import { createSystemService, planRestoredConfigOwnership } from './system-service'
import { ToolConfigOwnershipStore } from './tool-config-ownership'

const directories: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-ownership-'))
  directories.push(root)
  const roots = { userHome: root, codexHome: path.join(root, '.codex') }
  const data = path.join(root, 'manager')
  let owner: string | null = JSON.stringify(['solov', 36])
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 }))
  const makeService = () => createSystemService(new AppSettingsStore(path.join(data, 'settings.json'), root), {
    providerRoots: roots, managerDataDirectory: data, relayFetch: fetch,
    getExternalClientAccountId: () => owner,
    // 真去查进程在 Windows CI 上会因为找不到 npm 落到「看不出开没开」，补缺省项那条路就一律跳过。
    inspectRunningToolsForTemplateFill: async () => ({ running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false }),
  })
  const payload = { provider: 'codex' as const, apiKey: 'sk-fixture-user-secret', model: 'fixture-model', mode: 'merge' as const }
  const ownership = new ToolConfigOwnershipStore(path.join(data, 'tool-config-ownership'))
  const current = () => inspectProviderConfig('codex', roots)
  const setOwner = (next: string | null) => { owner = next }
  const ownerFile = () => {
    const directory = path.join(data, 'tool-config-ownership')
    return path.join(directory, fs.readdirSync(directory)[0])
  }
  return { root, roots, data, fetch, makeService, payload, ownership, current, setOwner, ownerFile }
}

afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

describe('durable tool configuration ownership', () => {
  it('protects an externally configured same-site key before any model request', async () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const service = f.makeService()
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
    await expect(service.saveConfig({ ...f.payload, apiKey: 'sk-account-replacement' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.current().apiKey).toBe(f.payload.apiKey)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('persists manual ownership across restarts without storing the plaintext key', async () => {
    const f = fixture()
    await f.makeService().saveConfig(f.payload, false)
    expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('manual')
    const ownerDirectory = path.join(f.data, 'tool-config-ownership')
    const saved = fs.readFileSync(path.join(ownerDirectory, fs.readdirSync(ownerDirectory)[0]), 'utf8')
    expect(saved).not.toContain(f.payload.apiKey)
    await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-managed-key' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.current().apiKey).toBe(f.payload.apiKey)
  })

  it('allows explicit account selection, then permits automatic managed rotation', async () => {
    const f = fixture()
    await f.makeService().saveConfig(f.payload, false)
    const selected = { ...f.payload, apiKey: 'sk-selected-account-key' }
    await f.makeService().saveConfig(selected, false, undefined, { source: 'account', automatic: false })
    expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('account')
    expect(JSON.parse(fs.readFileSync(f.ownerFile(), 'utf8'))).toMatchObject({ version: 2, source: 'account', owner: JSON.stringify(['solov', 36]) })
    await f.makeService().saveConfig({ ...selected, apiKey: 'sk-account-rotated' }, false, undefined, { source: 'account', automatic: true })
    expect(f.current().apiKey).toBe('sk-account-rotated')
  })

  it.each([
    ['another account on the same site', JSON.stringify(['solov', 37])],
    ['the same numeric account on another site', JSON.stringify(['solov-api', 36])],
    ['a signed-out session', null],
  ] as const)('does not grant account ownership to %s', async (_label, owner) => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    f.fetch.mockClear()
    f.setOwner(owner)
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
    await expect(service.saveConfig({ ...f.payload, apiKey: 'sk-another-account' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow()
    expect(f.current().apiKey).toBe(f.payload.apiKey)
    expect(f.fetch).not.toHaveBeenCalled()
    f.setOwner(JSON.stringify(['solov', 36]))
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
  })

  it.each(['account', 'manual'] as const)('retains only the safe meaning of a legacy %s record', async (source) => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, source === 'account' ? { source, automatic: false } : undefined)
    const record = JSON.parse(fs.readFileSync(f.ownerFile(), 'utf8'))
    delete record.owner
    record.version = 1
    fs.writeFileSync(f.ownerFile(), JSON.stringify(record), 'utf8')
    const original = fs.readFileSync(f.ownerFile(), 'utf8')
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe(source === 'manual' ? 'manual' : 'unknown')
    expect(fs.readFileSync(f.ownerFile(), 'utf8')).toBe(original)
    await expect(service.saveConfig({ ...f.payload, apiKey: 'sk-automatic' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.current().apiKey).toBe(f.payload.apiKey)
  })

  it('recognizes all matching current-account keys without creating write consent', async () => {
    const f = fixture()
    const cachedKeys = providerIds.map((provider, index) => ({
      id: index + 1, provider, group: 'fixture', name: `Fixture ${provider}`, key: `sk-fixture-${provider}-secret`,
    }))
    for (const entry of cachedKeys) saveProviderConfig(entry.provider, entry.key, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const service = f.makeService()
    for (const provider of providerIds) {
      expect(service.getConfig(false, cachedKeys).providers[provider]).toMatchObject({
        configurationOwnership: 'unknown', configurationAccountMatched: true,
      })
      expect(service.getConfig(false).providers[provider].configurationAccountMatched).toBe(false)
    }
    expect(service.getConfig(true, cachedKeys).providers.codex.configurationAccountMatched).toBe(false)
    expect(fs.existsSync(path.join(f.data, 'tool-config-ownership'))).toBe(false)
    expect(JSON.stringify(service.getConfig(false, cachedKeys))).not.toContain(cachedKeys[0].key)
    await expect(service.saveConfig({ ...f.payload, apiKey: 'sk-automatic' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('requires an exact key, provider, relay, and active owner for display matching', () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const service = f.makeService()
    const cached = { id: 1, provider: 'codex' as const, group: 'fixture', name: 'Fixture', key: f.payload.apiKey }
    expect(service.getConfig(false, [cached]).providers.codex.configurationAccountMatched).toBe(true)
    expect(service.getConfig(false, [{ ...cached, key: `${cached.key}-different` }]).providers.codex.configurationAccountMatched).toBe(false)
    expect(service.getConfig(false, [{ ...cached, provider: 'claude' }]).providers.codex.configurationAccountMatched).toBe(false)
    f.setOwner(null)
    expect(service.getConfig(false, [cached]).providers.codex.configurationAccountMatched).toBe(false)
    f.setOwner(JSON.stringify(['solov', 36]))
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, { ...providerBaseUrls, codex: 'https://other.example/v1' })
    expect(service.getConfig(false, [cached]).providers.codex.configurationAccountMatched).toBe(false)
  })

  it('preserves manual protection even when the key belongs to the current account', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false)
    const cached = { id: 1, provider: 'codex' as const, group: 'fixture', name: 'Fixture', key: f.payload.apiKey }
    expect(service.getConfig(false, [cached]).providers.codex).toMatchObject({ configurationOwnership: 'manual', configurationAccountMatched: true })
    await expect(service.saveConfig({ ...f.payload, apiKey: 'sk-automatic' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.current().apiKey).toBe(f.payload.apiKey)
  })

  it('preserves an unmarked current-account key and its write protection when only its model changes', async () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const cached = { id: 1, provider: 'codex' as const, group: 'fixture', name: 'Fixture', key: f.payload.apiKey }
    f.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'another-model' }] }), { status: 200 }))
    await f.makeService().saveConfig({ ...f.payload, apiKey: '', model: 'another-model' }, false)
    expect(f.current().apiKey).toBe(f.payload.apiKey)
    expect(f.current().model).toBe('another-model')
    expect(f.makeService().getConfig(false, [cached]).providers.codex).toMatchObject({
      configurationOwnership: 'unknown', configurationAccountMatched: true,
    })
    expect(JSON.parse(fs.readFileSync(f.ownerFile(), 'utf8')).source).toBe('unknown')
    f.fetch.mockClear()
    await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-automatic' }, false, undefined,
      { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  describe('reporting a configuration the app wrote and someone else edited', () => {
    it('reports an externally replaced key as changed', async () => {
      const f = fixture()
      await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('account')
      saveProviderConfig('codex', 'sk-someone-else-edited', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('changed')
    })

    it('reports a removed base URL as changed while the key is still present', async () => {
      const f = fixture()
      await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
      const configPath = providerConfigPaths('codex', f.roots)[0]
      fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8')
        .split('\n').filter((line) => !line.includes('base_url')).join('\n'), 'utf8')
      expect(f.current().hasApiKey).toBe(true)
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('changed')
    })

    it('ignores keys the app never writes', async () => {
      const f = fixture()
      await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
      const configPath = providerConfigPaths('codex', f.roots)[0]
      fs.appendFileSync(configPath, '\nhide_agent_reasoning = true\n', 'utf8')
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('account')
    })

    it('does not attribute an edited configuration to another account', async () => {
      const f = fixture()
      await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
      saveProviderConfig('codex', 'sk-someone-else-edited', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
      f.setOwner(JSON.stringify(['solov', 37]))
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
      f.setOwner(null)
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
    })

    it('still refuses an automatic takeover of a changed configuration', async () => {
      const f = fixture()
      await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
      saveProviderConfig('codex', 'sk-someone-else-edited', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
      f.fetch.mockClear()
      await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-replacement' }, false, undefined,
        { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
      expect(f.current().apiKey).toBe('sk-someone-else-edited')
      expect(f.fetch).not.toHaveBeenCalled()
    })

    it('lets an explicit account write take a changed configuration back', async () => {
      const f = fixture()
      await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
      saveProviderConfig('codex', 'sk-someone-else-edited', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
      await f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-account-rewritten' }, false, undefined,
        { source: 'account', automatic: false })
      expect(f.current().apiKey).toBe('sk-account-rewritten')
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('account')
    })

    it('leaves a manual record unattributed after an edit', async () => {
      const f = fixture()
      await f.makeService().saveConfig(f.payload, false)
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('manual')
      saveProviderConfig('codex', 'sk-someone-else-edited', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
      expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
    })
  })

  it('rejects account consent without an authenticated owner', async () => {
    const f = fixture()
    f.setOwner(null)
    await expect(f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })).rejects.toThrow('请先登录')
    await expect(f.ownership.write('codex', f.current(), 'account')).rejects.toThrow('请先登录')
    expect(f.current().hasApiKey).toBe(false)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('stops an account save if the owner changes during model detection', async () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    f.fetch.mockImplementation(async () => {
      f.setOwner(JSON.stringify(['solov', 37]))
      return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 })
    })
    await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-selected' }, false, undefined, { source: 'account', automatic: false })).rejects.toThrow('账号已变化')
    expect(f.current().apiKey).toBe(f.payload.apiKey)
    expect(fs.existsSync(path.join(f.data, 'tool-config-ownership'))).toBe(false)
  })

  it('rechecks the owner after the protective provenance write', async () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const write = ToolConfigOwnershipStore.prototype.write
    vi.spyOn(ToolConfigOwnershipStore.prototype, 'write').mockImplementation(async function (this: ToolConfigOwnershipStore, ...args) {
      await write.apply(this, args)
      f.setOwner(JSON.stringify(['solov', 37]))
    })
    await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-selected' }, false, undefined, { source: 'account', automatic: false })).rejects.toThrow('账号已变化')
    expect(f.current().apiKey).toBe(f.payload.apiKey)
    expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('manual')
  })

  it.each(['missing', 'corrupt', 'changed-key', 'different-path'] as const)('refuses automatic takeover when ownership is %s', async (scenario) => {
    const f = fixture()
    await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    const ownerDirectory = path.join(f.data, 'tool-config-ownership')
    const file = path.join(ownerDirectory, fs.readdirSync(ownerDirectory)[0])
    if (scenario === 'missing') fs.unlinkSync(file)
    if (scenario === 'corrupt') fs.writeFileSync(file, '{broken', 'utf8')
    if (scenario === 'changed-key') saveProviderConfig('codex', 'sk-external-key', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    if (scenario === 'different-path') {
      const different = { ...f.current(), files: f.current().files.map(entry => ({ ...entry, path: `${entry.path}-moved` })) }
      expect(f.ownership.read('codex', different)).toBe('unknown')
      return
    }
    const before = f.current().apiKey
    await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-replacement' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.current().apiKey).toBe(before)
  })

  it('rechecks native files after awaiting model detection', async () => {
    const f = fixture()
    await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    f.fetch.mockImplementation(async () => {
      saveProviderConfig('codex', 'sk-external-during-fetch', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
      return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 })
    })
    await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-replacement' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('发生变化')
    expect(f.current().apiKey).toBe('sk-external-during-fetch')
  })

  it('serializes a manual save ahead of automatic writes so the manual choice wins', async () => {
    const f = fixture()
    const service = f.makeService()
    const manual = service.saveConfig(f.payload, false)
    const automatic = service.saveConfig({ ...f.payload, apiKey: 'sk-automatic' }, false, undefined, { source: 'account', automatic: true })
    await expect(manual).resolves.toHaveProperty('files')
    await expect(automatic).rejects.toThrow('来源未经确认')
    expect(f.current().apiKey).toBe(f.payload.apiKey)
  })

  it('keeps the existing config intact when provenance cannot be saved', async () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    fs.mkdirSync(f.data, { recursive: true })
    fs.writeFileSync(path.join(f.data, 'tool-config-ownership'), 'blocked', 'utf8')
    const authPath = providerConfigPaths('codex', f.roots)[1]
    const original = fs.readFileSync(authPath, 'utf8')
    await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-replacement' }, false)).rejects.toThrow()
    expect(fs.readFileSync(authPath, 'utf8')).toBe(original)
  })

  it('stops a restored backup from reading as changed and keeps it away from automatic writes', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    // A restore copies back a config holding a key the account never issued.
    saveProviderConfig('codex', 'sk-restored-from-backup', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('changed')

    await service.adoptRestoredConfig('codex', () => false)
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('manual')
    f.fetch.mockClear()
    await expect(service.saveConfig({ ...f.payload, apiKey: 'sk-automatic' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.current().apiKey).toBe('sk-restored-from-backup')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('records a restored current-account key as account-owned for that account only', async () => {
    const f = fixture()
    const service = f.makeService()
    saveProviderConfig('codex', 'sk-current-account-key', f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const seen: string[] = []
    await service.adoptRestoredConfig('codex', (key) => { seen.push(key); return key === 'sk-current-account-key' })
    expect(seen).toEqual(['sk-current-account-key'])
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
    expect(fs.readFileSync(f.ownerFile(), 'utf8')).not.toContain('sk-current-account-key')
    f.setOwner(JSON.stringify(['solov', 37]))
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
  })

  it('leaves no record behind when the restored config has no key', async () => {
    const f = fixture()
    await f.makeService().adoptRestoredConfig('codex', () => true)
    expect(fs.existsSync(path.join(f.data, 'tool-config-ownership'))).toBe(false)
  })
})

describe('planRestoredConfigOwnership', () => {
  const base = { current: 'changed' as const, hasApiKey: true, matchesRelay: true, owner: '["solov",36]', isAccountKey: true }

  it('adopts a current-account key as account-owned', () => {
    expect(planRestoredConfigOwnership(base)).toBe('account')
  })

  it.each([
    ['a key the account did not issue', { isAccountKey: false }],
    ['a signed-out session', { owner: null }],
    ['a key pointing at another endpoint', { matchesRelay: false }],
  ] as const)('falls back to manual for %s', (_label, patch) => {
    expect(planRestoredConfigOwnership({ ...base, ...patch })).toBe('manual')
  })

  it.each(['account', 'manual'] as const)('keeps an already matching %s record', (current) => {
    expect(planRestoredConfigOwnership({ ...base, current })).toBeNull()
  })

  it('writes nothing when the restored config holds no key', () => {
    expect(planRestoredConfigOwnership({ ...base, hasApiKey: false })).toBeNull()
  })
})

describe('filling template defaults into older account configs at startup', () => {
  function makeOlder(f: ReturnType<typeof fixture>) {
    const record = JSON.parse(fs.readFileSync(f.ownerFile(), 'utf8'))
    delete record.templateRevision
    fs.writeFileSync(f.ownerFile(), JSON.stringify(record), 'utf8')
    const configPath = codexConfigSnapshotPaths(f.roots).active
    const text = fs.readFileSync(configPath, 'utf8').replace('check_for_update_on_startup = false\n', '')
    fs.writeFileSync(configPath, text, 'utf8')
    return configPath
  }

  it('records the template revision whenever a full config is saved', async () => {
    const f = fixture()
    await f.makeService().saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    expect(JSON.parse(fs.readFileSync(f.ownerFile(), 'utf8')).templateRevision).toBe(relayTemplateRevision)
    expect(f.ownership.templateRevision('codex', f.current())).toBe(relayTemplateRevision)
  })

  it('fills an older current-account config once, after a backup, and keeps it owned by the account', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    const configPath = makeOlder(f)
    expect(f.ownership.templateRevision('codex', f.current())).toBe(0)
    const backups: string[] = []

    const result = await service.fillToolTemplateDefaults!((provider) => { backups.push(provider) })

    expect(result.filled).toEqual(['codex'])
    expect(backups).toEqual(['codex'])
    expect(fs.readFileSync(configPath, 'utf8')).toContain('check_for_update_on_startup = false')
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
    expect(f.ownership.templateRevision('codex', f.current())).toBe(relayTemplateRevision)
    expect(await service.fillToolTemplateDefaults!(() => { backups.push('again') })).toEqual({ filled: [] })
    expect(backups).toEqual(['codex'])
  })

  it('only moves the revision forward when an older record already has every key', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    const record = JSON.parse(fs.readFileSync(f.ownerFile(), 'utf8'))
    delete record.templateRevision
    fs.writeFileSync(f.ownerFile(), JSON.stringify(record), 'utf8')
    const before = fs.readFileSync(codexConfigSnapshotPaths(f.roots).active, 'utf8')
    const backups: string[] = []

    expect(await service.fillToolTemplateDefaults!((provider) => { backups.push(provider) })).toEqual({ filled: [] })

    expect(backups).toEqual([])
    expect(fs.readFileSync(codexConfigSnapshotPaths(f.roots).active, 'utf8')).toBe(before)
    expect(f.ownership.templateRevision('codex', f.current())).toBe(relayTemplateRevision)
  })

  it.each([
    ['manually entered', async (f: ReturnType<typeof fixture>) => { await f.makeService().saveConfig(f.payload, false) }],
    ['unconfirmed', async (f: ReturnType<typeof fixture>) => { saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls) }],
  ] as const)('never touches a %s config', async (_label, setup) => {
    const f = fixture()
    await setup(f)
    const configPath = codexConfigSnapshotPaths(f.roots).active
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('check_for_update_on_startup = false\n', ''), 'utf8')
    const before = fs.readFileSync(configPath, 'utf8')

    expect(await f.makeService().fillToolTemplateDefaults!(() => undefined)).toEqual({ filled: [] })
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('does not fill anything while signed out', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    const configPath = makeOlder(f)
    const before = fs.readFileSync(configPath, 'utf8')
    f.setOwner(null)
    expect(await service.fillToolTemplateDefaults!(() => undefined)).toEqual({ filled: [] })
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('leaves the revision behind when the backup fails so the next start tries again', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    const configPath = makeOlder(f)
    const before = fs.readFileSync(configPath, 'utf8')

    expect(await service.fillToolTemplateDefaults!(() => { throw new Error('备份失败') })).toEqual({ filled: [] })

    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
    expect(f.ownership.templateRevision('codex', f.current())).toBe(0)
  })
})

describe('filling template defaults while a tool may be running', () => {
  it.each([
    ['running', { running: ['codex' as const], unknown: [], codexDesktopRunning: false }],
    ['undetectable', { running: [], unknown: ['codex' as const], codexDesktopRunning: false }],
    ['open as the desktop app', { running: [], unknown: [], codexDesktopRunning: true }],
    ['possibly open as the desktop app', { running: [], unknown: [], codexDesktopRunning: null }],
  ])('leaves a %s tool for the next start', async (_label, report) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-ownership-'))
    directories.push(root)
    const roots = { userHome: root, codexHome: path.join(root, '.codex') }
    const data = path.join(root, 'manager')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 }))
    const service = createSystemService(new AppSettingsStore(path.join(data, 'settings.json'), root), {
      providerRoots: roots, managerDataDirectory: data, relayFetch: fetch,
      getExternalClientAccountId: () => JSON.stringify(['solov', 36]),
      inspectRunningToolsForTemplateFill: async () => ({ ...report, canRestartCodexDesktop: false }),
    })
    await service.saveConfig({ provider: 'codex', apiKey: 'sk-fixture-user-secret', model: 'fixture-model', mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    const ownerDirectory = path.join(data, 'tool-config-ownership')
    const ownerFile = path.join(ownerDirectory, fs.readdirSync(ownerDirectory)[0])
    const record = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
    delete record.templateRevision
    fs.writeFileSync(ownerFile, JSON.stringify(record), 'utf8')
    const configPath = codexConfigSnapshotPaths(roots).active
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('check_for_update_on_startup = false\n', ''), 'utf8')
    const before = fs.readFileSync(configPath, 'utf8')
    const backups: string[] = []

    expect(await service.fillToolTemplateDefaults!((provider) => { backups.push(provider) })).toEqual({ filled: [] })

    expect(backups).toEqual([])
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
    expect(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).templateRevision).toBeUndefined()
  })
})

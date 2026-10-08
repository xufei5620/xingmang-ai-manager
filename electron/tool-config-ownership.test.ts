import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { providerBaseUrls, providerIds, type ProviderId } from './catalog'
import {
  codexConfigSnapshotPaths,
  geminiUsageStatisticsRecordName,
  inspectProviderConfig,
  providerConfigPaths,
  relayTemplateRevision,
  saveProviderConfig,
} from './config-files'
import { createSystemService, permitsShadowedCodexRepair, planRestoredConfigOwnership, sameNativeConfigSnapshot } from './system-service'
import type { RunningToolsReport } from './running-tools'
import { ToolConfigOwnershipStore } from './tool-config-ownership'
import { XINGMANG_AI_CODEX_SKILL_STATE_FILE, resolveXingmangAiCodexSkillPath } from './xingmang-ai-skill'

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

  // 保存在动任何文件之前就停下（和工具开着、文件被占用一样）：写之前记下的那条「手动」要原样
  // 换回原来的记录，否则客户关掉工具再保存一次，「当前账号」就成了「手动」，以后换账号、换线路都不跟着换。
  function blockNextWrite(f: ReturnType<typeof fixture>) {
    const alias = path.join(f.root, 'relay-alias.toml')
    fs.linkSync(codexConfigSnapshotPaths(f.roots).relay, alias)
    return () => fs.unlinkSync(alias)
  }

  it('puts the account source back when a same-key save fails before touching the config, so the retry stays with the account', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    const record = fs.readFileSync(f.ownerFile(), 'utf8')
    const unblock = blockNextWrite(f)
    await expect(service.saveConfig({ ...f.payload, apiKey: '' }, false)).rejects.toThrow('单链接普通文件')
    expect(fs.readFileSync(f.ownerFile(), 'utf8')).toBe(record)
    unblock()
    await service.saveConfig({ ...f.payload, apiKey: '' }, false)
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('account')
    await service.saveConfig({ ...f.payload, apiKey: 'sk-account-rotated' }, false, undefined, { source: 'account', automatic: true })
    expect(f.current().apiKey).toBe('sk-account-rotated')
  })

  it('lets the next automatic rotation through after one failed before touching the config', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false, undefined, { source: 'account', automatic: false })
    const rotated = { ...f.payload, apiKey: 'sk-account-rotated' }
    const unblock = blockNextWrite(f)
    await expect(service.saveConfig(rotated, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('单链接普通文件')
    unblock()
    await service.saveConfig(rotated, false, undefined, { source: 'account', automatic: true })
    expect(f.current().apiKey).toBe('sk-account-rotated')
  })

  it('leaves a manual source manual when its save fails', async () => {
    const f = fixture()
    const service = f.makeService()
    await service.saveConfig(f.payload, false)
    const record = fs.readFileSync(f.ownerFile(), 'utf8')
    const unblock = blockNextWrite(f)
    await expect(service.saveConfig({ ...f.payload, apiKey: '' }, false)).rejects.toThrow('单链接普通文件')
    unblock()
    expect(fs.readFileSync(f.ownerFile(), 'utf8')).toBe(record)
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('manual')
  })

  it('leaves no record behind when the failed save was the first for a config nobody recorded', async () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const service = f.makeService()
    const unblock = blockNextWrite(f)
    await expect(service.saveConfig({ ...f.payload, apiKey: '' }, false)).rejects.toThrow('单链接普通文件')
    unblock()
    expect(fs.readdirSync(path.join(f.data, 'tool-config-ownership'))).toEqual([])
    expect(service.getConfig(false).providers.codex.configurationOwnership).toBe('unknown')
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

  it('forgets the Gemini usage statistics record a restored settings.json no longer carries', async () => {
    const f = fixture()
    const [settingsPath] = providerConfigPaths('gemini', f.roots)
    const recordPath = path.join(path.dirname(settingsPath), geminiUsageStatisticsRecordName)
    saveProviderConfig('gemini', 'sk-fixture-user-secret', 'gemini-3.5-flash', 'reset', f.roots, {}, providerBaseUrls)
    expect(fs.readFileSync(recordPath, 'utf8')).not.toBe('')

    // The backup from before the switch comes back without the switch Xingmang wrote.
    fs.writeFileSync(settingsPath, JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }), 'utf8')
    await f.makeService().adoptRestoredConfig('gemini', () => false)
    expect(fs.readFileSync(recordPath, 'utf8')).toBe('')
  })

  it('forgets that Gemini record even when the restored config cannot be registered', async () => {
    const f = fixture()
    const [settingsPath] = providerConfigPaths('gemini', f.roots)
    const recordPath = path.join(path.dirname(settingsPath), geminiUsageStatisticsRecordName)
    saveProviderConfig('gemini', 'sk-fixture-user-secret', 'gemini-3.5-flash', 'reset', f.roots, {}, providerBaseUrls)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, privacy: {} }), 'utf8')
    fs.mkdirSync(f.data, { recursive: true })
    fs.writeFileSync(path.join(f.data, 'tool-config-ownership'), 'blocked', 'utf8')

    await expect(f.makeService().adoptRestoredConfig('gemini', () => false)).rejects.toThrow()
    expect(fs.readFileSync(recordPath, 'utf8')).toBe('')
  })

  // On the ChatGPT account, with the record still saying the skill comes back
  // on, a Xingmang config with the user's own off is put back.
  async function restoredXingmangConfigWithSkillOff(f: ReturnType<typeof fixture>) {
    saveProviderConfig('codex', 'sk-fixture-user-secret', 'fixture-model', 'reset', f.roots, {}, providerBaseUrls)
    const skillPath = resolveXingmangAiCodexSkillPath(f.roots.userHome)
    fs.appendFileSync(path.join(f.roots.codexHome, 'config.toml'), `\n[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n`, 'utf8')
    const statePath = path.join(f.roots.codexHome, XINGMANG_AI_CODEX_SKILL_STATE_FILE)
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, offByXingmang: true })}\n`, 'utf8')
    await new AppSettingsStore(path.join(f.data, 'settings.json'), f.root).setOfficialProvider('codex', true)
    return () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown
  }

  it('records the skill off in a Xingmang config restored on the backups page as the user\'s', async () => {
    const f = fixture()
    const record = await restoredXingmangConfigWithSkillOff(f)
    await f.makeService().adoptRestoredConfig('codex', () => false, { fromBackupsPage: true })
    expect(record()).toEqual({ version: 1, offByXingmang: false })
  })

  it('leaves the skill record alone when a failed switch is rolled back', async () => {
    const f = fixture()
    const record = await restoredXingmangConfigWithSkillOff(f)
    await f.makeService().adoptRestoredConfig('codex', () => false)
    expect(record()).toEqual({ version: 1, offByXingmang: true })
  })

  it('records that skill off even when the restored config cannot be registered', async () => {
    const f = fixture()
    const record = await restoredXingmangConfigWithSkillOff(f)
    fs.writeFileSync(path.join(f.data, 'tool-config-ownership'), 'blocked', 'utf8')

    await expect(f.makeService().adoptRestoredConfig('codex', () => false, { fromBackupsPage: true })).rejects.toThrow()
    expect(record()).toEqual({ version: 1, offByXingmang: false })
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

describe('remembering an ownership record to put it back', () => {
  it('puts back exactly the record it saw, including no record at all', async () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const config = f.current()
    const putBackNothing = f.ownership.remember('codex', config)
    await f.ownership.write('codex', config, 'manual')
    expect(putBackNothing).toBeTypeOf('function')
    await putBackNothing?.()
    expect(fs.readdirSync(path.join(f.data, 'tool-config-ownership'))).toEqual([])

    await f.ownership.write('codex', config, 'account', JSON.stringify(['solov', 36]), relayTemplateRevision)
    const record = fs.readFileSync(f.ownerFile(), 'utf8')
    const putBack = f.ownership.remember('codex', config)
    await f.ownership.write('codex', config, 'manual')
    await putBack?.()
    expect(fs.readFileSync(f.ownerFile(), 'utf8')).toBe(record)
  })

  it('declines when the record cannot be read safely', async () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const config = f.current()
    await f.ownership.write('codex', config, 'manual')
    fs.linkSync(f.ownerFile(), path.join(f.root, 'record-alias.json'))
    expect(f.ownership.remember('codex', config)).toBeNull()
  })
})

describe('sameNativeConfigSnapshot', () => {
  it('counts a config as untouched only while its identity, modification time and model all match', () => {
    const f = fixture()
    saveProviderConfig('codex', f.payload.apiKey, f.payload.model, 'merge', f.roots, {}, providerBaseUrls)
    const before = f.current()
    expect(sameNativeConfigSnapshot(before, f.current())).toBe(true)
    expect(sameNativeConfigSnapshot(before, { ...before, model: 'another-model' })).toBe(false)
    expect(sameNativeConfigSnapshot(before, { ...before, apiKey: 'sk-another-key' })).toBe(false)
    // 回滚会把内容照原样写回去，可修改时间变了：照「写到一半」算，不当没动过。
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(providerConfigPaths('codex', f.roots)[0], later, later)
    expect(sameNativeConfigSnapshot(before, f.current())).toBe(false)
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
  const closed = { running: [], unknown: [], codexDesktopRunning: false }

  async function savedWhile(report: Omit<RunningToolsReport, 'canRestartCodexDesktop'>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-ownership-'))
    directories.push(root)
    const roots = { userHome: root, codexHome: path.join(root, '.codex') }
    const data = path.join(root, 'manager')
    const state = { report, owner: JSON.stringify(['solov', 36]) as string | null }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 }))
    const running = vi.fn(async (_providers: readonly ProviderId[]): Promise<RunningToolsReport> => ({ ...state.report, canRestartCodexDesktop: false }))
    const service = createSystemService(new AppSettingsStore(path.join(data, 'settings.json'), root), {
      providerRoots: roots, managerDataDirectory: data, relayFetch: fetch,
      getExternalClientAccountId: () => state.owner,
      inspectRunningToolsForTemplateFill: running,
    })
    await service.saveConfig({ provider: 'codex', apiKey: 'sk-fixture-user-secret', model: 'fixture-model', mode: 'merge' }, false, undefined, { source: 'account', automatic: false })
    const ownerDirectory = path.join(data, 'tool-config-ownership')
    const ownerFile = path.join(ownerDirectory, fs.readdirSync(ownerDirectory)[0])
    const configPath = codexConfigSnapshotPaths(roots).active
    function makeOlder(): string {
      const record = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
      delete record.templateRevision
      fs.writeFileSync(ownerFile, JSON.stringify(record), 'utf8')
      fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('check_for_update_on_startup = false\n', ''), 'utf8')
      return fs.readFileSync(configPath, 'utf8')
    }
    function revision(): unknown {
      return JSON.parse(fs.readFileSync(ownerFile, 'utf8')).templateRevision
    }
    return { state, service, running, configPath, makeOlder, revision }
  }

  it.each([
    ['running', { running: ['codex' as const], unknown: [], codexDesktopRunning: false }],
    ['undetectable', { running: [], unknown: ['codex' as const], codexDesktopRunning: false }],
    ['open as the desktop app', { running: [], unknown: [], codexDesktopRunning: true }],
    ['possibly open as the desktop app', { running: [], unknown: [], codexDesktopRunning: null }],
  ])('leaves a %s tool for a later try and reports it as still pending', async (_label, report) => {
    const f = await savedWhile(report)
    const before = f.makeOlder()
    const backups: string[] = []

    expect(await f.service.fillToolTemplateDefaults!((provider) => { backups.push(provider) })).toEqual({ filled: [], pending: ['codex'] })

    expect(backups).toEqual([])
    expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before)
    expect(f.revision()).toBeUndefined()
  })

  it('fills a tool it had to skip on a later try once the tool has been closed', async () => {
    const f = await savedWhile({ running: [], unknown: [], codexDesktopRunning: true })
    const before = f.makeOlder()
    const backups: string[] = []
    await f.service.fillToolTemplateDefaults!((provider) => { backups.push(provider) })

    expect(await f.service.fillToolTemplateDefaults!((provider) => { backups.push(provider) }, true)).toEqual({ filled: [], pending: ['codex'] })
    expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before)
    f.state.report = closed
    expect(await f.service.fillToolTemplateDefaults!((provider) => { backups.push(provider) }, true)).toEqual({ filled: ['codex'] })

    expect(backups).toEqual(['codex'])
    expect(fs.readFileSync(f.configPath, 'utf8')).toContain('check_for_update_on_startup = false')
    expect(f.revision()).toBe(relayTemplateRevision)
    // 补完就不欠了：再来要什么都不做，也不再起进程看它开没开。
    const probes = f.running.mock.calls.length
    expect(await f.service.fillToolTemplateDefaults!(() => { backups.push('again') }, true)).toEqual({ filled: [] })
    expect(f.running.mock.calls.length).toBe(probes)
    expect(backups).toEqual(['codex'])
  })

  it('stops waiting for the running-tools check once an account change begins, and fills on a later try', async () => {
    const f = await savedWhile(closed)
    const before = f.makeOlder()
    const backups: string[] = []
    // 安全软件拖住了 PowerShell：看工具开没开这一下迟迟没有回音。
    f.running.mockImplementationOnce(() => new Promise<never>(() => undefined))

    const startup = f.service.fillToolTemplateDefaults!((provider) => { backups.push(provider) })
    await vi.waitFor(() => expect(f.running).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    const resume = f.service.stopTemplateFillWaits!()

    expect(await startup).toEqual({ filled: [], pending: ['codex'] })
    expect(backups).toEqual([])
    expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before)
    expect(f.revision()).toBeUndefined()
    // 换账号那段等完了、没换成，还是这个账号：再来要时照常看、照常补。
    resume()
    expect(await f.service.fillToolTemplateDefaults!((provider) => { backups.push(provider) }, true)).toEqual({ filled: ['codex'] })
    expect(backups).toEqual(['codex'])
    expect(f.revision()).toBe(relayTemplateRevision)
  })

  it('does not wait on a round that only gets going while an account change is still waiting', async () => {
    const f = await savedWhile(closed)
    const before = f.makeOlder()
    const backups: string[] = []
    // 进门以后先读备份用的账号信息，晚一步才走到看工具这里：叫停还管着，起都不起。
    const resume = f.service.stopTemplateFillWaits!()

    expect(await f.service.fillToolTemplateDefaults!((provider) => { backups.push(provider) })).toEqual({ filled: [], pending: ['codex'] })
    expect(f.running).not.toHaveBeenCalled()
    expect(backups).toEqual([])
    expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before)

    resume()
    expect(await f.service.fillToolTemplateDefaults!((provider) => { backups.push(provider) })).toEqual({ filled: ['codex'] })
    expect(f.running).toHaveBeenCalledTimes(1)
    expect(backups).toEqual(['codex'])
  })

  it('keeps waits stopped until every overlapping account change has finished waiting', async () => {
    const f = await savedWhile(closed)
    f.makeOlder()
    // 上一次换账号超时了还在等，又来一次：先等完的那次放开（重复放开也只算一次），后来那次还管着。
    const first = f.service.stopTemplateFillWaits!()
    const second = f.service.stopTemplateFillWaits!()
    first()
    first()

    expect(await f.service.fillToolTemplateDefaults!(() => undefined)).toEqual({ filled: [], pending: ['codex'] })
    expect(f.running).not.toHaveBeenCalled()

    second()
    expect(await f.service.fillToolTemplateDefaults!(() => undefined)).toEqual({ filled: ['codex'] })
    expect(f.running).toHaveBeenCalledTimes(1)
  })

  it('only retries what the startup round had to leave behind', async () => {
    const f = await savedWhile(closed)
    expect(await f.service.fillToolTemplateDefaults!(() => undefined)).toEqual({ filled: [] })
    const before = f.makeOlder()

    expect(await f.service.fillToolTemplateDefaults!(() => undefined, true)).toEqual({ filled: [] })

    expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before)
    expect(f.revision()).toBeUndefined()
  })

  it('drops what it owed once another account is signed in', async () => {
    const f = await savedWhile({ running: ['codex'], unknown: [], codexDesktopRunning: false })
    const before = f.makeOlder()
    await f.service.fillToolTemplateDefaults!(() => undefined)
    f.state.report = closed
    f.state.owner = JSON.stringify(['solov', 37])
    const probes = f.running.mock.calls.length

    expect(await f.service.fillToolTemplateDefaults!(() => undefined, true)).toEqual({ filled: [] })

    expect(f.running.mock.calls.length).toBe(probes)
    expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before)
  })
})

describe('automatic repair of a Codex config written under a built-in provider name', () => {
  function shadowedFixture(key: string) {
    const f = fixture()
    fs.mkdirSync(f.roots.codexHome, { recursive: true })
    fs.writeFileSync(path.join(f.roots.codexHome, 'config.toml'),
      'model_provider = "openai"\nmodel = "fixture-model"\n[model_providers.openai]\nbase_url = "https://xm.solov.cc/v1"\n')
    fs.writeFileSync(path.join(f.roots.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key, auth_mode: 'apikey' }))
    return f
  }

  it('rewrites an unowned shadowed config that already holds the account key, and records it as the account\'s', async () => {
    const f = shadowedFixture('sk-account-key')
    const service = f.makeService()
    expect(service.getConfig(false).providers.codex).toMatchObject({ configurationOwnership: 'unknown', codexProviderShadowed: true })
    await service.saveConfig({ ...f.payload, apiKey: 'sk-account-key' }, false, undefined, { source: 'account', automatic: true })
    expect(f.current()).toMatchObject({ codexProviderName: 'XingmangAI', codexProviderShadowed: false, apiKey: 'sk-account-key', matchesRelay: true })
    expect(f.makeService().getConfig(false).providers.codex.configurationOwnership).toBe('account')
  })

  it('still refuses when the shadowed config holds a different key', async () => {
    const f = shadowedFixture('sk-someone-else')
    await expect(f.makeService().saveConfig({ ...f.payload, apiKey: 'sk-account-key' }, false, undefined, { source: 'account', automatic: true })).rejects.toThrow('来源未经确认')
    expect(f.current()).toMatchObject({ codexProviderName: 'openai', apiKey: 'sk-someone-else' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
})

describe('permitsShadowedCodexRepair', () => {
  const before = { hasApiKey: true, matchesRelay: true, apiKey: 'sk-account', codexProviderShadowed: true }

  it('permits only an unowned shadowed Codex config on our site holding the key being written', () => {
    expect(permitsShadowedCodexRepair('codex', before, 'unknown', ' sk-account ')).toBe(true)
  })

  it.each([
    ['another tool', { provider: 'claude' as const }],
    ['an edited config', { ownership: 'changed' as const }],
    ['a manual config', { ownership: 'manual' as const }],
    ['a config Codex reads fine', { before: { codexProviderShadowed: false } }],
    ['another site', { before: { matchesRelay: false } }],
    ['a different key', { key: 'sk-other' }],
    ['an empty key', { key: '  ' }],
  ])('refuses %s', (_label, change: { provider?: 'claude'; ownership?: 'changed' | 'manual'; before?: Partial<typeof before>; key?: string }) => {
    expect(permitsShadowedCodexRepair(change.provider ?? 'codex', { ...before, ...change.before }, change.ownership ?? 'unknown', change.key ?? 'sk-account')).toBe(false)
  })
})

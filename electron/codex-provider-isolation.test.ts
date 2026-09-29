import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it } from 'vitest'
import { providerBaseUrls } from './catalog'
import { codexConfigSnapshotPaths, inspectProviderConfig, saveProviderConfig, switchProviderToOfficialAccount } from './config-files'

const homes: string[] = []

function fixture(content: string) {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-provider-isolation-'))
  homes.push(userHome)
  const roots = { userHome, codexHome: path.join(userHome, '.codex') }
  fs.mkdirSync(roots.codexHome)
  const config = path.join(roots.codexHome, 'config.toml')
  fs.writeFileSync(config, content)
  return { roots, config }
}

function readConfig(file: string) {
  return TOML.parse(fs.readFileSync(file, 'utf8'))
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith('xingmang-provider-isolation-')) throw new Error('Unsafe fixture cleanup')
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe('Codex relay provider isolation', () => {
  it.each(['openai', 'ollama', 'lmstudio'])('does not redefine the built-in %s provider', (provider) => {
    const original = `model_provider = "${provider}"\nmodel = "original"\n[projects."C:/project"]\ntrust_level = "untrusted"\n`
    const { roots, config } = fixture(original)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    const parsed = readConfig(config)
    expect(parsed.model_provider).toBe('XingmangAI')
    expect(parsed.model_providers).toEqual({ XingmangAI: expect.objectContaining({ base_url: providerBaseUrls.codex, wire_api: 'responses' }) })
    expect(parsed.projects).toEqual({ 'C:/project': { trust_level: 'untrusted' } })
    expect(fs.readFileSync(codexConfigSnapshotPaths(roots).chatgpt, 'utf8')).toBe(original)
  })

  it('allocates a free relay identifier without overwriting unselected user tables', () => {
    const original = '[model_providers.OpenAI]\nbase_url = "https://user.example/v1"\n[model_providers.XingmangAI]\nbase_url = "https://other.example/v1"\n[model_providers.XingmangAI-2]\nbase_url = "https://third.example/v1"\n'
    const { roots, config } = fixture(original)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    const parsed = readConfig(config)
    expect(parsed.model_provider).toBe('XingmangAI-3')
    expect(parsed.model_providers).toEqual({
      ...readConfig(codexConfigSnapshotPaths(roots).chatgpt).model_providers as object,
      'XingmangAI-3': expect.objectContaining({ base_url: providerBaseUrls.codex }),
    })
    saveProviderConfig('codex', 'fixture-key-2', 'next-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('XingmangAI-3')
    expect(Object.keys(readConfig(config).model_providers as object)).toHaveLength(4)
  })

  it('migrates a reserved relay table without dropping its provider options', () => {
    const { roots, config } = fixture('model_provider = "openai"\n[model_providers.openai]\nbase_url = "https://xm.solov.cc/v1"\nrequest_max_retries = 2\n')
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_providers).toEqual({
      XingmangAI: expect.objectContaining({ base_url: providerBaseUrls.codex, request_max_retries: 2 }),
    })
  })

  it.each(['openai', 'azure'])('keeps a foreign built-in table untouched and still saves with %s active', (active) => {
    const userTable = '[model_providers.openai]\nbase_url = "https://api.openai.com/v1"\nenv_key = "PRIVATE_KEY"\n'
    const original = `model_provider = "${active}"\n[model_providers.azure]\nbase_url = "https://azure.example.com"\n${userTable}`
    const { roots, config } = fixture(original)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    const parsed = readConfig(config)
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>
    expect(providers.openai).toEqual({ base_url: 'https://api.openai.com/v1', env_key: 'PRIVATE_KEY' })
    const selected = active === 'openai' ? 'XingmangAI' : 'azure'
    expect(parsed.model_provider).toBe(selected)
    expect(providers[selected]).toEqual(expect.objectContaining({ base_url: providerBaseUrls.codex }))
  })

  it.each(['OpenAI', 'XingmangAI', 'existing'])('keeps the active %s name so earlier chats stay in the resume list', (active) => {
    const { roots, config } = fixture(`model_provider = "${active}"\n[model_providers.${active}]\nbase_url = "https://xm.solov.cc/v1"\n`)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe(active)
  })

  it('keeps the legacy OpenAI name when no provider is selected', () => {
    const { roots, config } = fixture('[model_providers.azure]\nbase_url = "https://azure.example.com"\n')
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    const parsed = readConfig(config)
    expect(parsed.model_provider).toBe('OpenAI')
    expect(parsed.model_providers).toEqual({
      azure: { base_url: 'https://azure.example.com' },
      OpenAI: expect.objectContaining({ base_url: providerBaseUrls.codex }),
    })
  })

  it('backs up a reserved profile before an explicit reset', () => {
    const original = 'model_provider = "openai"\ncustom_setting = "preserve-in-backup"\n'
    const { roots, config } = fixture(original)
    const result = saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'reset', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('XingmangAI')
    expect(result.backups.some((backup) => fs.readFileSync(backup, 'utf8') === original)).toBe(true)
  })

  it('rolls back active and snapshot files when provider migration fails', () => {
    const original = 'model_provider = "openai"\n'
    const { roots, config } = fixture(original)
    expect(() => saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {
      beforeReplace: (_target, index) => { if (index === 1) throw new Error('fixture failure') },
    }, providerBaseUrls)).toThrow('fixture failure')
    expect(fs.readFileSync(config, 'utf8')).toBe(original)
    expect(fs.existsSync(codexConfigSnapshotPaths(roots).chatgpt)).toBe(false)
  })
})

describe('Codex shadowed relay inspection', () => {
  const shadowed = 'model_provider = "openai"\nmodel = "fixture-model"\n[model_providers.openai]\nbase_url = "https://xm.solov.cc/v1"\n'

  function withKey(content: string) {
    const created = fixture(content)
    fs.writeFileSync(path.join(created.roots.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key', auth_mode: 'apikey' }))
    return created
  }

  it('flags a relay table written under a built-in name without changing matchesRelay', () => {
    const { roots } = withKey(shadowed)
    const inspection = inspectProviderConfig('codex', roots, providerBaseUrls)
    expect(inspection.codexProviderShadowed).toBe(true)
    expect(inspection.codexProviderName).toBe('openai')
    expect(inspection.matchesRelay).toBe(true)
  })

  it.each([
    ['a user-owned built-in table', 'model_provider = "openai"\n[model_providers.openai]\nbase_url = "https://api.openai.com/v1"\n', 'openai'],
    ['an ordinary relay name', 'model_provider = "XingmangAI"\n[model_providers.XingmangAI]\nbase_url = "https://xm.solov.cc/v1"\n', 'XingmangAI'],
    ['the case-sensitive OpenAI name', 'model_provider = "OpenAI"\n[model_providers.OpenAI]\nbase_url = "https://xm.solov.cc/v1"\n', 'OpenAI'],
  ])('does not flag %s', (_label, content, name) => {
    const { roots } = withKey(content)
    const inspection = inspectProviderConfig('codex', roots, providerBaseUrls)
    expect(inspection.codexProviderShadowed).toBe(false)
    expect(inspection.codexProviderName).toBe(name)
  })

  it('reports no provider for other tools or an empty Codex config', () => {
    const { roots } = fixture('')
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ codexProviderName: null, codexProviderShadowed: false })
    expect(inspectProviderConfig('claude', roots, providerBaseUrls)).not.toHaveProperty('codexProviderShadowed')
  })

  it('clears the flag once a save moves the table to the relay name', () => {
    const { roots } = withKey(shadowed)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ codexProviderName: 'XingmangAI', codexProviderShadowed: false, matchesRelay: true })
  })

  it('still switches a shadowed config back to the official account', () => {
    const { roots, config } = withKey(shadowed)
    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    const parsed = readConfig(config)
    expect((parsed.model_providers as Record<string, unknown> | undefined)?.openai).toBeUndefined()
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).codexProviderShadowed).toBe(false)
  })
})

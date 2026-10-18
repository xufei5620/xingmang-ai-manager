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

describe('Codex provider tables that carry their own credentials', () => {
  const packy = '[model_providers.packy]\nname = "packy"\nbase_url = "https://packy.example/v1"\nwire_api = "responses"\nenv_key = "PACKY_KEY"\n'

  function withKey(content: string) {
    const created = fixture(content)
    fs.writeFileSync(path.join(created.roots.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key', auth_mode: 'apikey' }))
    return created
  }

  function providerTables(file: string) {
    return readConfig(file).model_providers as Record<string, Record<string, unknown>>
  }

  it('starts a relay table of its own and leaves the customer table untouched', () => {
    const { roots, config } = fixture(`model_provider = "packy"\nmodel = "their-model"\n${packy}`)
    const original = providerTables(config).packy
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    const parsed = readConfig(config)
    expect(parsed.model_provider).toBe('XingmangAI')
    expect(providerTables(config).packy).toEqual(original)
    expect(providerTables(config).XingmangAI).toEqual(expect.objectContaining({ base_url: providerBaseUrls.codex, requires_openai_auth: true }))
    expect(providerTables(config).XingmangAI).not.toHaveProperty('env_key')
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ codexProviderName: 'XingmangAI', matchesRelay: true })
  })

  it.each([
    ['env_key', 'env_key = "OTHER_KEY"'],
    ['env_key_instructions', 'env_key_instructions = "export OTHER_KEY"'],
    ['experimental_bearer_token', 'experimental_bearer_token = "PROXY_MANAGED"'],
    ['http_headers', 'http_headers = { Authorization = "Bearer other" }'],
    ['env_http_headers', 'env_http_headers = { Authorization = "OTHER_TOKEN" }'],
    ['query_params', 'query_params = { api-version = "2025-04-01" }'],
    ['auth', '[model_providers.other.auth]\ncommand = "other-token"'],
  ])('does not adopt an active table with %s', (_key, line) => {
    const { roots, config } = fixture(`model_provider = "other"\n[model_providers.other]\nbase_url = "https://other.example/v1"\n${line}\n`)
    const original = providerTables(config).other
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('XingmangAI')
    expect(providerTables(config).other).toEqual(original)
  })

  it('still adopts an active table that only points somewhere else', () => {
    const { roots, config } = fixture('model_provider = "packy"\n[model_providers.packy]\nbase_url = "https://packy.example/v1"\nrequest_max_retries = 3\n')
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('packy')
    expect(providerTables(config).packy).toEqual(expect.objectContaining({ base_url: providerBaseUrls.codex, request_max_retries: 3 }))
  })

  it('skips a free-looking relay name whose table carries credentials', () => {
    const { roots, config } = fixture(`model_provider = "packy"\n${packy}[model_providers.XingmangAI]\nbase_url = "${providerBaseUrls.codex}"\nenv_key = "CUSTOMER_KEY"\n`)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('XingmangAI-2')
    expect(providerTables(config).XingmangAI).toEqual({ base_url: providerBaseUrls.codex, env_key: 'CUSTOMER_KEY' })
  })

  it('does not move a reserved relay table that carries credentials', () => {
    const { roots, config } = fixture(`model_provider = "openai"\n[model_providers.openai]\nbase_url = "${providerBaseUrls.codex}"\nenv_key = "CUSTOMER_KEY"\n`)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('XingmangAI')
    expect(providerTables(config).openai).toEqual({ base_url: providerBaseUrls.codex, env_key: 'CUSTOMER_KEY' })
    expect(providerTables(config).XingmangAI).not.toHaveProperty('env_key')
  })

  it('does not report a table taken over by an older release as configured, and the next save repairs it', () => {
    const takenOver = `model_provider = "packy"\nmodel = "fixture-model"\n[model_providers.packy]\nname = "packy"\nbase_url = "${providerBaseUrls.codex}"\nwire_api = "responses"\nrequires_openai_auth = true\nenv_key = "PACKY_KEY"\n`
    const { roots, config } = withKey(takenOver)
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ codexProviderName: 'packy', hasApiKey: true, matchesRelay: false })
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(providerTables(config).packy.env_key).toBe('PACKY_KEY')
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ codexProviderName: 'XingmangAI', matchesRelay: true })
  })

  it('repairs a stored relay snapshot written by an older release when switching back', () => {
    const { roots, config } = withKey(`model_provider = "packy"\n${packy}`)
    fs.writeFileSync(codexConfigSnapshotPaths(roots).relay, `model_provider = "packy"\nmodel = "fixture-model"\n[model_providers.packy]\nbase_url = "${providerBaseUrls.codex}"\nenv_key = "PACKY_KEY"\n`)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('XingmangAI')
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).matchesRelay).toBe(true)
  })

  it('keeps the active name on reset, where the template drops the other settings', () => {
    const { roots, config } = fixture(`model_provider = "packy"\n${packy}`)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'reset', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('packy')
    expect(providerTables(config)).toEqual({ packy: expect.objectContaining({ base_url: providerBaseUrls.codex }) })
    expect(providerTables(config).packy).not.toHaveProperty('env_key')
  })
})

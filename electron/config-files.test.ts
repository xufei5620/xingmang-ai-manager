import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as TOML from '@iarna/toml'
import {
  inspectProviderConfig,
  providerAccountMode,
  providerConfigPaths,
  providerSupportsOfficialAccount,
  saveProviderConfig,
  switchProviderToOfficialAccount,
  toNativeConfigSummary,
} from './config-files'
import { providerBaseUrls, type ProviderId } from './catalog'

const temporaryHomes: string[] = []
const testModels: Record<ProviderId, string> = {
  claude: 'claude-opus-4-6',
  codex: 'gpt-5.5',
  gemini: 'gemini-3.5-flash',
  grok: 'grok-4.5',
}

function temporaryHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-test-'))
  temporaryHomes.push(directory)
  return directory
}

function providerRoots(userHome: string) {
  return { userHome, codexHome: path.join(userHome, '.codex') }
}

function directoryFileSnapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    fs.readdirSync(directory).sort().map((name) => [
      name,
      fs.readFileSync(path.join(directory, name)).toString('base64'),
    ]),
  )
}

// TOML.parse returns AnyJson (string | number | boolean | Date | JsonMap | JsonArray),
// which cannot support chained property access. Tests that read back a written
// config.toml know the fixture shape, so narrow one level at a time the same way
// codex-sessions.ts / provider-sessions.ts already do for their own JSON payloads.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

if (false) {
  // @ts-expect-error Core config APIs require both the user and Codex roots.
  providerConfigPaths('codex', '/tmp/string-root')
  // @ts-expect-error Core config APIs require both the user and Codex roots.
  inspectProviderConfig('codex', '/tmp/string-root')
  // @ts-expect-error Core config APIs require both the user and Codex roots.
  saveProviderConfig('codex', 'sk-key', 'gpt-5.6-sol', 'reset', '/tmp/string-root')
}

afterEach(() => {
  for (const directory of temporaryHomes.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('native CLI configuration files', () => {
  it('resets a Codex config.toml that can no longer be parsed', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const configPath = providerConfigPaths('codex', roots)[0]
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    // A half-written table is what a crash during a previous save leaves behind.
    fs.writeFileSync(configPath, 'model_provider = "solov"\n[model_providers.\n', 'utf8')

    const saved = saveProviderConfig('codex', 'sk-recovered', 'gpt-5.6-sol', 'reset', roots, {}, providerBaseUrls)

    const summary = inspectProviderConfig('codex', roots)
    expect(summary.apiKey).toBe('sk-recovered')
    const rewritten = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    // The unreadable file cannot say which provider it used, so reset falls
    // back to the same default it uses when no config exists at all.
    expect(rewritten.model_provider).toBe('OpenAI')
    expect(rewritten.model).toBe('gpt-5.6-sol')

    // The broken original must still be recoverable by hand.
    const configBackup = saved.backups.find((entry) => entry.startsWith(`${configPath}.bak.`))
    expect(configBackup).toBeDefined()
    expect(fs.readFileSync(String(configBackup), 'utf8')).toContain('[model_providers.')
  })

  it('still refuses to merge into a Codex config.toml that cannot be parsed', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const configPath = providerConfigPaths('codex', roots)[0]
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'model_provider = "solov"\n[model_providers.\n', 'utf8')
    const before = fs.readFileSync(configPath, 'utf8')

    // Merge promises to preserve existing settings. It cannot honour that on a
    // file it cannot read, so it must fail rather than quietly reset the user.
    expect(() => saveProviderConfig('codex', 'sk-merge', 'gpt-5.6-sol', 'merge', roots, {}, providerBaseUrls))
      .toThrow(/无法解析/)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('keeps an existing provider name when the config is still readable', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const configPath = providerConfigPaths('codex', roots)[0]
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'model_provider = "solov"\n', 'utf8')

    saveProviderConfig('codex', 'sk-key', 'gpt-5.6-sol', 'reset', roots, {}, providerBaseUrls)

    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).model_provider).toBe('solov')
  })

  it('reads and writes Codex at codexHome while every other provider stays at userHome', () => {
    const userHome = temporaryHome()
    const codexParent = temporaryHome()
    const codexHome = path.join(codexParent, 'custom-codex')
    const roots = { userHome, codexHome }

    saveProviderConfig('codex', 'sk-codex', 'gpt-5.6-sol', 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('claude', 'sk-claude', 'claude-sonnet-4-6', 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('gemini', 'sk-gemini', 'gemini-3.5-pro', 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('grok', 'sk-grok', 'grok-5', 'reset', roots, {}, providerBaseUrls)

    expect(providerConfigPaths('codex', roots)).toEqual([
      path.join(codexHome, 'config.toml'),
      path.join(codexHome, 'auth.json'),
    ])
    expect(fs.existsSync(path.join(userHome, '.codex'))).toBe(false)
    expect(inspectProviderConfig('codex', roots).apiKey).toBe('sk-codex')
    expect(providerConfigPaths('claude', roots)[0]).toBe(
      path.join(userHome, '.claude', 'settings.json'),
    )
    expect(providerConfigPaths('gemini', roots)[0]).toBe(
      path.join(userHome, '.gemini', 'settings.json'),
    )
    expect(providerConfigPaths('grok', roots)[0]).toBe(
      path.join(userHome, '.grok', 'config.toml'),
    )
  })

  it('rejects an existing junction component inside a custom Codex root', () => {
    const userHome = temporaryHome()
    const codexParent = temporaryHome()
    const outside = temporaryHome()
    const junction = path.join(codexParent, 'nested')
    fs.symlinkSync(outside, junction, 'junction')
    const roots = { userHome, codexHome: junction }

    expect(() => inspectProviderConfig('codex', roots)).toThrow(/符号链接|目录联接/)
    expect(() => saveProviderConfig('codex', 'sk-key', 'gpt-5.6-sol', 'reset', roots, {}, providerBaseUrls))
      .toThrow(/符号链接|目录联接/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('refuses to merge an oversized existing config without modifying it', () => {
    const home = temporaryHome()
    const configPath = providerConfigPaths('codex', providerRoots(home))[0]
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8')

    expect(() => saveProviderConfig('codex', 'sk-new-key', 'gpt-5.6-sol', 'merge', providerRoots(home), {}, providerBaseUrls))
      .toThrow('2048 KB 安全上限')
    expect(fs.statSync(configPath).size).toBe(2 * 1024 * 1024 + 1)
  })

  it.each(['claude', 'codex', 'gemini', 'grok'] as ProviderId[])(
    'creates and detects %s configuration',
    (provider) => {
      const home = temporaryHome()
      const model = testModels[provider]
      const result = saveProviderConfig(provider, 'sk-user-key', model, 'reset', providerRoots(home), {}, providerBaseUrls)
      expect(result.backups).toEqual([])
      expect(result.files.every((filePath) => fs.existsSync(filePath))).toBe(true)

      const inspection = inspectProviderConfig(provider, providerRoots(home))
      expect(inspection.exists).toBe(true)
      expect(inspection.apiKey).toBe('sk-user-key')
      expect(inspection.hasApiKey).toBe(true)
      expect(inspection.matchesRelay).toBe(true)
      expect(inspection.model).toBe(model)

      const paths = providerConfigPaths(provider, providerRoots(home))
      if (provider === 'claude') {
        const settings = JSON.parse(fs.readFileSync(paths[0], 'utf8'))
        expect(settings).toEqual({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-user-key',
            ANTHROPIC_BASE_URL: 'https://xm.solov.cc',
          },
          permissions: { defaultMode: 'bypassPermissions' },
          model,
          effortLevel: 'medium',
          skipDangerousModePermissionPrompt: true,
        })
      }
      if (provider === 'gemini') {
        expect(JSON.parse(fs.readFileSync(paths[0], 'utf8'))).toEqual({
          ide: { enabled: true },
          security: { auth: { selectedType: 'gemini-api-key' } },
        })
        expect(fs.readFileSync(paths[1], 'utf8')).toBe([
          'GOOGLE_GEMINI_BASE_URL=https://xm.solov.cc',
          'GEMINI_API_KEY=sk-user-key',
          `GEMINI_MODEL=${model}`,
          '',
        ].join('\n'))
      }
      if (provider === 'grok') {
        const settings = TOML.parse(fs.readFileSync(paths[0], 'utf8'))
        expect(settings.models).toEqual({ default: 'grok', web_search: 'grok' })
        expect(asRecord(settings.model)?.grok).toMatchObject({
          model,
          base_url: 'https://xm.solov.cc/v1',
          name: model,
          api_key: 'sk-user-key',
          api_backend: 'responses',
          context_window: 1000000,
          supports_backend_search: true,
        })
      }
    },
  )

  it.each(['claude', 'codex', 'gemini', 'grok'] as ProviderId[])(
    'reports the %s data directory independently from its config files',
    (provider) => {
      const home = temporaryHome()
      const expectedDirectory = path.dirname(providerConfigPaths(provider, providerRoots(home))[0])
      const before = inspectProviderConfig(provider, providerRoots(home))
      expect(before.dataDirectory).toBe(expectedDirectory)
      expect(before.dataDirectoryExists).toBe(false)

      fs.mkdirSync(expectedDirectory, { recursive: true })
      const after = inspectProviderConfig(provider, providerRoots(home))
      expect(after.dataDirectory).toBe(expectedDirectory)
      expect(after.dataDirectoryExists).toBe(true)
      expect(after.exists).toBe(false)
    },
  )

  it.each(['claude', 'codex', 'gemini', 'grok'] as ProviderId[])(
    'clears detected %s configuration after its files are removed',
    (provider) => {
      const home = temporaryHome()
      saveProviderConfig(provider, 'sk-user-key', testModels[provider], 'reset', providerRoots(home), {}, providerBaseUrls)
      for (const filePath of providerConfigPaths(provider, providerRoots(home))) {
        fs.rmSync(filePath, { force: true })
      }

      const inspection = inspectProviderConfig(provider, providerRoots(home))
      expect(inspection.exists).toBe(false)
      expect(inspection.apiKey).toBe('')
      expect(inspection.hasApiKey).toBe(false)
      expect(inspection.actualBaseUrl).toBe('')
      expect(inspection.matchesRelay).toBe(false)
      expect(inspection.model).toBe('')
      expect(inspection.updatedAt).toBeNull()
      expect(inspection.files.every((file) => file.exists === false)).toBe(true)
    },
  )

  it('merges API Key and model without replacing unrelated Claude settings', () => {
    const home = temporaryHome()
    saveProviderConfig('claude', 'old-key', testModels.claude, 'reset', providerRoots(home), {}, providerBaseUrls)
    const [settingsPath] = providerConfigPaths('claude', providerRoots(home))
    const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    existing.customSetting = { enabled: true }
    existing.env.CUSTOM_TOKEN = 'preserved'
    existing.env.ANTHROPIC_BASE_URL = 'https://legacy.example.com'
    fs.writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')

    const result = saveProviderConfig('claude', 'new-key', 'claude-sonnet-4-6', 'merge', providerRoots(home), {}, providerBaseUrls)
    expect(result.backups).toHaveLength(1)
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(merged.env.ANTHROPIC_AUTH_TOKEN).toBe('new-key')
    expect(merged.env.ANTHROPIC_BASE_URL).toBe('https://xm.solov.cc')
    expect(merged.model).toBe('claude-sonnet-4-6')
    expect(merged.env.CUSTOM_TOKEN).toBe('preserved')
    expect(merged.customSetting).toEqual({ enabled: true })
  })

  it('backs up Codex files and preserves its existing provider identifier', () => {
    const home = temporaryHome()
    const [configPath, authPath] = providerConfigPaths('codex', providerRoots(home))
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model_provider = "mycodex"',
      '',
      '[model_providers.mycodex]',
      'name = "mycodex"',
      'base_url = "https://old.example.com"',
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{"OPENAI_API_KEY":"old-key"}\n', 'utf8')

    const result = saveProviderConfig('codex', 'new-key', testModels.codex, 'reset', providerRoots(home), {}, providerBaseUrls)
    expect(result.backups).toHaveLength(2)
    expect(result.backups.every((filePath) => fs.existsSync(filePath))).toBe(true)

    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(parsed.model_provider).toBe('mycodex')
    const mycodexProvider = asRecord(asRecord(parsed.model_providers)?.mycodex)
    expect(mycodexProvider?.name).toBe('mycodex')
    expect(mycodexProvider?.base_url).toBe('https://xm.solov.cc')
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY).toBe('new-key')
  })

  it('merges Codex credentials at a custom external root while preserving provider settings', () => {
    const userHome = temporaryHome()
    const codexHome = path.join(temporaryHome(), 'custom-codex')
    const roots = { userHome, codexHome }
    saveProviderConfig('codex', 'old-key', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    config.custom_setting = 'preserved'
    const modelProviders = config.model_providers as Record<string, unknown>
    ;(modelProviders.OpenAI as Record<string, unknown>).custom_header = 'preserved'
    ;(modelProviders.OpenAI as Record<string, unknown>).base_url = 'https://legacy.example.com'
    fs.writeFileSync(configPath, TOML.stringify(config), 'utf8')
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    auth.CUSTOM_AUTH = 'preserved'
    fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8')

    const result = saveProviderConfig('codex', 'new-key', 'gpt-5.6-sol', 'merge', roots, {}, providerBaseUrls)
    expect(result.backups).toHaveLength(2)
    const mergedConfig = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    const mergedAuth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    expect(mergedConfig.model).toBe('gpt-5.6-sol')
    expect(mergedConfig.review_model).toBe('gpt-5.6-sol')
    expect(mergedConfig.custom_setting).toBe('preserved')
    expect(asRecord(asRecord(mergedConfig.model_providers)?.OpenAI)?.custom_header).toBe('preserved')
    expect(asRecord(asRecord(mergedConfig.model_providers)?.OpenAI)?.base_url).toBe('https://xm.solov.cc')
    expect(mergedAuth.OPENAI_API_KEY).toBe('new-key')
    expect(mergedAuth.CUSTOM_AUTH).toBe('preserved')
    expect(fs.existsSync(path.join(userHome, '.codex'))).toBe(false)
  })

  it('rolls back every Codex file at a custom external root when its hook fails', () => {
    const userHome = temporaryHome()
    const codexHome = path.join(temporaryHome(), 'custom-codex')
    const roots = { userHome, codexHome }
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const originalConfig = [
      'model_provider = "existing"',
      'model = "old-model"',
      '',
      '[model_providers.existing]',
      'name = "existing"',
      'base_url = "https://old.example.com"',
      '',
    ].join('\n')
    const originalAuth = '{"OPENAI_API_KEY":"old-key","preserve":true}\n'
    fs.writeFileSync(configPath, originalConfig, 'utf8')
    fs.writeFileSync(authPath, originalAuth, 'utf8')

    expect(() => saveProviderConfig(
      'codex',
      'new-key',
      'gpt-5.6-sol',
      'reset',
      roots,
      {
        beforeReplace: (_targetPath, index) => {
          if (index === 1) throw new Error('injected second-file failure')
        },
      },
      providerBaseUrls,
    )).toThrow('injected second-file failure')

    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig)
    expect(fs.readFileSync(authPath, 'utf8')).toBe(originalAuth)
    expect(fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes('rollback'))).toEqual([])
  })

  it('fails closed when a hook swaps a custom Codex root for a junction', () => {
    const userHome = temporaryHome()
    const codexParent = temporaryHome()
    const codexHome = path.join(codexParent, 'custom-codex')
    const displacedCodexHome = path.join(codexParent, 'displaced-codex')
    const outside = temporaryHome()
    const roots = { userHome, codexHome }
    saveProviderConfig('codex', 'old-key', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    let outsideBefore: Record<string, string> = {}
    let saveError: unknown
    try {
      saveProviderConfig('codex', 'new-key', 'gpt-5.6-sol', 'merge', roots, {
        beforeReplace: (_targetPath, index) => {
          if (index !== 1) return
          for (const name of fs.readdirSync(codexHome)) {
            fs.writeFileSync(path.join(outside, name), `outside sentinel: ${name}\n`, 'utf8')
          }
          outsideBefore = directoryFileSnapshot(outside)
          fs.renameSync(codexHome, displacedCodexHome)
          fs.symlinkSync(outside, codexHome, 'junction')
        },
      }, providerBaseUrls)
    } catch (error) {
      saveError = error
    }

    expect(saveError).toBeInstanceOf(Error)
    expect(directoryFileSnapshot(outside)).toEqual(outsideBefore)
  })

  it('merges Gemini env values while preserving other env and settings entries', () => {
    const home = temporaryHome()
    saveProviderConfig('gemini', 'old-key', testModels.gemini, 'reset', providerRoots(home), {}, providerBaseUrls)
    const [settingsPath, envPath] = providerConfigPaths('gemini', providerRoots(home))
    const settingsBefore = fs.readFileSync(settingsPath, 'utf8')
    const oldEnv = fs.readFileSync(envPath, 'utf8')
      .replace('GOOGLE_GEMINI_BASE_URL=https://xm.solov.cc', 'GOOGLE_GEMINI_BASE_URL=https://legacy.example.com')
    fs.writeFileSync(envPath, oldEnv, 'utf8')
    fs.appendFileSync(envPath, 'CUSTOM_VALUE=preserved\n', 'utf8')

    const result = saveProviderConfig('gemini', 'new-key', 'gemini-3.5-pro', 'merge', providerRoots(home), {}, providerBaseUrls)
    expect(result.backups).toHaveLength(1)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore)
    expect(fs.readFileSync(envPath, 'utf8')).toContain('GOOGLE_GEMINI_BASE_URL=https://xm.solov.cc')
    expect(fs.readFileSync(envPath, 'utf8')).toContain('GEMINI_API_KEY=new-key')
    expect(fs.readFileSync(envPath, 'utf8')).toContain('GEMINI_MODEL=gemini-3.5-pro')
    expect(fs.readFileSync(envPath, 'utf8')).toContain('CUSTOM_VALUE=preserved')
  })

  it('merges the active Grok model while preserving the rest of its TOML', () => {
    const home = temporaryHome()
    saveProviderConfig('grok', 'old-key', testModels.grok, 'reset', providerRoots(home), {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('grok', providerRoots(home))
    const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    config.custom_setting = 'preserved'
    const configGrokModel = (config.model as Record<string, unknown>).grok as Record<string, unknown>
    configGrokModel.custom_option = true
    configGrokModel.base_url = 'https://legacy.example.com/v1'
    fs.writeFileSync(configPath, TOML.stringify(config), 'utf8')

    const result = saveProviderConfig('grok', 'new-key', 'grok-5', 'merge', providerRoots(home), {}, providerBaseUrls)
    expect(result.backups).toHaveLength(1)
    const merged = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    const mergedGrokModel = asRecord(asRecord(merged.model)?.grok)
    expect(mergedGrokModel?.api_key).toBe('new-key')
    expect(mergedGrokModel?.model).toBe('grok-5')
    expect(mergedGrokModel?.base_url).toBe('https://xm.solov.cc/v1')
    expect(mergedGrokModel?.custom_option).toBe(true)
    expect(merged.custom_setting).toBe('preserved')
  })

  it('reads a Grok key from the existing default model even when its name is custom', () => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('grok', providerRoots(home))
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      '[models]',
      'default = "sub2api-grok"',
      '',
      '[model."sub2api-grok"]',
      'api_key = "existing-key"',
      '',
    ].join('\n'), 'utf8')
    expect(inspectProviderConfig('grok', providerRoots(home)).apiKey).toBe('existing-key')
  })

  it.each([
    {
      name: 'missing relay URL',
      activeProvider: [
        '[model_providers.active]',
        'name = "active"',
      ],
      expectedBaseUrl: '',
    },
    {
      name: 'a different relay URL',
      activeProvider: [
        '[model_providers.active]',
        'name = "active"',
        'base_url = "https://other-relay.example.com"',
      ],
      expectedBaseUrl: 'https://other-relay.example.com',
    },
  ])('does not use an inactive Codex provider when the active provider has $name', ({ activeProvider, expectedBaseUrl }) => {
    const home = temporaryHome()
    const [configPath, authPath] = providerConfigPaths('codex', providerRoots(home))
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model_provider = "active"',
      'model = "gpt-active"',
      '',
      ...activeProvider,
      '',
      '[model_providers.inactive]',
      'name = "inactive"',
      'base_url = "https://xm.solov.cc"',
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{"OPENAI_API_KEY":"existing-key"}\n', 'utf8')

    const inspection = inspectProviderConfig('codex', providerRoots(home))
    expect(inspection.hasApiKey).toBe(true)
    expect(inspection.actualBaseUrl).toBe(expectedBaseUrl)
    expect(inspection.matchesRelay).toBe(false)
  })

  it.each([
    {
      name: 'missing relay URL',
      activeModel: [
        '[model.active]',
        'model = "grok-active"',
        'api_key = "active-key"',
      ],
      expectedBaseUrl: '',
    },
    {
      name: 'a different relay URL',
      activeModel: [
        '[model.active]',
        'model = "grok-active"',
        'api_key = "active-key"',
        'base_url = "https://other-relay.example.com/v1"',
      ],
      expectedBaseUrl: 'https://other-relay.example.com/v1',
    },
  ])('does not use an inactive Grok model when the default model has $name', ({ activeModel, expectedBaseUrl }) => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('grok', providerRoots(home))
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      '[models]',
      'default = "active"',
      '',
      ...activeModel,
      '',
      '[model.inactive]',
      'model = "grok-inactive"',
      'api_key = "inactive-key"',
      'base_url = "https://xm.solov.cc/v1"',
      '',
    ].join('\n'), 'utf8')

    const inspection = inspectProviderConfig('grok', providerRoots(home))
    expect(inspection.apiKey).toBe('active-key')
    expect(inspection.model).toBe('grok-active')
    expect(inspection.actualBaseUrl).toBe(expectedBaseUrl)
    expect(inspection.matchesRelay).toBe(false)
  })

  it('reads no Grok credentials or model when the default target is absent', () => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('grok', providerRoots(home))
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      '[models]',
      'default = "missing"',
      '',
      '[model.inactive]',
      'model = "grok-inactive"',
      'api_key = "inactive-key"',
      'base_url = "https://xm.solov.cc/v1"',
      '',
    ].join('\n'), 'utf8')

    const inspection = inspectProviderConfig('grok', providerRoots(home))
    expect(inspection.apiKey).toBe('')
    expect(inspection.hasApiKey).toBe(false)
    expect(inspection.model).toBe('')
    expect(inspection.actualBaseUrl).toBe('')
    expect(inspection.matchesRelay).toBe(false)
  })

  it('marks a non-Xingmang relay as not ready to open', () => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'existing-key',
        ANTHROPIC_BASE_URL: 'https://other-relay.example.com',
      },
    }), 'utf8')

    const inspection = inspectProviderConfig('claude', providerRoots(home))
    expect(inspection.hasApiKey).toBe(true)
    expect(inspection.matchesRelay).toBe(false)
    expect(inspection.actualBaseUrl).toBe('https://other-relay.example.com')
  })

  it('does not expose the raw key in the renderer-safe summary', () => {
    const home = temporaryHome()
    saveProviderConfig('codex', 'sk-12345-secret-value-wxyz', 'gpt-5.5', 'reset', providerRoots(home), {}, providerBaseUrls)
    const summary = toNativeConfigSummary(inspectProviderConfig('codex', providerRoots(home)))
    expect(summary.apiKeyPreview).toBe('sk-12••••••••wxyz')
    expect(JSON.stringify(summary)).not.toContain('sk-12345-secret-value-wxyz')
    expect('apiKey' in summary).toBe(false)
  })

  it('rejects a provider directory junction before creating or replacing files', () => {
    const home = temporaryHome()
    const outside = temporaryHome()
    const providerDirectory = path.join(home, '.codex')
    fs.symlinkSync(outside, providerDirectory, 'junction')

    expect(() => saveProviderConfig('codex', 'sk-junction', 'gpt-5.5', 'reset', providerRoots(home), {}, providerBaseUrls))
      .toThrow(/符号链接|用户目录之外/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('rejects a directory or multiply-linked target without making a backup', () => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(configPath, { recursive: true })
    expect(() => saveProviderConfig('claude', 'sk-directory', 'claude-opus-4-6', 'merge', providerRoots(home), {}, providerBaseUrls))
      .toThrow(/普通文件/)
    expect(fs.readdirSync(path.dirname(configPath))).toEqual(['settings.json'])

    fs.rmSync(configPath, { recursive: true, force: true })
    const source = path.join(home, 'linked-source.json')
    fs.writeFileSync(source, '{}', 'utf8')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.linkSync(source, configPath)
    expect(() => saveProviderConfig('claude', 'sk-hardlink', 'claude-opus-4-6', 'merge', providerRoots(home), {}, providerBaseUrls))
      .toThrow(/普通文件/)
    expect(fs.readFileSync(source, 'utf8')).toBe('{}')
    expect(fs.readdirSync(path.dirname(configPath)).some((name) => name.includes('.bak.'))).toBe(false)
  })

  it('prunes old backups after a successful save while keeping the most recent ones', () => {
    const home = temporaryHome()
    saveProviderConfig('claude', 'sk-first', testModels.claude, 'reset', providerRoots(home), {}, providerBaseUrls)
    for (let index = 0; index < 7; index += 1) {
      saveProviderConfig('claude', `sk-${index}`, testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls)
    }
    const [configPath] = providerConfigPaths('claude', providerRoots(home))
    const backups = fs.readdirSync(path.dirname(configPath))
      .filter((name) => name.startsWith('settings.json.bak.'))
    expect(backups.length).toBeGreaterThan(0)
    expect(backups.length).toBeLessThanOrEqual(5)
  })
})

// 账号来源切换(星芒中转 ⇄ 用户自己的官方订阅)。本组的核心断言只有一条:
// 切换绝不能碰官方登录凭据 —— Codex 的 ChatGPT token 就住在同一个
// auth.json 里,删错一个键用户就要重新走浏览器登录,整个功能也就没意义了。
describe('switching a provider back to the official subscription account', () => {
  function chatGptTokens() {
    return {
      id_token: 'header.payload.signature',
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      account_id: 'account-uuid',
    }
  }

  function seedCodexRelayConfigWithChatGptLogin(home: string) {
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', providerRoots(home), {}, providerBaseUrls)
    const [, authPath] = providerConfigPaths('codex', providerRoots(home))
    // Codex 的订阅登录与 API Key 共存于同一份 auth.json。
    fs.writeFileSync(authPath, JSON.stringify({
      OPENAI_API_KEY: 'sk-relay',
      tokens: chatGptTokens(),
      last_refresh: '2026-08-12T00:00:00Z',
    }, null, 2))
  }

  it('keeps the ChatGPT login in auth.json and only drops the relay key', () => {
    const home = temporaryHome()
    seedCodexRelayConfigWithChatGptLogin(home)

    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)

    const [, authPath] = providerConfigPaths('codex', providerRoots(home))
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>
    expect(auth.OPENAI_API_KEY).toBeUndefined()
    expect(auth.tokens).toEqual(chatGptTokens())
    expect(auth.last_refresh).toBe('2026-08-12T00:00:00Z')
  })

  it('removes the relay provider table and model overrides so Codex falls back to its built-in openai provider', () => {
    const home = temporaryHome()
    seedCodexRelayConfigWithChatGptLogin(home)

    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)

    const [configPath] = providerConfigPaths('codex', providerRoots(home))
    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))
    expect(parsed?.model_provider).toBeUndefined()
    expect(parsed?.model_providers).toBeUndefined()
    // 中转的模型名未必存在于官方目录,留着会让 Codex 启动即报错。
    expect(parsed?.model).toBeUndefined()
    expect(parsed?.review_model).toBeUndefined()
    // 与中转无关的设置原样保留。
    expect(parsed?.disable_response_storage).toBe(true)
  })

  it('leaves a user-authored provider table alone while removing only the relay one', () => {
    const home = temporaryHome()
    seedCodexRelayConfigWithChatGptLogin(home)
    const [configPath] = providerConfigPaths('codex', providerRoots(home))
    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))!
    const providers = asRecord(parsed.model_providers)!
    providers.mine = { name: 'mine', base_url: 'https://example.invalid/v1' }
    fs.writeFileSync(configPath, TOML.stringify(parsed as never))

    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)

    const after = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))
    const remaining = asRecord(after?.model_providers)
    expect(Object.keys(remaining ?? {})).toEqual(['mine'])
  })

  it('drops only the two relay env entries from Claude settings.json, never the credential store', () => {
    const home = temporaryHome()
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', providerRoots(home), {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('claude', providerRoots(home))
    const seeded = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const env = seeded.env as Record<string, unknown>
    env.MY_OWN_VARIABLE = 'keep-me'
    fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2))

    switchProviderToOfficialAccount('claude', providerRoots(home), {}, providerBaseUrls)

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const afterEnv = after.env as Record<string, unknown>
    expect(afterEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(afterEnv.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(afterEnv.MY_OWN_VARIABLE).toBe('keep-me')
    // Claude 的订阅凭据在 .credentials.json / 钥匙串里,本模块从不触碰。
    expect(after.permissions).toBeDefined()
  })

  it('switches Gemini back to Google OAuth and strips its three relay env entries, keeping the rest of .env', () => {
    const home = temporaryHome()
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'reset', providerRoots(home), {}, providerBaseUrls)
    const [settingsPath, envPath] = providerConfigPaths('gemini', providerRoots(home))
    fs.appendFileSync(envPath, 'MY_OWN_VARIABLE=keep-me\n')

    switchProviderToOfficialAccount('gemini', providerRoots(home), {}, providerBaseUrls)

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    const security = asRecord(settings.security)
    expect(asRecord(security?.auth)?.selectedType).toBe('oauth-personal')
    const env = fs.readFileSync(envPath, 'utf8')
    expect(env).not.toContain('GEMINI_API_KEY')
    expect(env).not.toContain('GOOGLE_GEMINI_BASE_URL')
    expect(env).not.toContain('GEMINI_MODEL')
    expect(env).toContain('MY_OWN_VARIABLE=keep-me')
  })

  it('refuses to touch a configuration that points at somebody else\'s relay', () => {
    const home = temporaryHome()
    saveProviderConfig('claude', 'sk-third-party', testModels.claude, 'reset', providerRoots(home), {}, {
      ...providerBaseUrls,
      claude: 'https://not-xingmang.invalid',
    })

    expect(() => switchProviderToOfficialAccount('claude', providerRoots(home), {}, providerBaseUrls))
      .toThrow(/不是星芒中转/)
  })

  it('refuses a second switch instead of rewriting an already-official configuration', () => {
    const home = temporaryHome()
    seedCodexRelayConfigWithChatGptLogin(home)
    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)

    expect(() => switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls))
      .toThrow(/已经在使用/)
  })

  it('backs every touched file up before rewriting it, so the switch is reversible by hand too', () => {
    const home = temporaryHome()
    seedCodexRelayConfigWithChatGptLogin(home)

    const result = switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)

    expect(result.files).toHaveLength(2)
    expect(result.backups).toHaveLength(2)
    for (const backup of result.backups) expect(fs.existsSync(backup)).toBe(true)
  })

  it('reports Grok as unswitchable -- xAI CLI has no subscription login to fall back to', () => {
    expect(providerSupportsOfficialAccount('grok')).toBe(false)
    expect(providerSupportsOfficialAccount('codex')).toBe(true)
    const home = temporaryHome()
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', providerRoots(home), {}, providerBaseUrls)
    expect(() => switchProviderToOfficialAccount('grok', providerRoots(home), {}, providerBaseUrls))
      .toThrow(/只支持 API Key 登录/)
  })

  it('classifies the account mode from an inspection', () => {
    const home = temporaryHome()
    expect(providerAccountMode(inspectProviderConfig('codex', providerRoots(home), providerBaseUrls))).toBe('official')

    seedCodexRelayConfigWithChatGptLogin(home)
    expect(providerAccountMode(inspectProviderConfig('codex', providerRoots(home), providerBaseUrls))).toBe('relay')

    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)
    expect(providerAccountMode(inspectProviderConfig('codex', providerRoots(home), providerBaseUrls))).toBe('official')
  })
})

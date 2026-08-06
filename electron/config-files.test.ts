import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as TOML from '@iarna/toml'
import {
  inspectProviderConfig,
  providerConfigPaths,
  saveProviderConfig,
  toNativeConfigSummary,
} from './config-files'
import type { ProviderId } from './catalog'

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

afterEach(() => {
  for (const directory of temporaryHomes.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('native CLI configuration files', () => {
  it('refuses to merge an oversized existing config without modifying it', () => {
    const home = temporaryHome()
    const configPath = providerConfigPaths('codex', home)[0]
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8')

    expect(() => saveProviderConfig('codex', 'sk-new-key', 'gpt-5.6-sol', 'merge', home))
      .toThrow('2048 KB 安全上限')
    expect(fs.statSync(configPath).size).toBe(2 * 1024 * 1024 + 1)
  })

  it.each(['claude', 'codex', 'gemini', 'grok'] as ProviderId[])(
    'creates and detects %s configuration',
    (provider) => {
      const home = temporaryHome()
      const model = testModels[provider]
      const result = saveProviderConfig(provider, 'sk-user-key', model, 'reset', home)
      expect(result.backups).toEqual([])
      expect(result.files.every((filePath) => fs.existsSync(filePath))).toBe(true)

      const inspection = inspectProviderConfig(provider, home)
      expect(inspection.exists).toBe(true)
      expect(inspection.apiKey).toBe('sk-user-key')
      expect(inspection.hasApiKey).toBe(true)
      expect(inspection.matchesRelay).toBe(true)
      expect(inspection.model).toBe(model)

      const paths = providerConfigPaths(provider, home)
      if (provider === 'claude') {
        const settings = JSON.parse(fs.readFileSync(paths[0], 'utf8'))
        expect(settings).toEqual({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-user-key',
            ANTHROPIC_BASE_URL: 'https://api.solov.cc',
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
          'GOOGLE_GEMINI_BASE_URL=https://api.solov.cc',
          'GEMINI_API_KEY=sk-user-key',
          `GEMINI_MODEL=${model}`,
          '',
        ].join('\n'))
      }
      if (provider === 'grok') {
        const settings = TOML.parse(fs.readFileSync(paths[0], 'utf8'))
        expect(settings.models).toEqual({ default: 'grok', web_search: 'grok' })
        expect(settings.model.grok).toMatchObject({
          model,
          base_url: 'https://api.solov.cc/v1',
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
      const expectedDirectory = path.dirname(providerConfigPaths(provider, home)[0])
      const before = inspectProviderConfig(provider, home)
      expect(before.dataDirectory).toBe(expectedDirectory)
      expect(before.dataDirectoryExists).toBe(false)

      fs.mkdirSync(expectedDirectory, { recursive: true })
      const after = inspectProviderConfig(provider, home)
      expect(after.dataDirectory).toBe(expectedDirectory)
      expect(after.dataDirectoryExists).toBe(true)
      expect(after.exists).toBe(false)
    },
  )

  it.each(['claude', 'codex', 'gemini', 'grok'] as ProviderId[])(
    'clears detected %s configuration after its files are removed',
    (provider) => {
      const home = temporaryHome()
      saveProviderConfig(provider, 'sk-user-key', testModels[provider], 'reset', home)
      for (const filePath of providerConfigPaths(provider, home)) {
        fs.rmSync(filePath, { force: true })
      }

      const inspection = inspectProviderConfig(provider, home)
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
    saveProviderConfig('claude', 'old-key', testModels.claude, 'reset', home)
    const [settingsPath] = providerConfigPaths('claude', home)
    const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    existing.customSetting = { enabled: true }
    existing.env.CUSTOM_TOKEN = 'preserved'
    fs.writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')

    const result = saveProviderConfig('claude', 'new-key', 'claude-sonnet-4-6', 'merge', home)
    expect(result.backups).toHaveLength(1)
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(merged.env.ANTHROPIC_AUTH_TOKEN).toBe('new-key')
    expect(merged.model).toBe('claude-sonnet-4-6')
    expect(merged.env.CUSTOM_TOKEN).toBe('preserved')
    expect(merged.customSetting).toEqual({ enabled: true })
  })

  it('backs up Codex files and preserves its existing provider identifier', () => {
    const home = temporaryHome()
    const [configPath, authPath] = providerConfigPaths('codex', home)
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

    const result = saveProviderConfig('codex', 'new-key', testModels.codex, 'reset', home)
    expect(result.backups).toHaveLength(2)
    expect(result.backups.every((filePath) => fs.existsSync(filePath))).toBe(true)

    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(parsed.model_provider).toBe('mycodex')
    expect(parsed.model_providers.mycodex.name).toBe('mycodex')
    expect(parsed.model_providers.mycodex.base_url).toBe('https://api.solov.cc')
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY).toBe('new-key')
  })

  it('merges Codex credentials and models while preserving provider settings', () => {
    const home = temporaryHome()
    saveProviderConfig('codex', 'old-key', testModels.codex, 'reset', home)
    const [configPath, authPath] = providerConfigPaths('codex', home)
    const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    config.custom_setting = 'preserved'
    config.model_providers.OpenAI.custom_header = 'preserved'
    fs.writeFileSync(configPath, TOML.stringify(config), 'utf8')
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    auth.CUSTOM_AUTH = 'preserved'
    fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8')

    const result = saveProviderConfig('codex', 'new-key', 'gpt-5.6-sol', 'merge', home)
    expect(result.backups).toHaveLength(2)
    const mergedConfig = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    const mergedAuth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    expect(mergedConfig.model).toBe('gpt-5.6-sol')
    expect(mergedConfig.review_model).toBe('gpt-5.6-sol')
    expect(mergedConfig.custom_setting).toBe('preserved')
    expect(mergedConfig.model_providers.OpenAI.custom_header).toBe('preserved')
    expect(mergedAuth.OPENAI_API_KEY).toBe('new-key')
    expect(mergedAuth.CUSTOM_AUTH).toBe('preserved')
  })

  it('rolls back every Codex file when replacing the second file fails', () => {
    const home = temporaryHome()
    const [configPath, authPath] = providerConfigPaths('codex', home)
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
      home,
      {
        beforeReplace: (_targetPath, index) => {
          if (index === 1) throw new Error('injected second-file failure')
        },
      },
    )).toThrow('injected second-file failure')

    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig)
    expect(fs.readFileSync(authPath, 'utf8')).toBe(originalAuth)
    expect(fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes('rollback'))).toEqual([])
  })

  it('merges Gemini env values while preserving other env and settings entries', () => {
    const home = temporaryHome()
    saveProviderConfig('gemini', 'old-key', testModels.gemini, 'reset', home)
    const [settingsPath, envPath] = providerConfigPaths('gemini', home)
    const settingsBefore = fs.readFileSync(settingsPath, 'utf8')
    fs.appendFileSync(envPath, 'CUSTOM_VALUE=preserved\n', 'utf8')

    const result = saveProviderConfig('gemini', 'new-key', 'gemini-3.5-pro', 'merge', home)
    expect(result.backups).toHaveLength(1)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore)
    expect(fs.readFileSync(envPath, 'utf8')).toContain('GOOGLE_GEMINI_BASE_URL=https://api.solov.cc')
    expect(fs.readFileSync(envPath, 'utf8')).toContain('GEMINI_API_KEY=new-key')
    expect(fs.readFileSync(envPath, 'utf8')).toContain('GEMINI_MODEL=gemini-3.5-pro')
    expect(fs.readFileSync(envPath, 'utf8')).toContain('CUSTOM_VALUE=preserved')
  })

  it('merges the active Grok model while preserving the rest of its TOML', () => {
    const home = temporaryHome()
    saveProviderConfig('grok', 'old-key', testModels.grok, 'reset', home)
    const [configPath] = providerConfigPaths('grok', home)
    const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    config.custom_setting = 'preserved'
    config.model.grok.custom_option = true
    fs.writeFileSync(configPath, TOML.stringify(config), 'utf8')

    const result = saveProviderConfig('grok', 'new-key', 'grok-5', 'merge', home)
    expect(result.backups).toHaveLength(1)
    const merged = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(merged.model.grok.api_key).toBe('new-key')
    expect(merged.model.grok.model).toBe('grok-5')
    expect(merged.model.grok.base_url).toBe('https://api.solov.cc/v1')
    expect(merged.model.grok.custom_option).toBe(true)
    expect(merged.custom_setting).toBe('preserved')
  })

  it('reads a Grok key from the existing default model even when its name is custom', () => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('grok', home)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      '[models]',
      'default = "sub2api-grok"',
      '',
      '[model."sub2api-grok"]',
      'api_key = "existing-key"',
      '',
    ].join('\n'), 'utf8')
    expect(inspectProviderConfig('grok', home).apiKey).toBe('existing-key')
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
    const [configPath, authPath] = providerConfigPaths('codex', home)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model_provider = "active"',
      'model = "gpt-active"',
      '',
      ...activeProvider,
      '',
      '[model_providers.inactive]',
      'name = "inactive"',
      'base_url = "https://api.solov.cc"',
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{"OPENAI_API_KEY":"existing-key"}\n', 'utf8')

    const inspection = inspectProviderConfig('codex', home)
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
    const [configPath] = providerConfigPaths('grok', home)
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
      'base_url = "https://api.solov.cc/v1"',
      '',
    ].join('\n'), 'utf8')

    const inspection = inspectProviderConfig('grok', home)
    expect(inspection.apiKey).toBe('active-key')
    expect(inspection.model).toBe('grok-active')
    expect(inspection.actualBaseUrl).toBe(expectedBaseUrl)
    expect(inspection.matchesRelay).toBe(false)
  })

  it('reads no Grok credentials or model when the default target is absent', () => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('grok', home)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      '[models]',
      'default = "missing"',
      '',
      '[model.inactive]',
      'model = "grok-inactive"',
      'api_key = "inactive-key"',
      'base_url = "https://api.solov.cc/v1"',
      '',
    ].join('\n'), 'utf8')

    const inspection = inspectProviderConfig('grok', home)
    expect(inspection.apiKey).toBe('')
    expect(inspection.hasApiKey).toBe(false)
    expect(inspection.model).toBe('')
    expect(inspection.actualBaseUrl).toBe('')
    expect(inspection.matchesRelay).toBe(false)
  })

  it('marks a non-Xingmang relay as not ready to open', () => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('claude', home)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'existing-key',
        ANTHROPIC_BASE_URL: 'https://other-relay.example.com',
      },
    }), 'utf8')

    const inspection = inspectProviderConfig('claude', home)
    expect(inspection.hasApiKey).toBe(true)
    expect(inspection.matchesRelay).toBe(false)
    expect(inspection.actualBaseUrl).toBe('https://other-relay.example.com')
  })

  it('does not expose the raw key in the renderer-safe summary', () => {
    const home = temporaryHome()
    saveProviderConfig('codex', 'sk-12345-secret-value-wxyz', 'gpt-5.5', 'reset', home)
    const summary = toNativeConfigSummary(inspectProviderConfig('codex', home))
    expect(summary.apiKeyPreview).toBe('sk-12••••••••wxyz')
    expect(JSON.stringify(summary)).not.toContain('sk-12345-secret-value-wxyz')
    expect('apiKey' in summary).toBe(false)
  })

  it('rejects a provider directory junction before creating or replacing files', () => {
    const home = temporaryHome()
    const outside = temporaryHome()
    const providerDirectory = path.join(home, '.codex')
    fs.symlinkSync(outside, providerDirectory, 'junction')

    expect(() => saveProviderConfig('codex', 'sk-junction', 'gpt-5.5', 'reset', home))
      .toThrow(/符号链接|用户目录之外/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('rejects a directory or multiply-linked target without making a backup', () => {
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('claude', home)
    fs.mkdirSync(configPath, { recursive: true })
    expect(() => saveProviderConfig('claude', 'sk-directory', 'claude-opus-4-6', 'merge', home))
      .toThrow(/普通文件/)
    expect(fs.readdirSync(path.dirname(configPath))).toEqual(['settings.json'])

    fs.rmSync(configPath, { recursive: true, force: true })
    const source = path.join(home, 'linked-source.json')
    fs.writeFileSync(source, '{}', 'utf8')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.linkSync(source, configPath)
    expect(() => saveProviderConfig('claude', 'sk-hardlink', 'claude-opus-4-6', 'merge', home))
      .toThrow(/普通文件/)
    expect(fs.readFileSync(source, 'utf8')).toBe('{}')
    expect(fs.readdirSync(path.dirname(configPath)).some((name) => name.includes('.bak.'))).toBe(false)
  })

  it('prunes old backups after a successful save while keeping the most recent ones', () => {
    const home = temporaryHome()
    saveProviderConfig('claude', 'sk-first', testModels.claude, 'reset', home)
    for (let index = 0; index < 7; index += 1) {
      saveProviderConfig('claude', `sk-${index}`, testModels.claude, 'merge', home)
    }
    const [configPath] = providerConfigPaths('claude', home)
    const backups = fs.readdirSync(path.dirname(configPath))
      .filter((name) => name.startsWith('settings.json.bak.'))
    expect(backups.length).toBeGreaterThan(0)
    expect(backups.length).toBeLessThanOrEqual(5)
  })
})

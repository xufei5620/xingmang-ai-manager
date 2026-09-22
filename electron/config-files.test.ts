import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as TOML from '@iarna/toml'
import {
  buildCodexApiKeyAuth,
  canLaunchManagedProvider,
  geminiCliCompatibleModel,
  classifyCodexAuthProfile,
  classifyCodexConfigProfile,
  claudeConsoleKeySnapshotName,
  codexApiKeyAuthSnapshotName,
  codexAuthSnapshotPaths,
  codexChatGptAuthSnapshotName,
  codexConfigSnapshotPaths,
  defaultCodexRelayProvider,
  ensureCodexPermissionDefaultsInConfigText,
  ensureGeminiContextFilenamesInSettingsText,
  ensureGeminiProjectContextFiles,
  inspectOfficialLogin,
  inspectProviderConfig,
  inspectCodexWorkspacePermissionsText,
  managedProviderLaunchBlockedMessage,
  moveClaudeConsoleKeyAside,
  moveClaudeConsoleKeyAsideTexts,
  providerAccountMode,
  providerConfigPaths,
  restoreClaudeConsoleKey,
  restoreClaudeConsoleKeyTexts,
  saveProviderConfig,
  snapshotCodexChatGptAuth,
  switchProviderToOfficialAccount,
  trustClaudeWorkspace,
  trustClaudeWorkspaceInRootConfigText,
  trustCodexWorkspace,
  trustCodexWorkspaceInConfigText,
  trustGeminiWorkspace,
  trustGeminiWorkspaceInTrustedFoldersText,
  trustManagedWorkspace,
  toNativeConfigSummary,
} from './config-files'
import { providerBaseUrls, type ProviderId } from './catalog'

const temporaryHomes: string[] = []
const statusLineCommand = '"/managed/node/bin/node" "/opt/app/resources/bundled-catalog/cli-status-line/xingmang-statusline.cjs"'
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
  it('adds a relay tier suffix that avoids Gemini CLI 0.59 flash model rewriting', () => {
    expect(geminiCliCompatibleModel('gemini-3.7-flash')).toBe('gemini-3.7-flash-high')
    expect(geminiCliCompatibleModel('gemini-3.8-flash')).toBe('gemini-3.8-flash-high')
    expect(geminiCliCompatibleModel('gemini-3.8-flash-medium')).toBe('gemini-3.8-flash-medium')
    expect(geminiCliCompatibleModel('gemini-3.5-flash')).toBe('gemini-3.5-flash')
  })
  it('retains the exact Gemini high-tier model when saving and reading a new configuration', () => {
    const roots = providerRoots(temporaryHome())
    saveProviderConfig('gemini', 'sk-fixture', 'gemini-3.8-flash-high', 'reset', roots, {}, providerBaseUrls)
    const inspection = inspectProviderConfig('gemini', roots, providerBaseUrls)
    expect(inspection.model).toBe('gemini-3.8-flash-high')
    expect(toNativeConfigSummary(inspection).model).toBe('gemini-3.8-flash-high')
    saveProviderConfig('gemini', 'sk-fixture', 'gemini-3.8-flash-high', 'merge', roots, {}, providerBaseUrls)
    expect(inspectProviderConfig('gemini', roots, providerBaseUrls).model).toBe('gemini-3.8-flash-high')
  })
  it('diagnoses the Codex permission picker from trust and approval settings', () => {
    const config = [
      'approval_policy = "unless-trusted"',
      'sandbox_mode = "workspace-write"',
      '',
      '[projects."C:\\\\Users\\\\tester\\\\project"]',
      'trust_level = "untrusted"',
      '',
    ].join('\n')
    const status = inspectCodexWorkspacePermissionsText(config, 'c:/users/TESTER/project')
    expect(status.trustLevel).toBe('untrusted')
    expect(status.approvalPolicy).toBe('unless-trusted')
    expect(status.sandboxMode).toBe('workspace-write')
    expect(status.control).toBe('restricted')

    const trusted = inspectCodexWorkspacePermissionsText(
      config.replace('trust_level = "untrusted"', 'trust_level = "trusted"'),
      'C:\\Users\\tester\\project',
    )
    expect(trusted.control).toBe('available')
  })

  it('trusts only the selected Codex workspace and adds safe missing defaults', () => {
    const result = trustCodexWorkspaceInConfigText(
      '[projects."D:\\\\Work"]\ntrust_level = "untrusted"\n',
      'd:/work',
    )
    expect(result.changed).toBe(true)
    const parsed = TOML.parse(result.content) as Record<string, unknown>
    expect(parsed.approval_policy).toBe('on-request')
    expect(parsed.sandbox_mode).toBe('workspace-write')
    expect(asRecord(asRecord(parsed.projects)?.['D:\\Work'])?.trust_level).toBe('trusted')
    expect(result.content).not.toContain('D:\\Other')
  })

  it('does not override an explicit never approval policy', () => {
    const result = trustCodexWorkspaceInConfigText(
      'approval_policy = "never"\n',
      'C:\\Work',
    )
    const parsed = TOML.parse(result.content) as Record<string, unknown>
    expect(parsed.approval_policy).toBe('never')
    expect(parsed.sandbox_mode).toBe('workspace-write')
    expect(inspectCodexWorkspacePermissionsText(result.content, 'C:\\Work').control).toBe('restricted')
  })

  it('adds permission defaults without rewriting an already complete config', () => {
    const missing = ensureCodexPermissionDefaultsInConfigText('model = "gpt-5"\n')
    expect(missing.changed).toBe(true)
    expect(TOML.parse(missing.content)).toMatchObject({
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
    })
    const complete = ensureCodexPermissionDefaultsInConfigText(missing.content)
    expect(complete.changed).toBe(false)
    expect(complete.content).toBe(missing.content)
  })

  it('writes a trusted workspace transaction with a recoverable backup', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'approval_policy = "unless-trusted"\n', 'utf8')

    const result = trustCodexWorkspace(roots, path.join(home, 'project'))
    expect(result.changed).toBe(true)
    expect(result.status.trustLevel).toBe('trusted')
    expect(result.status.control).toBe('available')
    expect(result.backups).toHaveLength(1)
    expect(fs.readFileSync(configPath, 'utf8')).toContain('trust_level = "trusted"')
    expect(fs.existsSync(result.backups[0])).toBe(true)
  })

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
    expect(rewritten.model_provider).toBe(defaultCodexRelayProvider)
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

  it('uses XingmangAI as the Codex model provider when the user has no config yet', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)

    saveProviderConfig('codex', 'sk-first', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))!
    expect(parsed.model_provider).toBe('XingmangAI')
    expect(parsed).not.toHaveProperty('model_context_window')
    expect(parsed).not.toHaveProperty('model_auto_compact_token_limit')
    expect(parsed.approval_policy).toBe('on-request')
    expect(parsed.sandbox_mode).toBe('workspace-write')
    expect(asRecord(parsed.model_providers)?.XingmangAI).toMatchObject({
      name: 'XingmangAI',
      base_url: 'https://xm.solov.cc/v1',
      wire_api: 'responses',
      requires_openai_auth: true,
    })
    expect(asRecord(parsed.model_providers)?.OpenAI).toBeUndefined()

    const mergeHome = temporaryHome()
    const mergeRoots = providerRoots(mergeHome)
    const [mergeConfigPath] = providerConfigPaths('codex', mergeRoots)
    saveProviderConfig('codex', 'sk-merge-first', testModels.codex, 'merge', mergeRoots, {}, providerBaseUrls)
    const merged = asRecord(TOML.parse(fs.readFileSync(mergeConfigPath, 'utf8')))!
    expect(merged.model_provider).toBe(defaultCodexRelayProvider)
    expect(merged).not.toHaveProperty('model_context_window')
    expect(merged).not.toHaveProperty('model_auto_compact_token_limit')
  })

  it.each(['merge', 'reset'] as const)('keeps non-GPT model IDs on Responses during %s', (mode) => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)

    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model_provider = "XingmangAI"',
      '[model_providers.XingmangAI]',
      'base_url = "https://xm.solov.cc/v1"',
      'wire_api = "chat"',
      '',
    ].join('\n'), 'utf8')

    saveProviderConfig('codex', 'sk-key', 'deepseek-v4-flash', mode, roots, {}, providerBaseUrls)

    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))!
    expect(parsed.model).toBe('deepseek-v4-flash')
    expect(parsed.review_model).toBe('deepseek-v4-flash')
    expect(asRecord(parsed.model_providers)?.XingmangAI).toMatchObject({
      base_url: 'https://xm.solov.cc/v1',
      wire_api: 'responses',
    })
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
            DISABLE_AUTOUPDATER: '1',
          },
          permissions: { defaultMode: 'bypassPermissions', deny: ['Artifact'] },
          model,
          effortLevel: 'medium',
          skipDangerousModePermissionPrompt: true,
          skipWebFetchPreflight: true,
          language: '简体中文',
          cleanupPeriodDays: 365,
        })
      }
      if (provider === 'gemini') {
        const settings = JSON.parse(fs.readFileSync(paths[0], 'utf8'))
        expect(settings).toMatchObject({
          general: {
            enableAutoUpdate: false,
            enableAutoUpdateNotification: false,
            sessionRetention: { maxAge: '365d' },
          },
          ide: { enabled: true },
          security: { auth: { selectedType: 'gemini-api-key' } },
        })
        expect(Object.keys(settings).sort()).toEqual(['general', 'ide', 'modelConfigs', 'security'])
        expect(fs.readFileSync(paths[1], 'utf8')).toBe([
          'GOOGLE_GEMINI_BASE_URL=https://xm.solov.cc',
          'GEMINI_API_KEY=sk-user-key',
          `GEMINI_MODEL=${model}`,
          '',
        ].join('\n'))
      }
      if (provider === 'grok') {
        const settings = TOML.parse(fs.readFileSync(paths[0], 'utf8'))
        expect(settings.cli).toEqual({ auto_update: false })
        expect(settings.models).toEqual({ default: 'grok', web_search: 'grok' })
        expect(settings.endpoints).toEqual({ xai_api_base_url: 'https://xm.solov.cc/v1' })
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
    expect(merged.env.DISABLE_AUTOUPDATER).toBe('1')
    expect(merged.model).toBe('claude-sonnet-4-6')
    expect(merged.env.CUSTOM_TOKEN).toBe('preserved')
    expect(merged.customSetting).toEqual({ enabled: true })
    expect(merged.permissions).toEqual({ defaultMode: 'bypassPermissions', deny: ['Artifact'] })
    expect(merged.skipWebFetchPreflight).toBe(true)
  })

  it('appends Artifact to an existing Claude deny list without touching the entries the user wrote', () => {
    const home = temporaryHome()
    const [settingsPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      permissions: { defaultMode: 'acceptEdits', deny: ['Bash(rm:*)'], allow: ['Read'] },
    }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(merged.permissions).toEqual({
      defaultMode: 'acceptEdits',
      deny: ['Bash(rm:*)', 'Artifact'],
      allow: ['Read'],
    })
  })

  it('does not duplicate Artifact when merging twice over a Claude config', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('claude', 'old-key', testModels.claude, 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', roots, {}, providerBaseUrls)

    const [settingsPath] = providerConfigPaths('claude', roots)
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(merged.permissions)?.deny).toEqual(['Artifact'])
  })

  it('extends Claude transcript retention and pins the response language when merging over a bare config', () => {
    const home = temporaryHome()
    const [settingsPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({ env: { CUSTOM_TOKEN: 'preserved' } }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(merged.cleanupPeriodDays).toBe(365)
    expect(merged.language).toBe('简体中文')
  })

  it('leaves the Claude retention period and language alone when the user already chose them', () => {
    const home = temporaryHome()
    const [settingsPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      cleanupPeriodDays: 7,
      language: 'japanese',
    }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(merged.cleanupPeriodDays).toBe(7)
    expect(merged.language).toBe('japanese')
  })

  it('writes the bundled status line into a fresh Claude config when a command is given', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls, statusLineCommand)

    const [settingsPath] = providerConfigPaths('claude', roots)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(settings.statusLine).toEqual({ type: 'command', command: statusLineCommand })
  })

  it('writes no status line at all when no command is given', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)

    const [settingsPath] = providerConfigPaths('claude', roots)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect('statusLine' in settings).toBe(false)
  })

  it('adds the status line when merging over a config that has none', () => {
    const home = temporaryHome()
    const [settingsPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({ env: { CUSTOM_TOKEN: 'preserved' } }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls, statusLineCommand)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(merged.statusLine).toEqual({ type: 'command', command: statusLineCommand })
  })

  it('leaves a status line the user configured himself untouched', () => {
    const home = temporaryHome()
    const [settingsPath] = providerConfigPaths('claude', providerRoots(home))
    const own = { type: 'command', command: 'bun run ~/ccstatusline.ts', padding: 0 }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({ statusLine: own }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls, statusLineCommand)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(merged.statusLine).toEqual(own)
  })

  it('points our own status line at the new location after the app moved', () => {
    const home = temporaryHome()
    const [settingsPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      statusLine: { type: 'command', command: '"C:\\Old\\node.exe" "C:\\Old\\xingmang-statusline.cjs"' },
    }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls, statusLineCommand)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(merged.statusLine).toEqual({ type: 'command', command: statusLineCommand })
  })

  it('rejects a status line command with a line break', () => {
    const home = temporaryHome()
    expect(() => saveProviderConfig(
      'claude', 'sk-relay', testModels.claude, 'reset', providerRoots(home), {}, providerBaseUrls,
      `${statusLineCommand}\nrm -rf /`,
    )).toThrow('状态行命令不能包含换行符')
  })

  it('keeps the Claude retention period and language after switching back to the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

    const [settingsPath] = providerConfigPaths('claude', roots)
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(after.cleanupPeriodDays).toBe(365)
    expect(after.language).toBe('简体中文')
  })

  it('extends Gemini session retention when merging over settings without that section', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({ general: { vimMode: true } }, null, 2)}\n`, 'utf8')

    saveProviderConfig('gemini', 'new-key', testModels.gemini, 'merge', roots, {}, providerBaseUrls)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(merged.general)?.sessionRetention).toEqual({ maxAge: '365d' })
    expect(asRecord(merged.general)?.vimMode).toBe(true)
  })

  it('leaves an existing Gemini sessionRetention section exactly as the user wrote it', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      general: { sessionRetention: { enabled: false } },
    }, null, 2)}\n`, 'utf8')

    saveProviderConfig('gemini', 'new-key', testModels.gemini, 'merge', roots, {}, providerBaseUrls)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(merged.general)?.sessionRetention).toEqual({ enabled: false })
  })

  it('turns off the Claude self-updater when merging over settings the user already wrote', () => {
    const home = temporaryHome()
    const [settingsPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      env: { CUSTOM_TOKEN: 'preserved', DISABLE_AUTOUPDATER: '0' },
    }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(merged.env)?.DISABLE_AUTOUPDATER).toBe('1')
    expect(asRecord(merged.env)?.CUSTOM_TOKEN).toBe('preserved')
  })

  it('keeps the Claude self-updater off after switching back to the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

    const [settingsPath] = providerConfigPaths('claude', roots)
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    const env = asRecord(after.env)
    expect(env?.DISABLE_AUTOUPDATER).toBe('1')
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env?.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('turns off both Gemini update switches when merging without touching other general settings', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      general: { vimMode: true, enableAutoUpdate: true, enableAutoUpdateNotification: true },
    }, null, 2)}\n`, 'utf8')

    saveProviderConfig('gemini', 'new-key', testModels.gemini, 'merge', roots, {}, providerBaseUrls)

    const general = asRecord(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).general)
    expect(general).toEqual({
      vimMode: true,
      enableAutoUpdate: false,
      enableAutoUpdateNotification: false,
      sessionRetention: { maxAge: '365d' },
    })
  })

  it('turns off the Codex startup update check when merging over an existing config', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, '[custom_official]\nenabled = true\n', 'utf8')

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    const merged = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(merged.check_for_update_on_startup).toBe(false)
    expect(merged.custom_official).toEqual({ enabled: true })
  })

  it('writes no Codex settings that the recommended version no longer recognizes', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    const written = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(written.disable_response_storage).toBeUndefined()
    expect(written.network_access).toBeUndefined()
    expect(written.windows_wsl_setup_acknowledged).toBeUndefined()
  })

  it('clears the Codex settings it used to write once they stop being recognized', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'disable_response_storage = true',
      'network_access = "enabled"',
      'windows_wsl_setup_acknowledged = true',
      '',
      '[custom_official]',
      'enabled = true',
      '',
    ].join('\n'), 'utf8')

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    const merged = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(merged.disable_response_storage).toBeUndefined()
    expect(merged.network_access).toBeUndefined()
    expect(merged.windows_wsl_setup_acknowledged).toBeUndefined()
    expect(merged.custom_official).toEqual({ enabled: true })
  })

  it('keeps values a user changed away from the ones it used to write', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'disable_response_storage = false',
      'network_access = "disabled"',
      'windows_wsl_setup_acknowledged = false',
      '',
      // 新版真正认的那一份在嵌套表里,不能跟着顶层旧键一起清掉。
      '[sandbox_workspace_write]',
      'network_access = true',
      '',
    ].join('\n'), 'utf8')

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    const merged = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(merged.disable_response_storage).toBe(false)
    expect(merged.network_access).toBe('disabled')
    expect(merged.windows_wsl_setup_acknowledged).toBe(false)
    expect(asRecord(merged.sandbox_workspace_write)?.network_access).toBe(true)
  })

  it('turns off the Grok launch update check when merging over an existing config', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('grok', 'old-key', testModels.grok, 'reset', roots, {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('grok', roots)
    const seeded = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    seeded.cli = { auto_update: true, show_tips: true }
    fs.writeFileSync(configPath, TOML.stringify(seeded as Parameters<typeof TOML.stringify>[0]), 'utf8')

    saveProviderConfig('grok', 'new-key', testModels.grok, 'merge', roots, {}, providerBaseUrls)

    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).cli).toEqual({
      auto_update: false,
      show_tips: true,
    })
  })

  it('routes Grok image and video tools to the relay instead of api.x.ai when merging', () => {
    // Those tools send the same api_key to endpoints.xai_api_base_url; left at
    // the xAI default, a relay key would leave for api.x.ai.
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('grok', 'old-key', testModels.grok, 'reset', roots, {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('grok', roots)
    const seeded = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    seeded.endpoints = { xai_api_base_url: 'https://api.x.ai/v1', feedback_base_url: 'https://example.invalid' }
    fs.writeFileSync(configPath, TOML.stringify(seeded as Parameters<typeof TOML.stringify>[0]), 'utf8')

    saveProviderConfig('grok', 'new-key', testModels.grok, 'merge', roots, {}, providerBaseUrls)

    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).endpoints).toEqual({
      xai_api_base_url: 'https://xm.solov.cc/v1',
      feedback_base_url: 'https://example.invalid',
    })
  })

  it('restores Gemini API-key auth mode when merging over an OAuth config', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('gemini', 'old-key', testModels.gemini, 'reset', roots, {}, providerBaseUrls)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    ;(settings.security as Record<string, unknown>).auth = { selectedType: 'oauth-personal' }
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')

    saveProviderConfig('gemini', 'new-key', 'gemini-3.5-pro', 'merge', roots, {}, providerBaseUrls)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(asRecord(merged.security)?.auth)?.selectedType).toBe('gemini-api-key')
    expect(inspectProviderConfig('gemini', roots).authType).toBe('gemini-api-key')
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
    expect(mycodexProvider?.base_url).toBe('https://xm.solov.cc/v1')
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY).toBe('new-key')
  })

  it('backs up and replaces a broken stored relay config only when reset was explicitly selected', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configs = codexConfigSnapshotPaths(roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    const official = 'model = "official-model"\ncustom_setting = "keep-official"\n'
    const brokenRelay = '[broken-relay\n'
    fs.writeFileSync(configs.active, official, 'utf8')
    fs.writeFileSync(configs.relay, brokenRelay, 'utf8')

    expect(() => saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls))
      .toThrow('已保存的星芒 Codex 配置 无法解析')
    expect(fs.readFileSync(configs.active, 'utf8')).toBe(official)
    const result = saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    expect(TOML.parse(fs.readFileSync(configs.active, 'utf8')).model).toBe(testModels.codex)
    expect(TOML.parse(fs.readFileSync(configs.active, 'utf8')).custom_setting).toBeUndefined()
    expect(fs.readFileSync(configs.chatgpt, 'utf8')).toBe(official)
    expect(fs.readFileSync(result.backups.find((file) => file.startsWith(`${configs.relay}.bak.`))!, 'utf8')).toBe(brokenRelay)
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
    ;(modelProviders.XingmangAI as Record<string, unknown>).custom_header = 'preserved'
    fs.writeFileSync(configPath, TOML.stringify(config), 'utf8')
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    auth.CUSTOM_AUTH = 'preserved'
    fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8')

    const result = saveProviderConfig('codex', 'new-key', 'gpt-5.6-sol', 'merge', roots, {}, providerBaseUrls)
    const mergedConfig = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    const mergedAuth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    expect(mergedConfig.model).toBe('gpt-5.6-sol')
    expect(mergedConfig.review_model).toBe('gpt-5.6-sol')
    expect(mergedConfig.custom_setting).toBe('preserved')
    expect(asRecord(asRecord(mergedConfig.model_providers)?.XingmangAI)?.custom_header).toBe('preserved')
    expect(asRecord(asRecord(mergedConfig.model_providers)?.XingmangAI)?.base_url).toBe('https://xm.solov.cc/v1')
    expect(mergedAuth).toEqual({ OPENAI_API_KEY: 'new-key' })
    expect(result.backups.length).toBeGreaterThanOrEqual(2)
    expect(fs.existsSync(path.join(userHome, '.codex'))).toBe(false)
  })

  it('fills the complete Codex relay provider contract during merge', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model_provider = "OpenAI"',
      '',
      '[model_providers.OpenAI]',
      'base_url = "https://legacy.example.com/v1"',
      'custom_header = "keep"',
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{}\n', 'utf8')

    saveProviderConfig('codex', 'new-key', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))
    const provider = asRecord(parsed?.model_providers)?.OpenAI
    expect(provider).toMatchObject({
      name: 'OpenAI',
      base_url: 'https://xm.solov.cc/v1',
      wire_api: 'responses',
      requires_openai_auth: true,
      custom_header: 'keep',
    })
  })

  it('does not select a user custom provider when model_provider is absent', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      '[model_providers.azure]',
      'name = "azure"',
      'base_url = "https://azure.example.com"',
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{}\n', 'utf8')

    saveProviderConfig('codex', 'new-key', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))!
    expect(parsed.model_provider).toBe('OpenAI')
    expect(asRecord(parsed.model_providers)?.azure).toMatchObject({ base_url: 'https://azure.example.com' })
    expect(asRecord(parsed.model_providers)?.OpenAI).toMatchObject({ base_url: 'https://xm.solov.cc/v1' })
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
    expect(result.backups).toHaveLength(2)
    const mergedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(asRecord(mergedSettings.security)?.auth)?.selectedType).toBe('gemini-api-key')
    expect(mergedSettings.ide).toEqual(JSON.parse(settingsBefore).ide)
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
    {
      name: 'the former bare relay URL',
      activeProvider: [
        '[model_providers.active]',
        'name = "active"',
        'base_url = "https://xm.solov.cc"',
      ],
      expectedBaseUrl: 'https://xm.solov.cc',
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
      'base_url = "https://xm.solov.cc/v1"',
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

  it('surfaces the ChatGPT email from Codex JWTs without sending the tokens across', () => {
    const home = temporaryHome()
    const [, authPath] = providerConfigPaths('codex', providerRoots(home))
    const jwt = (payload: Record<string, unknown>) => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
      return `${header}.${body}.sig`
    }
    const idToken = jwt({
      email: 'ivy@example.com',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'prolite',
        chatgpt_subscription_active_until: '2026-09-22T11:32:00.000Z',
      },
    })
    const accessToken = jwt({ 'https://api.openai.com/profile': { email: 'ivy@example.com' } })
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: 'rt.not-a-jwt',
        account_id: 'account-uuid',
      },
    }), 'utf8')

    const inspection = inspectProviderConfig('codex', providerRoots(home))
    const summary = toNativeConfigSummary(inspection)
    expect(inspection.officialAccountEmail).toBe('ivy@example.com')
    expect(inspection.codexAuthMode).toBe('chatgpt')
    expect(summary.officialAccountEmail).toBe('ivy@example.com')
    expect(summary.codexAuthMode).toBe('chatgpt')
    expect(summary.officialAccountPlan).toBe('Pro 5x')
    expect(summary.officialAccountRenewsAt).toBe('2026-09-22T11:32:00.000Z')
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain(idToken)
    expect(serialized).not.toContain(accessToken)
    expect(serialized).not.toContain('rt.not-a-jwt')
    expect(inspection.hasApiKey).toBe(false)
    expect(providerAccountMode(inspection)).toBe('official')
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
    expect(auth.auth_mode).toBe('chatgpt')
    expect(auth.tokens).toEqual(chatGptTokens())
    expect(auth.last_refresh).toBe('2026-08-12T00:00:00Z')
    expect(Object.keys(auth)).toEqual(['auth_mode', 'tokens', 'last_refresh'])
  })

  it('stores the ChatGPT auth.json aside and writes a key-only file when switching to Xingmang', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    const snapshots = codexAuthSnapshotPaths(roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model = "gpt-5.3-codex-spark"',
      'model_provider = "OpenAI"',
      '',
      '[model_providers.OpenAI]',
      'name = "OpenAI"',
      'base_url = "https://api.openai.com/v1"',
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: chatGptTokens(),
      last_refresh: '2026-08-12T00:00:00Z',
    }, null, 2))

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-relay' })
    expect(JSON.parse(fs.readFileSync(snapshots.chatgpt, 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      tokens: chatGptTokens(),
      last_refresh: '2026-08-12T00:00:00Z',
    })
    expect(JSON.parse(fs.readFileSync(snapshots.apikey, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-relay' })
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).codexAuthMode).toBe('apikey')
    expect(path.basename(snapshots.chatgpt)).toBe(codexChatGptAuthSnapshotName)
    expect(path.basename(snapshots.apikey)).toBe(codexApiKeyAuthSnapshotName)
  })

  it('restores the stored ChatGPT auth.json when switching back from Xingmang', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const snapshots = codexAuthSnapshotPaths(roots)
    fs.mkdirSync(path.dirname(snapshots.active), { recursive: true })
    fs.writeFileSync(snapshots.chatgpt, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: chatGptTokens(),
      last_refresh: '2026-08-12T00:00:00Z',
    }, null, 2))
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

    expect(JSON.parse(fs.readFileSync(snapshots.active, 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      tokens: chatGptTokens(),
      last_refresh: '2026-08-12T00:00:00Z',
    })
    expect(JSON.parse(fs.readFileSync(snapshots.apikey, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-relay' })
  })

  it('stores the official config.toml aside and restores it when switching back', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)
    const configs = codexConfigSnapshotPaths(roots)
    const officialConfig = [
      'model = "gpt-5.3-codex-spark"',
      'model_provider = "OpenAI"',
      'windows_wsl_setup_acknowledged = true',
      '',
      '[projects."E:\\\\work\\\\demo"]',
      'trust_level = "trusted"',
      '',
      '[model_providers.OpenAI]',
      'name = "OpenAI"',
      'base_url = "https://api.openai.com/v1"',
      '',
    ].join('\n')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, officialConfig, 'utf8')
    fs.writeFileSync(configs.active.replace('config.toml', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: chatGptTokens(),
    }, null, 2))

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    const liveAfterRelay = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))
    expect(liveAfterRelay?.model).toBe(testModels.codex)
    expect(asRecord(asRecord(liveAfterRelay?.model_providers)?.OpenAI)?.base_url).toBe('https://xm.solov.cc/v1')
    expect(fs.readFileSync(configs.chatgpt, 'utf8')).toContain('gpt-5.3-codex-spark')
    expect(fs.readFileSync(configs.chatgpt, 'utf8')).toContain('E:\\\\work\\\\demo')
    expect(fs.readFileSync(configs.chatgpt, 'utf8')).toContain('https://api.openai.com/v1')
    // 用户自己写的键留在他自己的官方配置快照里,切回去还在。
    expect(fs.readFileSync(configs.chatgpt, 'utf8')).toContain('windows_wsl_setup_acknowledged')
    expect(classifyCodexConfigProfile(liveAfterRelay, providerBaseUrls.codex)).toBe('relay')

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

    const restored = fs.readFileSync(configPath, 'utf8')
    expect(restored).toContain('gpt-5.3-codex-spark')
    expect(restored).toContain('E:\\\\work\\\\demo')
    expect(restored).toContain('https://api.openai.com/v1')
    expect(restored).not.toContain('https://xm.solov.cc/v1')
    expect(classifyCodexConfigProfile(
      asRecord(TOML.parse(restored)),
      providerBaseUrls.codex,
    )).toBe('official')
  })

  it('resets the official Codex profile without losing saved login, relay customizations, or history', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    seedCodexRelayConfigWithChatGptLogin(home)
    const configs = codexConfigSnapshotPaths(roots)
    const auth = codexAuthSnapshotPaths(roots)
    const sessions = path.join(roots.codexHome, 'sessions', 'existing.jsonl')
    const database = path.join(roots.codexHome, 'state_5.sqlite')
    fs.mkdirSync(path.dirname(sessions), { recursive: true })
    fs.writeFileSync(sessions, 'existing conversation\n', 'utf8')
    fs.writeFileSync(database, 'existing state database', 'utf8')
    fs.appendFileSync(configs.active, '\n[custom_relay]\nenabled = true\n')
    const relayBefore = fs.readFileSync(configs.active, 'utf8')
    const officialBefore = 'model = "official-custom-model"\n[custom_official]\nenabled = true\n'
    fs.writeFileSync(configs.chatgpt, officialBefore, 'utf8')
    const login = { auth_mode: 'chatgpt', tokens: chatGptTokens(), last_refresh: '2026-08-12T00:00:00Z' }
    fs.writeFileSync(auth.chatgpt, JSON.stringify(login), 'utf8')
    fs.writeFileSync(auth.active, JSON.stringify({ OPENAI_API_KEY: 'sk-relay' }), 'utf8')

    const result = switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset')

    const initial = TOML.parse(fs.readFileSync(configs.active, 'utf8'))
    expect(initial).toEqual({
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      check_for_update_on_startup: false,
    })
    expect(TOML.parse(fs.readFileSync(configs.chatgpt, 'utf8'))).toEqual(initial)
    expect(fs.readFileSync(configs.relay, 'utf8')).toBe(relayBefore)
    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual(login)
    expect(JSON.parse(fs.readFileSync(auth.apikey, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-relay' })
    expect(fs.readFileSync(result.backups.find((file) => file.startsWith(`${configs.chatgpt}.bak.`))!, 'utf8')).toBe(officialBefore)
    expect(fs.readFileSync(result.backups.find((file) => file.startsWith(`${configs.active}.bak.`))!, 'utf8')).toBe(relayBefore)
    expect(fs.readFileSync(sessions, 'utf8')).toBe('existing conversation\n')
    expect(fs.readFileSync(database, 'utf8')).toBe('existing state database')
    expect(result.files).not.toContain(sessions)
    expect(result.files).not.toContain(database)

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configs.active, 'utf8')).custom_relay).toEqual({ enabled: true })
    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configs.active, 'utf8'))).toEqual(initial)
    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual(login)
  })

  it('allows an explicit official reset after switching and retains the active login', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    seedCodexRelayConfigWithChatGptLogin(home)
    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    const configs = codexConfigSnapshotPaths(roots)
    const auth = codexAuthSnapshotPaths(roots)
    const loginBefore = fs.readFileSync(auth.active, 'utf8')
    fs.appendFileSync(configs.active, '\n[custom_official]\nenabled = true\n')

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset')

    expect(TOML.parse(fs.readFileSync(configs.active, 'utf8')).custom_official).toBeUndefined()
    expect(fs.readFileSync(auth.active, 'utf8')).toBe(loginBefore)
  })

  it('rolls back the official reset and its snapshot if a later auth file cannot commit', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    seedCodexRelayConfigWithChatGptLogin(home)
    const configs = codexConfigSnapshotPaths(roots)
    fs.writeFileSync(configs.chatgpt, 'model = "custom-official"\n', 'utf8')
    const activeBefore = fs.readFileSync(configs.active, 'utf8')
    const storedBefore = fs.readFileSync(configs.chatgpt, 'utf8')

    expect(() => switchProviderToOfficialAccount('codex', roots, {
      beforeReplace(file) { if (file === codexAuthSnapshotPaths(roots).active) throw new Error('fixture failure') },
    }, providerBaseUrls, 'reset')).toThrow('fixture failure')

    expect(fs.readFileSync(configs.active, 'utf8')).toBe(activeBefore)
    expect(fs.readFileSync(configs.chatgpt, 'utf8')).toBe(storedBefore)
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).matchesRelay).toBe(true)
  })

  it.each(['claude', 'gemini'] as const)('resets %s custom settings while keeping OAuth credentials and history', (provider) => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig(provider, 'sk-relay', testModels[provider], 'reset', roots, {}, providerBaseUrls)
    const paths = providerConfigPaths(provider, roots)
    const config = JSON.parse(fs.readFileSync(paths[0], 'utf8'))
    config.custom_setting = 'remove-on-reset'
    fs.writeFileSync(paths[0], JSON.stringify(config), 'utf8')
    const credentialPath = path.join(path.dirname(paths[0]), provider === 'claude' ? '.credentials.json' : 'oauth_creds.json')
    const historyPath = path.join(path.dirname(paths[0]), 'history.jsonl')
    fs.writeFileSync(credentialPath, '{"oauth":"keep"}\n', 'utf8')
    fs.writeFileSync(historyPath, 'existing history\n', 'utf8')
    if (provider === 'gemini') fs.appendFileSync(paths[1], 'CUSTOM_ENV=remove-on-reset\n')

    const result = switchProviderToOfficialAccount(provider, roots, {}, providerBaseUrls, 'reset')

    // 切回官方账号只收回中转的那几项，关自动更新、语言与记录保留期留着：CLI 仍由本软件
    // 装和更新，后两项是用户偏好，跟用哪个账号无关。
    expect(JSON.parse(fs.readFileSync(paths[0], 'utf8'))).toEqual(provider === 'claude'
      ? { env: { DISABLE_AUTOUPDATER: '1' }, language: '简体中文', cleanupPeriodDays: 365 }
      : {
        general: {
          enableAutoUpdate: false,
          enableAutoUpdateNotification: false,
          sessionRetention: { maxAge: '365d' },
        },
        security: { auth: { selectedType: 'oauth-personal' } },
      })
    if (provider === 'gemini') expect(fs.readFileSync(paths[1], 'utf8')).toBe('')
    expect(fs.readFileSync(credentialPath, 'utf8')).toBe('{"oauth":"keep"}\n')
    expect(fs.readFileSync(historyPath, 'utf8')).toBe('existing history\n')
    expect(result.backups.length).toBe(paths.length)
    expect(result.files).not.toContain(credentialPath)
    expect(result.files).not.toContain(historyPath)
  })

  it('keeps the third-party protection for explicit official resets', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('codex', 'sk-custom', testModels.codex, 'reset', roots, {}, {
      ...providerBaseUrls, codex: 'https://custom.invalid/v1',
    })
    const before = directoryFileSnapshot(roots.codexHome)
    expect(() => switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset')).toThrow('不是星芒中转')
    expect(directoryFileSnapshot(roots.codexHome)).toEqual(before)
  })

  it('classifies the two Codex auth.json shapes without mixing them', () => {
    expect(classifyCodexAuthProfile(buildCodexApiKeyAuth('sk-relay'))).toBe('apikey')
    expect(classifyCodexAuthProfile({
      auth_mode: 'chatgpt',
      tokens: chatGptTokens(),
    })).toBe('chatgpt')
    expect(classifyCodexAuthProfile({
      OPENAI_API_KEY: 'sk-relay',
      tokens: chatGptTokens(),
    })).toBe('mixed')
    expect(snapshotCodexChatGptAuth({
      OPENAI_API_KEY: 'sk-relay',
      auth_mode: 'chatgpt',
      tokens: chatGptTokens(),
      last_refresh: '2026-08-12T00:00:00Z',
    })).toEqual({
      auth_mode: 'chatgpt',
      tokens: chatGptTokens(),
      last_refresh: '2026-08-12T00:00:00Z',
    })
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
    expect(parsed?.approval_policy).toBe('on-request')
    expect(parsed?.sandbox_mode).toBe('workspace-write')
  })

  it('clears the settings it used to write when switching back to the official account', () => {
    const home = temporaryHome()
    seedCodexRelayConfigWithChatGptLogin(home)
    const [configPath] = providerConfigPaths('codex', providerRoots(home))
    // 老版本装出来的中转配置里还留着这三个键。
    fs.appendFileSync(configPath, [
      'disable_response_storage = true',
      'network_access = "enabled"',
      'windows_wsl_setup_acknowledged = true',
      '',
    ].join('\n'), 'utf8')

    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)

    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))
    expect(parsed?.disable_response_storage).toBeUndefined()
    expect(parsed?.network_access).toBeUndefined()
    expect(parsed?.windows_wsl_setup_acknowledged).toBeUndefined()
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
    // Artifact 对 claude.ai 账号用户是有用的,切回官方来源要把这条 deny 撤掉。
    expect(asRecord(after.permissions)?.deny).toBeUndefined()
    expect(asRecord(after.permissions)?.defaultMode).toBe('bypassPermissions')
  })

  it('skips the WebFetch domain preflight on the relay and restores it for the official account', () => {
    // The preflight asks api.anthropic.com about every domain; from mainland
    // China that host is unreachable, so relay users could not fetch any page.
    const home = temporaryHome()
    const [configPath] = providerConfigPaths('claude', providerRoots(home))
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ skipWebFetchPreflight: false, theme: 'dark' }, null, 2))

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls)
    const relay = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(relay.skipWebFetchPreflight).toBe(true)
    expect(relay.theme).toBe('dark')

    switchProviderToOfficialAccount('claude', providerRoots(home), {}, providerBaseUrls)
    const official = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(official).not.toHaveProperty('skipWebFetchPreflight')
    expect(official.theme).toBe('dark')
  })

  it('removes only Artifact from the Claude deny list when switching to the official account', () => {
    const home = temporaryHome()
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', providerRoots(home), {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('claude', providerRoots(home))
    const seeded = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const permissions = seeded.permissions as Record<string, unknown>
    permissions.deny = ['Bash(curl:*)', 'Artifact', 'WebFetch']
    permissions.allow = ['Read']
    fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2))

    switchProviderToOfficialAccount('claude', providerRoots(home), {}, providerBaseUrls)

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(after.permissions)).toEqual({
      defaultMode: 'bypassPermissions',
      deny: ['Bash(curl:*)', 'WebFetch'],
      allow: ['Read'],
    })
  })

  it('points every built-in Gemini helper model at the relay model so background features do not hit missing channels', () => {
    const home = temporaryHome()
    saveProviderConfig('gemini', 'sk-relay', 'gemini-3.8-flash', 'reset', providerRoots(home), {}, providerBaseUrls)
    const [settingsPath] = providerConfigPaths('gemini', providerRoots(home))
    const overrides = asRecord(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).modelConfigs)?.customOverrides
    expect(overrides).toContainEqual({
      match: { model: 'gemini-3-flash-preview' },
      modelConfig: { model: 'gemini-3.8-flash-high' },
    })
    expect(overrides).toContainEqual({
      match: { model: 'gemini-3.1-pro-preview-customtools' },
      modelConfig: { model: 'gemini-3.8-flash-high' },
    })
    expect(overrides).toContainEqual({
      match: { model: 'gemini-3.1-flash-lite' },
      modelConfig: { model: 'gemini-3.8-flash-high' },
    })
  })

  it('never rewrites the configured Gemini model onto itself', () => {
    const home = temporaryHome()
    saveProviderConfig('gemini', 'sk-relay', 'gemini-3.5-flash', 'reset', providerRoots(home), {}, providerBaseUrls)
    const [settingsPath] = providerConfigPaths('gemini', providerRoots(home))
    const overrides = asRecord(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).modelConfigs)?.customOverrides
    expect(Array.isArray(overrides)).toBe(true)
    const matched = (overrides as Array<{ match: { model: string } }>).map((entry) => entry.match.model)
    expect(matched).not.toContain('gemini-3.5-flash')
    expect(matched).toContain('gemini-3-flash-preview')
  })

  it('replaces its own Gemini helper overrides on merge and keeps the ones the user wrote', () => {
    const home = temporaryHome()
    saveProviderConfig('gemini', 'sk-relay', 'gemini-3.8-flash', 'reset', providerRoots(home), {}, providerBaseUrls)
    const [settingsPath] = providerConfigPaths('gemini', providerRoots(home))
    const seeded = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    const userOverride = {
      match: { model: 'gemini-3-flash-preview', overrideScope: 'web-search' },
      modelConfig: { generateContentConfig: { temperature: 0.2 } },
    }
    const modelConfigs = asRecord(seeded.modelConfigs) as Record<string, unknown>
    modelConfigs.customOverrides = [userOverride, ...(modelConfigs.customOverrides as unknown[])]
    modelConfigs.customAliases = { mine: { modelConfig: { model: 'gemini-3.8-pro' } } }
    fs.writeFileSync(settingsPath, JSON.stringify(seeded, null, 2))

    saveProviderConfig('gemini', 'sk-relay', 'gemini-3.8-pro', 'merge', providerRoots(home), {}, providerBaseUrls)

    const merged = asRecord(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).modelConfigs) as Record<string, unknown>
    const overrides = merged.customOverrides as Array<Record<string, unknown>>
    expect(overrides[0]).toEqual(userOverride)
    const ours = overrides.slice(1)
    expect(ours.length).toBeGreaterThan(0)
    expect(ours.every((entry) => asRecord(entry.modelConfig)?.model === 'gemini-3.8-pro')).toBe(true)
    expect(new Set(ours.map((entry) => asRecord(entry.match)?.model)).size).toBe(ours.length)
    expect(merged.customAliases).toEqual({ mine: { modelConfig: { model: 'gemini-3.8-pro' } } })
  })

  it('drops the relay helper overrides when Gemini switches back to the Google account', () => {
    const home = temporaryHome()
    saveProviderConfig('gemini', 'sk-relay', 'gemini-3.8-flash', 'reset', providerRoots(home), {}, providerBaseUrls)
    const [settingsPath] = providerConfigPaths('gemini', providerRoots(home))

    switchProviderToOfficialAccount('gemini', providerRoots(home), {}, providerBaseUrls)

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(settings).not.toHaveProperty('modelConfigs')
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
    const snapshots = codexAuthSnapshotPaths(providerRoots(home))

    expect(result.files).toEqual(expect.arrayContaining([
      providerConfigPaths('codex', providerRoots(home))[0],
      snapshots.active,
      snapshots.chatgpt,
      snapshots.apikey,
    ]))
    expect(result.backups.length).toBeGreaterThanOrEqual(2)
    for (const backup of result.backups) expect(fs.existsSync(backup)).toBe(true)
  })

  it('switches Grok back to its own login by removing every table that points at the relay', () => {
    // Grok 1.0.40: [model.X].api_key beats the ~/.grok/auth.json login, and a
    // leftover base_url alone makes Grok send the official session token to it.
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', roots, {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('grok', roots)
    const seeded = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    asRecord(seeded.model)!.mine = { model: 'grok-4.6', base_url: 'https://my.example.com/v1', api_key: 'sk-mine' }
    ;(seeded.endpoints as Record<string, unknown>).feedback_base_url = 'https://example.invalid'
    fs.writeFileSync(configPath, TOML.stringify(seeded as Parameters<typeof TOML.stringify>[0]), 'utf8')

    switchProviderToOfficialAccount('grok', roots, {}, providerBaseUrls)

    const settings = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(settings.cli).toEqual({ auto_update: false })
    expect(settings.models).toBeUndefined()
    expect(settings.model).toEqual({ mine: { model: 'grok-4.6', base_url: 'https://my.example.com/v1', api_key: 'sk-mine' } })
    expect(settings.endpoints).toEqual({ feedback_base_url: 'https://example.invalid' })
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('sk-relay')
    const inspection = inspectProviderConfig('grok', roots, providerBaseUrls)
    expect(providerAccountMode(inspection)).toBe('official')
    expect(canLaunchManagedProvider(inspection)).toBe(true)
  })

  it('writes the relay model back after Grok was switched to its own login', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', roots, {}, providerBaseUrls)
    switchProviderToOfficialAccount('grok', roots, {}, providerBaseUrls)

    saveProviderConfig('grok', 'sk-relay-2', testModels.grok, 'merge', roots, {}, providerBaseUrls)

    const settings = TOML.parse(fs.readFileSync(providerConfigPaths('grok', roots)[0], 'utf8'))
    expect(settings.models).toEqual({ default: 'grok', web_search: 'grok' })
    expect(asRecord(settings.model)?.grok).toMatchObject({
      model: testModels.grok, base_url: 'https://xm.solov.cc/v1', api_key: 'sk-relay-2',
      api_backend: 'responses', context_window: 1000000, supports_backend_search: true,
    })
    expect(settings.endpoints).toEqual({ xai_api_base_url: 'https://xm.solov.cc/v1' })
    expect(providerAccountMode(inspectProviderConfig('grok', roots, providerBaseUrls))).toBe('relay')
  })

  it('reads only the non-secret Grok login fields', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    expect(inspectOfficialLogin('grok', roots)).toBe(false)
    expect(inspectProviderConfig('grok', roots, providerBaseUrls).grokLoginMode).toBeNull()
    const grokRoot = path.join(home, '.grok')
    fs.mkdirSync(grokRoot, { recursive: true })
    fs.writeFileSync(path.join(grokRoot, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: 'session-secret', refresh_token: 'refresh-secret', auth_mode: 'oidc', email: 'user@example.com',
      },
    }), 'utf8')
    expect(inspectOfficialLogin('grok', roots)).toBe(true)
    const summary = toNativeConfigSummary(inspectProviderConfig('grok', roots, providerBaseUrls))
    expect(summary.grokLoginMode).toBe('oidc')
    expect(summary.officialAccountEmail).toBe('user@example.com')
    expect(JSON.stringify(summary)).not.toContain('secret')
  })

  it('classifies the account mode from an inspection', () => {
    const home = temporaryHome()
    expect(providerAccountMode(inspectProviderConfig('codex', providerRoots(home), providerBaseUrls))).toBe('official')

    seedCodexRelayConfigWithChatGptLogin(home)
    expect(providerAccountMode(inspectProviderConfig('codex', providerRoots(home), providerBaseUrls))).toBe('relay')

    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)
    expect(providerAccountMode(inspectProviderConfig('codex', providerRoots(home), providerBaseUrls))).toBe('official')
  })

  it('lets official ChatGPT launch Codex and still refuses a third-party URL', () => {
    expect(canLaunchManagedProvider({ hasApiKey: false, matchesRelay: false })).toBe(true)
    expect(canLaunchManagedProvider({ hasApiKey: true, matchesRelay: true })).toBe(true)
    expect(canLaunchManagedProvider({ hasApiKey: true, matchesRelay: false })).toBe(false)
    expect(managedProviderLaunchBlockedMessage('codex')).toContain('ChatGPT 账号')
  })
})

describe('workspace trust for the directory the user picked', () => {
  // 字段形态见 config-files.ts 的长注释：2026-09-21 用空 HOME 走完
  // Claude Code 2.1.277 与 Gemini CLI 0.60.0 的首启向导后 diff 出来的。
  it('accepts the Claude trust dialog and the first-run wizard for that workspace', () => {
    const result = trustClaudeWorkspaceInRootConfigText(null, 'D:\\Work')
    expect(result.changed).toBe(true)
    const parsed = JSON.parse(result.content) as Record<string, unknown>
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(asRecord(asRecord(parsed.projects)?.['D:\\Work'])?.hasTrustDialogAccepted).toBe(true)
  })

  it('keeps every other Claude project entry and answer untouched', () => {
    const existing = JSON.stringify({
      hasCompletedOnboarding: false,
      numStartups: 7,
      projects: {
        'D:\\Other': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
        'D:\\Work': { hasTrustDialogAccepted: false, mcpServers: { local: {} } },
      },
    })
    const result = trustClaudeWorkspaceInRootConfigText(existing, 'd:/work')
    expect(result.changed).toBe(false)
    const parsed = JSON.parse(result.content) as Record<string, unknown>
    // 用户自己答过「不信任」，本软件不替他翻案；向导的 false 同理。
    expect(parsed.hasCompletedOnboarding).toBe(false)
    expect(parsed.numStartups).toBe(7)
    const projects = asRecord(parsed.projects)
    expect(asRecord(projects?.['D:\\Work'])?.hasTrustDialogAccepted).toBe(false)
    expect(asRecord(projects?.['D:\\Work'])?.mcpServers).toEqual({ local: {} })
    expect(asRecord(projects?.['D:\\Other'])?.allowedTools).toEqual(['Bash'])
  })

  it('reuses the Claude project key that already names this workspace', () => {
    const existing = JSON.stringify({ projects: { 'D:\\Work': { allowedTools: [] } } })
    const result = trustClaudeWorkspaceInRootConfigText(existing, 'D:/Work/')
    const projects = asRecord((JSON.parse(result.content) as Record<string, unknown>).projects)
    expect(Object.keys(projects ?? {})).toEqual(['D:\\Work'])
    expect(asRecord(projects?.['D:\\Work'])?.hasTrustDialogAccepted).toBe(true)
  })

  it('trusts an unknown Gemini folder and leaves an existing answer alone', () => {
    const fresh = trustGeminiWorkspaceInTrustedFoldersText('{}', '/home/tester/work')
    expect(fresh.changed).toBe(true)
    expect(JSON.parse(fresh.content)).toEqual({ '/home/tester/work': 'TRUST_FOLDER' })

    const declined = JSON.stringify({ '/home/tester/work': 'DO_NOT_TRUST', '/home/tester/other': 'TRUST_PARENT' })
    const kept = trustGeminiWorkspaceInTrustedFoldersText(declined, '/home/tester/work/')
    expect(kept.changed).toBe(false)
    expect(JSON.parse(kept.content)).toEqual({
      '/home/tester/work': 'DO_NOT_TRUST',
      '/home/tester/other': 'TRUST_PARENT',
    })
  })

  it('refuses to guess at a damaged trust file instead of overwriting it', () => {
    expect(() => trustClaudeWorkspaceInRootConfigText('{"projects":', 'D:\\Work'))
      .toThrow('无法解析为 JSON')
    expect(() => trustGeminiWorkspaceInTrustedFoldersText('["a"]', '/home/tester/work'))
      .toThrow('不是有效的 JSON 对象')
    // 解析器原文会带上出错位置附近的片段，~/.claude.json 里有会话历史（I13）。
    expect(() => trustClaudeWorkspaceInRootConfigText('{"apiKey": "sk-secret-value"', 'D:\\Work'))
      .not.toThrow(/sk-secret-value/)
  })

  it('leaves a Claude project record it cannot read the shape of entirely alone', () => {
    // 换成空对象就跳过了弹窗，代价是用户的项目记录没了，这笔买卖不做。
    expect(() => trustClaudeWorkspaceInRootConfigText('{"projects": ["D:\\\\Work"]}', 'D:\\Work'))
      .toThrow('项目记录已损坏')
    expect(() => trustClaudeWorkspaceInRootConfigText('{"projects": {"D:\\\\Work": "trusted"}}', 'D:\\Work'))
      .toThrow('项目记录已损坏')
  })

  it('writes the Claude trust transaction with a recoverable backup', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = path.join(home, '.claude.json')
    fs.writeFileSync(configPath, JSON.stringify({ numStartups: 3 }), 'utf8')

    const result = trustManagedWorkspace('claude', roots, path.join(home, 'project'))
    expect(result.changed).toBe(true)
    expect(result.backups).toHaveLength(1)
    expect(fs.existsSync(result.backups[0])).toBe(true)
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(written.numStartups).toBe(3)
    expect(written.hasCompletedOnboarding).toBe(true)
    expect(asRecord(asRecord(written.projects)?.[path.join(home, 'project')])?.hasTrustDialogAccepted).toBe(true)

    // 第二次打开同一个目录不再改文件，所以也不会再堆一份备份。
    const again = trustClaudeWorkspace(roots, path.join(home, 'project'))
    expect(again.changed).toBe(false)
    expect(again.backups).toEqual([])
  })

  it('creates the Gemini trust file when the CLI has never written one', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const workspace = path.join(home, 'project')

    const result = trustManagedWorkspace('gemini', roots, workspace)
    expect(result.changed).toBe(true)
    expect(result.backups).toEqual([])
    const trustedFolders = path.join(home, '.gemini', 'trustedFolders.json')
    expect(JSON.parse(fs.readFileSync(trustedFolders, 'utf8'))).toEqual({ [workspace]: 'TRUST_FOLDER' })
  })

  it('reports a damaged trust file instead of blocking the launch path', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":', 'utf8')

    expect(() => trustManagedWorkspace('claude', roots, path.join(home, 'project')))
      .toThrow('未执行修改')
    // 原文件一字未动，等着 CLI 自己去修。
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{"projects":')
  })

  it('has nothing to write for the providers without a launch-time trust file', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'grok'] as const) {
      expect(trustManagedWorkspace(provider, roots, path.join(home, 'project')))
        .toEqual({ backups: [], files: [], changed: false })
    }
    expect(fs.readdirSync(home)).toEqual([])
  })
})

describe('teaching Gemini CLI to read the shared AGENTS.md', () => {
  it('adds both context files when settings.json has none', () => {
    const result = ensureGeminiContextFilenamesInSettingsText('{}')
    expect(result.changed).toBe(true)
    const context = asRecord((JSON.parse(result.content) as Record<string, unknown>).context)
    expect(context?.fileName).toEqual(['GEMINI.md', 'AGENTS.md'])
  })

  it('appends only what is missing and keeps the user list and order', () => {
    const existing = JSON.stringify({ context: { fileName: ['docs/RULES.md', 'GEMINI.md'] } })
    const result = ensureGeminiContextFilenamesInSettingsText(existing)
    expect(result.changed).toBe(true)
    const context = asRecord((JSON.parse(result.content) as Record<string, unknown>).context)
    // GEMINI.md 已在，不重复；用户自己的条目原样保留，AGENTS.md 补在末尾。
    expect(context?.fileName).toEqual(['docs/RULES.md', 'GEMINI.md', 'AGENTS.md'])
  })

  it('upgrades a single string value to a list without losing it', () => {
    const result = ensureGeminiContextFilenamesInSettingsText(JSON.stringify({ context: { fileName: 'GEMINI.md' } }))
    expect(result.changed).toBe(true)
    const context = asRecord((JSON.parse(result.content) as Record<string, unknown>).context)
    expect(context?.fileName).toEqual(['GEMINI.md', 'AGENTS.md'])
  })

  it('does nothing when both context files are already listed', () => {
    const existing = JSON.stringify({ context: { fileName: ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md'] } })
    const result = ensureGeminiContextFilenamesInSettingsText(existing)
    expect(result.changed).toBe(false)
  })

  it('leaves an unreadable context.fileName shape untouched', () => {
    const result = ensureGeminiContextFilenamesInSettingsText(JSON.stringify({ context: { fileName: { a: 1 } } }))
    expect(result.changed).toBe(false)
    const context = asRecord((JSON.parse(result.content) as Record<string, unknown>).context)
    expect(context?.fileName).toEqual({ a: 1 })
  })

  it('writes the settings.json transaction only once and keeps other settings', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const settingsPath = path.join(home, '.gemini', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'Dark', security: { auth: { selectedType: 'gemini-api-key' } } }), 'utf8')

    const result = ensureGeminiProjectContextFiles(roots)
    expect(result.changed).toBe(true)
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(written.theme).toBe('Dark')
    expect(asRecord(asRecord(written.security)?.auth)?.selectedType).toBe('gemini-api-key')
    expect(asRecord(written.context)?.fileName).toEqual(['GEMINI.md', 'AGENTS.md'])

    const again = ensureGeminiProjectContextFiles(roots)
    expect(again.changed).toBe(false)
    expect(again.backups).toEqual([])
  })
})

describe('moving competing official credentials aside during an account switch', () => {
  it('moves the Console key out of ~/.claude.json and keeps every other field', () => {
    const next = moveClaudeConsoleKeyAsideTexts(JSON.stringify({ primaryApiKey: 'sk-ant-api03-console', projects: { '/work': { hasTrustDialogAccepted: true } } }))
    expect(JSON.parse(next.rootConfig!)).toEqual({ projects: { '/work': { hasTrustDialogAccepted: true } } })
    expect(JSON.parse(next.snapshot!)).toEqual({ primaryApiKey: 'sk-ant-api03-console' })
  })

  it('leaves both files alone when there is no Console key', () => {
    expect(moveClaudeConsoleKeyAsideTexts(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }))).toEqual({ rootConfig: null, snapshot: null })
    expect(moveClaudeConsoleKeyAsideTexts(null)).toEqual({ rootConfig: null, snapshot: null })
  })

  it('puts the key back and empties the snapshot, but never overwrites a newer login', () => {
    const snapshot = JSON.stringify({ primaryApiKey: 'sk-ant-api03-console' })
    const restored = restoreClaudeConsoleKeyTexts(JSON.stringify({ numStartups: 3 }), snapshot)
    expect(JSON.parse(restored.rootConfig!)).toEqual({ numStartups: 3, primaryApiKey: 'sk-ant-api03-console' })
    expect(restored.snapshot).toBe('')
    expect(restoreClaudeConsoleKeyTexts(JSON.stringify({ primaryApiKey: 'sk-ant-newer' }), snapshot)).toEqual({ rootConfig: null, snapshot: '' })
    expect(restoreClaudeConsoleKeyTexts(JSON.stringify({}), null)).toEqual({ rootConfig: null, snapshot: null })
  })

  it('round-trips the Console key through the snapshot file on disk', () => {
    const home = temporaryHome()
    const rootConfig = path.join(home, '.claude.json')
    const snapshot = path.join(home, '.claude', claudeConsoleKeySnapshotName)
    fs.writeFileSync(rootConfig, JSON.stringify({ primaryApiKey: 'sk-ant-api03-console', hasCompletedOnboarding: true }))

    expect(moveClaudeConsoleKeyAside(providerRoots(home))).toBe(true)
    expect(JSON.parse(fs.readFileSync(rootConfig, 'utf8'))).toEqual({ hasCompletedOnboarding: true })
    expect(JSON.parse(fs.readFileSync(snapshot, 'utf8'))).toEqual({ primaryApiKey: 'sk-ant-api03-console' })
    expect(moveClaudeConsoleKeyAside(providerRoots(home))).toBe(false)

    expect(restoreClaudeConsoleKey(providerRoots(home))).toBe(true)
    expect(JSON.parse(fs.readFileSync(rootConfig, 'utf8'))).toEqual({ hasCompletedOnboarding: true, primaryApiKey: 'sk-ant-api03-console' })
    expect(fs.readFileSync(snapshot, 'utf8')).toBe('')
    expect(restoreClaudeConsoleKey(providerRoots(home))).toBe(false)
  })

  it('does not create files when nothing needs to move', () => {
    const home = temporaryHome()
    expect(moveClaudeConsoleKeyAside(providerRoots(home))).toBe(false)
    expect(restoreClaudeConsoleKey(providerRoots(home))).toBe(false)
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.claude', claudeConsoleKeySnapshotName))).toBe(false)
  })

  it('pins the relay profile to file-based Codex credentials and keeps the official choice in its snapshot', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'cli_auth_credentials_store = "keyring"\nmodel = "gpt-5.5"\n')

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).cli_auth_credentials_store).toBe('file')

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).cli_auth_credentials_store).toBe('keyring')
  })

  it('switches a half-switched Codex (ChatGPT login over the relay config.toml) fully back to official', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    // What Codex's own "Sign in with ChatGPT" leaves behind.
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'a.b.c', access_token: 'token' } }))
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).actualBaseUrl).toBe(providerBaseUrls.codex)

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(config.model_provider).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toMatchObject({ auth_mode: 'chatgpt', tokens: { access_token: 'token' } })
  })

  it('reads a Codex auth file without auth_mode the way Codex does: the key wins', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-relay', tokens: { id_token: 'a.b.c', access_token: 'token' } }))
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).codexAuthMode).toBe('apikey')
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-relay', tokens: { id_token: 'a.b.c', access_token: 'token' } }))
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).codexAuthMode).toBe('chatgpt')
  })
})

describe('telling whether an official login already exists on this computer', () => {
  it('recognises a Claude login from the account record or the credentials file', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    expect(inspectOfficialLogin('claude', roots)).toBe(false)
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }))
    expect(inspectOfficialLogin('claude', roots)).toBe(true)
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
    expect(inspectOfficialLogin('claude', roots)).toBe(false)
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}')
    expect(inspectOfficialLogin('claude', roots)).toBe(true)
  })

  it('recognises a ChatGPT login and admits it cannot see the OS credential store', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-relay' }))
    expect(inspectOfficialLogin('codex', roots)).toBe(false)
    fs.writeFileSync(configPath, 'cli_auth_credentials_store = "auto"\n')
    expect(inspectOfficialLogin('codex', roots)).toBeNull()
    fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'a.b.c', access_token: 'token' } }))
    expect(inspectOfficialLogin('codex', roots)).toBe(true)
  })

  it('recognises a Google login from the cached OAuth credentials', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    expect(inspectOfficialLogin('gemini', roots)).toBe(false)
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
    fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), '{"refresh_token":"x"}')
    expect(inspectOfficialLogin('gemini', roots)).toBe(true)
    expect(inspectOfficialLogin('grok', roots)).toBe(false)
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TOML from '@iarna/toml'
import fc from 'fast-check'
import {
  applyClaudeToggle,
  codexConfigSnapshotPaths,
  codexModelCatalogNeedsRefresh,
  codexModelCatalogPath,
  codexModelCatalogTargetUsable,
  inspectCodexModelCatalogOnDisk,
  takeBackCodexModelCatalog,
  geminiUsageStatisticsRecordName,
  fillRelayTemplateDefaults,
  relayTemplateDefaultsPending,
  inspectProviderConfig,
  isGrokInstallerOnlyConfig,
  MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS,
  PUBLISHED_GLOBAL_RESPONSE_LANGUAGE_DIGESTS,
  managedGlobalResponseLanguagePresent,
  providerConfigPaths,
  saveProviderConfig,
  switchProviderToOfficialAccount,
} from './config-files'
import { providerBaseUrls, type ProviderId } from './catalog'
import { projectInstructionsDigest } from './project-instructions'
import { applyStandingInstructions } from './standing-instructions'
import {
  asRecord,
  directoryFileSnapshot,
  providerRoots,
  removeTemporaryHomes,
  temporaryHome,
  testModels,
  uninterruptedFeatures,
} from './config-files.test-support'

afterEach(() => {
  vi.restoreAllMocks()
  removeTemporaryHomes()
})

describe('bringing an older account config up to the current template', () => {
  function writeFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  }

  it('fills only the Codex keys an older template never wrote and keeps what the user set', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    writeFile(configPath, [
      'model_provider = "XingmangAI"',
      'model = "gpt-5.5"',
      'approval_policy = "never"',
      'disable_response_storage = true',
      '',
      '[model_providers.XingmangAI]',
      'name = "XingmangAI"',
      `base_url = "${providerBaseUrls.codex}"`,
      'wire_api = "responses"',
      '',
      '[features]',
      'prevent_idle_sleep = false',
      '',
    ].join('\n'))

    expect(relayTemplateDefaultsPending('codex', roots, providerBaseUrls, 'win32')).toBe(true)
    const result = fillRelayTemplateDefaults('codex', roots, providerBaseUrls, {}, 'win32')

    expect(result?.backups).toHaveLength(1)
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(parsed.approval_policy).toBe('never')
    expect(parsed.sandbox_mode).toBe('workspace-write')
    expect(parsed.check_for_update_on_startup).toBe(false)
    expect(parsed.disable_response_storage).toBeUndefined()
    expect(asRecord(parsed.analytics)?.enabled).toBe(false)
    expect(asRecord(parsed.features)?.prevent_idle_sleep).toBe(false)
    expect(asRecord(parsed.features)?.daemon_auto_start).toBe(false)
    expect(asRecord(parsed.features)).toMatchObject(uninterruptedFeatures)
    expect(parsed.suppress_unstable_features_warning).toBe(true)
    expect(asRecord(parsed.windows)?.sandbox).toBe('unelevated')
    expect(asRecord(asRecord(parsed.model_providers)?.XingmangAI)?.supports_websockets).toBe(true)
    expect(parsed.model).toBe('gpt-5.5')
    expect(fs.readFileSync(codexConfigSnapshotPaths(roots).relay, 'utf8')).toBe(fs.readFileSync(configPath, 'utf8'))
    expect(relayTemplateDefaultsPending('codex', roots, providerBaseUrls, 'win32')).toBe(false)
  })

  it('keeps a customer supports_websockets = false on our Codex table at startup', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const snapshots = codexConfigSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-fixture', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const fresh = fs.readFileSync(snapshots.active, 'utf8')
    expect(fresh).toMatch(/^supports_websockets = true$/m)
    writeFile(snapshots.active, fresh.replace('supports_websockets = true', 'supports_websockets = false'))

    expect(relayTemplateDefaultsPending('codex', roots, providerBaseUrls)).toBe(false)
    expect(fillRelayTemplateDefaults('codex', roots, providerBaseUrls)).toBeNull()
    expect(fs.readFileSync(snapshots.active, 'utf8')).toMatch(/^supports_websockets = false$/m)
  })

  it('fills plain streaming at startup when the old Codex config uses another vendor model', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    writeFile(configPath, [
      'model_provider = "XingmangAI"',
      'model = "claude-opus-4-6"',
      '',
      '[model_providers.XingmangAI]',
      'name = "OpenAI"',
      `base_url = "${providerBaseUrls.codex}"`,
      'wire_api = "responses"',
      '',
    ].join('\n'))

    expect(fillRelayTemplateDefaults('codex', roots, providerBaseUrls)).not.toBeNull()

    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(asRecord(asRecord(parsed.model_providers)?.XingmangAI)?.supports_websockets).toBe(false)
  })

  it('renames our own legacy Codex display name at startup and keeps a name the customer chose', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const snapshots = codexConfigSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-fixture', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const fresh = fs.readFileSync(snapshots.active, 'utf8')
    expect(fresh).toContain('name = "OpenAI"')
    writeFile(snapshots.active, fresh.replace('name = "OpenAI"', 'name = "XingmangAI"'))

    expect(relayTemplateDefaultsPending('codex', roots, providerBaseUrls)).toBe(true)
    const result = fillRelayTemplateDefaults('codex', roots, providerBaseUrls)

    expect(result?.backups).toHaveLength(2)
    for (const file of [snapshots.active, snapshots.relay]) {
      const parsed = asRecord(TOML.parse(fs.readFileSync(file, 'utf8')))!
      expect(parsed.model_provider).toBe('XingmangAI')
      expect(asRecord(asRecord(parsed.model_providers)?.XingmangAI)?.name).toBe('OpenAI')
    }

    const renamed = fs.readFileSync(snapshots.active, 'utf8')
    writeFile(snapshots.active, renamed.replace('name = "OpenAI"', 'name = "我的中转"'))
    expect(relayTemplateDefaultsPending('codex', roots, providerBaseUrls)).toBe(false)
    expect(fillRelayTemplateDefaults('codex', roots, providerBaseUrls)).toBeNull()
  })

  it('leaves the Codex desktop mode the customer picked alone at startup', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const snapshots = codexConfigSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-fixture', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const picked = `${fs.readFileSync(snapshots.active, 'utf8')}\n[desktop]\nconversationDetailMode = "STEPS_PROSE"\n`
    writeFile(snapshots.active, picked)

    expect(relayTemplateDefaultsPending('codex', roots, providerBaseUrls)).toBe(false)
    expect(fillRelayTemplateDefaults('codex', roots, providerBaseUrls)).toBeNull()
    expect(fs.readFileSync(snapshots.active, 'utf8')).toBe(picked)
  })

  it('leaves a forced ChatGPT login alone at startup', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const snapshots = codexConfigSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-fixture', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const picked = `forced_login_method = "chatgpt"\n${fs.readFileSync(snapshots.active, 'utf8')}`
    writeFile(snapshots.active, picked)

    expect(fillRelayTemplateDefaults('codex', roots, providerBaseUrls)).toBeNull()
    expect(fs.readFileSync(snapshots.active, 'utf8')).toBe(picked)
  })

  it('writes nothing when the config already has every template key', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'claude', 'gemini', 'grok'] as const) {
      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)
    }
    const before = directoryFileSnapshot(path.join(home, '.claude'))
    for (const provider of ['codex', 'claude', 'gemini', 'grok'] as const) {
      expect(relayTemplateDefaultsPending(provider, roots, providerBaseUrls, process.platform)).toBe(false)
      expect(fillRelayTemplateDefaults(provider, roots, providerBaseUrls)).toBeNull()
    }
    expect(directoryFileSnapshot(path.join(home, '.claude'))).toEqual(before)
  })

  it('leaves configs that do not point at the current account alone', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const codexPath = codexConfigSnapshotPaths(roots).active
    writeFile(codexPath, 'model = "gpt-5.5"\n')
    const claudePath = providerConfigPaths('claude', roots)[0]
    writeFile(claudePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }))
    const grokPath = providerConfigPaths('grok', roots)[0]
    writeFile(grokPath, '[models]\ndefault = "mine"\n\n[model.mine]\nbase_url = "https://api.x.ai/v1"\n')

    for (const provider of ['codex', 'claude', 'gemini', 'grok'] as const) {
      expect(fillRelayTemplateDefaults(provider, roots, providerBaseUrls)).toBeNull()
    }
    expect(fs.readFileSync(codexPath, 'utf8')).toBe('model = "gpt-5.5"\n')
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }))
  })

  it('fills Claude Code defaults without touching values the user chose', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const settingsPath = providerConfigPaths('claude', roots)[0]
    writeFile(settingsPath, JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-fixture', ANTHROPIC_BASE_URL: providerBaseUrls.claude },
      permissions: { deny: ['Bash(rm:*)'] },
      skipWebFetchPreflight: false,
      language: 'English',
      model: 'claude-opus-4-6',
    }))

    fillRelayTemplateDefaults('claude', roots, providerBaseUrls)

    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(parsed.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'sk-fixture', ANTHROPIC_BASE_URL: providerBaseUrls.claude, DISABLE_AUTOUPDATER: '1' })
    expect(parsed.permissions.deny).toEqual(['Bash(rm:*)', 'Artifact', 'DesignSync'])
    expect(parsed.skipWebFetchPreflight).toBe(false)
    expect(parsed.language).toBe('English')
    expect(parsed.cleanupPeriodDays).toBe(365)
    expect(parsed.model).toBe('claude-opus-4-6')
    expect(parsed.permissions.defaultMode).toBe('bypassPermissions')
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true)
  })

  it('leaves a Claude permission mode the user chose when filling defaults', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const settingsPath = providerConfigPaths('claude', roots)[0]
    writeFile(settingsPath, JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-fixture', ANTHROPIC_BASE_URL: providerBaseUrls.claude },
      permissions: { defaultMode: 'default' },
      skipDangerousModePermissionPrompt: false,
    }))

    fillRelayTemplateDefaults('claude', roots, providerBaseUrls)

    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(parsed.permissions.defaultMode).toBe('default')
    expect(parsed.skipDangerousModePermissionPrompt).toBe(false)
  })

  it('fills Gemini defaults and adds the helper model mapping only when none is there', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath, envPath] = providerConfigPaths('gemini', roots)
    writeFile(envPath, `GOOGLE_GEMINI_BASE_URL=${providerBaseUrls.gemini}\nGEMINI_API_KEY=sk-fixture\nGEMINI_MODEL=gemini-3.5-flash\n`)
    writeFile(settingsPath, JSON.stringify({
      security: { auth: { selectedType: 'gemini-api-key' } },
      general: { enableAutoUpdate: true },
      privacy: { usageStatisticsEnabled: true },
    }))

    fillRelayTemplateDefaults('gemini', roots, providerBaseUrls)

    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(parsed.general.enableAutoUpdate).toBe(true)
    expect(parsed.general.enableAutoUpdateNotification).toBe(false)
    expect(parsed.general.sessionRetention).toEqual({ maxAge: '365d' })
    expect(parsed.privacy.usageStatisticsEnabled).toBe(true)
    expect(parsed.modelConfigs.customOverrides.length).toBeGreaterThan(0)
    expect(parsed.modelConfigs.customOverrides.every((entry: { modelConfig: { model: string } }) => entry.modelConfig.model === 'gemini-3.5-flash')).toBe(true)
  })

  it('skips Gemini when it is signed in with a Google account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath, envPath] = providerConfigPaths('gemini', roots)
    writeFile(envPath, `GOOGLE_GEMINI_BASE_URL=${providerBaseUrls.gemini}\n`)
    writeFile(settingsPath, JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }))
    expect(fillRelayTemplateDefaults('gemini', roots, providerBaseUrls)).toBeNull()
  })

  it('records the Gemini usage statistics switch it fills so switching back to Google takes back only that one', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath, envPath] = providerConfigPaths('gemini', roots)
    const recordPath = path.join(path.dirname(settingsPath), geminiUsageStatisticsRecordName)
    const relaySettings = { security: { auth: { selectedType: 'gemini-api-key' } } }
    writeFile(envPath, `GOOGLE_GEMINI_BASE_URL=${providerBaseUrls.gemini}\nGEMINI_API_KEY=sk-fixture\nGEMINI_MODEL=gemini-3.5-flash\n`)
    writeFile(settingsPath, JSON.stringify({ ...relaySettings, privacy: { usageStatisticsEnabled: false } }))
    expect(fillRelayTemplateDefaults('gemini', roots, providerBaseUrls)?.files).not.toContain(recordPath)
    expect(fs.existsSync(recordPath)).toBe(false)

    writeFile(settingsPath, JSON.stringify(relaySettings))
    expect(fillRelayTemplateDefaults('gemini', roots, providerBaseUrls)?.files).toContain(recordPath)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).privacy).toEqual({ usageStatisticsEnabled: false })

    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).not.toHaveProperty('privacy')
  })

  it('points Grok image tools at the current account only when the user never set them', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = providerConfigPaths('grok', roots)[0]
    writeFile(configPath, [
      '[models]',
      'default = "grok"',
      'session_summary = "grok-4.6"',
      '',
      '[model.grok]',
      'model = "grok-4.5"',
      `base_url = "${providerBaseUrls.grok}"`,
      'api_key = "sk-fixture"',
      '',
    ].join('\n'))

    fillRelayTemplateDefaults('grok', roots, providerBaseUrls)

    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(asRecord(parsed.cli)?.auto_update).toBe(false)
    expect(asRecord(parsed.endpoints)?.xai_api_base_url).toBe(providerBaseUrls.grok)
    expect(asRecord(parsed.models)?.session_summary).toBe('grok-4.6')
    expect(asRecord(parsed.models)?.image_description).toBe('grok')
    expect(asRecord(parsed.models)?.allowed_models).toEqual(['grok'])
    expect(asRecord(parsed.features)?.video_gen).toBe(false)
  })

  it('turns the Grok video tools off for existing customers only where they never set them', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = providerConfigPaths('grok', roots)[0]
    const relayConfig = [
      '[cli]',
      'auto_update = false',
      '',
      '[models]',
      'default = "grok"',
      'session_summary = "grok"',
      'image_description = "grok"',
      'allowed_models = ["grok"]',
      '',
      '[model.grok]',
      'model = "grok-4.5"',
      `base_url = "${providerBaseUrls.grok}"`,
      'api_key = "sk-fixture"',
      '',
      '[endpoints]',
      `xai_api_base_url = "${providerBaseUrls.grok}"`,
      '',
    ].join('\n')
    writeFile(configPath, relayConfig)
    expect(relayTemplateDefaultsPending('grok', roots, providerBaseUrls)).toBe(true)

    fillRelayTemplateDefaults('grok', roots, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).features).toEqual({ video_gen: false })

    writeFile(configPath, `${relayConfig}\n[features]\nvideo_gen = true\n`)
    fillRelayTemplateDefaults('grok', roots, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).features).toEqual({ video_gen: true })
  })
})

describe('the global reply language Codex and Grok read', () => {
  function writeFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf8')
  }

  function configDirectory(provider: ProviderId, roots: ReturnType<typeof providerRoots>): string {
    return path.dirname(providerConfigPaths(provider, roots)[0])
  }

  it('places the Chinese reply instructions next to a fresh Codex and Grok config and nothing for Claude Code', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'grok', 'claude'] as const) {
      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)
    }

    for (const provider of ['codex', 'grok'] as const) {
      expect(fs.readFileSync(path.join(configDirectory(provider, roots), 'AGENTS.md'), 'utf8'))
        .toBe(MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS)
    }
    expect(fs.existsSync(path.join(configDirectory('claude', roots), 'AGENTS.md'))).toBe(false)
    expect(MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS).toContain('始终用简体中文回复')
  })

  it('leaves an AGENTS.md the customer already has untouched on both reset and merge', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'grok'] as const) {
      const own = path.join(configDirectory(provider, roots), 'AGENTS.md')
      writeFile(own, 'Always answer in English.\n')
      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)
      const saved = saveProviderConfig(provider, 'sk-other', testModels[provider], 'merge', roots, {}, providerBaseUrls)

      expect(fs.readFileSync(own, 'utf8')).toBe('Always answer in English.\n')
      expect(saved.files).not.toContain(own)
      expect(fs.readdirSync(path.dirname(own)).filter((name) => name.startsWith('AGENTS.md.'))).toEqual([])
    }
  })

  it('counts every global instruction file each tool reads, whatever its letter case', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    writeFile(path.join(configDirectory('codex', roots), 'AGENTS.override.md'), '用中文。\n')
    writeFile(path.join(configDirectory('grok', roots), 'claude.md'), '用中文。\n')

    for (const provider of ['codex', 'grok'] as const) {
      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)
      expect(fs.readdirSync(configDirectory(provider, roots)).filter((name) => name.toLowerCase() === 'agents.md')).toEqual([])
    }
  })

  // Creating a file symlink needs Developer Mode or administrator rights on Windows.
  it.skipIf(process.platform === 'win32')('leaves a linked AGENTS.md alone and still saves the config', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const source = path.join(home, 'dotfiles', 'AGENTS.md')
    writeFile(source, 'Keep answers short.\n')
    const link = path.join(configDirectory('codex', roots), 'AGENTS.md')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(source, link)

    saveProviderConfig('codex', 'sk-fixture', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(source, 'utf8')).toBe('Keep answers short.\n')
    expect(inspectProviderConfig('codex', roots).hasApiKey).toBe(true)
  })

  it('places it once for an older Codex and Grok account config at startup', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'grok'] as const) {
      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)
      const placed = path.join(configDirectory(provider, roots), 'AGENTS.md')
      // A config written before this template revision has no global instructions next to it.
      fs.rmSync(placed)

      expect(relayTemplateDefaultsPending(provider, roots, providerBaseUrls)).toBe(true)
      const result = fillRelayTemplateDefaults(provider, roots, providerBaseUrls)

      expect(result?.files).toEqual([placed])
      expect(result?.backups).toEqual([])
      expect(fs.readFileSync(placed, 'utf8')).toBe(MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS)
      expect(relayTemplateDefaultsPending(provider, roots, providerBaseUrls)).toBe(false)
      expect(fillRelayTemplateDefaults(provider, roots, providerBaseUrls)).toBeNull()
    }
  })

  it('does not place it next to a config that does not point at the current account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    writeFile(codexConfigSnapshotPaths(roots).active, 'model = "gpt-5.5"\n')
    writeFile(providerConfigPaths('grok', roots)[0], '[models]\ndefault = "mine"\n\n[model.mine]\nbase_url = "https://api.x.ai/v1"\n')

    for (const provider of ['codex', 'grok'] as const) {
      expect(fillRelayTemplateDefaults(provider, roots, providerBaseUrls)).toBeNull()
      expect(fs.existsSync(path.join(configDirectory(provider, roots), 'AGENTS.md'))).toBe(false)
    }
  })

  it('keeps the instructions after switching Codex and Grok back to the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'grok'] as const) {
      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)
      switchProviderToOfficialAccount(provider, roots, {}, providerBaseUrls)
      expect(fs.readFileSync(path.join(configDirectory(provider, roots), 'AGENTS.md'), 'utf8'))
        .toBe(MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS)
    }
  })

  it('lists the instructions it writes among the published versions', () => {
    expect(PUBLISHED_GLOBAL_RESPONSE_LANGUAGE_DIGESTS).toContain(projectInstructionsDigest(MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS))
  })

  it('does not place it again once it has been on this computer and the customer deleted it', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const seeded = { responseLanguage: true }
    for (const provider of ['codex', 'grok'] as const) {
      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)
      const placed = path.join(configDirectory(provider, roots), 'AGENTS.md')
      fs.rmSync(placed)

      const saved = saveProviderConfig(provider, 'sk-other', testModels[provider], 'merge', roots, {}, providerBaseUrls, undefined, undefined, undefined, undefined, seeded)
      expect(saved.files).not.toContain(placed)
      saveProviderConfig(provider, 'sk-other', testModels[provider], 'reset', roots, {}, providerBaseUrls, undefined, undefined, undefined, undefined, seeded)
      expect(relayTemplateDefaultsPending(provider, roots, providerBaseUrls, process.platform, seeded)).toBe(false)
      expect(fillRelayTemplateDefaults(provider, roots, providerBaseUrls, {}, process.platform, seeded)).toBeNull()
      expect(fs.existsSync(placed)).toBe(false)
    }
  })

  it('recognises only its own untouched instructions', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    expect(managedGlobalResponseLanguagePresent('codex', roots)).toBe(false)
    saveProviderConfig('codex', 'sk-fixture', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    expect(managedGlobalResponseLanguagePresent('codex', roots)).toBe(true)
    // Windows line endings from an editor that only re-saved it still count as the same text.
    const placed = path.join(configDirectory('codex', roots), 'AGENTS.md')
    fs.writeFileSync(placed, MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS.replace(/\n/g, '\r\n'), 'utf8')
    expect(managedGlobalResponseLanguagePresent('codex', roots)).toBe(true)
    fs.writeFileSync(placed, `${MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS}- 回答尽量短。\n`, 'utf8')
    expect(managedGlobalResponseLanguagePresent('codex', roots)).toBe(false)
    writeFile(path.join(configDirectory('grok', roots), 'AGENTS.md'), 'Always answer in English.\n')
    expect(managedGlobalResponseLanguagePresent('grok', roots)).toBe(false)
    expect(managedGlobalResponseLanguagePresent('claude', roots)).toBe(false)
  })

  it('still places it in front when AGENTS.md holds only the standing instructions block', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'grok'] as const) {
      // The customer saved standing instructions before signing in, so the block is all the file has.
      expect(applyStandingInstructions(provider, '回答简短一点', roots).outcome).toBe('written')
      const placed = path.join(configDirectory(provider, roots), 'AGENTS.md')
      const block = fs.readFileSync(placed, 'utf8')

      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)

      expect(fs.readFileSync(placed, 'utf8')).toBe(`${MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS}\n${block}`)
      expect(managedGlobalResponseLanguagePresent(provider, roots)).toBe(true)
      expect(relayTemplateDefaultsPending(provider, roots, providerBaseUrls)).toBe(false)
    }
  })

  it('still recognises its own instructions with the standing instructions block after them, and clearing gives them back', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    for (const provider of ['codex', 'grok'] as const) {
      saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, providerBaseUrls)
      const placed = path.join(configDirectory(provider, roots), 'AGENTS.md')
      expect(applyStandingInstructions(provider, '回答简短一点', roots).outcome).toBe('written')
      expect(fs.readFileSync(placed, 'utf8').startsWith(MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS)).toBe(true)
      expect(managedGlobalResponseLanguagePresent(provider, roots)).toBe(true)

      expect(applyStandingInstructions(provider, '', roots).outcome).toBe('removed')
      expect(fs.readFileSync(placed, 'utf8')).toBe(MANAGED_GLOBAL_RESPONSE_LANGUAGE_INSTRUCTIONS)
    }
  })

  it('treats AGENTS.md with the customer\'s own words around the block as theirs', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const placed = path.join(configDirectory('codex', roots), 'AGENTS.md')
    writeFile(placed, 'Always answer in English.\n')
    expect(applyStandingInstructions('codex', '回答简短一点', roots).outcome).toBe('written')
    const before = fs.readFileSync(placed, 'utf8')

    saveProviderConfig('codex', 'sk-fixture', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    expect(fs.readFileSync(placed, 'utf8')).toBe(before)
    expect(managedGlobalResponseLanguagePresent('codex', roots)).toBe(false)
  })
})

describe('the Codex model catalog Xingmang writes', () => {
  const catalog = '{\n  "models": [\n    {\n      "slug": "gpt-6.1-sol"\n    }\n  ]\n}\n'
  const otherCatalog = '{\n  "models": [\n    {\n      "slug": "gpt-6-astra"\n    }\n  ]\n}\n'

  function saveCodex(roots: ReturnType<typeof providerRoots>, mode: 'reset' | 'merge', modelCatalog?: string | null, hooks = {}) {
    return saveProviderConfig('codex', 'sk-relay', testModels.codex, mode, roots, hooks, providerBaseUrls, undefined, undefined, undefined, modelCatalog)
  }

  function readConfig(roots: ReturnType<typeof providerRoots>): Record<string, unknown> {
    return asRecord(TOML.parse(fs.readFileSync(providerConfigPaths('codex', roots)[0], 'utf8'))) ?? {}
  }

  it('writes the catalog next to config.toml and points Codex at it above the first table', () => {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset', catalog)

    const text = fs.readFileSync(providerConfigPaths('codex', roots)[0], 'utf8')
    const line = text.indexOf('model_catalog_json = "xingmang-models.json"')
    expect(line).toBeGreaterThan(-1)
    expect(line).toBeLessThan(text.indexOf('['))
    expect(codexModelCatalogPath(roots)).toBe(path.join(roots.codexHome, 'xingmang-models.json'))
    expect(fs.readFileSync(codexModelCatalogPath(roots), 'utf8')).toBe(catalog)
  })

  it('commits the catalog before the config that points at it', () => {
    const roots = providerRoots(temporaryHome())
    const replaced: string[] = []
    saveCodex(roots, 'reset', catalog, { beforeReplace: (filePath: string) => { replaced.push(path.basename(filePath)) } })
    expect(replaced.indexOf('xingmang-models.json')).toBe(0)
    expect(replaced.indexOf('config.toml')).toBeGreaterThan(0)
  })

  it('adds the catalog to an existing config and rewrites the file only when it changed', () => {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset')
    expect('model_catalog_json' in readConfig(roots)).toBe(false)

    expect(saveCodex(roots, 'merge', catalog).files).toContain(codexModelCatalogPath(roots))
    expect(readConfig(roots).model_catalog_json).toBe('xingmang-models.json')
    expect(saveCodex(roots, 'merge', catalog).files).not.toContain(codexModelCatalogPath(roots))
    expect(saveCodex(roots, 'merge', otherCatalog).files).toContain(codexModelCatalogPath(roots))
    expect(fs.readFileSync(codexModelCatalogPath(roots), 'utf8')).toBe(otherCatalog)
  })

  it('takes back only its own line when no catalog should be written, and keeps the file for old backups', () => {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset', catalog)
    saveCodex(roots, 'merge', null)
    expect('model_catalog_json' in readConfig(roots)).toBe(false)
    expect(readConfig(roots).model).toBe(testModels.codex)
    expect(fs.existsSync(codexModelCatalogPath(roots))).toBe(true)
  })

  it('leaves the line and the file alone when the caller cannot tell what to write', () => {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset', catalog)
    saveCodex(roots, 'merge')
    expect(readConfig(roots).model_catalog_json).toBe('xingmang-models.json')
    expect(fs.readFileSync(codexModelCatalogPath(roots), 'utf8')).toBe(catalog)
  })

  it('never replaces a catalog the user pointed Codex at', () => {
    const roots = providerRoots(temporaryHome())
    const [configPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(configPath, 'model_catalog_json = "my-models.json"\n', 'utf8')

    saveCodex(roots, 'merge', catalog)
    expect(readConfig(roots).model_catalog_json).toBe('my-models.json')
    expect(fs.existsSync(codexModelCatalogPath(roots))).toBe(false)
    saveCodex(roots, 'merge', null)
    expect(readConfig(roots).model_catalog_json).toBe('my-models.json')
  })

  it('takes the line back on the official account and puts it back with the relay', () => {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset', catalog)

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    expect('model_catalog_json' in readConfig(roots)).toBe(false)
    expect(fs.existsSync(codexModelCatalogPath(roots))).toBe(true)

    saveCodex(roots, 'merge', catalog)
    expect(readConfig(roots).model_catalog_json).toBe('xingmang-models.json')
    expect('model_catalog_json' in asRecord(TOML.parse(fs.readFileSync(codexConfigSnapshotPaths(roots).chatgpt, 'utf8')))!).toBe(false)
  })

  it('keeps its line out of the saved ChatGPT config even when an official config still carries it', () => {
    const roots = providerRoots(temporaryHome())
    const configs = codexConfigSnapshotPaths(roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(configs.active, 'model_catalog_json = "xingmang-models.json"\napproval_policy = "never"\n', 'utf8')

    saveCodex(roots, 'merge', catalog)
    const official = asRecord(TOML.parse(fs.readFileSync(configs.chatgpt, 'utf8')))
    expect(official).toEqual({ approval_policy: 'never' })
  })

  it('reports whether the catalog on disk matches what the account needs', () => {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset')
    expect(codexModelCatalogNeedsRefresh(catalog, roots)).toBe(true)
    expect(codexModelCatalogNeedsRefresh(null, roots)).toBe(false)

    saveCodex(roots, 'merge', catalog)
    expect(codexModelCatalogNeedsRefresh(catalog, roots)).toBe(false)
    expect(codexModelCatalogNeedsRefresh(otherCatalog, roots)).toBe(true)
    expect(codexModelCatalogNeedsRefresh(null, roots)).toBe(true)

    fs.rmSync(codexModelCatalogPath(roots))
    expect(codexModelCatalogNeedsRefresh(catalog, roots)).toBe(true)
  })

  function expectLinkRefused(link: (target: string, linkPath: string) => void, refusal: RegExp) {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset', catalog)
    // Same volume as the Codex root, so a hard link can be made on every platform.
    const elsewhere = path.join(roots.userHome, 'elsewhere.json')
    fs.writeFileSync(elsewhere, catalog, 'utf8')
    fs.rmSync(codexModelCatalogPath(roots))
    link(elsewhere, codexModelCatalogPath(roots))

    expect(codexModelCatalogTargetUsable(roots)).toBe(false)
    expect(() => codexModelCatalogNeedsRefresh(catalog, roots)).toThrow(refusal)
    expect(inspectCodexModelCatalogOnDisk(roots)).toEqual({ managed: true, content: null })
    // 名单写不了不连累整次保存：Key 照存，那一行收回，链接指向的文件一个字不动。
    saveProviderConfig('codex', 'sk-relay-next', testModels.codex, 'merge', roots, {}, providerBaseUrls, undefined, undefined, undefined, otherCatalog)
    expect(inspectProviderConfig('codex', roots, providerBaseUrls).apiKey).toBe('sk-relay-next')
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe(catalog)
    expect('model_catalog_json' in readConfig(roots)).toBe(false)
  }

  it('saves the key without the catalog when the catalog was swapped for a hard link', () => {
    expectLinkRefused((target, linkPath) => fs.linkSync(target, linkPath), /xingmang-models\.json 是一个链接。为保障安全，星芒不会写入链接/)
  })

  // Creating a file symlink needs Developer Mode or administrator rights on Windows.
  it.skipIf(process.platform === 'win32')('saves the key without the catalog when the catalog was swapped for a symbolic link', () => {
    expectLinkRefused((target, linkPath) => fs.symlinkSync(target, linkPath), /xingmang-models\.json 是一个链接。为保障安全，星芒不会写入链接/)
  })

  it('reports whether config.toml carries its own catalog line and what that file holds', () => {
    const roots = providerRoots(temporaryHome())
    expect(inspectCodexModelCatalogOnDisk(roots)).toEqual({ managed: false, content: null })
    saveCodex(roots, 'reset', catalog)
    expect(inspectCodexModelCatalogOnDisk(roots)).toEqual({ managed: true, content: catalog })
    fs.rmSync(codexModelCatalogPath(roots))
    expect(inspectCodexModelCatalogOnDisk(roots)).toEqual({ managed: true, content: null })
    fs.writeFileSync(providerConfigPaths('codex', roots)[0], 'model_catalog_json = "my-models.json"\n', 'utf8')
    expect(inspectCodexModelCatalogOnDisk(roots)).toEqual({ managed: false, content: null })
  })

  it('takes back only its own line, from config.toml and the saved relay config, leaving every other byte alone', () => {
    const roots = providerRoots(temporaryHome())
    const configs = codexConfigSnapshotPaths(roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    const original = [
      '# 我自己的注释',
      'model = "gpt-6.1-sol"',
      "model_catalog_json = 'xingmang-models.json'  # 星芒写的",
      'model_provider = "xingmang"',
      '',
      '[model_providers.xingmang]',
      'name = "星芒"',
      '',
    ].join('\r\n')
    fs.writeFileSync(configs.active, original, 'utf8')
    fs.writeFileSync(configs.relay, original, 'utf8')
    fs.writeFileSync(codexModelCatalogPath(roots), catalog, 'utf8')

    const result = takeBackCodexModelCatalog(roots)

    const expected = original.replace("model_catalog_json = 'xingmang-models.json'  # 星芒写的\r\n", '')
    expect(fs.readFileSync(configs.active, 'utf8')).toBe(expected)
    expect(fs.readFileSync(configs.relay, 'utf8')).toBe(expected)
    expect(result?.files).toEqual([configs.relay, configs.active])
    expect(fs.readFileSync(codexModelCatalogPath(roots), 'utf8')).toBe(catalog)
  })

  it('keeps mixed line endings and values that only read back as big integers when it takes the line back', () => {
    const roots = providerRoots(temporaryHome())
    const [configPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    const original = 'model = "gpt-6.1-sol"\nmodel_catalog_json = "xingmang-models.json"\r\nproject_doc_max_bytes = 9007199254740993\r\n'
    fs.writeFileSync(configPath, original, 'utf8')

    expect(takeBackCodexModelCatalog(roots)).not.toBeNull()

    expect(fs.readFileSync(configPath, 'utf8')).toBe('model = "gpt-6.1-sol"\nproject_doc_max_bytes = 9007199254740993\r\n')
  })

  it('still takes the line back from config.toml when the saved relay config cannot be read', () => {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset', catalog)
    const configs = codexConfigSnapshotPaths(roots)
    fs.writeFileSync(configs.relay, 'model_catalog_json = "xingmang-models.json"\nmodel = [\n', 'utf8')

    expect(takeBackCodexModelCatalog(roots)?.files).toEqual([configs.active])

    expect('model_catalog_json' in readConfig(roots)).toBe(false)
    expect(fs.readFileSync(configs.relay, 'utf8')).toBe('model_catalog_json = "xingmang-models.json"\nmodel = [\n')
  })

  it('has nothing to take back when the line is absent or the user set their own catalog', () => {
    const roots = providerRoots(temporaryHome())
    expect(takeBackCodexModelCatalog(roots)).toBeNull()
    saveCodex(roots, 'reset')
    expect(takeBackCodexModelCatalog(roots)).toBeNull()
    const [configPath] = providerConfigPaths('codex', roots)
    fs.writeFileSync(configPath, 'model_catalog_json = "my-models.json"\n', 'utf8')
    expect(takeBackCodexModelCatalog(roots)).toBeNull()
    expect(fs.readFileSync(configPath, 'utf8')).toBe('model_catalog_json = "my-models.json"\n')
  })

  it('rewrites the whole file instead of cutting a line that only looks like its own', () => {
    const roots = providerRoots(temporaryHome())
    const [configPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(configPath, [
      'developer_instructions = """',
      'model_catalog_json = "xingmang-models.json"',
      '"""',
      '"model_catalog_json" = "xingmang-models.json"',
      'model = "gpt-6.1-sol"',
      '',
    ].join('\n'), 'utf8')

    expect(takeBackCodexModelCatalog(roots)).not.toBeNull()

    expect(readConfig(roots)).toEqual({
      developer_instructions: 'model_catalog_json = "xingmang-models.json"\n',
      model: 'gpt-6.1-sol',
    })
  })

  it('refuses to take the line back through a linked config.toml', () => {
    const roots = providerRoots(temporaryHome())
    saveCodex(roots, 'reset', catalog)
    const [configPath] = providerConfigPaths('codex', roots)
    const elsewhere = path.join(roots.userHome, 'config-elsewhere.toml')
    fs.renameSync(configPath, elsewhere)
    fs.linkSync(elsewhere, configPath)

    expect(() => takeBackCodexModelCatalog(roots)).toThrow(/config\.toml 是一个链接。为保障安全，星芒不会写入链接/)
    expect(asRecord(TOML.parse(fs.readFileSync(elsewhere, 'utf8')))?.model_catalog_json).toBe('xingmang-models.json')
  })
})

// Fable 第二轮 Q6：设置里「仅允许 Claude Code 修改项目文件夹内的文件」。星芒只写、只撤自己写的那一项。
describe('Claude write boundary toggle', () => {
  function relayClaude(seeded: Parameters<typeof saveProviderConfig>[11] = {}) {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls, undefined, undefined, undefined, undefined, seeded)
    const [configPath] = providerConfigPaths('claude', roots)
    const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8')) as { permissions?: Record<string, unknown>; [key: string]: unknown }
    const write = (value: unknown) => fs.writeFileSync(configPath, JSON.stringify(value, null, 2))
    return { roots, configPath, read, write }
  }

  it('leaves the setting out of the relay template while the toggle is off', () => {
    const { read } = relayClaude()
    expect(read().permissions).not.toHaveProperty('blockWritesOutsideWorkingDirectories')
  })

  it('writes the setting into the relay template when the toggle is on and takes it back on the official switch', () => {
    const { roots, read } = relayClaude({ claudeWritesInsideProject: true })
    expect(read().permissions?.blockWritesOutsideWorkingDirectories).toBe(true)
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    expect(read().permissions).toBeUndefined()
  })

  it('turns the setting on in place, touching nothing else, and off again', () => {
    const { roots, read } = relayClaude()
    const before = read()
    const on = applyClaudeToggle(roots, 'writesInsideProject', true)
    expect(on.outcome).toBe('written')
    expect(on.result.files.length).toBeGreaterThan(0)
    const after = read()
    expect(after.permissions?.blockWritesOutsideWorkingDirectories).toBe(true)
    delete after.permissions?.blockWritesOutsideWorkingDirectories
    expect(after).toEqual(before)
    expect(applyClaudeToggle(roots, 'writesInsideProject', true).outcome).toBe('unchanged')

    expect(applyClaudeToggle(roots, 'writesInsideProject', false).outcome).toBe('written')
    expect(read()).toEqual(before)
    expect(applyClaudeToggle(roots, 'writesInsideProject', false).outcome).toBe('unchanged')
  })

  it('never takes away a block the customer wrote themselves', () => {
    const { roots, read, write } = relayClaude()
    const own = read()
    own.permissions = { ...own.permissions, blockWritesOutsideWorkingDirectories: true }
    write(own)
    expect(applyClaudeToggle(roots, 'writesInsideProject', false).outcome).toBe('kept')
    expect(read().permissions?.blockWritesOutsideWorkingDirectories).toBe(true)
    // Turning it on records nothing, so a later official switch leaves it too.
    expect(applyClaudeToggle(roots, 'writesInsideProject', true).outcome).toBe('unchanged')
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    expect(read().permissions?.blockWritesOutsideWorkingDirectories).toBe(true)
  })

  it('leaves a value the customer set to false alone when the toggle is turned on', () => {
    const { roots, read, write } = relayClaude()
    const own = read()
    own.permissions = { ...own.permissions, blockWritesOutsideWorkingDirectories: false }
    write(own)
    expect(applyClaudeToggle(roots, 'writesInsideProject', true).outcome).toBe('kept')
    expect(read().permissions?.blockWritesOutsideWorkingDirectories).toBe(false)
  })

  it('does not rebuild a hand-broken permissions entry', () => {
    const { roots, read, write } = relayClaude()
    write({ ...read(), permissions: 'broken' })
    expect(applyClaudeToggle(roots, 'writesInsideProject', true).outcome).toBe('kept')
    expect((read() as Record<string, unknown>).permissions).toBe('broken')
  })

  it('writes nothing when Claude Code has no settings file yet', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    expect(applyClaudeToggle(roots, 'writesInsideProject', true)).toEqual({ outcome: 'unchanged', result: { backups: [], files: [] } })
    expect(fs.existsSync(providerConfigPaths('claude', roots)[0])).toBe(false)
  })

  it('removes the setting the toggle wrote when an account switch rewrites the config with the toggle off', () => {
    const { roots, read } = relayClaude()
    applyClaudeToggle(roots, 'writesInsideProject', true)
    saveProviderConfig('claude', 'sk-relay-2', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    expect(read().permissions).not.toHaveProperty('blockWritesOutsideWorkingDirectories')
  })

  it('keeps the setting through an account switch while the toggle is on and adds it to a config that lacks it', () => {
    const { roots, read } = relayClaude()
    saveProviderConfig('claude', 'sk-relay-2', testModels.claude, 'merge', roots, {}, providerBaseUrls, undefined, undefined, undefined, undefined, { claudeWritesInsideProject: true })
    expect(read().permissions?.blockWritesOutsideWorkingDirectories).toBe(true)
    saveProviderConfig('claude', 'sk-relay-3', testModels.claude, 'merge', roots, {}, providerBaseUrls, undefined, undefined, undefined, undefined, { claudeWritesInsideProject: true })
    expect(read().permissions?.blockWritesOutsideWorkingDirectories).toBe(true)
    // Recorded as written by the toggle, so going back to the official account takes it back.
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    expect(read().permissions).toBeUndefined()
  })

  it('takes back only the write boundary, not the confirmation defaults the customer kept', () => {
    const { roots, read, write } = relayClaude()
    applyClaudeToggle(roots, 'writesInsideProject', true)
    const settings = read()
    settings.permissions = { ...settings.permissions, defaultMode: 'acceptEdits' }
    write(settings)
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    expect(read().permissions).toEqual({ defaultMode: 'acceptEdits' })
  })
})

// 同类对比 备选 6：设置里「Claude Code 提交代码时不署名」。写对象形式（旧版 Claude Code 见到 true / false 会报错，
// 整份设置不读），只撤星芒原样写下的那一份。
describe('Claude commit attribution toggle', () => {
  function relayClaude(seeded: Parameters<typeof saveProviderConfig>[11] = {}) {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls, undefined, undefined, undefined, undefined, seeded)
    const [configPath] = providerConfigPaths('claude', roots)
    const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const write = (value: unknown) => fs.writeFileSync(configPath, JSON.stringify(value, null, 2))
    return { roots, read, write }
  }

  it('leaves attribution to Claude Code while the toggle is off', () => {
    expect(relayClaude().read()).not.toHaveProperty('attribution')
  })

  it('writes the object form into the relay template when the toggle is on and takes it back on the official switch', () => {
    const { roots, read } = relayClaude({ claudeHidesCommitAttribution: true })
    expect(read().attribution).toEqual({ commit: '', pr: '' })
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    expect(read()).not.toHaveProperty('attribution')
  })

  it('turns attribution off in place, touching nothing else, and back on', () => {
    const { roots, read } = relayClaude()
    const before = read()
    expect(applyClaudeToggle(roots, 'hidesCommitAttribution', true).outcome).toBe('written')
    const after = read()
    expect(after.attribution).toEqual({ commit: '', pr: '' })
    delete after.attribution
    expect(after).toEqual(before)
    expect(applyClaudeToggle(roots, 'hidesCommitAttribution', true).outcome).toBe('unchanged')
    expect(applyClaudeToggle(roots, 'hidesCommitAttribution', false).outcome).toBe('written')
    expect(read()).toEqual(before)
  })

  it('leaves attribution the customer wrote alone, whatever it says', () => {
    for (const own of [false, { commit: 'Made with care' }, { commit: '', pr: '' }]) {
      const { roots, read, write } = relayClaude()
      write({ ...read(), attribution: own })
      const enabled = applyClaudeToggle(roots, 'hidesCommitAttribution', true).outcome
      expect(enabled).toBe(JSON.stringify(own) === JSON.stringify({ commit: '', pr: '' }) ? 'unchanged' : 'kept')
      if (JSON.stringify(own) === JSON.stringify({ commit: '', pr: '' })) expect(applyClaudeToggle(roots, 'hidesCommitAttribution', false).outcome).toBe('kept')
      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
      expect(read().attribution).toEqual(own)
    }
  })

  it('stops counting the attribution as ours once the customer edits it', () => {
    const { roots, read, write } = relayClaude()
    applyClaudeToggle(roots, 'hidesCommitAttribution', true)
    write({ ...read(), attribution: { commit: '', pr: '', sessionUrl: false } })
    expect(applyClaudeToggle(roots, 'hidesCommitAttribution', false).outcome).toBe('unchanged')
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    expect(read().attribution).toEqual({ commit: '', pr: '', sessionUrl: false })
  })

  it('follows the toggle through account switches and keeps the two toggles apart', () => {
    const { roots, read } = relayClaude()
    const both = { claudeHidesCommitAttribution: true, claudeWritesInsideProject: true }
    saveProviderConfig('claude', 'sk-relay-2', testModels.claude, 'merge', roots, {}, providerBaseUrls, undefined, undefined, undefined, undefined, both)
    expect(read().attribution).toEqual({ commit: '', pr: '' })
    expect((read().permissions as Record<string, unknown>).blockWritesOutsideWorkingDirectories).toBe(true)
    saveProviderConfig('claude', 'sk-relay-3', testModels.claude, 'merge', roots, {}, providerBaseUrls, undefined, undefined, undefined, undefined, { claudeWritesInsideProject: true })
    expect(read()).not.toHaveProperty('attribution')
    expect((read().permissions as Record<string, unknown>).blockWritesOutsideWorkingDirectories).toBe(true)
  })
})

// 总单 17 的随机输入：「只有 Grok 安装程序写的那一两行」才当成还没配置，客户多写的任何一个字都让它不算；
// 合并写入只往里加，安装那几行一个字不改。
describe('Grok installer-only config with random inputs', () => {
  const key = fc.string({ minLength: 1, maxLength: 12 })
  const scalar = fc.oneof(fc.string({ maxLength: 20 }), fc.boolean(), fc.integer())
  const installerTable = fc.record({ installer: fc.string({ maxLength: 40 }), npm_registry: fc.string({ maxLength: 60 }) }, { requiredKeys: ['installer'] })

  it('accepts every config holding only what the installer writes', () => {
    fc.assert(fc.property(installerTable, (cli) => isGrokInstallerOnlyConfig({ cli })))
  })

  it('rejects a config with any other table or any other key in [cli]', () => {
    fc.assert(fc.property(installerTable, key.filter((name) => name !== 'cli'), scalar, (cli, table, value) => (
      !isGrokInstallerOnlyConfig({ cli, [table]: value }) && !isGrokInstallerOnlyConfig({ cli, [table]: { inner: value } })
    )))
    fc.assert(fc.property(installerTable, key.filter((name) => name !== 'installer' && name !== 'npm_registry'), scalar, (cli, extra, value) => (
      !isGrokInstallerOnlyConfig({ cli: { ...cli, [extra]: value } })
    )))
  })

  it('keeps the installer lines word for word when the account config is merged in', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('grok', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fc.assert(fc.property(installerTable, (cli) => {
      fs.writeFileSync(configPath, TOML.stringify({ cli }), 'utf8')
      saveProviderConfig('grok', 'sk-relay', testModels.grok, 'merge', roots, {}, providerBaseUrls)
      const written = TOML.parse(fs.readFileSync(configPath, 'utf8'))
      const inspection = inspectProviderConfig('grok', roots, providerBaseUrls)
      return JSON.stringify(written.cli) === JSON.stringify({ ...cli, auto_update: false })
        && inspection.apiKey === 'sk-relay' && inspection.matchesRelay
    }), { numRuns: 25 })
  })
})

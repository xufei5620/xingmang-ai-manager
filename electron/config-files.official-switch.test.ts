import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TOML from '@iarna/toml'
import {
  canLaunchManagedProvider,
  claudeModelPickerNeedsRefresh,
  claudeForeignModelEnvKeys,
  claudeForeignSettingsSnapshotName,
  moveClaudeForeignSettingsAside,
  recordClaudeFilledDefaults,
  restoreClaudeForeignSettings,
  withdrawClaudeFilledDefaults,
  inspectClaudeOfficialSkipsConfirmation,
  restoreClaudeOfficialCommandConfirmation,
  claudeNotOfficialMessage,
  planProviderPickerRefresh,
  codexAuthSnapshotPaths,
  forgetStaleGeminiUsageStatisticsRecord,
  geminiUsageStatisticsRecordName,
  fillRelayTemplateDefaults,
  inspectOfficialLogin,
  inspectProviderConfig,
  managedProviderLaunchBlockedMessage,
  providerAccountMode,
  providerConfigPaths,
  saveProviderConfig,
  switchProviderToOfficialAccount,
  toNativeConfigSummary,
} from './config-files'
import { providerBaseUrls } from './catalog'
import { relayProviderBaseUrls } from './relay-sites'
import {
  asRecord,
  providerRoots,
  removeTemporaryHomes,
  seedCodexRelayConfigWithChatGptLogin,
  temporaryHome,
  testModels,
} from './config-files.test-support'

afterEach(() => {
  vi.restoreAllMocks()
  removeTemporaryHomes()
})

// 本文件接着 config-files.official-codex.test.ts 的同名 describe：那边是 Codex 的官方快照、登录和别名表，
// 这边是 Claude Code、Gemini CLI、Grok CLI 切回官方，以及切换前后的拒绝、备份和账号模式判断。
describe('switching a provider back to the official subscription account', () => {
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
    // Artifact 对 claude.ai 账号用户是有用的,切回官方来源要把这条 deny 撤掉；
    // 「不逐条确认」是星芒替这个新客户补的，也撤掉（D5），permissions 空了连键一起删。
    expect(after.permissions).toBeUndefined()
    expect(after.skipDangerousModePermissionPrompt).toBeUndefined()
  })

  // 全面检测 Q7：照别家中转教程配过 Claude Code 的人，settings.json 里留着的这几项
  // 会顶掉当前账号。接当前账号时挪进快照，切回官方原样放回。
  const foreignClaudeSettings = () => ({
    env: {
      ANTHROPIC_API_KEY: 'sk-other-relay',
      ANTHROPIC_MODEL: 'glm-4.6',
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-4.5-air',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-4.6',
      CLAUDE_CODE_SUBAGENT_MODEL: 'glm-4.5-air',
      MY_OWN_VARIABLE: 'keep-me',
    },
    apiKeyHelper: '/usr/local/bin/print-other-key',
    theme: 'dark',
  })

  it('moves settings left by another relay aside for the account and puts them back for the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    const snapshotPath = path.join(path.dirname(configPath), claudeForeignSettingsSnapshotName)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const original = foreignClaudeSettings()
    fs.writeFileSync(configPath, JSON.stringify(original, null, 2))

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    const relay = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const relayEnv = relay.env as Record<string, unknown>
    for (const key of Object.keys(original.env).filter((key) => key !== 'MY_OWN_VARIABLE')) expect(relayEnv[key]).toBeUndefined()
    expect(relay.apiKeyHelper).toBeUndefined()
    expect(relayEnv.ANTHROPIC_AUTH_TOKEN).toBe('sk-relay')
    expect(relayEnv.MY_OWN_VARIABLE).toBe('keep-me')
    expect(relay.theme).toBe('dark')
    expect(inspectProviderConfig('claude', roots).matchesRelay).toBe(true)
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))).toMatchObject({
      env: { ANTHROPIC_API_KEY: 'sk-other-relay', ANTHROPIC_MODEL: 'glm-4.6' },
      settings: { apiKeyHelper: '/usr/local/bin/print-other-key' },
    })

    // 再保存一次（换 Key、换模型）不能把快照里的东西弄丢。
    saveProviderConfig('claude', 'sk-relay-2', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).env.ANTHROPIC_API_KEY).toBe('sk-other-relay')

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    const official = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(official.env).toMatchObject(original.env)
    expect(official.apiKeyHelper).toBe(original.apiKeyHelper)
    expect(official.theme).toBe('dark')
    expect(fs.readFileSync(snapshotPath, 'utf8')).toBe('')
  })

  // CC Switch 写的样子照抄它的源码（services/proxy.rs 的接管、codexProviderPresets.ts 的模板）。
  // 首页「改用当前账号」走的就是这条 merge，写完必须认得出是当前中转。
  it('takes over files written by CC Switch, including its local proxy takeover', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [claudePath] = providerConfigPaths('claude', roots)
    const [codexConfigPath, codexAuthPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(claudePath), { recursive: true })
    fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true })
    fs.writeFileSync(claudePath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
        CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5',
      },
    }))
    fs.writeFileSync(codexConfigPath, [
      'model_provider = "custom"', 'model = "glm-5"', 'model_reasoning_effort = "high"', 'disable_response_storage = true', '',
      '[model_providers.custom]', 'name = "Other"', 'base_url = "https://other.example/v1"', 'wire_api = "responses"', 'requires_openai_auth = true', '',
    ].join('\n'))
    fs.writeFileSync(codexAuthPath, JSON.stringify({ OPENAI_API_KEY: 'sk-other' }))

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    expect(inspectProviderConfig('claude', roots)).toMatchObject({ matchesRelay: true, apiKey: 'sk-relay' })
    expect(inspectProviderConfig('codex', roots)).toMatchObject({ matchesRelay: true, apiKey: 'sk-relay' })
    const claudeEnv = (JSON.parse(fs.readFileSync(claudePath, 'utf8')) as { env: Record<string, unknown> }).env
    expect(claudeEnv.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined()
    expect(claudeEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
  })

  it('keeps foreign Claude settings through a reset and restores them on an official reset', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(foreignClaudeSettings(), null, 2))

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)
    const relay = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect((relay.env as Record<string, unknown>).ANTHROPIC_MODEL).toBeUndefined()

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls, 'reset')
    const official = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect((official.env as Record<string, unknown>).ANTHROPIC_MODEL).toBe('glm-4.6')
    expect((official.env as Record<string, unknown>).DISABLE_AUTOUPDATER).toBe('1')
    expect(official.apiKeyHelper).toBe('/usr/local/bin/print-other-key')
  })

  it('does not write a foreign-settings snapshot when there is nothing foreign to move', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    // 权限模式客户自己设过，星芒不补，也就没有记号要记。
    fs.writeFileSync(configPath, JSON.stringify({
      env: { MY_OWN_VARIABLE: 'x' },
      permissions: { defaultMode: 'acceptEdits' },
      skipDangerousModePermissionPrompt: false,
    }, null, 2))

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

    expect(fs.existsSync(path.join(path.dirname(configPath), claudeForeignSettingsSnapshotName))).toBe(false)
  })

  it('never hands the account key back to the official config and prefers values the user set again', () => {
    const settings: Record<string, unknown> = { env: { ANTHROPIC_API_KEY: 'sk-relay', ANTHROPIC_MODEL: 'glm-4.6' } }
    const snapshot = moveClaudeForeignSettingsAside(settings, null, 'sk-relay')
    expect(settings.env).toBeUndefined()
    expect(JSON.parse(String(snapshot)).env).toEqual({ ANTHROPIC_MODEL: 'glm-4.6' })

    const official: Record<string, unknown> = { env: { ANTHROPIC_MODEL: 'claude-opus-5' } }
    expect(restoreClaudeForeignSettings(official, snapshot)).toBe(false)
    expect(official.env).toEqual({ ANTHROPIC_MODEL: 'claude-opus-5' })
    // 本软件自己的选模型菜单写的 ANTHROPIC_DEFAULT_MODEL 不归这张表管。
    const own: Record<string, unknown> = { env: { ANTHROPIC_DEFAULT_MODEL: 'claude-sonnet-5' } }
    expect(moveClaudeForeignSettingsAside(own, null, 'sk-relay')).toBeNull()
  })

  // 0.2.24 深查「反复切换」N4：官方账号那边客户自己选的型号，接当前账号再切回官方以后还得在。
  it('puts the official Claude model back after a round trip through the account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    const snapshotPath = path.join(path.dirname(configPath), claudeForeignSettingsSnapshotName)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ model: 'opus', theme: 'dark' }, null, 2))

    for (let round = 0; round < 2; round += 1) {
      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).model).toBe(testModels.claude)
      // Saving again on the account (new key, another model) must not replace the stashed official model.
      saveProviderConfig('claude', 'sk-relay-2', 'claude-other-model', 'merge', roots, {}, providerBaseUrls)

      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
      const official = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
      expect(official.model).toBe('opus')
      expect(official.theme).toBe('dark')
      expect(fs.readFileSync(snapshotPath, 'utf8')).toBe('')
    }
  })

  it('keeps the official Claude model through an account reset and an official reset', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ model: 'claude-opus-5' }, null, 2))

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).model).toBe(testModels.claude)

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls, 'reset')
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).model).toBe('claude-opus-5')
  })

  it('leaves the Claude model unset for the official account when it never had one', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    // 权限模式客户自己设过，快照里不会有「不逐条确认」的记号，只看型号存没存。
    fs.writeFileSync(configPath, JSON.stringify({
      theme: 'dark',
      permissions: { defaultMode: 'default' },
      skipDangerousModePermissionPrompt: false,
    }, null, 2))

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).model).toBeUndefined()
    expect(fs.existsSync(path.join(path.dirname(configPath), claudeForeignSettingsSnapshotName))).toBe(false)
  })

  // 0.2.24 深查 D5（反复切换 N7）：接当前账号时星芒补上的「不逐条确认」记在快照里，切回官方只撤这几项。
  describe('Claude command-confirmation defaults filled by the account', () => {
    function claudeFiles(home: string) {
      const roots = providerRoots(home)
      const [configPath] = providerConfigPaths('claude', roots)
      return { roots, configPath, snapshotPath: path.join(path.dirname(configPath), claudeForeignSettingsSnapshotName) }
    }

    function readSettings(configPath: string): Record<string, unknown> {
      return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    }

    function writeSettings(configPath: string, settings: Record<string, unknown>): void {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify(settings, null, 2))
    }

    it('withdraws both defaults for a customer who never set them, on every round trip', () => {
      const home = temporaryHome()
      const { roots, configPath, snapshotPath } = claudeFiles(home)

      for (let round = 0; round < 2; round += 1) {
        saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
        const relay = readSettings(configPath)
        expect(asRecord(relay.permissions)?.defaultMode).toBe('bypassPermissions')
        expect(relay.skipDangerousModePermissionPrompt).toBe(true)
        expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).filled)
          .toEqual(['permissions.defaultMode', 'skipDangerousModePermissionPrompt'])
        // Saving again on the account must keep the marks: the values are still the ones Xingmang wrote.
        saveProviderConfig('claude', 'sk-relay-2', testModels.claude, 'merge', roots, {}, providerBaseUrls)

        switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
        const official = readSettings(configPath)
        expect(official).not.toHaveProperty('permissions')
        expect(official).not.toHaveProperty('skipDangerousModePermissionPrompt')
        expect(fs.readFileSync(snapshotPath, 'utf8')).toBe('')
      }
    })

    it.each([
      ['a stricter mode', { defaultMode: 'acceptEdits' }, false],
      ['the same bypass mode', { defaultMode: 'bypassPermissions' }, true],
    ] as const)('keeps %s the customer set before connecting', (_label, permissions, skipPrompt) => {
      const home = temporaryHome()
      const { roots, configPath } = claudeFiles(home)
      writeSettings(configPath, { permissions: { ...permissions }, skipDangerousModePermissionPrompt: skipPrompt })

      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      const official = readSettings(configPath)
      expect(official.permissions).toEqual(permissions)
      expect(official.skipDangerousModePermissionPrompt).toBe(skipPrompt)
    })

    it('keeps a mode the customer changed while on the account and withdraws only the untouched one', () => {
      const home = temporaryHome()
      const { roots, configPath } = claudeFiles(home)
      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
      const relay = readSettings(configPath)
      asRecord(relay.permissions)!.defaultMode = 'plan'
      writeSettings(configPath, relay)

      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      const official = readSettings(configPath)
      expect(official.permissions).toEqual({ defaultMode: 'plan' })
      expect(official).not.toHaveProperty('skipDangerousModePermissionPrompt')
    })

    it('drops a mark the customer took over while on the account, even if they set the value back later', () => {
      const home = temporaryHome()
      const { roots, configPath } = claudeFiles(home)
      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
      const changed = readSettings(configPath)
      asRecord(changed.permissions)!.defaultMode = 'plan'
      writeSettings(configPath, changed)
      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
      const back = readSettings(configPath)
      asRecord(back.permissions)!.defaultMode = 'bypassPermissions'
      writeSettings(configPath, back)

      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      expect(asRecord(readSettings(configPath).permissions)?.defaultMode).toBe('bypassPermissions')
    })

    it('ignores stale marks when the settings went back to the official account without the snapshot', () => {
      // 切到当前账号失败按备份退回官方时，备份里没有这份快照，记号还在；客户随后自己开的同一项不能算星芒补的。
      const home = temporaryHome()
      const { roots, configPath, snapshotPath } = claudeFiles(home)
      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
      expect(fs.readFileSync(snapshotPath, 'utf8')).toContain('permissions.defaultMode')
      writeSettings(configPath, { permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true })

      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
      expect(fs.readFileSync(snapshotPath, 'utf8')).toBe('')
      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      const official = readSettings(configPath)
      expect(official.permissions).toEqual({ defaultMode: 'bypassPermissions' })
      expect(official.skipDangerousModePermissionPrompt).toBe(true)
    })

    it('leaves defaults written before the marks existed alone when switching to the official account', () => {
      // 0.2.24 之前接过星芒的配置：快照里没有记号，分不清是不是客户自己设的，照旧不动。
      const home = temporaryHome()
      const { roots, configPath, snapshotPath } = claudeFiles(home)
      writeSettings(configPath, {
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-relay', ANTHROPIC_BASE_URL: providerBaseUrls.claude },
        permissions: { defaultMode: 'bypassPermissions', deny: ['Artifact', 'DesignSync'] },
        skipDangerousModePermissionPrompt: true,
        model: testModels.claude,
      })
      fs.writeFileSync(snapshotPath, JSON.stringify({ version: 1, env: {}, settings: { model: 'opus' } }))

      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)
      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      const official = readSettings(configPath)
      expect(official.permissions).toEqual({ defaultMode: 'bypassPermissions' })
      expect(official.skipDangerousModePermissionPrompt).toBe(true)
      expect(official.model).toBe('opus')
    })

    it('marks the defaults an account reset fills over an official config that never had them', () => {
      const home = temporaryHome()
      const { roots, configPath } = claudeFiles(home)
      writeSettings(configPath, { theme: 'dark', skipDangerousModePermissionPrompt: false })

      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)
      expect(readSettings(configPath).skipDangerousModePermissionPrompt).toBe(true)
      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      // The reset overwrote the customer's own false, so only the mode Xingmang added is withdrawn.
      const official = readSettings(configPath)
      expect(official).not.toHaveProperty('permissions')
      expect(official.skipDangerousModePermissionPrompt).toBe(true)
    })

    it('marks the mode the startup template fill adds so the official switch withdraws it too', () => {
      const home = temporaryHome()
      const { roots, configPath, snapshotPath } = claudeFiles(home)
      writeSettings(configPath, {
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-relay', ANTHROPIC_BASE_URL: providerBaseUrls.claude },
        permissions: { deny: ['Artifact', 'DesignSync'] },
        skipDangerousModePermissionPrompt: false,
        model: testModels.claude,
      })

      fillRelayTemplateDefaults('claude', roots, providerBaseUrls)
      expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).filled).toEqual(['permissions.defaultMode'])
      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      const official = readSettings(configPath)
      expect(official).not.toHaveProperty('permissions')
      expect(official.skipDangerousModePermissionPrompt).toBe(false)
    })

    it('does not touch the snapshot when the startup fill has no confirmation default to add', () => {
      const home = temporaryHome()
      const { roots, configPath, snapshotPath } = claudeFiles(home)
      writeSettings(configPath, {
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-relay', ANTHROPIC_BASE_URL: providerBaseUrls.claude },
        permissions: { defaultMode: 'default', deny: ['Artifact', 'DesignSync'] },
        skipDangerousModePermissionPrompt: false,
      })

      fillRelayTemplateDefaults('claude', roots, providerBaseUrls)

      expect(fs.existsSync(snapshotPath)).toBe(false)
    })

    it('reads only known marks and withdraws a mark only while the value is still the one written', () => {
      const snapshot = JSON.stringify({ version: 1, env: {}, settings: {}, filled: ['permissions.defaultMode', 'theme', 7, 'skipDangerousModePermissionPrompt'] })
      const settings: Record<string, unknown> = {
        permissions: { defaultMode: 'bypassPermissions', allow: ['Read'] },
        skipDangerousModePermissionPrompt: 'yes',
        theme: 'dark',
      }
      expect(withdrawClaudeFilledDefaults(settings, snapshot)).toEqual(['permissions.defaultMode'])
      expect(settings).toEqual({ permissions: { allow: ['Read'] }, skipDangerousModePermissionPrompt: 'yes', theme: 'dark' })
      expect(withdrawClaudeFilledDefaults({ permissions: 'bypassPermissions' }, snapshot)).toEqual([])
      expect(withdrawClaudeFilledDefaults(settings, null)).toEqual([])
    })

    it('keeps the stashed foreign settings when recording or clearing marks', () => {
      const stashed = JSON.stringify({ version: 1, env: { ANTHROPIC_MODEL: 'glm-4.6' }, settings: { model: 'opus' } })
      const marked = recordClaudeFilledDefaults(stashed, { skipDangerousModePermissionPrompt: true }, ['skipDangerousModePermissionPrompt'], true)
      expect(JSON.parse(String(marked))).toEqual({
        version: 1, env: { ANTHROPIC_MODEL: 'glm-4.6' }, settings: { model: 'opus' }, filled: ['skipDangerousModePermissionPrompt'],
      })
      // Nothing new to record and the mark still holds: the snapshot stays as it is.
      expect(recordClaudeFilledDefaults(marked, { skipDangerousModePermissionPrompt: true }, [], false)).toBeNull()
      // Coming from the official account clears old marks without dropping what was stashed.
      expect(JSON.parse(String(recordClaudeFilledDefaults(marked, {}, [], true)))).toEqual(JSON.parse(stashed))
      expect(recordClaudeFilledDefaults(JSON.stringify({ version: 1, env: {}, settings: {}, filled: ['skipDangerousModePermissionPrompt'] }), {}, [], true)).toBe('')
    })
  })

  // Fable 复查第一轮 3：0.2.24 之前接过星芒的老配置没有记号，切回官方以后「不逐条确认」还开着，问客户一次，他点了才撤。
  describe('Claude command confirmation left on after the official switch', () => {
    function claudeFiles(home: string) {
      const roots = providerRoots(home)
      const [configPath] = providerConfigPaths('claude', roots)
      return { roots, configPath, snapshotPath: path.join(path.dirname(configPath), claudeForeignSettingsSnapshotName) }
    }

    function readSettings(configPath: string): Record<string, unknown> {
      return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    }

    function writeSettings(configPath: string, settings: Record<string, unknown>): void {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify(settings, null, 2))
    }

    /** A config written before the marks existed: the defaults are in settings.json, the snapshot has no filled column. */
    function legacyRelayConfig(configPath: string, snapshotPath: string): void {
      writeSettings(configPath, {
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-relay', ANTHROPIC_BASE_URL: providerBaseUrls.claude },
        permissions: { defaultMode: 'bypassPermissions', deny: ['Artifact', 'DesignSync'], allow: ['Read'] },
        skipDangerousModePermissionPrompt: true,
        theme: 'dark',
        model: testModels.claude,
      })
      fs.writeFileSync(snapshotPath, JSON.stringify({ version: 1, env: {}, settings: {} }))
    }

    it('sees the bypass mode a legacy config keeps after switching to the official account', () => {
      const home = temporaryHome()
      const { roots, configPath, snapshotPath } = claudeFiles(home)
      legacyRelayConfig(configPath, snapshotPath)
      // Still on the account: the question is about the official side only.
      expect(inspectClaudeOfficialSkipsConfirmation(roots)).toBe(false)

      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      expect(asRecord(readSettings(configPath).permissions)?.defaultMode).toBe('bypassPermissions')
      expect(inspectClaudeOfficialSkipsConfirmation(roots)).toBe(true)
    })

    it('has nothing to ask once the marks withdrew the defaults Xingmang filled', () => {
      const home = temporaryHome()
      const { roots } = claudeFiles(home)
      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

      expect(inspectClaudeOfficialSkipsConfirmation(roots)).toBe(false)
    })

    it.each([
      ['no settings file', null],
      ['a stricter mode', JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } })],
      ['a file Claude Code cannot read', '{ not json'],
      ['permissions that are not a table', JSON.stringify({ permissions: 'bypassPermissions' })],
    ] as const)('does not ask with %s and never throws', (_label, content) => {
      const home = temporaryHome()
      const { roots, configPath } = claudeFiles(home)
      if (content !== null) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, content)
      }

      expect(inspectClaudeOfficialSkipsConfirmation(roots)).toBe(false)
    })

    it('puts the official Claude Code back to asking first and leaves everything else as it was', () => {
      const home = temporaryHome()
      const { roots, configPath, snapshotPath } = claudeFiles(home)
      legacyRelayConfig(configPath, snapshotPath)
      switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
      const before = readSettings(configPath)
      const backup = vi.fn()

      const { outcome, result } = restoreClaudeOfficialCommandConfirmation(roots, backup)

      expect(outcome).toBe('written')
      expect(backup).toHaveBeenCalledTimes(1)
      expect(result.files).toEqual([configPath])
      const after = readSettings(configPath)
      const { permissions: _beforePermissions, skipDangerousModePermissionPrompt: _skip, ...rest } = before
      expect(after).toEqual({ ...rest, permissions: { allow: ['Read'] } })
      expect(inspectClaudeOfficialSkipsConfirmation(roots)).toBe(false)
    })

    it('drops the permissions table it empties and keeps a prompt flag the customer set to something else', () => {
      const home = temporaryHome()
      const { roots, configPath } = claudeFiles(home)
      writeSettings(configPath, { permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: 'yes' })

      expect(restoreClaudeOfficialCommandConfirmation(roots).outcome).toBe('written')

      expect(readSettings(configPath)).toEqual({ skipDangerousModePermissionPrompt: 'yes' })
    })

    it('writes nothing and skips the backup when Claude Code already asks first', () => {
      const home = temporaryHome()
      const { roots, configPath } = claudeFiles(home)
      writeSettings(configPath, { permissions: { defaultMode: 'plan' }, skipDangerousModePermissionPrompt: true })
      const backup = vi.fn()

      expect(restoreClaudeOfficialCommandConfirmation(roots, backup)).toEqual({ outcome: 'unchanged', result: { backups: [], files: [] } })
      expect(restoreClaudeOfficialCommandConfirmation(providerRoots(temporaryHome()), backup).outcome).toBe('unchanged')

      expect(backup).not.toHaveBeenCalled()
      expect(readSettings(configPath)).toEqual({ permissions: { defaultMode: 'plan' }, skipDangerousModePermissionPrompt: true })
    })

    it('refuses to touch a config that is back on the account', () => {
      const home = temporaryHome()
      const { roots, configPath, snapshotPath } = claudeFiles(home)
      legacyRelayConfig(configPath, snapshotPath)
      const before = fs.readFileSync(configPath, 'utf8')
      const backup = vi.fn()

      expect(() => restoreClaudeOfficialCommandConfirmation(roots, backup)).toThrow(claudeNotOfficialMessage)

      expect(backup).not.toHaveBeenCalled()
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
    })

    it('does not write when the backup fails', () => {
      const home = temporaryHome()
      const { roots, configPath } = claudeFiles(home)
      writeSettings(configPath, { permissions: { defaultMode: 'bypassPermissions' } })
      const before = fs.readFileSync(configPath, 'utf8')

      expect(() => restoreClaudeOfficialCommandConfirmation(roots, () => { throw new Error('未能先备份 Claude Code 的配置，本次未修改') }))
        .toThrow('未能先备份 Claude Code 的配置，本次未修改')

      expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
    })
  })

  // 别家中转的型号放回官方账号只会选到官方没有的型号：接当前账号前已经接着别家的，不记它。
  it('never hands a model chosen on another relay to the official Claude account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-other-relay', ANTHROPIC_BASE_URL: 'https://other.example' },
      model: 'glm-4.6',
    }, null, 2))

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).model).toBeUndefined()
  })

  it('stashes the official Claude model without touching settings and prefers a model set again', () => {
    const settings: Record<string, unknown> = { model: 'claude-sonnet-5' }
    const snapshot = moveClaudeForeignSettingsAside(settings, null, 'sk-relay', 'opus')
    expect(settings).toEqual({ model: 'claude-sonnet-5' })
    expect(JSON.parse(String(snapshot)).settings).toEqual({ model: 'opus' })

    const official: Record<string, unknown> = {}
    expect(restoreClaudeForeignSettings(official, snapshot)).toBe(true)
    expect(official.model).toBe('opus')
    const changed: Record<string, unknown> = { model: 'haiku' }
    expect(restoreClaudeForeignSettings(changed, snapshot)).toBe(false)
    expect(changed.model).toBe('haiku')
    // Without an official model the snapshot stays as it was.
    expect(moveClaudeForeignSettingsAside({ model: 'claude-sonnet-5' }, snapshot, 'sk-relay')).toBeNull()
  })

  // 从星芒打开 Claude Code 时不交给它的选型号变量（system-service.ts，已知45 跟进），得和接账号时
  // 从 settings.json 挪开的是同一批，只差那把 Key。
  it('names as model choices exactly what connecting the account moves aside, less the key', () => {
    const env = Object.fromEntries([...claudeForeignModelEnvKeys, 'ANTHROPIC_API_KEY', 'MY_OWN_VARIABLE'].map((key) => [key, 'x']))
    const settings: Record<string, unknown> = { env: { ...env } }

    moveClaudeForeignSettingsAside(settings, null, 'sk-relay')

    const left = settings.env as Record<string, unknown>
    expect(Object.keys(env).filter((key) => !(key in left)).sort()).toEqual([...claudeForeignModelEnvKeys, 'ANTHROPIC_API_KEY'].sort())
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

  it('replaces the Claude model menu with the models the key can use and takes it back for the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    saveProviderConfig('claude', 'sk-relay', 'claude-sonnet-5', 'reset', roots, {}, providerBaseUrls, undefined, [
      'claude-opus-5',
      'claude-sonnet-5',
    ])
    const relay = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(relay.env)?.ANTHROPIC_DEFAULT_MODEL).toBe('claude-sonnet-5')
    expect(relay.modelPicker).toEqual({
      replaceBuiltInOptions: true,
      options: [
        { model: 'claude-opus-5', label: 'Opus 5', description: 'claude-opus-5' },
        { model: 'claude-sonnet-5', label: 'Sonnet 5', description: 'claude-sonnet-5' },
      ],
    })

    saveProviderConfig('claude', 'sk-relay', 'claude-opus-5', 'merge', roots, {}, providerBaseUrls, undefined, ['claude-opus-5'])
    const merged = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(merged.env)?.ANTHROPIC_DEFAULT_MODEL).toBe('claude-opus-5')
    expect(asRecord(merged.modelPicker)?.options).toHaveLength(1)

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    const official = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(official).not.toHaveProperty('modelPicker')
    expect(asRecord(official.env)).not.toHaveProperty('ANTHROPIC_DEFAULT_MODEL')
  })

  it('writes Claude fallback models from the key\'s models, follows a model change, and keeps them for the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    const models = ['claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5']
    saveProviderConfig('claude', 'sk-relay', 'claude-opus-5-5', 'reset', roots, {}, providerBaseUrls, undefined, models)
    expect((JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>).fallbackModel).toEqual(['claude-opus-5', 'claude-sonnet-5-5'])

    saveProviderConfig('claude', 'sk-relay', 'claude-sonnet-5-5', 'merge', roots, {}, providerBaseUrls, undefined, models)
    expect((JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>).fallbackModel).toEqual(['claude-opus-5-5'])

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    expect((JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>).fallbackModel).toEqual(['claude-opus-5-5'])
  })

  it('does not put Claude fallback models back on save once they have been on this computer and the customer deleted them', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('claude', roots)
    const models = ['claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5']
    const seeded = { claudeFallbackModel: true }
    saveProviderConfig('claude', 'sk-relay', 'claude-opus-5-5', 'reset', roots, {}, providerBaseUrls, undefined, models)
    const { fallbackModel: _deleted, ...settings } = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf8')

    saveProviderConfig('claude', 'sk-relay', 'claude-sonnet-5-5', 'merge', roots, {}, providerBaseUrls, undefined, models, undefined, undefined, seeded)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).not.toHaveProperty('fallbackModel')
    saveProviderConfig('claude', 'sk-relay', 'claude-sonnet-5-5', 'reset', roots, {}, providerBaseUrls, undefined, models, undefined, undefined, seeded)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).not.toHaveProperty('fallbackModel')
    expect(claudeModelPickerNeedsRefresh(models, 'claude-sonnet-5-5', roots, seeded)).toBe(false)
    expect(planProviderPickerRefresh('claude', 'claude-sonnet-5-5', models, roots, undefined, seeded)).toEqual({ status: 'current' })
    // Without the record it looks like settings an older version wrote, and the menu refresh fills them in.
    expect(claudeModelPickerNeedsRefresh(models, 'claude-sonnet-5-5', roots)).toBe(true)
  })

  it('leaves the Claude model menu untouched when no model list is supplied', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('claude', roots)
    const settings = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(settings).not.toHaveProperty('modelPicker')
    expect(asRecord(settings.env)).not.toHaveProperty('ANTHROPIC_DEFAULT_MODEL')
  })

  it('removes only the claude.ai-only tools from the Claude deny list when switching to the official account', () => {
    const home = temporaryHome()
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', providerRoots(home), {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('claude', providerRoots(home))
    const seeded = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const permissions = seeded.permissions as Record<string, unknown>
    permissions.deny = ['Bash(curl:*)', 'Artifact', 'WebFetch', 'DesignSync']
    permissions.allow = ['Read']
    fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2))

    switchProviderToOfficialAccount('claude', providerRoots(home), {}, providerBaseUrls)

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
    // defaultMode 是星芒替新客户补的，跟着撤掉（D5）；客户自己加的 deny、allow 原样留着。
    expect(asRecord(after.permissions)).toEqual({
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

  it('covers the Flash models Gemini CLI 0.61.0 added to its built-in table and model menu', () => {
    // 0.61.0 的 /model 菜单列出这两个；不改写的话选了就直接发出官方型号名。
    const home = temporaryHome()
    saveProviderConfig('gemini', 'sk-relay', 'gemini-3.8-flash', 'reset', providerRoots(home), {}, providerBaseUrls)
    const [settingsPath] = providerConfigPaths('gemini', providerRoots(home))
    const overrides = asRecord(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).modelConfigs)?.customOverrides
    for (const helper of ['gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
      expect(overrides).toContainEqual({
        match: { model: helper },
        modelConfig: { model: 'gemini-3.8-flash-high' },
      })
    }
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

  it('turns off Gemini usage statistics on the relay, respects a user choice and takes back only its own switch', () => {
    // With statistics on, every relay request carries a stable installation id header.
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ privacy: { usageStatisticsEnabled: true } }), 'utf8')
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).privacy).toEqual({ usageStatisticsEnabled: true })

    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'Dark' }), 'utf8')
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).privacy).toEqual({ usageStatisticsEnabled: false })

    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)
    const official = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(official).not.toHaveProperty('privacy')
    expect(official.theme).toBe('Dark')
  })

  it('keeps the Gemini usage statistics a user turned off before using the relay when switching back to Google', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    const recordPath = path.join(path.dirname(settingsPath), geminiUsageStatisticsRecordName)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ privacy: { usageStatisticsEnabled: false }, theme: 'Dark' }), 'utf8')

    const saved = saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls)
    expect(saved.files).not.toContain(recordPath)
    expect(fs.existsSync(recordPath)).toBe(false)

    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)
    const official = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(official.privacy).toEqual({ usageStatisticsEnabled: false })
    expect(official.theme).toBe('Dark')
  })

  it('forgets its own Gemini usage statistics switch once it is taken back', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    const recordPath = path.join(path.dirname(settingsPath), geminiUsageStatisticsRecordName)
    const settings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'reset', roots, {}, providerBaseUrls)
    expect(settings().privacy).toEqual({ usageStatisticsEnabled: false })
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toEqual({ version: 1, usageStatisticsEnabled: false })

    // A second save that writes the switch again does not rewrite the record (no extra backup).
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings(), privacy: {} }), 'utf8')
    const again = saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls)
    expect(settings().privacy).toEqual({ usageStatisticsEnabled: false })
    expect(again.files).not.toContain(recordPath)

    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)
    expect(settings()).not.toHaveProperty('privacy')
    expect(fs.readFileSync(recordPath, 'utf8')).toBe('')

    // Turned off by the user on the Google account: a relay round trip must leave it alone.
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings(), privacy: { usageStatisticsEnabled: false } }), 'utf8')
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls)
    expect(fs.readFileSync(recordPath, 'utf8')).toBe('')
    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)
    expect(settings().privacy).toEqual({ usageStatisticsEnabled: false })
  })

  it('does not take back a Gemini usage statistics switch when its record is unreadable', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    const recordPath = path.join(path.dirname(settingsPath), geminiUsageStatisticsRecordName)
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'reset', roots, {}, providerBaseUrls)
    fs.writeFileSync(recordPath, '{not-json', 'utf8')

    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)

    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).privacy).toEqual({ usageStatisticsEnabled: false })
    expect(fs.readFileSync(recordPath, 'utf8')).toBe('')
  })

  it('forgets its Gemini usage statistics record once a restored settings.json no longer has that switch', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    const recordPath = path.join(path.dirname(settingsPath), geminiUsageStatisticsRecordName)
    const google = JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } }, theme: 'Dark' })
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, google, 'utf8')
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls)

    // The switch is rolled back: the backup puts settings.json back, but not the record.
    fs.writeFileSync(settingsPath, google, 'utf8')
    expect(forgetStaleGeminiUsageStatisticsRecord(roots)).toBe(true)
    expect(fs.readFileSync(recordPath, 'utf8')).toBe('')
    expect(forgetStaleGeminiUsageStatisticsRecord(roots)).toBe(false)

    // Later the user turns statistics off on Google; a relay round trip leaves it alone.
    fs.writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(google), privacy: { usageStatisticsEnabled: false } }), 'utf8')
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls)
    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).privacy).toEqual({ usageStatisticsEnabled: false })
  })

  it('keeps its Gemini usage statistics record while the restored settings.json still has that switch', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    const recordPath = path.join(path.dirname(settingsPath), geminiUsageStatisticsRecordName)
    expect(forgetStaleGeminiUsageStatisticsRecord(roots)).toBe(false)
    expect(fs.existsSync(recordPath)).toBe(false)

    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'reset', roots, {}, providerBaseUrls)
    const record = fs.readFileSync(recordPath, 'utf8')
    expect(forgetStaleGeminiUsageStatisticsRecord(roots)).toBe(false)
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(record)

    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).not.toHaveProperty('privacy')
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

  it('writes the account key into a Gemini settings file that carries comments and keeps the comments', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath, envPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    // Gemini CLI strips comments before JSON.parse, so this is a valid file to it.
    fs.writeFileSync(settingsPath, [
      '{',
      '  // 我的主题',
      '  "ui": { "theme": "GitHub" },',
      '  /* 登录方式 */',
      '  "security": { "auth": { "selectedType": "oauth-personal" } }',
      '}',
      '',
    ].join('\n'), 'utf8')

    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls)

    const written = fs.readFileSync(settingsPath, 'utf8')
    expect(written).toContain('// 我的主题')
    expect(written).toContain('/* 登录方式 */')
    expect(written).toContain('"theme": "GitHub"')
    expect(fs.readFileSync(envPath, 'utf8')).toContain('GEMINI_API_KEY=sk-relay')
    expect(inspectProviderConfig('gemini', roots).authType).toBe('gemini-api-key')

    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)

    const restored = fs.readFileSync(settingsPath, 'utf8')
    expect(restored).toContain('// 我的主题')
    expect(inspectProviderConfig('gemini', roots).authType).toBe('oauth-personal')
  })

  it('still refuses a Gemini settings file that Gemini itself could not read', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    const damaged = [
      // Trailing commas survive strip-json-comments, so Gemini rejects them too.
      '{ "ui": { "theme": "GitHub", }, // note\n }',
      // Duplicate keys: an in-place edit would change one copy while Gemini reads the other.
      '{ // note\n "ui": {}, "ui": {} }',
    ]
    for (const content of damaged) {
      fs.writeFileSync(settingsPath, content, 'utf8')
      expect(() => saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls))
        .toThrow('Gemini CLI 的配置文件内容有误，星芒未改动该文件。')
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(content)
    }
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
      .toThrow(/已在使用/)
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

    // The relay merge limits the picker to the relay entry; that list must go with it.
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'merge', roots, {}, providerBaseUrls)
    expect(asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')).models)?.allowed_models).toEqual(['grok'])

    switchProviderToOfficialAccount('grok', roots, {}, providerBaseUrls)

    const settings = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(settings.cli).toEqual({ auto_update: false })
    // Nothing tells our video_gen = false apart from one the customer wrote, so it stays.
    expect(settings.features).toEqual({ video_gen: false })
    expect(settings.models).toBeUndefined()
    expect(settings.model).toEqual({ mine: { model: 'grok-4.6', base_url: 'https://my.example.com/v1', api_key: 'sk-mine' } })
    expect(settings.endpoints).toEqual({ feedback_base_url: 'https://example.invalid' })
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('sk-relay')
    const inspection = inspectProviderConfig('grok', roots, providerBaseUrls)
    expect(providerAccountMode(inspection)).toBe('official')
    expect(canLaunchManagedProvider(inspection)).toBe(true)
  })

  // 0.2.24 深查「反复切换」N3：只删跟传进来的线路地址一模一样的那几处，停在这个站别的线路、旧别名上的
  // 留着，切回官方以后 Grok 还走中转。这个站的每条线路和别名都要认，别的站和客户自己的地址不碰。
  it('removes Grok relay entries on every line and retired alias of the account site', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const primary = relayProviderBaseUrls('solov', 'primary')
    const direct = relayProviderBaseUrls('solov', 'direct')
    const otherSite = relayProviderBaseUrls('solov-api', 'primary')
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', roots, {}, direct)
    const [configPath] = providerConfigPaths('grok', roots)
    const seeded = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    asRecord(seeded.endpoints)!.xai_api_base_url = `${primary.grok}/`
    Object.assign(asRecord(seeded.model)!, {
      alias: { model: 'grok-old', base_url: 'https://38.147.105.28:8443/v1', api_key: 'sk-alias' },
      upper: { model: 'grok-upper', base_url: 'HTTPS://XM.SOLOV.CC/v1', api_key: 'sk-upper' },
      history: { model: 'grok-history', base_url: otherSite.grok, api_key: 'sk-history' },
      mine: { model: 'grok-4.6', base_url: 'https://my.example.com/v1', api_key: 'sk-mine' },
    })
    asRecord(seeded.models)!.allowed_models = ['grok', 'alias', 'mine']
    fs.writeFileSync(configPath, TOML.stringify(seeded as Parameters<typeof TOML.stringify>[0]), 'utf8')

    // The caller names the line it believes is in use; the other line and the alias must go as well.
    switchProviderToOfficialAccount('grok', roots, {}, primary)

    const settings = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(settings.model).toEqual({
      history: { model: 'grok-history', base_url: otherSite.grok, api_key: 'sk-history' },
      mine: { model: 'grok-4.6', base_url: 'https://my.example.com/v1', api_key: 'sk-mine' },
    })
    expect(settings.models).toEqual({ allowed_models: ['mine'] })
    expect(settings.endpoints).toBeUndefined()
    const written = fs.readFileSync(configPath, 'utf8')
    for (const secret of ['sk-relay', 'sk-alias', 'sk-upper']) expect(written).not.toContain(secret)
    for (const line of [primary, direct]) {
      expect(providerAccountMode(inspectProviderConfig('grok', roots, line))).toBe('official')
    }
  })

  it('writes the relay model back after Grok was switched to its own login', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', roots, {}, providerBaseUrls)
    switchProviderToOfficialAccount('grok', roots, {}, providerBaseUrls)

    saveProviderConfig('grok', 'sk-relay-2', testModels.grok, 'merge', roots, {}, providerBaseUrls)

    const settings = TOML.parse(fs.readFileSync(providerConfigPaths('grok', roots)[0], 'utf8'))
    expect(settings.models).toEqual({
      default: 'grok', web_search: 'grok', allowed_models: ['grok'], session_summary: 'grok', image_description: 'grok',
    })
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

  // 总单 17：Grok 的 npm 安装包装完自己写下的那一两行（1.0.77 的 bin/postinstall.js 用 @iarna/toml 整份写回），
  // 客户一个字没填过。只认这一种，多一个键、多一张表、旁边有 auth.json 都不算。
  it('recognizes the config Grok\'s own npm installer leaves behind and nothing more', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('grok', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const read = () => inspectProviderConfig('grok', roots, providerBaseUrls)
    fs.writeFileSync(configPath, TOML.stringify({ cli: { installer: 'npm' } }), 'utf8')
    expect(read()).toMatchObject({ exists: true, hasApiKey: false, grokLoginMode: null, grokInstallerOnly: true })
    fs.writeFileSync(configPath, TOML.stringify({ cli: { installer: 'npm', npm_registry: 'https://registry.npmmirror.com/' } }), 'utf8')
    expect(read().grokInstallerOnly).toBe(true)
    const others: Array<Parameters<typeof TOML.stringify>[0]> = [
      { cli: { installer: 'npm', auto_update: false } },
      { cli: { installer: 'npm' }, features: { video_gen: false } },
      { cli: { npm_registry: 'https://registry.npmjs.org/' } },
      { cli: { installer: 'npm', npm_registry: true } },
      { cli: {} },
    ]
    for (const other of others) {
      fs.writeFileSync(configPath, TOML.stringify(other), 'utf8')
      expect(read(), JSON.stringify(other)).not.toHaveProperty('grokInstallerOnly')
    }
    fs.writeFileSync(configPath, TOML.stringify({ cli: { installer: 'npm' } }), 'utf8')
    fs.writeFileSync(path.join(path.dirname(configPath), 'auth.json'), '{}', 'utf8')
    expect(read()).not.toHaveProperty('grokInstallerOnly')
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

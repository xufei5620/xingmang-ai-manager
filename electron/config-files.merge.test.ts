import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TOML from '@iarna/toml'
import {
  applyCodexRelayMachineDefaults,
  codexConfigSnapshotPaths,
  codexDaemonAutoStartSetting,
  inspectCodexDaemonAutoStart,
  executeFilePlans,
  codexModelUsesRelayWebsockets,
  inspectProviderConfig,
  providerAccountMode,
  providerConfigPaths,
  saveProviderConfig,
  switchProviderToOfficialAccount,
  toNativeConfigSummary,
} from './config-files'
import { providerBaseUrls } from './catalog'
import { relayProviderBaseUrls } from './relay-sites'
import { renameWithTransientRetrySync } from './safe-local-data'
import { isOpenAiModelId } from '../src/renderer-v2/features/tools/model-filter'
import {
  asRecord,
  cliHook,
  directoryFileSnapshot,
  type GrokConfigShape,
  providerRoots,
  removeTemporaryHomes,
  statusLineCommand,
  temporaryHome,
  testModels,
  uninterruptedFeatures,
} from './config-files.test-support'

afterEach(() => {
  vi.restoreAllMocks()
  removeTemporaryHomes()
})

// 本文件接着 config-files.test.ts 的同名 describe：那边是读配置、坏文件的重置与修复、认地址和检测，
// 这边是保存时写进去和留着的东西。
describe('native CLI configuration files', () => {
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
    expect(merged.permissions).toEqual({ defaultMode: 'bypassPermissions', deny: ['Artifact', 'DesignSync'] })
    expect(merged.skipWebFetchPreflight).toBe(true)
  })

  it('appends the claude.ai-only tools to an existing Claude deny list without touching the entries the user wrote', () => {
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
      deny: ['Bash(rm:*)', 'Artifact', 'DesignSync'],
      allow: ['Read'],
    })
  })

  it('does not duplicate the denied claude.ai-only tools when merging twice over a Claude config', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('claude', 'old-key', testModels.claude, 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', roots, {}, providerBaseUrls)

    const [settingsPath] = providerConfigPaths('claude', roots)
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(merged.permissions)?.deny).toEqual(['Artifact', 'DesignSync'])
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

  it('writes the terminal notification hooks next to the user hooks and takes only ours back on the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('claude', roots)
    const own = { hooks: [{ type: 'command', command: 'say done' }] }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({ hooks: { Stop: [own] } }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls, undefined, undefined, cliHook)

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown[]> }
    expect(merged.hooks.Stop).toEqual([own, { hooks: [expect.objectContaining({ command: cliHook.nodeExecutable, args: [cliHook.scriptPath, 'claude', cliHook.eventsDirectory] })] }])
    expect(merged.hooks.StopFailure).toHaveLength(1)

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls)
    const official = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(official.hooks).toEqual({ Stop: [own] })
  })

  it('writes the terminal notification hooks into fresh and merged Gemini settings and removes them for the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('gemini', roots)

    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'reset', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    const fresh = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(Object.keys(fresh.hooks).sort()).toEqual(['AfterAgent', 'BeforeAgent', 'Notification', 'SessionEnd'])
    expect(fresh.hooks.AfterAgent[0].hooks[0].command).toContain('xingmang-hook.cjs')

    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'merge', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown[]> }
    expect(merged.hooks.AfterAgent).toHaveLength(1)

    switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls)
    const official = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect('hooks' in official).toBe(false)
  })

  it('writes the Grok turn hooks into fresh and merged configs, turns off its Claude hook compatibility and takes the hooks back on the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('grok', roots)
    const posixHook = { ...cliHook, platform: 'linux' as const }

    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', roots, {}, providerBaseUrls, undefined, undefined, posixHook)
    const fresh = TOML.parse(fs.readFileSync(configPath, 'utf8')) as unknown as GrokConfigShape
    expect(fresh.compat).toEqual({ claude: { hooks: false } })
    expect(Object.keys(fresh.hooks).sort()).toEqual(['Notification', 'SessionEnd', 'Stop', 'StopCancelled', 'StopFailure', 'UserPromptSubmit'])
    expect(fresh.hooks.Stop[0].hooks[0].command).toContain(' grok ')
    expect(fresh.model.grok.api_key).toBe('sk-relay')

    fs.writeFileSync(configPath, `${fs.readFileSync(configPath, 'utf8')}\n[[hooks.PreToolUse]]\nmatcher = "Bash"\nhooks = [{ type = "command", command = "/opt/guard.sh" }]\n`, 'utf8')
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'merge', roots, {}, providerBaseUrls, undefined, undefined, posixHook)
    const merged = TOML.parse(fs.readFileSync(configPath, 'utf8')) as unknown as GrokConfigShape
    expect(merged.hooks.Stop).toHaveLength(1)
    expect(merged.hooks.PreToolUse).toHaveLength(1)

    switchProviderToOfficialAccount('grok', roots, {}, providerBaseUrls)
    const official = TOML.parse(fs.readFileSync(configPath, 'utf8')) as unknown as GrokConfigShape
    expect(Object.keys(official.hooks)).toEqual(['PreToolUse'])
    expect(official.compat).toEqual({ claude: { hooks: false } })
  })

  it('leaves the Grok Claude compatibility switch the user set alone and writes no Grok hook on Windows', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('grok', roots)
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'reset', roots, {}, providerBaseUrls, undefined, undefined, { ...cliHook, platform: 'win32' })
    const fresh = TOML.parse(fs.readFileSync(configPath, 'utf8')) as unknown as GrokConfigShape
    expect(fresh.compat).toEqual({ claude: { hooks: false } })
    expect('hooks' in fresh).toBe(false)

    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('hooks = false', 'hooks = true'), 'utf8')
    saveProviderConfig('grok', 'sk-relay', testModels.grok, 'merge', roots, {}, providerBaseUrls, undefined, undefined, { ...cliHook, platform: 'linux' })
    expect((TOML.parse(fs.readFileSync(configPath, 'utf8')) as unknown as GrokConfigShape).compat).toEqual({ claude: { hooks: true } })
  })

  it('writes the Codex notify command into a fresh config, refreshes our own and takes it back on the official account', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)
    const expected = [cliHook.nodeExecutable, cliHook.scriptPath, 'codex', cliHook.eventsDirectory]

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).notify).toEqual(expected)

    const moved = { ...cliHook, scriptPath: '/new/place/bundled-catalog/cli-hooks/xingmang-hook.cjs' }
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls, undefined, undefined, moved)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).notify).toEqual([moved.nodeExecutable, moved.scriptPath, 'codex', moved.eventsDirectory])

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    expect('notify' in TOML.parse(fs.readFileSync(configPath, 'utf8'))).toBe(false)
  })

  it('leaves a notify command the user set for Codex alone', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'notify = ["notify-send", "Codex"]\n', 'utf8')

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls, undefined, undefined, cliHook)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).notify).toEqual(['notify-send', 'Codex'])

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).notify).toEqual(['notify-send', 'Codex'])
  })

  it('switches the Codex desktop out of ChatGPT Work when saving a relay key and gives the official account its own choice back', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const snapshots = codexConfigSnapshotPaths(roots)
    fs.mkdirSync(path.dirname(snapshots.active), { recursive: true })
    fs.writeFileSync(snapshots.active, '[desktop]\nlocaleOverride = "zh-CN"\nconversationDetailMode = "STEPS_PROSE"\n', 'utf8')

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    for (const file of [snapshots.active, snapshots.relay]) {
      expect(asRecord(TOML.parse(fs.readFileSync(file, 'utf8')))?.desktop).toEqual({
        localeOverride: 'zh-CN',
        conversationDetailMode: 'STEPS_COMMANDS',
      })
    }

    // With a ChatGPT login the Work mode does work, so the official profile keeps it.
    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
    expect(asRecord(asRecord(TOML.parse(fs.readFileSync(snapshots.active, 'utf8')))?.desktop)?.conversationDetailMode).toBe('STEPS_PROSE')
  })

  it('leaves the other Codex desktop modes alone and never adds a mode the customer did not pick', () => {
    function savedDesktop(existing: string | null): unknown {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      if (existing !== null) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, existing, 'utf8')
      }
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
      return asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))?.desktop
    }

    expect(savedDesktop('[desktop]\nconversationDetailMode = "STEPS_EXECUTION"\n')).toEqual({ conversationDetailMode: 'STEPS_EXECUTION' })
    expect(savedDesktop('[desktop]\nlocaleOverride = "zh-CN"\n')).toEqual({ localeOverride: 'zh-CN' })
    expect(savedDesktop(null)).toBeUndefined()
  })

  it('writes no hooks at all when none are given', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('claude', 'sk-relay', testModels.claude, 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('gemini', 'sk-relay', testModels.gemini, 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    for (const provider of ['claude', 'gemini'] as const) {
      const settings = JSON.parse(fs.readFileSync(providerConfigPaths(provider, roots)[0], 'utf8')) as Record<string, unknown>
      expect('hooks' in settings).toBe(false)
    }
    expect('notify' in TOML.parse(fs.readFileSync(providerConfigPaths('codex', roots)[0], 'utf8'))).toBe(false)
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

  it('skips command confirmation on merge only when the user wrote no permission mode', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [settingsPath] = providerConfigPaths('claude', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2)}\n`, 'utf8')

    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    const filled = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(filled.permissions)?.defaultMode).toBe('bypassPermissions')
    expect(asRecord(filled.permissions)?.allow).toEqual(['Bash(ls:*)'])
    expect(filled.skipDangerousModePermissionPrompt).toBe(true)

    fs.writeFileSync(settingsPath, `${JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }, null, 2)}\n`, 'utf8')
    saveProviderConfig('claude', 'new-key', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    const chosen = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(asRecord(chosen.permissions)?.defaultMode).toBe('acceptEdits')
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

  it('turns off Codex analytics for the relay without overriding a user who enabled it', () => {
    // Codex waits ~10 s on exit to flush metrics to ab.chatgpt.com, which is
    // unreachable from mainland China.
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).analytics).toEqual({ enabled: false })

    const seeded = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    seeded.analytics = { enabled: true }
    fs.writeFileSync(configPath, TOML.stringify(seeded as Parameters<typeof TOML.stringify>[0]), 'utf8')
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).analytics).toEqual({ enabled: true })
  })

  it('takes back only its own analytics switch when Codex leaves the relay without a ChatGPT snapshot', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, '[analytics]\nenabled = false\n', 'utf8')
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    fs.rmSync(codexConfigSnapshotPaths(roots).chatgpt, { force: true })

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

    expect(TOML.parse(fs.readFileSync(configPath, 'utf8'))).not.toHaveProperty('analytics')
  })

  it('keeps the computer awake, leaves no background server and skips the admin sandbox prompt', () => {
    const windows: Record<string, unknown> = {}
    applyCodexRelayMachineDefaults(windows, 'win32')
    expect(windows).toEqual({
      features: { ...uninterruptedFeatures, prevent_idle_sleep: true, daemon_auto_start: false },
      suppress_unstable_features_warning: true,
      windows: { sandbox: 'unelevated' },
    })

    // [windows] is a Windows-only table; macOS has no elevation prompt to avoid.
    const mac: Record<string, unknown> = {}
    applyCodexRelayMachineDefaults(mac, 'darwin')
    expect(mac).toEqual({
      features: { ...uninterruptedFeatures, prevent_idle_sleep: true, daemon_auto_start: false },
      suppress_unstable_features_warning: true,
    })
  })

  it('leaves Codex sleep and sandbox choices the user already made', () => {
    const chosen: Record<string, unknown> = {
      features: {
        prevent_idle_sleep: false,
        daemon_auto_start: true,
        goals: true,
        instant_interrupt: true,
        defer_mailbox_preemption: false,
        interrupt_on_cancel: true,
      },
      windows: { sandbox: 'elevated' },
    }
    applyCodexRelayMachineDefaults(chosen, 'win32')
    // Their own defer_mailbox_preemption = false raises no warning, so nothing gets silenced either.
    expect(chosen).toEqual({
      features: {
        prevent_idle_sleep: false,
        daemon_auto_start: true,
        goals: true,
        instant_interrupt: true,
        defer_mailbox_preemption: false,
        interrupt_on_cancel: true,
      },
      windows: { sandbox: 'elevated' },
    })

    // A malformed scalar is the user's problem to see in Codex, not ours to overwrite.
    const scalar: Record<string, unknown> = { features: 'off', windows: 'x' }
    applyCodexRelayMachineDefaults(scalar, 'win32')
    expect(scalar).toEqual({ features: 'off', windows: 'x' })
  })

  // new-api 的 WebSocket 只认 response.create / response.cancel，response.interrupt 回 400（2026-11-06）。
  it('keeps Codex from sending the response.interrupt event the relay rejects', () => {
    const parsed: Record<string, unknown> = { features: { goals: true } }
    applyCodexRelayMachineDefaults(parsed, 'darwin')
    expect(asRecord(parsed.features)).toMatchObject({
      goals: true,
      instant_interrupt: false,
      defer_mailbox_preemption: true,
    })
    // interrupt_on_cancel (0.167+) is off by default. Spelling it out as false made the
    // recommended 0.164.0 show an English "1 warning" on its first screen for an unknown key.
    expect(asRecord(parsed.features)).not.toHaveProperty('interrupt_on_cancel')
    // defer_mailbox_preemption is an under-development flag: without this Codex prints an
    // English "Under-development features enabled" line at the start of every conversation.
    expect(parsed.suppress_unstable_features_warning).toBe(true)

    // A user who wants that warning keeps it.
    const wantsWarning: Record<string, unknown> = { suppress_unstable_features_warning: false }
    applyCodexRelayMachineDefaults(wantsWarning, 'darwin')
    expect(wantsWarning.suppress_unstable_features_warning).toBe(false)
    expect(asRecord(wantsWarning.features)?.defer_mailbox_preemption).toBe(true)

    // A user who turned the deferral on themselves still gets the warning silenced, since it
    // is the same under-development flag either way.
    const ownDeferral: Record<string, unknown> = { features: { defer_mailbox_preemption: true } }
    applyCodexRelayMachineDefaults(ownDeferral, 'darwin')
    expect(ownDeferral.suppress_unstable_features_warning).toBe(true)

    // A profile table is the user's own override and stays as written.
    const profiled: Record<string, unknown> = { profiles: { work: { features: { instant_interrupt: true } } } }
    applyCodexRelayMachineDefaults(profiled, 'darwin')
    expect(profiled.profiles).toEqual({ work: { features: { instant_interrupt: true } } })
  })

  // 照 rust-v0.160.1 features/src/lib.rs 的 from_sources：[features] 在先，profile 选中的那张盖过它。
  it('reads whether the Codex background server starts on its own', () => {
    expect(codexDaemonAutoStartSetting({ features: { daemon_auto_start: false } })).toBe('off')
    expect(codexDaemonAutoStartSetting({ features: { daemon_auto_start: true } })).toBe('on')
    expect(codexDaemonAutoStartSetting({})).toBe('default')
    expect(codexDaemonAutoStartSetting({ features: { daemon_auto_start: 'false' } })).toBe('default')
    expect(codexDaemonAutoStartSetting({ features: 'off' })).toBe('default')
    const withProfile = {
      profile: 'work',
      features: { daemon_auto_start: false },
      profiles: { work: { features: { daemon_auto_start: true } }, home: { features: { daemon_auto_start: false } } },
    }
    expect(codexDaemonAutoStartSetting(withProfile)).toBe('on')
    expect(codexDaemonAutoStartSetting({ ...withProfile, profile: 'home' })).toBe('off')
    expect(codexDaemonAutoStartSetting({ ...withProfile, profile: 'missing' })).toBe('off')
    expect(codexDaemonAutoStartSetting({ ...withProfile, profile: 'work', profiles: { work: { model: 'x' } } })).toBe('off')
  })

  it('inspects the Codex background server setting on disk without touching the file', () => {
    // macOS 的临时目录经过 /var → /private/var 这条符号链接，安全读法会拒读。
    const home = fs.realpathSync.native(temporaryHome())
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    expect(inspectCodexDaemonAutoStart(roots)).toBeNull()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, '[features]\ndaemon_auto_start = true\n', 'utf8')
    expect(inspectCodexDaemonAutoStart(roots)).toBe('on')
    fs.writeFileSync(configPath, 'model = "x"\n', 'utf8')
    expect(inspectCodexDaemonAutoStart(roots)).toBe('default')
    fs.writeFileSync(configPath, '[features', 'utf8')
    expect(inspectCodexDaemonAutoStart(roots)).toBeNull()
    expect(fs.readFileSync(configPath, 'utf8')).toBe('[features')
  })

  it('writes the Codex sleep and sandbox defaults on both a fresh install and an existing config', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active
    const expectedWindows = process.platform === 'win32' ? { sandbox: 'unelevated' } : undefined

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const fresh = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(fresh.features).toEqual({ ...uninterruptedFeatures, goals: true, prevent_idle_sleep: true, daemon_auto_start: false })
    expect(fresh.suppress_unstable_features_warning).toBe(true)
    expect(fresh.windows).toEqual(expectedWindows)
    // The spelled-out template and the merge path must agree, or a fresh install and a
    // merged config would behave differently.
    const reapplied = structuredClone(fresh)
    applyCodexRelayMachineDefaults(reapplied)
    expect(reapplied).toEqual(fresh)

    const existingRoots = providerRoots(temporaryHome())
    const existingPath = codexConfigSnapshotPaths(existingRoots).active
    fs.mkdirSync(path.dirname(existingPath), { recursive: true })
    fs.writeFileSync(existingPath, '[custom_official]\nenabled = true\n', 'utf8')
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', existingRoots, {}, providerBaseUrls)
    const merged = TOML.parse(fs.readFileSync(existingPath, 'utf8'))
    expect(merged.features).toEqual({ ...uninterruptedFeatures, prevent_idle_sleep: true, daemon_auto_start: false })
    expect(merged.suppress_unstable_features_warning).toBe(true)
    expect(merged.windows).toEqual(expectedWindows)
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

  // 0.164.0 把不认识的键挂在第一屏右下角（「⚠ 1 warning」），不只是记日志（2026-11-09 真终端核过）。
  it('writes no Codex feature the recommended version does not recognize yet', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configPath = codexConfigSnapshotPaths(roots).active

    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    const written = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    expect(asRecord(written.features)).not.toHaveProperty('interrupt_on_cancel')
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

  it('turns the Grok video tools off when merging, unless the user set them', () => {
    // The relay hands back xAI's own video address, which Grok downloads straight
    // from the customer's machine; x.ai is blocked in mainland China, so every
    // video was charged and never arrived (2026-11-17, yoyo「关视频」).
    const home = temporaryHome()
    const roots = providerRoots(home)
    saveProviderConfig('grok', 'old-key', testModels.grok, 'reset', roots, {}, providerBaseUrls)
    const [configPath] = providerConfigPaths('grok', roots)
    const seeded = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    seeded.features = { lsp_tools: true }
    fs.writeFileSync(configPath, TOML.stringify(seeded as Parameters<typeof TOML.stringify>[0]), 'utf8')

    saveProviderConfig('grok', 'new-key', testModels.grok, 'merge', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).features).toEqual({ lsp_tools: true, video_gen: false })

    // A customer who turned video back on keeps it on across later saves.
    const chosen = TOML.parse(fs.readFileSync(configPath, 'utf8'))
    chosen.features = { video_gen: true }
    fs.writeFileSync(configPath, TOML.stringify(chosen as Parameters<typeof TOML.stringify>[0]), 'utf8')

    saveProviderConfig('grok', 'newer-key', testModels.grok, 'merge', roots, {}, providerBaseUrls)
    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).features).toEqual({ video_gen: true })
  })

  it('limits the Grok model picker to the relay entry and routes titles through it when merging', () => {
    // The built-in grok-4.6 / grok-4.5 entries go to xAI's own proxy, which the
    // relay key cannot use, and session titles default to the literal grok-4.6.
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('grok', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      '[models]',
      'default = "mine"',
      'image_description = "vision"',
      '',
      '[model."mine"]',
      'model = "grok-old"',
      'base_url = "https://legacy.example.com/v1"',
      'api_key = "old"',
      '',
    ].join('\n'), 'utf8')

    saveProviderConfig('grok', 'new-key', testModels.grok, 'merge', roots, {}, providerBaseUrls)

    expect(TOML.parse(fs.readFileSync(configPath, 'utf8')).models).toEqual({
      default: 'mine',
      image_description: 'vision',
      session_summary: 'mine',
      allowed_models: ['mine'],
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
    // Reset writes the template: only the identifier is kept, for the resume list.
    expect(mycodexProvider?.name).toBe('OpenAI')
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
      .toThrow('星芒为 Codex 保存的配置无法读取，星芒未改动该文件。')
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
      supports_websockets: true,
      custom_header: 'keep',
    })
  })

  it.each([true, false])('keeps a user supports_websockets = %s on the relay provider during merge', (choice) => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model_provider = "XingmangAI"',
      '',
      '[model_providers.XingmangAI]',
      'name = "XingmangAI"',
      `base_url = "${relayProviderBaseUrls('solov', 'direct').codex}"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      `supports_websockets = ${choice}`,
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{}\n', 'utf8')

    saveProviderConfig('codex', 'new-key', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))
    const provider = asRecord(asRecord(parsed?.model_providers)?.XingmangAI)
    expect(provider?.base_url).toBe('https://xm.solov.cc/v1')
    expect(provider?.supports_websockets).toBe(choice)
  })

  it('treats exactly the models the other-vendor dialog calls GPT as websocket models', () => {
    const models = [
      'gpt-5.5', 'gpt-6.1-sol', 'GPT-5', 'chatgpt-4o-latest', 'codex-auto-review', 'o3', 'o4-mini', 'openai/gpt-oss',
      'claude-opus-4-6', 'grok-4.5', 'gemini-3.5-flash', 'deepseek-v3', 'kimi-k2', 'gpt', 'gptx', 'o', 'oss',
    ]
    for (const model of models) expect(codexModelUsesRelayWebsockets(model)).toBe(isOpenAiModelId(model))
    expect(codexModelUsesRelayWebsockets('gpt-5.5')).toBe(true)
    expect(codexModelUsesRelayWebsockets('claude-opus-4-6')).toBe(false)
  })

  it('keeps plain streaming when a fresh Codex config uses another vendor model', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)

    saveProviderConfig('codex', 'sk-first', 'claude-opus-4-6', 'reset', roots, {}, providerBaseUrls)

    expect(fs.readFileSync(configPath, 'utf8')).toMatch(/^supports_websockets = false$/m)
  })

  it('moves our own websocket setting with the model between GPT and another vendor', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath] = providerConfigPaths('codex', roots)
    const websockets = () => asRecord(asRecord(asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))?.model_providers)?.XingmangAI)?.supports_websockets

    saveProviderConfig('codex', 'sk-first', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    expect(websockets()).toBe(true)
    saveProviderConfig('codex', 'sk-first', 'claude-opus-4-6', 'merge', roots, {}, providerBaseUrls)
    expect(websockets()).toBe(false)
    saveProviderConfig('codex', 'sk-first', 'grok-4.5', 'merge', roots, {}, providerBaseUrls)
    expect(websockets()).toBe(false)
    saveProviderConfig('codex', 'sk-first', 'gpt-6.1-sol', 'merge', roots, {}, providerBaseUrls)
    expect(websockets()).toBe(true)
  })

  it.each([
    ['gpt-5.5', false],
    ['claude-opus-4-6', true],
  ] as const)('keeps a customer websocket choice that does not match model %s', (model, choice) => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model_provider = "XingmangAI"',
      `model = "${model}"`,
      '',
      '[model_providers.XingmangAI]',
      'name = "OpenAI"',
      `base_url = "${providerBaseUrls.codex}"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      `supports_websockets = ${choice}`,
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{}\n', 'utf8')

    saveProviderConfig('codex', 'new-key', model, 'merge', roots, {}, providerBaseUrls)
    saveProviderConfig('codex', 'new-key', model === 'gpt-5.5' ? 'gpt-6.1-sol' : 'grok-4.5', 'merge', roots, {}, providerBaseUrls)

    const provider = asRecord(asRecord(asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))?.model_providers)?.XingmangAI)
    expect(provider?.supports_websockets).toBe(choice)
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

  it('waits out a scanner briefly holding a Codex file instead of failing the save', () => {
    const roots = providerRoots(temporaryHome())
    saveProviderConfig('codex', 'old-key', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    const originalRename = fs.renameSync.bind(fs)
    let locked = 2
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (locked > 0 && path.resolve(String(to)) === path.resolve(authPath)) {
        locked -= 1
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      originalRename(from, to)
    })
    let authHookCalls = 0

    saveProviderConfig('codex', 'new-key', 'gpt-5.6-sol', 'merge', roots, {
      beforeReplace: (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(authPath)) authHookCalls += 1
      },
    }, providerBaseUrls)

    expect(locked).toBe(0)
    expect(authHookCalls).toBe(3)
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toMatchObject({ OPENAI_API_KEY: 'new-key' })
    expect(asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))?.model).toBe('gpt-5.6-sol')
    expect(fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps the original error and restores every Codex file when a file stays held', () => {
    const roots = providerRoots(temporaryHome())
    saveProviderConfig('codex', 'old-key', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    const configBefore = fs.readFileSync(configPath, 'utf8')
    const authBefore = fs.readFileSync(authPath, 'utf8')
    const originalRename = fs.renameSync.bind(fs)
    let heldAttempts = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.resolve(String(to)) === path.resolve(authPath)) {
        heldAttempts += 1
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      originalRename(from, to)
    })

    expect(() => saveProviderConfig('codex', 'new-key', 'gpt-5.6-sol', 'merge', roots, {}, providerBaseUrls))
      .toThrow('EPERM: operation not permitted, rename')
    expect(heldAttempts).toBe(5)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore)
    expect(fs.readFileSync(authPath, 'utf8')).toBe(authBefore)
    expect(fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('waits out a briefly held file while rolling back a failed save', () => {
    const root = temporaryHome()
    const first = path.join(root, 'first.json')
    const second = path.join(root, 'second.json')
    fs.writeFileSync(first, '{"before":1}\n', 'utf8')
    fs.writeFileSync(second, '{"before":2}\n', 'utf8')
    const originalRename = fs.renameSync.bind(fs)
    let rollbackLocked = 1
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (rollbackLocked > 0 && path.basename(String(from)).includes('.xingmang-rollback-')) {
        rollbackLocked -= 1
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
      }
      originalRename(from, to)
    })

    expect(() => executeFilePlans([
      { path: first, content: '{"after":1}\n' },
      { path: second, content: '{"after":2}\n' },
    ], {
      beforeReplace: (_targetPath, index) => {
        if (index === 1) throw new Error('injected second-file failure')
      },
    }, root)).toThrow('injected second-file failure')
    expect(rollbackLocked).toBe(0)
    expect(fs.readFileSync(first, 'utf8')).toBe('{"before":1}\n')
    expect(fs.readFileSync(second, 'utf8')).toBe('{"before":2}\n')
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('fails closed when a junction replaces the Codex root while a held file is retried', () => {
    const userHome = temporaryHome()
    const codexParent = temporaryHome()
    const codexHome = path.join(codexParent, 'custom-codex')
    const displacedCodexHome = path.join(codexParent, 'displaced-codex')
    const outside = temporaryHome()
    const roots = { userHome, codexHome }
    saveProviderConfig('codex', 'old-key', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const [, authPath] = providerConfigPaths('codex', roots)
    const originalRename = fs.renameSync.bind(fs)
    let swapped = false
    let outsideBefore: Record<string, string> = {}
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!swapped && path.resolve(String(to)) === path.resolve(authPath)) {
        swapped = true
        for (const name of fs.readdirSync(codexHome)) {
          fs.writeFileSync(path.join(outside, name), `outside sentinel: ${name}\n`, 'utf8')
        }
        outsideBefore = directoryFileSnapshot(outside)
        // A scanner may still hold a file just written here; wait it out the
        // same way, or the swap itself could fail and let the save go through.
        renameWithTransientRetrySync(codexHome, displacedCodexHome)
        fs.symlinkSync(outside, codexHome, 'junction')
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      originalRename(from, to)
    })

    expect(() => saveProviderConfig('codex', 'new-key', 'gpt-5.6-sol', 'merge', roots, {}, providerBaseUrls))
      .toThrow()
    expect(fs.lstatSync(codexHome).isSymbolicLink()).toBe(true)
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

  // Creating a file symlink needs Developer Mode or administrator rights on Windows.
  it.skipIf(process.platform === 'win32')('names a dotfiles-linked settings file by where it sits in the home folder and keeps the original refusal for the log', () => {
    const home = temporaryHome()
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const [configPath] = providerConfigPaths('claude', providerRoots(home))
    const source = path.join(home, 'dotfiles', 'settings.json')
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, '{}', 'utf8')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.symlinkSync(source, configPath)

    let refusal: unknown
    try {
      saveProviderConfig('claude', 'sk-dotfiles', testModels.claude, 'merge', providerRoots(home), {}, providerBaseUrls)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toBe(`用户文件夹里的 ${path.join('.claude', 'settings.json')} 是一个链接。为保障安全，星芒不会写入链接，原有设置未改动。请将其替换为普通文件后重试。`)
    expect(((refusal as Error).cause as Error).message).toMatch(/单链接普通文件|符号链接/)
    expect(fs.readFileSync(source, 'utf8')).toBe('{}')
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

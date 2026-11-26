import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TOML from '@iarna/toml'
import {
  buildCodexApiKeyAuth,
  classifyCodexAuthProfile,
  classifyCodexConfigProfile,
  claudeForeignSettingsSnapshotName,
  codexApiKeyAuthSnapshotName,
  codexAuthSnapshotPaths,
  codexChatGptAuthSnapshotName,
  codexConfigSnapshotPaths,
  defaultCodexRelayProvider,
  codexRelayDisplayName,
  codexOfficialAliasPending,
  restoreCodexOfficialAlias,
  geminiUsageStatisticsRecordName,
  inspectProviderConfig,
  providerConfigPaths,
  saveProviderConfig,
  snapshotCodexChatGptAuth,
  switchProviderToOfficialAccount,
} from './config-files'
import { providerBaseUrls } from './catalog'
import {
  asRecord,
  chatGptTokens,
  directoryFileSnapshot,
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

// 账号来源切换(星芒中转 ⇄ 用户自己的官方订阅)。本组的核心断言只有一条:
// 切换绝不能碰官方登录凭据 —— Codex 的 ChatGPT token 就住在同一个
// auth.json 里,删错一个键用户就要重新走浏览器登录,整个功能也就没意义了。
describe('switching a provider back to the official subscription account', () => {
  const historicalCodexBaseUrls = { ...providerBaseUrls, codex: 'https://api.solov.cc/v1' }

  // 切官方时给旧对话留下的那张表：不写地址，拿 auth.json 里的官方登录走官方默认地址。
  function officialAliasTable() {
    return { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true }
  }

  it.each([
    ['current then historical', providerBaseUrls, historicalCodexBaseUrls],
    ['historical then current', historicalCodexBaseUrls, providerBaseUrls],
  ])('keeps the official snapshot intact across %s relay sites', (_label, firstSite, secondSite) => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configs = codexConfigSnapshotPaths(roots)
    const auth = codexAuthSnapshotPaths(roots)
    const officialConfig = 'approval_policy = "never"\n[custom_official]\nenabled = true\n'
    const officialAuth = { auth_mode: 'chatgpt', tokens: chatGptTokens() }
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(configs.active, officialConfig)
    fs.writeFileSync(auth.active, JSON.stringify(officialAuth))

    saveProviderConfig('codex', 'sk-first-relay', testModels.codex, 'merge', roots, {}, firstSite)
    const officialSnapshot = fs.readFileSync(configs.chatgpt, 'utf8')
    const loginSnapshot = fs.readFileSync(auth.chatgpt, 'utf8')
    saveProviderConfig('codex', 'sk-second-relay', testModels.codex, 'merge', roots, {}, secondSite)

    expect(fs.readFileSync(configs.chatgpt, 'utf8')).toBe(officialSnapshot)
    expect(fs.readFileSync(auth.chatgpt, 'utf8')).toBe(loginSnapshot)
    switchProviderToOfficialAccount('codex', roots, {}, secondSite)
    // 官方配置原文一字不动，旧对话要找的那张表接在后面。
    const active = fs.readFileSync(configs.active, 'utf8')
    expect(active.startsWith(officialConfig)).toBe(true)
    expect(TOML.parse(active)).toEqual({ ...TOML.parse(officialConfig), model_providers: { OpenAI: officialAliasTable() } })
    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual(officialAuth)
  })

  it('switches a known relay back to official when the selected account site changed first', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configs = codexConfigSnapshotPaths(roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(configs.active, 'approval_policy = "never"\n')
    saveProviderConfig('codex', 'sk-first-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    switchProviderToOfficialAccount('codex', roots, {}, historicalCodexBaseUrls)

    const active = fs.readFileSync(configs.active, 'utf8')
    expect(active.startsWith('approval_policy = "never"\n')).toBe(true)
    expect(TOML.parse(active)).toEqual({ approval_policy: 'never', model_providers: { OpenAI: officialAliasTable() } })
  })

  it('creates a clean official fallback when no official snapshot exists', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configs = codexConfigSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-first-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('codex', 'sk-second-relay', testModels.codex, 'merge', roots, {}, historicalCodexBaseUrls)

    switchProviderToOfficialAccount('codex', roots, {}, historicalCodexBaseUrls)

    const active = fs.readFileSync(configs.active, 'utf8')
    const snapshot = fs.readFileSync(configs.chatgpt, 'utf8')
    expect(active).not.toContain('https://xm.solov.cc/v1')
    expect(active).not.toContain('https://api.solov.cc/v1')
    expect(snapshot).not.toContain('https://xm.solov.cc/v1')
    expect(snapshot).not.toContain('https://api.solov.cc/v1')
  })

  it.each(['https://38.147.105.28:8443/v1', 'https://xm-direct.solov.cc/v1'])(
    'does not store the recognized backup %s as an official Codex snapshot', (baseUrl) => {
      const roots = providerRoots(temporaryHome())
      const configs = codexConfigSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-fixture', testModels.codex, 'reset', roots, {},
        { ...providerBaseUrls, codex: baseUrl })
      expect(classifyCodexConfigProfile(asRecord(TOML.parse(fs.readFileSync(configs.active, 'utf8'))) ?? {}, providerBaseUrls.codex)).toBe('relay')
      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
      expect(fs.readFileSync(configs.active, 'utf8')).not.toContain(baseUrl)
      expect(fs.existsSync(configs.chatgpt)).toBe(false)
    },
  )

  it('repairs an already polluted official snapshot instead of restoring a relay route', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configs = codexConfigSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-first-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const polluted = fs.readFileSync(configs.active, 'utf8')
    saveProviderConfig('codex', 'sk-second-relay', testModels.codex, 'merge', roots, {}, historicalCodexBaseUrls)
    fs.writeFileSync(configs.chatgpt, polluted)

    switchProviderToOfficialAccount('codex', roots, {}, historicalCodexBaseUrls)

    expect(fs.readFileSync(configs.active, 'utf8')).not.toContain('https://xm.solov.cc/v1')
    expect(fs.readFileSync(configs.active, 'utf8')).not.toContain('https://api.solov.cc/v1')
    expect(fs.readFileSync(configs.chatgpt, 'utf8')).not.toContain('https://xm.solov.cc/v1')
  })

  it('rolls back every cross-site snapshot when the official auth commit fails', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configs = codexConfigSnapshotPaths(roots)
    const auth = codexAuthSnapshotPaths(roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(configs.active, 'approval_policy = "never"\n')
    fs.writeFileSync(auth.active, JSON.stringify({ auth_mode: 'chatgpt', tokens: chatGptTokens() }))
    saveProviderConfig('codex', 'sk-first-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    const polluted = fs.readFileSync(configs.active, 'utf8')
    saveProviderConfig('codex', 'sk-second-relay', testModels.codex, 'merge', roots, {}, historicalCodexBaseUrls)
    fs.writeFileSync(configs.chatgpt, polluted)
    const files = [...Object.values(configs), ...Object.values(auth)]
    const before = files.map((file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

    expect(() => switchProviderToOfficialAccount('codex', roots, {
      beforeReplace(file) { if (file === auth.active) throw new Error('fixture auth commit failure') },
    }, historicalCodexBaseUrls)).toThrow('fixture auth commit failure')

    expect(files.map((file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)).toEqual(before)
  })

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

    const initial = {
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      check_for_update_on_startup: false,
    }
    expect(TOML.parse(fs.readFileSync(configs.active, 'utf8'))).toEqual({
      ...initial,
      model_providers: { [defaultCodexRelayProvider]: officialAliasTable() },
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
    expect(TOML.parse(fs.readFileSync(configs.active, 'utf8'))).toEqual({
      ...initial,
      model_providers: { [defaultCodexRelayProvider]: officialAliasTable() },
    })
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
    // Gemini 另有一份「统计开关是星芒写的」记录，重置成官方模板后它没用了，跟着写空。
    const recordPath = path.join(path.dirname(paths[0]), geminiUsageStatisticsRecordName)
    if (provider === 'gemini') expect(fs.readFileSync(recordPath, 'utf8')).toBe('')
    // Claude 同理：快照里记着「不逐条确认」是星芒补的（D5），重置成官方模板后跟着写空。
    const snapshotPath = path.join(path.dirname(paths[0]), claudeForeignSettingsSnapshotName)
    if (provider === 'claude') expect(fs.readFileSync(snapshotPath, 'utf8')).toBe('')
    expect(result.backups.length).toBe(paths.length + 1)
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

  it('turns the relay provider table into an official alias and drops model overrides so Codex falls back to its built-in openai provider', () => {
    const home = temporaryHome()
    seedCodexRelayConfigWithChatGptLogin(home)

    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)

    const [configPath] = providerConfigPaths('codex', providerRoots(home))
    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))
    expect(parsed?.model_provider).toBeUndefined()
    // 旧对话还认这个表名才打得开；表里没有地址，ChatGPT 令牌只去官方，到不了中转。
    expect(parsed?.model_providers).toEqual({ [defaultCodexRelayProvider]: officialAliasTable() })
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

  it('leaves a user-authored provider table alone while aliasing only the relay one', () => {
    const home = temporaryHome()
    seedCodexRelayConfigWithChatGptLogin(home)
    const [configPath] = providerConfigPaths('codex', providerRoots(home))
    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))!
    const providers = asRecord(parsed.model_providers)!
    providers.mine = { name: 'mine', base_url: 'https://example.invalid/v1' }
    fs.writeFileSync(configPath, TOML.stringify(parsed as never))

    switchProviderToOfficialAccount('codex', providerRoots(home), {}, providerBaseUrls)

    const after = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))
    expect(after?.model_providers).toEqual({
      mine: { name: 'mine', base_url: 'https://example.invalid/v1' },
      [defaultCodexRelayProvider]: officialAliasTable(),
    })
  })

  describe('chats started on the relay after a round trip through the official account', () => {
    function liveRelayTable(parsed: Record<string, unknown> | null, name: string) {
      return asRecord(asRecord(parsed?.model_providers)?.[name])
    }

    it.each([
      ['restored from the saved relay copy', false],
      ['rebuilt from the official config when that copy is gone', true],
    ])('turns the alias back into the relay table under the same name when %s', (_label, dropRelayCopy) => {
      const home = temporaryHome()
      const roots = providerRoots(home)
      const configs = codexConfigSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
      if (dropRelayCopy) fs.rmSync(configs.relay)

      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

      const parsed = asRecord(TOML.parse(fs.readFileSync(configs.active, 'utf8')))
      expect(parsed?.model_provider).toBe(defaultCodexRelayProvider)
      expect(Object.keys(asRecord(parsed?.model_providers) ?? {})).toEqual([defaultCodexRelayProvider])
      const table = liveRelayTable(parsed, defaultCodexRelayProvider)
      expect(table).toMatchObject({ name: codexRelayDisplayName, base_url: providerBaseUrls.codex, requires_openai_auth: true })
    })

    it('keeps the OpenAI table name of a config that existed before Xingmang wrote it', () => {
      const home = temporaryHome()
      const roots = providerRoots(home)
      const configs = codexConfigSnapshotPaths(roots)
      fs.mkdirSync(roots.codexHome, { recursive: true })
      fs.writeFileSync(configs.active, 'approval_policy = "never"\n')
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
      expect(asRecord(TOML.parse(fs.readFileSync(configs.active, 'utf8')))?.model_providers).toEqual({ OpenAI: officialAliasTable() })
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)
      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

      // 第二趟官方配置来自存的快照，里面已经有那张表：不重复加，整份照样读得懂。
      const active = fs.readFileSync(configs.active, 'utf8')
      expect(active.match(/\[model_providers\.OpenAI\]/g)).toHaveLength(1)
      expect(asRecord(TOML.parse(active))?.model_providers).toEqual({ OpenAI: officialAliasTable() })
    })

    it('takes back the table a customer rewrote by hand to reach the official account', () => {
      const home = temporaryHome()
      const roots = providerRoots(home)
      const configs = codexConfigSnapshotPaths(roots)
      fs.mkdirSync(roots.codexHome, { recursive: true })
      // 2026-10-15 客户自己在 Codex 里改出来的那张表；当前账号的快照已经没了。
      fs.writeFileSync(configs.active, [
        'approval_policy = "never"',
        '',
        `[model_providers.${defaultCodexRelayProvider}]`,
        'name = "OpenAI"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
      ].join('\n'))

      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'merge', roots, {}, providerBaseUrls)

      const parsed = asRecord(TOML.parse(fs.readFileSync(configs.active, 'utf8')))
      expect(parsed?.model_provider).toBe(defaultCodexRelayProvider)
      expect(Object.keys(asRecord(parsed?.model_providers) ?? {})).toEqual([defaultCodexRelayProvider])
      expect(liveRelayTable(parsed, defaultCodexRelayProvider)).toMatchObject({ name: codexRelayDisplayName, base_url: providerBaseUrls.codex })
    })

    it('writes the alias under the saved relay name when the official profile is reset while already official', () => {
      const home = temporaryHome()
      const roots = providerRoots(home)
      const configs = codexConfigSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
      fs.writeFileSync(configs.active, 'approval_policy = "never"\n')

      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset')

      expect(asRecord(TOML.parse(fs.readFileSync(configs.active, 'utf8')))?.model_providers)
        .toEqual({ [defaultCodexRelayProvider]: officialAliasTable() })
    })

    it('leaves a same-named table the customer wrote in the official snapshot untouched', () => {
      const home = temporaryHome()
      const roots = providerRoots(home)
      const configs = codexConfigSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      const official = [
        'approval_policy = "never"',
        '',
        `[model_providers.${defaultCodexRelayProvider}]`,
        'name = "自己的"',
        'base_url = "https://example.invalid/v1"',
        '',
      ].join('\n')
      fs.writeFileSync(configs.chatgpt, official)

      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

      expect(fs.readFileSync(configs.active, 'utf8')).toBe(official)
    })

    it('replaces a live relay table an older official snapshot still carries', () => {
      const home = temporaryHome()
      const roots = providerRoots(home)
      const configs = codexConfigSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      fs.writeFileSync(configs.chatgpt, [
        'approval_policy = "never"',
        '',
        `[model_providers.${defaultCodexRelayProvider}]`,
        `name = "${codexRelayDisplayName}"`,
        `base_url = "${providerBaseUrls.codex}"`,
        'requires_openai_auth = true',
        '',
      ].join('\n'))

      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

      const active = fs.readFileSync(configs.active, 'utf8')
      expect(active).not.toContain(providerBaseUrls.codex)
      expect(TOML.parse(active)).toEqual({
        approval_policy: 'never',
        model_providers: { [defaultCodexRelayProvider]: officialAliasTable() },
      })
    })

    it('rewrites the whole official config when its providers are an inline table that cannot be extended', () => {
      const home = temporaryHome()
      const roots = providerRoots(home)
      const configs = codexConfigSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      fs.writeFileSync(configs.chatgpt, 'model_providers = { mine = { name = "mine", base_url = "https://example.invalid/v1" } }\n')

      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

      expect(asRecord(TOML.parse(fs.readFileSync(configs.active, 'utf8')))?.model_providers).toEqual({
        mine: { name: 'mine', base_url: 'https://example.invalid/v1' },
        [defaultCodexRelayProvider]: officialAliasTable(),
      })
    })

    describe('customers who switched to the official account before this table was kept', () => {
      // 这次以前的版本切官方：当前账号快照留着，官方配置里那张表被删了。
      function switchedBeforeTheFix(home: string, official: string) {
        const roots = providerRoots(home)
        const configs = codexConfigSnapshotPaths(roots)
        saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
        switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)
        fs.writeFileSync(configs.active, official)
        return { roots, configs }
      }

      it('adds only the alias, once, keeping the customer comments and layout', () => {
        const home = temporaryHome()
        const official = '# 自己的注释\napproval_policy   = "never"\n'
        const { roots, configs } = switchedBeforeTheFix(home, official)

        expect(codexOfficialAliasPending(roots, providerBaseUrls)).toBe(true)
        const result = restoreCodexOfficialAlias(roots, providerBaseUrls)

        expect(result?.files).toEqual([configs.active])
        expect(result?.backups.map((backup) => fs.readFileSync(backup, 'utf8'))).toEqual([official])
        const active = fs.readFileSync(configs.active, 'utf8')
        expect(active.startsWith(official)).toBe(true)
        expect(TOML.parse(active)).toEqual({ approval_policy: 'never', model_providers: { [defaultCodexRelayProvider]: officialAliasTable() } })
        expect(codexOfficialAliasPending(roots, providerBaseUrls)).toBe(false)
        expect(restoreCodexOfficialAlias(roots, providerBaseUrls)).toBeNull()
        expect(fs.readFileSync(configs.active, 'utf8')).toBe(active)
      })

      it.each([
        ['there is no saved relay copy', (configs: ReturnType<typeof codexConfigSnapshotPaths>) => fs.rmSync(configs.relay)],
        ['the saved name belongs to a table the customer wrote', (configs: ReturnType<typeof codexConfigSnapshotPaths>) => fs.writeFileSync(configs.active, [
          'approval_policy = "never"',
          '',
          `[model_providers.${defaultCodexRelayProvider}]`,
          'name = "自己的"',
          'base_url = "https://example.invalid/v1"',
          '',
        ].join('\n'))],
        ['the config cannot be read', (configs: ReturnType<typeof codexConfigSnapshotPaths>) => fs.writeFileSync(configs.active, 'approval_policy = \n')],
      ])('leaves the official config alone when %s', (_label, arrange) => {
        const home = temporaryHome()
        const { roots, configs } = switchedBeforeTheFix(home, 'approval_policy = "never"\n')
        arrange(configs)
        const before = fs.readFileSync(configs.active, 'utf8')

        expect(codexOfficialAliasPending(roots, providerBaseUrls)).toBe(false)
        expect(restoreCodexOfficialAlias(roots, providerBaseUrls)).toBeNull()
        expect(fs.readFileSync(configs.active, 'utf8')).toBe(before)
      })

      it('never writes the alias into a config that is on the relay', () => {
        const home = temporaryHome()
        const roots = providerRoots(home)
        const configs = codexConfigSnapshotPaths(roots)
        saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
        const before = fs.readFileSync(configs.active, 'utf8')

        expect(codexOfficialAliasPending(roots, providerBaseUrls)).toBe(false)
        expect(restoreCodexOfficialAlias(roots, providerBaseUrls)).toBeNull()
        expect(fs.readFileSync(configs.active, 'utf8')).toBe(before)
      })
    })
  })
})

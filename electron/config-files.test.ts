import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TOML from '@iarna/toml'
import {
  canLaunchManagedProvider,
  geminiCliCompatibleModel,
  codexAuthSnapshotPaths,
  codexConfigSnapshotPaths,
  defaultCodexRelayProvider,
  codexRelayDisplayName,
  ensureCodexPermissionDefaultsInConfigText,
  executeFilePlans,
  inspectProviderConfig,
  inspectCodexWorkspacePermissionsText,
  providerConfigPaths,
  saveProviderConfig,
  switchProviderToOfficialAccount,
  trustCodexWorkspace,
  trustCodexWorkspaceInConfigText,
  toNativeConfigSummary,
} from './config-files'
import { attachNotUtf8ConfigRewriteLog } from './config-files-context'
import { providerBaseUrls, type ProviderId } from './catalog'
import { relayProviderBaseUrls } from './relay-sites'
import {
  asRecord,
  directoryFileSnapshot,
  providerRoots,
  removeTemporaryHomes,
  temporaryHome,
  testModels,
} from './config-files.test-support'

if (false) {
  // @ts-expect-error Core config APIs require both the user and Codex roots.
  providerConfigPaths('codex', '/tmp/string-root')
  // @ts-expect-error Core config APIs require both the user and Codex roots.
  inspectProviderConfig('codex', '/tmp/string-root')
  // @ts-expect-error Core config APIs require both the user and Codex roots.
  saveProviderConfig('codex', 'sk-key', 'gpt-5.6-sol', 'reset', '/tmp/string-root')
}

afterEach(() => {
  vi.restoreAllMocks()
  removeTemporaryHomes()
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
  it('reads the first exact NAME= line of the Gemini .env and reports a missing line as empty', () => {
    const roots = providerRoots(temporaryHome())
    const [, envPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(envPath), { recursive: true })
    fs.writeFileSync(envPath, [
      '# comment',
      'GEMINI_API_KEY =sk-spaced',
      '  GEMINI_API_KEY= "sk-quoted" ',
      'GEMINI_API_KEY=sk-second',
      "GOOGLE_GEMINI_BASE_URL='https://xm.solov.cc'",
      'GEMINI_MODEL="gemini-3.5-flash\'',
      '',
    ].join('\r\n'))
    expect(inspectProviderConfig('gemini', roots, providerBaseUrls)).toMatchObject({
      apiKey: 'sk-quoted',
      actualBaseUrl: 'https://xm.solov.cc',
      model: '"gemini-3.5-flash\'',
    })

    fs.writeFileSync(envPath, 'OTHER=1\n')
    expect(inspectProviderConfig('gemini', roots, providerBaseUrls)).toMatchObject({ apiKey: '', actualBaseUrl: '', model: '' })
    fs.rmSync(envPath)
    expect(inspectProviderConfig('gemini', roots, providerBaseUrls)).toMatchObject({ apiKey: '', actualBaseUrl: '', model: '' })
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
      .toThrow(/^Codex 的配置文件内容有误（第 \d+ 行附近），星芒未改动该文件。/)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('tells the home page when Codex itself cannot read config.toml', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const configPath = providerConfigPaths('codex', roots)[0]
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    // A duplicate key written by another tool stops Codex Desktop at
    // 「无法加载组织设置」 before anything else loads.
    fs.writeFileSync(configPath, 'model = "a"\nmodel = "b"\n', 'utf8')
    expect(inspectProviderConfig('codex', roots).configBroken).toBe(true)
    // A Chinese comment saved as GBK: this app still reads the file, Codex does not.
    fs.writeFileSync(configPath, Buffer.concat([Buffer.from('# '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\nmodel = "a"\n')]))
    expect(inspectProviderConfig('codex', roots).model).toBe('a')
    expect(inspectProviderConfig('codex', roots).configBroken).toBe(true)
    // TOML 1.1 that Codex reads fine is not broken, although this app cannot parse it.
    fs.writeFileSync(configPath, 'model = "a"\nxm = {\n  b = 1,\n}\n', 'utf8')
    expect(inspectProviderConfig('codex', roots)).not.toHaveProperty('configBroken')
    fs.writeFileSync(configPath, 'model = "a"\n', 'utf8')
    expect(inspectProviderConfig('codex', roots)).not.toHaveProperty('configBroken')
    const grokPath = providerConfigPaths('grok', roots)[0]
    fs.mkdirSync(path.dirname(grokPath), { recursive: true })
    fs.writeFileSync(grokPath, 'model = "a"\nmodel = "b"\n', 'utf8')
    expect(inspectProviderConfig('grok', roots)).not.toHaveProperty('configBroken')
  })

  it('opens each Codex config file once per inspection and reads it afresh on the next one', () => {
    const roots = providerRoots(temporaryHome())
    saveProviderConfig('codex', 'sk-first', 'gpt-5.6-sol', 'reset', roots, {}, providerBaseUrls)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    const opened: string[] = []
    const openSync = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(function (this: unknown, target: fs.PathLike, ...rest: unknown[]) {
      opened.push(path.resolve(String(target)))
      return Reflect.apply(openSync, this, [target, ...rest]) as number
    } as typeof fs.openSync)

    expect(inspectProviderConfig('codex', roots, providerBaseUrls))
      .toMatchObject({ apiKey: 'sk-first', model: 'gpt-5.6-sol', hasApiKey: true, matchesRelay: true })
    // Model, address, provider table, credentials check and the broken check all read config.toml;
    // key, sign-in mode, official identity and the broken check all read auth.json.
    expect(opened.filter((target) => target === path.resolve(configPath))).toHaveLength(1)
    expect(opened.filter((target) => target === path.resolve(authPath))).toHaveLength(1)

    // Nothing is kept past one inspection: a change written in between is read the next time.
    vi.mocked(fs.openSync).mockRestore()
    saveProviderConfig('codex', 'sk-second', 'gpt-5.5', 'merge', roots, {}, providerBaseUrls)
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ apiKey: 'sk-second', model: 'gpt-5.5' })
  })

  it('still tells the home page about a broken Codex config.toml after parsing it only once', () => {
    const roots = providerRoots(temporaryHome())
    const configPath = providerConfigPaths('codex', roots)[0]
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'model = "a"\nmodel = "b"\n', 'utf8')
    // The failed parse behind the empty model is the same one the broken check judges.
    expect(inspectProviderConfig('codex', roots)).toMatchObject({ model: '', configBroken: true })
  })

  it('resets an unreadable Codex config.toml for a ChatGPT login and keeps the login', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'model = "a"\nmodel = "b"\n', 'utf8')
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { id_token: 'id-token', access_token: 'access-token', refresh_token: 'refresh-token', account_id: 'acct' },
    }), 'utf8')

    // 首页「立即修复」对登录 ChatGPT 的客户走的就是这条：以前坏文件在这里直接报错，修不了。
    const saved = switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset')

    expect(fs.readFileSync(configPath, 'utf8')).toBe('approval_policy = "on-request"\nsandbox_mode = "workspace-write"\ncheck_for_update_on_startup = false\n')
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8')) as { tokens: { access_token: string } }
    expect(auth.tokens.access_token).toBe('access-token')
    expect(inspectProviderConfig('codex', roots)).not.toHaveProperty('configBroken')
    const backup = saved.backups.find((entry) => entry.startsWith(`${configPath}.bak.`))
    expect(backup).toBeDefined()
    expect(fs.readFileSync(String(backup), 'utf8')).toBe('model = "a"\nmodel = "b"\n')
    // An unreadable file is never kept as the 星芒 snapshot to switch back to.
    expect(fs.existsSync(codexConfigSnapshotPaths(roots).relay)).toBe(false)
  })

  // ChatGPT 登录换来的 Key 和令牌一起留在 auth.json 里时，Codex 按 auth_mode 用令牌，
  // 读不出地址的坏文件不能因此被当成第三方挡住重置。
  it('resets an unreadable Codex config.toml for a ChatGPT login that also keeps an exchanged key', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, 'model = "a"\nmodel = "b"\n', 'utf8')
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'sk-exchanged-by-login',
      tokens: { id_token: 'id-token', access_token: 'access-token', refresh_token: 'refresh-token', account_id: 'acct' },
    }), 'utf8')
    expect(inspectProviderConfig('codex', roots)).toMatchObject({ codexAuthMode: 'chatgpt', hasApiKey: true, matchesRelay: false, configBroken: true })

    // 只更新照旧不碰，指去重置：分不清来源时宁可不动。
    expect(() => switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'merge'))
      .toThrow(/^Codex 的配置文件内容有误，星芒未改动该文件。/)
    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset')

    expect(fs.readFileSync(configPath, 'utf8')).toBe('approval_policy = "on-request"\nsandbox_mode = "workspace-write"\ncheck_for_update_on_startup = false\n')
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8')) as { tokens: { access_token: string } }
    expect(auth.tokens.access_token).toBe('access-token')
    expect(inspectProviderConfig('codex', roots)).toMatchObject({ codexAuthMode: 'chatgpt' })
    expect(inspectProviderConfig('codex', roots)).not.toHaveProperty('configBroken')
  })

  it('still refuses to reset a readable third-party Codex setup behind a ChatGPT login', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const thirdParty = 'model_provider = "other"\n\n[model_providers.other]\nname = "other"\nbase_url = "https://other.example.test/v1"\n'
    fs.writeFileSync(configPath, thirdParty, 'utf8')
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'sk-exchanged-by-login',
      tokens: { id_token: 'id-token', access_token: 'access-token', refresh_token: 'refresh-token', account_id: 'acct' },
    }), 'utf8')

    expect(() => switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset'))
      .toThrow('当前配置不是星芒中转')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(thirdParty)
  })

  it('tells the home page when Claude Code, Gemini CLI or Codex cannot read their own JSON files', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const [claudePath] = providerConfigPaths('claude', roots)
    const [geminiPath] = providerConfigPaths('gemini', roots)
    const [, authPath] = providerConfigPaths('codex', roots)
    for (const filePath of [claudePath, geminiPath, authPath]) fs.mkdirSync(path.dirname(filePath), { recursive: true })

    // Claude Code skips a settings.json with a trailing comma, so the key this app
    // cannot read either is not the official account in disguise.
    fs.writeFileSync(claudePath, '{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-relay" }, }\n', 'utf8')
    expect(inspectProviderConfig('claude', roots)).toMatchObject({ configBroken: true, hasApiKey: false })
    // A byte order mark is fine for Claude Code, but stops Gemini CLI and Codex.
    fs.writeFileSync(claudePath, '\uFEFF{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-relay" } }\n', 'utf8')
    expect(inspectProviderConfig('claude', roots)).not.toHaveProperty('configBroken')
    fs.writeFileSync(geminiPath, '\uFEFF{ "security": { "auth": { "selectedType": "gemini-api-key" } } }\n', 'utf8')
    expect(inspectProviderConfig('gemini', roots)).toMatchObject({ configBroken: true, authType: 'gemini-api-key' })
    fs.writeFileSync(geminiPath, '// 我的设置\n{ "security": { "auth": { "selectedType": "gemini-api-key" } } }\n', 'utf8')
    expect(inspectProviderConfig('gemini', roots)).not.toHaveProperty('configBroken')
    fs.writeFileSync(authPath, '\uFEFF{ "OPENAI_API_KEY": "sk-relay" }\n', 'utf8')
    expect(inspectProviderConfig('codex', roots)).toMatchObject({ codexAuthBroken: true, hasApiKey: true })
    fs.writeFileSync(authPath, '{ "OPENAI_API_KEY": "sk-relay" }\n', 'utf8')
    expect(inspectProviderConfig('codex', roots)).not.toHaveProperty('codexAuthBroken')
    expect(inspectProviderConfig('claude', roots)).not.toHaveProperty('codexAuthBroken')
  })

  // 中文 Windows 上老记事本把手改过的 settings.json 存成 GBK：Claude Code 照用，星芒写回后那几个字成「�」（D78）。
  it('notes a Claude Code settings.json that is not UTF-8 and logs the save over it, writing what it always wrote (D78)', () => {
    const roots = providerRoots(temporaryHome())
    const [settingsPath] = providerConfigPaths('claude', roots)
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    const original = Buffer.concat([
      Buffer.from('{ "env": { "PROJECT_DIR": "D:/'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from('" } }\n'),
    ])
    fs.writeFileSync(settingsPath, original)
    expect(inspectProviderConfig('claude', roots).files).toEqual([{ path: settingsPath, exists: true, notUtf8: true }])

    const log = vi.fn()
    attachNotUtf8ConfigRewriteLog(log)
    try {
      saveProviderConfig('claude', 'sk-relay', testModels.claude, 'merge', roots, {}, providerBaseUrls)
    } finally {
      attachNotUtf8ConfigRewriteLog(null)
    }

    expect(log).toHaveBeenCalledTimes(1)
    const [{ file, backup }] = log.mock.calls[0] as [{ file: string; backup: string }]
    expect(file).toBe(settingsPath)
    expect(fs.readFileSync(backup)).toEqual(original)
    // 写回的还是解码时换成占位符的那几个字，客户自己设的值一个不少。
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }
    expect(written.env.PROJECT_DIR).toBe(`D:/${'\uFFFD'.repeat(4)}`)
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-relay')
    expect(inspectProviderConfig('claude', roots).files).toEqual([{ path: settingsPath, exists: true }])
  })

  it('resets the account config over an auth.json Codex cannot read, after backing it up', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const auth = codexAuthSnapshotPaths(roots)
    fs.mkdirSync(path.dirname(auth.active), { recursive: true })
    const broken = '{"OPENAI_API_KEY": "sk-old-re'
    fs.writeFileSync(auth.active, broken, 'utf8')
    const savedLogin = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'a.b.c', access_token: 'saved' } })
    fs.writeFileSync(auth.chatgpt, savedLogin, 'utf8')

    // Merge still refuses to rewrite what it cannot read, and says where the reset is.
    expect(() => saveProviderConfig('codex', 'sk-new', testModels.codex, 'merge', roots, {}, providerBaseUrls))
      .toThrow(/^Codex 的配置文件内容有误，星芒未改动该文件。.*「重置为初始状态」/)
    expect(fs.readFileSync(auth.active, 'utf8')).toBe(broken)

    const saved = saveProviderConfig('codex', 'sk-new', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-new' })
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ hasApiKey: true, matchesRelay: true })
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).not.toHaveProperty('codexAuthBroken')
    const backup = saved.backups.find((entry) => entry.startsWith(`${auth.active}.bak.`))
    expect(fs.readFileSync(String(backup), 'utf8')).toBe(broken)
    // The ChatGPT login saved earlier is still there to switch back to.
    expect(fs.readFileSync(auth.chatgpt, 'utf8')).toBe(savedLogin)
  })

  it('resets the official config over an auth.json Codex cannot read', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const auth = codexAuthSnapshotPaths(roots)
    fs.mkdirSync(path.dirname(auth.active), { recursive: true })
    fs.writeFileSync(auth.active, Buffer.alloc(64))

    expect(() => switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'merge'))
      .toThrow(/^Codex 的配置文件内容有误，星芒未改动该文件。/)
    const saved = switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset')

    // No ChatGPT login to put back: no auth.json at all is how Codex itself says
    // "not logged in", and opening it asks for a login.
    expect(fs.existsSync(auth.active)).toBe(false)
    const backup = saved.backups.find((entry) => entry.startsWith(`${auth.active}.bak.`))
    expect(fs.readFileSync(String(backup))).toEqual(Buffer.alloc(64))
    expect(inspectProviderConfig('codex', roots)).not.toHaveProperty('codexAuthBroken')

    // With a saved ChatGPT login, the reset puts that login back instead.
    fs.writeFileSync(auth.active, '{"auth_mode": "chatgpt",', 'utf8')
    fs.writeFileSync(auth.chatgpt, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'a.b.c', access_token: 'saved' } }), 'utf8')
    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'reset')
    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toMatchObject({ auth_mode: 'chatgpt', tokens: { access_token: 'saved' } })
  })

  // 0.2.24 深查 X-1：只坏了 auth.json 时「立即修复」以前整份重建 config.toml，客户自己加的连接、信任过的文件夹、
  // 推理强度全没了；从修之前的备份找回又把坏的 auth.json 一起放回去。
  describe('repair over an auth.json Codex cannot read (X-1)', () => {
    const customized = [
      'model_reasoning_effort = "high"',
      '',
      '[mcp_servers.my-docs]',
      'command = "npx"',
      'args = ["-y", "my-docs-mcp"]',
      '',
      '[projects."/home/me/work"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')
    const brokenAuth = '{"OPENAI_API_KEY": "sk-old-re'

    // The template already sets its own reasoning effort, so the customer's choice replaces it in place.
    function customize(configPath: string) {
      const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
      Object.assign(config, TOML.parse(customized))
      fs.writeFileSync(configPath, TOML.stringify(config), 'utf8')
    }

    function expectCustomizationsKept(config: Record<string, unknown>) {
      expect(config.model_reasoning_effort).toBe('high')
      expect(config.mcp_servers).toEqual({ 'my-docs': { command: 'npx', args: ['-y', 'my-docs-mcp'] } })
      expect(config.projects).toEqual({ '/home/me/work': { trust_level: 'trusted' } })
    }

    it('keeps the customer\'s own config.toml settings and rebuilds only auth.json for the current account', () => {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      const auth = codexAuthSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-old', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      customize(configPath)
      fs.writeFileSync(auth.active, brokenAuth, 'utf8')
      const inspected = inspectProviderConfig('codex', roots, providerBaseUrls)
      expect(inspected).toMatchObject({ codexAuthBroken: true })
      expect(inspected).not.toHaveProperty('configBroken')

      const saved = saveProviderConfig('codex', 'sk-new', testModels.codex, 'repair', roots, {}, providerBaseUrls)

      const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
      expectCustomizationsKept(config)
      expect(config.model).toBe(testModels.codex)
      expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-new' })
      const after = inspectProviderConfig('codex', roots, providerBaseUrls)
      expect(after).toMatchObject({ hasApiKey: true, matchesRelay: true })
      expect(after).not.toHaveProperty('codexAuthBroken')
      // Still backed up first, so the broken file can be looked at later.
      const backup = saved.backups.find((entry) => entry.startsWith(`${auth.active}.bak.`))
      expect(fs.readFileSync(String(backup), 'utf8')).toBe(brokenAuth)

      // 配置里「重置为初始状态」照旧整份重建：那颗按钮说了「自己改过的设置也会重置」。
      fs.writeFileSync(auth.active, brokenAuth, 'utf8')
      saveProviderConfig('codex', 'sk-new', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      const reset = TOML.parse(fs.readFileSync(configPath, 'utf8'))
      expect(reset).not.toHaveProperty('mcp_servers')
      expect(reset).not.toHaveProperty('projects')
    })

    it('still rebuilds config.toml like a reset when Codex cannot read it either', () => {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      const auth = codexAuthSnapshotPaths(roots)
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, 'model = "a"\nmodel = "b"\n', 'utf8')
      fs.writeFileSync(auth.active, brokenAuth, 'utf8')
      expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ configBroken: true, codexAuthBroken: true })

      saveProviderConfig('codex', 'sk-new', testModels.codex, 'repair', roots, {}, providerBaseUrls)
      const repaired = fs.readFileSync(configPath, 'utf8')
      fs.writeFileSync(configPath, 'model = "a"\nmodel = "b"\n', 'utf8')
      fs.writeFileSync(auth.active, brokenAuth, 'utf8')
      saveProviderConfig('codex', 'sk-new', testModels.codex, 'reset', roots, {}, providerBaseUrls)

      expect(repaired).toBe(fs.readFileSync(configPath, 'utf8'))
      expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-new' })
      expect(inspectProviderConfig('codex', roots, providerBaseUrls)).not.toHaveProperty('configBroken')
    })

    // 2026-11-18 客户：中文用户名被 PowerShell 5.1 按 GBK 转了一圈，后面的反斜杠被吃掉，整份 Codex 读不了。
    // 只坏了带用户名的那几行，「立即修复」去掉它们照合并修，客户自己的设置照留；「重置为初始状态」照旧整份重建。
    const mangledLines = [
      'notify = ["C:\\\\Users\\\\\u5BEE\u72B2\u76AC\u93C4\u5DBE\\AppData\\\\hook.cjs", "codex"]',
      '',
      '[projects."C:\\\\Users\\\\\u5BEE\u72B2\u76AC\u93C4\u5DBE\\Documents"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')

    it('keeps the readable settings when only a few lines of config.toml are unreadable, repairing for the current account', () => {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      const auth = codexAuthSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-old', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      customize(configPath)
      const broken = `${fs.readFileSync(configPath, 'utf8')}\n${mangledLines}`
      fs.writeFileSync(configPath, broken, 'utf8')
      expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ configBroken: true, matchesRelay: false })

      const saved = saveProviderConfig('codex', 'sk-new', testModels.codex, 'repair', roots, {}, providerBaseUrls)

      const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
      expectCustomizationsKept(config)
      expect(config.model).toBe(testModels.codex)
      expect(config).not.toHaveProperty('notify')
      expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-new' })
      const after = inspectProviderConfig('codex', roots, providerBaseUrls)
      expect(after).toMatchObject({ hasApiKey: true, matchesRelay: true })
      expect(after).not.toHaveProperty('configBroken')
      const backup = saved.backups.find((entry) => entry.startsWith(`${configPath}.bak.`))
      expect(fs.readFileSync(String(backup), 'utf8')).toBe(broken)

      // 配置里「重置为初始状态」照旧整份重建。
      fs.writeFileSync(configPath, broken, 'utf8')
      saveProviderConfig('codex', 'sk-new', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      const reset = TOML.parse(fs.readFileSync(configPath, 'utf8'))
      expect(reset).not.toHaveProperty('mcp_servers')
      expect(reset).not.toHaveProperty('projects')
    })

    it('rebuilds a config.toml that is not UTF-8 instead of salvaging garbled text', () => {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      saveProviderConfig('codex', 'sk-old', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      customize(configPath)
      // 「张三」 saved as GBK, plus one line Codex cannot parse either way.
      const gbk = Buffer.concat([fs.readFileSync(configPath), Buffer.from('\n[projects."C:\\\\Users\\\\'), Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]), Buffer.from('\\A"]\ntrust_level = "trusted"\n')])
      fs.writeFileSync(configPath, gbk)
      expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ configBroken: true })

      saveProviderConfig('codex', 'sk-new', testModels.codex, 'repair', roots, {}, providerBaseUrls)

      const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
      expect(config).not.toHaveProperty('mcp_servers')
      expect(config.model).toBe(testModels.codex)
    })

    it('keeps the readable settings of a ChatGPT login whose config.toml has a few unreadable lines', () => {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      const auth = codexAuthSnapshotPaths(roots)
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      const broken = `${customized}\n${mangledLines}`
      fs.writeFileSync(configPath, broken, 'utf8')
      const login = { auth_mode: 'chatgpt', tokens: { id_token: 'a.b.c', access_token: 'live' } }
      fs.writeFileSync(auth.active, JSON.stringify(login), 'utf8')
      expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ configBroken: true, codexAuthMode: 'chatgpt' })

      const saved = switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'repair')

      const config = TOML.parse(fs.readFileSync(configPath, 'utf8'))
      expectCustomizationsKept(config)
      expect(config).not.toHaveProperty('notify')
      expect(inspectProviderConfig('codex', roots, providerBaseUrls)).not.toHaveProperty('configBroken')
      const backup = saved.backups.find((entry) => entry.startsWith(`${configPath}.bak.`))
      expect(fs.readFileSync(String(backup), 'utf8')).toBe(broken)
    })

    it('leaves an official config.toml exactly as the customer had it when repairing for the official account', () => {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      const auth = codexAuthSnapshotPaths(roots)
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, customized, 'utf8')
      fs.writeFileSync(auth.active, brokenAuth, 'utf8')
      // An older official copy must not come back over what the customer has now.
      fs.writeFileSync(codexConfigSnapshotPaths(roots).chatgpt, 'approval_policy = "never"\n', 'utf8')
      const savedLogin = { auth_mode: 'chatgpt', tokens: { id_token: 'a.b.c', access_token: 'saved' } }
      fs.writeFileSync(auth.chatgpt, JSON.stringify(savedLogin), 'utf8')

      const saved = switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'repair')

      expect(fs.readFileSync(configPath, 'utf8')).toBe(customized)
      expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toMatchObject(savedLogin)
      expect(inspectProviderConfig('codex', roots, providerBaseUrls)).not.toHaveProperty('codexAuthBroken')
      const backup = saved.backups.find((entry) => entry.startsWith(`${auth.active}.bak.`))
      expect(fs.readFileSync(String(backup), 'utf8')).toBe(brokenAuth)

      // Without a saved login the broken file goes, the way Codex itself says "not logged in".
      fs.rmSync(auth.chatgpt)
      fs.writeFileSync(auth.active, brokenAuth, 'utf8')
      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'repair')
      expect(fs.existsSync(auth.active)).toBe(false)
      expect(fs.readFileSync(configPath, 'utf8')).toBe(customized)
    })

    it('drops only the current account\'s settings from config.toml when repairing a relay setup for the official account', () => {
      const roots = providerRoots(temporaryHome())
      const [configPath] = providerConfigPaths('codex', roots)
      const auth = codexAuthSnapshotPaths(roots)
      saveProviderConfig('codex', 'sk-old', testModels.codex, 'reset', roots, {}, providerBaseUrls)
      customize(configPath)
      fs.rmSync(codexConfigSnapshotPaths(roots).chatgpt, { force: true })
      fs.writeFileSync(auth.active, brokenAuth, 'utf8')

      switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls, 'repair')

      expectCustomizationsKept(TOML.parse(fs.readFileSync(configPath, 'utf8')))
      const after = inspectProviderConfig('codex', roots, providerBaseUrls)
      expect(after.actualBaseUrl).toBe('')
      expect(after).not.toHaveProperty('codexAuthBroken')
      expect(fs.existsSync(auth.active)).toBe(false)
    })
  })

  // Codex 0.159 reads an auth.json of `{}` as a ChatGPT login without tokens: every
  // request fails with "plan type is required for chatgpt authentication" and it
  // never asks for a login. Switching a relay that never had a ChatGPT login back
  // to official used to leave exactly that behind.
  it('leaves no empty auth.json behind when switching a relay without a ChatGPT login to official', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const auth = codexAuthSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

    expect(fs.existsSync(auth.active)).toBe(false)
    expect(JSON.parse(fs.readFileSync(auth.apikey, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-relay' })
    expect(inspectProviderConfig('codex', roots, providerBaseUrls)).toMatchObject({ hasApiKey: false, codexAuthMode: null })
    saveProviderConfig('codex', 'sk-relay-again', testModels.codex, 'merge', roots, {}, providerBaseUrls)
    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual({ OPENAI_API_KEY: 'sk-relay-again' })
  })

  it('keeps an auth.json that still holds something else when switching to official', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const auth = codexAuthSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    fs.writeFileSync(auth.active, JSON.stringify({ OPENAI_API_KEY: 'sk-relay', personal_access_token: 'pat' }), 'utf8')

    switchProviderToOfficialAccount('codex', roots, {}, providerBaseUrls)

    expect(JSON.parse(fs.readFileSync(auth.active, 'utf8'))).toEqual({ personal_access_token: 'pat' })
  })

  it('puts a removed auth.json back when a later file in the same switch cannot commit', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const auth = codexAuthSnapshotPaths(roots)
    const configs = codexConfigSnapshotPaths(roots)
    saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', roots, {}, providerBaseUrls)
    const before = directoryFileSnapshot(roots.codexHome)

    expect(() => executeFilePlans([
      { path: auth.active, remove: true },
      { path: configs.active, content: 'model = "x"\n' },
    ], {
      beforeReplace(file) { if (file === configs.active) throw new Error('fixture failure') },
    }, roots.codexHome)).toThrow('fixture failure')

    const after = directoryFileSnapshot(roots.codexHome)
    expect(after[path.basename(auth.active)]).toBe(before[path.basename(auth.active)])
    expect(after[path.basename(configs.active)]).toBe(before[path.basename(configs.active)])
    expect(Object.keys(after).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('points a Claude Code or Gemini CLI switch to official at the reset instead of calling it official already', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const [claudePath] = providerConfigPaths('claude', roots)
    const [geminiPath] = providerConfigPaths('gemini', roots)
    fs.mkdirSync(path.dirname(claudePath), { recursive: true })
    fs.mkdirSync(path.dirname(geminiPath), { recursive: true })
    fs.writeFileSync(claudePath, '{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-relay" }, }\n', 'utf8')
    fs.writeFileSync(geminiPath, '{ "security": ', 'utf8')

    // 以前这里说「当前已在使用您自己的官方订阅账号，无需切换」，方向全错（已知44 ①）。
    expect(() => switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls, 'merge'))
      .toThrow(/^Claude Code 的配置文件内容有误，星芒未改动该文件。/)
    expect(() => switchProviderToOfficialAccount('gemini', roots, {}, providerBaseUrls, 'merge'))
      .toThrow(/^Gemini CLI 的配置文件内容有误，星芒未改动该文件。/)

    switchProviderToOfficialAccount('claude', roots, {}, providerBaseUrls, 'reset')
    expect(JSON.parse(fs.readFileSync(claudePath, 'utf8'))).toMatchObject({ env: { DISABLE_AUTOUPDATER: '1' } })
    expect(inspectProviderConfig('claude', roots)).not.toHaveProperty('configBroken')
  })

  it('points the customer at the reset when a save cannot read the existing config', () => {
    // 以前只说「现有 … 无法解析，未执行修改」，客户不知道「重置为初始状态」能救，只能反复重试（第三十批 C）。
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const reset = '星芒未改动该文件。请在首页 {tool} 卡片的「…」中点击「配置…」，选择「当前账号」，展开最下方的「高级」并点击「重置为初始状态」：将先备份原文件（可在「设置 › 备份迁移」中找回），再重新生成。'
    const advice = (tool: string, problem: string) => `${problem}，${reset.replace('{tool}', tool)}`
    const cases: Array<{ provider: ProviderId, content: string, expected: string }> = [
      { provider: 'codex', content: 'model = “gpt-5.5”\n', expected: advice('Codex', 'Codex 的配置文件内容有误（第 1 行附近）') },
      { provider: 'claude', content: '{ "env": { "ANTHROPIC_MODEL": "claude-opus-4-6" }, }\n', expected: advice('Claude Code', 'Claude Code 的配置文件内容有误') },
      { provider: 'claude', content: '["not", "settings"]\n', expected: advice('Claude Code', 'Claude Code 的配置文件内容有误') },
      { provider: 'gemini', content: '{ "ui": { "theme": "GitHub", }, }\n', expected: advice('Gemini CLI', 'Gemini CLI 的配置文件内容有误') },
      { provider: 'gemini', content: '[]\n', expected: advice('Gemini CLI', 'Gemini CLI 的配置文件内容有误') },
      { provider: 'grok', content: '# 我的设置\ndefault = “grok-4.5”\n', expected: advice('Grok CLI', 'Grok CLI 的配置文件内容有误（第 2 行附近）') },
      { provider: 'grok', content: '[models]\ndefault = "missing"\n', expected: advice('Grok CLI', 'Grok CLI 配置文件中的默认模型部分有误') },
    ]
    for (const { provider, content, expected } of cases) {
      const configPath = providerConfigPaths(provider, roots)[0]
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, content, 'utf8')
      let message = ''
      try {
        saveProviderConfig(provider, 'sk-merge', testModels[provider], 'merge', roots, {}, providerBaseUrls)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toBe(expected)
      // 客户看不懂文件格式的名字；按钮叫法要和界面上的一字不差。
      expect(message).not.toMatch(/toml|json/i)
      expect(fs.readFileSync(configPath, 'utf8')).toBe(content)
    }
  })

  it('names only the row of a broken TOML config, never the lines around it', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const broken = 'model = "grok-4"\napi_key = "xai-secret-value-123"\n[mcp.\nGITHUB_PERSONAL_ACCESS_TOKEN = "ghp_secretvalue"\n'
    for (const provider of ['codex', 'grok'] as const) {
      const configPath = providerConfigPaths(provider, roots)[0]
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, broken, 'utf8')
      let message = ''
      try {
        saveProviderConfig(provider, 'sk-merge', provider === 'codex' ? 'gpt-5.6-sol' : 'grok-4', 'merge', roots, {}, providerBaseUrls)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      // 全面检测 Q17：TOML 解析器的原文自带前后几行，截图发客服就带出 Key。
      expect(message).toMatch(/的配置文件内容有误（第 3 行附近），星芒未改动该文件。/)
      expect(message).not.toMatch(/xai-secret|ghp_secret|api_key/)
      expect(fs.readFileSync(configPath, 'utf8')).toBe(broken)
    }
  })

  it('reads configs that start with a UTF-8 byte order mark', () => {
    const userHome = temporaryHome()
    const roots = providerRoots(userHome)
    const claudePath = providerConfigPaths('claude', roots)[0]
    const codexPath = providerConfigPaths('codex', roots)[0]
    fs.mkdirSync(path.dirname(claudePath), { recursive: true })
    fs.mkdirSync(path.dirname(codexPath), { recursive: true })
    // 老记事本和 PowerShell 5 的 Set-Content -Encoding UTF8 都会写 BOM（全面检测 Q41）。
    fs.writeFileSync(claudePath, `\uFEFF${JSON.stringify({ theme: 'dark' })}`, 'utf8')
    fs.writeFileSync(codexPath, '\uFEFFapproval_policy = "never"\n', 'utf8')

    saveProviderConfig('claude', 'sk-claude', 'claude-sonnet-5', 'merge', roots, {}, providerBaseUrls)
    saveProviderConfig('codex', 'sk-codex', 'gpt-5.6-sol', 'merge', roots, {}, providerBaseUrls)

    const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as Record<string, unknown>
    expect(claude.theme).toBe('dark')
    const codex = TOML.parse(fs.readFileSync(codexPath, 'utf8'))
    expect(codex.approval_policy).toBe('never')
    expect(inspectProviderConfig('claude', roots).hasApiKey).toBe(true)
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
      name: 'OpenAI',
      base_url: 'https://xm.solov.cc/v1',
      wire_api: 'responses',
      requires_openai_auth: true,
      supports_websockets: true,
    })
    expect(asRecord(parsed.model_providers)?.OpenAI).toBeUndefined()

    const mergeHome = temporaryHome()
    const mergeRoots = providerRoots(mergeHome)
    const [mergeConfigPath] = providerConfigPaths('codex', mergeRoots)
    saveProviderConfig('codex', 'sk-merge-first', testModels.codex, 'merge', mergeRoots, {}, providerBaseUrls)
    const merged = asRecord(TOML.parse(fs.readFileSync(mergeConfigPath, 'utf8')))!
    expect(merged.model_provider).toBe(defaultCodexRelayProvider)
    expect(asRecord(asRecord(merged.model_providers)?.[defaultCodexRelayProvider])?.supports_websockets).toBe(true)
    expect(merged).not.toHaveProperty('model_context_window')
    expect(merged).not.toHaveProperty('model_auto_compact_token_limit')
  })

  it('renames our own legacy XingmangAI display name during merge and keeps the table key', () => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const configs = codexConfigSnapshotPaths(roots)
    const [, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(configs.active, [
      'model_provider = "XingmangAI"',
      '',
      '[model_providers.XingmangAI]',
      'name = "XingmangAI"',
      `base_url = "${relayProviderBaseUrls('solov', 'direct').codex}"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{}\n', 'utf8')

    saveProviderConfig('codex', 'sk-merge', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    expect(codexRelayDisplayName).toBe('OpenAI')
    for (const file of [configs.active, configs.relay]) {
      const parsed = asRecord(TOML.parse(fs.readFileSync(file, 'utf8')))!
      expect(parsed.model_provider).toBe('XingmangAI')
      expect(asRecord(asRecord(parsed.model_providers)?.XingmangAI)?.name).toBe('OpenAI')
    }
  })

  it.each([
    ['a name the customer chose', 'XingmangAI', '我的中转', providerBaseUrls.codex],
    ['the table older releases named OpenAI', 'OpenAI', 'OpenAI', providerBaseUrls.codex],
    ['a XingmangAI name on a table that pointed somewhere else', 'XingmangAI', 'XingmangAI', 'https://other.example.com/v1'],
  ])('keeps %s as the Codex display name during merge', (_label, table, name, baseUrl) => {
    const home = temporaryHome()
    const roots = providerRoots(home)
    const [configPath, authPath] = providerConfigPaths('codex', roots)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      `model_provider = "${table}"`,
      '',
      `[model_providers.${table}]`,
      `name = "${name}"`,
      `base_url = "${baseUrl}"`,
      '',
    ].join('\n'), 'utf8')
    fs.writeFileSync(authPath, '{}\n', 'utf8')

    saveProviderConfig('codex', 'sk-merge', testModels.codex, 'merge', roots, {}, providerBaseUrls)

    const parsed = asRecord(TOML.parse(fs.readFileSync(configPath, 'utf8')))!
    expect(parsed.model_provider).toBe(table)
    const provider = asRecord(asRecord(parsed.model_providers)?.[table])
    expect(provider?.name).toBe(name)
    expect(provider?.base_url).toBe('https://xm.solov.cc/v1')
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
    'recognizes both fixed and historical backup URLs for %s only within their account site', (provider) => {
      const roots = providerRoots(temporaryHome())
      const direct = relayProviderBaseUrls('solov', 'direct')
      const historical = { claude: 'https://38.147.105.28:8443', codex: 'https://38.147.105.28:8443/v1',
        gemini: 'https://38.147.105.28:8443', grok: 'https://38.147.105.28:8443/v1' }
      for (const urls of [direct, historical]) {
        saveProviderConfig(provider, 'sk-fixture', testModels[provider], 'reset', roots, {}, urls)
        const inspection = inspectProviderConfig(provider, roots, providerBaseUrls)
        expect(inspection.actualBaseUrl).toBe(urls[provider])
        expect(inspection.matchesRelay).toBe(true)
        expect(canLaunchManagedProvider(inspection)).toBe(true)
        expect(inspectProviderConfig(provider, roots, relayProviderBaseUrls('solov-api')).matchesRelay).toBe(false)
      }
    },
  )

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
          permissions: { defaultMode: 'bypassPermissions', deny: ['Artifact', 'DesignSync'] },
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
          privacy: { usageStatisticsEnabled: false },
          security: { auth: { selectedType: 'gemini-api-key' } },
        })
        expect(Object.keys(settings).sort()).toEqual(['general', 'ide', 'modelConfigs', 'privacy', 'security'])
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
        expect(settings.models).toEqual({
          default: 'grok',
          web_search: 'grok',
          session_summary: 'grok',
          image_description: 'grok',
          allowed_models: ['grok'],
        })
        expect(settings.endpoints).toEqual({ xai_api_base_url: 'https://xm.solov.cc/v1' })
        expect(settings.features).toEqual({ video_gen: false })
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
})

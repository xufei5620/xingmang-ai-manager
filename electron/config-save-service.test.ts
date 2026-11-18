import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { providerBaseUrls, type ProviderId } from './catalog'
import { resolveGrokWindowsShell } from './cli-hooks'
import { inspectProviderConfig, providerConfigPaths, saveProviderConfig, type NativeConfigInspection } from './config-files'
import { createConfigSaveService, grokShellEnvironment, recoverBrokenConfigOwnership } from './config-save-service'
import { resolveEditorSettingsLocations } from './editor-claude-login-prompt'
import type { SystemServiceOptions, ToolStatus } from './system-service'
import { createServiceContext } from './system-service-context'

// #1070 第 3 步把保存配置、钩子、型号名单和开机补设置那一段搬成了 createConfigSaveService。保存的全过程仍由
// system-service 的测试经 createSystemService 覆盖；这里钉住搬家新接上的那几处：问型号走上下文那份，挪开官方 Key、
// 换完 Key 让外部客户端跟上用的是传进来的那几样，开机那次型号名单检查只做一遍。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const absent: ToolStatus = { installed: false, version: null, path: null, installDirectory: null }

function createService(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-save-service-'))
  temporaryDirectories.push(root)
  const userHome = path.join(root, 'home')
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true })
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'claude-fixture' }] }))
  const context = createServiceContext(store, {
    platform: 'linux',
    managerDataDirectory: root,
    providerRoots: { userHome, codexHome: path.join(root, 'codex') },
    findExecutable: async () => null,
    relayFetch,
    ...options,
  })
  const dependencies = {
    inspectCliTool: vi.fn(async () => ({ status: absent, installation: null })),
    inspectRunningTools: vi.fn(async () => ({ running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false })),
    followManagedKeysNow: vi.fn(async () => undefined),
    accountRouteFollowed: new Map(),
    accountRouteFaultFollowed: vi.fn(() => false),
    writeToolRouteRecord: vi.fn(async () => undefined),
    toolRouteSummaryFields: vi.fn(() => ({})),
    restoreOfficialCredentialsNow: vi.fn(() => false),
    moveOfficialCredentialsAside: vi.fn(() => false),
    withCredentialUndo: vi.fn((error: unknown) => error),
    applyXingmangAiSkillForCodexAccount: vi.fn(async () => undefined),
    holdsAccountKey: vi.fn(async (_provider: ProviderId, _current: NativeConfigInspection) => false),
  }
  return { root, store, userHome, relayFetch, dependencies, service: createConfigSaveService(context, dependencies) }
}

describe('config save service', () => {
  it('saves Claude Code with the shared model list and the official key helper it was given', async () => {
    const { store, userHome, relayFetch, dependencies, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    await store.setOfficialProvider('claude', true)

    await service.saveConfig({ provider: 'claude', apiKey: 'sk-fixture', model: 'claude-fixture', mode: 'merge' }, false, undefined, {
      source: 'account',
      automatic: false,
    })

    expect(relayFetch).toHaveBeenCalledTimes(1)
    expect(dependencies.moveOfficialCredentialsAside).toHaveBeenCalledTimes(1)
    expect(dependencies.withCredentialUndo).not.toHaveBeenCalled()
    expect(dependencies.applyXingmangAiSkillForCodexAccount).not.toHaveBeenCalled()
    expect(store.read().officialProviders ?? []).not.toContain('claude')
    expect(fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8')).toContain('sk-fixture')
    // 换的是星芒签的 Key：外部客户端那边接着看一眼要不要跟上，不挡这次保存。
    await vi.waitFor(() => expect(dependencies.followManagedKeysNow).toHaveBeenCalledTimes(1))
  })

  it('refuses a model the key cannot use before touching the official key', async () => {
    const { dependencies, service } = createService()

    await expect(service.saveConfig({ provider: 'claude', apiKey: 'sk-fixture', model: 'claude-missing', mode: 'merge' }, false))
      .rejects.toThrow('当前密钥不支持模型 claude-missing')
    expect(dependencies.moveOfficialCredentialsAside).not.toHaveBeenCalled()
    expect(dependencies.followManagedKeysNow).not.toHaveBeenCalled()
  })

  it('reads each tool config file once for the whole summary the home page asks for', () => {
    const { root, userHome, service } = createService()
    const roots = { userHome, codexHome: path.join(root, 'codex') }
    saveProviderConfig('codex', 'sk-codex', 'gpt-fixture', 'reset', roots, {}, providerBaseUrls)
    saveProviderConfig('claude', 'sk-claude', 'claude-fixture', 'reset', roots, {}, providerBaseUrls)
    const watched = [...providerConfigPaths('codex', roots), ...providerConfigPaths('claude', roots)].map((target) => path.resolve(target))
    const opened: string[] = []
    const openSync = fs.openSync
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(function (this: unknown, target: fs.PathLike, ...rest: unknown[]) {
      opened.push(path.resolve(String(target)))
      return Reflect.apply(openSync, this, [target, ...rest]) as number
    } as typeof fs.openSync)
    try {
      const summary = service.buildConfigSummary(false)
      expect(summary.providers.codex).toMatchObject({ hasApiKey: true, model: 'gpt-fixture' })
      expect(summary.providers.claude).toMatchObject({ hasApiKey: true, model: 'claude-fixture' })
      // The hooks check reads the same main config the inspection just read.
      expect(watched.map((target) => opened.filter((entry) => entry === target).length)).toEqual(watched.map(() => 1))
    } finally {
      spy.mockRestore()
    }
  })

  it('checks the Codex model catalog at startup only once and not at all without a bundled catalog', async () => {
    const { dependencies, service } = createService()

    const first = service.guardCodexModelCatalogAtStartup()
    expect(service.guardCodexModelCatalogAtStartup()).toBe(first)
    await first
    expect(dependencies.inspectCliTool).not.toHaveBeenCalled()
  })
})

describe('turning off the Claude Code sign-in screen in VS Code and Cursor', () => {
  const claude = { provider: 'claude' as const, apiKey: 'sk-fixture', model: 'claude-fixture', mode: 'merge' as const }
  const account = { source: 'account' as const, automatic: false }

  function editors(userHome: string) {
    const [vscode, cursor] = resolveEditorSettingsLocations({ platform: 'linux', userHome, env: {} })
    return { vscode, cursor }
  }

  function loginPromptSetting(settingsPath: string): unknown {
    return (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)['claudeCode.disableLoginPrompt']
  }

  it('adds the setting to an editor the customer has opened whenever Claude Code is saved', async () => {
    const { userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    const { vscode, cursor } = editors(userHome)
    fs.mkdirSync(vscode.userDirectory, { recursive: true })
    fs.writeFileSync(vscode.settingsPath, '{\n    "editor.fontSize": 16\n}\n')

    await service.saveConfig(claude, false, undefined, account)

    expect(loginPromptSetting(vscode.settingsPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(vscode.settingsPath, 'utf8'))).toMatchObject({ 'editor.fontSize': 16 })
    expect(fs.existsSync(cursor.userDirectory)).toBe(false)
  })

  it('leaves editor settings alone in the onboarding preview', async () => {
    const { userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    const { vscode } = editors(userHome)
    fs.mkdirSync(vscode.userDirectory, { recursive: true })

    await service.saveConfig(claude, true, undefined, account)

    expect(fs.readdirSync(vscode.userDirectory)).toEqual([])
  })

  it('gives an older Claude Code config of the current account the setting once at startup', async () => {
    const { root, userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    await service.saveConfig(claude, false, undefined, account)
    // 装星芒那会儿还没用过 VS Code，配置是上一版模板写的。
    const ownerDirectory = path.join(root, 'tool-config-ownership')
    const ownerFile = path.join(ownerDirectory, fs.readdirSync(ownerDirectory)[0])
    const record = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as Record<string, unknown>
    delete record.templateRevision
    fs.writeFileSync(ownerFile, JSON.stringify(record), 'utf8')
    const { vscode } = editors(userHome)
    fs.mkdirSync(vscode.userDirectory, { recursive: true })

    await service.fillToolTemplateDefaultsThenSyncPickers(() => undefined)

    expect(loginPromptSetting(vscode.settingsPath)).toBe(true)
    // 跟着模板版本号只做这一次：客户自己删掉以后，下次开机不再补回来。
    fs.rmSync(vscode.settingsPath)
    await service.fillToolTemplateDefaultsThenSyncPickers(() => undefined)
    expect(fs.existsSync(vscode.settingsPath)).toBe(false)
  })

  it('does not put the setting back on a later save or startup after the customer removed it', async () => {
    const { root, store, userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    const { vscode } = editors(userHome)
    fs.mkdirSync(vscode.userDirectory, { recursive: true })
    await service.saveConfig(claude, false, undefined, account)
    expect(loginPromptSetting(vscode.settingsPath)).toBe(true)
    expect(store.read().seededToolDefaults).toContain('vscode:login-prompt')

    // 客户自己删掉这一行：再保存一次、模板升了版本再开机，都不再补回来。
    fs.writeFileSync(vscode.settingsPath, '{\n    "editor.fontSize": 16\n}\n')
    await service.saveConfig(claude, false, undefined, account)
    const ownerDirectory = path.join(root, 'tool-config-ownership')
    const ownerFile = path.join(ownerDirectory, fs.readdirSync(ownerDirectory)[0])
    const record = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as Record<string, unknown>
    delete record.templateRevision
    fs.writeFileSync(ownerFile, JSON.stringify(record), 'utf8')
    await service.fillToolTemplateDefaultsThenSyncPickers(() => undefined)

    expect(loginPromptSetting(vscode.settingsPath)).toBeUndefined()
  })

  it('does not add the setting at startup for a Claude Code config the customer entered by hand', async () => {
    const { userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    await service.saveConfig(claude, false)
    const { vscode } = editors(userHome)
    fs.mkdirSync(vscode.userDirectory, { recursive: true })

    await service.fillToolTemplateDefaultsThenSyncPickers(() => undefined)

    expect(fs.existsSync(vscode.settingsPath)).toBe(false)
  })
})

describe('the reply-in-Chinese AGENTS.md Xingmang places for Codex', () => {
  const codex = { provider: 'codex' as const, apiKey: 'sk-fixture', model: 'gpt-fixture', mode: 'merge' as const }

  it('does not place it again after the customer deleted it', async () => {
    const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'gpt-fixture' }] }))
    const { root, store, service } = createService({ relayFetch })
    const agents = path.join(root, 'codex', 'AGENTS.md')

    await service.saveConfig(codex, false)
    expect(fs.existsSync(agents)).toBe(true)
    expect(store.read().seededToolDefaults).toContain('codex:response-language')

    fs.rmSync(agents)
    await service.saveConfig(codex, false)

    expect(fs.existsSync(agents)).toBe(false)
  })

  it('does not count an AGENTS.md the customer wrote as one Xingmang placed', async () => {
    const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'gpt-fixture' }] }))
    const { root, store, service } = createService({ relayFetch })
    const agents = path.join(root, 'codex', 'AGENTS.md')
    fs.mkdirSync(path.dirname(agents), { recursive: true })
    fs.writeFileSync(agents, '# 我自己的规矩\n', 'utf8')

    await service.saveConfig(codex, false)

    expect(fs.readFileSync(agents, 'utf8')).toBe('# 我自己的规矩\n')
    expect(store.read().seededToolDefaults ?? []).not.toContain('codex:response-language')
  })
})

// SH-10：以管理员身份运行时，从星芒打开的 Grok 拿的是 trustedCommandEnvironment 收窄过的 PATH，推 shell 也得照它推。
describe('the environment the Windows Grok shell is worked out from', () => {
  const storePwsh = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps'
  const env: NodeJS.ProcessEnv = {
    Path: `C:\\Windows\\System32;${storePwsh}`,
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  }
  const exists = (candidate: string) => candidate === `${storePwsh}\\pwsh.exe`
    || candidate === 'C:\\Program Files\\Git\\bin\\bash.exe'
  // Stands in for trustedCommandEnvironment on Windows: only machine directories survive in PATH.
  function machineOnly(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, Path: undefined, PATH: 'C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7' }
  }

  it('keeps the snapshot and appends the live PATH when the app runs as the same user', () => {
    const result = grokShellEnvironment('same-user', env, 'C:\\Tools', machineOnly)
    expect(result.PATH).toBe(`C:\\Windows\\System32;${storePwsh};C:\\Tools`)
    expect(resolveGrokWindowsShell(result, exists)).toBe('powershell')
  })

  it('works from the narrowed PATH the elevated Grok window gets, ignoring the live PATH', () => {
    const builder = vi.fn(machineOnly)
    const result = grokShellEnvironment('trusted-only', env, 'C:\\Tools', builder)
    expect(builder).toHaveBeenCalledWith(env)
    expect(result.PATH).toBe('C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7')
    // The Store pwsh is out of reach there, so Grok falls through to Git Bash, and so must the guess.
    expect(resolveGrokWindowsShell(result, exists)).toBe('bash')
  })
})

// Fable 第二轮 Q6：设置里「只让 Claude Code 改项目文件夹里的文件」。
describe('the Claude Code write boundary toggle', () => {
  const settingsOf = (userHome: string) => JSON.parse(fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8')) as { permissions?: Record<string, unknown> }
  const saveForAccount = (service: ReturnType<typeof createService>['service'], apiKey = 'sk-fixture') => service.saveConfig(
    { provider: 'claude', apiKey, model: 'claude-fixture', mode: 'merge' }, false, undefined, { source: 'account', automatic: false },
  )

  it('changes the account config in place after a backup and keeps the choice through later saves', async () => {
    const { store, userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    await saveForAccount(service)
    const backup = vi.fn()

    await expect(service.setClaudeWriteBoundary(true, backup)).resolves.toEqual({ enabled: true, applied: 'written' })
    expect(backup).toHaveBeenCalledTimes(1)
    expect(settingsOf(userHome).permissions?.blockWritesOutsideWorkingDirectories).toBe(true)
    expect(store.read().claudeWritesInsideProject).toBe(true)

    await saveForAccount(service, 'sk-fixture-2')
    expect(settingsOf(userHome).permissions?.blockWritesOutsideWorkingDirectories).toBe(true)

    await expect(service.setClaudeWriteBoundary(false, backup)).resolves.toEqual({ enabled: false, applied: 'written' })
    expect(settingsOf(userHome).permissions).not.toHaveProperty('blockWritesOutsideWorkingDirectories')
    expect(store.read().claudeWritesInsideProject).toBeUndefined()
  })

  it('only remembers the choice while Claude Code is not on the current account, and applies it at the next account save', async () => {
    let owner: string | null = null
    const { store, userHome, service } = createService({ getExternalClientAccountId: () => owner })
    const backup = vi.fn()

    await expect(service.setClaudeWriteBoundary(true, backup)).resolves.toEqual({ enabled: true, applied: 'later' })
    expect(backup).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(userHome, '.claude', 'settings.json'))).toBe(false)
    expect(store.read().claudeWritesInsideProject).toBe(true)

    owner = 'user-1'
    await saveForAccount(service)
    expect(settingsOf(userHome).permissions?.blockWritesOutsideWorkingDirectories).toBe(true)
  })

  it('changes neither the config nor the choice when the backup before the change fails', async () => {
    const { store, userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    await saveForAccount(service)
    const before = fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8')

    await expect(service.setClaudeWriteBoundary(true, () => { throw new Error('没能先备份 Claude Code 的配置，这次没有改') }))
      .rejects.toThrow('没能先备份 Claude Code 的配置，这次没有改')
    expect(fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8')).toBe(before)
    expect(store.read().claudeWritesInsideProject).toBeUndefined()
  })

  // 同类对比 备选 6：「不署名」走同一条路，记的是自己那个开关，两个开关互不影响。
  it('switches commit attribution the same way and keeps it apart from the write boundary', async () => {
    const { store, userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    await saveForAccount(service)
    const backup = vi.fn()

    await expect(service.setClaudeCommitAttribution(true, backup)).resolves.toEqual({ enabled: true, applied: 'written' })
    expect(backup).toHaveBeenCalledTimes(1)
    expect((settingsOf(userHome) as Record<string, unknown>).attribution).toEqual({ commit: '', pr: '' })
    expect(store.read().claudeHidesCommitAttribution).toBe(true)
    expect(store.read().claudeWritesInsideProject).toBeUndefined()
    expect(settingsOf(userHome).permissions).not.toHaveProperty('blockWritesOutsideWorkingDirectories')

    await saveForAccount(service, 'sk-fixture-2')
    expect((settingsOf(userHome) as Record<string, unknown>).attribution).toEqual({ commit: '', pr: '' })
    await expect(service.setClaudeCommitAttribution(false, backup)).resolves.toEqual({ enabled: false, applied: 'written' })
    expect(settingsOf(userHome)).not.toHaveProperty('attribution')
    expect(store.read().claudeHidesCommitAttribution).toBeUndefined()
  })

  it('leaves an official-account Claude Code alone', async () => {
    const { store, userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    await saveForAccount(service)
    await store.setOfficialProvider('claude', true)
    const before = fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8')

    await expect(service.setClaudeWriteBoundary(true)).resolves.toEqual({ enabled: true, applied: 'later' })
    expect(fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8')).toBe(before)
  })
})

// 11-18 客户：Codex 的 config.toml 被 PowerShell 5.1 按 GBK 读、按 UTF-8 写回，路径里吃掉一个反斜杠，Codex 和星芒
// 都读不了；Key 在 auth.json 里好好的。配置窗口里「保持当前」再点重置，以前读不出地址就报「属于其他账号」，一个字没写。
describe('resetting a config the tool cannot read while keeping the current key', () => {
  function codexService() {
    let owner: string | null = 'solov:7'
    const fixture = createService({ getExternalClientAccountId: () => owner })
    fixture.relayFetch.mockImplementation(async () => Response.json({ data: [{ id: 'gpt-fixture' }] }))
    const roots = { userHome: fixture.userHome, codexHome: path.join(fixture.root, 'codex') }
    return { ...fixture, roots, switchOwner: (next: string | null) => { owner = next } }
  }

  function breakCodexConfig(roots: { userHome: string; codexHome: string }): string {
    const configPath = providerConfigPaths('codex', roots)[0]
    // 跟客户那份一样：一个反斜杠被吃掉，"\." 是 TOML 不认的转义。
    const broken = 'notify_dir = "C:\\\\Users\\\\fixture\\.codex"\n' + fs.readFileSync(configPath, 'utf8')
    fs.writeFileSync(configPath, broken)
    expect(inspectProviderConfig('codex', roots)).toMatchObject({ configBroken: true, matchesRelay: false, hasApiKey: true, actualBaseUrl: '' })
    return broken
  }

  const keepCurrent = { provider: 'codex' as const, apiKey: '', model: 'gpt-fixture', mode: 'reset' as const }

  it('rebuilds the file with the key Xingmang last wrote for this account', async () => {
    const { roots, service } = codexService()
    await service.saveConfig({ provider: 'codex', apiKey: 'sk-current-fixture', model: 'gpt-fixture', mode: 'merge' }, false, undefined, {
      source: 'account', automatic: false,
    })
    breakCodexConfig(roots)

    await service.saveConfig(keepCurrent, false)

    const after = inspectProviderConfig('codex', roots)
    expect(after).toMatchObject({ matchesRelay: true, apiKey: 'sk-current-fixture', model: 'gpt-fixture' })
    expect(after.configBroken).toBeUndefined()
    // 来源照记录放回：重置完首页不会又说「来源未确认」。
    expect(service.buildConfigSummary(false).providers.codex.configurationOwnership).toBe('account')
  })

  it('still refuses, before any request, a key nothing on this computer ties to the current account', async () => {
    const { roots, relayFetch, dependencies, service } = codexService()
    saveProviderConfig('codex', 'sk-unrecorded-fixture', 'gpt-fixture', 'reset', roots, {}, providerBaseUrls)
    const broken = breakCodexConfig(roots)

    await expect(service.saveConfig(keepCurrent, false)).rejects.toThrow('已保存的密钥属于其他账号')

    expect(dependencies.holdsAccountKey).toHaveBeenCalledWith('codex', expect.objectContaining({ apiKey: 'sk-unrecorded-fixture' }))
    expect(relayFetch).not.toHaveBeenCalled()
    expect(fs.readFileSync(providerConfigPaths('codex', roots)[0], 'utf8')).toBe(broken)
  })

  it('does not take a record Xingmang wrote for another account as proof', async () => {
    const { roots, relayFetch, switchOwner, service } = codexService()
    await service.saveConfig({ provider: 'codex', apiKey: 'sk-first-account', model: 'gpt-fixture', mode: 'merge' }, false, undefined, {
      source: 'account', automatic: false,
    })
    breakCodexConfig(roots)
    relayFetch.mockClear()
    switchOwner('solov:8')

    await expect(service.saveConfig(keepCurrent, false)).rejects.toThrow('已保存的密钥属于其他账号')
    expect(relayFetch).not.toHaveBeenCalled()
  })

  it('keeps refusing a plain save, which has to edit the unreadable file in place', async () => {
    const { roots, relayFetch, service } = codexService()
    await service.saveConfig({ provider: 'codex', apiKey: 'sk-current-fixture', model: 'gpt-fixture', mode: 'merge' }, false, undefined, {
      source: 'account', automatic: false,
    })
    breakCodexConfig(roots)
    relayFetch.mockClear()

    await expect(service.saveConfig({ ...keepCurrent, mode: 'merge' }, false)).rejects.toThrow('已保存的密钥属于其他账号')
    expect(relayFetch).not.toHaveBeenCalled()
  })

  it('accepts the key the current account issued for this tool and leaves its source unconfirmed', async () => {
    const { roots, dependencies, service } = codexService()
    saveProviderConfig('codex', 'sk-cached-fixture', 'gpt-fixture', 'reset', roots, {}, providerBaseUrls)
    breakCodexConfig(roots)
    dependencies.holdsAccountKey.mockImplementation(async (_provider, current) => current.apiKey === 'sk-cached-fixture')

    await service.saveConfig(keepCurrent, false)

    expect(inspectProviderConfig('codex', roots)).toMatchObject({ matchesRelay: true, apiKey: 'sk-cached-fixture' })
    // 同读得懂的配置沿用这把时一样：没有记录就不替客户认来源，首页按缓存认出是当前账号。
    expect(service.buildConfigSummary(false).providers.codex.configurationOwnership).toBe('unknown')
  })

  it('does not ask the key cache while logged out', async () => {
    const { roots, relayFetch, dependencies, switchOwner, service } = codexService()
    saveProviderConfig('codex', 'sk-cached-fixture', 'gpt-fixture', 'reset', roots, {}, providerBaseUrls)
    breakCodexConfig(roots)
    switchOwner(null)
    dependencies.holdsAccountKey.mockResolvedValue(true)

    await expect(service.saveConfig(keepCurrent, false)).rejects.toThrow('已保存的密钥属于其他账号')
    expect(dependencies.holdsAccountKey).not.toHaveBeenCalled()
    expect(relayFetch).not.toHaveBeenCalled()
  })
})

describe('recovering who a broken config belonged to', () => {
  const broken = { configBroken: true, hasApiKey: true, actualBaseUrl: '', apiKey: 'sk-fixture' } as NativeConfigInspection
  const urls = ['https://primary.example/v1', 'https://direct.example/v1']

  it('tries every address of the site and takes only account or manual records', () => {
    const tried: string[] = []
    expect(recoverBrokenConfigOwnership(broken, urls, (config) => {
      tried.push(config.actualBaseUrl)
      return config.actualBaseUrl === urls[1] ? 'manual' : 'unknown'
    })).toBe('manual')
    expect(tried).toEqual(urls)
    expect(recoverBrokenConfigOwnership(broken, urls, () => 'changed')).toBeNull()
    expect(recoverBrokenConfigOwnership(broken, urls, () => 'unknown')).toBeNull()
    expect(recoverBrokenConfigOwnership(broken, [], () => 'account')).toBeNull()
  })

  it('never vouches for a config whose address is readable, that is not broken, or that has no key, with random inputs', () => {
    fc.assert(fc.property(
      fc.record({ configBroken: fc.option(fc.boolean(), { nil: undefined }), hasApiKey: fc.boolean(), actualBaseUrl: fc.string() }),
      fc.array(fc.string(), { maxLength: 4 }),
      (fields, siteUrls) => {
        fc.pre(fields.configBroken !== true || !fields.hasApiKey || fields.actualBaseUrl !== '')
        return recoverBrokenConfigOwnership({ ...broken, ...fields }, siteUrls, () => 'account') === null
      },
    ))
  })
})

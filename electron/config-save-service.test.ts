import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createConfigSaveService } from './config-save-service'
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
    managedKeyFollowTarget: vi.fn(async () => ({ owner: 'user-1', keys: [], cachedKeys: [] })),
    scanExternalClients: vi.fn(async () => []),
    accountRouteFollowed: new Map(),
    accountRouteFaultFollowed: vi.fn(() => false),
    writeToolRouteRecord: vi.fn(async () => undefined),
    toolRouteSummaryFields: vi.fn(() => ({})),
    restoreOfficialCredentialsNow: vi.fn(() => false),
    moveOfficialCredentialsAside: vi.fn(() => false),
    withCredentialUndo: vi.fn((error: unknown) => error),
    applyXingmangAiSkillForCodexAccount: vi.fn(async () => undefined),
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
    await vi.waitFor(() => expect(dependencies.scanExternalClients).toHaveBeenCalledTimes(1))
    expect(dependencies.managedKeyFollowTarget).toHaveBeenCalledTimes(1)
  })

  it('refuses a model the key cannot use before touching the official key', async () => {
    const { dependencies, service } = createService()

    await expect(service.saveConfig({ provider: 'claude', apiKey: 'sk-fixture', model: 'claude-missing', mode: 'merge' }, false))
      .rejects.toThrow('当前 API Key 不支持模型 claude-missing')
    expect(dependencies.moveOfficialCredentialsAside).not.toHaveBeenCalled()
    expect(dependencies.managedKeyFollowTarget).not.toHaveBeenCalled()
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

  it('does not add the setting at startup for a Claude Code config the customer entered by hand', async () => {
    const { userHome, service } = createService({ getExternalClientAccountId: () => 'user-1' })
    await service.saveConfig(claude, false)
    const { vscode } = editors(userHome)
    fs.mkdirSync(vscode.userDirectory, { recursive: true })

    await service.fillToolTemplateDefaultsThenSyncPickers(() => undefined)

    expect(fs.existsSync(vscode.settingsPath)).toBe(false)
  })
})

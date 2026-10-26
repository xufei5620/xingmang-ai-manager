import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createConfigSaveService } from './config-save-service'
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
  }
  return { store, userHome, relayFetch, dependencies, service: createConfigSaveService(context, dependencies) }
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
      .rejects.toThrow('当前 API Key 不支持模型 claude-missing')
    expect(dependencies.moveOfficialCredentialsAside).not.toHaveBeenCalled()
    expect(dependencies.followManagedKeysNow).not.toHaveBeenCalled()
  })

  it('checks the Codex model catalog at startup only once and not at all without a bundled catalog', async () => {
    const { dependencies, service } = createService()

    const first = service.guardCodexModelCatalogAtStartup()
    expect(service.guardCodexModelCatalogAtStartup()).toBe(first)
    await first
    expect(dependencies.inspectCliTool).not.toHaveBeenCalled()
  })
})

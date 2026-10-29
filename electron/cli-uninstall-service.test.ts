import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createCliUninstallService, type CliUninstallServiceDependencies } from './cli-uninstall-service'
import { createServiceContext } from './system-service-context'
import type { SystemServiceOptions } from './system-service'

// #1070 第 3 步把卸载那一段搬成了 createCliUninstallService。卸的全过程仍由 system-service 的测试经
// createSystemService 覆盖；这里钉住搬家新接上的那几处：传进来的读工具状态、装着的时候不让卸、
// 卸 Codex 后让型号名单那边重新找它、没记下残留时「帮我清理」什么都不动，以及手机遥控还在用 Codex 时不卸。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function createService(dependencies: Partial<CliUninstallServiceDependencies> = {}, options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-uninstall-service-'))
  temporaryDirectories.push(root)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'linux',
    windowsExecutionMode: 'same-user',
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    findExecutable: async () => null,
    ...options,
  })
  const forgetCodexModelCatalogReaders = vi.fn()
  const service = createCliUninstallService(context, {
    inspectCliTool: async () => ({
      status: { installed: false, version: null, path: null, installDirectory: null },
      installation: null,
    }),
    invalidateCliUpdateCache: () => undefined,
    forgetCodexModelCatalogReaders,
    ...dependencies,
  })
  return { context, service, forgetCodexModelCatalogReaders }
}

describe('cli uninstall service', () => {
  it('answers not installed when the injected tool probe finds no copy', async () => {
    const inspectCliTool = vi.fn(async () => ({
      status: { installed: false, version: null, path: null, installDirectory: null },
      installation: null,
    }))
    const { service } = createService({ inspectCliTool })

    await expect(service.uninstallCli('claude')).resolves.toEqual({ outcome: 'not-installed', previousVersion: null })
    expect(inspectCliTool).toHaveBeenCalledWith('claude', null, null)
  })

  it('will not uninstall a tool that is being installed', async () => {
    const { context, service } = createService()
    context.installing.add('grok')

    await expect(service.uninstallCli('grok')).rejects.toThrow('Grok CLI 正在安装、更新或卸载中')
  })

  it('lets the model catalog look for Codex again once its uninstall settles', async () => {
    const { service, forgetCodexModelCatalogReaders } = createService()

    await service.uninstallCli('codex')
    await Promise.resolve()
    expect(forgetCodexModelCatalogReaders).toHaveBeenCalledTimes(1)
  })

  // #1407 P3-3：Windows 上手机遥控开着的那份 Codex 锁着包目录，正在干活时不卸、原句告诉客户，什么都没动。
  it('leaves Codex installed when the remote control is still using it', async () => {
    const busy = '手机遥控里的 Codex 正在干活，等它做完再卸载，或者先在设置里关掉手机遥控。'
    const releaseCodexRemote = vi.fn(async () => { throw new Error(busy) })
    const packageRoot = path.join(os.tmpdir(), 'npm', 'node_modules', '@openai', 'codex')
    const inspectCliTool = vi.fn(async () => ({
      status: { installed: true, version: '0.164.0', path: path.join(os.tmpdir(), 'npm', 'codex.cmd'), installDirectory: packageRoot },
      installation: { commandPath: path.join(os.tmpdir(), 'npm', 'codex.cmd'), installDirectory: packageRoot, packageRoot, npmPrefix: path.join(os.tmpdir(), 'npm'), source: 'npm' as const },
    }))
    const { context, service } = createService({ inspectCliTool }, { platform: 'win32', releaseCodexRemote })

    await expect(service.uninstallCli('codex')).rejects.toThrow(busy)
    expect(releaseCodexRemote).toHaveBeenCalledWith('uninstall')
    // 只查过一次装没装，没往下走到 npm 那一步。
    expect(inspectCliTool).toHaveBeenCalledTimes(1)
    expect(context.installing.has('codex')).toBe(false)
  })

  it('cleans nothing when the last uninstall left nothing on record', async () => {
    const { service } = createService()

    await expect(service.cleanUninstallLeftovers('claude')).resolves.toEqual({ remaining: 0 })
  })
})

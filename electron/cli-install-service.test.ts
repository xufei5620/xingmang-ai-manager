import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createCliInstallService, type CliInstallServiceDependencies } from './cli-install-service'
import type { RendererMessageTarget, ToolStatus } from './system-service'
import { createServiceContext } from './system-service-context'

// #1070 第 2 步把装命令行工具那一整段搬成了 createCliInstallService。装的全过程仍由 system-service 的测试经
// createSystemService 覆盖；这里钉住搬家新接上的那几处：传进来的 inspectCliTool 真的被用来挡住官方安装器
// 管的那份，同一个工具排队时换版本照旧被拒，没在装时取消照旧说没在装。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function nativeClaude(): { status: ToolStatus; installation: null } {
  return {
    status: { installed: true, version: '2.1.277', path: '/opt/claude/bin/claude', installDirectory: '/opt/claude', installSource: 'native' },
    installation: null,
  }
}

function createService(dependencies: Partial<CliInstallServiceDependencies> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-install-service-'))
  temporaryDirectories.push(root)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'linux',
    windowsExecutionMode: 'same-user',
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    findExecutable: async () => null,
  })
  const takeBackUnreadableCodexModelCatalog = vi.fn(async () => undefined)
  const service = createCliInstallService(context, {
    inspectNetworkRegion: async () => 'unknown',
    withToolCertificateHint: async (message) => message,
    inspectCliTool: async () => nativeClaude(),
    invalidateCliUpdateCache: () => undefined,
    installGitRuntime: async () => {
      throw new Error('should not install Git on Linux')
    },
    takeBackUnreadableCodexModelCatalog,
    ...dependencies,
  })
  return { service, takeBackUnreadableCodexModelCatalog }
}

function rendererTarget() {
  const sent: unknown[] = []
  const target: RendererMessageTarget = { isDestroyed: () => false, send: (_channel, payload) => sent.push(payload) }
  return { target, sent }
}

describe('cli install service', () => {
  it('refuses to install over a copy the official installer manages, as told by the injected tool probe', async () => {
    const inspectCliTool = vi.fn(async () => nativeClaude())
    const { service } = createService({ inspectCliTool })

    await expect(service.installCli('claude', rendererTarget().target)).rejects.toThrow('由官方安装器管理')
    expect(inspectCliTool).toHaveBeenCalledWith('claude', null, null)
  })

  it('still refuses a different version of a tool whose install is already queued', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const { service } = createService({
      inspectCliTool: async () => {
        await held
        return nativeClaude()
      },
    })
    const { target } = rendererTarget()

    const first = service.installCli('claude', target)
    await expect(service.installCli('claude', target, '2.1.200')).rejects.toThrow('Claude Code 正在安装中')
    release()
    await expect(first).rejects.toThrow('由官方安装器管理')
  })

  it('says nothing is being installed when there is nothing to cancel', () => {
    const { service } = createService()

    expect(service.cancelCliInstall('codex')).toMatchObject({ cancelled: false })
  })
})

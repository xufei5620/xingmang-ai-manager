import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createRuntimeInstallService } from './runtime-install-service'
import type { RendererMessageTarget, SystemServiceOptions, ToolStatus } from './system-service'
import { createServiceContext } from './system-service-context'

// #1070 第 3 步把装运行环境那一段搬成了 createRuntimeInstallService。装的全过程仍由 system-service 的测试经
// createSystemService 覆盖；这里钉住搬家新接上的那几处：重启电脑只在 Windows 上、有任务在跑时不重启，
// 「正在装 Node.js」的标记和装命令行工具那边共用上下文里的同一个，处理器一次启动只问一次。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const absent: ToolStatus = { installed: false, version: null, path: null, installDirectory: null }
const target: RendererMessageTarget = { isDestroyed: () => false, send: () => undefined }

function createService(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-runtime-install-service-'))
  temporaryDirectories.push(root)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'win32',
    windowsExecutionMode: 'same-user',
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    findExecutable: async () => null,
    ...options,
  })
  const service = createRuntimeInstallService(context, {
    inspectNetworkRegion: async () => 'unknown',
    inspectTool: async () => absent,
    inspectNode: async () => absent,
    inspectPython: async () => absent,
    inspectGit: async () => absent,
    refreshGrokHooksForShellChange: async () => undefined,
    addMissingGrokHooks: async () => false,
  })
  return { context, service }
}

describe('runtime install service', () => {
  it('only restarts the computer on Windows', async () => {
    const { service } = createService({ platform: 'darwin' })

    await expect(service.restartWindows()).rejects.toThrow('系统重启仅支持 Windows')
  })

  it('does not restart while an install is still in the queue', async () => {
    const executeCommand = vi.fn()
    const { context, service } = createService({ runCommand: executeCommand })
    let release!: () => void
    const held = context.installationQueue.enqueue('cli:install:claude', () => new Promise<void>((resolve) => { release = resolve }))

    await expect(service.restartWindows()).rejects.toThrow('还有安装、卸载或打开工具的任务在进行')
    expect(executeCommand).not.toHaveBeenCalled()
    release()
    await held
  })

  it('shares the Node.js install flag with the CLI install path', async () => {
    const { context, service } = createService()
    context.nodeRuntimeInstall.running = true

    await expect(service.installNodeRuntime(target)).rejects.toThrow('Node.js 正在安装中')
  })

  it('asks for the Windows processor once per run and remembers a failed answer as unknown', async () => {
    const inspectWindowsProcessor = vi.fn(async () => {
      throw new Error('reg.exe failed')
    })
    const { service } = createService({ inspectWindowsProcessor })

    await expect(service.inspectWindowsProcessor()).resolves.toBeNull()
    await expect(service.inspectWindowsProcessor()).resolves.toBeNull()
    expect(inspectWindowsProcessor).toHaveBeenCalledTimes(1)
  })
})

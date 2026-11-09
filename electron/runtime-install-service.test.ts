import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { linuxNodeRuntimeVersion } from './linux-node-runtime'
import { darwinNodeRuntimeVersion } from './macos-node-runtime'
import { managedNodeRuntimeBinDirectory } from './managed-cli-paths'
import type { NodeRuntimeInstallResult } from './node-runtime'
import {
  createRuntimeInstallService,
  managedNodeRuntimePinnedVersion,
  shouldRefreshManagedNodeRuntime,
  type RuntimeInstallServiceDependencies,
} from './runtime-install-service'
import type { RendererMessageTarget, SystemServiceOptions, ToolStatus } from './system-service'
import { createServiceContext, type ServiceContext } from './system-service-context'

// #1070 第 3 步把装运行环境那一段搬成了 createRuntimeInstallService。装的全过程仍由 system-service 的测试经
// createSystemService 覆盖；这里钉住搬家新接上的那几处：重启电脑只在 Windows 上、有任务在跑时不重启，
// 「正在装 Node.js」的标记和装命令行工具那边共用上下文里的同一个，处理器一次启动只问一次。

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const absent: ToolStatus = { installed: false, version: null, path: null, installDirectory: null }
const target: RendererMessageTarget = { isDestroyed: () => false, send: () => undefined }

function createService(
  options: SystemServiceOptions = {},
  dependencies: Partial<RuntimeInstallServiceDependencies> = {},
  beforeService?: (context: ServiceContext) => void,
) {
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
  // 服务一建好就把上下文里的函数拆走了，要盯它们得在这之前装上。
  beforeService?.(context)
  const service = createRuntimeInstallService(context, {
    inspectNetworkRegion: async () => 'unknown',
    inspectTool: async () => absent,
    inspectNode: async () => absent,
    inspectPython: async () => absent,
    inspectGit: async () => absent,
    refreshGrokHooksForShellChange: async () => undefined,
    addMissingGrokHooks: async () => false,
    ...dependencies,
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

describe('refreshing an outdated managed Node.js before a CLI install (D86)', () => {
  const refreshed: NodeRuntimeInstallResult = {
    installed: true,
    action: 'installed',
    method: 'archive',
    source: 'official',
    version: linuxNodeRuntimeVersion,
    architecture: 'x64',
    pathRefreshRequired: false,
    systemRestartRequired: false,
  }

  /** HOME（Linux 上还有 XDG_DATA_HOME）指到临时目录，返回代装那份 node 的位置；present 时放一个假的进去。 */
  function managedNodeAt(platform: 'darwin' | 'linux', present: boolean): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-node-refresh-home-'))
    temporaryDirectories.push(home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('XDG_DATA_HOME', path.join(home, 'data'))
    const directory = managedNodeRuntimeBinDirectory(process.env, platform)
    const node = path.posix.join(directory, 'node')
    if (present) {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 })
    }
    return node
  }

  function nodeStatus(nodePath: string, version: string | null): ToolStatus {
    return { installed: true, version, path: nodePath, installDirectory: path.posix.dirname(nodePath) }
  }

  it('pins the same release the Mac and Linux installers download and nothing on Windows', () => {
    expect(managedNodeRuntimePinnedVersion('darwin')).toBe(darwinNodeRuntimeVersion)
    expect(managedNodeRuntimePinnedVersion('linux')).toBe(linuxNodeRuntimeVersion)
    expect(managedNodeRuntimePinnedVersion('win32')).toBeNull()
  })

  it('refreshes only the managed copy in use when it is older than the pin', () => {
    const managedNode = '/Users/peaker/Library/Application Support/XingMangAI/Runtime/node/bin/node'
    const pinnedVersion = 'v24.22.1'
    const decide = (node: Pick<ToolStatus, 'installed' | 'path' | 'version'>) => shouldRefreshManagedNodeRuntime({ managedNode, node, pinnedVersion })

    expect(decide({ installed: true, path: managedNode, version: 'v24.11.0' })).toBe(true)
    expect(decide({ installed: true, path: managedNode, version: 'v22.20.0' })).toBe(true)
    // 同一个文件换个写法也认得出来。
    expect(decide({ installed: true, path: managedNode.replace('/bin/node', '/bin/../bin/node'), version: 'v24.22.0' })).toBe(true)
    // 客户自己装的那份不碰，哪怕它更旧。
    expect(decide({ installed: true, path: '/usr/local/bin/node', version: 'v20.1.0' })).toBe(false)
    // 已经是钉的那版、比钉的还新（退回了旧版星芒）都不动。
    expect(decide({ installed: true, path: managedNode, version: 'v24.22.1' })).toBe(false)
    expect(decide({ installed: true, path: managedNode, version: 'v26.1.0' })).toBe(false)
    // 报不出版本、没找到 node 的，交给首页检测和「准备 Node.js」那一路。
    expect(decide({ installed: true, path: managedNode, version: null })).toBe(false)
    expect(decide({ installed: false, path: null, version: null })).toBe(false)
  })

  it('downloads the pinned release over an outdated managed copy on Linux and forgets what it knew about node', async () => {
    const managedNode = managedNodeAt('linux', true)
    const installNodeRuntime = vi.fn(async () => refreshed)
    const inspectTool = vi.fn(async () => nodeStatus(managedNode, 'v24.11.0'))
    const runtimeLog = { log: vi.fn() }
    const spies: { forgetPreferred?: ReturnType<typeof vi.fn>; forgetRoots?: ReturnType<typeof vi.fn> } = {}
    const { context, service } = createService({ platform: 'linux', installNodeRuntime, runtimeLog }, { inspectTool }, (shared) => {
      spies.forgetPreferred = vi.spyOn(shared, 'forgetPreferredNodeDirectories')
      spies.forgetRoots = vi.spyOn(shared, 'forgetNpmGlobalRoots')
    })
    const controller = new AbortController()

    await service.refreshOutdatedManagedNodeRuntime(controller.signal)

    expect(inspectTool).toHaveBeenCalledWith('node')
    expect(installNodeRuntime).toHaveBeenCalledTimes(1)
    expect(installNodeRuntime).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
    // 静默：不往界面发进度。
    expect(installNodeRuntime).toHaveBeenCalledWith(expect.not.objectContaining({ onProgress: expect.anything() }))
    expect(context.nodeRuntimeInstall.running).toBe(false)
    expect(runtimeLog.log).toHaveBeenCalledWith('info', 'install', 'node.refresh.done', expect.any(String), { version: linuxNodeRuntimeVersion })
    // 换了 node 和 npm：Mac 上用哪份、npm 的全局目录，下次都重新问。
    expect(spies.forgetPreferred).toHaveBeenCalledTimes(1)
    expect(spies.forgetRoots).toHaveBeenCalledTimes(1)
  })

  it('looks at nothing but the file when there is no managed copy', async () => {
    managedNodeAt('linux', false)
    const installNodeRuntime = vi.fn(async () => refreshed)
    const inspectTool = vi.fn(async () => nodeStatus('/usr/bin/node', 'v18.19.1'))
    const { service } = createService({ platform: 'linux', installNodeRuntime }, { inspectTool })

    await service.refreshOutdatedManagedNodeRuntime()

    expect(inspectTool).not.toHaveBeenCalled()
    expect(installNodeRuntime).not.toHaveBeenCalled()
  })

  it('leaves the managed copy alone on a Mac whose own Node.js is found first', async () => {
    managedNodeAt('darwin', true)
    const installNodeRuntime = vi.fn(async () => refreshed)
    const inspectTool = vi.fn(async () => nodeStatus('/opt/homebrew/bin/node', 'v24.1.0'))
    const { service } = createService({ platform: 'darwin', installNodeRuntime }, { inspectTool })

    await service.refreshOutdatedManagedNodeRuntime()

    expect(inspectTool).toHaveBeenCalledWith('node')
    expect(installNodeRuntime).not.toHaveBeenCalled()
  })

  it('refreshes the managed copy on a Mac when it is the one in use', async () => {
    const managedNode = managedNodeAt('darwin', true)
    const installNodeRuntime = vi.fn(async () => ({ ...refreshed, version: darwinNodeRuntimeVersion, architecture: 'arm64' as const }))
    const { service } = createService({ platform: 'darwin', installNodeRuntime }, { inspectTool: async () => nodeStatus(managedNode, 'v24.11.0') })

    await service.refreshOutdatedManagedNodeRuntime()

    expect(installNodeRuntime).toHaveBeenCalledTimes(1)
  })

  it('never refreshes on Windows', async () => {
    const installNodeRuntime = vi.fn(async () => refreshed)
    const inspectTool = vi.fn(async () => nodeStatus('C:\\Program Files\\nodejs\\node.exe', 'v20.1.0'))
    const { service } = createService({ platform: 'win32', installNodeRuntime }, { inspectTool })

    await service.refreshOutdatedManagedNodeRuntime()

    expect(inspectTool).not.toHaveBeenCalled()
    expect(installNodeRuntime).not.toHaveBeenCalled()
  })

  it('keeps the CLI install going on the old copy when the download fails', async () => {
    const managedNode = managedNodeAt('linux', true)
    const installNodeRuntime = vi.fn(async (): Promise<NodeRuntimeInstallResult> => {
      throw new Error(`Node.js 没有下载成功（${managedNode}：ETIMEDOUT）`)
    })
    const runtimeLog = { log: vi.fn() }
    const spies: { forgetRoots?: ReturnType<typeof vi.fn> } = {}
    const home = process.env.HOME ?? ''
    const { context, service } = createService(
      { platform: 'linux', installNodeRuntime, runtimeLog, providerRoots: { userHome: home, codexHome: path.join(home, '.codex') } },
      { inspectTool: async () => nodeStatus(managedNode, 'v24.11.0') },
      (shared) => { spies.forgetRoots = vi.spyOn(shared, 'forgetNpmGlobalRoots') },
    )

    await expect(service.refreshOutdatedManagedNodeRuntime()).resolves.toBeUndefined()

    expect(context.nodeRuntimeInstall.running).toBe(false)
    const failure = runtimeLog.log.mock.calls.find((call) => call[2] === 'node.refresh.failed')
    expect(failure?.[0]).toBe('warn')
    expect(JSON.stringify(failure)).toContain('ETIMEDOUT')
    // 日志里的原因遮掉用户目录那段。
    expect(JSON.stringify(failure)).not.toContain(home)
    // 换到一半失败也可能已经动过 npm。
    expect(spies.forgetRoots).toHaveBeenCalledTimes(1)
  })

  it('does not report a cancelled CLI install as a failed refresh', async () => {
    const managedNode = managedNodeAt('linux', true)
    const controller = new AbortController()
    const installNodeRuntime = vi.fn(async (): Promise<NodeRuntimeInstallResult> => {
      controller.abort(new Error('Claude Code 安装已取消'))
      throw new Error('操作已取消')
    })
    const runtimeLog = { log: vi.fn() }
    const { service } = createService(
      { platform: 'linux', installNodeRuntime, runtimeLog },
      { inspectTool: async () => nodeStatus(managedNode, 'v24.11.0') },
    )

    await expect(service.refreshOutdatedManagedNodeRuntime(controller.signal)).resolves.toBeUndefined()

    const events = runtimeLog.log.mock.calls.map((call) => call[2])
    expect(events).toContain('node.refresh.cancelled')
    expect(events).not.toContain('node.refresh.failed')
  })

  it('yields to a Node.js install that is already running', async () => {
    const managedNode = managedNodeAt('linux', true)
    const installNodeRuntime = vi.fn(async () => refreshed)
    const { context, service } = createService(
      { platform: 'linux', installNodeRuntime },
      { inspectTool: async () => nodeStatus(managedNode, 'v24.11.0') },
    )
    context.nodeRuntimeInstall.running = true

    await service.refreshOutdatedManagedNodeRuntime()

    expect(installNodeRuntime).not.toHaveBeenCalled()
    expect(context.nodeRuntimeInstall.running).toBe(true)
  })
})

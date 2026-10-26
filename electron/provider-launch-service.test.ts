import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createProviderLaunchService } from './provider-launch-service'
import type { DesktopAppStatus, SystemServiceOptions, ToolStatus } from './system-service'
import { createServiceContext } from './system-service-context'

// #1070 第 3 步把打开工具那一段搬成了 createProviderLaunchService。真正开终端的各条路仍由 system-service 的测试经
// createSystemService 覆盖；这里钉住搬家新接上的那几处：打开前记下「从星芒打开过」、清掉「需重开生效」（这两份
// 记录现在在上下文里，线路跟随那边读同一份）、打开 Grok 前先修钩子，以及照旧排进安装队列。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const absent: ToolStatus = { installed: false, version: null, path: null, installDirectory: null }
const desktopMissing: DesktopAppStatus = {
  ...absent,
  appVersion: null,
  mirrorVersion: null,
  mirrorUpdateAvailable: null,
  mirrorError: null,
  running: false,
}

function createService(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-provider-launch-service-'))
  temporaryDirectories.push(root)
  const workspace = path.join(root, 'project')
  fs.mkdirSync(workspace)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'linux',
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    findExecutable: async () => null,
    ...options,
  })
  const inspectCliTool = vi.fn(async () => ({ status: absent, installation: null }))
  const repairGrokHooksBeforeLaunch = vi.fn(async () => undefined)
  const service = createProviderLaunchService(context, {
    providerEnvironment: () => ({}),
    inspectCodexDesktop: async () => desktopMissing,
    launchCodexDesktopOperation: vi.fn(),
    inspectCliTool,
    rememberedWorkspaceFor: () => null,
    repairGrokHooksBeforeLaunch,
  })
  return { context, service, workspace, root, inspectCliTool, repairGrokHooksBeforeLaunch }
}

describe('provider launch service', () => {
  it('refuses a workspace that is gone before touching anything', async () => {
    const { context, service, root, inspectCliTool } = createService()

    await expect(service.launchProvider('claude', path.join(root, 'missing'))).rejects.toThrow('工作目录不存在，请重新选择')
    expect(context.toolLaunchedAt.has('claude')).toBe(false)
    expect(inspectCliTool).not.toHaveBeenCalled()
  })

  it('records the launch in the shared records and repairs the Grok hooks first', async () => {
    const { context, service, workspace, repairGrokHooksBeforeLaunch } = createService()
    context.toolRouteRestartPending.add('grok')

    await expect(service.launchProvider('grok', workspace)).rejects.toThrow('请先安装')
    expect(context.toolLaunchedAt.has('grok')).toBe(true)
    expect(context.toolRouteRestartPending.has('grok')).toBe(false)
    expect(repairGrokHooksBeforeLaunch).toHaveBeenCalledTimes(1)
  })

  it('does not repair hooks for tools other than Grok', async () => {
    const { service, workspace, repairGrokHooksBeforeLaunch } = createService()

    await expect(service.launchProvider('claude', workspace)).rejects.toThrow('请先安装')
    expect(repairGrokHooksBeforeLaunch).not.toHaveBeenCalled()
  })

  it('opens a tool once when the same launch is asked for twice', async () => {
    const { service, workspace, inspectCliTool } = createService()

    const first = service.launchProvider('codex', workspace)
    const second = service.launchProvider('codex', workspace)

    await expect(first).rejects.toThrow('请先安装')
    await expect(second).rejects.toThrow('请先安装')
    expect(inspectCliTool).toHaveBeenCalledTimes(1)
  })
})

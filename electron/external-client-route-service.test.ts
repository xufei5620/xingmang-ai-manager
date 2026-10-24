import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import type { ClaudeDesktopLaunchContext } from './claude-desktop-acceleration'
import { createExternalClientRouteService } from './external-client-route-service'
import type { SystemServiceOptions } from './system-service'
import { createServiceContext } from './system-service-context'

// #1070 第 3 步把三个外部桌面客户端那一段搬成了 createExternalClientRouteService，原来手抄三份的排队收成了
// queueExternalConfigWork。写配置、换线路的全过程仍由 external-client-service.test.ts 经 createSystemService
// 覆盖；这里钉住收拢后的排队：一件一件来，前一件失败不挡后一件，各自拿到自己的结果。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function createService(fetchAvailableModels: (apiKey: string) => Promise<string[]>, options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-external-client-route-service-'))
  temporaryDirectories.push(root)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const runtime: NonNullable<SystemServiceOptions['externalClientRuntime']> = {
    scan: vi.fn(async () => []),
    install: vi.fn(),
    cancelInstall: vi.fn(() => ({ cancelled: false, reason: '这个工具当前没有正在进行的安装。' })),
    launch: vi.fn(async () => undefined),
    stillRunning: vi.fn(async () => null),
  }
  const context = createServiceContext(store, {
    platform: 'linux',
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    externalClientRuntime: runtime,
    ...options,
  })
  return { runtime, service: createExternalClientRouteService(context, { fetchAvailableModels }) }
}

describe('external client route service', () => {
  it('runs config writes one at a time and lets the next one run after a failure', async () => {
    let releaseModels!: (models: string[]) => void
    const fetchAvailableModels = vi.fn(() => new Promise<string[]>((resolve) => { releaseModels = resolve }))
    const { service } = createService(fetchAvailableModels)
    const settled: string[] = []

    const first = service.configureExternalTool('opencode', { apiKey: 'sk-first', model: 'gpt-fixture' })
      .catch((error: unknown) => { settled.push(`first:${(error as Error).message}`) })
    const second = service.configureExternalTool('workbuddy', { apiKey: 'sk-second', model: '' })
      .catch((error: unknown) => { settled.push(`second:${(error as Error).message}`) })
    await vi.waitFor(() => expect(fetchAvailableModels).toHaveBeenCalledTimes(1))
    expect(settled).toEqual([])

    releaseModels([])
    await Promise.all([first, second])

    expect(settled).toEqual(['first:当前密钥不支持所选模型，请重新检测', 'second:请选择有效模型'])
    expect(fetchAvailableModels).toHaveBeenCalledTimes(1)
  })

  it('hands launching and cancelling a client to the runtime', async () => {
    const { runtime, service } = createService(async () => [])

    await service.launchExternalClient('claudeDesktop')
    expect(service.cancelExternalClientInstall('opencode')).toEqual({ cancelled: false, reason: '这个工具当前没有正在进行的安装。' })

    expect(runtime.launch).toHaveBeenCalledWith('claudeDesktop')
    expect(runtime.cancelInstall).toHaveBeenCalledWith('opencode')
  })

  // #1373: Claude Desktop downloads its components from the official site on first
  // use, so the line has to be up before it starts.
  it('connects acceleration before launching Claude Desktop, and only for Claude Desktop', async () => {
    const order: string[] = []
    const prepareClaudeDesktopLaunch = vi.fn(async (_context: ClaudeDesktopLaunchContext) => { order.push('prepare') })
    const { runtime, service } = createService(async () => [], { prepareClaudeDesktopLaunch })
    vi.mocked(runtime.launch).mockImplementation(async () => { order.push('launch') })

    await service.launchExternalClient('claudeDesktop')
    await service.launchExternalClient('opencode')

    expect(order).toEqual(['prepare', 'launch', 'launch'])
    expect(prepareClaudeDesktopLaunch).toHaveBeenCalledOnce()
    // This runtime never says where it found the client, so whether it runs cannot be told yet.
    await expect(prepareClaudeDesktopLaunch.mock.calls[0][0].isDesktopRunning()).resolves.toBeNull()
  })

  it('still opens Claude Desktop when acceleration fails, and counts it gone after a launch that failed', async () => {
    const prepareClaudeDesktopLaunch = vi.fn(async (_context: ClaudeDesktopLaunchContext) => { throw new Error('helper down') })
    const { runtime, service } = createService(async () => [], { prepareClaudeDesktopLaunch })

    await service.launchExternalClient('claudeDesktop')
    expect(runtime.launch).toHaveBeenCalledWith('claudeDesktop')

    vi.mocked(runtime.launch).mockRejectedValueOnce(new Error('尚未检测到客户端，请先安装并重新检测'))
    await expect(service.launchExternalClient('claudeDesktop')).rejects.toThrow('尚未检测到客户端')
    await expect(prepareClaudeDesktopLaunch.mock.calls[1][0].isDesktopRunning()).resolves.toBe(false)
    expect(runtime.stillRunning).not.toHaveBeenCalled()
  })
})

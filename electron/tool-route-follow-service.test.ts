import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import type { SystemServiceOptions } from './system-service'
import { createServiceContext } from './system-service-context'
import { createToolRouteFollowService } from './tool-route-follow-service'

// #1070 第 3 步把换线路定点改写工具配置那一段搬成了 createToolRouteFollowService。改写、重试、回头核对的全过程
// 仍由 system-service-tool-route.test.ts 经 createSystemService 覆盖；这里钉住搬家新接上的那几处：没有账号归属时
// 一个都不碰，退出时连外部客户端那边的定时一起撤。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function createService(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-tool-route-follow-service-'))
  temporaryDirectories.push(root)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'linux',
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    ...options,
  })
  const cancelPendingExternalRouteRecheck = vi.fn()
  const inspectRunningTools = vi.fn(async () => ({ running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false }))
  const service = createToolRouteFollowService(context, { inspectRunningTools, cancelPendingExternalRouteRecheck })
  return { service, cancelPendingExternalRouteRecheck }
}

describe('tool route follow service', () => {
  it('leaves every tool alone while no account owns the configs', async () => {
    const inspectProviderConfig = vi.fn()
    const { service } = createService({ getExternalClientAccountId: () => null, inspectProviderConfig })

    await expect(service.followToolRoutes({ reason: 'route-changed' })).resolves.toEqual({ rewritten: [] })
    expect(inspectProviderConfig).not.toHaveBeenCalled()
  })

  it('also stops the external client check-back when it is disposed', () => {
    const { service, cancelPendingExternalRouteRecheck } = createService()

    service.disposeToolRoutes()
    service.disposeToolRoutes()

    expect(cancelPendingExternalRouteRecheck).toHaveBeenCalledTimes(2)
  })
})

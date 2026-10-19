import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createSystemScanService } from './system-scan-service'
import type { DesktopAppStatus, SystemServiceOptions } from './system-service'
import { createServiceContext } from './system-service-context'

// #1070 第 3 步把首页检测那一段搬成了 createSystemScanService。整轮检测仍由 system-service 的测试经
// createSystemService 覆盖；这里钉住搬家新接上的那几处：镜像策略钉死时不去探网络、网络位置只探一次，
// Codex 首次设置检查用的是传进来的那个桌面端探测。

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const desktopMissing: DesktopAppStatus = {
  installed: false,
  version: null,
  path: null,
  installDirectory: null,
  appVersion: null,
  mirrorVersion: null,
  mirrorUpdateAvailable: null,
  mirrorError: null,
  running: false,
}

function createService(options: SystemServiceOptions = {}, inspectCodexDesktop = vi.fn(async () => desktopMissing)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-system-scan-service-'))
  temporaryDirectories.push(root)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const context = createServiceContext(store, {
    platform: 'linux',
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    findExecutable: async () => null,
    ...options,
  })
  const service = createSystemScanService(context, {
    providerEnvironment: () => ({}),
    inspectCodexDesktop,
    inspectCodexDesktopUpdate: async () => desktopMissing,
  })
  return { store, service, inspectCodexDesktop }
}

function traceFetch(body: string) {
  return vi.fn(async () => new Response(body, { status: 200 }))
}

describe('system scan service', () => {
  it('takes the region from a pinned mirror policy without probing the network', async () => {
    const networkLocationFetch = traceFetch('ip=203.0.113.8\nloc=US\n')
    const { store, service } = createService({ networkLocationFetch })
    await store.update({ version: 2, mirrorPolicy: 'mirror-first' })

    await expect(service.inspectNetworkRegion()).resolves.toBe('mainland-china')
    expect(networkLocationFetch).not.toHaveBeenCalled()
  })

  it('probes the network location once and reuses it for the next region question', async () => {
    const networkLocationFetch = traceFetch('ip=203.0.113.8\nloc=CN\n')
    const { service } = createService({ networkLocationFetch })

    await expect(service.inspectNetworkRegion()).resolves.toBe('mainland-china')
    await expect(service.inspectNetworkRegion()).resolves.toBe('mainland-china')
    expect(networkLocationFetch).toHaveBeenCalledTimes(1)
  })

  it('reports a tool as missing when its command is not found', async () => {
    const { service } = createService()

    await expect(service.inspectTool('git')).resolves.toEqual({
      installed: false,
      version: null,
      path: null,
      installDirectory: null,
    })
  })

  it('checks the Codex setup with the desktop probe it was given', async () => {
    const desktop: DesktopAppStatus = { ...desktopMissing, installed: true, version: '26.1.0', path: '/Applications/Codex.app' }
    const inspectCodexDesktop = vi.fn(async () => desktop)
    const { service } = createService({}, inspectCodexDesktop)

    const status = await service.inspectCodexSetupStatus()

    expect(inspectCodexDesktop).toHaveBeenCalledTimes(1)
    expect(status.desktop).toMatchObject({ installed: true, version: '26.1.0' })
    expect(status.runtime.node.installed).toBe(false)
    expect(status.cli.installed).toBe(false)
  })
})

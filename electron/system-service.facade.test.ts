import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import type { ProviderId } from './catalog'
import { inspectProviderConfig, providerConfigPaths, saveProviderConfig } from './config-files'
import { isInstallCancelledError } from './install-cancellation'
import type { InstallLeftoverSweepResult } from './install-leftovers'
import type { InstallationQueueSnapshot } from './installation-queue'
import type { MacosCodexAppInspection } from './macos-codex-app'
import { createRelayEndpointRoutingSnapshot, relayProviderBaseUrls } from './relay-sites'
import { createSystemService, type SystemServiceOptions } from './system-service'
import { ToolConfigOwnershipStore } from './tool-config-ownership'
import { toolRouteRetryDelayMs } from './tool-route-follow-state'

// #1070 第 1 步：SystemService 上这 11 个对外方法以前没有测试直接调过（别处测试里出现的是 ipc 侧的假对象），
// 拆 system-service.ts 的时候搬坏了没人报警。这里每个方法至少钉一条行为，调的都是 createSystemService
// 交出去的那个对象本身，不 mock 闭包里的任何东西。

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryRoot(): string {
  // 先换成真实路径：macOS 的 /var 是指向 /private/var 的链接，读配置那几处会拒绝经过链接的路径。
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-service-facade-')))
  temporaryDirectories.push(root)
  return root
}

function createFixture(options: SystemServiceOptions = {}, root = temporaryRoot()) {
  // 有几处按 HOME 找本软件自己的目录（Mac 上代下的 Node.js 等），别读到开发机真实的家目录。它和下面交给
  // 服务的配置根目录故意不是同一处：读配置的哪一处没用服务拿到的根目录、退回了 HOME，用例就会红。
  const processHome = path.join(root, 'process-home')
  fs.mkdirSync(processHome, { recursive: true })
  vi.stubEnv('HOME', processHome)
  const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
  fs.mkdirSync(roots.userHome, { recursive: true })
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const service = createSystemService(store, {
    platform: 'linux',
    windowsExecutionMode: 'same-user',
    managerDataDirectory: root,
    providerRoots: roots,
    findExecutable: vi.fn(async () => null),
    ...options,
  })
  return { root, roots, store, service }
}

/** 接口上标了可选（旧实现不提供）的那几个，这份实现都得有：没有就当场红，别让 `?.` 把用例悄悄跳过去。 */
function provided<T>(method: T | undefined, name: string): T {
  if (!method) throw new Error(`${name} missing`)
  return method
}

function hold() {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  return { held, release }
}

/** 「清理安装残留」挂在这里不动，就占住了安装队列：后面排进来的都在等它。 */
function heldLeftoverSweep() {
  const started = hold()
  const gate = hold()
  async function sweep(): Promise<InstallLeftoverSweepResult> {
    started.release()
    await gate.held
    return { removed: 0, freedBytes: 0, failed: 0 }
  }
  return { sweep, started: started.held, release: gate.release }
}

function rendererTarget() {
  return { isDestroyed: () => false, send: vi.fn() }
}

function macCodexApp(appPath: string, running = true) {
  return vi.fn(async (): Promise<MacosCodexAppInspection> => ({
    app: { path: appPath, version: '26.1007.0', running },
    detectionFailed: false,
    detectionError: null,
  }))
}

describe('setOfficialSourcePreference', () => {
  it('waits for the config write in flight, then flips only that provider in the official list', async () => {
    const { store, service } = createFixture()
    const setOfficialSourcePreference = provided(service.setOfficialSourcePreference, 'setOfficialSourcePreference')
    await store.setOfficialProvider('grok', true)
    const saving = hold()
    const save = provided(service.serializeToolConfigWrite, 'serializeToolConfigWrite')(() => saving.held)

    // 切换失败回滚时恢复这个记号：要等手上那次保存写完，不然保存写下的来源会把它盖掉。
    const restored = setOfficialSourcePreference('claude', true)
    // 设置文件的写入按先后排队：这一笔写完的时候，记号要是已经开始写了，也一定写完了。
    await store.update({ version: 2 })
    expect(store.read().officialProviders).toEqual(['grok'])

    saving.release()
    await save
    await restored
    expect(store.read().officialProviders).toEqual(['claude', 'grok'])

    await setOfficialSourcePreference('claude', false)
    expect(store.read().officialProviders).toEqual(['grok'])
  })
})

describe('inspectOfficialLogin', () => {
  it('looks for the official login under the provider roots the service was given', () => {
    const { roots, service } = createFixture()
    const inspectOfficialLogin = provided(service.inspectOfficialLogin, 'inspectOfficialLogin')
    expect(inspectOfficialLogin('claude')).toBe(false)

    fs.writeFileSync(path.join(roots.userHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'fixture@example.invalid' } }))
    expect(inspectOfficialLogin('claude')).toBe(true)
  })
})

describe('cancelCodexDesktopInstall', () => {
  it('says nothing is running when no desktop install is in flight', () => {
    const { service } = createFixture()
    expect(service.cancelCodexDesktopInstall()).toEqual({ cancelled: false, reason: expect.stringContaining('没有正在进行的安装') })
  })

  it('takes a desktop install still waiting in the installation queue out at once', async () => {
    const leftovers = heldLeftoverSweep()
    const { service } = createFixture({ sweepInstallLeftovers: leftovers.sweep })
    const cleanup = service.cleanupInstallLeftovers()
    await leftovers.started
    const target = rendererTarget()
    const install = service.installCodexDesktop(target).catch((error: unknown) => error)
    expect(service.inspectInstallationQueue()).toEqual({ activeKey: 'maintenance:install-leftovers', pendingKeys: ['desktop:codex:install'] })

    expect(service.cancelCodexDesktopInstall()).toEqual({ cancelled: true, reason: null })
    const error = await install
    expect(isInstallCancelledError(error)).toBe(true)
    expect((error as Error).message).toBe('Codex 桌面端安装已取消')
    expect(target.send).toHaveBeenCalledWith('desktop:codex-install-progress', expect.objectContaining({ phase: 'error', message: 'Codex 桌面端安装已取消' }))
    // 出队了，排在前面的清理照旧挂着，再点一次就是没有在装的了。
    expect(service.inspectInstallationQueue()).toEqual({ activeKey: 'maintenance:install-leftovers', pendingKeys: [] })
    expect(service.cancelCodexDesktopInstall().cancelled).toBe(false)

    leftovers.release()
    await cleanup
  })
})

describe('resetCodexDesktop', () => {
  it.each(['darwin', 'linux'] as const)('refuses on %s inside the installation queue, since only Windows can reset the app', async (platform) => {
    const { service } = createFixture({ platform })
    const activeKeys: Array<string | null> = []
    service.onInstallationQueueChange((snapshot) => { activeKeys.push(snapshot.activeKey) })

    await expect(service.resetCodexDesktop()).rejects.toThrow('只有 Windows 上的 Codex 桌面端可以一键重置')
    // 重置会动桌面端的安装，和安装、卸载排同一条队（I11）。
    expect(activeKeys).toEqual(['desktop:codex:reset', null])
  })
})

describe('inspectCodexDesktopUpdate', () => {
  it('looks at the Mac app again on every check and leaves its updates to the app itself', async () => {
    const root = temporaryRoot()
    const appPath = path.join(root, 'Codex.app')
    const detector = macCodexApp(appPath)
    const { service } = createFixture({ platform: 'darwin', macosCodexAppDetector: detector }, root)

    await expect(service.inspectCodexDesktopUpdate()).resolves.toMatchObject({
      installed: true, version: '26.1007.0', path: appPath, running: true, updateCheck: 'skipped', updateAvailable: null,
    })
    // 两次之间客户把它删了：强制刷新那次照实说没装，不拿上一次的结果。
    detector.mockResolvedValueOnce({ app: null, detectionFailed: false, detectionError: null })
    await expect(service.inspectCodexDesktopUpdate(true)).resolves.toMatchObject({ installed: false, version: null, path: null })
    expect(detector).toHaveBeenCalledTimes(2)
  })

  it('skips the check outside Windows and macOS without reporting it as an error', async () => {
    const { service } = createFixture({ platform: 'linux' })
    // 带了错误文字，system:scan 每次检测都会记一条「Codex 桌面端更新检测失败」警告。
    await expect(service.inspectCodexDesktopUpdate(true)).resolves.toMatchObject({
      installed: false, updateCheck: 'skipped', updateError: null,
    })
  })
})

describe('inspectCodexDesktopLocale', () => {
  it('reads the locale from the service Codex home and the Chinese resources inside the app it found', async () => {
    const root = temporaryRoot()
    const appPath = path.join(root, 'Codex.app')
    const resources = path.join(appPath, 'Contents', 'Resources', 'app.asar')
    for (const file of [path.join(resources, 'webview', 'assets', 'zh-CN-fixture.js'), path.join(resources, 'native-menu-locales', 'zh-CN.json')]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '{}')
    }
    const { roots, service } = createFixture({ platform: 'darwin', macosCodexAppDetector: macCodexApp(appPath) }, root)
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(path.join(roots.codexHome, 'config.toml'), '[desktop]\nlocaleOverride = "zh-CN"\n')

    await expect(service.inspectCodexDesktopLocale()).resolves.toEqual({
      installed: true,
      version: '26.1007.0',
      running: true,
      configPath: path.join(roots.codexHome, 'config.toml'),
      configuredLocale: 'zh-CN',
      effectiveLocale: 'zh-CN',
      chineseResources: expect.objectContaining({ available: true, resourceRoot: resources }),
      // 开着的桌面端是按启动那一刻的语言画的，改过的要重开才生效。
      needsRestart: true,
      error: null,
    })
  })
})

describe('inspectCodexWorkspacePermissions', () => {
  it('reports the trust Codex gives the workspace saved in settings', async () => {
    const { roots, store, service } = createFixture()
    const workspace = path.join(roots.userHome, '项目')
    fs.mkdirSync(workspace)
    await store.update({ version: 2, workspace })
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(path.join(roots.codexHome, 'config.toml'), TOML.stringify({
      approval_policy: 'on-request',
      projects: { [workspace]: { trust_level: 'trusted' } },
    }))

    expect(service.inspectCodexWorkspacePermissions()).toEqual({
      configPath: path.join(roots.codexHome, 'config.toml'),
      workspace,
      configExists: true,
      trustLevel: 'trusted',
      approvalPolicy: 'on-request',
      permissionProfile: null,
      sandboxMode: null,
      control: 'available',
      error: null,
    })
  })

  it('turns a config it refuses to read into an unknown status with the reason instead of throwing', async () => {
    const { root, roots, store, service } = createFixture()
    await store.update({ version: 2, workspace: root })
    fs.mkdirSync(roots.codexHome, { recursive: true })
    const configPath = path.join(roots.codexHome, 'config.toml')
    fs.writeFileSync(configPath, 'approval_policy = "on-request"\n')
    // 硬链接：配置文件可能被换成别处文件的另一个名字，读配置那一步拒绝它（I8）。
    fs.linkSync(configPath, path.join(root, 'config-alias.toml'))

    const status = service.inspectCodexWorkspacePermissions()
    expect(status).toMatchObject({
      configPath, workspace: root, configExists: false, trustLevel: 'unknown', approvalPolicy: null, control: 'unknown',
    })
    expect(status.error).toContain('是个链接')
  })
})

describe('inspectRunningTools', () => {
  it('finds each tool where it is installed and asks the desktop app whether it is open', async () => {
    const root = temporaryRoot()
    const resolveCliInstallation = vi.fn(async (provider: ProviderId) => {
      if (provider === 'claude') throw new Error('读不到 Claude Code 的安装信息')
      return null
    })
    const { service } = createFixture({
      platform: 'darwin',
      resolveCliInstallation,
      macosCodexAppDetector: macCodexApp(path.join(root, 'Codex.app')),
    }, root)

    await expect(provided(service.inspectRunningTools, 'inspectRunningTools')(['claude', 'codex'])).resolves.toEqual({
      // 读不到安装信息的看不出开没开；Codex 命令行没装，不算开着。
      running: [],
      unknown: ['claude'],
      codexDesktopRunning: true,
      // Mac 上没法替客户重开桌面端。
      canRestartCodexDesktop: false,
    })
    expect(resolveCliInstallation).toHaveBeenCalledWith('claude', expect.objectContaining({ platform: 'darwin' }))
    expect(resolveCliInstallation).toHaveBeenCalledWith('codex', expect.objectContaining({ platform: 'darwin' }))
  })
})

describe('disposeToolRoutes', () => {
  it('stops the check-back and the retry it scheduled after following a route change', async () => {
    const root = temporaryRoot()
    const roots = { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') }
    const primary = relayProviderBaseUrls('solov', 'primary')
    const owner = JSON.stringify(['solov', 9])
    const ownership = new ToolConfigOwnershipStore(path.join(root, 'tool-config-ownership'))
    for (const provider of ['claude', 'codex'] satisfies ProviderId[]) {
      saveProviderConfig(provider, 'sk-route-fixture', 'fixture-model', 'reset', roots, {}, primary)
      await ownership.write(provider, inspectProviderConfig(provider, roots, primary), 'account', owner, 2)
    }
    // Claude Code 的配置读不出来（这里用一个目录顶替它）：这一家等着重试，Codex 改好了等着回头核对。
    const [claudeConfig] = providerConfigPaths('claude', roots)
    fs.rmSync(claudeConfig)
    fs.mkdirSync(claudeConfig)
    const timers: Array<{ delayMs: number }> = []
    const { service } = createFixture({
      // 和 system-service-tool-route.test.ts 一样按这台机器本身跑：改配置那几处读的是真实的路径规则。
      platform: process.platform,
      windowsExecutionMode: 'trusted-only',
      providerRoots: roots,
      getExternalClientAccountId: () => owner,
      relayEndpointRouting: createRelayEndpointRoutingSnapshot({}, () => ({ solov: { line: 'direct', settled: true } })),
      relayFetch: vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] })),
      resolveCliInstallation: async () => null,
      inspectCodexDesktopForModelCatalog: async () => ({ installed: false, version: null }),
      inspectRunningToolsForRouteHint: async () => ({ running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false }),
      scheduleToolRoute: (_callback, delayMs) => {
        const timer = { delayMs }
        timers.push(timer)
        return () => { timers.splice(timers.indexOf(timer), 1) }
      },
      toolRouteNow: () => 1_000_000_000_000,
    }, root)

    await expect(provided(service.followToolRoutes, 'followToolRoutes')({ reason: 'route-changed' })).resolves.toEqual({ rewritten: ['codex'] })
    expect(timers.map((timer) => timer.delayMs).sort((left, right) => left - right)).toEqual([60_000, toolRouteRetryDelayMs])

    // 退出时调：几个定时器都撤掉，进程不会因为它们多等。调两次也不出错。
    const disposeToolRoutes = provided(service.disposeToolRoutes, 'disposeToolRoutes')
    disposeToolRoutes()
    expect(timers).toEqual([])
    disposeToolRoutes()
  })
})

describe('cancelExternalClientInstall', () => {
  it('takes a client install still waiting in the installation queue out at once', async () => {
    const leftovers = heldLeftoverSweep()
    const { service } = createFixture({ sweepInstallLeftovers: leftovers.sweep })
    expect(service.cancelExternalClientInstall('opencode')).toEqual({ cancelled: false, reason: expect.stringContaining('没有正在进行的安装') })
    const cleanup = service.cleanupInstallLeftovers()
    await leftovers.started
    const target = rendererTarget()
    const install = service.installExternalClient('opencode', target).catch((error: unknown) => error)
    expect(service.inspectInstallationQueue().pendingKeys).toEqual(['external-client:install:opencode'])

    expect(service.cancelExternalClientInstall('opencode')).toEqual({ cancelled: true, reason: null })
    const error = await install
    expect(isInstallCancelledError(error)).toBe(true)
    expect(target.send).toHaveBeenLastCalledWith('external-clients:install-progress', expect.objectContaining({
      tool: 'opencode', phase: 'error', message: (error as Error).message,
    }))
    // 只取消点的那一家。
    expect(service.inspectInstallationQueue()).toEqual({ activeKey: 'maintenance:install-leftovers', pendingKeys: [] })

    leftovers.release()
    await cleanup
  })
})

describe('onInstallationQueueChange', () => {
  it('reports each start and end of a queued job until the listener unsubscribes', async () => {
    const leftovers = heldLeftoverSweep()
    const { service } = createFixture({ sweepInstallLeftovers: leftovers.sweep })
    const snapshots: InstallationQueueSnapshot[] = []
    const unsubscribe = service.onInstallationQueueChange((snapshot) => { snapshots.push(snapshot) })

    const cleanup = service.cleanupInstallLeftovers()
    await leftovers.started
    expect(snapshots).toEqual([{ activeKey: 'maintenance:install-leftovers', pendingKeys: [] }])
    leftovers.release()
    await cleanup
    expect(snapshots).toEqual([
      { activeKey: 'maintenance:install-leftovers', pendingKeys: [] },
      { activeKey: null, pendingKeys: [] },
    ])

    unsubscribe()
    await service.cleanupInstallLeftovers()
    expect(snapshots).toHaveLength(2)
  })
})

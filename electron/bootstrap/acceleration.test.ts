import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { net, session } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccelerationState } from '../acceleration-contract'
import { accelerationProxyJournalPath, createAccelerationDevelopmentHost, type AccelerationDevelopmentConfig } from '../acceleration-development-host'
import type { AccelerationInterruptionNotice } from '../acceleration-interruption-notice'
import type { AccelerationPreferenceStore } from '../acceleration-preference-store'
import { accelerationOffMessage } from '../remote-features'
import type { RuntimeLogStore } from '../runtime-log'
import {
  createAccelerationHost,
  createAccelerationHostLoader,
  createAccelerationRouting,
  createAccelerationServices,
  type AccelerationHost,
  type AccelerationHostLoaderOptions,
  type AccelerationHostOptions,
  type AccelerationRoutingOptions,
  type AccelerationServicesOptions,
} from './acceleration'

// Every request the routing could make goes through these mocks, so nothing
// here reaches the network.
vi.mock('electron', () => {
  const partitionFetch = vi.fn(async () => { throw new TypeError('offline in tests') })
  return {
    app: { isPackaged: true },
    net: { fetch: vi.fn(async () => new Response('ok')), request: vi.fn() },
    session: { defaultSession: {}, fromPartition: vi.fn(() => ({ fetch: partitionFetch, setProxy: vi.fn(async () => undefined) })) },
  }
})

// The real host spawns the helper process and the proxy kernel; these tests
// only care what the startup wiring hands it and asks of it.
vi.mock('../acceleration-development-host', async (importOriginal) => ({
  ...await importOriginal<typeof import('../acceleration-development-host')>(),
  createAccelerationDevelopmentHost: vi.fn(() => ({ recover: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) })),
}))

beforeEach(() => {
  vi.mocked(createAccelerationDevelopmentHost).mockClear()
  vi.mocked(session.fromPartition).mockClear()
  vi.mocked(net.fetch).mockClear()
})

function runtimeLog() {
  return { log: vi.fn(), exception: vi.fn() }
}

type HostRead = Awaited<AccelerationHostOptions['read']>

function create(read: HostRead | Promise<HostRead>, interruption: AccelerationInterruptionNotice | null = null) {
  const runtimeLog = { log: vi.fn(), exception: vi.fn() }
  const host = createAccelerationHost({
    read: Promise.resolve(read),
    managerDataDirectory: '/tmp/xingmang-acceleration-test',
    runtimeLog: runtimeLog as unknown as RuntimeLogStore,
    accelerationInterruption: () => interruption,
  })
  return { host, runtimeLog }
}

describe('acceleration host wiring', () => {
  it('builds no host and blames the bundle when the packaged files could not be read', async () => {
    const { host, runtimeLog } = create({ ok: false, error: new Error('quarantined') })
    expect(await host).toEqual({ developmentAcceleration: undefined, accelerationBundleDamaged: true })
    expect(createAccelerationDevelopmentHost).not.toHaveBeenCalled()
    expect(runtimeLog.log).toHaveBeenCalledWith('warn', 'network', 'acceleration.config.invalid', expect.any(String))
  })

  it('builds no host and blames nothing when the build carries no acceleration files', async () => {
    const { host, runtimeLog } = create({ ok: true, config: null })
    expect(await host).toEqual({ developmentAcceleration: undefined, accelerationBundleDamaged: false })
    expect(runtimeLog.log).not.toHaveBeenCalled()
  })

  it('restores a proxy left behind by a crash as soon as the host exists', async () => {
    const host = await create({ ok: true, config: {} as AccelerationDevelopmentConfig }).host
    expect(host.accelerationBundleDamaged).toBe(false)
    expect(host.developmentAcceleration?.recover).toHaveBeenCalledTimes(1)
  })

  it('builds the host and restores the proxy the moment the files are read, with nobody waiting for it', async () => {
    let finishRead!: (read: HostRead) => void
    create(new Promise<HostRead>((resolve) => { finishRead = resolve }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(createAccelerationDevelopmentHost).not.toHaveBeenCalled()
    finishRead({ ok: true, config: {} as AccelerationDevelopmentConfig })
    await new Promise((resolve) => setImmediate(resolve))
    const [host] = vi.mocked(createAccelerationDevelopmentHost).mock.results.map((result) => result.value as { recover: ReturnType<typeof vi.fn> })
    expect(host.recover).toHaveBeenCalledTimes(1)
  })

  it('tells the interruption notice, read when the runtime exits, that acceleration stopped', async () => {
    const interruption = { runtimeExited: vi.fn(), helperExited: vi.fn() } as unknown as AccelerationInterruptionNotice
    await create({ ok: true, config: {} as AccelerationDevelopmentConfig }, interruption).host
    const [[options]] = vi.mocked(createAccelerationDevelopmentHost).mock.calls
    options.onRuntimeExited?.()
    options.onHelperExited?.(true)
    expect(interruption.runtimeExited).toHaveBeenCalledTimes(1)
    expect(interruption.helperExited).toHaveBeenCalledWith(true)
  })
})

// 0.2.24 启动速度深查 S-3：加速下线以后开机不再整读三十多兆的内核，只有上次崩溃留下了没改回的系统代理才马上读。
describe('acceleration host loader', () => {
  type BuiltHost = { recover: ReturnType<typeof vi.fn>, dispose: ReturnType<typeof vi.fn> }

  function settle() {
    return new Promise((resolve) => setImmediate(resolve))
  }

  function builtHosts(): BuiltHost[] {
    return vi.mocked(createAccelerationDevelopmentHost).mock.results.map((result) => result.value as BuiltHost)
  }

  function loader(overrides: Partial<AccelerationHostLoaderOptions> = {}) {
    const log = runtimeLog()
    const read = vi.fn<AccelerationHostLoaderOptions['read']>(async () => ({ ok: true, config: {} as AccelerationDevelopmentConfig }))
    const onLoaded = vi.fn<(host: AccelerationHost) => void>()
    const hosts = createAccelerationHostLoader({
      read,
      hasRecoveryRecords: async () => false,
      onLoaded,
      managerDataDirectory: '/tmp/xingmang-acceleration-test',
      runtimeLog: log as unknown as RuntimeLogStore,
      accelerationInterruption: () => null,
      ...overrides,
    })
    return { hosts, read, onLoaded, log }
  }

  it('reads nothing at startup when no proxy was left behind', async () => {
    const { read, onLoaded, log } = loader()
    await settle()
    expect(read).not.toHaveBeenCalled()
    expect(createAccelerationDevelopmentHost).not.toHaveBeenCalled()
    expect(onLoaded).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
  })

  it('reads the files and restores the proxy at startup when a crash left one behind', async () => {
    const { read, onLoaded, log } = loader({ hasRecoveryRecords: async () => true })
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    const [host] = builtHosts()
    expect(host.recover).toHaveBeenCalledTimes(1)
    expect(onLoaded).toHaveBeenCalledWith({ developmentAcceleration: host, accelerationBundleDamaged: false })
    expect(log.log).toHaveBeenCalledWith('info', 'network', 'acceleration.recover.pending', expect.any(String))
  })

  it('treats records it cannot look at as records, so a dead proxy never stays', async () => {
    const { read } = loader({ hasRecoveryRecords: async () => { throw new Error('unreadable') } })
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    expect(builtHosts()[0].recover).toHaveBeenCalledTimes(1)
  })

  it('looks for the recovery journal under the data directory by default', async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'xingmang-acceleration-loader-'))
    try {
      const clean = loader({ hasRecoveryRecords: undefined, managerDataDirectory: dataDirectory })
      await vi.waitFor(() => expect(clean.log.log).not.toHaveBeenCalled())
      await settle()
      expect(clean.read).not.toHaveBeenCalled()

      await mkdir(path.dirname(accelerationProxyJournalPath(dataDirectory)), { recursive: true })
      await writeFile(accelerationProxyJournalPath(dataDirectory), '{}')
      const crashed = loader({ hasRecoveryRecords: undefined, managerDataDirectory: dataDirectory })
      await vi.waitFor(() => expect(crashed.read).toHaveBeenCalledTimes(1))
    } finally {
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('reads the files once, the first time something needs the host', async () => {
    const { hosts, read, onLoaded } = loader()
    const [first, second] = await Promise.all([hosts.load(), hosts.load()])
    expect(first).toBe(second)
    expect(await hosts.load()).toBe(first)
    expect(read).toHaveBeenCalledTimes(1)
    expect(createAccelerationDevelopmentHost).toHaveBeenCalledTimes(1)
    expect(onLoaded).toHaveBeenCalledTimes(1)
  })

  it('shares the startup recovery read with a later use', async () => {
    const { hosts, read } = loader({ hasRecoveryRecords: async () => true })
    await settle()
    await hosts.load()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reads nothing on quit when the host was never needed, nor afterwards', async () => {
    const { hosts, read } = loader()
    hosts.dispose()
    expect(await hosts.load()).toEqual({ developmentAcceleration: undefined, accelerationBundleDamaged: false })
    expect(read).not.toHaveBeenCalled()
  })

  it('skips the startup recovery when the app quits before the records were looked at', async () => {
    let answer!: (records: boolean) => void
    const { hosts, read } = loader({ hasRecoveryRecords: () => new Promise<boolean>((resolve) => { answer = resolve }) })
    hosts.dispose()
    answer(true)
    await settle()
    expect(read).not.toHaveBeenCalled()
  })

  it('lets a built host go exactly once on quit', async () => {
    const { hosts } = loader()
    await hosts.load()
    hosts.dispose()
    hosts.dispose()
    await settle()
    expect(builtHosts()[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('lets a host still being read go once it is built, without announcing it', async () => {
    let finishRead!: (read: HostRead) => void
    const { hosts, onLoaded } = loader({ read: () => new Promise<HostRead>((resolve) => { finishRead = resolve }) })
    const loading = hosts.load()
    hosts.dispose()
    finishRead({ ok: true, config: {} as AccelerationDevelopmentConfig })
    await loading
    await settle()
    expect(builtHosts()[0].dispose).toHaveBeenCalledTimes(1)
    expect(onLoaded).not.toHaveBeenCalled()
  })
})

describe('acceleration routing', () => {
  function route(overrides: Partial<AccelerationRoutingOptions> = {}) {
    const log = runtimeLog()
    const getAccelerationPreference = vi.fn<AccelerationPreferenceStore['getAccelerationPreference']>(async () => ({ lineId: 'jp-2', mode: 'system-proxy' }))
    const accelerationService = vi.fn<AccelerationRoutingOptions['accelerationService']>(() => undefined)
    const routing = createAccelerationRouting({
      routes: { proxyBypass: { active: () => false } } as unknown as AccelerationRoutingOptions['routes'],
      rootedOptions: {} as AccelerationRoutingOptions['rootedOptions'],
      accelerationPreferences: { getAccelerationPreference },
      runtimeLog: log as unknown as RuntimeLogStore,
      readAccelerationAccountScope: () => 'xm-account:1',
      downloadRoutes: () => null,
      accelerationService,
      issueCodexStartupTicket: () => Promise.reject(new Error('账号服务尚未就绪')),
      readStoredConfig: () => ({ relaySiteId: 'solov' }),
      ...overrides,
    })
    return { routing, log, getAccelerationPreference, accelerationService }
  }

  it('keeps downloads on the default session until a download line is up', async () => {
    const { routing } = route()
    expect(vi.mocked(session.fromPartition).mock.calls).toEqual([['xingmang-download-acceleration']])
    expect(routing.downloadAcceleration.currentEndpoint()).toBeNull()
    await routing.downloadFetch('https://example.invalid/node.zip')
    expect(net.fetch).toHaveBeenCalledWith('https://example.invalid/node.zip', undefined)
    const [partition] = vi.mocked(session.fromPartition).mock.results.map((result) => result.value as { fetch: ReturnType<typeof vi.fn> })
    expect(partition.fetch).not.toHaveBeenCalled()
  })

  it('connects with the line and mode saved for the account, or the default when they cannot be read', async () => {
    const { routing, log, getAccelerationPreference } = route()
    expect(await routing.accelerationStartArguments('xm-account:1', null)).toEqual(['system-proxy', 'jp-2'])
    expect(getAccelerationPreference).toHaveBeenCalledWith('xm-account:1')

    const failure = new Error('preferences unreadable')
    getAccelerationPreference.mockRejectedValueOnce(failure)
    expect(await routing.accelerationStartArguments('xm-account:1', null)).toEqual(['system-proxy'])
    expect(log.exception).toHaveBeenCalledWith('network', 'acceleration.preference.read.failed', failure)
  })

  it('opens Codex desktop unaccelerated while the acceleration service is not built yet', async () => {
    const { routing, accelerationService } = route()
    expect(accelerationService).not.toHaveBeenCalled()
    await expect(routing.codexDesktopAcceleration.ensureConnected()).resolves.toEqual({ status: 'skipped', reason: 'state-unreadable' })
    expect(accelerationService).toHaveBeenCalled()
  })

  it('opens Claude Desktop unaccelerated while the acceleration service is not built yet', async () => {
    const { routing } = route()
    await expect(routing.claudeDesktopAcceleration.ensureConnected({ isDesktopRunning: async () => null }))
      .resolves.toEqual({ status: 'skipped', reason: 'state-unreadable' })
  })

  // 网络加速 2026-10-30 下线（yoyo 回「下线改」）：打开 Codex、Claude 桌面端都不再替他连，连加速状态都不去读，
  // 读一次就会拉起整份加速辅助进程。
  it('neither connects nor reads acceleration for the desktop apps where acceleration is retired', async () => {
    const { routing, accelerationService } = route({ accelerationOffered: false })
    expect(routing.prepareClaudeDesktopLaunch).toBeUndefined()
    await expect(routing.codexDesktopStartupRoute.prepare({ launchArgumentsUsable: true })).resolves.toMatchObject({ kind: expect.any(String) })
    await expect(routing.codexDesktopStartupRoute.prepare({ launchArgumentsUsable: false })).resolves.toMatchObject({ kind: expect.any(String) })
    expect(accelerationService).not.toHaveBeenCalled()
  })

  it('still connects for the desktop apps on a platform that offers acceleration', async () => {
    const { routing, accelerationService } = route({ accelerationOffered: true })
    await expect(routing.prepareClaudeDesktopLaunch?.({ isDesktopRunning: async () => null }))
      .resolves.toEqual({ status: 'skipped', reason: 'state-unreadable' })
    expect(accelerationService).toHaveBeenCalledTimes(1)
    await routing.codexDesktopStartupRoute.prepare({ launchArgumentsUsable: false })
    expect(accelerationService).toHaveBeenCalledTimes(2)
  })

  it('offers no acceleration for the desktop apps on this computer by default', () => {
    expect(route().routing.prepareClaudeDesktopLaunch).toBeUndefined()
  })
})

describe('acceleration services', () => {
  function build(overrides: Partial<AccelerationServicesOptions> = {}) {
    const log = runtimeLog()
    const observe = vi.fn<(state: AccelerationState) => void>()
    const observeClaude = vi.fn<(state: AccelerationState) => void>()
    const applicationTray = vi.fn<AccelerationServicesOptions['applicationTray']>(() => null)
    const recheckAccelerationBundle = vi.fn(async () => 'repaired' as const)
    const services = createAccelerationServices({
      host: async () => ({ developmentAcceleration: undefined, accelerationBundleDamaged: false }),
      accelerationPreferences: {} as AccelerationPreferenceStore,
      recheckAccelerationBundle,
      routing: {
        codexDesktopAcceleration: { observe } as unknown as AccelerationServicesOptions['routing']['codexDesktopAcceleration'],
        claudeDesktopAcceleration: { observe: observeClaude } as unknown as AccelerationServicesOptions['routing']['claudeDesktopAcceleration'],
        accelerationStartArguments: async () => ['system-proxy'],
      },
      readAccelerationAccountScope: () => 'xm-account:1',
      runtimeLog: log as unknown as RuntimeLogStore,
      mainWindow: () => null,
      applicationTray,
      ...overrides,
    })
    return { services, log, observe, observeClaude, applicationTray, recheckAccelerationBundle }
  }

  it('hands every state the service produces to the Codex and Claude desktop watchers', async () => {
    const { services, observe, observeClaude } = build()
    const state = await services.acceleration.getAccelerationState('xm-account:1')
    expect(state.phase).toBe('unavailable')
    expect(observe).toHaveBeenCalledWith(state)
    expect(observeClaude).toHaveBeenCalledWith(state)
  })

  it('blames a damaged bundle and offers a recheck that logs what it found', async () => {
    const { services, log, recheckAccelerationBundle } = build({ host: async () => ({ developmentAcceleration: undefined, accelerationBundleDamaged: true }) })
    expect((await services.userAcceleration.getAccelerationState('xm-account:1')).unavailableReason).toBe('bundle-damaged')
    expect(await services.userAcceleration.recheckAccelerationBundle?.()).toBe('repaired')
    expect(recheckAccelerationBundle).toHaveBeenCalledTimes(1)
    expect(log.log).toHaveBeenCalledWith('info', 'network', 'acceleration.config.recheck', '本机加速资源已恢复，重新打开软件后生效', { result: 'repaired' })
  })

  it('offers no recheck when the bundle was fine', async () => {
    const { services } = build()
    await services.userAcceleration.getAccelerationState('xm-account:1')
    expect(services.userAcceleration.recheckAccelerationBundle).toBeUndefined()
  })

  it('is ready to answer before the files are read, and answers once they are', async () => {
    let finishHost!: (host: AccelerationHost) => void
    const pending = new Promise<AccelerationHost>((resolve) => { finishHost = resolve })
    const { services, observe } = build({ host: () => pending })
    const read = services.userAcceleration.getAccelerationState('xm-account:1')
    await new Promise((resolve) => setImmediate(resolve))
    expect(observe).not.toHaveBeenCalled()
    expect(services.userAcceleration.recheckAccelerationBundle).toBeUndefined()
    finishHost({ developmentAcceleration: undefined, accelerationBundleDamaged: true })
    expect((await read).unavailableReason).toBe('bundle-damaged')
    expect(services.userAcceleration.recheckAccelerationBundle).toBeTypeOf('function')
  })

  // 读加速文件要整读三十多兆：换账号、退出这些用不着宿主的事不去建它，真要用的第一次才建，之后不再建。
  it('builds the host only when an operation first needs it', async () => {
    const host = vi.fn<AccelerationServicesOptions['host']>(async () => ({ developmentAcceleration: undefined, accelerationBundleDamaged: false }))
    const { services } = build({ host })
    await services.acceleration.onAccountChanged()
    await services.acceleration.stopAll()
    expect(services.acceleration.hasPossibleSession()).toBe(false)
    expect(host).not.toHaveBeenCalled()
    await services.userAcceleration.getAccelerationState('xm-account:1')
    await services.userAcceleration.getAccelerationState('xm-account:1')
    expect(host).toHaveBeenCalledTimes(1)
    await services.acceleration.dispose()
    expect(host).toHaveBeenCalledTimes(1)
  })

  it('quits without building a host nobody needed', async () => {
    const host = vi.fn<AccelerationServicesOptions['host']>(async () => ({ developmentAcceleration: undefined, accelerationBundleDamaged: false }))
    const { services } = build({ host })
    await services.acceleration.dispose()
    expect(host).not.toHaveBeenCalled()
  })

  // 网络加速 2026-10-30 下线：三个平台都不再有托盘那一行。
  it('puts no acceleration row on the tray now that acceleration is retired', () => {
    const { services } = build()
    expect(services.trayAcceleration).toBeNull()
  })

  it('builds the tray row without touching the tray, which is built later, where acceleration is offered', () => {
    const { services, applicationTray } = build({ accelerationOffered: true })
    expect(services.trayAcceleration).not.toBeNull()
    expect(applicationTray).not.toHaveBeenCalled()
  })

  // 冻结的旧回滚界面还有加速页：从那里点开启也不连新的，停用的话照现成的远程开关那一句说。
  it('refuses every new connection where acceleration is retired, whatever the status file says', async () => {
    const { services } = build({ accelerationSuspended: () => false })
    await expect(services.userAcceleration.startAcceleration('xm-account:1', 'system-proxy')).rejects.toThrow(accelerationOffMessage)
  })

  it('follows the status file where acceleration is offered', async () => {
    let off = false
    const { services } = build({ accelerationOffered: true, accelerationSuspended: () => off })
    await expect(services.userAcceleration.startAcceleration('xm-account:1', 'system-proxy')).rejects.not.toThrow(accelerationOffMessage)
    off = true
    await expect(services.userAcceleration.startAcceleration('xm-account:1', 'system-proxy')).rejects.toThrow(accelerationOffMessage)
  })
})

import { net, session } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccelerationState } from '../acceleration-contract'
import { createAccelerationDevelopmentHost, type AccelerationDevelopmentConfig } from '../acceleration-development-host'
import type { AccelerationInterruptionNotice } from '../acceleration-interruption-notice'
import type { AccelerationPreferenceStore } from '../acceleration-preference-store'
import type { RuntimeLogStore } from '../runtime-log'
import {
  createAccelerationHost,
  createAccelerationRouting,
  createAccelerationServices,
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
  createAccelerationDevelopmentHost: vi.fn(() => ({ recover: vi.fn(async () => undefined) })),
}))

beforeEach(() => {
  vi.mocked(createAccelerationDevelopmentHost).mockClear()
  vi.mocked(session.fromPartition).mockClear()
  vi.mocked(net.fetch).mockClear()
})

function runtimeLog() {
  return { log: vi.fn(), exception: vi.fn() }
}

function create(read: AccelerationHostOptions['read'], interruption: AccelerationInterruptionNotice | null = null) {
  const runtimeLog = { log: vi.fn(), exception: vi.fn() }
  const host = createAccelerationHost({
    read,
    managerDataDirectory: '/tmp/xingmang-acceleration-test',
    runtimeLog: runtimeLog as unknown as RuntimeLogStore,
    accelerationInterruption: () => interruption,
  })
  return { host, runtimeLog }
}

describe('acceleration host wiring', () => {
  it('builds no host and blames the bundle when the packaged files could not be read', () => {
    const { host, runtimeLog } = create({ ok: false, error: new Error('quarantined') })
    expect(host).toEqual({ developmentAcceleration: undefined, accelerationBundleDamaged: true })
    expect(createAccelerationDevelopmentHost).not.toHaveBeenCalled()
    expect(runtimeLog.log).toHaveBeenCalledWith('warn', 'network', 'acceleration.config.invalid', expect.any(String))
  })

  it('builds no host and blames nothing when the build carries no acceleration files', () => {
    const { host, runtimeLog } = create({ ok: true, config: null })
    expect(host).toEqual({ developmentAcceleration: undefined, accelerationBundleDamaged: false })
    expect(runtimeLog.log).not.toHaveBeenCalled()
  })

  it('restores a proxy left behind by a crash as soon as the host exists', () => {
    const { host } = create({ ok: true, config: {} as AccelerationDevelopmentConfig })
    expect(host.accelerationBundleDamaged).toBe(false)
    expect(host.developmentAcceleration?.recover).toHaveBeenCalledTimes(1)
  })

  it('tells the interruption notice, read when the runtime exits, that acceleration stopped', () => {
    const interruption = { runtimeExited: vi.fn(), helperExited: vi.fn() } as unknown as AccelerationInterruptionNotice
    create({ ok: true, config: {} as AccelerationDevelopmentConfig }, interruption)
    const [[options]] = vi.mocked(createAccelerationDevelopmentHost).mock.calls
    options.onRuntimeExited?.()
    options.onHelperExited?.(true)
    expect(interruption.runtimeExited).toHaveBeenCalledTimes(1)
    expect(interruption.helperExited).toHaveBeenCalledWith(true)
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
})

describe('acceleration services', () => {
  function build(overrides: Partial<AccelerationServicesOptions> = {}) {
    const log = runtimeLog()
    const observe = vi.fn<(state: AccelerationState) => void>()
    const observeClaude = vi.fn<(state: AccelerationState) => void>()
    const applicationTray = vi.fn<AccelerationServicesOptions['applicationTray']>(() => null)
    const recheckAccelerationBundle = vi.fn(async () => 'repaired' as const)
    const services = createAccelerationServices({
      developmentAcceleration: undefined,
      accelerationBundleDamaged: false,
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
    const { services, log, recheckAccelerationBundle } = build({ accelerationBundleDamaged: true })
    expect((await services.userAcceleration.getAccelerationState('xm-account:1')).unavailableReason).toBe('bundle-damaged')
    expect(await services.userAcceleration.recheckAccelerationBundle?.()).toBe('repaired')
    expect(recheckAccelerationBundle).toHaveBeenCalledTimes(1)
    expect(log.log).toHaveBeenCalledWith('info', 'network', 'acceleration.config.recheck', '本机加速资源已恢复，重新打开软件后生效', { result: 'repaired' })
  })

  it('offers no recheck when the bundle was fine', () => {
    const { services } = build()
    expect(services.userAcceleration.recheckAccelerationBundle).toBeUndefined()
  })

  it.runIf(process.platform === 'linux')('puts no acceleration row on the tray on Linux', () => {
    const { services } = build()
    expect(services.trayAcceleration).toBeNull()
  })

  it.runIf(process.platform !== 'linux')('builds the tray row without touching the tray, which is built later', () => {
    const { services, applicationTray } = build()
    expect(services.trayAcceleration).not.toBeNull()
    expect(applicationTray).not.toHaveBeenCalled()
  })
})

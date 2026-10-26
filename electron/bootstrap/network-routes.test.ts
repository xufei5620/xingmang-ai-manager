import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { net, powerMonitor, session } from 'electron'
import { ipcEventChannels } from '../ipc-contract'
import type { RuntimeLogStore } from '../runtime-log'
import { createNetworkRoutes, startToolRouteFollowing, type NetworkRoutes, type NetworkRoutesOptions } from './network-routes'

function fakeSession() {
  return {
    setProxy: vi.fn(async () => undefined),
    resolveProxy: vi.fn(async () => 'DIRECT'),
  }
}

vi.mock('electron', () => {
  const defaultSession = fakeSession()
  return {
    app: { isPackaged: true },
    net: { isOnline: vi.fn(() => true) },
    powerMonitor: { on: vi.fn(), off: vi.fn() },
    session: { defaultSession, fromPartition: vi.fn(() => fakeSession()) },
  }
})

const directories: string[] = []
const disposers: Array<() => void> = []

beforeEach(() => {
  vi.mocked(session.fromPartition).mockClear()
  vi.mocked(powerMonitor.on).mockClear()
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function create(overrides: Partial<NetworkRoutesOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-network-routes-'))
  directories.push(root)
  // Every request the routes make goes through the session fetch handed in
  // here, so nothing in these tests reaches a real account site.
  const sessionFetch = vi.fn(async () => { throw new TypeError('offline in tests') })
  const chromiumSessionFetch = vi.fn<NetworkRoutesOptions['chromiumSessionFetch']>(() => sessionFetch as unknown as typeof fetch)
  const routes = createNetworkRoutes({
    managerDataDirectory: root,
    settingsStore: { read: () => ({}) as ReturnType<NetworkRoutesOptions['settingsStore']['read']> },
    runtimeLog: { log: vi.fn(), exception: vi.fn() } as unknown as RuntimeLogStore,
    chromiumSessionFetch,
    readStoredConfig: () => ({ relaySiteId: 'solov' }),
    accelerationRunning: async () => false,
    mainWindow: () => null,
    readAccountSiteId: () => 'solov',
    ...overrides,
  })
  disposers.push(() => {
    routes.unsubscribeRelayRoute()
    routes.relayRouteController.dispose()
    routes.toolRouteController.dispose()
  })
  return { routes, chromiumSessionFetch, sessionFetch }
}

describe('network routes', () => {
  it('builds its own sessions for the direct and system-proxy paths and fetches only through them', () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const { chromiumSessionFetch } = create()
    expect(vi.mocked(session.fromPartition).mock.calls.map(([partition]) => partition)).toEqual(['xingmang-site-direct', 'xingmang-system-proxy'])
    expect(chromiumSessionFetch.mock.calls.map(([target]) => target)).toEqual([
      session.defaultSession,
      ...vi.mocked(session.fromPartition).mock.results.map((result) => result.value),
    ])
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('tells the main window about a route change only once there is one', () => {
    const send = vi.fn()
    let window: { isDestroyed: () => boolean, webContents: { isDestroyed: () => boolean, send: typeof send } } | null = null
    const { routes } = create({ mainWindow: () => window as never })
    routes.notifyRelayRouteChanged()
    window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    routes.notifyRelayRouteChanged()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(ipcEventChannels.onRelayRouteChanged, undefined)
  })

  it('reads the latest route status through a getter that starts out empty', () => {
    const { routes } = create()
    expect(routes.latestRouteStatus()).toBeNull()
  })
})

describe('tool route following', () => {
  function follow(siteId = 'solov') {
    let listener: ((snapshot: { line: string, lastChange?: { reason: string } }) => void) | undefined
    const unsubscribe = vi.fn()
    const routes = {
      toolRouteController: {
        line: vi.fn(() => 'direct'),
        subscribe: vi.fn((next: typeof listener) => { listener = next; return unsubscribe }),
        start: vi.fn(),
      },
      toolRouteStatusBoard: { update: vi.fn() },
      notifyRelayRouteChanged: vi.fn(),
      recheckRoutes: vi.fn(),
    }
    const followToolRoutes = vi.fn(async () => undefined)
    const handles = startToolRouteFollowing(routes as unknown as Pick<NetworkRoutes, 'toolRouteController' | 'toolRouteStatusBoard' | 'notifyRelayRouteChanged' | 'recheckRoutes'>, {
      systemService: { followToolRoutes } as never,
      readAccountSiteId: () => siteId,
    })
    disposers.push(() => clearInterval(handles.routeOnlineTimer))
    return { routes, handles, followToolRoutes, unsubscribe, emit: (snapshot: { line: string, lastChange?: { reason: string } }) => listener?.(snapshot) }
  }

  it('listens for line changes before it starts checking tool routes', () => {
    const { routes, handles, unsubscribe } = follow()
    const [subscribed] = routes.toolRouteController.subscribe.mock.invocationCallOrder
    const [started] = routes.toolRouteController.start.mock.invocationCallOrder
    expect(subscribed).toBeLessThan(started)
    handles.unsubscribeToolRoutes()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('rewrites tool configs only when the line changes, and says whether it changed because of a fault', () => {
    const { routes, followToolRoutes, emit } = follow()
    emit({ line: 'direct' })
    expect(followToolRoutes).not.toHaveBeenCalled()
    emit({ line: 'primary', lastChange: { reason: 'unreachable' } })
    emit({ line: 'direct', lastChange: { reason: 'recovered' } })
    expect(followToolRoutes.mock.calls).toEqual([
      [{ reason: 'route-changed', fault: true }],
      [{ reason: 'route-changed', fault: false }],
    ])
    expect(routes.toolRouteStatusBoard.update).toHaveBeenCalledTimes(3)
    expect(routes.notifyRelayRouteChanged).toHaveBeenCalledTimes(3)
  })

  it('leaves the renderer alone for a history account unless the line changed', () => {
    const { routes, emit } = follow('solov-api')
    emit({ line: 'direct' })
    expect(routes.notifyRelayRouteChanged).not.toHaveBeenCalled()
    emit({ line: 'primary' })
    expect(routes.notifyRelayRouteChanged).toHaveBeenCalledTimes(1)
  })

  it('rechecks routes on wake and when the network comes back', () => {
    vi.useFakeTimers()
    vi.mocked(net.isOnline).mockReturnValue(false)
    const { routes, handles } = follow()
    expect(powerMonitor.on).toHaveBeenCalledWith('resume', handles.onRouteResume)
    handles.onRouteResume()
    expect(routes.recheckRoutes).toHaveBeenLastCalledWith('resume')

    vi.mocked(net.isOnline).mockReturnValue(true)
    vi.advanceTimersByTime(15_000)
    expect(routes.recheckRoutes).toHaveBeenLastCalledWith('network')
    vi.advanceTimersByTime(15_000)
    expect(routes.recheckRoutes).toHaveBeenCalledTimes(2)
  })
})

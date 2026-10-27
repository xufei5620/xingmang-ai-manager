import { describe, expect, it, vi } from 'vitest'
import { createCodexPayloadNoticeBoard } from '../codex-payload-limit'
import { createToolRouteRoutingSnapshot, type RelayEndpointId, type RelayRoutePreferences } from '../relay-sites'
import type { RelayRouteHoldResult } from '../relay-route-controller'
import { codexPayloadRouting, type CodexPayloadWatchOptions } from './codex-payload-watch'

function wiring(options: { siteId?: string; preferences?: RelayRoutePreferences; toolLine?: RelayEndpointId; officialCodex?: boolean; restarted?: boolean } = {}) {
  const calls: string[] = []
  const toolHold = vi.fn(async (_trigger: string): Promise<RelayRouteHoldResult> => 'switched')
  const appHold = vi.fn(async (_siteId: string, _trigger: string): Promise<RelayRouteHoldResult> => 'switched')
  const followToolRoutes = vi.fn(async () => {
    calls.push('follow')
    return { rewritten: ['codex' as const] }
  })
  const noteCodexPayloadRestart = vi.fn(async () => {
    calls.push('restart-hint')
    return options.restarted ?? true
  })
  const notifyRelayRouteChanged = vi.fn()
  const notifyHost = vi.fn()
  const clock = { now: 1_800_000_000_000 }
  const notices = createCodexPayloadNoticeBoard(() => clock.now)
  const routes = {
    toolRouteController: { holdDirect: toolHold },
    relayRouteController: { holdDirect: appHold },
    toolRouting: createToolRouteRoutingSnapshot(
      options.preferences ?? { solov: 'auto', 'solov-api': 'auto' },
      () => ({ 'solov-api': { line: 'primary', settled: true } }),
      () => options.toolLine ?? 'primary',
    ),
    notifyRelayRouteChanged,
  } as unknown as CodexPayloadWatchOptions['routes']
  const routing = codexPayloadRouting({
    readAccountSiteId: () => options.siteId ?? 'solov',
    routes,
    systemService: {
      followToolRoutes,
      noteCodexPayloadRestart,
      readStoredConfig: () => ({ version: 2, ...(options.officialCodex ? { officialProviders: ['codex'] } : {}) }),
    } as unknown as CodexPayloadWatchOptions['systemService'],
    notices,
    notifyHost,
  })
  return { routing, calls, toolHold, appHold, followToolRoutes, noteCodexPayloadRestart, notifyRelayRouteChanged, notifyHost, notices, clock }
}

describe('codex payload watch wiring', () => {
  it('moves the xm tool line and the historical app line', async () => {
    const run = wiring()
    expect(await run.routing.holdDirect('solov', 'payload-too-large')).toBe('switched')
    expect(run.toolHold).toHaveBeenCalledWith('payload-too-large')
    expect(await run.routing.holdDirect('solov-api', 'payload-too-large')).toBe('switched')
    expect(run.appHold).toHaveBeenCalledWith('solov-api', 'payload-too-large')
  })

  it('reads the line written into tool configs and whether Codex is on the account', () => {
    const run = wiring({ preferences: { solov: 'auto', 'solov-api': 'auto' }, toolLine: 'direct' })
    expect(run.routing.preference('solov')).toBe('auto')
    expect(wiring({ preferences: { solov: 'primary' } }).routing.preference('solov')).toBe('primary')
    expect(run.routing.toolLine('solov')).toBe('direct')
    expect(run.routing.toolLine('solov-api')).toBe('primary')
    expect(run.routing.codexOnRelay()).toBe(true)
    expect(wiring({ officialCodex: true }).routing.codexOnRelay()).toBe(false)
  })

  it('waits for the xm Codex config to follow before asking for a restart', async () => {
    const run = wiring()
    expect(await run.routing.followCodex('solov', 'switched')).toBe(true)
    expect(run.followToolRoutes).toHaveBeenCalledWith({ reason: 'payload', providers: ['codex'] })
    expect(run.calls).toEqual(['follow', 'restart-hint'])
    expect(await wiring({ restarted: false }).routing.followCodex('solov', 'already')).toBe(false)
  })

  it('leaves a fresh historical switch to the whole rewrite and asks right away when already on line 2', async () => {
    const run = wiring({ siteId: 'solov-api' })
    expect(await run.routing.followCodex('solov-api', 'switched')).toBe(true)
    expect(run.calls).toEqual([])
    expect(await run.routing.followCodex('solov-api', 'already')).toBe(true)
    expect(run.calls).toEqual(['restart-hint'])
    expect(run.followToolRoutes).not.toHaveBeenCalled()
  })

  it('puts a notice up for the window and as a system notification under its id', () => {
    const run = wiring()
    run.routing.notify('locked')
    expect(run.notices.current()).toEqual({ id: run.clock.now, kind: 'locked' })
    expect(run.notifyRelayRouteChanged).toHaveBeenCalledTimes(1)
    expect(run.notifyHost).toHaveBeenCalledWith('locked', String(run.clock.now))
  })
})

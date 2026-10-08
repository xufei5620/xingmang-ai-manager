import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RelayRouteConclusions } from './relay-route-controller'
import type { RelayEndpointId, RelayRoutePreference } from './relay-sites'
import { parseRouteStatus, type RouteStatus } from './route-status-file'
import {
  createToolRouteController,
  createToolRouteStateStore,
  parseToolRouteState,
  toolRouteCooldownMs,
  toolRouteFailureProbeGapMs,
  toolRouteHongKongAssignable,
  toolRouteIncidentWaitMs,
  toolRouteLegitimateAddresses,
  toolRouteMinSwitchGapMs,
  toolRouteRecheckIntervalMs,
  toolRouteRecoveryProbeIntervalMs,
  toolRouteRecoveryStreak,
  toolRouteSameEntrance,
  type ToolRouteNotice,
  type ToolRouteProbeResult,
  type ToolRouteSnapshot,
  type ToolRouteStoredState,
} from './tool-route-controller'

// RFC 5737 documentation addresses only; none of them is a real xm entrance.
const legitDirect = '192.0.2.10'
const foreign = '203.0.113.50'
const fakeIp = '198.18.0.7'
const cloudflare = '104.16.1.1'
const hourMs = 60 * 60_000
const dayMs = 24 * hourMs
const startedAt = 1_800_000_000_000

const directories: string[] = []

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop() as string, { recursive: true, force: true })
})

function pass(addresses: string[] = [legitDirect]): ToolRouteProbeResult {
  return { ok: true, addresses }
}

function fail(kind: ToolRouteProbeResult['kind'] = 'timeout', addresses: string[] = [legitDirect]): ToolRouteProbeResult {
  return { ok: false, kind, addresses }
}

function status(overrides: Record<string, unknown> = {}): RouteStatus {
  const parsed = parseRouteStatus(JSON.stringify({
    v: 1,
    updated_at: '2026-10-08T00:00:00Z',
    incident: { line: null, state: 'none', since: null },
    lines: { direct: { target: 'lax', proxied: false, healthy: true, legit_ips: [legitDirect] } },
    hk_enabled: false,
    hk_recommended: false,
    ...overrides,
  }))
  if (!parsed) throw new Error('fixture status did not parse')
  return parsed
}

interface FakeTimer {
  callback: () => void
  dueAt: number
  order: number
}

interface HarnessOptions {
  preference?: RelayRoutePreference
  stored?: ToolRouteStoredState | null
  legacy?: RelayRouteConclusions
  status?: RouteStatus | null
  clock?: number
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
}

function harness(options: HarnessOptions = {}) {
  let clock = options.clock ?? startedAt
  let order = 0
  const results: Record<RelayEndpointId, ToolRouteProbeResult> = { direct: pass(), primary: pass([cloudflare]) }
  const probes: RelayEndpointId[] = []
  const statusReads: boolean[] = []
  const timers = new Set<FakeTimer>()
  const writes: ToolRouteStoredState[] = []
  const notices: ToolRouteNotice[] = []
  const snapshots: ToolRouteSnapshot[] = []
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  const routeStatus = { current: options.status === undefined ? null : options.status }
  const controller = createToolRouteController({
    preference: options.preference ?? 'auto',
    readState: () => options.stored ?? null,
    writeState: async (value) => { writes.push(value) },
    readLegacyConclusions: () => options.legacy ?? { lines: {}, changes: {} },
    probe: async (line) => {
      probes.push(line)
      return results[line]
    },
    readStatus: async ({ fresh }) => {
      statusReads.push(fresh)
      return routeStatus.current
    },
    notify: (notice) => { notices.push(notice) },
    schedule(callback, delayMs) {
      const timer = { callback, dueAt: clock + delayMs, order: order++ }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
    now: () => clock,
    log: (_level, event, _message, detail) => { events.push({ event, detail }) },
  })
  controller.subscribe((value) => { snapshots.push(value) })
  return {
    controller,
    results,
    probes,
    statusReads,
    timers,
    writes,
    notices,
    snapshots,
    routeStatus,
    now: () => clock,
    advance(ms: number) { clock += ms },
    events: (event: string) => events.filter((entry) => entry.event === event).map((entry) => entry.detail),
    pendingDelays: () => [...timers].sort((a, b) => a.dueAt - b.dueAt || a.order - b.order).map((timer) => timer.dueAt - clock),
    async fireNext() {
      const [timer] = [...timers].sort((a, b) => a.dueAt - b.dueAt || a.order - b.order)
      if (!timer) throw new Error('no timer pending')
      timers.delete(timer)
      clock = Math.max(clock, timer.dueAt)
      timer.callback()
      await settle()
    },
    async fireUntil(predicate: () => boolean, limit = 50) {
      for (let step = 0; step < limit && !predicate(); step++) await this.fireNext()
      if (!predicate()) throw new Error('condition never reached')
    },
  }
}

type Harness = ReturnType<typeof harness>

async function failDirectThreeRounds(run: Harness): Promise<void> {
  run.results.direct = fail('timeout')
  run.controller.start()
  await settle()
  for (let round = 1; round < 3; round++) {
    expect(run.pendingDelays()[0]).toBe(toolRouteFailureProbeGapMs)
    await run.fireNext()
  }
}

describe('tool route controller', () => {
  it('starts on the stored tool line and only probes when the preference is auto', async () => {
    const stored = harness({ stored: { line: 'primary', failures: {}, notices: {} } })
    expect(stored.controller.line()).toBe('primary')
    const fixed = harness({ preference: 'primary' })
    fixed.controller.start()
    fixed.controller.recheck('manual')
    fixed.controller.reportFailure('ERR_CONNECTION_RESET')
    await settle()
    expect(fixed.controller.snapshot()).toMatchObject({ line: 'primary', automatic: false, lastChange: null })
    expect(fixed.probes).toEqual([])
    expect(fixed.writes).toEqual([])
    expect(harness({ preference: 'direct' }).controller.line()).toBe('direct')
  })

  it('takes the app line conclusion on the first run after upgrading and does not pull a recent fallback back to Los Angeles', async () => {
    const run = harness({
      legacy: {
        lines: { solov: 'primary' },
        changes: { solov: { from: 'direct', to: 'primary', reason: 'health-failed', at: startedAt - hourMs } },
      },
    })
    expect(run.controller.line()).toBe('primary')
    await settle()
    expect(run.writes[0]).toMatchObject({ line: 'primary', failures: { direct: [startedAt - hourMs] } })
    run.controller.start()
    await settle()
    expect(run.controller.line()).toBe('primary')
    expect(run.snapshots).toEqual([])
  })

  it('ignores an old app line change and defaults to Los Angeles without any conclusion', async () => {
    const old = harness({
      legacy: { lines: { solov: 'primary' }, changes: { solov: { from: 'direct', to: 'primary', reason: 'health-failed', at: startedAt - 8 * dayMs } } },
    })
    await settle()
    expect(old.writes[0]).toEqual({ line: 'primary', failures: {}, notices: {} })
    const fresh = harness()
    expect(fresh.controller.line()).toBe('direct')
    await settle()
    expect(fresh.writes[0]).toEqual({ line: 'direct', failures: {}, notices: {} })
  })

  it('downgrades to CF after three failed rounds fifteen seconds apart when the status file is unavailable', async () => {
    const run = harness()
    await failDirectThreeRounds(run)
    expect(run.controller.line()).toBe('primary')
    expect(run.controller.snapshot().lastChange).toMatchObject({ from: 'direct', to: 'primary', reason: 'failed', trigger: 'startup' })
    expect(run.statusReads).toContain(true)
    expect(run.writes.at(-1)).toMatchObject({ line: 'primary', failures: { direct: [run.now()] } })
    expect(run.snapshots.at(-1)).toMatchObject({ line: 'primary', serverSwitching: false, outage: null })
    expect(run.notices).toEqual([])
  })

  it('does not count a slow but progressing probe as a failure', async () => {
    const run = harness()
    run.results.direct = fail('slow')
    run.controller.start()
    await settle()
    expect(run.pendingDelays()).toEqual([toolRouteRecheckIntervalMs])
    run.controller.recheck('manual')
    await settle()
    run.controller.recheck('manual')
    await settle()
    expect(run.controller.line()).toBe('direct')
  })

  it('treats one certificate failure on a foreign address as hijack and notices it at most once a week', async () => {
    const run = harness({ status: status() })
    run.results.direct = fail('certificate', [foreign])
    run.controller.start()
    await settle()
    expect(run.controller.snapshot().lastChange).toMatchObject({ to: 'primary', reason: 'hijack' })
    expect(run.notices).toEqual([{ kind: 'hijack', line: 'direct' }])
    expect(run.writes.at(-1)?.notices.hijack).toBe(run.now())

    const later = harness({ status: status(), stored: { ...run.writes.at(-1)!, line: 'direct' }, clock: run.now() + dayMs })
    later.results.direct = fail('certificate', [foreign])
    later.controller.start()
    await settle()
    expect(later.controller.line()).toBe('primary')
    expect(later.notices).toEqual([])
  })

  it('never judges hijack without legitimate addresses or behind a local proxy takeover', async () => {
    const unknown = harness({ status: null })
    unknown.results.direct = fail('certificate', [foreign])
    unknown.controller.start()
    await settle()
    expect(unknown.controller.line()).toBe('direct')
    expect(unknown.statusReads).toEqual([false, true])

    const proxied = harness({ status: status() })
    proxied.results.direct = fail('certificate', [fakeIp])
    proxied.controller.start()
    await settle()
    expect(proxied.controller.line()).toBe('direct')
    expect(proxied.events('relay.route.check-failed')[0]).toMatchObject({ label: 'proxy', failure: 'certificate' })
  })

  it('waits five minutes from the first failure during a server incident and then only falls back to CF', async () => {
    const run = harness({ status: status({ incident: { line: 'direct', state: 'switching', since: '2026-10-08T00:00:00Z' } }) })
    const firstFailure = run.now()
    await failDirectThreeRounds(run)
    expect(run.controller.line()).toBe('direct')
    expect(run.controller.snapshot().serverSwitching).toBe(true)
    expect(run.snapshots.at(-1)).toMatchObject({ serverSwitching: true })
    expect(run.pendingDelays()[0]).toBe(firstFailure + toolRouteIncidentWaitMs - run.now())
    await run.fireNext()
    expect(run.now()).toBe(firstFailure + toolRouteIncidentWaitMs)
    expect(run.controller.snapshot()).toMatchObject({ line: 'primary', serverSwitching: false })
    expect(run.controller.snapshot().lastChange).toMatchObject({ reason: 'incident' })
  })

  it('keeps the current line when it recovers during the incident wait', async () => {
    const run = harness({ status: status({ incident: { line: 'direct', state: 'suspected', since: null } }) })
    await failDirectThreeRounds(run)
    run.results.direct = pass()
    await run.fireNext()
    expect(run.controller.snapshot()).toMatchObject({ line: 'direct', serverSwitching: false })
    expect(run.pendingDelays()).toEqual([toolRouteRecheckIntervalMs])
  })

  it('goes straight back up to Los Angeles when CF fails and Los Angeles already passes, cooldown or not', async () => {
    const run = harness({ stored: { line: 'primary', failures: { direct: [startedAt - 10 * 60_000, startedAt - 5 * 60_000] }, notices: {} } })
    run.results.primary = fail('reset', [cloudflare])
    run.controller.start()
    await settle()
    await run.fireUntil(() => run.controller.line() === 'direct', 3)
    expect(run.controller.snapshot().lastChange).toMatchObject({ from: 'primary', to: 'direct', reason: 'failed' })
    expect(run.writes.at(-1)?.failures.primary).toEqual([run.now()])
  })

  it('does not switch to a target that failed this round and reports the outage once a day until it recovers', async () => {
    const run = harness()
    run.results.primary = fail('reset', [cloudflare])
    run.results.direct = fail('reset')
    run.controller.start()
    await settle()
    await run.fireNext()
    await run.fireNext()
    expect(run.controller.line()).toBe('direct')
    expect(run.controller.snapshot().outage).toEqual({ reason: 'reset', since: run.now() })
    expect(run.notices).toEqual([{ kind: 'outage', reason: 'reset' }])
    await run.fireUntil(() => run.events('relay.route.unreachable').length === 2)
    expect(run.notices).toHaveLength(1)
    run.results.direct = pass()
    await run.fireNext()
    expect(run.controller.snapshot().outage).toBeNull()
    expect(run.snapshots.at(-1)?.outage).toBeNull()
  })

  it('holds a second switch until five minutes after the previous one', async () => {
    const run = harness({ stored: { line: 'primary', failures: { direct: [startedAt - hourMs] }, notices: {} } })
    run.controller.start()
    await settle()
    await run.fireUntil(() => run.controller.line() === 'direct')
    const switchedAt = run.now()
    run.results.direct = fail('timeout')
    run.controller.reportFailure('ERR_CONNECTION_RESET')
    await settle()
    await run.fireNext()
    await run.fireNext()
    expect(run.controller.line()).toBe('direct')
    expect(run.events('relay.route.held')).toHaveLength(1)
    await run.fireUntil(() => run.controller.line() === 'primary')
    expect(run.now() - switchedAt).toBeGreaterThanOrEqual(toolRouteMinSwitchGapMs)
  })

  it('maps seven-day failure counts to the four cooldown tiers', () => {
    expect([0, 1, 2, 3, 4, 9].map(toolRouteCooldownMs)).toEqual([0, 0, hourMs, 6 * hourMs, 24 * hourMs, 24 * hourMs])
  })

  it('waits out the wall clock cooldown across restarts before probing the higher line again', async () => {
    const lastFailure = startedAt - 20 * 60_000
    const run = harness({ stored: { line: 'primary', failures: { direct: [startedAt - 2 * dayMs, lastFailure] }, notices: {} } })
    run.controller.start()
    await settle()
    expect(run.probes).toEqual(['primary'])
    expect(run.pendingDelays()).toEqual([toolRouteRecheckIntervalMs, lastFailure + hourMs - startedAt])
  })

  it('switches back only after six consecutive passes two minutes apart and starts over after a miss', async () => {
    const run = harness({ stored: { line: 'primary', failures: { direct: [startedAt - 2 * hourMs] }, notices: {} } })
    run.results.direct = pass()
    run.controller.start()
    await settle()
    const recoveryProbes = () => run.probes.filter((line) => line === 'direct').length
    await run.fireUntil(() => recoveryProbes() === 3)
    run.results.direct = fail('timeout')
    await run.fireUntil(() => recoveryProbes() === 4)
    run.results.direct = pass()
    const restartedAt = run.now()
    await run.fireUntil(() => run.controller.line() === 'direct')
    expect(recoveryProbes()).toBe(4 + toolRouteRecoveryStreak)
    expect(run.now() - restartedAt).toBe(toolRouteRecoveryStreak * toolRouteRecoveryProbeIntervalMs)
    expect(run.controller.snapshot().lastChange).toMatchObject({ reason: 'recovered', trigger: 'scheduled' })
    expect(run.writes.at(-1)?.failures.primary).toBeUndefined()
  })

  it('returns within thirty seconds of startup when the higher line has no recent failures', async () => {
    const run = harness({ stored: { line: 'primary', failures: {}, notices: {} } })
    run.controller.start()
    await settle()
    await run.fireUntil(() => run.controller.line() === 'direct')
    expect(run.now() - startedAt).toBeLessThan(30_000)
    expect(run.controller.snapshot().lastChange).toMatchObject({ reason: 'recovered', trigger: 'startup' })

    const missed = harness({ stored: { line: 'primary', failures: {}, notices: {} } })
    missed.results.direct = fail('timeout')
    missed.controller.start()
    await settle()
    expect(missed.pendingDelays()).toEqual([toolRouteRecoveryProbeIntervalMs, toolRouteRecheckIntervalMs])
  })

  it('does not climb back on quit', async () => {
    const run = harness({ stored: { line: 'primary', failures: {}, notices: {} } })
    run.controller.start()
    await settle()
    run.controller.dispose()
    expect(run.timers.size).toBe(0)
    expect(run.controller.line()).toBe('primary')
  })

  it('restarts the recovery streak after the computer wakes up', async () => {
    const run = harness({ stored: { line: 'primary', failures: { direct: [startedAt - 2 * hourMs] }, notices: {} } })
    run.controller.start()
    await settle()
    const recoveryProbes = () => run.probes.filter((line) => line === 'direct').length
    await run.fireUntil(() => recoveryProbes() === toolRouteRecoveryStreak - 1)
    run.controller.recheck('resume')
    await settle()
    await run.fireUntil(() => recoveryProbes() === toolRouteRecoveryStreak)
    expect(run.controller.line()).toBe('primary')
  })

  it('treats a failure stamped in the future as happening now so the cooldown is not cut short', async () => {
    const run = harness({ stored: { line: 'primary', failures: { direct: [startedAt - hourMs, startedAt + 5 * hourMs] }, notices: {} } })
    run.controller.start()
    await settle()
    expect(run.pendingDelays()).toEqual([toolRouteRecheckIntervalMs, hourMs])
  })

  it('rate-limits failures reported by tool checks to one round per thirty seconds', async () => {
    const run = harness()
    run.controller.reportFailure('ERR_CONNECTION_RESET')
    await settle()
    run.controller.reportFailure('ERR_CONNECTION_RESET')
    await settle()
    expect(run.probes).toEqual(['direct'])
    run.advance(30_000)
    run.controller.reportFailure('bad trigger with spaces')
    await settle()
    expect(run.probes).toEqual(['direct', 'direct'])
  })

  it('dedupes Los Angeles and Hong Kong by resolved entrance except for DNS and SNI failures', () => {
    expect(toolRouteSameEntrance(fail('timeout', [legitDirect]), pass([legitDirect]))).toBe(true)
    expect(toolRouteSameEntrance(fail('timeout', [legitDirect]), pass([foreign]))).toBe(false)
    expect(toolRouteSameEntrance(fail('dns', [legitDirect]), pass([legitDirect]))).toBe(false)
    expect(toolRouteSameEntrance(fail('reset', [legitDirect]), pass([legitDirect]))).toBe(false)
    expect(toolRouteSameEntrance(fail('timeout', []), pass([]))).toBe(false)
  })

  it('never assigns Hong Kong in the first batch even when the status file recommends it', () => {
    const recommended = status({ hk_enabled: true, hk_recommended: true })
    expect(toolRouteHongKongAssignable({ status: recommended, incident: false, skillSupportsHongKong: true })).toBe(false)
    expect(toolRouteHongKongAssignable({ status: null, incident: false, skillSupportsHongKong: true })).toBe(false)
  })

  it('picks legitimate addresses per line from the status file', () => {
    expect(toolRouteLegitimateAddresses('primary', null)).toEqual({ cloudflare: true })
    expect(toolRouteLegitimateAddresses('direct', null)).toBeNull()
    expect(toolRouteLegitimateAddresses('direct', status())).toEqual({ cloudflare: false, ips: [legitDirect] })
    const proxied = status({ lines: { direct: { target: 'cf', proxied: true, healthy: true, legit_ips: [] } } })
    expect(toolRouteLegitimateAddresses('direct', proxied)).toEqual({ cloudflare: true })
  })
})

describe('tool route state store', () => {
  function temporaryFile(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-tool-route-'))
    directories.push(directory)
    return path.join(directory, 'tool-route-state.json')
  }

  it('round-trips the state in its own file', async () => {
    const file = temporaryFile()
    const store = createToolRouteStateStore(file)
    expect(store.readState()).toBeNull()
    const value: ToolRouteStoredState = {
      line: 'primary',
      failures: { direct: [startedAt - 2, startedAt - 1] },
      lastChange: { from: 'direct', to: 'primary', reason: 'failed', trigger: 'scheduled', at: startedAt - 1 },
      notices: { hijack: startedAt - 3, outage: { reset: startedAt - 4 } },
    }
    await store.writeState(value)
    expect(store.readState()).toEqual(value)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 1, line: 'primary' })
    expect(fs.readdirSync(path.dirname(file))).toEqual(['tool-route-state.json'])
  })

  it('treats a damaged or foreign file as missing', () => {
    const file = temporaryFile()
    const store = createToolRouteStateStore(file)
    fs.writeFileSync(file, '{not json')
    expect(store.readState()).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ version: 2, line: 'direct' }))
    expect(store.readState()).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ version: 1, line: 'direct-hk' }))
    expect(store.readState()).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ version: 1, line: 'direct', padding: 'x'.repeat(9 * 1024) }))
    expect(store.readState()).toBeNull()
    expect(() => createToolRouteStateStore('relative.json')).toThrow('工具线路状态必须使用绝对路径。')
  })

  it('drops unknown lines, reasons and addresses and caps failure records', () => {
    const parsed = parseToolRouteState(JSON.stringify({
      version: 1,
      line: 'direct',
      address: legitDirect,
      failures: { direct: Array.from({ length: 30 }, (_, index) => startedAt - index), 'direct-hk': [startedAt], primary: ['x', -1] },
      lastChange: { from: 'direct', to: 'direct-hk', reason: 'failed', at: startedAt },
      notices: { hijack: 'soon', outage: { reset: startedAt, other: startedAt } },
    }))
    expect(parsed).toEqual({
      line: 'direct',
      failures: { direct: Array.from({ length: 16 }, (_, index) => startedAt - 15 + index) },
      notices: { outage: { reset: startedAt } },
    })
  })
})

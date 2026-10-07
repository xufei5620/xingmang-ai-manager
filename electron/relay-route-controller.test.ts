import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRelayRouteConclusionStore,
  createRelayRouteController,
  probeRelayLineHealth,
  relayRouteFailureProbeGapMs,
  relayRouteFailureRecheckGapMs,
  relayRouteMinSwitchGapMs,
  relayRouteRecheckIntervalMs,
  relayRouteRecoveryMs,
  relayRouteRecoveryProbeIntervalMs,
  type RelayRouteChange,
  type RelayRouteConclusions,
  type RelayRouteControllerDependencies,
} from './relay-route-controller'
import type { RelayEndpointId, RelayRouteLine, RelayRoutePreference, RelayRouteSiteId } from './relay-sites'

interface FakeTimer {
  callback: () => void
  delayMs: number
}

interface LogEntry {
  level: 'info' | 'warn'
  event: string
  detail: Record<string, unknown>
}

interface HarnessOptions {
  preferences?: Partial<Record<RelayRouteSiteId, RelayRoutePreference>>
  conclusions?: Partial<Record<RelayRouteSiteId, RelayEndpointId>>
  changes?: Partial<Record<RelayRouteSiteId, RelayRouteChange>>
  readConclusions?: RelayRouteControllerDependencies['readConclusions']
  writeConclusions?: RelayRouteControllerDependencies['writeConclusions']
  probe?: RelayRouteControllerDependencies['probe']
}

const directories: string[] = []
const startedAt = 1_000_000
// 切回直连要连着查通几次：头一次到最后一次隔 relayRouteRecoveryMs。
const recoveryProbes = relayRouteRecoveryMs / relayRouteRecoveryProbeIntervalMs + 1

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop() as string, { recursive: true, force: true })
})

// 两个站都写死 primary 时控制器什么都不做；测试只把要测的站改成「自动」。
function harness(options: HarnessOptions = {}) {
  const reachable: Record<RelayEndpointId, boolean> = { direct: true, primary: true }
  const probes: Array<[RelayRouteSiteId, RelayEndpointId]> = []
  const timers = new Set<FakeTimer>()
  const writes: RelayRouteConclusions[] = []
  const logs: LogEntry[] = []
  const changes: Array<[RelayRouteSiteId, RelayRouteLine]> = []
  let clock = startedAt
  const controller = createRelayRouteController({
    preferences: { solov: 'primary', 'solov-api': 'primary', ...options.preferences },
    readConclusions: options.readConclusions ?? (() => ({ lines: { ...options.conclusions }, changes: { ...options.changes } })),
    writeConclusions: options.writeConclusions ?? (async (conclusions) => { writes.push(conclusions) }),
    probe: options.probe ?? (async (siteId, line) => {
      probes.push([siteId, line])
      return reachable[line]
    }),
    schedule(callback, delayMs) {
      const timer = { callback, delayMs }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
    now: () => clock,
    log(level, event, _message, detail) {
      logs.push({ level, event, detail })
    },
  })
  controller.subscribe((siteId, line) => { changes.push([siteId, line]) })
  return {
    controller,
    reachable,
    probes,
    timers,
    writes,
    logs,
    changes,
    now: () => clock,
    advance(ms: number) { clock += ms },
    delays: () => [...timers].map((timer) => timer.delayMs),
    events: (event: string) => logs.filter((entry) => entry.event === event).map((entry) => entry.detail),
    // 一次只放一个到点的计时器，钟跟着走到那一刻：控制器在回调里会再挂新的。
    async fireTimer() {
      const [timer] = timers
      if (!timer) throw new Error('no timer pending')
      timers.delete(timer)
      clock += timer.delayMs
      timer.callback()
      await settle()
    },
  }
}

type Harness = ReturnType<typeof harness>

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setImmediate(resolve))
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function temporaryFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-relay-route-'))
  directories.push(directory)
  return path.join(directory, 'relay-route-lines.json')
}

// 一轮里头一次已经查过（没通）以后，再放两次隔 relayRouteFailureProbeGapMs 的检查，攒够三次。
async function failTwiceMore(run: Harness): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(run.delays()).toEqual([relayRouteFailureProbeGapMs])
    await run.fireTimer()
  }
}

describe('relay route controller', () => {
  it('starts an auto site on its stored conclusion, or unsettled on the default line without one', () => {
    const stored = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    expect(stored.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(stored.controller.route('solov')).toEqual({ line: 'direct', automatic: true })

    const fresh = harness({ preferences: { solov: 'auto', 'solov-api': 'auto' }, conclusions: { solov: 'primary' } })
    expect(fresh.controller.lines()).toEqual({
      solov: { line: 'primary', settled: true },
      'solov-api': { line: 'primary', settled: false },
    })
  })

  it('reports a pinned site as settled on its own line, never probes it and has no last change', async () => {
    const pinned = harness({
      preferences: { solov: 'direct', 'solov-api': 'primary' },
      conclusions: { solov: 'primary', 'solov-api': 'direct' },
      changes: { solov: { from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'scheduled', at: 5 } },
    })
    expect(pinned.controller.lines()).toEqual({
      solov: { line: 'direct', settled: true },
      'solov-api': { line: 'primary', settled: true },
    })
    expect(pinned.controller.route('solov')).toEqual({ line: 'direct', automatic: false })
    expect(pinned.controller.lastChange('solov')).toBeNull()
    pinned.controller.start()
    pinned.controller.reportDirectFailure('solov', 'ECONNRESET')
    await settle()
    expect(pinned.probes).toEqual([])
    expect(pinned.timers.size).toBe(0)
    expect(pinned.changes).toEqual([])
  })

  it('treats an unreadable stored conclusion as none', () => {
    const broken = harness({
      preferences: { solov: 'auto' },
      readConclusions: () => { throw new Error('locked') },
    })
    expect(broken.controller.lines().solov).toEqual({ line: 'primary', settled: false })
    expect(broken.controller.lastChange('solov')).toBeNull()
  })

  it('settles on direct at startup when direct answers, tells subscribers once and stores the line and the change', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'direct']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'direct', settled: true }]])
    const change = { from: 'primary', to: 'direct', reason: 'startup', at: startedAt }
    expect(run.writes).toEqual([{ lines: { solov: 'direct' }, changes: { solov: change } }])
    expect(run.controller.lastChange('solov')).toEqual(change)
    expect(run.events('relay.route.changed')).toEqual([{ siteId: 'solov', from: 'primary', to: 'direct', reason: 'startup' }])
    // 走直连以后隔一阵查一次。
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('stays quiet when the startup check confirms the stored line', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.controller.start()
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('moves to the default line only after direct fails three health checks in a row and the default line answers', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.reachable.direct = false
    run.controller.start()
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    await failTwiceMore(run)

    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'direct'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.events('relay.route.check-failed')).toEqual([1, 2, 3].map((failures) => ({
      siteId: 'solov', line: 'direct', failures, trigger: 'startup',
    })))
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'primary', settled: true }]])
    expect(run.events('relay.route.changed')).toEqual([{
      siteId: 'solov', from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'startup',
    }])
    const change = { from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'startup', at: startedAt + 2 * relayRouteFailureProbeGapMs }
    expect(run.controller.lastChange('solov')).toEqual(change)
    expect(run.writes.at(-1)).toEqual({ lines: { solov: 'primary' }, changes: { solov: change } })
    // 退回以后隔两分钟查一次直连，看能不能切回去。
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  it('settles a site with no stored line on the default line after three failed checks', async () => {
    const run = harness({ preferences: { 'solov-api': 'auto' } })
    run.reachable.direct = false
    run.controller.start()
    await settle()
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: false })
    await failTwiceMore(run)
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toEqual([['solov-api', { line: 'primary', settled: true }]])
    expect(run.events('relay.route.changed')).toEqual([{
      siteId: 'solov-api', from: 'primary', to: 'primary', reason: 'health-failed', trigger: 'startup',
    }])
  })

  it('starts counting again when one check in the round passes', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.reachable.direct = false
    run.controller.start()
    await settle()
    run.reachable.direct = true
    await run.fireTimer()
    expect(run.controller.lines().solov.line).toBe('direct')
    // 这一轮查通了就收工，回到隔一阵查一次。
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])

    run.reachable.direct = false
    run.probes.length = 0
    await run.fireTimer()
    expect(run.controller.lines().solov.line).toBe('direct')
    await failTwiceMore(run)
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'direct'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.events('relay.route.changed')).toEqual([{
      siteId: 'solov', from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'scheduled',
    }])
  })

  it('changes nothing when neither line answers, then settles once a later check gets through', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    run.reachable.direct = false
    run.reachable.primary = false
    run.controller.start()
    await settle()
    await failTwiceMore(run)
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: false })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([])
    expect(run.events('relay.route.unreachable')).toEqual([{ siteId: 'solov', line: 'primary', settled: false, trigger: 'startup' }])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])

    run.reachable.direct = true
    run.probes.length = 0
    await run.fireTimer()
    expect(run.probes).toEqual([['solov', 'direct']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.events('relay.route.changed')).toEqual([{ siteId: 'solov', from: 'primary', to: 'direct', reason: 'startup' }])
  })

  it('stays on direct when the default line does not answer either', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.reachable.direct = false
    run.reachable.primary = false
    run.controller.start()
    await settle()
    await failTwiceMore(run)
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    expect(run.events('relay.route.unreachable')).toEqual([{ siteId: 'solov', line: 'direct', settled: true, trigger: 'startup' }])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('switches back to direct only after it has answered every check for ten minutes', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'primary' } })
    // 开机那一次算头一次。
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'direct']])
    for (let probe = 2; probe < recoveryProbes; probe++) {
      expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
      await run.fireTimer()
    }
    expect(run.controller.lines().solov.line).toBe('primary')

    // 中间一次没通就从头数。
    run.reachable.direct = false
    await run.fireTimer()
    run.reachable.direct = true
    for (let probe = 1; probe < recoveryProbes; probe++) {
      // 电脑睡了一觉、钟跳过去一个钟头，也照样要连着查够次数。
      if (probe === 2) run.advance(60 * 60_000)
      await run.fireTimer()
    }
    expect(run.controller.lines().solov.line).toBe('primary')
    expect(run.changes).toEqual([])

    await run.fireTimer()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'direct', settled: true }]])
    expect(run.events('relay.route.changed')).toEqual([{ siteId: 'solov', from: 'primary', to: 'direct', reason: 'recovered' }])
    expect(run.controller.lastChange('solov')).toEqual({ from: 'primary', to: 'direct', reason: 'recovered', at: run.now() })
    expect(run.writes.at(-1)?.lines).toEqual({ solov: 'direct' })
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('holds a switch that would come too soon after the last one and checks again once the gap is over', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'primary' } })
    run.controller.start()
    await settle()
    for (let probe = 1; probe < recoveryProbes; probe++) await run.fireTimer()
    expect(run.controller.lines().solov.line).toBe('direct')
    const switchedAt = run.now()

    run.reachable.direct = false
    run.controller.reportDirectFailure('solov', 'ERR_CONNECTION_RESET')
    await settle()
    await failTwiceMore(run)
    expect(run.controller.lines().solov.line).toBe('direct')
    const waitMs = switchedAt + relayRouteMinSwitchGapMs - run.now()
    expect(run.events('relay.route.held')).toEqual([{ siteId: 'solov', line: 'direct', waitMs }])
    expect(run.delays()).toEqual([waitMs])

    // 到点重查一轮，还是三次都没通才改。
    run.probes.length = 0
    await run.fireTimer()
    expect(run.controller.lines().solov.line).toBe('direct')
    await failTwiceMore(run)
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'direct'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov.line).toBe('primary')
    expect(run.controller.lastChange('solov')).toMatchObject({ from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'ERR_CONNECTION_RESET' })
  })

  it('checks right away when a request on direct fails, one round at a time and at most once per gap', async () => {
    const pending = deferred<boolean>()
    const probes: Array<[RelayRouteSiteId, RelayEndpointId]> = []
    const answers: Record<RelayEndpointId, () => Promise<boolean>> = {
      direct: () => Promise.resolve(true),
      primary: () => Promise.resolve(true),
    }
    const run = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'direct' },
      probe: (siteId, line) => {
        probes.push([siteId, line])
        return answers[line]()
      },
    })

    // 直连还通：失败只是那一下，线路不改。
    run.controller.reportDirectFailure('solov', 'ECONNRESET')
    await settle()
    expect(probes).toEqual([['solov', 'direct']])
    expect(run.controller.lines().solov.line).toBe('direct')
    expect(run.events('relay.route.direct-failed')).toEqual([{ siteId: 'solov', line: 'direct', reason: 'ECONNRESET' }])

    // 同一阵子里再报不再查。
    run.advance(relayRouteFailureRecheckGapMs - 1)
    run.controller.reportDirectFailure('solov', 'ECONNRESET')
    await settle()
    expect(probes).toHaveLength(1)

    // 过了这一阵再报才查；查着的时候再报也不重复查。
    run.advance(1)
    answers.direct = () => pending.promise
    run.controller.reportDirectFailure('solov', 'ERR_CONNECTION_REFUSED')
    run.advance(relayRouteFailureRecheckGapMs)
    run.controller.reportDirectFailure('solov', 'ERR_NAME_NOT_RESOLVED')
    await settle()
    expect(probes).toEqual([['solov', 'direct'], ['solov', 'direct']])

    // 报上来的只叫这里去查：一次没通不改，照样要连着三次。
    pending.resolve(false)
    await settle()
    expect(run.controller.lines().solov.line).toBe('direct')
    expect(run.changes).toEqual([])
    answers.direct = () => Promise.resolve(false)
    await failTwiceMore(run)
    expect(probes).toEqual([['solov', 'direct'], ['solov', 'direct'], ['solov', 'direct'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.events('relay.route.changed')).toEqual([{
      siteId: 'solov', from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'ERR_CONNECTION_REFUSED',
    }])

    // 已经在默认线路上，再报直连失败没有意义。
    run.advance(relayRouteFailureRecheckGapMs)
    run.controller.reportDirectFailure('solov', 'ECONNRESET')
    await settle()
    expect(probes).toHaveLength(5)
  })

  it('records a reported reason that is not a plain code as a request failure', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.reachable.direct = false
    run.controller.reportDirectFailure('solov', 'C:\\Users\\peaker failed')
    await settle()
    await failTwiceMore(run)
    expect(run.controller.lastChange('solov')?.trigger).toBe('request')
  })

  it('keeps the new line when the conclusion cannot be stored and logs only the error name', async () => {
    const run = harness({
      preferences: { solov: 'auto' },
      writeConclusions: () => Promise.reject(new TypeError('C:\\Users\\peaker\\AppData denied')),
    })
    run.controller.start()
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'direct', settled: true }]])
    expect(run.logs.find((entry) => entry.event === 'relay.route.persist-failed')).toEqual({
      level: 'warn',
      event: 'relay.route.persist-failed',
      detail: { error: 'TypeError' },
    })
  })

  it('stores one conclusion after another so an earlier, slower write never overwrites a later one', async () => {
    const pending: Array<{ conclusions: RelayRouteConclusions; done: () => void }> = []
    const run = harness({
      preferences: { solov: 'auto', 'solov-api': 'auto' },
      writeConclusions: (conclusions) => new Promise<void>((resolve) => { pending.push({ conclusions, done: resolve }) }),
    })
    run.controller.start()
    await settle()
    expect(run.controller.lines()).toEqual({ solov: { line: 'direct', settled: true }, 'solov-api': { line: 'direct', settled: true } })
    expect(pending.map((write) => write.conclusions.lines)).toEqual([{ solov: 'direct' }])
    pending[0]?.done()
    await settle()
    expect(pending.map((write) => write.conclusions.lines)).toEqual([{ solov: 'direct' }, { solov: 'direct', 'solov-api': 'direct' }])
  })

  it('counts a probe that throws as a failed check', async () => {
    const run = harness({
      preferences: { solov: 'auto' },
      probe: async (_siteId, line) => {
        if (line === 'direct') throw new TypeError('fetch failed')
        return true
      },
    })
    run.controller.start()
    await settle()
    await failTwiceMore(run)
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
  })

  it('remembers the last change from an earlier run', () => {
    const change: RelayRouteChange = { from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'scheduled', at: 42 }
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'primary' }, changes: { solov: change } })
    expect(run.controller.lastChange('solov')).toEqual(change)
    expect(run.controller.lastChange('solov-api')).toBeNull()
  })

  it('stops checking and notifying once disposed', async () => {
    const pending = deferred<boolean>()
    const run = harness({ preferences: { solov: 'auto', 'solov-api': 'auto' }, probe: () => pending.promise })
    run.controller.start()
    await settle()
    run.controller.dispose()
    pending.resolve(true)
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: false })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([])

    const failing = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    failing.reachable.direct = false
    failing.controller.start()
    await settle()
    expect(failing.timers.size).toBe(1)
    failing.controller.dispose()
    expect(failing.timers.size).toBe(0)
    failing.advance(relayRouteFailureRecheckGapMs)
    failing.controller.reportDirectFailure('solov', 'ECONNRESET')
    await settle()
    expect(failing.probes).toEqual([['solov', 'direct']])
  })

  it('keeps notifying the other subscribers when one throws, and stops calling one that unsubscribed', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    const removed = vi.fn()
    run.controller.subscribe(() => { throw new Error('renderer gone') })
    const unsubscribe = run.controller.subscribe(removed)
    unsubscribe()
    run.controller.start()
    await settle()
    expect(run.changes).toEqual([['solov', { line: 'direct', settled: true }]])
    expect(removed).not.toHaveBeenCalled()
  })
})

describe('relay route conclusion store', () => {
  const change: RelayRouteChange = { from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'ERR_CONNECTION_RESET', at: 1_760_000_000_000 }

  it('round-trips the stored lines and the last change through a fresh store', async () => {
    const filePath = temporaryFile()
    const conclusions: RelayRouteConclusions = { lines: { solov: 'primary', 'solov-api': 'direct' }, changes: { solov: change } }
    await createRelayRouteConclusionStore(filePath).writeConclusions(conclusions)
    expect(createRelayRouteConclusionStore(filePath).readConclusions()).toEqual(conclusions)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1, ...conclusions })
  })

  it('keeps the earlier layout while nothing has changed yet, and reads a file written by an earlier version', async () => {
    const filePath = temporaryFile()
    const store = createRelayRouteConclusionStore(filePath)
    await store.writeConclusions({ lines: { solov: 'direct' }, changes: {} })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1, lines: { solov: 'direct' } })
    expect(store.readConclusions()).toEqual({ lines: { solov: 'direct' }, changes: {} })
  })

  it('reads a missing, damaged or foreign file as no conclusion', () => {
    const filePath = temporaryFile()
    const store = createRelayRouteConclusionStore(filePath)
    const none = { lines: {}, changes: {} }
    expect(store.readConclusions()).toEqual(none)
    for (const content of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ version: 2, lines: { solov: 'direct' } }),
      JSON.stringify({ version: 1, lines: ['direct'] }),
      JSON.stringify({ version: 1 }),
    ]) {
      fs.writeFileSync(filePath, content)
      expect(store.readConclusions()).toEqual(none)
    }
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, lines: { solov: 'https://evil.example', 'solov-api': 'direct', sub2api: 'direct' } }))
    expect(store.readConclusions()).toEqual({ lines: { 'solov-api': 'direct' }, changes: {} })
  })

  it('drops a damaged change and a trigger that is not a plain code', () => {
    const filePath = temporaryFile()
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      lines: { solov: 'primary' },
      changes: {
        solov: { ...change, trigger: 'C:\\Users\\peaker' },
        'solov-api': { ...change, reason: 'request-failed' },
        sub2api: change,
      },
    }))
    const { trigger: _dropped, ...withoutTrigger } = change
    expect(createRelayRouteConclusionStore(filePath).readConclusions()).toEqual({ lines: { solov: 'primary' }, changes: { solov: withoutTrigger } })
    for (const damaged of [{ ...change, at: -1 }, { ...change, at: 1.5 }, { ...change, to: 'backup' }, 'health-failed']) {
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, lines: {}, changes: { solov: damaged } }))
      expect(createRelayRouteConclusionStore(filePath).readConclusions()).toEqual({ lines: {}, changes: {} })
    }
  })

  it('stores only the known sites, lines and changes', async () => {
    const filePath = temporaryFile()
    const conclusions = {
      lines: { solov: 'backup', 'solov-api': 'direct', sub2api: 'direct' },
      changes: { sub2api: change, solov: { ...change, at: 'yesterday' } },
    } as unknown as RelayRouteConclusions
    await createRelayRouteConclusionStore(filePath).writeConclusions(conclusions)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1, lines: { 'solov-api': 'direct' } })
  })

  it('requires an absolute path', () => {
    expect(() => createRelayRouteConclusionStore('relay-route-lines.json')).toThrow('连接线路结论必须使用绝对路径。')
  })
})

describe('relay line health probe', () => {
  it('counts a 200 JSON answer as reachable and asks without cookies or following redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"success":true,"data":{}}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }))
    await expect(probeRelayLineHealth(fetchImpl, 'https://xm-direct.solov.cc/api/status')).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://xm-direct.solov.cc/api/status')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual', headers: { Accept: 'application/json' } })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('treats a web page, an error status, a redirect or a body that is not JSON as unreachable', async () => {
    const answers = [
      new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response('{"message":"Invalid URL"}', { status: 404, headers: { 'content-type': 'application/json' } }),
      new Response(null, { status: 302, headers: { location: 'https://portal.example/login' } }),
      new Response('"ok"', { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response('<html>', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    for (const answer of answers) {
      await expect(probeRelayLineHealth(async () => answer, 'https://xm-direct.solov.cc/api/status')).resolves.toBe(false)
    }
  })

  it('refuses a plain http address without asking', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(probeRelayLineHealth(fetchImpl, 'http://xm-direct.solov.cc/api/status')).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

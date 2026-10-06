import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRelayRouteConclusionStore,
  createRelayRouteController,
  probeRelayLineHealth,
  relayRouteFailureRecheckGapMs,
  relayRouteRecheckIntervalMs,
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
  conclusions?: Partial<Record<RelayRouteSiteId, RelayEndpointId>> | (() => Partial<Record<RelayRouteSiteId, RelayEndpointId>>)
  writeConclusions?: RelayRouteControllerDependencies['writeConclusions']
  probe?: RelayRouteControllerDependencies['probe']
}

const directories: string[] = []

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop() as string, { recursive: true, force: true })
})

// 两个站都写死 primary 时控制器什么都不做；测试只把要测的站改成「自动」。
function harness(options: HarnessOptions = {}) {
  const reachable: Record<RelayEndpointId, boolean> = { direct: true, primary: true }
  const probes: Array<[RelayRouteSiteId, RelayEndpointId]> = []
  const timers = new Set<FakeTimer>()
  const writes: Array<Partial<Record<RelayRouteSiteId, RelayEndpointId>>> = []
  const logs: LogEntry[] = []
  const changes: Array<[RelayRouteSiteId, RelayRouteLine]> = []
  let clock = 1_000_000
  const conclusions = options.conclusions
  const controller = createRelayRouteController({
    preferences: { solov: 'primary', 'solov-api': 'primary', ...options.preferences },
    readConclusions: typeof conclusions === 'function' ? conclusions : () => ({ ...conclusions }),
    writeConclusions: options.writeConclusions ?? (async (lines) => { writes.push(lines) }),
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
    advance(ms: number) { clock += ms },
    // 一次只放一个到点的计时器：控制器在回调里会再挂新的。
    async fireTimer() {
      const [timer] = timers
      if (!timer) throw new Error('no timer pending')
      timers.delete(timer)
      timer.callback()
      await settle()
    },
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve))
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

  it('reports a pinned site as settled on its own line and never probes it', async () => {
    const pinned = harness({ preferences: { solov: 'direct', 'solov-api': 'primary' }, conclusions: { solov: 'primary', 'solov-api': 'direct' } })
    expect(pinned.controller.lines()).toEqual({
      solov: { line: 'direct', settled: true },
      'solov-api': { line: 'primary', settled: true },
    })
    expect(pinned.controller.route('solov')).toEqual({ line: 'direct', automatic: false })
    pinned.controller.start()
    pinned.controller.reportDirectFailure('solov', 'timeout')
    await settle()
    expect(pinned.probes).toEqual([])
    expect(pinned.timers.size).toBe(0)
    expect(pinned.changes).toEqual([])
  })

  it('treats an unreadable stored conclusion as none', () => {
    const broken = harness({
      preferences: { solov: 'auto' },
      conclusions: () => { throw new Error('locked') },
    })
    expect(broken.controller.lines().solov).toEqual({ line: 'primary', settled: false })
  })

  it('settles on direct at startup when direct answers, tells subscribers once and stores the conclusion', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'direct']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'direct', settled: true }]])
    expect(run.writes).toEqual([{ solov: 'direct' }])
    expect(run.timers.size).toBe(0)
    expect(run.logs).toContainEqual({
      level: 'info',
      event: 'relay.route.changed',
      detail: { siteId: 'solov', from: 'primary', to: 'direct', reason: 'startup' },
    })
  })

  it('stays quiet when the startup check confirms the stored line', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.controller.start()
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([])
  })

  it('falls back to the default line when only the default line answers', async () => {
    const run = harness({ preferences: { solov: 'auto', 'solov-api': 'auto' }, conclusions: { 'solov-api': 'direct' } })
    run.reachable.direct = false
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov-api', 'direct'], ['solov', 'primary'], ['solov-api', 'primary']])
    expect(run.controller.lines()).toEqual({
      solov: { line: 'primary', settled: true },
      'solov-api': { line: 'primary', settled: true },
    })
    expect(run.changes).toEqual([
      ['solov', { line: 'primary', settled: true }],
      ['solov-api', { line: 'primary', settled: true }],
    ])
    expect(run.writes.at(-1)).toEqual({ solov: 'primary', 'solov-api': 'primary' })
    // 退回以后挂着查直连的计时器，每个站一个。
    expect([...run.timers].map((timer) => timer.delayMs)).toEqual([relayRouteRecheckIntervalMs, relayRouteRecheckIntervalMs])
  })

  it('changes nothing when neither line answers and checks again later', async () => {
    const run = harness({ preferences: { solov: 'auto', 'solov-api': 'auto' }, conclusions: { 'solov-api': 'direct' } })
    run.reachable.direct = false
    run.reachable.primary = false
    run.controller.start()
    await settle()
    expect(run.controller.lines()).toEqual({
      solov: { line: 'primary', settled: false },
      'solov-api': { line: 'direct', settled: true },
    })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([])
    expect(run.logs.filter((entry) => entry.event === 'relay.route.unreachable').map((entry) => entry.detail)).toEqual([
      { siteId: 'solov', line: 'primary', settled: false, reason: 'startup' },
      { siteId: 'solov-api', line: 'direct', settled: true, reason: 'startup' },
    ])
    expect([...run.timers].map((timer) => timer.delayMs)).toEqual([relayRouteRecheckIntervalMs, relayRouteRecheckIntervalMs])

    run.reachable.direct = true
    run.probes.length = 0
    await run.fireTimer()
    expect(run.probes).toEqual([['solov', 'direct']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.logs.find((entry) => entry.event === 'relay.route.changed')?.detail).toEqual({
      siteId: 'solov', from: 'primary', to: 'direct', reason: 'retry',
    })
  })

  it('switches back to direct only after two checks in a row pass', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    run.reachable.direct = false
    run.controller.start()
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    run.changes.length = 0

    run.reachable.direct = true
    await run.fireTimer()
    expect(run.controller.lines().solov.line).toBe('primary')
    run.reachable.direct = false
    await run.fireTimer()
    expect(run.controller.lines().solov.line).toBe('primary')
    run.reachable.direct = true
    await run.fireTimer()
    expect(run.controller.lines().solov.line).toBe('primary')
    expect(run.changes).toEqual([])

    await run.fireTimer()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'direct', settled: true }]])
    expect(run.logs.at(-1)).toEqual({
      level: 'info',
      event: 'relay.route.changed',
      detail: { siteId: 'solov', from: 'primary', to: 'direct', reason: 'recovered' },
    })
    expect(run.writes.at(-1)).toEqual({ solov: 'direct' })
    // 回到直连以后不再定时查，等请求报失败再查。
    expect(run.timers.size).toBe(0)
  })

  it('checks again when a request on direct fails, one check at a time and at most once per gap', async () => {
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
    run.controller.reportDirectFailure('solov', 'timeout')
    await settle()
    expect(probes).toEqual([['solov', 'direct']])
    expect(run.controller.lines().solov.line).toBe('direct')
    expect(run.logs.find((entry) => entry.event === 'relay.route.direct-failed')?.detail).toEqual({ siteId: 'solov', reason: 'timeout' })

    // 同一阵子里再报不再查。
    run.advance(relayRouteFailureRecheckGapMs - 1)
    run.controller.reportDirectFailure('solov', 'refused')
    await settle()
    expect(probes).toHaveLength(1)

    // 过了这一阵再报才查；查着的时候再报也不重复查。
    run.advance(1)
    answers.direct = () => pending.promise
    run.controller.reportDirectFailure('solov', 'refused')
    run.advance(relayRouteFailureRecheckGapMs)
    run.controller.reportDirectFailure('solov', 'refused')
    await settle()
    expect(probes).toEqual([['solov', 'direct'], ['solov', 'direct']])

    pending.resolve(false)
    await settle()
    expect(probes).toEqual([['solov', 'direct'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'primary', settled: true }]])
    expect(run.logs.find((entry) => entry.event === 'relay.route.changed')?.detail).toEqual({
      siteId: 'solov', from: 'direct', to: 'primary', reason: 'request-failed',
    })

    // 已经在默认线路上，再报直连失败没有意义。
    run.advance(relayRouteFailureRecheckGapMs)
    run.controller.reportDirectFailure('solov', 'timeout')
    await settle()
    expect(probes).toHaveLength(3)
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

  it('treats a probe that throws as unreachable', async () => {
    const run = harness({
      preferences: { solov: 'auto' },
      probe: async (_siteId, line) => {
        if (line === 'direct') throw new TypeError('fetch failed')
        return true
      },
    })
    run.controller.start()
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
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

    const fallen = harness({ preferences: { solov: 'auto' } })
    fallen.reachable.direct = false
    fallen.controller.start()
    await settle()
    expect(fallen.timers.size).toBe(1)
    fallen.controller.dispose()
    expect(fallen.timers.size).toBe(0)
    fallen.controller.reportDirectFailure('solov', 'timeout')
    await settle()
    expect(fallen.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
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
  it('round-trips the stored lines through a fresh store', async () => {
    const filePath = temporaryFile()
    await createRelayRouteConclusionStore(filePath).writeConclusions({ solov: 'direct', 'solov-api': 'primary' })
    expect(createRelayRouteConclusionStore(filePath).readConclusions()).toEqual({ solov: 'direct', 'solov-api': 'primary' })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1, lines: { solov: 'direct', 'solov-api': 'primary' } })
  })

  it('reads a missing, damaged or foreign file as no conclusion', () => {
    const filePath = temporaryFile()
    const store = createRelayRouteConclusionStore(filePath)
    expect(store.readConclusions()).toEqual({})
    for (const content of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ version: 2, lines: { solov: 'direct' } }),
      JSON.stringify({ version: 1, lines: ['direct'] }),
      JSON.stringify({ version: 1 }),
    ]) {
      fs.writeFileSync(filePath, content)
      expect(store.readConclusions()).toEqual({})
    }
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, lines: { solov: 'https://evil.example', 'solov-api': 'direct', sub2api: 'direct' } }))
    expect(store.readConclusions()).toEqual({ 'solov-api': 'direct' })
  })

  it('stores only the known sites and lines', async () => {
    const filePath = temporaryFile()
    const lines = { solov: 'backup', 'solov-api': 'direct', sub2api: 'direct' } as unknown as Partial<Record<RelayRouteSiteId, RelayEndpointId>>
    await createRelayRouteConclusionStore(filePath).writeConclusions(lines)
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

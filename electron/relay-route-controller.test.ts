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
  relayRouteFirstLaunchPreferDirectMs,
  relayRouteLineDownConfirmMs,
  relayRouteMinSwitchGapMs,
  relayRouteNetworkSettleMs,
  relayRouteRecheckIntervalMs,
  relayRouteRecoveryMs,
  relayRouteRecoveryProbeIntervalMs,
  relayRouteRequestFailureThreshold,
  relayRouteRequestFailureWindowMs,
  requestFailuresTrigger,
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
    // 放挂着的那个这么长的计时器：两条一起查里再查一次前的等待、唤醒以后等网络稳下来那一下。
    async fireTimerOf(delayMs: number) {
      const timer = [...timers].find((pending) => pending.delayMs === delayMs)
      if (!timer) throw new Error(`no ${delayMs} ms timer pending`)
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
  it('starts an auto site on its stored conclusion; without one xm is settled on direct and the historical site waits on the default line', () => {
    const backToDefault: RelayRouteChange = { from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'scheduled', at: 5 }
    const stored = harness({
      preferences: { solov: 'auto', 'solov-api': 'auto' },
      conclusions: { solov: 'primary', 'solov-api': 'primary' },
      changes: { 'solov-api': backToDefault },
    })
    expect(stored.controller.lines()).toEqual({
      solov: { line: 'primary', settled: true },
      'solov-api': { line: 'primary', settled: true },
    })
    expect(stored.controller.lastChange('solov-api')).toEqual(backToDefault)
    expect(stored.controller.route('solov')).toEqual({ line: 'primary', automatic: true })

    const fresh = harness({ preferences: { solov: 'auto', 'solov-api': 'auto' } })
    expect(fresh.controller.lines()).toEqual({
      solov: { line: 'direct', settled: true },
      'solov-api': { line: 'primary', settled: false },
    })
    expect(fresh.controller.route('solov')).toEqual({ line: 'direct', automatic: true })
    expect(fresh.controller.lastChange('solov')).toBeNull()
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
    pinned.controller.reportFailure('solov', 'direct', 'ECONNRESET')
    await settle()
    expect(pinned.probes).toEqual([])
    expect(pinned.timers.size).toBe(0)
    expect(pinned.changes).toEqual([])
  })

  it('treats an unreadable stored conclusion as none', () => {
    const broken = harness({
      preferences: { solov: 'auto', 'solov-api': 'auto' },
      readConclusions: () => { throw new Error('locked') },
    })
    expect(broken.controller.lines()).toEqual({
      solov: { line: 'direct', settled: true },
      'solov-api': { line: 'primary', settled: false },
    })
    expect(broken.controller.lastChange('solov')).toBeNull()
  })

  // 历史账号先走默认线路（api 的 CF），直连备用（yoyo 10-14）。
  it('settles the historical site on the default line at startup when it answers, never asking direct, and stores the line and the change', async () => {
    const run = harness({ preferences: { 'solov-api': 'auto' } })
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov-api', 'primary']])
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: true })
    // 定下来了要叫一声：工具配置按定下的线路迁（0.2.18 写在直连上的迁回默认线路）。
    expect(run.changes).toEqual([['solov-api', { line: 'primary', settled: true }]])
    const change = { from: 'primary', to: 'primary', reason: 'startup', at: startedAt }
    expect(run.writes).toEqual([{ lines: { 'solov-api': 'primary' }, changes: { 'solov-api': change } }])
    expect(run.controller.lastChange('solov-api')).toEqual(change)
    expect(run.events('relay.route.changed')).toEqual([{ siteId: 'solov-api', from: 'primary', to: 'primary', reason: 'startup' }])
    // 走着先走的那条，隔一阵查一次。
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('drops a historical direct conclusion stored under the old direct-first rule and starts again on the default line', async () => {
    for (const reason of ['startup', 'recovered'] as const) {
      const run = harness({
        preferences: { 'solov-api': 'auto' },
        conclusions: { 'solov-api': 'direct' },
        changes: { 'solov-api': { from: 'primary', to: 'direct', reason, at: 5 } },
      })
      expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: false })
      expect(run.controller.lastChange('solov-api')).toBeNull()
      run.controller.start()
      await settle()
      expect(run.probes).toEqual([['solov-api', 'primary']])
      expect(run.changes).toEqual([['solov-api', { line: 'primary', settled: true }]])
      expect(run.writes.at(-1)).toEqual({
        lines: { 'solov-api': 'primary' },
        changes: { 'solov-api': { from: 'primary', to: 'primary', reason: 'startup', at: startedAt } },
      })
    }
    // 只存了线路、没有切换记录的也是旧规矩存的。
    const bare = harness({ preferences: { 'solov-api': 'auto' }, conclusions: { 'solov-api': 'direct' } })
    expect(bare.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: false })
  })

  it('keeps a historical direct conclusion reached because the default line failed, and keeps xm direct conclusions as they are', () => {
    const fellBack: RelayRouteChange = { from: 'primary', to: 'direct', reason: 'health-failed', trigger: 'scheduled', at: 5 }
    const run = harness({
      preferences: { solov: 'auto', 'solov-api': 'auto' },
      conclusions: { solov: 'direct', 'solov-api': 'direct' },
      changes: { 'solov-api': fellBack },
    })
    expect(run.controller.lines()).toEqual({
      solov: { line: 'direct', settled: true },
      'solov-api': { line: 'direct', settled: true },
    })
    expect(run.controller.lastChange('solov-api')).toEqual(fellBack)

    // 两条一起查时当场换到直连的（#1053）也是默认线路连不上退过去的。
    const lineDown: RelayRouteChange = { from: 'primary', to: 'direct', reason: 'line-down', trigger: 'network', at: 5 }
    const switched = harness({
      preferences: { 'solov-api': 'auto' },
      conclusions: { 'solov-api': 'direct' },
      changes: { 'solov-api': lineDown },
    })
    expect(switched.controller.lines()['solov-api']).toEqual({ line: 'direct', settled: true })
    expect(switched.controller.lastChange('solov-api')).toEqual(lineDown)
  })

  it('moves the historical site to direct only after the default line fails three checks in a row and direct answers', async () => {
    const run = harness({ preferences: { 'solov-api': 'auto' } })
    run.reachable.primary = false
    run.controller.start()
    await settle()
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: false })
    await failTwiceMore(run)
    expect(run.probes).toEqual([['solov-api', 'primary'], ['solov-api', 'primary'], ['solov-api', 'primary'], ['solov-api', 'direct']])
    expect(run.events('relay.route.check-failed')).toEqual([1, 2, 3].map((failures) => ({
      siteId: 'solov-api', line: 'primary', failures, trigger: 'startup',
    })))
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([['solov-api', { line: 'direct', settled: true }]])
    expect(run.events('relay.route.changed')).toEqual([{
      siteId: 'solov-api', from: 'primary', to: 'direct', reason: 'health-failed', trigger: 'startup',
    }])
    expect(run.writes.at(-1)?.lines).toEqual({ 'solov-api': 'direct' })
    // 退到直连以后隔两分钟查一次默认线路，看能不能切回去。
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  it('switches the historical site back to the default line only after it has answered every check for ten minutes', async () => {
    const run = harness({
      preferences: { 'solov-api': 'auto' },
      conclusions: { 'solov-api': 'direct' },
      changes: { 'solov-api': { from: 'primary', to: 'direct', reason: 'health-failed', at: 5 } },
    })
    run.controller.start()
    await settle()
    // 开机两条一起查：走着的直连先查，默认线路查通算切回去的头一次。
    expect(run.probes).toEqual([['solov-api', 'direct'], ['solov-api', 'primary']])
    for (let probe = 1; probe < recoveryProbes; probe++) {
      expect(run.controller.lines()['solov-api'].line).toBe('direct')
      await run.fireTimer()
    }
    expect(run.probes.slice(2).every(([, line]) => line === 'primary')).toBe(true)
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: true })
    expect(run.events('relay.route.changed')).toEqual([{ siteId: 'solov-api', from: 'direct', to: 'primary', reason: 'recovered' }])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('checks the historical default line right away when a request on it fails, and ignores reports once it is on direct', async () => {
    const run = harness({ preferences: { 'solov-api': 'auto' }, conclusions: { 'solov-api': 'primary' } })
    run.controller.reportFailure('solov-api', 'primary', 'ECONNRESET')
    await settle()
    expect(run.probes).toEqual([['solov-api', 'primary']])
    expect(run.events('relay.route.direct-failed')).toEqual([{ siteId: 'solov-api', line: 'primary', reason: 'ECONNRESET' }])

    const onDirect = harness({
      preferences: { 'solov-api': 'auto' },
      conclusions: { 'solov-api': 'direct' },
      changes: { 'solov-api': { from: 'primary', to: 'direct', reason: 'health-failed', at: 5 } },
    })
    onDirect.controller.reportFailure('solov-api', 'primary', 'ECONNRESET')
    await settle()
    expect(onDirect.probes).toEqual([])
  })

  // 全新安装开机那一轮两条一起查（#963）；直连查通照旧走直连、不叫订阅方，但要把它存成结论，
  // 下次开机就不再当全新安装。
  it('keeps xm on direct at startup without a stored conclusion and stores direct once it answers', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([{ lines: { solov: 'direct' }, changes: {} }])
    expect(run.controller.lastChange('solov')).toBeNull()
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('treats a machine that stored xm on direct as no longer new on the next launch', async () => {
    const first = harness({ preferences: { solov: 'auto' } })
    first.controller.start()
    await settle()
    const stored = first.writes.at(-1)?.lines

    const next = harness({ preferences: { solov: 'auto' }, conclusions: stored })
    next.controller.start()
    await settle()
    expect(next.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(next.writes).toEqual([])
    // 有了结论，开机以后定时查照三次阈值：头一次没通只等下一次，不去查默认线路。
    next.reachable.direct = false
    next.probes.length = 0
    await next.fireTimer()
    expect(next.probes).toEqual([['solov', 'direct']])
    expect(next.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(next.delays()).toEqual([relayRouteFailureProbeGapMs])
    expect(next.events('relay.route.first-launch')).toEqual([])
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
    run.controller.start()
    await settle()
    run.reachable.direct = false
    run.probes.length = 0
    await run.fireTimer()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    await failTwiceMore(run)

    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'direct'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.events('relay.route.check-failed')).toEqual([1, 2, 3].map((failures) => ({
      siteId: 'solov', line: 'direct', failures, trigger: 'scheduled',
    })))
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'primary', settled: true }]])
    expect(run.events('relay.route.changed')).toEqual([{
      siteId: 'solov', from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'scheduled',
    }])
    const change = {
      from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'scheduled',
      at: startedAt + relayRouteRecheckIntervalMs + 2 * relayRouteFailureProbeGapMs,
    }
    expect(run.controller.lastChange('solov')).toEqual(change)
    expect(run.writes.at(-1)).toEqual({ lines: { solov: 'primary' }, changes: { solov: change } })
    // 退回以后隔两分钟查一次直连，看能不能切回去。
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  // 全新安装不等那三次：没有结论就没有可横跳的对象，而新用户的注册就在开机后这几十秒里（#963）。
  it('moves xm without a stored conclusion to the default line as soon as direct fails the first check', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    run.reachable.direct = false
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'primary', settled: true }]])
    expect(run.events('relay.route.first-launch')).toEqual([{ siteId: 'solov', line: 'primary', trigger: 'startup' }])
    const change = { from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'first-launch', at: startedAt }
    expect(run.controller.lastChange('solov')).toEqual(change)
    expect(run.writes).toEqual([{ lines: { solov: 'primary' }, changes: { solov: change } }])
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  it('settles xm on the default line when it answers and direct has not answered within the wait', async () => {
    const direct = deferred<boolean>()
    const probes: RelayEndpointId[] = []
    const run = harness({
      preferences: { solov: 'auto' },
      probe: (_siteId, line) => {
        probes.push(line)
        return line === 'direct' ? direct.promise : Promise.resolve(true)
      },
    })
    run.controller.start()
    await settle()
    expect(probes).toEqual(['direct', 'primary'])
    // 默认线路查通了也先等直连一会儿：两条都通时要的是直连。
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.delays()).toEqual([relayRouteFirstLaunchPreferDirectMs])
    await run.fireTimer()
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'primary', settled: true }]])

    // 直连晚回来了也不切回去，交给切回的规矩（连续 10 分钟查得通）。
    direct.resolve(true)
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toHaveLength(1)
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  it('keeps xm on direct when both lines answer, whichever answers first', async () => {
    const direct = deferred<boolean>()
    const run = harness({
      preferences: { solov: 'auto' },
      probe: (_siteId, line) => line === 'direct' ? direct.promise : Promise.resolve(true),
    })
    run.controller.start()
    await settle()
    direct.resolve(true)
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    // 等的那一下撤掉了，只剩走直连以后隔一阵查一次。
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('changes nothing for a new machine when neither line answers and checks both again on the next round', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    run.reachable.direct = false
    run.reachable.primary = false
    run.controller.start()
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])

    run.reachable.primary = true
    run.probes.length = 0
    await run.fireTimer()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
  })

  // 「不等三次」只给开机那一轮。定下过一条线路之后，这次运行里后面的检查照常守三次阈值——
  // 否则这台机器就永久失去了防横跳的保护。
  it('goes back to the three-check rule once the first launch has settled a line', async () => {
    const run = harness({ preferences: { solov: 'auto' } })
    run.controller.start()
    await settle()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })

    run.reachable.direct = false
    run.probes.length = 0
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
    await run.fireTimer()
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    await failTwiceMore(run)
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'direct'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
  })

  it('starts counting again when one check in the round passes', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.controller.start()
    await settle()
    run.reachable.direct = false
    await run.fireTimer()
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
    const run = harness({ preferences: { 'solov-api': 'auto' } })
    run.reachable.direct = false
    run.reachable.primary = false
    run.controller.start()
    await settle()
    await failTwiceMore(run)
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: false })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([])
    expect(run.events('relay.route.unreachable')).toEqual([{ siteId: 'solov-api', line: 'primary', settled: false, trigger: 'startup' }])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])

    run.reachable.primary = true
    run.probes.length = 0
    await run.fireTimer()
    expect(run.probes).toEqual([['solov-api', 'primary']])
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: true })
    expect(run.events('relay.route.changed')).toEqual([{ siteId: 'solov-api', from: 'primary', to: 'primary', reason: 'startup' }])
  })

  it('stays on direct when the default line does not answer either', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.reachable.direct = false
    run.reachable.primary = false
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.events('relay.route.unreachable')).toEqual([{ siteId: 'solov', line: 'direct', settled: true, trigger: 'startup' }])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])

    // 定时查那一轮照三次阈值，查完两条还是都不通，照样不改。
    await run.fireTimer()
    await failTwiceMore(run)
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    expect(run.events('relay.route.unreachable').at(-1)).toEqual({ siteId: 'solov', line: 'direct', settled: true, trigger: 'scheduled' })
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('switches back to direct only after it has answered every check for ten minutes', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'primary' } })
    // 开机两条一起查，直连查通算头一次。
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'primary'], ['solov', 'direct']])
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
    run.controller.reportFailure('solov', 'direct', 'ERR_CONNECTION_RESET')
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

  it('waits one gap at most when the clock was turned back after the last switch', async () => {
    const run = harness({ preferences: { 'solov-api': 'auto' } })
    run.controller.start()
    await settle()
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: true })

    // 系统对时把钟往回拨了三个钟头，接着默认线路坏了。
    run.advance(-3 * 60 * 60_000)
    run.reachable.primary = false
    run.controller.reportFailure('solov-api', 'primary', 'ECONNRESET')
    await settle()
    await failTwiceMore(run)
    expect(run.events('relay.route.held')).toEqual([{ siteId: 'solov-api', line: 'primary', waitMs: relayRouteMinSwitchGapMs }])

    await run.fireTimer()
    await failTwiceMore(run)
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'direct', settled: true })
    expect(run.events('relay.route.held')).toHaveLength(1)
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
    run.controller.reportFailure('solov', 'direct', 'ECONNRESET')
    await settle()
    expect(probes).toEqual([['solov', 'direct']])
    expect(run.controller.lines().solov.line).toBe('direct')
    expect(run.events('relay.route.direct-failed')).toEqual([{ siteId: 'solov', line: 'direct', reason: 'ECONNRESET' }])

    // 同一阵子里再报不再查。
    run.advance(relayRouteFailureRecheckGapMs - 1)
    run.controller.reportFailure('solov', 'direct', 'ECONNRESET')
    await settle()
    expect(probes).toHaveLength(1)

    // 过了这一阵再报才查；查着的时候再报也不重复查。
    run.advance(1)
    answers.direct = () => pending.promise
    run.controller.reportFailure('solov', 'direct', 'ERR_CONNECTION_REFUSED')
    run.advance(relayRouteFailureRecheckGapMs)
    run.controller.reportFailure('solov', 'direct', 'ERR_NAME_NOT_RESOLVED')
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
    run.controller.reportFailure('solov', 'direct', 'ECONNRESET')
    await settle()
    expect(probes).toHaveLength(5)
  })

  // 直连被限速、长连接被掐：健康检查只拉几 KB，照样查得通，AI 回复却次次断在半路（#1157 第 1 条）。
  it('moves off the line it prefers when its requests keep breaking off although its health check passes', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.controller.reportFailure('solov', 'direct', 'body')
    await settle()
    expect(run.probes).toEqual([['solov', 'direct']])
    run.advance(60_000)
    run.controller.reportFailure('solov', 'direct', 'no-answer')
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'direct']])
    expect(run.controller.lines().solov.line).toBe('direct')

    // 第三次：不再查直连自己（它照样查得通），只查备用那条，通了就换。
    run.advance(10_000)
    run.controller.reportFailure('solov', 'direct', 'body')
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.events('relay.route.requests-failed')).toEqual([{
      siteId: 'solov', line: 'direct', failures: relayRouteRequestFailureThreshold, windowMs: relayRouteRequestFailureWindowMs,
    }])
    expect(run.events('relay.route.changed')).toEqual([{ siteId: 'solov', from: 'direct', to: 'primary', reason: 'health-failed', trigger: requestFailuresTrigger }])
    expect(run.controller.lastChange('solov')).toMatchObject({ from: 'direct', to: 'primary', reason: 'health-failed', trigger: requestFailuresTrigger })
    // 切回去照旧要连着查通 10 分钟。
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  it('does the same for the historical account, which prefers line 1', async () => {
    const run = harness({ preferences: { 'solov-api': 'auto' }, conclusions: { 'solov-api': 'primary' } })
    for (let index = 0; index < relayRouteRequestFailureThreshold; index++) {
      run.controller.reportFailure('solov-api', 'primary', 'body')
      await settle()
      run.advance(10_000)
    }
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'direct', settled: true })
    expect(run.controller.lastChange('solov-api')).toMatchObject({ from: 'primary', to: 'direct', reason: 'health-failed', trigger: requestFailuresTrigger })
  })

  it('counts only replies cut midway and missing answers, and only when they come close together', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    // 连不上一类的失败健康检查查得出来，照旧只叫这里查一轮，不攒。
    for (const reason of ['ECONNRESET', 'ERR_CONNECTION_REFUSED', 'intercepted', 'http-502']) {
      run.controller.reportFailure('solov', 'direct', reason)
      await settle()
      run.advance(relayRouteFailureRecheckGapMs)
    }
    // 隔得太开的连不成一段。
    for (let index = 0; index < 4; index++) {
      run.controller.reportFailure('solov', 'direct', 'body')
      await settle()
      run.advance(relayRouteRequestFailureWindowMs / 2)
    }
    expect(run.events('relay.route.requests-failed')).toEqual([])
    expect(run.probes.every(([, line]) => line === 'direct')).toBe(true)
    expect(run.controller.lines().solov.line).toBe('direct')
  })

  it('stays on the line it prefers when the other one is down too, and counts again from nothing', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.reachable.primary = false
    for (let index = 0; index < relayRouteRequestFailureThreshold; index++) {
      run.controller.reportFailure('solov', 'direct', 'body')
      await settle()
      run.advance(10_000)
    }
    expect(run.controller.lines().solov.line).toBe('direct')
    expect(run.events('relay.route.unreachable')).toEqual([{ siteId: 'solov', line: 'direct', settled: true, trigger: requestFailuresTrigger }])

    // 攒下的已经用掉：再报一次只照常查一轮直连。
    run.advance(relayRouteFailureRecheckGapMs)
    run.controller.reportFailure('solov', 'direct', 'body')
    await settle()
    expect(run.probes.slice(-2)).toEqual([['solov', 'primary'], ['solov', 'direct']])
    expect(run.events('relay.route.requests-failed')).toHaveLength(1)
  })

  // 退到备用那条以后它上面的请求没走通本来就两条一起查（#1053），不攒；切回先走的那条照旧要连着查通 10 分钟。
  it('does not count requests on the backup line', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'primary' } })
    for (let index = 0; index < relayRouteRequestFailureThreshold + 1; index++) {
      run.controller.reportFailure('solov', 'primary', 'body')
      await settle()
      run.advance(relayRouteFailureRecheckGapMs)
    }
    expect(run.events('relay.route.requests-failed')).toEqual([])
    expect(run.controller.lines().solov.line).toBe('primary')
    expect(run.changes).toEqual([])
  })

  it('waits for a check still out, then acts on the next failure, and drops a round waiting between its checks', async () => {
    const pending = deferred<boolean>()
    const probes: Array<[RelayRouteSiteId, RelayEndpointId]> = []
    const run = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'direct' },
      probe: (siteId, line) => {
        probes.push([siteId, line])
        return probes.length === 1 ? pending.promise : Promise.resolve(line === 'primary')
      },
    })
    for (let index = 0; index < relayRouteRequestFailureThreshold; index++) {
      run.controller.reportFailure('solov', 'direct', 'body')
      run.advance(10_000)
    }
    await settle()
    expect(probes).toEqual([['solov', 'direct']])

    // 那次查回来没通：这一轮等着隔 15 秒再查。下一次请求失败不等它，直接查备用那条。
    pending.resolve(false)
    await settle()
    expect(run.delays()).toEqual([relayRouteFailureProbeGapMs])
    run.controller.reportFailure('solov', 'direct', 'no-answer')
    await settle()
    expect(probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov.line).toBe('primary')
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  it('records a reported reason that is not a plain code as a request failure', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.reachable.direct = false
    run.controller.reportFailure('solov', 'direct', 'C:\\Users\\peaker failed')
    await settle()
    await failTwiceMore(run)
    expect(run.controller.lastChange('solov')?.trigger).toBe('request')
  })

  it('keeps the new line when the conclusion cannot be stored and logs only the error name', async () => {
    const run = harness({
      preferences: { 'solov-api': 'auto' },
      writeConclusions: () => Promise.reject(new TypeError('C:\\Users\\peaker\\AppData denied')),
    })
    run.controller.start()
    await settle()
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toEqual([['solov-api', { line: 'primary', settled: true }]])
    expect(run.logs.find((entry) => entry.event === 'relay.route.persist-failed')).toEqual({
      level: 'warn',
      event: 'relay.route.persist-failed',
      detail: { error: 'TypeError' },
    })
  })

  it('stores xm on direct once its own check answers, though xm itself never switched', async () => {
    const run = harness({ preferences: { solov: 'auto', 'solov-api': 'auto' } })
    run.controller.start()
    await settle()
    expect(run.controller.lines()).toEqual({ solov: { line: 'direct', settled: true }, 'solov-api': { line: 'primary', settled: true } })
    expect(run.writes.map((write) => write.lines)).toEqual([{ 'solov-api': 'primary' }, { solov: 'direct', 'solov-api': 'primary' }])
    expect(run.changes).toEqual([['solov-api', { line: 'primary', settled: true }]])
  })

  // 开机先定的直连还没查过：历史账号先存结论时不能把它一起存下，否则下次开机就当它查过了。
  it('does not store the unchecked xm line when the historical site stores its conclusion first', async () => {
    const solovDirect = deferred<boolean>()
    const run = harness({
      preferences: { solov: 'auto', 'solov-api': 'auto' },
      probe: (siteId, line) => siteId === 'solov' && line === 'direct' ? solovDirect.promise : Promise.resolve(true),
    })
    run.controller.start()
    await settle()
    expect(run.writes.map((write) => write.lines)).toEqual([{ 'solov-api': 'primary' }])
    solovDirect.resolve(true)
    await settle()
    expect(run.writes.map((write) => write.lines).at(-1)).toEqual({ solov: 'direct', 'solov-api': 'primary' })
  })

  it('stores one conclusion after another so an earlier, slower write never overwrites a later one', async () => {
    const pending: Array<{ conclusions: RelayRouteConclusions; done: () => void }> = []
    const run = harness({
      preferences: { 'solov-api': 'auto' },
      writeConclusions: (conclusions) => new Promise<void>((resolve) => { pending.push({ conclusions, done: resolve }) }),
    })
    run.controller.start()
    await settle()
    expect(pending.map((write) => write.conclusions.lines)).toEqual([{ 'solov-api': 'primary' }])

    // 默认线路接着就坏了：离开机那次切换不够 5 分钟，到点再查一轮才改，这时头一份还没写完。
    run.reachable.primary = false
    run.controller.reportFailure('solov-api', 'primary', 'ECONNRESET')
    await settle()
    await failTwiceMore(run)
    await run.fireTimer()
    await failTwiceMore(run)
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'direct', settled: true })
    expect(pending.map((write) => write.conclusions.lines)).toEqual([{ 'solov-api': 'primary' }])
    pending[0]?.done()
    await settle()
    expect(pending.map((write) => write.conclusions.lines)).toEqual([{ 'solov-api': 'primary' }, { 'solov-api': 'direct' }])
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
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })

    // 有结论的机器开机两条一起查，抛错的也当没通。
    const stored = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'direct' },
      probe: async (_siteId, line) => {
        if (line === 'direct') throw new TypeError('fetch failed')
        return true
      },
    })
    stored.controller.start()
    await settle()
    await stored.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(stored.controller.lines().solov).toEqual({ line: 'primary', settled: true })

    // 定时查那一轮照三次阈值数。
    let broken = false
    const scheduled = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'direct' },
      probe: async (_siteId, line) => {
        if (line === 'direct' && broken) throw new TypeError('fetch failed')
        return true
      },
    })
    scheduled.controller.start()
    await settle()
    broken = true
    await scheduled.fireTimer()
    await failTwiceMore(scheduled)
    expect(scheduled.controller.lines().solov).toEqual({ line: 'primary', settled: true })
  })

  // #1053：开机（有结论时）两条一起查，走着的那条不通、另一条通，隔几秒再查一次走着的那条，还不通就换，
  // 不等三次（#1156）。
  it('switches a stored line when the startup check finds it down twice and the other line up', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.reachable.direct = false
    run.controller.start()
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.changes).toEqual([])
    expect(run.delays()).toEqual([relayRouteLineDownConfirmMs])
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary'], ['solov', 'direct']])
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.changes).toEqual([['solov', { line: 'primary', settled: true }]])
    const at = startedAt + relayRouteLineDownConfirmMs
    const change = { from: 'direct', to: 'primary', reason: 'line-down', trigger: 'startup', at }
    expect(run.controller.lastChange('solov')).toEqual(change)
    expect(run.writes).toEqual([{ lines: { solov: 'primary' }, changes: { solov: change } }])
    expect(run.events('relay.route.check-failed')).toEqual([{ siteId: 'solov', line: 'direct', trigger: 'startup', bothLines: true }])
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])

    // 历史账号反过来：先走的默认线路不通、直连通就换到直连。
    const historical = harness({ preferences: { 'solov-api': 'auto' }, conclusions: { 'solov-api': 'primary' } })
    historical.reachable.primary = false
    historical.controller.start()
    await settle()
    await historical.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(historical.probes).toEqual([['solov-api', 'primary'], ['solov-api', 'direct'], ['solov-api', 'primary']])
    expect(historical.controller.lastChange('solov-api')).toEqual({ from: 'primary', to: 'direct', reason: 'line-down', trigger: 'startup', at })
  })

  // #1156：唤醒、换网那几秒里走着的那条一次没通、紧接着就通了，不换线。
  it('keeps the line when it fails one check and answers the check right after', async () => {
    let directFailures = 0
    const probes: Array<[RelayRouteSiteId, RelayEndpointId]> = []
    const run = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'direct' },
      probe: async (siteId, line) => {
        probes.push([siteId, line])
        if (line !== 'direct' || directFailures === 0) return true
        directFailures -= 1
        throw new TypeError('net::ERR_CONNECTION_RESET')
      },
    })
    run.controller.start()
    await settle()
    directFailures = 1
    probes.length = 0
    run.controller.recheck('resume')
    await run.fireTimerOf(relayRouteNetworkSettleMs)
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(probes).toEqual([['solov', 'direct'], ['solov', 'primary'], ['solov', 'direct']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    expect(run.controller.lastChange('solov')).toBeNull()
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  // #1156：报「网络变了」那几种错的算没查准，另一条通了也不换。
  it.each(['ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_IO_SUSPENDED'])('does not switch away from a line that fails with %s', async (code) => {
    const run = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'direct' },
      probe: async (_siteId, line) => {
        if (line === 'direct') throw new TypeError(`net::${code}`)
        return true
      },
    })
    run.controller.start()
    await settle()
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.changes).toEqual([])
    expect(run.events('relay.route.check-failed')).toEqual([{ siteId: 'solov', line: 'direct', trigger: 'startup', bothLines: true, unsure: true }])
    expect(run.events('relay.route.unsure')).toEqual([{ siteId: 'solov', line: 'direct', trigger: 'startup' }])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  // 一次没查准、再查一次是真没通：换。
  it('switches when a check that could not tell is followed by one that fails', async () => {
    let first = true
    const run = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'direct' },
      probe: async (_siteId, line) => {
        if (line !== 'direct') return true
        if (first) {
          first = false
          throw new TypeError('net::ERR_NETWORK_CHANGED')
        }
        return false
      },
    })
    run.controller.start()
    await settle()
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.controller.lastChange('solov')).toMatchObject({ from: 'direct', to: 'primary', reason: 'line-down', trigger: 'startup' })
  })

  // 退到备用那条以后它自己坏了（换了网络常常是它先坏）：不等那 10 分钟，先走的那条通就换回去。
  it('goes back to the preferred line without the ten minutes when the backup line it fell back to is down', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'primary' } })
    run.reachable.primary = false
    run.controller.start()
    await settle()
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.probes).toEqual([['solov', 'primary'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.controller.lastChange('solov')).toEqual({
      from: 'primary', to: 'direct', reason: 'line-down', trigger: 'startup', at: startedAt + relayRouteLineDownConfirmMs,
    })
    expect(run.events('relay.route.check-failed')).toEqual([{ siteId: 'solov', line: 'primary', trigger: 'startup', bothLines: true }])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  it('checks both lines when a request on the backup line fails, and switches back only if the preferred line answers', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'primary' } })
    run.reachable.primary = false
    run.reachable.direct = false
    run.controller.reportFailure('solov', 'primary', 'ERR_CONNECTION_RESET')
    await settle()
    expect(run.events('relay.route.backup-failed')).toEqual([{ siteId: 'solov', line: 'primary', reason: 'ERR_CONNECTION_RESET' }])
    expect(run.probes).toEqual([['solov', 'primary'], ['solov', 'direct']])
    // 两条都不通：不改，切回去的计时照旧挂着。
    expect(run.controller.lines().solov).toEqual({ line: 'primary', settled: true })
    expect(run.events('relay.route.unreachable')).toEqual([{ siteId: 'solov', line: 'primary', settled: true, trigger: 'ERR_CONNECTION_RESET' }])
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])

    run.reachable.direct = true
    run.advance(relayRouteFailureRecheckGapMs)
    run.probes.length = 0
    run.controller.reportFailure('solov', 'primary', 'ERR_NAME_NOT_RESOLVED')
    await settle()
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.probes).toEqual([['solov', 'primary'], ['solov', 'direct'], ['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.controller.lastChange('solov')).toMatchObject({ from: 'primary', to: 'direct', reason: 'line-down', trigger: 'ERR_NAME_NOT_RESOLVED' })
  })

  it('checks both lines on resume, network changes and a manual recheck, and switches once the current line is down', async () => {
    const run = harness({ preferences: { solov: 'auto', 'solov-api': 'auto' }, conclusions: { solov: 'direct', 'solov-api': 'primary' } })
    run.controller.start()
    await settle()
    expect(run.changes).toEqual([])

    run.reachable.direct = false
    run.probes.length = 0
    run.controller.recheck('network')
    await settle()
    expect(run.events('relay.route.recheck')).toEqual([
      { siteId: 'solov', line: 'direct', trigger: 'network' },
      { siteId: 'solov-api', line: 'primary', trigger: 'network' },
    ])
    // 先等网络稳下来（#1156）。
    expect(run.probes).toEqual([])
    await run.fireTimerOf(relayRouteNetworkSettleMs)
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary'], ['solov-api', 'primary'], ['solov-api', 'direct']])
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.probes.slice(4)).toEqual([['solov', 'direct']])
    expect(run.controller.lines()).toEqual({ solov: { line: 'primary', settled: true }, 'solov-api': { line: 'primary', settled: true } })
    expect(run.changes).toEqual([['solov', { line: 'primary', settled: true }]])
    const switchedAt = startedAt + relayRouteNetworkSettleMs + relayRouteLineDownConfirmMs
    expect(run.controller.lastChange('solov')).toEqual({ from: 'direct', to: 'primary', reason: 'line-down', trigger: 'network', at: switchedAt })

    // 两次切换至少隔 5 分钟照旧：刚换过去，默认线路接着坏了，到点再两条一起查一轮才换。「重新检测」不等网络稳下来。
    run.reachable.direct = true
    run.reachable.primary = false
    run.advance(60_000)
    run.probes.length = 0
    run.controller.recheck('manual')
    await settle()
    expect(run.probes).toEqual([['solov', 'primary'], ['solov', 'direct'], ['solov-api', 'primary'], ['solov-api', 'direct']])
    while (run.delays().includes(relayRouteLineDownConfirmMs)) await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.controller.lines().solov.line).toBe('primary')
    const waitMs = relayRouteMinSwitchGapMs - 60_000 - relayRouteLineDownConfirmMs
    expect(run.events('relay.route.held')).toEqual([{ siteId: 'solov', line: 'primary', waitMs }])
    expect(run.delays()).toContain(waitMs)
  })

  // #1156：唤醒以后系统接连报几次网络变化，等稳下来只查一次。
  it('waits for the network to settle after a resume or network change and checks once', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.controller.start()
    await settle()
    run.probes.length = 0
    run.controller.recheck('resume')
    run.advance(3_000)
    run.controller.recheck('network')
    await settle()
    expect(run.probes).toEqual([])
    expect(run.delays().filter((delay) => delay === relayRouteNetworkSettleMs)).toHaveLength(1)
    await run.fireTimerOf(relayRouteNetworkSettleMs)
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])

    // 点「重新检测」不等，还在等的那次也不用再查了。
    run.probes.length = 0
    run.controller.recheck('network')
    run.controller.recheck('manual')
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])
  })

  // 唤醒、网络恢复时切回去的那 10 分钟从头数：睡前那几次不跟醒来连成「一直查得通」。点「重新检测」不清。
  it('counts the ten minutes before switching back again after a resume, but not after a manual recheck', async () => {
    for (const trigger of ['resume', 'manual'] as const) {
      const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'primary' } })
      run.controller.start()
      await settle()
      await run.fireTimer()
      await run.fireTimer()
      // 开机一次加两次，已经连着查通三次。
      run.controller.recheck(trigger)
      await settle()
      if (trigger === 'resume') await run.fireTimerOf(relayRouteNetworkSettleMs)
      expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
      const left = trigger === 'resume' ? recoveryProbes : recoveryProbes - 3
      for (let probe = 1; probe < left; probe++) await run.fireTimer()
      expect(run.controller.lines().solov.line).toBe('primary')
      await run.fireTimer()
      expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
      expect(run.controller.lastChange('solov')?.reason).toBe('recovered')
    }
  })

  it('waits for a check of both lines that is still out before the next switch-back check', async () => {
    const pending = deferred<boolean>()
    let hold = false
    const probes: Array<[RelayRouteSiteId, RelayEndpointId]> = []
    const run = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'primary' },
      probe: (siteId, line) => {
        probes.push([siteId, line])
        return hold && line === 'primary' ? pending.promise : Promise.resolve(true)
      },
    })
    run.controller.start()
    await settle()
    hold = true
    run.controller.reportFailure('solov', 'primary', 'ECONNRESET')
    await settle()
    expect(probes).toHaveLength(4)
    // 两条一起查那一轮还没回来：切回去那次检查这回不查，过两分钟再来。
    await run.fireTimer()
    expect(probes).toHaveLength(4)
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
    pending.resolve(true)
    await settle()
    expect(run.controller.lines().solov.line).toBe('primary')
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  // 开机没联网、两条都没连上的历史账号还没定下线路：网络恢复那一下也两条一起查，不走三次的规矩。
  it('checks both lines on a recheck before the historical site has settled a line', async () => {
    const run = harness({ preferences: { 'solov-api': 'auto' } })
    run.reachable.primary = false
    run.reachable.direct = false
    run.controller.start()
    await settle()
    await failTwiceMore(run)
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: false })
    expect(run.delays()).toEqual([relayRouteRecheckIntervalMs])

    run.reachable.direct = true
    run.probes.length = 0
    run.controller.recheck('network')
    await run.fireTimerOf(relayRouteNetworkSettleMs)
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.probes).toEqual([['solov-api', 'primary'], ['solov-api', 'direct'], ['solov-api', 'primary']])
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'direct', settled: true })
    expect(run.controller.lastChange('solov-api')).toEqual({ from: 'primary', to: 'direct', reason: 'line-down', trigger: 'network', at: run.now() })
  })

  it('drops the wait between failed checks for a check of both lines when a recheck comes in', async () => {
    const run = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    run.controller.start()
    await settle()
    run.reachable.direct = false
    await run.fireTimer()
    expect(run.delays()).toEqual([relayRouteFailureProbeGapMs])

    run.probes.length = 0
    run.controller.recheck('manual')
    await settle()
    expect(run.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
    expect(run.delays()).toEqual([relayRouteLineDownConfirmMs])
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(run.controller.lastChange('solov')).toMatchObject({ from: 'direct', to: 'primary', reason: 'line-down', trigger: 'manual' })
    expect(run.delays()).toEqual([relayRouteRecoveryProbeIntervalMs])
  })

  // 唤醒那一刻，睡着时到点的切回检查往往同时起来，它只查先走的那条：唤醒要的两条一起查等它回来马上补上，
  // 不然走着的备用那条坏了也查不出来。
  it('checks both lines once a probe still out when a recheck came in returns', async () => {
    const pending = deferred<boolean>()
    let hold = false
    const reachable: Record<RelayEndpointId, boolean> = { direct: true, primary: true }
    const probes: Array<[RelayRouteSiteId, RelayEndpointId]> = []
    const run = harness({
      preferences: { solov: 'auto' },
      conclusions: { solov: 'primary' },
      probe: (siteId, line) => {
        probes.push([siteId, line])
        return hold && line === 'direct' ? pending.promise : Promise.resolve(reachable[line])
      },
    })
    run.controller.start()
    await settle()
    hold = true
    await run.fireTimer()
    expect(probes).toEqual([['solov', 'primary'], ['solov', 'direct'], ['solov', 'direct']])

    reachable.primary = false
    run.controller.recheck('resume')
    await run.fireTimerOf(relayRouteNetworkSettleMs)
    expect(probes).toHaveLength(3)
    pending.resolve(true)
    await settle()
    expect(probes.slice(3)).toEqual([['solov', 'primary'], ['solov', 'direct']])
    await run.fireTimerOf(relayRouteLineDownConfirmMs)
    expect(probes.slice(5)).toEqual([['solov', 'primary']])
    expect(run.controller.lines().solov).toEqual({ line: 'direct', settled: true })
    expect(run.controller.lastChange('solov')).toMatchObject({ from: 'primary', to: 'direct', reason: 'line-down', trigger: 'resume' })
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
    expect(run.controller.lines()['solov-api']).toEqual({ line: 'primary', settled: false })
    expect(run.changes).toEqual([])
    expect(run.writes).toEqual([])

    const failing = harness({ preferences: { solov: 'auto' }, conclusions: { solov: 'direct' } })
    failing.reachable.direct = false
    failing.reachable.primary = false
    failing.controller.start()
    await settle()
    expect(failing.timers.size).toBe(1)
    failing.controller.dispose()
    expect(failing.timers.size).toBe(0)
    failing.advance(relayRouteFailureRecheckGapMs)
    failing.controller.reportFailure('solov', 'direct', 'ECONNRESET')
    failing.controller.recheck('network')
    await settle()
    expect(failing.probes).toEqual([['solov', 'direct'], ['solov', 'primary']])
  })

  it('keeps notifying the other subscribers when one throws, and stops calling one that unsubscribed', async () => {
    const run = harness({ preferences: { 'solov-api': 'auto' } })
    const removed = vi.fn()
    run.controller.subscribe(() => { throw new Error('renderer gone') })
    const unsubscribe = run.controller.subscribe(removed)
    unsubscribe()
    run.controller.start()
    await settle()
    expect(run.changes).toEqual([['solov-api', { line: 'primary', settled: true }]])
    expect(removed).not.toHaveBeenCalled()
  })
})

describe('relay route conclusion store', () => {
  const change: RelayRouteChange = { from: 'direct', to: 'primary', reason: 'health-failed', trigger: 'ERR_CONNECTION_RESET', at: 1_760_000_000_000 }

  it('round-trips the stored lines and the last change through a fresh store', async () => {
    const filePath = temporaryFile()
    const conclusions: RelayRouteConclusions = {
      lines: { solov: 'primary', 'solov-api': 'direct' },
      changes: { solov: change, 'solov-api': { from: 'primary', to: 'direct', reason: 'line-down', trigger: 'resume', at: 1_760_000_000_000 } },
    }
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

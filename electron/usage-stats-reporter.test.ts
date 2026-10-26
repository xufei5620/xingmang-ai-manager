import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usageMaxAttemptsPerDay, type UsageStatsSnapshot } from './usage-stats'
import { createMainStallMonitor, createUsageStatsReporter, type UsageStatsReporterOptions } from './usage-stats-reporter'

let directory = ''

beforeEach(async () => {
  directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xm-usage-stats-test-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.promises.rm(directory, { recursive: true, force: true })
})

function snapshot(): UsageStatsSnapshot {
  return {
    appVersion: '0.2.22',
    os: 'm15',
    arch: 'arm64',
    account: 'xm',
    route: { preference: 'auto', line: 'direct' },
    autoUpdate: true,
    update: { state: 'current' },
    tools: { clis: { claude: '2.1.310' }, gemini: null, desktops: {} },
  }
}

interface FetchCall {
  url: string
  init: RequestInit
}

// Never a real address: every request lands here and gets the answer the test picks.
function fakeFetch(answer: (url: string, calls: number) => Response | Error = () => new Response('', { status: 404 })) {
  const calls: FetchCall[] = []
  async function fetchImpl(url: string, init: RequestInit): Promise<Response> {
    calls.push({ url, init })
    const result = answer(url, calls.length)
    if (result instanceof Error) throw result
    return result
  }
  return { calls, fetchImpl }
}

function reporterWith(overrides: Partial<UsageStatsReporterOptions> & Pick<UsageStatsReporterOptions, 'fetchImpl'>) {
  let now = new Date('2026-10-27T03:00:00Z')
  const options: UsageStatsReporterOptions = {
    filePath: path.join(directory, 'usage-stats.json'),
    isEnabled: () => true,
    collect: async () => snapshot(),
    now: () => now,
    ...overrides,
  }
  return {
    reporter: createUsageStatsReporter(options),
    filePath: options.filePath,
    setNow(value: string) { now = new Date(value) },
  }
}

function pathOf(call: FetchCall): string {
  return new URL(call.url).pathname
}

function readState(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

describe('usage stats reporter', () => {
  it('sends one plain GET a day to the primary origin, without cookies, cache or redirects', async () => {
    const fetch = fakeFetch()
    const { reporter, setNow } = reporterWith({ fetchImpl: fetch.fetchImpl })
    reporter.record({ kind: 'hang', hang: 'stall' })

    await expect(reporter.runOnce()).resolves.toBe('sent')
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0].url.startsWith('https://updatesnew.shenfengwl.fun/xingmang-manager/stats/v1/d-20261027/')).toBe(true)
    expect(pathOf(fetch.calls[0]).endsWith('/i-0/f-0/h-s~1')).toBe(true)
    expect(fetch.calls[0].init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' })
    expect(fetch.calls[0].init.body).toBeUndefined()
    expect(fetch.calls[0].init.headers).toBeUndefined()
    expect(fetch.calls[0].init.signal).toBeInstanceOf(AbortSignal)

    // The same UTC day again: nothing more goes out, however often the app opens.
    await expect(reporter.runOnce()).resolves.toBe('skipped')
    setNow('2026-10-27T23:59:00Z')
    await expect(reporter.runOnce()).resolves.toBe('skipped')
    expect(fetch.calls).toHaveLength(1)

    // The next day sends again, with the counters already sent taken off.
    setNow('2026-10-28T00:01:00Z')
    await expect(reporter.runOnce()).resolves.toBe('sent')
    expect(fetch.calls).toHaveLength(2)
    expect(pathOf(fetch.calls[1])).toContain('/d-20261028/')
    expect(pathOf(fetch.calls[1]).endsWith('/i-0/f-0/h-0')).toBe(true)
  })

  it('falls back to the direct origin only when the primary cannot be reached', async () => {
    const onSendFailure = vi.fn()
    const fetch = fakeFetch((url) => (url.startsWith('https://updatesnew.shenfengwl.fun/') ? new TypeError('fetch failed') : new Response('', { status: 404 })))
    const { reporter } = reporterWith({ fetchImpl: fetch.fetchImpl, onSendFailure })
    await expect(reporter.runOnce()).resolves.toBe('sent')
    expect(fetch.calls.map((call) => new URL(call.url).origin)).toEqual(['https://updatesnew.shenfengwl.fun', 'https://xm-direct.solov.cc'])
    expect(pathOf(fetch.calls[1])).toBe(pathOf(fetch.calls[0]))
    expect(onSendFailure).toHaveBeenCalledTimes(1)
  })

  it('never follows a redirect and does not resend the day another way after one', async () => {
    const fetch = fakeFetch(() => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } }))
    const { reporter } = reporterWith({ fetchImpl: fetch.fetchImpl })
    await expect(reporter.runOnce()).resolves.toBe('failed')
    expect(fetch.calls).toHaveLength(1)
  })

  it('does not count a server error from the direct forward as delivered', async () => {
    const fetch = fakeFetch((url) => (url.startsWith('https://updatesnew.shenfengwl.fun/') ? new TypeError('fetch failed') : new Response('', { status: 502 })))
    const { reporter, filePath } = reporterWith({ fetchImpl: fetch.fetchImpl })
    await expect(reporter.runOnce()).resolves.toBe('failed')
    expect(readState(filePath).lastSentDay).toBeNull()
  })

  it('tries at most three times a day when nothing gets through', async () => {
    const fetch = fakeFetch(() => new TypeError('fetch failed'))
    const { reporter, setNow } = reporterWith({ fetchImpl: fetch.fetchImpl })
    for (let attempt = 0; attempt < usageMaxAttemptsPerDay; attempt += 1) await expect(reporter.runOnce()).resolves.toBe('failed')
    await expect(reporter.runOnce()).resolves.toBe('skipped')
    expect(fetch.calls).toHaveLength(usageMaxAttemptsPerDay * 2)
    setNow('2026-10-28T00:01:00Z')
    await expect(reporter.runOnce()).resolves.toBe('failed')
  })

  it('keeps counters that arrive while a send is on the way', async () => {
    let reporterRef: ReturnType<typeof createUsageStatsReporter> | null = null
    const fetch = fakeFetch(() => {
      reporterRef?.record({ kind: 'hang', hang: 'unresponsive' })
      return new Response('', { status: 404 })
    })
    const { reporter, filePath } = reporterWith({ fetchImpl: fetch.fetchImpl })
    reporterRef = reporter
    reporter.record({ kind: 'install', target: 'claude', category: 'network' })
    await expect(reporter.runOnce()).resolves.toBe('sent')
    await reporter.idle()
    expect(pathOf(fetch.calls[0])).toContain('/i-cc~net~1/')
    expect(readState(filePath)).toMatchObject({ lastSentDay: '20261027', counters: { 'h~w': 1 } })
  })

  it('drops counters a week old instead of sending them as today', async () => {
    const fetch = fakeFetch(() => new TypeError('fetch failed'))
    const { reporter, setNow } = reporterWith({ fetchImpl: fetch.fetchImpl })
    reporter.record({ kind: 'hang', hang: 'stall' })
    await reporter.idle()
    setNow('2026-11-04T04:00:00Z')
    await expect(reporter.runOnce()).resolves.toBe('failed')
    expect(pathOf(fetch.calls[0]).endsWith('/h-0')).toBe(true)
  })

  it('starts over from a damaged local file', async () => {
    const fetch = fakeFetch()
    const { reporter, filePath } = reporterWith({ fetchImpl: fetch.fetchImpl })
    fs.writeFileSync(filePath, '{"version":1,"lastSentDay":"20261027"')
    await expect(reporter.runOnce()).resolves.toBe('sent')
  })

  it('records and sends nothing once turned off, and removes what was kept', async () => {
    let enabled = true
    const fetch = fakeFetch()
    const { reporter, filePath } = reporterWith({ fetchImpl: fetch.fetchImpl, isEnabled: () => enabled })
    reporter.record({ kind: 'hang', hang: 'stall' })
    await reporter.idle()
    expect(fs.existsSync(filePath)).toBe(true)

    enabled = false
    reporter.record({ kind: 'hang', hang: 'stall' })
    await expect(reporter.runOnce()).resolves.toBe('disabled')
    expect(fs.existsSync(filePath)).toBe(false)
    expect(fetch.calls).toHaveLength(0)

    // Turned back on: the stall from before is gone, not saved up.
    enabled = true
    await expect(reporter.runOnce()).resolves.toBe('sent')
    expect(pathOf(fetch.calls[0]).endsWith('/h-0')).toBe(true)
  })

  it('removes what was kept as soon as the switch is turned off, without waiting for the timer', async () => {
    let enabled = true
    const fetch = fakeFetch()
    const { reporter, filePath } = reporterWith({ fetchImpl: fetch.fetchImpl, isEnabled: () => enabled })
    reporter.record({ kind: 'hang', hang: 'stall' })
    await reporter.idle()
    expect(fs.existsSync(filePath)).toBe(true)

    enabled = false
    await reporter.discard()
    expect(fs.existsSync(filePath)).toBe(false)
    expect(fetch.calls).toHaveLength(0)

    // Turned back on before the next check: the stall from before is not sent.
    enabled = true
    await expect(reporter.runOnce()).resolves.toBe('sent')
    expect(pathOf(fetch.calls[0]).endsWith('/h-0')).toBe(true)
  })

  it('does not send when the switch is turned off while the snapshot is being read', async () => {
    let enabled = true
    const fetch = fakeFetch()
    const { reporter } = reporterWith({
      fetchImpl: fetch.fetchImpl,
      isEnabled: () => enabled,
      collect: async () => {
        enabled = false
        return snapshot()
      },
    })
    await expect(reporter.runOnce()).resolves.toBe('disabled')
    expect(fetch.calls).toHaveLength(0)
  })

  it('records nothing once stopped for quitting', async () => {
    const { reporter, filePath } = reporterWith({ fetchImpl: fakeFetch().fetchImpl })
    reporter.stop()
    reporter.record({ kind: 'hang', hang: 'unresponsive' })
    await reporter.idle()
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('refuses a relative file path', () => {
    expect(() => createUsageStatsReporter({
      filePath: 'usage-stats.json',
      isEnabled: () => true,
      collect: async () => snapshot(),
      fetchImpl: fakeFetch().fetchImpl,
    })).toThrow('绝对路径')
  })

  it('waits before the first send and retries sooner after a failure', async () => {
    vi.useFakeTimers()
    const fetch = fakeFetch((_url, calls) => (calls <= 2 ? new TypeError('fetch failed') : new Response('', { status: 404 })))
    const { reporter } = reporterWith({ fetchImpl: fetch.fetchImpl, initialDelayMs: 1000, retryDelayMs: 5000, intervalMs: 60_000 })
    reporter.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(fetch.calls).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(fetch.calls).toHaveLength(3))
    reporter.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch.calls).toHaveLength(3)
  })
})

describe('main process stall monitor', () => {
  it('counts a tick two to thirty seconds late, only while resumed', () => {
    vi.useFakeTimers()
    let now = 0
    const onStall = vi.fn()
    const monitor = createMainStallMonitor({ onStall, intervalMs: 1000, clock: () => now })
    monitor.resume()
    now = 1000
    vi.advanceTimersByTime(1000)
    expect(onStall).not.toHaveBeenCalled()
    // The timer fired three seconds after the last one: two seconds late.
    now = 4000
    vi.advanceTimersByTime(1000)
    expect(onStall).toHaveBeenCalledTimes(1)
    // A gap this long is the machine waking from sleep.
    now = 40_000
    vi.advanceTimersByTime(1000)
    expect(onStall).toHaveBeenCalledTimes(1)

    monitor.pause()
    now = 100_000
    vi.advanceTimersByTime(5000)
    expect(onStall).toHaveBeenCalledTimes(1)
    // Resuming starts measuring afresh rather than from before the pause.
    monitor.resume()
    now = 101_000
    vi.advanceTimersByTime(1000)
    expect(onStall).toHaveBeenCalledTimes(1)

    monitor.stop()
    monitor.resume()
    now = 110_000
    vi.advanceTimersByTime(5000)
    expect(onStall).toHaveBeenCalledTimes(1)
  })
})

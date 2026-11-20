import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientVersionReportMaxAttemptsPerDay, clientVersionReportUrl, type ClientVersionReport } from './client-version-report'
import { createClientVersionReporter, type ClientVersionReporterOptions } from './client-version-reporter'

let directory = ''

beforeEach(async () => {
  directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xm-client-version-test-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.promises.rm(directory, { recursive: true, force: true })
})

function report(overrides: Partial<ClientVersionReport> = {}): ClientVersionReport {
  return { site: 'xm', userId: 1234, version: '0.2.25', os: 'windows', arch: 'x64', ...overrides }
}

interface FetchCall {
  url: string
  init: RequestInit
}

// Never a real address: every request lands here and gets the answer the test picks.
function fakeFetch(answer: (calls: number) => Response | Error = () => new Response(null, { status: 204 })) {
  const calls: FetchCall[] = []
  async function fetchImpl(url: string, init: RequestInit): Promise<Response> {
    calls.push({ url, init })
    const result = answer(calls.length)
    if (result instanceof Error) throw result
    return result
  }
  return { calls, fetchImpl }
}

function reporterWith(overrides: Partial<ClientVersionReporterOptions> & Pick<ClientVersionReporterOptions, 'fetchImpl'>) {
  let now = new Date('2026-11-20T03:00:00Z')
  let current: ClientVersionReport | null = report()
  const options: ClientVersionReporterOptions = {
    filePath: path.join(directory, 'client-version-report.json'),
    collect: () => current,
    now: () => now,
    ...overrides,
  }
  return {
    reporter: createClientVersionReporter(options),
    filePath: options.filePath,
    setNow(value: string) { now = new Date(value) },
    setReport(value: ClientVersionReport | null) { current = value },
  }
}

describe('client version reporter', () => {
  it('posts the five fields once a day to the console, without cookies, cache or redirects', async () => {
    const fetch = fakeFetch()
    const { reporter, setNow } = reporterWith({ fetchImpl: fetch.fetchImpl })

    await expect(reporter.runOnce()).resolves.toBe('sent')
    expect(fetch.calls).toHaveLength(1)
    const [call] = fetch.calls
    expect(call.url).toBe(clientVersionReportUrl)
    expect(call.init).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store' })
    expect(call.init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(call.init.body))).toEqual({ schema: 1, site: 'xm', user_id: 1234, version: '0.2.25', os: 'windows', arch: 'x64' })

    await expect(reporter.runOnce()).resolves.toBe('skipped')
    setNow('2026-11-20T23:00:00Z')
    await expect(reporter.runOnce()).resolves.toBe('skipped')
    setNow('2026-11-21T00:10:00Z')
    await expect(reporter.runOnce()).resolves.toBe('sent')
    expect(fetch.calls).toHaveLength(2)
  })

  it('sends nothing while signed out and does not spend an attempt on it', async () => {
    const fetch = fakeFetch()
    const { reporter, setReport, filePath } = reporterWith({ fetchImpl: fetch.fetchImpl })
    setReport(null)

    await expect(reporter.runOnce()).resolves.toBe('skipped')
    expect(fetch.calls).toHaveLength(0)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('reports again the same day after switching account or updating', async () => {
    const fetch = fakeFetch()
    const { reporter, setReport } = reporterWith({ fetchImpl: fetch.fetchImpl })

    await expect(reporter.runOnce()).resolves.toBe('sent')
    setReport(report({ version: '0.2.26' }))
    await expect(reporter.runOnce()).resolves.toBe('sent')
    setReport(report({ site: 'api', userId: 9 }))
    await expect(reporter.runOnce()).resolves.toBe('sent')
    expect(fetch.calls.map((call) => JSON.parse(String(call.init.body)).version)).toEqual(['0.2.25', '0.2.26', '0.2.25'])
  })

  it('keeps only a digest of what it sent on disk, never the account id', async () => {
    const fetch = fakeFetch()
    const { reporter, filePath } = reporterWith({ fetchImpl: fetch.fetchImpl })

    await reporter.runOnce()
    const stored = fs.readFileSync(filePath, 'utf8')
    expect(stored).not.toContain('1234')
    expect(JSON.parse(stored)).toMatchObject({ version: 1, sentDay: '20261120', attemptDay: '20261120', attempts: 1 })
    expect(JSON.parse(stored).sentDigest).toMatch(/^[0-9a-f]{32}$/)
  })

  it('counts only a 2xx as delivered and stops trying after the daily cap', async () => {
    const rejected: number[] = []
    const fetch = fakeFetch(() => new Response('not found', { status: 404 }))
    const { reporter } = reporterWith({ fetchImpl: fetch.fetchImpl, onRejected: (status) => rejected.push(status) })

    for (let index = 0; index < clientVersionReportMaxAttemptsPerDay; index += 1) {
      await expect(reporter.runOnce()).resolves.toBe('failed')
    }
    await expect(reporter.runOnce()).resolves.toBe('skipped')
    expect(fetch.calls).toHaveLength(clientVersionReportMaxAttemptsPerDay)
    expect(rejected).toEqual([404, 404, 404])
  })

  it('never follows a redirect or accepts an answer from another origin', async () => {
    const redirect = fakeFetch(() => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }))
    const first = reporterWith({ fetchImpl: redirect.fetchImpl })
    await expect(first.reporter.runOnce()).resolves.toBe('failed')

    const moved = new Response(null, { status: 204 })
    Object.defineProperty(moved, 'url', { value: 'https://evil.example/collect' })
    const elsewhere = fakeFetch(() => moved)
    const second = reporterWith({ fetchImpl: elsewhere.fetchImpl, filePath: path.join(directory, 'other.json') })
    await expect(second.reporter.runOnce()).resolves.toBe('failed')
  })

  it('records a network failure without throwing', async () => {
    const failures: unknown[] = []
    const fetch = fakeFetch(() => new TypeError('fetch failed'))
    const { reporter } = reporterWith({ fetchImpl: fetch.fetchImpl, onSendFailure: (error) => failures.push(error) })

    await expect(reporter.runOnce()).resolves.toBe('failed')
    expect(failures).toHaveLength(1)
  })

  it('gives up on a hung request at the timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T03:00:00Z'))
    const failures: unknown[] = []
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    function fetchImpl(_url: string, init: RequestInit): Promise<Response> {
      markStarted()
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    const reporter = createClientVersionReporter({
      filePath: path.join(directory, 'client-version-report.json'),
      collect: () => report(),
      fetchImpl,
      timeoutMs: 5_000,
      onSendFailure: (error) => failures.push(error),
    })

    const result = reporter.runOnce()
    // Reading the local record is real disk I/O; the timeout only starts once the request is out.
    await started
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(result).resolves.toBe('failed')
    expect(failures).toHaveLength(1)
  })

  it('shares one run when the timer and an account change land together', async () => {
    let release: (response: Response) => void = () => undefined
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const calls: FetchCall[] = []
    function fetchImpl(url: string, init: RequestInit): Promise<Response> {
      calls.push({ url, init })
      markStarted()
      return new Promise((resolve) => { release = resolve })
    }
    const { reporter } = reporterWith({ fetchImpl })

    const first = reporter.runOnce()
    const second = reporter.runOnce()
    // The request only goes out after the local record is read and written (real disk I/O): wait for it, not a fixed timeout.
    await started
    release(new Response(null, { status: 204 }))
    await expect(first).resolves.toBe('sent')
    await expect(second).resolves.toBe('sent')
    expect(calls).toHaveLength(1)
  })

  it('waits before the first report and pulls it forward after a sign-in without ever pushing it back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T03:00:00Z'))
    const fetch = fakeFetch()
    const reporter = createClientVersionReporter({
      filePath: path.join(directory, 'client-version-report.json'),
      collect: () => report(),
      fetchImpl: fetch.fetchImpl,
      initialDelayMs: 180_000,
      accountChangeDelayMs: 60_000,
    })

    reporter.accountChanged()
    reporter.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch.calls).toHaveLength(0)

    reporter.accountChanged()
    await vi.advanceTimersByTimeAsync(40_000)
    // Renewals keep firing account changes; none of them may delay the run already due.
    reporter.accountChanged()
    await vi.advanceTimersByTimeAsync(20_000)
    await reporter.idle()
    expect(fetch.calls).toHaveLength(1)
    reporter.stop()
  })

  it('stops scheduling after stop()', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T03:00:00Z'))
    const fetch = fakeFetch()
    const reporter = createClientVersionReporter({
      filePath: path.join(directory, 'client-version-report.json'),
      collect: () => report(),
      fetchImpl: fetch.fetchImpl,
      initialDelayMs: 1_000,
    })

    reporter.start()
    reporter.stop()
    reporter.accountChanged()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fetch.calls).toHaveLength(0)
    await expect(reporter.runOnce()).resolves.toBe('skipped')
  })

  it('refuses a relative record path', () => {
    expect(() => createClientVersionReporter({ filePath: 'client-version-report.json', collect: () => null, fetchImpl: fakeFetch().fetchImpl }))
      .toThrow('客户端版本上报记录必须使用绝对路径。')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { crashReportDsn, type CrashReportEnvironment } from './crash-report'
import { createCrashReporter, type CrashReporterOptions } from './crash-reporter'

const runtime: CrashReportEnvironment = {
  release: 'xingmang-ai-manager@9.9.9',
  environment: 'production',
  homeDirectory: '/home/yoyo',
  appVersion: '9.9.9',
  electronVersion: '43.0.0',
  nodeVersion: '22.0.0',
  osPlatform: 'linux',
  osRelease: '6.1.0',
  arch: 'x64',
}

interface Harness {
  calls: { url: string; init: RequestInit }[]
  failures: unknown[]
  enabled: boolean
}

function setup(
  overrides: Partial<CrashReporterOptions> = {},
  respond: (call: number) => Response = () => new Response('', { status: 200 }),
) {
  const harness: Harness = { calls: [], failures: [], enabled: true }
  const reporter = createCrashReporter({
    dsn: crashReportDsn,
    clientName: 'xingmang-ai-manager/9.9.9',
    runtime,
    isEnabled: () => harness.enabled,
    onSendFailure: (error) => { harness.failures.push(error) },
    fetchImpl: async (url, init) => {
      harness.calls.push({ url, init })
      return respond(harness.calls.length)
    },
    ...overrides,
  })
  return { reporter, harness }
}

describe('createCrashReporter', () => {
  it('posts one sentry envelope per distinct crash', async () => {
    const { reporter, harness } = setup()
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('boom') })
    await reporter.flush()
    expect(harness.calls).toHaveLength(1)
    const [call] = harness.calls
    expect(call.url).toContain('/api/4512110923350016/envelope/')
    expect(call.init.method).toBe('POST')
    expect(call.init.credentials).toBe('omit')
    expect(call.init.redirect).toBe('manual')
    expect(String(call.init.body).split('\n')[1]).toContain('"type":"event"')
  })

  it('sends nothing while the preference is off, and resumes when it is back on', async () => {
    const { reporter, harness } = setup()
    harness.enabled = false
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('boom') })
    await reporter.flush()
    expect(harness.calls).toEqual([])
    harness.enabled = true
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('boom') })
    await reporter.flush()
    expect(harness.calls).toHaveLength(1)
  })

  it('drops a send that was queued before the switch was turned off', async () => {
    const { reporter, harness } = setup()
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('first') })
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('second') })
    harness.enabled = false
    await reporter.flush()
    expect(harness.calls).toEqual([])
  })

  it('reports a crash loop once', async () => {
    const { reporter, harness } = setup()
    const throwTwice = () => {
      const error = new Error('same bug')
      error.stack = 'Error: same bug\n    at loop (/app/a.js:1:1)'
      return error
    }
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: throwTwice() })
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: throwTwice() })
    await reporter.flush()
    expect(harness.calls).toHaveLength(1)
  })

  it('stops at the per-session cap', async () => {
    const { reporter, harness } = setup({ maxEventsPerSession: 2 })
    for (let index = 0; index < 5; index += 1) {
      reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error(`boom ${index}`) })
    }
    await reporter.flush()
    expect(harness.calls).toHaveLength(2)
  })

  it('stops for the rest of the session when ingest rate limits the client', async () => {
    const { reporter, harness } = setup({}, () => new Response('', { status: 429 }))
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('one') })
    await reporter.flush()
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('two') })
    await reporter.flush()
    expect(harness.calls).toHaveLength(1)
  })

  it('stops when ingest answers with a redirect instead of accepting the envelope', async () => {
    const { reporter, harness } = setup(
      {},
      () => Response.redirect('https://collector.evil.test/api/1/envelope/', 307),
    )
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('one') })
    await reporter.flush()
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('two') })
    await reporter.flush()
    expect(harness.calls).toHaveLength(1)
  })

  it('stops when a 200 answer came back from another origin', async () => {
    const { reporter, harness } = setup({}, () => {
      const response = new Response('', { status: 200 })
      // A host that followed the redirect itself: the status is fine, the
      // origin is not, and the stack has already left for somewhere else.
      Object.defineProperty(response, 'url', { value: 'https://collector.evil.test/api/1/envelope/' })
      return response
    })
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('one') })
    await reporter.flush()
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('two') })
    await reporter.flush()
    expect(harness.calls).toHaveLength(1)
  })

  it('swallows a transport failure and records it locally', async () => {
    const { reporter, harness } = setup({
      fetchImpl: () => Promise.reject(new Error('offline')),
    })
    expect(() => reporter.report({
      mechanism: 'uncaughtException',
      source: 'main',
      error: new Error('boom'),
    })).not.toThrow()
    await reporter.flush()
    expect(harness.failures).toHaveLength(1)
  })

  it('aborts a send that never answers', async () => {
    const aborted = vi.fn()
    const { reporter, harness } = setup({
      timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted()
          reject(new Error('aborted'))
        })
      }),
    })
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('boom') })
    await reporter.flush()
    expect(aborted).toHaveBeenCalled()
    expect(harness.failures).toHaveLength(1)
  })

  it('does nothing at all when the dsn is not a sentry ingest endpoint', async () => {
    const { reporter, harness } = setup({ dsn: 'https://key123456@collector.evil.test/2' })
    expect(reporter.configured).toBe(false)
    reporter.report({ mechanism: 'uncaughtException', source: 'main', error: new Error('boom') })
    await reporter.flush()
    expect(harness.calls).toEqual([])
  })

  it('never lets a relay key reach the wire', async () => {
    const { reporter, harness } = setup()
    reporter.report({
      mechanism: 'renderer-error',
      source: 'renderer',
      error: new Error('写入 /home/yoyo/.claude/settings.json 失败 sk-abcdef123456'),
    })
    await reporter.flush()
    const body = String(harness.calls[0].init.body)
    expect(body).not.toContain('sk-abcdef123456')
    expect(body).not.toContain('yoyo')
    expect(body).toContain('%USERPROFILE%')
  })
})

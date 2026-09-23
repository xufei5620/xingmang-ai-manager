import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createServiceStatusMonitor,
  locateServiceStatusUrl,
  parseServiceStatus,
  readServiceStatus,
  resolveServiceStatusUrl,
  type ServiceStatus,
} from './service-status'

const now = new Date('2026-09-23T08:00:00.000Z')

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

describe('resolveServiceStatusUrl', () => {
  it('puts the status file next to the update manifests', () => {
    const config = 'provider: generic\nurl: https://updatesnew.shenfengwl.fun/xingmang-manager/\nupdaterCacheDirName: xingmang-ai-manager-updater\n'
    expect(resolveServiceStatusUrl(config)).toBe('https://updatesnew.shenfengwl.fun/xingmang-manager/service-status.json')
  })

  it('accepts a quoted url and a base without a trailing slash', () => {
    expect(resolveServiceStatusUrl("provider: generic\r\nurl: 'https://example.test/beta'\r\n"))
      .toBe('https://example.test/beta/service-status.json')
  })

  it('refuses anything the release scripts would refuse as an update url', () => {
    expect(resolveServiceStatusUrl('provider: generic\n')).toBeNull()
    expect(resolveServiceStatusUrl('url: http://example.test/feed/')).toBeNull()
    expect(resolveServiceStatusUrl('url: https://user:pass@example.test/feed/')).toBeNull()
    expect(resolveServiceStatusUrl('url: https://example.test/feed/?token=1')).toBeNull()
    expect(resolveServiceStatusUrl('url: https://localhost/feed/')).toBeNull()
    expect(resolveServiceStatusUrl('url: not a url')).toBeNull()
  })

  it('allows a loopback http feed only for development updates', () => {
    const config = 'url: http://127.0.0.1:8123/'
    expect(resolveServiceStatusUrl(config)).toBeNull()
    expect(resolveServiceStatusUrl(config, { allowLocalHttp: true })).toBe('http://127.0.0.1:8123/service-status.json')
  })
})

describe('locateServiceStatusUrl', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })

  it('reads the packaged update config and treats a missing file as no status file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-service-status-'))
    directories.push(directory)
    const config = path.join(directory, 'app-update.yml')
    fs.writeFileSync(config, 'provider: generic\nurl: https://example.test/xingmang-manager/\n')
    expect(locateServiceStatusUrl(config)).toBe('https://example.test/xingmang-manager/service-status.json')
    expect(locateServiceStatusUrl(path.join(directory, 'missing.yml'))).toBeNull()
  })
})

describe('parseServiceStatus', () => {
  it('reads an active maintenance notice and its message', () => {
    expect(parseServiceStatus(JSON.stringify({ maintenance: { active: true, message: '  服务升级中，\n预计 22:00 恢复  ' } }), now))
      .toMatchObject({ maintenance: { message: '服务升级中， 预计 22:00 恢复' } })
  })

  it('treats anything but a literal true as not in maintenance', () => {
    for (const active of [false, 'true', 1, null, undefined]) {
      expect(parseServiceStatus(JSON.stringify({ maintenance: { active, message: 'x' } }), now).maintenance).toBeNull()
    }
  })

  it('ends a maintenance notice once its until time has passed', () => {
    const past = { maintenance: { active: true, until: '2026-09-23T07:59:59Z' } }
    const future = { maintenance: { active: true, until: '2026-09-23T09:00:00Z' } }
    const unreadable = { maintenance: { active: true, until: 'tonight' } }
    expect(parseServiceStatus(JSON.stringify(past), now).maintenance).toBeNull()
    expect(parseServiceStatus(JSON.stringify(future), now).maintenance).toEqual({ message: null })
    expect(parseServiceStatus(JSON.stringify(unreadable), now).maintenance).toEqual({ message: null })
  })

  it('strips control and bidi characters and caps the message length', () => {
    const message = `a\u0007b\u202ec${'长'.repeat(400)}`
    const parsed = parseServiceStatus(JSON.stringify({ maintenance: { active: true, message } }), now)
    expect(parsed.maintenance?.message?.startsWith('a b c')).toBe(true)
    expect(Array.from(parsed.maintenance?.message ?? '')).toHaveLength(200)
  })

  it('never throws on malformed content', () => {
    for (const text of ['', 'not json', '[]', 'null', '"x"', '{"maintenance": []}', '\uFEFF{}']) {
      expect(parseServiceStatus(text, now)).toEqual({ maintenance: null, badVersions: [], rollout: null })
    }
    expect(parseServiceStatus('\uFEFF{"maintenance":{"active":true}}', now).maintenance).toEqual({ message: null })
  })

  it('reads withdrawn versions and a staged rollout, dropping entries it cannot read', () => {
    const text = JSON.stringify({
      badVersions: ['0.2.10', 'v0.2.11', '0.2.10', 'latest', 12, '1.0'],
      rollout: { version: '0.2.12', percent: 150 },
    })
    expect(parseServiceStatus(text, now)).toEqual({
      maintenance: null,
      badVersions: ['0.2.10', '0.2.11'],
      rollout: { version: '0.2.12', percent: 100 },
    })
    expect(parseServiceStatus(JSON.stringify({ badVersions: '0.2.10', rollout: { version: '0.2.12', percent: '20' } }), now))
      .toEqual({ maintenance: null, badVersions: [], rollout: null })
  })
})

describe('readServiceStatus', () => {
  const url = 'https://example.test/xingmang-manager/service-status.json'

  it('asks for the file without following redirects or reusing a cache', async () => {
    const fetch = vi.fn(async () => jsonResponse('{"maintenance":{"active":true,"message":"升级中"}}'))
    await expect(readServiceStatus({ url, fetch, now: () => now })).resolves.toMatchObject({ maintenance: { message: '升级中' } })
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error', cache: 'no-store', credentials: 'omit' }))
  })

  it('returns null whenever the file cannot be read', async () => {
    await expect(readServiceStatus({ url, fetch: async () => new Response('missing', { status: 404 }) })).resolves.toBeNull()
    await expect(readServiceStatus({ url, fetch: async () => { throw new TypeError('fetch failed') } })).resolves.toBeNull()
    await expect(readServiceStatus({
      url,
      fetch: async () => jsonResponse('x'.repeat(17 * 1024)),
    })).resolves.toBeNull()
  })

  it('gives up after its timeout instead of holding anything up', async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    await expect(readServiceStatus({ url, fetch, timeoutMs: 10 })).resolves.toBeNull()
  })
})

describe('createServiceStatusMonitor', () => {
  const maintenance: ServiceStatus = { maintenance: { message: '升级中' } }
  const quiet: ServiceStatus = { maintenance: null }

  it('reports only changes and polls faster while maintenance is on', async () => {
    vi.useFakeTimers()
    try {
      const results: (ServiceStatus | null)[] = [maintenance, maintenance, quiet]
      const read = vi.fn(async () => results.shift() ?? quiet)
      const onChange = vi.fn()
      const monitor = createServiceStatusMonitor({ read, onChange, idleIntervalMs: 1_000, activeIntervalMs: 100 })
      monitor.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onChange).toHaveBeenLastCalledWith(maintenance)
      await vi.advanceTimersByTimeAsync(100)
      expect(read).toHaveBeenCalledTimes(2)
      expect(onChange).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(read).toHaveBeenCalledTimes(3)
      expect(onChange).toHaveBeenLastCalledWith(quiet)
      await vi.advanceTimersByTimeAsync(500)
      expect(read).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(500)
      expect(read).toHaveBeenCalledTimes(4)
      monitor.dispose()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(read).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one request between concurrent refreshes and survives a failing reader', async () => {
    let finish!: (value: ServiceStatus | null) => void
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<ServiceStatus | null>((resolve) => { finish = resolve }))
      .mockImplementationOnce(async () => { throw new Error('boom') })
    const onChange = vi.fn()
    const monitor = createServiceStatusMonitor({ read, onChange })
    const first = monitor.refresh()
    const second = monitor.refresh()
    finish(maintenance)
    await expect(first).resolves.toEqual(maintenance)
    await expect(second).resolves.toEqual(maintenance)
    expect(read).toHaveBeenCalledTimes(1)
    await expect(monitor.refresh()).resolves.toBeNull()
    expect(onChange).toHaveBeenLastCalledWith(null)
    monitor.dispose()
  })
})

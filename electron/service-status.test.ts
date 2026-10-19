import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createServiceStatusMonitor,
  isOlderReleaseGuard,
  locateServiceStatusUrl,
  parseReleaseGuard,
  parseServiceStatus,
  parseServiceStatusDocument,
  readServiceStatus,
  resolveMinimumVersionFor,
  resolveReleaseGuardFor,
  resolveReleasePlatforms,
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
  it('switches tool route rewrites back to the merge path only on the literal merge', () => {
    expect(parseServiceStatus(JSON.stringify({ toolRouteRewrite: 'merge' }), now).toolRouteRewrite).toBe('merge')
    for (const value of ['targeted', 'MERGE', true, null]) {
      expect(parseServiceStatus(JSON.stringify({ toolRouteRewrite: value }), now)).not.toHaveProperty('toolRouteRewrite')
    }
  })

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
      expect(parseServiceStatus(text, now)).toEqual({ maintenance: null, badVersions: [], rollout: null, minimumVersion: null })
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
      minimumVersion: null,
    })
    expect(parseServiceStatus(JSON.stringify({ badVersions: '0.2.10', rollout: { version: '0.2.12', percent: '20' } }), now))
      .toEqual({ maintenance: null, badVersions: [], rollout: null, minimumVersion: null })
  })

  it('reads a minimum version and treats anything it cannot read as no minimum', () => {
    expect(parseServiceStatus(JSON.stringify({ minimumVersion: 'v0.2.12' }), now).minimumVersion).toBe('0.2.12')
    for (const minimumVersion of ['0.2', '0.2.12-beta', 'latest', 12, null, true, ['0.2.12'], '']) {
      expect(parseServiceStatus(JSON.stringify({ minimumVersion }), now).minimumVersion).toBeNull()
    }
  })

  it('reads the account group map, keeping each role\'s order', () => {
    const text = JSON.stringify({
      accountGroups: {
        claude: ['Claude 主力', 'Claude-MAX订阅'],
        codex: ['  GPT 主力  ', 'GPT-中转/订阅', 'GPT 主力'],
        image: ['画图专线'],
      },
    })
    expect(parseServiceStatus(text, now).accountGroups).toEqual({
      claude: ['Claude 主力', 'Claude-MAX订阅'],
      codex: ['GPT 主力', 'GPT-中转/订阅'],
      image: ['画图专线'],
    })
  })

  it('drops map entries it cannot use without voiding the rest of a role', () => {
    const text = JSON.stringify({
      accountGroups: {
        claude: ['坏\u0000名字', 'x'.repeat(129), 12, null, '', 'Claude-MAX订阅'],
        codex: Array.from({ length: 20 }, (_, index) => `GPT ${index}`),
        grok: 'Grok-中转/订阅',
        gemini: ['Gemini-中转/订阅'],
        video: ['视频模型-中转/订阅'],
      },
    })
    const groups = parseServiceStatus(text, now).accountGroups
    expect(groups?.claude).toEqual(['Claude-MAX订阅'])
    expect(groups?.codex).toHaveLength(8)
    expect(groups).not.toHaveProperty('grok')
    expect(groups).not.toHaveProperty('gemini')
    expect(groups).not.toHaveProperty('video')
  })

  it('treats a map with nothing usable as no map at all', () => {
    for (const accountGroups of [null, [], 'claude=x', {}, { claude: [] }, { claude: [''] }]) {
      expect(parseServiceStatus(JSON.stringify({ accountGroups }), now)).not.toHaveProperty('accountGroups')
    }
  })

  it('reads the CLI model table for the tools it still manages', () => {
    const text = JSON.stringify({
      cliModels: {
        codex: { default: ' gpt-7 ', previous: ['gpt-6-astra', 'gpt-6-astra'], retired: ['gpt-5.5', 'gpt-6-luna'] },
        claude: { previous: ['claude-opus-5-5'] },
        grok: { retired: ['grok-4.6'] },
      },
    })
    expect(parseServiceStatus(text, now).cliModels).toEqual({
      codex: { default: 'gpt-7', previous: ['gpt-6-astra'], retired: ['gpt-5.5', 'gpt-6-luna'] },
      claude: { previous: ['claude-opus-5-5'] },
      grok: { retired: ['grok-4.6'] },
    })
  })

  it('drops model names it cannot use without voiding the rest of a tool', () => {
    const text = JSON.stringify({
      cliModels: {
        codex: { default: 'gpt 7', previous: ['gpt-6-astra"', 12, null, '', 'gpt-6-astra'], retired: Array.from({ length: 40 }, (_, index) => `gpt-old-${index}`) },
        claude: { default: ['claude-opus-6'], retired: 'claude-opus-5' },
        gemini: { default: 'gemini-4' },
        image: { default: 'gpt-image-3' },
      },
    })
    const models = parseServiceStatus(text, now).cliModels
    expect(models?.codex?.default).toBeUndefined()
    expect(models?.codex?.previous).toEqual(['gpt-6-astra'])
    expect(models?.codex?.retired).toHaveLength(32)
    expect(models).not.toHaveProperty('claude')
    expect(models).not.toHaveProperty('gemini')
    expect(models).not.toHaveProperty('image')
  })

  it('treats a model table with nothing usable as no table at all', () => {
    for (const cliModels of [null, [], 'codex.default=gpt-7', {}, { codex: null }, { codex: {} }, { codex: { default: '' } }, { codex: { previous: [] } }]) {
      expect(parseServiceStatus(JSON.stringify({ cliModels }), now)).not.toHaveProperty('cliModels')
    }
  })

  it('reads when the publisher last changed the file, ignoring a time it cannot use (#1157 item 10)', () => {
    expect(parseServiceStatus(JSON.stringify({ updatedAt: '2026-09-23T07:59:00.000Z' }), now).updatedAt).toBe('2026-09-23T07:59:00.000Z')
    expect(parseServiceStatus(JSON.stringify({ updatedAt: '2026-09-23T16:00:00+08:00' }), now).updatedAt).toBe('2026-09-23T08:00:00.000Z')
    // 留一天给时钟偏差；再往后就是写错了，当没写，免得它压住之后每一份。
    expect(parseServiceStatus(JSON.stringify({ updatedAt: '2026-09-24T07:59:00.000Z' }), now).updatedAt).toBe('2026-09-24T07:59:00.000Z')
    for (const updatedAt of ['2026-09-24T08:01:00.000Z', 'yesterday', 1_758_614_400_000, null]) {
      expect(parseServiceStatus(JSON.stringify({ updatedAt }), now)).not.toHaveProperty('updatedAt')
    }
    expect(parseReleaseGuard({ badVersions: ['0.2.10'], rollout: null, updatedAt: '2026-09-23T07:00:00.000Z' }, now))
      .toEqual({ badVersions: ['0.2.10'], rollout: null, updatedAt: '2026-09-23T07:00:00.000Z' })
    expect(parseReleaseGuard({ badVersions: [], rollout: null, updatedAt: '2027-01-01T00:00:00.000Z' }, now))
      .toEqual({ badVersions: [], rollout: null })
  })

  it('calls a release guard older only when both copies say when they were written', () => {
    const earlier = { updatedAt: '2026-09-23T07:00:00.000Z' }
    const later = { updatedAt: '2026-09-23T08:00:00.000Z' }
    expect(isOlderReleaseGuard(earlier, later)).toBe(true)
    expect(isOlderReleaseGuard(later, earlier)).toBe(false)
    expect(isOlderReleaseGuard(later, later)).toBe(false)
    expect(isOlderReleaseGuard({}, later)).toBe(false)
    expect(isOlderReleaseGuard(earlier, {})).toBe(false)
  })
})

describe('release platforms (#1155 item 5)', () => {
  const machines = {
    windows: resolveReleasePlatforms({ platform: 'win32', arch: 'x64' }),
    windowsArm: resolveReleasePlatforms({ platform: 'win32', arch: 'arm64' }),
    intelMac: resolveReleasePlatforms({ platform: 'darwin', arch: 'x64', macRunsArm64: false }),
    appleMac: resolveReleasePlatforms({ platform: 'darwin', arch: 'arm64', macRunsArm64: true }),
    rosettaMac: resolveReleasePlatforms({ platform: 'darwin', arch: 'x64', macRunsArm64: true }),
    linux: resolveReleasePlatforms({ platform: 'linux', arch: 'x64' }),
    linuxArm: resolveReleasePlatforms({ platform: 'linux', arch: 'arm64' }),
  }

  it('names this machine by its platform and by the packages it runs and updates to', () => {
    expect(machines.windows).toEqual(['windows', 'windows-x64'])
    expect(machines.intelMac).toEqual(['mac', 'mac-x64'])
    expect(machines.appleMac).toEqual(['mac', 'mac-arm64'])
    // Intel 版经 Rosetta 跑着：装着的是 Intel 版，更新时会换成 M 系列芯片版，两种都算。
    expect(machines.rosettaMac).toEqual(['mac', 'mac-x64', 'mac-arm64'])
    expect(machines.linuxArm).toEqual(['linux', 'linux-arm64'])
    expect(resolveReleasePlatforms({ platform: 'darwin', arch: 'x64' })).toEqual(['mac', 'mac-x64'])
    expect(resolveReleasePlatforms({ platform: 'win32', arch: 'ia32' })).toEqual(['windows'])
    expect(resolveReleasePlatforms({ platform: 'freebsd', arch: 'x64' })).toEqual([])
  })

  it('reads which packages a withdrawal, a rollout or a minimum covers', () => {
    const status = parseServiceStatus(JSON.stringify({
      badVersions: ['0.2.19', '0.2.20', 'v0.2.21'],
      badVersionPlatforms: { '0.2.20': ['mac-x64', 'MAC-X64 ', 'linux'], 'v0.2.21': ['windows'], '0.2.18': ['mac'] },
      rollout: { version: '0.2.22', percent: 0, platforms: ['mac-x64'] },
      minimumVersion: '0.2.21',
      minimumVersionPlatforms: ['mac-arm64'],
    }), now)
    expect(status).toEqual({
      maintenance: null,
      badVersions: ['0.2.19', '0.2.20', '0.2.21'],
      // 不在撤回名单里的 0.2.18 不收。
      badVersionPlatforms: { '0.2.20': ['mac-x64', 'linux'], '0.2.21': ['windows'] },
      rollout: { version: '0.2.22', percent: 0, platforms: ['mac-x64'] },
      minimumVersion: '0.2.21',
      minimumVersionPlatforms: ['mac-arm64'],
    })
    expect(parseReleaseGuard({ badVersions: status.badVersions, badVersionPlatforms: status.badVersionPlatforms, rollout: status.rollout }, now))
      .toEqual({ badVersions: ['0.2.19', '0.2.20', '0.2.21'], badVersionPlatforms: { '0.2.20': ['mac-x64', 'linux'], '0.2.21': ['windows'] }, rollout: status.rollout })
  })

  it('falls back to every package on a platform list it cannot fully read', () => {
    for (const platforms of [['mac-intel'], ['mac-x64', 'macos'], [], 'mac-x64', [3], null, Array(10).fill('mac')]) {
      const status = parseServiceStatus(JSON.stringify({
        badVersions: ['0.2.20'],
        badVersionPlatforms: { '0.2.20': platforms },
        rollout: { version: '0.2.21', percent: 20, platforms },
        minimumVersion: '0.2.21',
        minimumVersionPlatforms: platforms,
      }), now)
      expect(status).toEqual({ maintenance: null, badVersions: ['0.2.20'], rollout: { version: '0.2.21', percent: 20 }, minimumVersion: '0.2.21' })
    }
    // 同一个版本写了两次，有一份读不懂就整版撤回。
    expect(parseServiceStatus(JSON.stringify({
      badVersions: ['0.2.20'],
      badVersionPlatforms: { '0.2.20': ['mac-x64'], 'v0.2.20': ['mac-intel'] },
    }), now)).not.toHaveProperty('badVersionPlatforms')
    expect(parseServiceStatus(JSON.stringify({
      badVersions: ['0.2.20'],
      badVersionPlatforms: { '0.2.20': ['mac-x64'], 'v0.2.20': ['linux'] },
    }), now).badVersionPlatforms).toEqual({ '0.2.20': ['mac-x64', 'linux'] })
    // 没有最低版本时不收它的平台表。
    expect(parseServiceStatus(JSON.stringify({ minimumVersionPlatforms: ['mac'] }), now)).not.toHaveProperty('minimumVersionPlatforms')
  })

  it('keeps only what applies to this machine', () => {
    const guard = {
      badVersions: ['0.2.19', '0.2.20'],
      badVersionPlatforms: { '0.2.20': ['mac-x64'] },
      rollout: { version: '0.2.21', percent: 0, platforms: ['mac'] },
    }
    expect(resolveReleaseGuardFor(guard, machines.intelMac)).toEqual({ badVersions: ['0.2.19', '0.2.20'], rollout: guard.rollout })
    expect(resolveReleaseGuardFor(guard, machines.rosettaMac)).toEqual({ badVersions: ['0.2.19', '0.2.20'], rollout: guard.rollout })
    expect(resolveReleaseGuardFor(guard, machines.appleMac)).toEqual({ badVersions: ['0.2.19'], rollout: guard.rollout })
    expect(resolveReleaseGuardFor(guard, machines.windows)).toEqual({ badVersions: ['0.2.19'], rollout: null })
    expect(resolveReleaseGuardFor({ badVersions: ['0.2.20'], rollout: { version: '0.2.21', percent: 20 } }, []))
      .toEqual({ badVersions: ['0.2.20'], rollout: { version: '0.2.21', percent: 20 } })
    const status = { minimumVersion: '0.2.21', minimumVersionPlatforms: ['linux-arm64'] }
    expect(resolveMinimumVersionFor(status, machines.linuxArm)).toBe('0.2.21')
    expect(resolveMinimumVersionFor(status, machines.linux)).toBeNull()
    expect(resolveMinimumVersionFor({ minimumVersion: '0.2.21' }, machines.windows)).toBe('0.2.21')
    expect(resolveMinimumVersionFor(null, machines.windows)).toBeNull()
  })

  it('leaves clients that do not read platforms withdrawing, holding back and requiring at least as much', () => {
    // 发布脚本写出来的文件，按 0.2.19 及以前的客户端那样只看 badVersions、rollout 的版本和百分比、minimumVersion
    // 去读：每台电脑上撤的、拦的都不比认平台的读法少。
    const load = createRequire(__filename)
    const { applyStatusChanges } = load('../scripts/service-status.cjs') as {
      applyStatusChanges: (current: Record<string, unknown>, changes: Record<string, string>, now: Date) => Record<string, unknown>
    }
    const changes: Array<Record<string, string>> = [
      { 'bad-versions': '0.2.19 0.2.20@mac-x64 0.2.21@linux|windows-arm64' },
      { rollout: '0.2.22 0@mac-x64' },
      { rollout: '0.2.22 30@windows|linux-arm64' },
      { 'minimum-version': '0.2.21@mac-arm64', 'published-versions': '0.2.22 0.2.22' },
    ]
    let written: Record<string, unknown> = {}
    for (const change of changes) {
      written = applyStatusChanges(written, change, now)
      const scoped = parseServiceStatusDocument(JSON.stringify(written), now)
      const { badVersionPlatforms: _versions, minimumVersionPlatforms: _minimum, ...visible } = written
      const rollout = visible.rollout as Record<string, unknown> | undefined
      const legacy = parseServiceStatusDocument(JSON.stringify({
        ...visible,
        ...(rollout ? { rollout: { version: rollout.version, percent: rollout.percent } } : {}),
      }), now)
      expect(scoped).not.toBeNull()
      expect(legacy).not.toBeNull()
      for (const here of Object.values(machines)) {
        const applied = resolveReleaseGuardFor({ badVersions: scoped!.badVersions ?? [], badVersionPlatforms: scoped!.badVersionPlatforms, rollout: scoped!.rollout ?? null }, here)
        for (const version of applied.badVersions) expect(legacy!.badVersions).toContain(version)
        if (applied.rollout) expect(legacy!.rollout).toEqual({ version: applied.rollout.version, percent: applied.rollout.percent })
        const minimum = resolveMinimumVersionFor(scoped, here)
        if (minimum) expect(legacy!.minimumVersion).toBe(minimum)
      }
      // 认不认平台，读到的撤回名单、放量的版本和百分比、最低版本都一样，差别只在管不管这台电脑。
      expect(scoped!.badVersions).toEqual(legacy!.badVersions)
      expect(scoped!.minimumVersion).toBe(legacy!.minimumVersion)
    }
    expect(written).toMatchObject({
      badVersions: ['0.2.19', '0.2.20', '0.2.21'],
      badVersionPlatforms: { '0.2.20': ['mac-x64'], '0.2.21': ['linux', 'windows-arm64'] },
      rollout: { version: '0.2.22', percent: 30, platforms: ['windows', 'linux-arm64'] },
      minimumVersion: '0.2.21',
      minimumVersionPlatforms: ['mac-arm64'],
    })
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

  it('counts a 200 that is not a JSON object as not read, so the last good copy survives it', async () => {
    for (const body of ['<html>请先登录</html>', '{"accountGroups": {"codex": ["GPT', '[]', 'null']) {
      await expect(readServiceStatus({ url, fetch: async () => jsonResponse(body) })).resolves.toBeNull()
    }
    await expect(readServiceStatus({ url, fetch: async () => jsonResponse('{}') })).resolves.toEqual({
      maintenance: null,
      badVersions: [],
      rollout: null,
      minimumVersion: null,
    })
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

  it('lets callers wait for the read already on the way without starting another', async () => {
    let finish!: (value: ServiceStatus | null) => void
    const read = vi.fn(() => new Promise<ServiceStatus | null>((resolve) => { finish = resolve }))
    const monitor = createServiceStatusMonitor({ read, onChange: vi.fn() })
    await expect(monitor.settled()).resolves.toBeNull()
    expect(read).not.toHaveBeenCalled()
    monitor.start()
    const waiting = monitor.settled()
    finish(maintenance)
    await expect(waiting).resolves.toEqual(maintenance)
    await expect(monitor.settled()).resolves.toEqual(maintenance)
    expect(read).toHaveBeenCalledTimes(1)
    monitor.dispose()
  })

  it('keeps the last status it could read across a failed read', async () => {
    const mapped: ServiceStatus = { maintenance: null, accountGroups: { codex: ['GPT 主力', 'GPT-中转/订阅'] } }
    const read = vi.fn()
      .mockResolvedValueOnce(mapped)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(quiet)
    const monitor = createServiceStatusMonitor({ read, onChange: vi.fn() })
    expect(monitor.lastKnown()).toBeNull()
    await monitor.refresh()
    await expect(monitor.refresh()).resolves.toBeNull()
    expect(monitor.lastKnown()).toEqual(mapped)
    await monitor.refresh()
    expect(monitor.lastKnown()).toEqual(quiet)
    monitor.dispose()
  })
})

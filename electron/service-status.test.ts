import fs from 'node:fs'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildReleaseGuardPayload,
  createServiceStatusMonitor,
  inspectReleaseGuardSignature,
  isOlderReleaseGuard,
  locateServiceStatusUrl,
  parseReleaseGuard,
  parseServiceStatus,
  parseServiceStatusDocument,
  readServiceStatus,
  releaseGuardSignatureField,
  resolveFeaturesOffFor,
  resolveHiddenPaymentMethodsFor,
  resolveKnownIssuesFor,
  resolveMinimumVersionFor,
  resolveReleaseGuardFor,
  resolveReleasePlatforms,
  resolveServiceStatusUrl,
  type ServiceStatus,
} from './service-status'

const now = new Date('2026-09-23T08:00:00.000Z')

// 撤回名单、放量、最低版本要发布者签名才认（D85）。测试用自己生成的一把，经 publicKeys 交给客户端。
const testKey = generateKeyPairSync('ed25519')
const testPublicKeys = [testKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')]
const signedKeys = { publicKeys: testPublicKeys }

function signGuard(document: Record<string, unknown>): Record<string, unknown> {
  const payload = buildReleaseGuardPayload(document)
  return { ...document, [releaseGuardSignatureField]: sign(null, Buffer.from(payload, 'utf8'), testKey.privateKey).toString('base64') }
}

function signedText(document: Record<string, unknown>): string {
  return JSON.stringify(signGuard(document))
}

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
    for (const text of ['', 'not json', '[]', 'null', '"x"']) {
      expect(parseServiceStatus(text, now)).toEqual({ maintenance: null, badVersions: [], rollout: null, minimumVersion: null })
    }
    // 是个对象、只是没签名：撤回名单那几项照样当没读到，并说明为什么（D85）。
    for (const text of ['{"maintenance": []}', '\uFEFF{}']) {
      expect(parseServiceStatus(text, now)).toEqual({ maintenance: null, badVersions: [], rollout: null, minimumVersion: null, releaseGuardRejected: 'unsigned' })
    }
    expect(parseServiceStatus(signedText({}), now, signedKeys)).toEqual({ maintenance: null, badVersions: [], rollout: null, minimumVersion: null })
    expect(parseServiceStatus('\uFEFF{"maintenance":{"active":true}}', now).maintenance).toEqual({ message: null })
  })

  it('reads withdrawn versions and a staged rollout, dropping entries it cannot read', () => {
    const text = signedText({
      badVersions: ['0.2.10', 'v0.2.11', '0.2.10', 'latest', 12, '1.0'],
      rollout: { version: '0.2.12', percent: 150 },
    })
    expect(parseServiceStatus(text, now, signedKeys)).toEqual({
      maintenance: null,
      badVersions: ['0.2.10', '0.2.11'],
      rollout: { version: '0.2.12', percent: 100 },
      minimumVersion: null,
    })
    expect(parseServiceStatus(signedText({ badVersions: '0.2.10', rollout: { version: '0.2.12', percent: '20' } }), now, signedKeys))
      .toEqual({ maintenance: null, badVersions: [], rollout: null, minimumVersion: null })
  })

  it('reads a minimum version and treats anything it cannot read as no minimum', () => {
    expect(parseServiceStatus(signedText({ minimumVersion: 'v0.2.12' }), now, signedKeys).minimumVersion).toBe('0.2.12')
    for (const minimumVersion of ['0.2', '0.2.12-beta', 'latest', 12, null, true, ['0.2.12'], '']) {
      expect(parseServiceStatus(signedText({ minimumVersion }), now, signedKeys).minimumVersion).toBeNull()
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
    expect(parseServiceStatus(signedText({ updatedAt: '2026-09-23T07:59:00.000Z' }), now, signedKeys).updatedAt).toBe('2026-09-23T07:59:00.000Z')
    expect(parseServiceStatus(signedText({ updatedAt: '2026-09-23T16:00:00+08:00' }), now, signedKeys).updatedAt).toBe('2026-09-23T08:00:00.000Z')
    // 留一天给时钟偏差；再往后就是写错了，当没写，免得它压住之后每一份。
    expect(parseServiceStatus(signedText({ updatedAt: '2026-09-24T07:59:00.000Z' }), now, signedKeys).updatedAt).toBe('2026-09-24T07:59:00.000Z')
    for (const updatedAt of ['2026-09-24T08:01:00.000Z', 'yesterday', 1_758_614_400_000, null]) {
      expect(parseServiceStatus(signedText({ updatedAt }), now, signedKeys)).not.toHaveProperty('updatedAt')
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
    const status = parseServiceStatus(signedText({
      badVersions: ['0.2.19', '0.2.20', 'v0.2.21'],
      badVersionPlatforms: { '0.2.20': ['mac-x64', 'MAC-X64 ', 'linux'], 'v0.2.21': ['windows'], '0.2.18': ['mac'] },
      rollout: { version: '0.2.22', percent: 0, platforms: ['mac-x64'] },
      minimumVersion: '0.2.21',
      minimumVersionPlatforms: ['mac-arm64'],
    }), now, signedKeys)
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
      const status = parseServiceStatus(signedText({
        badVersions: ['0.2.20'],
        badVersionPlatforms: { '0.2.20': platforms },
        rollout: { version: '0.2.21', percent: 20, platforms },
        minimumVersion: '0.2.21',
        minimumVersionPlatforms: platforms,
      }), now, signedKeys)
      expect(status).toEqual({ maintenance: null, badVersions: ['0.2.20'], rollout: { version: '0.2.21', percent: 20 }, minimumVersion: '0.2.21' })
    }
    // 同一个版本写了两次，有一份读不懂就整版撤回。
    expect(parseServiceStatus(signedText({
      badVersions: ['0.2.20'],
      badVersionPlatforms: { '0.2.20': ['mac-x64'], 'v0.2.20': ['mac-intel'] },
    }), now, signedKeys)).not.toHaveProperty('badVersionPlatforms')
    expect(parseServiceStatus(signedText({
      badVersions: ['0.2.20'],
      badVersionPlatforms: { '0.2.20': ['mac-x64'], 'v0.2.20': ['linux'] },
    }), now, signedKeys).badVersionPlatforms).toEqual({ '0.2.20': ['mac-x64', 'linux'] })
    // 没有最低版本时不收它的平台表。
    expect(parseServiceStatus(signedText({ minimumVersionPlatforms: ['mac'] }), now, signedKeys)).not.toHaveProperty('minimumVersionPlatforms')
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
      { 'bad-versions': '0.2.19 0.2.20@mac-x64 0.2.21@linux|windows-x64' },
      { rollout: '0.2.22 0@mac-x64' },
      { rollout: '0.2.22 30@windows|linux-arm64' },
      { 'minimum-version': '0.2.21@mac-arm64', 'published-versions': '0.2.22 0.2.22' },
    ]
    let written: Record<string, unknown> = {}
    for (const change of changes) {
      written = applyStatusChanges(written, change, now)
      const scoped = parseServiceStatusDocument(signedText(written), now, signedKeys)
      const { badVersionPlatforms: _versions, minimumVersionPlatforms: _minimum, ...visible } = written
      const rollout = visible.rollout as Record<string, unknown> | undefined
      // 0.2.19 及以前的客户端不验签名，这里替它把看得见的那几项重新签上，只比读法。
      const legacy = parseServiceStatusDocument(signedText({
        ...visible,
        ...(rollout ? { rollout: { version: rollout.version, percent: rollout.percent } } : {}),
      }), now, signedKeys)
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
      badVersionPlatforms: { '0.2.20': ['mac-x64'], '0.2.21': ['linux', 'windows-x64'] },
      rollout: { version: '0.2.22', percent: 30, platforms: ['windows', 'linux-arm64'] },
      minimumVersion: '0.2.21',
      minimumVersionPlatforms: ['mac-arm64'],
    })
  })
})

describe('known issues and payment method switches', () => {
  const windows = resolveReleasePlatforms({ platform: 'win32', arch: 'x64' })
  const intelMac = resolveReleasePlatforms({ platform: 'darwin', arch: 'x64', macRunsArm64: false })

  it('reads known issues with their page, button and scope, dropping entries it cannot show', () => {
    const status = parseServiceStatus(JSON.stringify({
      knownIssues: [
        { page: 'recharge', message: ' 支付宝暂时打不开，\u202e请先用微信付款。 ', action: 'support', versions: ['v0.2.23', '0.2.23'], platforms: ['Windows'] },
        { message: '每一页都出', action: 'open-browser' },
        { page: 'video', message: '以后才有的那一页' },
        { page: 'home', message: '   ' },
        { page: 'home', message: '请到 https://pay.example.com 充值' },
        { page: 'home', message: '请到 xm-solov.cc 充值' },
        { page: 'home', message: '版本表写坏了', versions: ['0.2'] },
        { page: 'home', message: '平台表写坏了', platforms: ['windows', 'bsd'] },
        'not an object',
      ],
    }), now)
    expect(status.knownIssues).toEqual([
      { page: 'recharge', message: '支付宝暂时打不开， 请先用微信付款。', action: 'support', versions: ['0.2.23'], platforms: ['windows'] },
      { page: 'all', message: '每一页都出' },
    ])
    expect(parseServiceStatus(JSON.stringify({ knownIssues: [{ page: 'home' }] }), now)).not.toHaveProperty('knownIssues')
    expect(parseServiceStatus(JSON.stringify({ knownIssues: 'none' }), now)).not.toHaveProperty('knownIssues')
  })

  it('caps how many known issues one file can put on screen', () => {
    const knownIssues = Array.from({ length: 12 }, (_, index) => ({ page: 'home', message: `第 ${index} 条` }))
    expect(parseServiceStatus(JSON.stringify({ knownIssues }), now).knownIssues).toHaveLength(8)
  })

  it('shows a known issue only on the versions and packages it names', () => {
    const status = parseServiceStatus(JSON.stringify({
      knownIssues: [
        { page: 'recharge', message: '只给 0.2.23 的 Windows', versions: ['0.2.23'], platforms: ['windows'] },
        { page: 'home', message: '只给 Intel 版 Mac', platforms: ['mac-x64'], action: 'update' },
        { page: 'chat', message: '谁都给' },
      ],
    }), now)
    expect(resolveKnownIssuesFor(status, '0.2.23', windows)).toEqual([
      { page: 'recharge', message: '只给 0.2.23 的 Windows' },
      { page: 'chat', message: '谁都给' },
    ])
    expect(resolveKnownIssuesFor(status, 'v0.2.24', windows)).toEqual([{ page: 'chat', message: '谁都给' }])
    expect(resolveKnownIssuesFor(status, '0.2.23', intelMac)).toEqual([
      { page: 'home', message: '只给 Intel 版 Mac', action: 'update' },
      { page: 'chat', message: '谁都给' },
    ])
    // 认不出的平台对不上任何只给某几种安装包的条目。
    expect(resolveKnownIssuesFor(status, '0.2.23', [])).toEqual([{ page: 'chat', message: '谁都给' }])
    expect(resolveKnownIssuesFor(null, '0.2.23', windows)).toEqual([])
  })

  it('reads payment method switches and hides only on the versions and packages they name', () => {
    const status = parseServiceStatus(JSON.stringify({
      paymentMethodsOff: [
        { method: ' AliPay ', versions: ['0.2.23'], platforms: ['windows'] },
        { method: 'wxpay', platforms: ['mac'] },
        { method: 'stripe' },
        { method: 'alipay' },
        { method: '支付宝' },
        { method: 'qqpay', versions: [] },
        { method: 'creem', platforms: 'windows' },
        { versions: ['0.2.23'] },
      ],
    }), now)
    expect(status.paymentMethodsOff).toEqual([
      { method: 'alipay', versions: ['0.2.23'], platforms: ['windows'] },
      { method: 'wxpay', platforms: ['mac'] },
      { method: 'stripe' },
      { method: 'alipay' },
    ])
    expect(resolveHiddenPaymentMethodsFor(status, '0.2.23', windows)).toEqual(['alipay', 'stripe'])
    expect(resolveHiddenPaymentMethodsFor(status, '0.2.24', intelMac)).toEqual(['wxpay', 'stripe', 'alipay'])
    expect(resolveHiddenPaymentMethodsFor(parseServiceStatus('{}', now), '0.2.23', windows)).toEqual([])
    expect(resolveHiddenPaymentMethodsFor(undefined, '0.2.23', windows)).toEqual([])
  })

  it('reads feature switches from the fixed list only and switches off only on the versions and packages they name', () => {
    const status = parseServiceStatus(JSON.stringify({
      featuresOff: [
        { feature: ' Video-Studio ', versions: ['0.2.23'], platforms: ['windows'] },
        { feature: 'install:codexdesktop', platforms: ['mac'] },
        { feature: 'launch:grok' },
        // 以后的版本才有的一样、名字相近的、写坏了范围的：整条不管。
        { feature: 'teleport' },
        { feature: 'install:gemini' },
        { feature: 'install' },
        { feature: 'codex-remote', versions: [] },
        { feature: 'acceleration', platforms: 'windows' },
        { versions: ['0.2.23'] },
        'tray-release',
      ],
    }), now)
    expect(status.featuresOff).toEqual([
      { feature: 'video-studio', versions: ['0.2.23'], platforms: ['windows'] },
      { feature: 'install:codexDesktop', platforms: ['mac'] },
      { feature: 'launch:grok' },
    ])
    // 按名单的先后排，跟写的先后无关。
    expect(resolveFeaturesOffFor(status, '0.2.23', windows)).toEqual(['video-studio', 'launch:grok'])
    expect(resolveFeaturesOffFor(status, 'v0.2.24', intelMac)).toEqual(['install:codexDesktop', 'launch:grok'])
    expect(resolveFeaturesOffFor(parseServiceStatus('{}', now), '0.2.23', windows)).toEqual([])
    expect(resolveFeaturesOffFor(null, '0.2.23', windows)).toEqual([])
    expect(parseServiceStatus(JSON.stringify({ featuresOff: 'video-studio' }), now).featuresOff).toBeUndefined()
  })

  it('reads back exactly what the publishing script writes', () => {
    const load = createRequire(__filename)
    const { applyStatusChanges } = load('../scripts/service-status.cjs') as {
      applyStatusChanges: (current: Record<string, unknown>, changes: Record<string, string>, now: Date) => Record<string, unknown>
    }
    let written = applyStatusChanges({}, { 'known-issue': 'recharge：支付宝暂时打不开付款页，请先用微信付款。', 'known-issue-scope': '0.2.23 @windows support' }, now)
    written = applyStatusChanges(written, { 'known-issue': 'all: 今晚 22 点前聊天可能慢一点。' }, now)
    written = applyStatusChanges(written, { 'payment-methods-off': 'alipay@0.2.23@windows wxpay' }, now)
    written = applyStatusChanges(written, { 'features-off': 'video-studio@0.2.23@windows install:codexDesktop' }, now)
    const status = parseServiceStatusDocument(JSON.stringify(written), now)
    expect(status?.knownIssues).toEqual(written.knownIssues)
    expect(status?.paymentMethodsOff).toEqual(written.paymentMethodsOff)
    expect(status?.featuresOff).toEqual(written.featuresOff)
    expect(resolveFeaturesOffFor(status, '0.2.23', windows)).toEqual(['video-studio', 'install:codexDesktop'])
    expect(resolveFeaturesOffFor(status, '0.2.23', intelMac)).toEqual(['install:codexDesktop'])
    expect(resolveKnownIssuesFor(status, '0.2.23', windows)).toEqual([
      { page: 'recharge', message: '支付宝暂时打不开付款页，请先用微信付款。', action: 'support' },
      { page: 'all', message: '今晚 22 点前聊天可能慢一点。' },
    ])
    expect(resolveHiddenPaymentMethodsFor(status, '0.2.23', windows)).toEqual(['alipay', 'wxpay'])
    expect(resolveHiddenPaymentMethodsFor(status, '0.2.23', intelMac)).toEqual(['wxpay'])
  })
})

interface StatusSignatureScript {
  canonicalJson: (value: unknown) => string
  buildGuardPayload: (status: Record<string, unknown>) => string
  signStatus: (status: Record<string, unknown>, privateKey: KeyObject, pinnedKeys: readonly string[]) => Record<string, unknown>
  inspectStatusSignature: (status: Record<string, unknown>, pinnedKeys: readonly string[]) => string
}

function loadStatusSignatureScript(): StatusSignatureScript {
  return createRequire(__filename)('../scripts/service-status-signature.cjs') as StatusSignatureScript
}

describe('release guard signature (D85)', () => {
  const guard = {
    badVersions: ['0.2.21'],
    rollout: { version: '0.2.25', percent: 20 },
    minimumVersion: '0.2.22',
    updatedAt: '2026-09-23T07:00:00.000Z',
  }
  const extras = {
    maintenance: { active: true, message: '升级中' },
    featuresOff: [{ feature: 'video-studio' }],
    accountGroups: { codex: ['GPT'] },
  }

  it('builds exactly the text scripts/service-status-signature.cjs signs', () => {
    // 与 scripts/service-status-signature.test.cjs 的同名断言逐字一致；改一边必须改另一边。
    const document = { ...extras, updatedAt: '2026-11-20T00:00:00.000Z', rollout: { version: '0.2.25', percent: 20 }, badVersions: ['0.2.21'] }
    const expected = 'xingmang-service-status-guard/v1\n{"badVersions":["0.2.21"],"rollout":{"percent":20,"version":"0.2.25"},"updatedAt":"2026-11-20T00:00:00.000Z"}\n'
    expect(buildReleaseGuardPayload(document)).toBe(expected)
    expect(loadStatusSignatureScript().buildGuardPayload(document)).toBe(expected)
    expect(buildReleaseGuardPayload({})).toBe('xingmang-service-status-guard/v1\n{}\n')
    // 写了 null 跟没写是两回事：拿掉一项也算改过。
    expect(buildReleaseGuardPayload({ rollout: null })).toBe('xingmang-service-status-guard/v1\n{"rollout":null}\n')
  })

  it('reads the guard of a signed file and every other field either way', () => {
    const signed = parseServiceStatus(signedText({ ...guard, ...extras }), now, signedKeys)
    expect(signed).toMatchObject({ badVersions: ['0.2.21'], rollout: { version: '0.2.25', percent: 20 }, minimumVersion: '0.2.22', updatedAt: guard.updatedAt })
    expect(signed).not.toHaveProperty('releaseGuardRejected')
    const unsigned = parseServiceStatus(JSON.stringify({ ...guard, ...extras }), now, signedKeys)
    expect(unsigned).toEqual({
      maintenance: { message: '升级中' },
      badVersions: [],
      rollout: null,
      minimumVersion: null,
      accountGroups: { codex: ['GPT'] },
      featuresOff: [{ feature: 'video-studio' }],
      releaseGuardRejected: 'unsigned',
    })
  })

  it('refuses the guard when any signed field was changed, added or taken away after signing', () => {
    const signed = signGuard({ ...guard, ...extras })
    const tampered: Array<Record<string, unknown>> = [
      // Z-4：把正在跑的版本写进撤回名单，好让客户端「退回」旧版。
      { ...signed, badVersions: ['0.2.21', '0.2.25'] },
      { ...signed, badVersionPlatforms: { '0.2.21': ['mac'] } },
      { ...signed, rollout: { version: '0.2.25', percent: 0 } },
      { ...signed, minimumVersion: '9.9.9' },
      { ...signed, minimumVersionPlatforms: ['windows'] },
      // 换个时间就能让一份旧的盖掉新的，或者让新的永远盖不掉它。
      { ...signed, updatedAt: '2026-09-23T07:30:00.000Z' },
    ]
    const { badVersions: _removed, ...withoutWithdrawals } = signed
    tampered.push(withoutWithdrawals)
    for (const document of tampered) {
      const status = parseServiceStatus(JSON.stringify(document), now, signedKeys)
      expect(status.releaseGuardRejected).toBe('signature')
      expect(status).toMatchObject({ badVersions: [], rollout: null, minimumVersion: null })
      expect(status).not.toHaveProperty('updatedAt')
      // 别的项照常读。
      expect(status.maintenance).toEqual({ message: '升级中' })
    }
  })

  it('keeps the signature valid across a hand edit of the unsigned fields, key order and whitespace', () => {
    const signed = signGuard({ ...guard, ...extras })
    const edited = { ...signed, maintenance: { active: false }, knownIssues: [{ page: 'home', message: '今晚慢一点。' }] }
    const reordered = Object.fromEntries(Object.entries(edited).reverse())
    for (const text of [JSON.stringify(edited), JSON.stringify(reordered, null, 4)]) {
      const status = parseServiceStatus(text, now, signedKeys)
      expect(status).not.toHaveProperty('releaseGuardRejected')
      expect(status.badVersions).toEqual(['0.2.21'])
    }
  })

  it('accepts no key but the pinned ones and no malformed signature', () => {
    const signed = signGuard(guard)
    // 内置的是发版那把，测试那把它不认。
    expect(inspectReleaseGuardSignature(signed)).toBe('signature')
    expect(inspectReleaseGuardSignature(signed, [])).toBe('signature')
    expect(inspectReleaseGuardSignature(signed, testPublicKeys)).toBeNull()
    for (const value of [42, 'not-base64', `${'A'.repeat(86)}==`, ['x'], { signature: 'x' }]) {
      expect(inspectReleaseGuardSignature({ ...signed, [releaseGuardSignatureField]: value }, testPublicKeys)).toBe('signature')
    }
    for (const value of [undefined, null, '']) {
      expect(inspectReleaseGuardSignature({ ...guard, [releaseGuardSignatureField]: value }, testPublicKeys)).toBe('unsigned')
    }
  })

  it('reads what the publishing scripts write and sign', () => {
    const load = createRequire(__filename)
    const { applyStatusChanges } = load('../scripts/service-status.cjs') as {
      applyStatusChanges: (current: Record<string, unknown>, changes: Record<string, string>, now: Date) => Record<string, unknown>
    }
    const { signStatus } = loadStatusSignatureScript()
    let written = applyStatusChanges({}, { 'bad-versions': '0.2.20 0.2.21@mac-x64', rollout: '0.2.25 20@windows' }, now)
    written = signStatus(written, testKey.privateKey, testPublicKeys)
    // 再改一次：脚本拿掉旧签名、改完重签，线上那个旧签名不会留下来冒充。
    written = applyStatusChanges(written, { 'minimum-version': '0.2.22', 'published-versions': '0.2.25 0.2.25' }, now)
    expect(written).not.toHaveProperty(releaseGuardSignatureField)
    expect(parseServiceStatus(JSON.stringify(written), now, signedKeys).releaseGuardRejected).toBe('unsigned')
    written = signStatus(written, testKey.privateKey, testPublicKeys)
    const status = parseServiceStatus(`${JSON.stringify(written, null, 2)}\n`, now, signedKeys)
    expect(status).toMatchObject({
      badVersions: ['0.2.20', '0.2.21'],
      badVersionPlatforms: { '0.2.21': ['mac-x64'] },
      rollout: { version: '0.2.25', percent: 20, platforms: ['windows'] },
      minimumVersion: '0.2.22',
      updatedAt: now.toISOString(),
    })
    expect(status).not.toHaveProperty('releaseGuardRejected')
  })
})

// Random inputs (fast-check). The promise is "the client and the publishing
// script sign the same text for any value the file can hold, the signature
// follows the values and not the bytes, and no change to a signed field gets
// through". A failing run prints its seed and the smallest document that breaks
// it; that is a file the workflow would sign and the client would then refuse,
// or a tampered file the client would trust.
describe('release guard signature with random inputs', () => {
  const script = loadStatusSignatureScript()
  const fieldNames = ['badVersions', 'badVersionPlatforms', 'rollout', 'minimumVersion', 'minimumVersionPlatforms', 'updatedAt'] as const
  const guardDocument = fc.record(
    Object.fromEntries(fieldNames.map((name) => [name, fc.jsonValue({ maxDepth: 3 })])) as Record<(typeof fieldNames)[number], fc.Arbitrary<unknown>>,
    { requiredKeys: [] },
  )
  const otherFields = fc.dictionary(
    fc.string({ maxLength: 12 }).filter((key) => !(fieldNames as readonly string[]).includes(key) && key !== releaseGuardSignatureField),
    fc.jsonValue({ maxDepth: 2 }),
    { maxKeys: 4 },
  )

  it('builds the same text as the script for anything JSON can hold, keys in any order', () => {
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
      expect(script.canonicalJson(value)).toBe(script.canonicalJson(JSON.parse(JSON.stringify(value))))
      const document = { rollout: value }
      expect(buildReleaseGuardPayload(document)).toBe(script.buildGuardPayload(document))
    }))
  })

  it('verifies a signed file after any edit of the unsigned fields and refuses any edit of a signed one', () => {
    fc.assert(fc.property(guardDocument, otherFields, otherFields, fc.constantFrom(...fieldNames), fc.jsonValue({ maxDepth: 2 }), (fields, before, after, target, replacement) => {
      const signed = script.signStatus({ ...before, ...fields }, testKey.privateKey, testPublicKeys)
      const reread = JSON.parse(JSON.stringify({ ...after, ...signed })) as Record<string, unknown>
      expect(inspectReleaseGuardSignature(reread, testPublicKeys)).toBeNull()
      const original = Object.hasOwn(signed, target) ? JSON.stringify(signed[target]) : undefined
      fc.pre(original !== JSON.stringify(replacement))
      const tampered = JSON.parse(JSON.stringify({ ...signed, [target]: replacement })) as Record<string, unknown>
      expect(inspectReleaseGuardSignature(tampered, testPublicKeys)).toBe('signature')
    }), { numRuns: 100 })
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
    await expect(readServiceStatus({ url, fetch: async () => jsonResponse(signedText({})), ...signedKeys })).resolves.toEqual({
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

describe('readServiceStatus when the system proxy points at a proxy that is not running (PX-1)', () => {
  const url = 'https://example.test/xingmang-manager/service-status.json'
  const gate = signedText({ minimumVersion: '0.2.22', badVersions: ['0.2.21'] })
  // What session.fetch rejects with when the proxy is not listening, captured from Electron 45.1.0: a plain
  // Error whose only own keys are `stack` and `message`, no `code`, no `cause`.
  const proxyConnectionError = () => new Error('net::ERR_PROXY_CONNECTION_FAILED')

  // 记下会话这会儿是哪种连法，每次 fetch 记一笔用的是哪种：system 时代理连不上，direct 时读到文件。
  function proxiedSession(body = gate) {
    let mode: 'system' | 'direct' = 'system'
    const calls: string[] = []
    const fetch = vi.fn(async () => {
      calls.push(mode)
      if (mode === 'system') throw proxyConnectionError()
      return jsonResponse(body)
    })
    const retryWithoutProxy = vi.fn(async () => {
      calls.push('retryWithoutProxy')
      mode = 'direct'
    })
    const restoreProxy = vi.fn(async () => {
      calls.push('restoreProxy')
      mode = 'system'
    })
    return { fetch, retryWithoutProxy, restoreProxy, calls, mode: () => mode }
  }

  it('reads the file directly once and puts the session back on the system proxy', async () => {
    const session = proxiedSession()
    expect(Object.getOwnPropertyNames(proxyConnectionError()).sort()).toEqual(['message', 'stack'])

    await expect(readServiceStatus({ url, ...session, now: () => now, ...signedKeys })).resolves.toMatchObject({
      minimumVersion: '0.2.22',
      badVersions: ['0.2.21'],
    })
    expect(session.calls).toEqual(['system', 'retryWithoutProxy', 'direct', 'restoreProxy'])
    expect(session.mode()).toBe('system')
    expect(session.fetch).toHaveBeenLastCalledWith(url, expect.objectContaining({ redirect: 'error', cache: 'no-store', credentials: 'omit' }))
  })

  it('still accepts a proxy failure that carries a structured code or sits on the cause chain', async () => {
    for (const rejection of [
      Object.assign(new Error('proxy connection failed'), { code: 'ERR_PROXY_CONNECTION_FAILED' }),
      new TypeError('fetch failed', { cause: proxyConnectionError() }),
    ]) {
      const fetch = vi.fn()
        .mockRejectedValueOnce(rejection)
        .mockResolvedValueOnce(jsonResponse(gate))
      const retryWithoutProxy = vi.fn(async () => {})
      const restoreProxy = vi.fn(async () => {})
      await expect(readServiceStatus({ url, fetch, retryWithoutProxy, restoreProxy, ...signedKeys })).resolves.toMatchObject({ minimumVersion: '0.2.22' })
      expect(retryWithoutProxy).toHaveBeenCalledOnce()
      expect(restoreProxy).toHaveBeenCalledOnce()
    }
  })

  it('gives the direct read a timeout of its own', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(proxyConnectionError())
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
    const restoreProxy = vi.fn(async () => {})
    await expect(readServiceStatus({ url, fetch, timeoutMs: 10, retryWithoutProxy: async () => {}, restoreProxy })).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
    const [firstInit, secondInit] = fetch.mock.calls.map((call) => call[1] as RequestInit)
    expect(secondInit.signal).not.toBe(firstInit.signal)
    expect(restoreProxy).toHaveBeenCalledOnce()
  })

  it('puts the session back even when the direct read fails or switching to direct throws', async () => {
    const failedDirect = vi.fn(async () => {})
    await expect(readServiceStatus({
      url,
      fetch: vi.fn().mockRejectedValue(proxyConnectionError()),
      retryWithoutProxy: async () => {},
      restoreProxy: failedDirect,
    })).resolves.toBeNull()
    expect(failedDirect).toHaveBeenCalledOnce()

    const fetch = vi.fn().mockRejectedValue(proxyConnectionError())
    const failedSwitch = vi.fn(async () => {})
    await expect(readServiceStatus({
      url,
      fetch,
      retryWithoutProxy: async () => { throw new Error('setProxy failed') },
      restoreProxy: failedSwitch,
    })).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
    expect(failedSwitch).toHaveBeenCalledOnce()
  })

  it('keeps what the direct read got when putting the session back fails', async () => {
    const session = proxiedSession()
    session.restoreProxy.mockRejectedValueOnce(new Error('setProxy failed'))
    await expect(readServiceStatus({ url, ...session, ...signedKeys })).resolves.toMatchObject({ minimumVersion: '0.2.22' })
  })

  it('reads only once when no direct retry was handed in', async () => {
    const fetch = vi.fn().mockRejectedValue(proxyConnectionError())
    await expect(readServiceStatus({ url, fetch })).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    ['a proxy that is running but refuses the tunnel', new Error('net::ERR_TUNNEL_CONNECTION_FAILED')],
    ['no network at all', new Error('net::ERR_INTERNET_DISCONNECTED')],
    ['a longer message that ends with the code', new Error('请求失败 net::ERR_PROXY_CONNECTION_FAILED')],
    ['a plain object shaped like the Electron error', { message: 'net::ERR_PROXY_CONNECTION_FAILED' }],
    ['a bare string', 'net::ERR_PROXY_CONNECTION_FAILED'],
    ['the read timing out', new DOMException('aborted', 'AbortError')],
  ])('does not leave the system proxy for %s', async (_label, rejection) => {
    const fetch = vi.fn().mockRejectedValue(rejection)
    const retryWithoutProxy = vi.fn(async () => {})
    const restoreProxy = vi.fn(async () => {})
    await expect(readServiceStatus({ url, fetch, retryWithoutProxy, restoreProxy })).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
    expect(retryWithoutProxy).not.toHaveBeenCalled()
    expect(restoreProxy).not.toHaveBeenCalled()
  })

  it('does not leave the system proxy when the file answered but could not be used', async () => {
    for (const fetch of [
      vi.fn(async () => new Response('missing', { status: 404 })),
      vi.fn(async () => jsonResponse('<html>请先登录</html>')),
      vi.fn(async () => jsonResponse('x'.repeat(17 * 1024))),
    ]) {
      const retryWithoutProxy = vi.fn(async () => {})
      await expect(readServiceStatus({ url, fetch, retryWithoutProxy, restoreProxy: async () => {} })).resolves.toBeNull()
      expect(fetch).toHaveBeenCalledOnce()
      expect(retryWithoutProxy).not.toHaveBeenCalled()
    }
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

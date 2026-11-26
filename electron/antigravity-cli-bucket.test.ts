import { describe, expect, it, vi } from 'vitest'
import {
  antigravityCliBucketIndexUrl, parseAntigravityCliBucketIndex, readAntigravityCliBucketRelease,
} from './antigravity-cli-bucket'
import type { AntigravityCliPlatform } from './antigravity-cli-release'
import { desktopPackageBucketOrigin, DesktopBucketUnavailableError } from './desktop-package-bucket'

// Nothing here reaches the real bucket: every index is built in the exact shape
// scripts/sync-antigravity-cli-cos.cjs publishes and served by a fake fetch.
const mib = 1024 * 1024
const sha256 = 'ab'.repeat(32)
const otherSha256 = 'cd'.repeat(32)
const sha512 = 'ef'.repeat(64)
const build = '5514532022517760'
const prefix = 'xingmang/offline/antigravity-cli'

const specs = {
  'windows-x64': { family: 'windows', architecture: 'x64', manifest: 'windows_amd64', extension: 'exe', contentType: 'application/octet-stream', verification: 'windows-authenticode-google', source: 'windows-x64/cli_windows_x64.exe' },
  'windows-arm64': { family: 'windows', architecture: 'arm64', manifest: 'windows_arm64', extension: 'exe', contentType: 'application/octet-stream', verification: 'windows-authenticode-google', source: 'windows-arm/cli_windows_arm64.exe' },
  'macos-x64': { family: 'macos', architecture: 'x64', manifest: 'darwin_amd64', extension: 'tar.gz', contentType: 'application/gzip', verification: 'macos-developer-id-google', source: 'darwin-x64/cli_mac_x64.tar.gz' },
  'macos-arm64': { family: 'macos', architecture: 'arm64', manifest: 'darwin_arm64', extension: 'tar.gz', contentType: 'application/gzip', verification: 'macos-developer-id-google', source: 'darwin-arm/cli_mac_arm64.tar.gz' },
} as const

type PlatformId = keyof typeof specs

function objectUrl(key: string): string {
  return `${desktopPackageBucketOrigin}/${key}`
}

function agyFile(platformId: PlatformId, version = '1.5.15', extra: Record<string, unknown> = {}, releaseBuild = build) {
  const spec = specs[platformId]
  const key = `${prefix}/${platformId}/sha256-${sha256}/agy-${version}-${platformId}.${spec.extension}`
  return {
    platformId, platform: spec.family, architecture: spec.architecture, manifest: spec.manifest, key, url: objectUrl(key),
    bytes: 235 * mib, sha256, sha512, contentType: spec.contentType, verification: spec.verification,
    sourceUrl: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-${releaseBuild}/${spec.source}`,
    cosEtag: '"etag"', ...extra,
  }
}

function windowsRelease(version = '1.5.15', files: unknown[] = [agyFile('windows-x64', version), agyFile('windows-arm64', version)]) {
  return { version, build, files }
}

function macosRelease(version = '1.5.15', files: unknown[] = [agyFile('macos-arm64', version), agyFile('macos-x64', version)]) {
  return { version, build, files }
}

function agyIndex(family: 'windows' | 'macos', releases: unknown[], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1, product: 'antigravity-cli', family,
    generatedAt: '2026-11-23T06:23:00.000Z', checkedAt: '2026-11-23T06:23:00.000Z', releases, ...overrides,
  })
}

function windowsIndex(releases: unknown[] = [windowsRelease('1.5.15'), windowsRelease('1.5.14')], overrides: Record<string, unknown> = {}) {
  return agyIndex('windows', releases, overrides)
}

describe('Antigravity CLI bucket index', () => {
  it.each([
    ['windows_amd64', 'windows-x64', 'windows', 'executable'],
    ['windows_arm64', 'windows-arm64', 'windows', 'executable'],
    ['darwin_amd64', 'macos-x64', 'macos', 'tar.gz'],
    ['darwin_arm64', 'macos-arm64', 'macos', 'tar.gz'],
  ] as const)('reads the newest release for %s from its own family index', (platform, platformId, family, packaging) => {
    const text = family === 'windows' ? windowsIndex() : agyIndex('macos', [macosRelease('1.5.15'), macosRelease('1.5.14')])
    const spec = specs[platformId]
    const key = `${prefix}/${platformId}/sha256-${sha256}/agy-1.5.15-${platformId}.${spec.extension}`
    expect(parseAntigravityCliBucketIndex(text, platform)).toEqual({
      platform, version: '1.5.15', build, url: objectUrl(key), bytes: 235 * mib, sha256, sha512,
      contentType: spec.contentType, packaging, checkedAt: '2026-11-23T06:23:00.000Z',
    })
    expect(antigravityCliBucketIndexUrl(platform)).toBe(objectUrl(`${prefix}/${family}.json`))
  })

  it('leaves checkedAt out when the index does not carry one', () => {
    const text = windowsIndex(undefined, { checkedAt: undefined })
    expect(parseAntigravityCliBucketIndex(text, 'windows_amd64')).not.toHaveProperty('checkedAt')
  })

  it('refuses the other family\'s index', () => {
    expect(parseAntigravityCliBucketIndex(windowsIndex(), 'darwin_arm64')).toBeNull()
    expect(parseAntigravityCliBucketIndex(agyIndex('macos', [macosRelease()]), 'windows_amd64')).toBeNull()
    // A macOS index relabelled as Windows still carries macOS files, which do not match.
    expect(parseAntigravityCliBucketIndex(agyIndex('windows', [macosRelease()]), 'windows_amd64')).toBeNull()
  })

  it.each([
    ['empty text', ''],
    ['not JSON', '{'],
    ['an oversized document', windowsIndex(undefined, { padding: 'x'.repeat(130 * 1024) })],
    ['another schema', windowsIndex(undefined, { schemaVersion: 2 })],
    ['another product', windowsIndex(undefined, { product: 'grok-cli' })],
    ['no releases', windowsIndex([])],
    ['too many releases', windowsIndex(Array.from({ length: 17 }, (_, index) => windowsRelease(`1.5.${index}`)))],
    ['a malformed version', windowsIndex([windowsRelease('1.5.15 && calc')])],
    ['a version with a leading zero', windowsIndex([windowsRelease('1.05.15')])],
    ['a malformed build', windowsIndex([{ ...windowsRelease(), build: '../5514' }])],
    ['no files list', windowsIndex([{ version: '1.5.15', build }])],
    ['no file for this processor', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-arm64')])])],
    ['two files for this processor', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64'), agyFile('windows-x64')])])],
    ['the other processor\'s file under this platform id', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-arm64', '1.5.15', { platformId: 'windows-x64' })])])],
    ['another version\'s file', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.14')])])],
    ['another architecture', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { architecture: 'arm64' })])])],
    ['another platform family', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { platform: 'macos' })])])],
    ['another Google manifest', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { manifest: 'windows_arm64' })])])],
    ['a key whose folder is not the digest', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { key: `${prefix}/windows-x64/sha256-${otherSha256}/agy-1.5.15-windows-x64.exe` })])])],
    ['a key outside the prefix', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { key: `xingmang/offline/grok/windows-x64/sha256-${sha256}/agy-1.5.15-windows-x64.exe` })])])],
    ['a URL that is not origin plus key', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { url: 'https://storage.googleapis.com/antigravity-public/agy.exe' })])])],
    ['another content type', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { contentType: 'text/html' })])])],
    ['another verification', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { verification: 'none' })])])],
    ['a source that is not Google\'s artifact for this build', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', {}, '1234')])])],
    ['a source on another host', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { sourceUrl: 'https://evil.example/cli_windows_x64.exe' })])])],
    ['an upper-case SHA-256', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { sha256: sha256.toUpperCase() })])])],
    ['a short SHA-512', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { sha512: 'ef'.repeat(32) })])])],
    ['no SHA-512', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { sha512: undefined })])])],
    ['a tiny file', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { bytes: 1024 })])])],
    ['an oversized file', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { bytes: 513 * mib })])])],
    ['a fractional size', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { bytes: 235 * mib + 0.5 })])])],
    ['a size given as text', windowsIndex([windowsRelease('1.5.15', [agyFile('windows-x64', '1.5.15', { bytes: String(235 * mib) })])])],
  ])('refuses an index with %s', (_label, text) => {
    expect(parseAntigravityCliBucketIndex(text, 'windows_amd64')).toBeNull()
  })

  it('only looks at the first release, which the sync always writes newest', () => {
    // A broken newest release is not skipped in favour of an older one: that would quietly install an old build.
    const text = windowsIndex([windowsRelease('1.5.15', [agyFile('windows-arm64')]), windowsRelease('1.5.14')])
    expect(parseAntigravityCliBucketIndex(text, 'windows_amd64')).toBeNull()
  })
})

describe('Antigravity CLI bucket index requests', () => {
  function indexFetch(text: string, date = 'Sun, 23 Nov 2026 10:00:00 GMT') {
    return vi.fn<typeof globalThis.fetch>(async () => new Response(text, { status: 200, headers: { 'content-type': 'application/json', date } }))
  }

  it('reads this family\'s index without caches or credentials and refuses redirects', async () => {
    const fetch = indexFetch(agyIndex('macos', [macosRelease()]))
    await expect(readAntigravityCliBucketRelease('darwin_arm64', fetch)).resolves.toMatchObject({ version: '1.5.15', packaging: 'tar.gz' })
    expect(fetch).toHaveBeenCalledWith(objectUrl(`${prefix}/macos.json`), expect.objectContaining({
      redirect: 'manual', credentials: 'omit', headers: expect.objectContaining({ 'Cache-Control': 'no-cache' }), signal: expect.any(AbortSignal),
    }))
  })

  it.each([
    ['an HTTP error', async () => new Response('missing', { status: 404 }), 'Antigravity 命令行清单返回 HTTP 404'],
    ['a redirect', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), '存储桶返回了跳转（HTTP 302）'],
    ['an index without this processor', async () => new Response(windowsIndex([windowsRelease('1.5.15', [agyFile('windows-arm64')])]), { status: 200 }), '存储桶里没有这台电脑能装的 Antigravity 命令行'],
    ['a network failure', async () => { throw new TypeError('fetch failed') }, 'fetch failed'],
  ] as const)('turns %s into a quiet fallback', async (_label, respond, message) => {
    const failure = await readAntigravityCliBucketRelease('windows_amd64', vi.fn<typeof globalThis.fetch>(respond)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
    expect((failure as Error).message).toContain(message)
  })

  it('passes the customer cancel through instead of falling back', async () => {
    const controller = new AbortController()
    const reason = new Error('客户取消了')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort(reason)
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(readAntigravityCliBucketRelease('windows_amd64', fetch, controller.signal)).rejects.toBe(reason)
  })

  // The sync asks Google for its version every 6 hours and rewrites checkedAt even when nothing
  // changed. A day without that means Google may have moved on, so the client goes to Google.
  it('uses the bucket while the index was checked within a day of the bucket\'s own clock', async () => {
    const fetch = indexFetch(windowsIndex(undefined, { checkedAt: '2026-11-22T10:00:00.000Z' }))
    await expect(readAntigravityCliBucketRelease('windows_arm64', fetch)).resolves.toMatchObject({ checkedAt: '2026-11-22T10:00:00.000Z' })
  })

  it('falls back to Google when the index was checked more than a day ago', async () => {
    const fetch = indexFetch(windowsIndex(undefined, { checkedAt: '2026-11-22T09:59:59.000Z' }))
    const failure = await readAntigravityCliBucketRelease('windows_arm64', fetch).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
    expect((failure as Error).message).toBe('存储桶清单超过 24 小时没和官方核对过（上次是 2026-11-22T09:59:59.000Z），桶里的可能不是最新版')
  })
})

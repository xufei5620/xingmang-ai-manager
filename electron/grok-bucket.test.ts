import { describe, expect, it, vi } from 'vitest'
import { desktopPackageBucketOrigin, DesktopBucketUnavailableError } from './desktop-package-bucket'
import { grokBucketIndexUrl, parseGrokBucketIndex, readGrokBucketRelease } from './grok-bucket'

// Nothing here reaches the real bucket: every index is built in the exact shape
// scripts/sync-grok-cos.cjs publishes and served by a fake fetch.
const mib = 1024 * 1024
const sha = 'ab'.repeat(32)
const otherSha = 'cd'.repeat(32)
const artifacts = { x64: ['windows-x64', 'windows-x86_64'], arm64: ['windows-arm64', 'windows-aarch64'] } as const

function objectUrl(key: string): string {
  return `${desktopPackageBucketOrigin}/${key}`
}

function grokFile(version: string, architecture: 'x64' | 'arm64', extra: Record<string, unknown> = {}) {
  const [platformId, artifact] = artifacts[architecture]
  const key = `xingmang/offline/grok/${platformId}/sha256-${sha}/grok-${version}-${artifact}.exe`
  return {
    platformId, platform: 'windows', architecture, key, url: objectUrl(key), bytes: 160 * mib, sha256: sha,
    contentType: 'application/octet-stream', verification: 'windows-authenticode-xai',
    sourceUrl: `https://x.ai/cli/grok-${version}-${artifact}.exe`, cosEtag: '"etag"', ...extra,
  }
}

function grokRelease(version: string, files: unknown[] = [grokFile(version, 'x64'), grokFile(version, 'arm64')]) {
  return { version, files }
}

function grokIndex(releases: unknown[] = [grokRelease('1.0.52'), grokRelease('1.0.46')], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1, product: 'grok-cli', generatedAt: '2026-10-14T00:00:00.000Z',
    stable: { version: '1.0.52', url: 'https://x.ai/cli/stable' }, releases, ...overrides,
  })
}

describe('Grok bucket index', () => {
  it('picks the stable release for this processor when no version is named', () => {
    expect(parseGrokBucketIndex(grokIndex(), 'x64')).toEqual({
      version: '1.0.52', bytes: 160 * mib, sha256: sha, contentType: 'application/octet-stream',
      url: objectUrl(`xingmang/offline/grok/windows-x64/sha256-${sha}/grok-1.0.52-windows-x86_64.exe`),
    })
    expect(parseGrokBucketIndex(grokIndex(), 'arm64')?.url).toBe(objectUrl(`xingmang/offline/grok/windows-arm64/sha256-${sha}/grok-1.0.52-windows-aarch64.exe`))
    expect(parseGrokBucketIndex(grokIndex(), 'x64', 'latest')?.version).toBe('1.0.52')
    expect(grokBucketIndexUrl()).toBe(objectUrl('xingmang/offline/grok/latest.json'))
  })

  it('picks a named version that is not newer than stable', () => {
    expect(parseGrokBucketIndex(grokIndex(), 'x64', '1.0.46')?.url).toBe(objectUrl(`xingmang/offline/grok/windows-x64/sha256-${sha}/grok-1.0.46-windows-x86_64.exe`))
    expect(parseGrokBucketIndex(grokIndex(), 'x64', ' 1.0.52 ')?.version).toBe('1.0.52')
    // The bucket's stable can lag xAI's by a sync interval, so a newer named version is xAI's call.
    expect(parseGrokBucketIndex(grokIndex(), 'x64', '1.0.60')).toBeNull()
    // A version the bucket does not carry falls back to xAI instead of installing another one.
    expect(parseGrokBucketIndex(grokIndex(), 'x64', '1.0.40')).toBeNull()
    expect(() => parseGrokBucketIndex(grokIndex(), 'x64', '1.0.46 && calc')).toThrow('版本号无效')
  })

  it.each([
    ['empty text', ''],
    ['not JSON', '{'],
    ['another schema', grokIndex(undefined, { schemaVersion: 2 })],
    ['another product', grokIndex(undefined, { product: 'opencode-desktop' })],
    ['no stable', grokIndex(undefined, { stable: null })],
    ['a malformed stable', grokIndex(undefined, { stable: { version: 'latest' } })],
    ['no release for stable', grokIndex([grokRelease('1.0.46')])],
    ['two releases for stable', grokIndex([grokRelease('1.0.52'), grokRelease('1.0.52')])],
    ['no file for this processor', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'arm64')])])],
    ['two files for this processor', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'x64'), grokFile('1.0.52', 'x64')])])],
    ['the other processor\'s binary', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'arm64', { platformId: 'windows-x64' })])])],
    ['another version\'s binary', grokIndex([grokRelease('1.0.52', [grokFile('1.0.46', 'x64')])])],
    ['a key whose folder is not the digest', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'x64', { key: `xingmang/offline/grok/windows-x64/sha256-${otherSha}/grok-1.0.52-windows-x86_64.exe` })])])],
    ['a URL that is not origin plus key', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'x64', { url: 'https://x.ai/cli/grok-1.0.52-windows-x86_64.exe' })])])],
    ['another content type', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'x64', { contentType: 'text/html' })])])],
    ['another verification', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'x64', { verification: 'none' })])])],
    ['an upper-case digest', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'x64', { sha256: sha.toUpperCase() })])])],
    ['a tiny binary', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'x64', { bytes: 1024 })])])],
    ['an oversized binary', grokIndex([grokRelease('1.0.52', [grokFile('1.0.52', 'x64', { bytes: 513 * mib })])])],
    ['too many releases', grokIndex(Array.from({ length: 33 }, (_, index) => grokRelease(`1.0.${index}`)))],
  ])('refuses an index with %s', (_label, text) => {
    expect(parseGrokBucketIndex(text, 'x64')).toBeNull()
  })

  it('refuses a processor Grok does not ship for Windows', () => {
    expect(parseGrokBucketIndex(grokIndex(), 'ia32')).toBeNull()
  })
})

describe('Grok bucket index requests', () => {
  it('reads the index without caches or credentials and refuses redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(grokIndex(), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(readGrokBucketRelease('arm64', '1.0.46', fetch)).resolves.toMatchObject({ version: '1.0.46' })
    expect(fetch).toHaveBeenCalledWith(objectUrl('xingmang/offline/grok/latest.json'), expect.objectContaining({
      redirect: 'manual', credentials: 'omit', headers: expect.objectContaining({ 'Cache-Control': 'no-cache' }), signal: expect.any(AbortSignal),
    }))
  })

  it.each([
    ['an HTTP error', async () => new Response('missing', { status: 404 }), 'Grok 清单返回 HTTP 404'],
    ['a redirect', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), '存储桶返回了跳转（HTTP 302）'],
    ['an index without the version', async () => new Response(grokIndex([grokRelease('1.0.52')]), { status: 200 }), '存储桶里没有要装的这一版 Grok'],
    ['a network failure', async () => { throw new TypeError('fetch failed') }, 'fetch failed'],
  ] as const)('turns %s into a quiet fallback', async (_label, respond, message) => {
    const failure = await readGrokBucketRelease('x64', '1.0.46', vi.fn<typeof globalThis.fetch>(respond)).catch((error: unknown) => error)
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
    await expect(readGrokBucketRelease('x64', undefined, fetch, controller.signal)).rejects.toBe(reason)
  })
})

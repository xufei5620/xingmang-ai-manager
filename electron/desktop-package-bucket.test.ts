import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeDesktopBucketFallback, desktopBucketIndexMaximumAgeMs, desktopBucketIndexUrl, desktopBucketResponseTime,
  desktopPackageBucketOrigin, DesktopBucketUnavailableError, downloadDesktopBucketPackage, fetchDesktopBucketResource,
  isDesktopAlternativeClearlyFaster, isDesktopBucketDownloadTooSlow, isDesktopBucketIndexStale,
  measureDesktopDownloadSpeed, parseDesktopBucketIndex, readDesktopBucketPackage, validateDesktopBucketUrl,
  type DesktopAlternativeSpeed, type DesktopBucketDownloadProgress, type DesktopBucketPackage, type DesktopBucketPackageId,
} from './desktop-package-bucket'

// Nothing here reaches the real bucket: every request goes to a fake fetch, and the
// indexes are built in the exact shape scripts/sync-*-official-cos.cjs publish.
const mib = 1024 * 1024
const sha = 'ab'.repeat(32)
const otherSha = 'cd'.repeat(32)
const windowsVersion = '26.1003.4512.0'
const temporaryDirectories: string[] = []

function objectUrl(key: string): string {
  return `${desktopPackageBucketOrigin}/${key}`
}

function codexWindowsEntry(architecture: 'x64' | 'arm64', extra: Record<string, unknown> = {}, artifact: Record<string, unknown> = {}) {
  const key = `chatgpt/windows-${architecture}/${windowsVersion}/ChatGPT-${architecture}.msix`
  return {
    platform: 'windows', architecture, format: 'msix', packageVersion: windowsVersion,
    source: { url: 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT.msix' },
    artifact: {
      key, url: objectUrl(key), bytes: 180 * mib, sha256: sha, contentType: 'application/vnd.ms-appx',
      verification: 'windows-authenticode', cosEtag: '"etag"', ...artifact,
    },
    license: { key: `chatgpt/windows-${architecture}/${windowsVersion}/ChatGPT-License.xml` },
    ...extra,
  }
}

function codexMacEntry(architecture: 'arm64' | 'x64', extra: Record<string, unknown> = {}, artifact: Record<string, unknown> = {}) {
  const key = `chatgpt/macos-${architecture}/sha256-${sha}/ChatGPT-darwin-${architecture}-26.1003.2.zip`
  return {
    platform: 'macos', architecture, format: 'zip', appVersion: '26.1003.2', buildVersion: '2401',
    artifact: {
      key, url: objectUrl(key), bytes: 240 * mib, sha256: sha, contentType: 'application/zip',
      verification: 'official-https-sha256', cosEtag: '"etag"', ...artifact,
    },
    ...extra,
  }
}

function codexIndex(overrides: Record<string, unknown> = {}, platforms: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    product: 'chatgpt',
    windows: { schemaVersion: 1, buildVersion: windowsVersion, packageIdentity: 'OpenAI.Codex', storeProductId: '9PLM9XGG6VKS' },
    platforms: {
      'windows-x64': codexWindowsEntry('x64'),
      'windows-arm64': codexWindowsEntry('arm64'),
      'macos-arm64': codexMacEntry('arm64'),
      'macos-x64': codexMacEntry('x64'),
      ...platforms,
    },
    ...overrides,
  })
}

const claudeFiles = {
  'windows-x64': { fileName: 'Claude-x64.msix', version: '1.1.2345.0', platform: 'windows', architecture: 'x64', format: 'msix', type: 'application/vnd.ms-appx', verification: 'windows-authenticode-msix-identity' },
  'windows-arm64': { fileName: 'Claude-arm64.msix', version: '1.1.2345.0', platform: 'windows', architecture: 'arm64', format: 'msix', type: 'application/vnd.ms-appx', verification: 'windows-authenticode-msix-identity' },
  'macos-dmg-universal': { fileName: 'Claude-universal.dmg', version: '1.1.2345', platform: 'macos', architecture: 'universal', format: 'dmg', type: 'application/x-apple-diskimage', verification: 'macos-dmg-signature' },
  'macos-pkg-universal': { fileName: 'Claude-universal.pkg', version: '1.1.2345', platform: 'macos', architecture: 'universal', format: 'pkg', type: 'application/vnd.apple.installer+xml', verification: 'macos-installer-signature' },
} as const

function claudeFile(platformId: keyof typeof claudeFiles, extra: Record<string, unknown> = {}) {
  const base = claudeFiles[platformId]
  const key = `xingmang/offline/claude/${platformId}/sha256-${sha}/${base.fileName}`
  return {
    platformId, ...base, kind: 'installer', key, url: objectUrl(key), size: 150 * mib, sha256: sha, cosEtag: '"etag"',
    source: { url: 'https://downloads.claude.ai/releases/example' }, inspection: {}, ...extra,
  }
}

function claudeIndex(files: unknown[] = Object.keys(claudeFiles).map((id) => claudeFile(id as keyof typeof claudeFiles)), overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 1, product: 'claude-desktop', files, ...overrides })
}

function openCodeFile(architecture: 'arm64' | 'x64', extra: Record<string, unknown> = {}) {
  const fileName = `opencode-desktop-mac-${architecture}.app.tar.gz`
  const key = `xingmang/offline/opencode/macos-${architecture}/sha256-${sha}/${fileName}`
  return {
    platformId: `macos-${architecture}`, platform: 'macos', architecture, kind: 'app-archive', format: 'tar.gz', fileName,
    type: 'application/gzip', verification: 'macos-developer-id-notarized', version: '1.18.34', key, url: objectUrl(key),
    size: 152 * mib, sha256: sha, sourceUrl: `https://github.com/anomalyco/opencode/releases/download/v1.18.34/${fileName}`, cosEtag: '"etag"', ...extra,
  }
}

function openCodeIndex(files: unknown[] = [openCodeFile('arm64'), openCodeFile('x64')], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1, product: 'opencode-desktop', generatedAt: '2026-10-14T00:00:00.000Z', version: '1.18.34',
    source: { feedUrl: 'https://github.com/anomalyco/opencode/releases/latest/download/latest.json' }, files, ...overrides,
  })
}

function release(payload: Buffer, extra: Partial<DesktopBucketPackage> = {}): DesktopBucketPackage {
  const digest = createHash('sha256').update(payload).digest('hex')
  const key = `xingmang/offline/claude/windows-x64/sha256-${digest}/Claude-x64.msix`
  return {
    id: 'claude-windows-x64', version: '1.1.2345.0', url: objectUrl(key), bytes: payload.byteLength, sha256: digest,
    contentType: 'application/vnd.ms-appx', ...extra,
  }
}

function packageResponse(body: BodyInit | null, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/vnd.ms-appx', ...headers } })
}

async function temporaryFile(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-desktop-bucket-test-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'package.msix')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })))
})

describe('desktop package bucket indexes', () => {
  it('reads each Codex package the sync script publishes', () => {
    expect(parseDesktopBucketIndex(codexIndex(), 'codex-windows-x64')).toEqual({
      id: 'codex-windows-x64', version: windowsVersion, bytes: 180 * mib, sha256: sha, contentType: 'application/vnd.ms-appx',
      url: objectUrl(`chatgpt/windows-x64/${windowsVersion}/ChatGPT-x64.msix`),
    })
    expect(parseDesktopBucketIndex(codexIndex(), 'codex-windows-arm64')?.url).toBe(objectUrl(`chatgpt/windows-arm64/${windowsVersion}/ChatGPT-arm64.msix`))
    expect(parseDesktopBucketIndex(codexIndex(), 'codex-macos-arm64')).toEqual({
      id: 'codex-macos-arm64', version: '26.1003.2', bytes: 240 * mib, sha256: sha, contentType: 'application/zip',
      url: objectUrl(`chatgpt/macos-arm64/sha256-${sha}/ChatGPT-darwin-arm64-26.1003.2.zip`),
    })
    expect(parseDesktopBucketIndex(codexIndex(), 'codex-macos-x64')?.version).toBe('26.1003.2')
  })

  it('reads each Claude package the sync script publishes and ignores the DMG', () => {
    expect(parseDesktopBucketIndex(claudeIndex(), 'claude-windows-x64')).toEqual({
      id: 'claude-windows-x64', version: '1.1.2345.0', bytes: 150 * mib, sha256: sha, contentType: 'application/vnd.ms-appx',
      url: objectUrl(`xingmang/offline/claude/windows-x64/sha256-${sha}/Claude-x64.msix`),
    })
    expect(parseDesktopBucketIndex(claudeIndex(), 'claude-windows-arm64')?.url).toBe(objectUrl(`xingmang/offline/claude/windows-arm64/sha256-${sha}/Claude-arm64.msix`))
    expect(parseDesktopBucketIndex(claudeIndex(), 'claude-macos-universal')).toEqual({
      id: 'claude-macos-universal', version: '1.1.2345', bytes: 150 * mib, sha256: sha, contentType: 'application/vnd.apple.installer+xml',
      url: objectUrl(`xingmang/offline/claude/macos-pkg-universal/sha256-${sha}/Claude-universal.pkg`),
    })
  })

  it('reads each OpenCode archive the sync script publishes', () => {
    expect(parseDesktopBucketIndex(openCodeIndex(), 'opencode-macos-arm64')).toEqual({
      id: 'opencode-macos-arm64', version: '1.18.34', bytes: 152 * mib, sha256: sha, contentType: 'application/gzip',
      url: objectUrl(`xingmang/offline/opencode/macos-arm64/sha256-${sha}/opencode-desktop-mac-arm64.app.tar.gz`),
    })
    expect(parseDesktopBucketIndex(openCodeIndex(), 'opencode-macos-x64')?.url).toBe(objectUrl(`xingmang/offline/opencode/macos-x64/sha256-${sha}/opencode-desktop-mac-x64.app.tar.gz`))
    expect(desktopBucketIndexUrl('opencode-macos-arm64')).toBe(objectUrl('xingmang/offline/opencode/latest.json'))
    expect(desktopBucketIndexUrl('opencode-macos-x64')).toBe(objectUrl('xingmang/offline/opencode/latest.json'))
  })

  it('reads the Codex and Claude indexes from their fixed keys', () => {
    expect(desktopBucketIndexUrl('codex-windows-x64')).toBe(objectUrl('chatgpt/latest.json'))
    expect(desktopBucketIndexUrl('codex-macos-arm64')).toBe(objectUrl('chatgpt/latest.json'))
    expect(desktopBucketIndexUrl('claude-windows-arm64')).toBe(objectUrl('xingmang/offline/claude/latest.json'))
    expect(desktopBucketIndexUrl('claude-macos-universal')).toBe(objectUrl('xingmang/offline/claude/latest.json'))
  })

  it.each([
    ['empty text', ''],
    ['not JSON', '{'],
    ['an array', '[]'],
    ['another schema', codexIndex({ schemaVersion: 2 })],
    ['another product', codexIndex({ product: 'claude-desktop' })],
    ['no platforms', codexIndex({ platforms: null })],
    ['a missing platform', codexIndex({}, { 'windows-x64': undefined })],
    ['another package identity', codexIndex({ windows: { buildVersion: windowsVersion, packageIdentity: 'OpenAI.Other' } })],
    ['a build version that differs from the package', codexIndex({ windows: { buildVersion: '26.1003.4513.0', packageIdentity: 'OpenAI.Codex' } })],
    ['a malformed package version', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', { packageVersion: '26.1003' }) })],
    ['the wrong architecture', codexIndex({}, { 'windows-x64': codexWindowsEntry('arm64') })],
    ['another format', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', { format: 'appx' }) })],
    ['a key in another folder', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { key: 'chatgpt/evil/ChatGPT-x64.msix' }) })],
    ['a URL on another host', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { url: `https://evil.example/chatgpt/windows-x64/${windowsVersion}/ChatGPT-x64.msix` }) })],
    ['a lookalike host', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { url: `${desktopPackageBucketOrigin}.evil.example/chatgpt/windows-x64/${windowsVersion}/ChatGPT-x64.msix` }) })],
    ['a URL with a query', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { url: `${objectUrl(`chatgpt/windows-x64/${windowsVersion}/ChatGPT-x64.msix`)}?x=1` }) })],
    ['another content type', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { contentType: 'application/octet-stream' }) })],
    ['another verification', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { verification: 'none' }) })],
    ['an upper-case digest', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { sha256: sha.toUpperCase() }) })],
    ['a tiny package', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { bytes: 1024 }) })],
    ['an oversized package', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { bytes: 1_600 * mib }) })],
    ['a fractional size', codexIndex({}, { 'windows-x64': codexWindowsEntry('x64', {}, { bytes: 180 * mib + 0.5 }) })],
  ])('refuses a Codex Windows index with %s', (_label, text) => {
    expect(parseDesktopBucketIndex(text, 'codex-windows-x64')).toBeNull()
  })

  it.each([
    ['a malformed app version', codexMacEntry('arm64', { appVersion: '26.1003' })],
    ['a Mac key whose folder is not the digest', codexMacEntry('arm64', {}, { key: `chatgpt/macos-arm64/sha256-${otherSha}/ChatGPT-darwin-arm64-26.1003.2.zip` })],
    ['a Mac key for another version', codexMacEntry('arm64', {}, { key: `chatgpt/macos-arm64/sha256-${sha}/ChatGPT-darwin-arm64-26.1003.1.zip` })],
    ['a Mac DMG', codexMacEntry('arm64', { format: 'dmg' })],
  ])('refuses a Codex Mac index with %s', (_label, entry) => {
    expect(parseDesktopBucketIndex(codexIndex({}, { 'macos-arm64': entry }), 'codex-macos-arm64')).toBeNull()
  })

  it.each([
    ['another product', claudeIndex(undefined, { product: 'chatgpt' })],
    ['no files', claudeIndex(undefined, { files: null })],
    ['too many files', claudeIndex(Array.from({ length: 17 }, () => claudeFile('windows-arm64')))],
    ['no entry for this platform', claudeIndex([claudeFile('windows-arm64')])],
    ['two entries for this platform', claudeIndex([claudeFile('windows-x64'), claudeFile('windows-x64')])],
    ['another file name', claudeIndex([claudeFile('windows-x64', { fileName: 'Claude.msix' })])],
    ['another kind', claudeIndex([claudeFile('windows-x64', { kind: 'license' })])],
    ['another architecture', claudeIndex([claudeFile('windows-x64', { architecture: 'arm64' })])],
    ['another type', claudeIndex([claudeFile('windows-x64', { type: 'application/octet-stream' })])],
    ['another verification', claudeIndex([claudeFile('windows-x64', { verification: 'none' })])],
    ['a three-part Windows version', claudeIndex([claudeFile('windows-x64', { version: '1.1.2345' })])],
    ['a key whose folder is not the digest', claudeIndex([claudeFile('windows-x64', { key: `xingmang/offline/claude/windows-x64/sha256-${otherSha}/Claude-x64.msix` })])],
    ['a URL that is not origin plus key', claudeIndex([claudeFile('windows-x64', { url: 'https://evil.example/Claude-x64.msix' })])],
    ['a tiny package', claudeIndex([claudeFile('windows-x64', { size: 4096 })])],
  ])('refuses a Claude Windows index with %s', (_label, text) => {
    expect(parseDesktopBucketIndex(text, 'claude-windows-x64')).toBeNull()
  })

  it.each([
    ['the Claude product', openCodeIndex(undefined, { product: 'claude-desktop' })],
    ['no entry for this chip', openCodeIndex([openCodeFile('x64')])],
    ['the other chip\'s archive', openCodeIndex([openCodeFile('arm64', { fileName: 'opencode-desktop-mac-x64.app.tar.gz' }), openCodeFile('x64')])],
    ['a Claude installer kind', openCodeIndex([openCodeFile('arm64', { kind: 'installer' }), openCodeFile('x64')])],
    ['a zip', openCodeIndex([openCodeFile('arm64', { format: 'zip' }), openCodeFile('x64')])],
    ['another type', openCodeIndex([openCodeFile('arm64', { type: 'application/octet-stream' }), openCodeFile('x64')])],
    ['another verification', openCodeIndex([openCodeFile('arm64', { verification: 'none' }), openCodeFile('x64')])],
    ['a prerelease version', openCodeIndex([openCodeFile('arm64', { version: '1.18.34-beta' }), openCodeFile('x64')])],
    ['a key in the Claude folder', openCodeIndex([openCodeFile('arm64', { key: `xingmang/offline/claude/macos-arm64/sha256-${sha}/opencode-desktop-mac-arm64.app.tar.gz` }), openCodeFile('x64')])],
    ['a URL that is not origin plus key', openCodeIndex([openCodeFile('arm64', { url: 'https://evil.example/opencode.tar.gz' }), openCodeFile('x64')])],
    ['an archive above the GitHub cap', openCodeIndex([openCodeFile('arm64', { size: 641 * mib }), openCodeFile('x64')])],
  ])('refuses an OpenCode index with %s', (_label, text) => {
    expect(parseDesktopBucketIndex(text, 'opencode-macos-arm64')).toBeNull()
  })

  it('refuses a Claude Mac PKG with a four-part version and an index larger than the cap', () => {
    expect(parseDesktopBucketIndex(claudeIndex([claudeFile('macos-pkg-universal', { version: '1.1.2345.0' })]), 'claude-macos-universal')).toBeNull()
    const padded = JSON.stringify({ ...JSON.parse(claudeIndex()), padding: 'x'.repeat(256 * 1024) })
    expect(parseDesktopBucketIndex(padded, 'claude-windows-x64')).toBeNull()
  })
})

describe('desktop package bucket addresses', () => {
  it('accepts only object paths under the synced folders on the fixed bucket host', () => {
    for (const key of ['chatgpt/latest.json', `chatgpt/windows-x64/${windowsVersion}/ChatGPT-x64.msix`, 'xingmang/offline/claude/latest.json',
      'xingmang/offline/codex-plugins/latest.json', 'xingmang/offline/grok/latest.json', `xingmang/offline/grok/windows-x64/sha256-${sha}/grok-1.0.52-windows-x86_64.exe`,
      'xingmang/offline/opencode/latest.json']) {
      expect(validateDesktopBucketUrl(objectUrl(key)).href).toBe(objectUrl(key))
    }
    for (const value of [
      objectUrl('chatgpt/latest.json').replace('https:', 'http:'),
      objectUrl('chatgpt/latest.json').replace('.com/', '.com:8443/'),
      objectUrl('chatgpt/latest.json').replace('https://', 'https://user@'),
      `${objectUrl('chatgpt/latest.json')}?versionId=1`,
      `${objectUrl('chatgpt/latest.json')}#top`,
      objectUrl('xingmang/stable/latest.json'),
      objectUrl('xingmang/offline/other/latest.json'),
      objectUrl('xingmang/offline/grokx/latest.json'),
      objectUrl('xingmang/offline/grok'),
      objectUrl('chatgpt/%2e%2e/secret.json'),
      objectUrl('chatgpt/a b.json'),
      'https://xingmang-downloads-1342302199.cos.ap-beijing.myqcloud.com/chatgpt/latest.json',
      'https://evil.example/chatgpt/latest.json',
      'not a url',
    ]) {
      expect(() => validateDesktopBucketUrl(value), value).toThrow(/存储桶地址/)
    }
  })

  it('refuses redirects and responses served from another address', async () => {
    const target = objectUrl('chatgpt/latest.json')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))
    await expect(fetchDesktopBucketResource(target, {}, fetch)).rejects.toThrow('存储桶返回了跳转（HTTP 302）')
    expect(fetch).toHaveBeenCalledWith(target, expect.objectContaining({ redirect: 'manual', credentials: 'omit' }))

    const moved = new Response('{}', { status: 200 })
    Object.defineProperty(moved, 'url', { value: 'https://evil.example/chatgpt/latest.json' })
    await expect(fetchDesktopBucketResource(target, {}, async () => moved)).rejects.toThrow('存储桶的下载被转到了别的地址')
    await expect(fetchDesktopBucketResource('https://evil.example/chatgpt/latest.json', {}, fetch)).rejects.toThrow('存储桶地址不在允许的范围内')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('works with Electron net.fetch, which leaves response.url empty and throws on a manual redirect', async () => {
    const target = objectUrl('chatgpt/latest.json')
    const served = new Response('{}', { status: 200 })
    Object.defineProperty(served, 'url', { value: '' })
    await expect(fetchDesktopBucketResource(target, {}, async () => served)).resolves.toBe(served)

    const redirected = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('Redirect was cancelled') })
    const failure = await readDesktopBucketPackage('codex-windows-x64', redirected).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
  })
})

describe('desktop package bucket index requests', () => {
  it('reads the index without caches or credentials and picks this package', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(claudeIndex(), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(readDesktopBucketPackage('claude-windows-arm64', fetch)).resolves.toMatchObject({ id: 'claude-windows-arm64', version: '1.1.2345.0' })
    expect(fetch).toHaveBeenCalledWith(objectUrl('xingmang/offline/claude/latest.json'), expect.objectContaining({
      redirect: 'manual', credentials: 'omit', headers: expect.objectContaining({ 'Cache-Control': 'no-cache' }), signal: expect.any(AbortSignal),
    }))
  })

  it.each([
    ['an HTTP error', async () => new Response('missing', { status: 404 }), '存储桶清单返回 HTTP 404'],
    ['a redirect', async () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }), '存储桶返回了跳转（HTTP 301）'],
    ['an index without this package', async () => new Response(claudeIndex([claudeFile('windows-arm64')]), { status: 200 }), '存储桶清单里没有这台电脑能用的安装包'],
    ['a network failure', async () => { throw new TypeError('fetch failed') }, 'fetch failed'],
  ] as const)('turns %s into a quiet fallback', async (_label, respond, message) => {
    const failure = await readDesktopBucketPackage('claude-windows-x64', vi.fn<typeof globalThis.fetch>(respond)).catch((error: unknown) => error)
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
    await expect(readDesktopBucketPackage('codex-windows-x64', fetch, controller.signal)).rejects.toBe(reason)
  })

  // The sync refreshes checkedAt on every successful run (every 6 hours), so a day without it means
  // the bucket's "latest" may be behind OpenAI's (#1061 item 7).
  function checkedCodexIndex(checkedAt: string | undefined): string {
    const stamp = checkedAt === undefined ? {} : { checkedAt }
    return codexIndex({}, {
      'windows-x64': codexWindowsEntry('x64', stamp),
      'macos-arm64': codexMacEntry('arm64', stamp),
    })
  }
  function indexFetch(text: string, date = 'Sun, 18 Oct 2026 10:00:00 GMT') {
    return vi.fn<typeof globalThis.fetch>(async () => new Response(text, { status: 200, headers: { 'content-type': 'application/json', date } }))
  }

  it('reads a Codex entry the sync checked within the last day, judged by the bucket clock', async () => {
    for (const id of ['codex-windows-x64', 'codex-macos-arm64'] as const) {
      await expect(readDesktopBucketPackage(id, indexFetch(checkedCodexIndex('2026-10-17T10:00:00.000Z')))).resolves.toMatchObject({
        id, checkedAt: '2026-10-17T10:00:00.000Z',
      })
    }
  })

  it.each([
    ['checked more than a day before the bucket answered', '2026-10-17T09:59:59.000Z'],
    ['never checked', undefined],
    ['checked at an unreadable time', 'yesterday'],
  ])('falls back from a Codex entry %s', async (_label, checkedAt) => {
    for (const id of ['codex-windows-x64', 'codex-macos-arm64'] as const) {
      const failure = await readDesktopBucketPackage(id, indexFetch(checkedCodexIndex(checkedAt))).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
      expect((failure as Error).message).toBe(`存储桶清单超过 24 小时没和官方核对过（上次是 ${checkedAt ?? '没写'}），桶里的可能不是最新版`)
    }
  })

  it('uses the local clock only when the bucket sends no readable date', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-18T10:00:00.000Z'))
    await expect(readDesktopBucketPackage('codex-windows-x64', indexFetch(checkedCodexIndex('2026-10-17T10:00:00.000Z'), 'not a date'))).resolves.toMatchObject({ version: windowsVersion })
    const stale = await readDesktopBucketPackage('codex-windows-x64', indexFetch(checkedCodexIndex('2026-10-17T09:00:00.000Z'), '')).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(DesktopBucketUnavailableError)
  })

  it('leaves the Claude and OpenCode indexes alone, their sync does not write checkedAt yet', async () => {
    await expect(readDesktopBucketPackage('claude-windows-x64', indexFetch(claudeIndex()))).resolves.toMatchObject({ version: '1.1.2345.0' })
    expect(parseDesktopBucketIndex(claudeIndex(), 'claude-windows-x64')).not.toHaveProperty('checkedAt')
  })
})

describe('desktop package bucket index age', () => {
  const now = Date.parse('2026-10-18T10:00:00.000Z')

  it('counts an entry as stale once its last check is more than a day old', () => {
    expect(desktopBucketIndexMaximumAgeMs).toBe(24 * 60 * 60_000)
    expect(isDesktopBucketIndexStale('2026-10-18T09:59:00.000Z', now)).toBe(false)
    expect(isDesktopBucketIndexStale('2026-10-17T10:00:00.000Z', now)).toBe(false)
    expect(isDesktopBucketIndexStale('2026-10-17T10:00:00Z', now)).toBe(false)
    expect(isDesktopBucketIndexStale('2026-10-17T09:59:59.999Z', now)).toBe(true)
    expect(isDesktopBucketIndexStale('2026-10-01T00:00:00.000Z', now)).toBe(true)
  })

  it('does not count a few seconds of clock skew between the sync runner and the bucket', () => {
    expect(isDesktopBucketIndexStale('2026-10-18T10:00:05.000Z', now)).toBe(false)
  })

  it.each([undefined, '', '2026-10-18', '2026-10-18 10:00:00', '2026-10-18T10:00:00+08:00', '2026-13-40T99:00:00.000Z'])('treats %j as never checked', (value) => {
    expect(isDesktopBucketIndexStale(value, now)).toBe(true)
  })

  it('takes the time from the bucket response before the local clock', () => {
    const local = vi.fn(() => now)
    expect(desktopBucketResponseTime(new Response('', { headers: { date: 'Sat, 17 Oct 2026 08:00:00 GMT' } }), local)).toBe(Date.parse('2026-10-17T08:00:00.000Z'))
    expect(local).not.toHaveBeenCalled()
    expect(desktopBucketResponseTime(new Response(''), local)).toBe(now)
  })
})

describe('desktop package bucket downloads', () => {
  it('writes the exact listed bytes and returns the digest the installer pins', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x5a)
    const destination = await temporaryFile()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => packageResponse(payload, { 'content-length': String(payload.byteLength) }))
    const progress: DesktopBucketDownloadProgress[] = []
    const item = release(payload)
    await expect(downloadDesktopBucketPackage(item, destination, { fetch, onProgress: (event) => progress.push(event) })).resolves.toEqual({
      size: payload.byteLength, sha256Base64: createHash('sha256').update(payload).digest('base64'),
    })
    expect(await fs.promises.readFile(destination)).toEqual(payload)
    expect(fetch).toHaveBeenCalledWith(item.url, expect.objectContaining({ redirect: 'manual', credentials: 'omit' }))
    expect(progress.at(-1)).toEqual({ transferred: payload.byteLength, total: payload.byteLength, percent: 100 })
    expect(new Set(progress.map((event) => event.percent)).size).toBe(progress.length)
  })

  it('accepts a generic binary content type', async () => {
    const payload = Buffer.alloc(4096, 1)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => packageResponse(payload, { 'content-type': 'application/octet-stream', 'content-length': '4096' }))
    await expect(downloadDesktopBucketPackage(release(payload), await temporaryFile(), { fetch })).resolves.toMatchObject({ size: 4096 })
  })

  it.each([
    ['an HTTP error', (payload: Buffer) => packageResponse(payload, { 'content-length': String(payload.byteLength) }, 403), '存储桶返回 HTTP 403'],
    ['another content type', (payload: Buffer) => packageResponse(payload, { 'content-type': 'text/html', 'content-length': String(payload.byteLength) }), '文件类型不对'],
    ['a different declared size', (payload: Buffer) => packageResponse(payload, { 'content-length': String(payload.byteLength - 1) }), '大小和清单不一致'],
    ['a missing declared size', (payload: Buffer) => packageResponse(new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close() } })), '大小和清单不一致'],
    ['different bytes', (payload: Buffer) => packageResponse(Buffer.alloc(payload.byteLength, 0x00), { 'content-length': String(payload.byteLength) }), 'SHA-256 和清单不一致'],
  ] as const)('falls back and removes the partial file on %s', async (_label, respond, message) => {
    const payload = Buffer.alloc(4096, 0x5a)
    const destination = await temporaryFile()
    const failure = await downloadDesktopBucketPackage(release(payload), destination, {
      fetch: vi.fn<typeof globalThis.fetch>(async () => respond(payload)),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
    expect((failure as Error).message).toContain(message)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('refuses a body larger than the listed size', async () => {
    const payload = Buffer.alloc(4096, 0x5a)
    const destination = await temporaryFile()
    const longer = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(payload); controller.enqueue(Buffer.from('extra')); controller.close() },
    })
    const failure = await downloadDesktopBucketPackage(release(payload), destination, {
      fetch: async () => packageResponse(longer, { 'content-length': String(payload.byteLength) }),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('picks a broken download up where it stopped and says so once', async () => {
    const payload = Buffer.alloc(8192, 0x7a)
    let calls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      calls += 1
      if (calls === 1) {
        let pulls = 0
        return packageResponse(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(payload.subarray(0, 4096))
            else controller.error(new TypeError('terminated'))
          },
        }), { 'content-length': String(payload.byteLength), etag: '"bucket"' })
      }
      expect(new Headers(init?.headers).get('range')).toBe('bytes=4096-')
      return packageResponse(payload.subarray(4096), {
        'content-length': '4096', 'content-range': `bytes 4096-8191/${payload.byteLength}`, etag: '"bucket"',
      }, 206)
    })
    const progress: DesktopBucketDownloadProgress[] = []
    await expect(downloadDesktopBucketPackage(release(payload), await temporaryFile(), {
      fetch, onProgress: (event) => progress.push(event), resumeOptions: { wait: async () => undefined },
    })).resolves.toMatchObject({ size: payload.byteLength })
    expect(progress.filter((event) => event.resuming)).toEqual([{ transferred: 4096, total: 8192, percent: 50, resuming: true }])
  })

  it('gives up on a download that would take too long and lets the old routes take over', async () => {
    const payload = Buffer.alloc(8192, 0x5a)
    const destination = await temporaryFile()
    let clock = 0
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // A trickle: 1 KiB arrives a minute after the download started.
        clock += 60_000
        if (pulls++ < 8) controller.enqueue(payload.subarray(0, 1024))
        else controller.close()
      },
    })
    const failure = await downloadDesktopBucketPackage(release(payload), destination, {
      fetch: async () => packageResponse(body, { 'content-length': String(payload.byteLength) }),
      now: () => clock, limitMs: 5 * 60_000,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
    expect((failure as Error).message).toBe('从存储桶下载太慢')
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('passes the customer cancel through and removes the partial file', async () => {
    const payload = Buffer.alloc(8192, 0x5a)
    const destination = await temporaryFile()
    const controller = new AbortController()
    const reason = new Error('客户取消了')
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (pulls++ === 0) stream.enqueue(payload.subarray(0, 1024))
        else controller.abort(reason)
      },
    })
    await expect(downloadDesktopBucketPackage(release(payload), destination, {
      fetch: async () => packageResponse(body, { 'content-length': String(payload.byteLength) }),
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(fs.existsSync(destination)).toBe(false)
  })
})

/**
 * A body that hands out one chunk per read and moves the fake clock on by stepMs each time. With a
 * high-water mark of 0 nothing is pulled ahead of a read, so the clock is exactly where the reader is.
 */
function pacedBody(payload: Buffer, chunkBytes: number, stepMs: number, clock: { now: number }, onCancel?: () => void): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      clock.now += stepMs
      if (offset >= payload.byteLength) {
        controller.close()
        return
      }
      controller.enqueue(payload.subarray(offset, offset + chunkBytes))
      offset += chunkBytes
    },
    cancel() { onCancel?.() },
  }, { highWaterMark: 0 })
}

describe('desktop package bucket downloads compared with the other route', () => {
  // 8 KiB at 1 KiB a minute: early on the bucket needs more than the 5 minute limit to finish.
  const payload = Buffer.alloc(8192, 0x5a)
  const limitMs = 5 * 60_000

  function slowBucket(clock: { now: number }) {
    return async () => packageResponse(pacedBody(payload, 1024, 60_000, clock), { 'content-length': String(payload.byteLength) })
  }

  it('lets the other route take over only after measuring it clearly faster', async () => {
    const clock = { now: 0 }
    const destination = await temporaryFile()
    // The whole package in 8 ms: far quicker than what is left on the bucket.
    const probeAlternative = vi.fn(async () => ({ bytesPerMs: 1024, totalBytes: null }))
    const failure = await downloadDesktopBucketPackage(release(payload), destination, {
      fetch: slowBucket(clock), now: () => clock.now, limitMs, probeAlternative,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
    // Minutes more on the bucket, under a minute on the other route; only the log carries this line.
    expect((failure as Error).message).toMatch(/^从存储桶下载太慢：照目前的速度还要 \d+ 分钟，另一路测下来 1 分钟就能下完$/)
    expect(probeAlternative).toHaveBeenCalledOnce()
    expect(probeAlternative).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(fs.existsSync(destination)).toBe(false)
  })

  it.each([
    ['cannot be reached', async (): Promise<DesktopAlternativeSpeed | null> => null],
    ['cannot be measured', async (): Promise<DesktopAlternativeSpeed | null> => { throw new TypeError('fetch failed') }],
    // The whole package in 10 minutes: twice that is more than the bucket still needs.
    ['is not clearly faster', async (): Promise<DesktopAlternativeSpeed | null> => ({ bytesPerMs: 8192 / (10 * 60_000), totalBytes: null })],
    // Fast, but its own package is so much larger that it would still finish later.
    ['has a much larger package', async (): Promise<DesktopAlternativeSpeed | null> => ({ bytesPerMs: 1, totalBytes: 2_000_000 })],
  ] as const)('keeps downloading from the bucket when the other route %s', async (_label, probe) => {
    const clock = { now: 0 }
    const destination = await temporaryFile()
    const probeAlternative = vi.fn(probe)
    await expect(downloadDesktopBucketPackage(release(payload), destination, {
      fetch: slowBucket(clock), now: () => clock.now, limitMs, probeAlternative,
    })).resolves.toEqual({ size: payload.byteLength, sha256Base64: createHash('sha256').update(payload).digest('base64') })
    expect(probeAlternative).toHaveBeenCalled()
    expect(await fs.promises.readFile(destination)).toEqual(payload)
  })

  it('measures again a while later while the bucket stays slow, three times at most', async () => {
    const clock = { now: 0 }
    const probeAlternative = vi.fn(async (): Promise<DesktopAlternativeSpeed | null> => null)
    const longer = Buffer.alloc(16 * 1024, 0x5a)
    await expect(downloadDesktopBucketPackage(release(longer), await temporaryFile(), {
      fetch: async () => packageResponse(pacedBody(longer, 1024, 60_000, clock), { 'content-length': String(longer.byteLength) }),
      // Always too slow once the first half minute is over.
      now: () => clock.now, limitMs: 1, probeAlternative,
    })).resolves.toMatchObject({ size: longer.byteLength })
    // Once the first half minute is over, then two minutes after each answer: 16 slow minutes, three probes.
    expect(probeAlternative).toHaveBeenCalledTimes(3)
  })

  it('stops measuring the other route once the bucket download is done', async () => {
    const clock = { now: 0 }
    const probeSignals: AbortSignal[] = []
    const probeAlternative = vi.fn((signal: AbortSignal) => {
      probeSignals.push(signal)
      return new Promise<DesktopAlternativeSpeed | null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }))
    })
    await expect(downloadDesktopBucketPackage(release(payload), await temporaryFile(), {
      fetch: slowBucket(clock), now: () => clock.now, limitMs, probeAlternative,
    })).resolves.toMatchObject({ size: payload.byteLength })
    expect(probeAlternative).toHaveBeenCalledOnce()
    expect(probeSignals[0].aborted).toBe(true)
  })

  it('passes the customer cancel through while the other route is being measured', async () => {
    const clock = { now: 0 }
    const destination = await temporaryFile()
    const controller = new AbortController()
    const reason = new Error('客户取消了')
    const probeSignals: AbortSignal[] = []
    const probeAlternative = vi.fn((signal: AbortSignal) => {
      probeSignals.push(signal)
      controller.abort(reason)
      return new Promise<DesktopAlternativeSpeed | null>(() => undefined)
    })
    await expect(downloadDesktopBucketPackage(release(payload), destination, {
      fetch: slowBucket(clock), now: () => clock.now, limitMs, probeAlternative, signal: controller.signal,
    })).rejects.toBe(reason)
    expect(probeSignals[0].aborted).toBe(true)
    expect(fs.existsSync(destination)).toBe(false)
  })
})

describe('measuring the other route', () => {
  const signal = new AbortController().signal

  it('reads at most 4 MiB, throws the bytes away and reports the speed and the package size', async () => {
    const clock = { now: 0 }
    let cancelled = false
    const body = pacedBody(Buffer.alloc(8 * mib, 1), mib, 500, clock, () => { cancelled = true })
    const request = vi.fn(async (_signal: AbortSignal) => packageResponse(body, { 'content-type': 'application/octet-stream', 'content-length': String(180 * mib) }))
    await expect(measureDesktopDownloadSpeed(request, signal, () => clock.now)).resolves.toEqual({ bytesPerMs: 4 * mib / 2000, totalBytes: 180 * mib })
    expect(request).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(cancelled).toBe(true)
  })

  it('stops after eight seconds and counts what arrived by then', async () => {
    const clock = { now: 0 }
    const body = pacedBody(Buffer.alloc(mib, 1), 64 * 1024, 3_000, clock)
    // Reads at 3 s, 6 s and 9 s; the window closes after the third.
    await expect(measureDesktopDownloadSpeed(async () => packageResponse(body), signal, () => clock.now))
      .resolves.toEqual({ bytesPerMs: 3 * 64 * 1024 / 9_000, totalBytes: null })
  })

  it.each([
    ['an HTTP error', async () => packageResponse(Buffer.alloc(1024), {}, 404)],
    ['a web page', async () => packageResponse(Buffer.alloc(1024), { 'content-type': 'text/html; charset=utf-8' })],
    ['a JSON error', async () => packageResponse(Buffer.alloc(1024), { 'content-type': 'application/json' })],
    ['an empty body', async () => packageResponse(new Uint8Array(0))],
    ['a route that cannot be reached', async (): Promise<Response> => { throw new TypeError('fetch failed') }],
  ] as const)('cannot measure %s', async (_label, request) => {
    await expect(measureDesktopDownloadSpeed(request, signal)).resolves.toBeNull()
  })

  it('cannot measure a route whose body breaks off before the window closes', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (pulls++ === 0) stream.enqueue(new Uint8Array(mib))
        else stream.error(new TypeError('terminated'))
      },
    }, { highWaterMark: 0 })
    await expect(measureDesktopDownloadSpeed(async () => packageResponse(body), signal)).resolves.toBeNull()
  })

  it('gives up when the download it was measuring for has ended', async () => {
    const controller = new AbortController()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (pulls++ === 0) stream.enqueue(new Uint8Array(1024))
        else controller.abort(new Error('done'))
      },
    }, { highWaterMark: 0 })
    await expect(measureDesktopDownloadSpeed(async () => packageResponse(body), controller.signal)).resolves.toBeNull()
  })
})

describe('desktop package bucket pacing', () => {
  it('waits out the first half minute, then compares the projected remaining time with the limit', () => {
    const limit = 10 * 60_000
    expect(isDesktopBucketDownloadTooSlow(29_999, 0, 100, limit)).toBe(false)
    expect(isDesktopBucketDownloadTooSlow(30_000, 0, 100, limit)).toBe(true)
    // 1% in 30 s: 99% more takes 49.5 minutes.
    expect(isDesktopBucketDownloadTooSlow(30_000, 1, 100, limit)).toBe(true)
    // 10% in 60 s: 90% more takes 9 minutes.
    expect(isDesktopBucketDownloadTooSlow(60_000, 10, 100, limit)).toBe(false)
    expect(isDesktopBucketDownloadTooSlow(60_000, 100, 100, limit)).toBe(false)
  })
})

describe('comparing the bucket with the other route', () => {
  // 10% in a minute: 9 more minutes on the bucket.
  const elapsed = 60_000
  const transferred = 10
  const total = 100

  it('switches only when the whole package on the other route takes under half of what is left', () => {
    expect(isDesktopAlternativeClearlyFaster(elapsed, transferred, total, { bytesPerMs: total / (4 * 60_000), totalBytes: null })).toBe(true)
    expect(isDesktopAlternativeClearlyFaster(elapsed, transferred, total, { bytesPerMs: total / (5 * 60_000), totalBytes: null })).toBe(false)
  })

  it('times the other route on its own package size when it declares one', () => {
    const speed = total / (4 * 60_000)
    expect(isDesktopAlternativeClearlyFaster(elapsed, transferred, total, { bytesPerMs: speed, totalBytes: 2 * total })).toBe(false)
    expect(isDesktopAlternativeClearlyFaster(elapsed, transferred, total, { bytesPerMs: speed, totalBytes: total / 2 })).toBe(true)
  })

  it('takes any working route over a bucket that has sent nothing, and never a route that sent nothing', () => {
    expect(isDesktopAlternativeClearlyFaster(elapsed, 0, total, { bytesPerMs: 0.0001, totalBytes: null })).toBe(true)
    expect(isDesktopAlternativeClearlyFaster(elapsed, 0, total, { bytesPerMs: 0, totalBytes: null })).toBe(false)
    expect(isDesktopAlternativeClearlyFaster(elapsed, transferred, total, { bytesPerMs: Number.NaN, totalBytes: null })).toBe(false)
  })
})

describe('desktop package bucket fallback log line', () => {
  it('names the package in front of the reason', () => {
    const ids: DesktopBucketPackageId[] = ['codex-windows-x64', 'claude-windows-arm64']
    expect(describeDesktopBucketFallback(ids[0], new DesktopBucketUnavailableError('读取存储桶清单超时'))).toBe('codex-windows-x64：读取存储桶清单超时')
    expect(describeDesktopBucketFallback(ids[1], '')).toBe('claude-windows-arm64：存储桶这一路没走通')
  })
})

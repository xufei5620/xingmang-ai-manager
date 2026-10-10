import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeDesktopBucketFallback, desktopBucketIndexUrl, desktopPackageBucketOrigin, DesktopBucketUnavailableError,
  downloadDesktopBucketPackage, fetchDesktopBucketResource, isDesktopBucketDownloadTooSlow, parseDesktopBucketIndex,
  readDesktopBucketPackage, validateDesktopBucketUrl, type DesktopBucketDownloadProgress, type DesktopBucketPackage,
  type DesktopBucketPackageId,
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

  it('refuses a Claude Mac PKG with a four-part version and an index larger than the cap', () => {
    expect(parseDesktopBucketIndex(claudeIndex([claudeFile('macos-pkg-universal', { version: '1.1.2345.0' })]), 'claude-macos-universal')).toBeNull()
    const padded = JSON.stringify({ ...JSON.parse(claudeIndex()), padding: 'x'.repeat(256 * 1024) })
    expect(parseDesktopBucketIndex(padded, 'claude-windows-x64')).toBeNull()
  })
})

describe('desktop package bucket addresses', () => {
  it('accepts only object paths under the two synced folders on the fixed bucket host', () => {
    for (const key of ['chatgpt/latest.json', `chatgpt/windows-x64/${windowsVersion}/ChatGPT-x64.msix`, 'xingmang/offline/claude/latest.json']) {
      expect(validateDesktopBucketUrl(objectUrl(key)).href).toBe(objectUrl(key))
    }
    for (const value of [
      objectUrl('chatgpt/latest.json').replace('https:', 'http:'),
      objectUrl('chatgpt/latest.json').replace('.com/', '.com:8443/'),
      objectUrl('chatgpt/latest.json').replace('https://', 'https://user@'),
      `${objectUrl('chatgpt/latest.json')}?versionId=1`,
      `${objectUrl('chatgpt/latest.json')}#top`,
      objectUrl('xingmang/stable/latest.json'),
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

describe('desktop package bucket fallback log line', () => {
  it('names the package in front of the reason', () => {
    const ids: DesktopBucketPackageId[] = ['codex-windows-x64', 'claude-windows-arm64']
    expect(describeDesktopBucketFallback(ids[0], new DesktopBucketUnavailableError('读取存储桶清单超时'))).toBe('codex-windows-x64：读取存储桶清单超时')
    expect(describeDesktopBucketFallback(ids[1], '')).toBe('claude-windows-arm64：存储桶这一路没走通')
  })
})

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildAntigravityDesktopArtifactUrl, parseAntigravityDesktopFeed, type AntigravityDesktopPlatform } from './antigravity-desktop-release'
import {
  desktopBucketIndexUrl, desktopPackageBucketOrigin, DesktopBucketIndexStaleError, DesktopBucketUnavailableError,
  parseDesktopBucketIndex, readDesktopBucketPackage, validateDesktopBucketUrl, type DesktopBucketPackageId,
} from './desktop-package-bucket'
import { macosDesktopBucketPackageId } from './macos-desktop-app-installer'

// Antigravity 桌面端在桶里的那两份清单（scripts/sync-antigravity-desktop-cos.cjs 写）。Nothing here reaches the
// bucket or Google: the indexes are built here or by running the sync script against a fake store.
const mib = 1024 * 1024
const sha = 'ab'.repeat(32)
const build = '5887025308631040'
const prefix = 'xingmang/offline/antigravity-desktop'

type Platform = AntigravityDesktopPlatform

const files: Record<Platform, { id: DesktopBucketPackageId, family: 'windows' | 'macos', architecture: 'x64' | 'arm64', kind: string, format: string, fileName: string, type: string, verification: string }> = {
  'windows-x64': { id: 'antigravity-windows-x64', family: 'windows', architecture: 'x64', kind: 'installer', format: 'exe', fileName: 'Antigravity-x64.exe', type: 'application/octet-stream', verification: 'windows-authenticode-google' },
  'windows-arm64': { id: 'antigravity-windows-arm64', family: 'windows', architecture: 'arm64', kind: 'installer', format: 'exe', fileName: 'Antigravity-arm64.exe', type: 'application/octet-stream', verification: 'windows-authenticode-google' },
  'macos-arm64': { id: 'antigravity-macos-arm64', family: 'macos', architecture: 'arm64', kind: 'app-archive', format: 'zip', fileName: 'Antigravity-darwin-arm64.zip', type: 'application/zip', verification: 'macos-developer-id-notarized' },
  'macos-x64': { id: 'antigravity-macos-x64', family: 'macos', architecture: 'x64', kind: 'app-archive', format: 'zip', fileName: 'Antigravity-darwin-x64.zip', type: 'application/zip', verification: 'macos-developer-id-notarized' },
}

function objectUrl(key: string): string {
  return `${desktopPackageBucketOrigin}/${key}`
}

function file(platform: Platform, extra: Record<string, unknown> = {}) {
  const spec = files[platform]
  const key = `${prefix}/${platform}/sha256-${sha}/${spec.fileName}`
  return {
    platformId: platform, platform: spec.family, architecture: spec.architecture, kind: spec.kind, format: spec.format, fileName: spec.fileName,
    type: spec.type, verification: spec.verification, version: '2.34.0', key, url: objectUrl(key), size: 170 * mib, sha256: sha,
    sha512: 'ef'.repeat(64), sourceUrl: buildAntigravityDesktopArtifactUrl(platform, '2.34.0', build), cosEtag: '"etag"', ...extra,
  }
}

function index(family: 'windows' | 'macos', entries?: unknown[], overrides: Record<string, unknown> = {}): string {
  const platforms: Platform[] = family === 'windows' ? ['windows-x64', 'windows-arm64'] : ['macos-arm64', 'macos-x64']
  return JSON.stringify({
    schemaVersion: 1, product: 'antigravity-desktop', family, generatedAt: '2026-11-24T16:00:00.000Z', checkedAt: '2026-11-24T16:00:00.000Z',
    version: '2.34.0', build, files: entries ?? platforms.map((platform) => file(platform)), ...overrides,
  })
}

describe('Antigravity desktop bucket indexes', () => {
  it.each(Object.keys(files) as Platform[])('reads the %s package from its own family index', (platform) => {
    const spec = files[platform]
    expect(parseDesktopBucketIndex(index(spec.family), spec.id)).toEqual({
      id: spec.id, version: '2.34.0', bytes: 170 * mib, sha256: sha, contentType: spec.type, checkedAt: '2026-11-24T16:00:00.000Z',
      url: objectUrl(`${prefix}/${platform}/sha256-${sha}/${spec.fileName}`),
    })
    expect(desktopBucketIndexUrl(spec.id)).toBe(objectUrl(`${prefix}/${spec.family}.json`))
  })

  it.each([
    ['the other family', index('macos'), 'antigravity-windows-x64'],
    ['no entry for this chip', index('windows', [file('windows-arm64')]), 'antigravity-windows-x64'],
    ['another product', index('windows', undefined, { product: 'antigravity-cli' }), 'antigravity-windows-x64'],
    ['the other chip\'s installer', index('windows', [file('windows-x64', { fileName: 'Antigravity-arm64.exe' }), file('windows-arm64')]), 'antigravity-windows-x64'],
    ['a zip for Windows', index('windows', [file('windows-x64', { format: 'zip' }), file('windows-arm64')]), 'antigravity-windows-x64'],
    ['another type', index('windows', [file('windows-x64', { type: 'application/x-msdownload' }), file('windows-arm64')]), 'antigravity-windows-x64'],
    ['another verification', index('windows', [file('windows-x64', { verification: 'none' }), file('windows-arm64')]), 'antigravity-windows-x64'],
    ['a key in the agy folder', index('windows', [file('windows-x64', { key: `xingmang/offline/antigravity-cli/windows-x64/sha256-${sha}/Antigravity-x64.exe` }), file('windows-arm64')]), 'antigravity-windows-x64'],
    ['a URL that is not origin plus key', index('macos', [file('macos-arm64', { url: 'https://evil.example/Antigravity.zip' }), file('macos-x64')]), 'antigravity-macos-arm64'],
    ['a version with a leading zero', index('macos', [file('macos-arm64', { version: '2.034.0' }), file('macos-x64')]), 'antigravity-macos-arm64'],
    ['a package above 1 GiB', index('macos', [file('macos-arm64', { size: 1024 * mib + 1 }), file('macos-x64')]), 'antigravity-macos-arm64'],
    ['a package below the floor', index('macos', [file('macos-arm64', { size: 9 * mib }), file('macos-x64')]), 'antigravity-macos-arm64'],
  ] as const)('refuses an index with %s', (_label, text, id) => {
    expect(parseDesktopBucketIndex(text, id)).toBeNull()
  })

  it('accepts only the Antigravity desktop folder next to the other synced ones', () => {
    for (const key of [`${prefix}/windows.json`, `${prefix}/macos.json`, `${prefix}/macos-arm64/sha256-${sha}/Antigravity-darwin-arm64.zip`]) {
      expect(validateDesktopBucketUrl(objectUrl(key)).href).toBe(objectUrl(key))
    }
    for (const key of ['xingmang/offline/antigravity-desktopx/windows.json', 'xingmang/offline/antigravity-desk/windows.json', `${prefix}/%2e%2e/secret.json`]) {
      expect(() => validateDesktopBucketUrl(objectUrl(key)), key).toThrow(/存储桶地址/)
    }
  })

  it('names the Mac package by chip for the installer', () => {
    expect(macosDesktopBucketPackageId('antigravityDesktop', 'arm64')).toBe('antigravity-macos-arm64')
    expect(macosDesktopBucketPackageId('antigravityDesktop', 'x64')).toBe('antigravity-macos-x64')
  })
})

describe('Antigravity desktop bucket index age', () => {
  function indexFetch(text: string, date = 'Tue, 24 Nov 2026 16:00:00 GMT') {
    return vi.fn<typeof globalThis.fetch>(async () => new Response(text, { status: 200, headers: { 'content-type': 'application/json', date } }))
  }

  it('reads an index the sync checked within the last day, judged by the bucket clock', async () => {
    await expect(readDesktopBucketPackage('antigravity-windows-x64', indexFetch(index('windows', undefined, { checkedAt: '2026-11-23T16:00:00.000Z' }))))
      .resolves.toMatchObject({ id: 'antigravity-windows-x64', checkedAt: '2026-11-23T16:00:00.000Z' })
  })

  it('treats an index over a day old as stale, and hands it over only when asked', async () => {
    const old = index('macos', undefined, { checkedAt: '2026-11-23T15:59:59.000Z' })
    const failure = await readDesktopBucketPackage('antigravity-macos-arm64', indexFetch(old)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DesktopBucketUnavailableError)
    expect(failure).toBeInstanceOf(DesktopBucketIndexStaleError)
    await expect(readDesktopBucketPackage('antigravity-macos-arm64', indexFetch(old), undefined, { allowStale: true }))
      .resolves.toMatchObject({ id: 'antigravity-macos-arm64', version: '2.34.0' })
  })
})

interface DesktopSyncFile { platformId: string }
interface DesktopSyncIndex { files: DesktopSyncFile[], version: string }
interface DesktopSyncScript {
  FAMILIES: Record<'windows' | 'macos', { indexKey: string, platformIds: readonly Platform[] }>
  sourceUrl(platformId: Platform, version: string, build: string): string
  parseFeed(text: string, platformId: Platform): { version: string, build: string, url: string, bytes: number, sha512: string }
  synchronizeAntigravityDesktop(input: {
    store: unknown
    dependencies: unknown
    family: 'windows' | 'macos'
    now?: () => string
  }): Promise<{ changed: boolean, index: DesktopSyncIndex }>
}

const sync = createRequire(__filename)(path.join(__dirname, '..', 'scripts', 'sync-antigravity-desktop-cos.cjs')) as DesktopSyncScript

function digest(algorithm: 'sha256' | 'sha512', value: string, encoding: 'hex' | 'base64' = 'hex'): string {
  return createHash(algorithm).update(value).digest(encoding)
}

function feedText(platform: Platform, version = '2.34.0'): string {
  const url = sync.sourceUrl(platform, version, build)
  return [`version: ${version}`, 'files:', `  - url: ${url}`, `    sha512: ${digest('sha512', url, 'base64')}`, `    size: ${170 * mib}`,
    `path: ${url.slice(url.lastIndexOf('/') + 1)}`, `sha512: ${digest('sha512', url, 'base64')}`, "releaseDate: '2026-11-20T18:04:11.000Z'", ''].join('\n')
}

/** Runs the real sync script once for a family against an in-memory store and returns the index it publishes. */
async function publishedIndex(family: 'windows' | 'macos'): Promise<string> {
  let published: unknown = null
  const store = {
    readJson: async () => published,
    inspect: async (key: string) => ({ bytes: 170 * mib, etag: `"${key.length}"`, contentType: family === 'windows' ? 'application/octet-stream' : 'application/zip' }),
    publicUrl: (key: string) => objectUrl(key),
    publishFile: async (key: string, _filePath: string, input: { expectedBytes: number, expectedSha256: string }) => ({ key, bytes: input.expectedBytes, sha256: input.expectedSha256, etag: `"${key.length}"` }),
    publishJson: async (key: string, value: unknown) => {
      expect(key).toBe(sync.FAMILIES[family].indexKey)
      published = value
    },
  }
  const dependencies = {
    fetchText: async ({ url }: { url: string }) => {
      const platform = sync.FAMILIES[family].platformIds.find((id) => url.endsWith(id.startsWith('windows') ? `latest-${id.endsWith('arm64') ? 'arm64' : 'x64'}-win.yml` : `latest-${id.endsWith('arm64') ? 'arm64' : 'x64'}-mac.yml`))
      if (!platform) throw new Error(`unexpected feed ${url}`)
      return feedText(platform)
    },
    downloadResource: async ({ url }: { url: string }) => ({ bytes: 170 * mib, sha256: digest('sha256', url), sha512: digest('sha512', url, 'base64') }),
    assertPeImage: async () => undefined,
    inspectWindowsSignature: async () => ({ status: 'Valid', subject: 'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US', issuer: 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O="DigiCert, Inc.", C=US' }),
    inspectMacArchive: async () => undefined,
    removeFile: async () => undefined,
    createWorkDirectory: async () => '/nonexistent/antigravity-desktop-contract',
    removeWorkDirectory: async () => undefined,
  }
  await sync.synchronizeAntigravityDesktop({ store, dependencies, family, now: () => '2026-11-24T16:00:00.000Z' })
  return JSON.stringify(published)
}

describe('Antigravity desktop sync script and client', () => {
  it.each(['windows', 'macos'] as const)('the client reads every %s package the sync script publishes', async (family) => {
    const text = await publishedIndex(family)
    for (const platform of sync.FAMILIES[family].platformIds) {
      const id = files[platform].id
      const source = sync.sourceUrl(platform, '2.34.0', build)
      expect(parseDesktopBucketIndex(text, id)).toEqual({
        id, version: '2.34.0', bytes: 170 * mib, sha256: digest('sha256', source), contentType: files[platform].type, checkedAt: '2026-11-24T16:00:00.000Z',
        url: objectUrl(`${prefix}/${platform}/sha256-${digest('sha256', source)}/${files[platform].fileName}`),
      })
      expect(desktopBucketIndexUrl(id)).toBe(objectUrl(sync.FAMILIES[family].indexKey))
    }
  })

  it.each(Object.keys(files) as Platform[])('reads Google\'s %s feed the same way the client does', (platform) => {
    const text = feedText(platform)
    const client = parseAntigravityDesktopFeed(text, platform)
    expect(client).not.toBeNull()
    expect(sync.parseFeed(text, platform)).toEqual({ version: client!.version, build: client!.build, url: client!.url, bytes: client!.bytes, sha512: client!.sha512 })
    // A feed for one chip is not accepted for another by either side.
    const other = (Object.keys(files) as Platform[]).find((candidate) => candidate !== platform && files[candidate].family === files[platform].family)!
    expect(parseAntigravityDesktopFeed(feedText(other), platform)).toBeNull()
    expect(() => sync.parseFeed(feedText(other), platform)).toThrow()
  })
})

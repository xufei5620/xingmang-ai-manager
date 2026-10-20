import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildGrokArtifactUrls,
  cleanupDownloadedGrokBinary,
  downloadLatestGrokBinary,
  grokWindowsArchitecture,
  GrokRollbackError,
  installDownloadedGrokBinary,
  recoverInterruptedGrokInstallation,
  validateGrokArtifactResponseUrl,
  type DownloadedGrokBinary,
} from './grok-installer'
import { desktopPackageBucketOrigin } from './desktop-package-bucket'
import type { GrokVersionFetch } from './grok-update'
import { NativeCliPublisherMismatchError, type VerifiedNativeCliFile } from './trusted-native-cli'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function responseWithUrl(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { value: url })
  return response
}

async function fakeVerification(_provider: string, filePath: string): Promise<VerifiedNativeCliFile> {
  const content = fs.readFileSync(filePath)
  return {
    path: filePath,
    sha256Hex: createHash('sha256').update(content).digest('hex'),
    size: content.length,
  }
}

describe('Grok signed binary installer', () => {
  it('builds only the fixed official artifacts for the selected architecture', () => {
    expect(grokWindowsArchitecture('x64')).toBe('x86_64')
    expect(grokWindowsArchitecture('arm64')).toBe('aarch64')
    expect(() => grokWindowsArchitecture('ia32')).toThrow('不支持')
    expect(buildGrokArtifactUrls(
      '0.2.112',
      'x64',
      'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable',
    )).toEqual([
      'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-0.2.112-windows-x86_64.exe',
      'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-0.2.112-windows-x86_64',
      'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      'https://x.ai/cli/grok-0.2.112-windows-x86_64',
    ])
  })

  it('rejects cross-host redirects and altered artifact paths', () => {
    const expected = 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe'
    expect(() => validateGrokArtifactResponseUrl(expected, expected)).not.toThrow()
    expect(() => validateGrokArtifactResponseUrl(
      'https://evil.example/grok.exe',
      expected,
    )).toThrow('不受信任的重定向')
    expect(() => validateGrokArtifactResponseUrl(
      'https://x.ai/cli/other.exe',
      expected,
    )).toThrow('不受信任的重定向')
  })

  it('accepts the empty url Electron net.fetch reports, but only for an official artifact', () => {
    expect(() => validateGrokArtifactResponseUrl('', 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe')).not.toThrow()
    expect(() => validateGrokArtifactResponseUrl(
      '',
      'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-0.2.112-windows-x86_64.exe',
    )).not.toThrow()
    expect(() => validateGrokArtifactResponseUrl('', 'https://evil.example/cli/grok.exe')).toThrow('不受信任的重定向')
    expect(() => validateGrokArtifactResponseUrl('', 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe?x=1')).toThrow('不受信任的重定向')
    expect(() => validateGrokArtifactResponseUrl('', 'https://x.ai:8443/cli/grok-0.2.112-windows-x86_64.exe')).toThrow('不受信任的重定向')
  })

  it('downloads when the binary response carries no url, as Electron net.fetch answers', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-download-'))
    temporaryDirectories.push(directory)
    const binary = Buffer.alloc(1024 * 1024, 0x5a)
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(new Response('0.2.112\n', { status: 200, headers: { 'Content-Type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response(binary, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(binary.length) },
      }))

    const result = await downloadLatestGrokBinary({
      fetchImpl,
      architecture: 'x64',
      createTemporaryDirectory: async () => directory,
      verifyBinary: fakeVerification,
    })

    expect(result).toMatchObject({ version: '0.2.112', size: binary.length })
    expect(fs.statSync(result.binaryPath).size).toBe(binary.length)
  })

  it('downloads a bounded official binary and verifies it before returning', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-download-'))
    temporaryDirectories.push(directory)
    const binary = Buffer.alloc(1024 * 1024, 0x5a)
    const artifactUrl = 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe'
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(responseWithUrl('0.2.112\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }, 'https://x.ai/cli/stable'))
      .mockResolvedValueOnce(responseWithUrl(binary, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(binary.length),
        },
      }, artifactUrl))
    const progress = vi.fn()

    const result = await downloadLatestGrokBinary({
      fetchImpl,
      architecture: 'x64',
      createTemporaryDirectory: async () => directory,
      verifyBinary: fakeVerification,
      onProgress: progress,
    })

    expect(result).toMatchObject({ version: '0.2.112', sourceUrl: artifactUrl, size: binary.length })
    expect(fs.statSync(result.binaryPath).size).toBe(binary.length)
    expect(progress).toHaveBeenLastCalledWith({
      transferred: binary.length,
      total: binary.length,
      percent: 100,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('downloads the named version instead of the stable one when it is not newer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-download-'))
    temporaryDirectories.push(directory)
    const binary = Buffer.alloc(1024 * 1024, 0x5a)
    const artifactUrl = 'https://x.ai/cli/grok-0.2.110-windows-x86_64.exe'
    const fetchImpl = vi.fn<GrokVersionFetch>()
      .mockResolvedValueOnce(responseWithUrl('0.2.112\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }, 'https://x.ai/cli/stable'))
      .mockResolvedValueOnce(responseWithUrl(binary, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(binary.length),
        },
      }, artifactUrl))

    const result = await downloadLatestGrokBinary({
      fetchImpl,
      architecture: 'x64',
      createTemporaryDirectory: async () => directory,
      verifyBinary: fakeVerification,
      version: '0.2.110',
    })

    expect(result).toMatchObject({ version: '0.2.110', sourceUrl: artifactUrl })
    expect(String(fetchImpl.mock.calls[1][0])).toBe(artifactUrl)
  })

  describe('when the xAI download fails its signature check', () => {
    function xaiSetup() {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-download-'))
      temporaryDirectories.push(directory)
      const binary = Buffer.alloc(1024 * 1024, 0x5c)
      const requested: string[] = []
      const fetchImpl = vi.fn<GrokVersionFetch>(async (input) => {
        const url = String(input)
        requested.push(url)
        if (url === 'https://x.ai/cli/stable') return new Response('1.0.62\n', { status: 200, headers: { 'Content-Type': 'text/plain' } })
        return new Response(binary, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(binary.length) } })
      })
      const verifyBinary = vi.fn(fakeVerification)
      return {
        requested,
        verifyBinary,
        options: { fetchImpl, architecture: 'x64' as const, createTemporaryDirectory: async () => directory, verifyBinary },
      }
    }

    it('stops after the first download when the signature is valid but from another publisher', async () => {
      const f = xaiSetup()
      f.verifyBinary.mockRejectedValue(new NativeCliPublisherMismatchError())
      await expect(downloadLatestGrokBinary(f.options))
        .rejects.toThrow('Grok 官方二进制下载或签名校验失败：x.ai：原生 CLI 数字签名发布者与官方发布者不一致')
      expect(f.requested).toEqual(['https://x.ai/cli/stable', 'https://x.ai/cli/grok-1.0.62-windows-x86_64.exe'])
      expect(f.verifyBinary).toHaveBeenCalledTimes(1)
    })

    it('still tries the next official address when the file is not validly signed', async () => {
      const f = xaiSetup()
      f.verifyBinary.mockRejectedValueOnce(new Error('原生 CLI 没有有效的 Authenticode 签名'))
      const result = await downloadLatestGrokBinary(f.options)
      expect(result.sourceUrl).toBe('https://x.ai/cli/grok-1.0.62-windows-x86_64')
      expect(f.verifyBinary).toHaveBeenCalledTimes(2)
    })
  })

  // #1061 item 4: yoyo relaxed this on 2026-10-20 ("四条都放"). A named version no longer
  // needs the stable ceiling to install; every check on the downloaded file stays.
  describe('when neither xAI stable address answers', () => {
    const stableUrls = ['https://x.ai/cli/stable', 'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable']

    function stableDownSetup() {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-download-'))
      temporaryDirectories.push(directory)
      const binary = Buffer.alloc(1024 * 1024, 0x5d)
      const requested: string[] = []
      const unavailable: string[] = []
      const fetchImpl = vi.fn<GrokVersionFetch>(async (input, init) => {
        const url = String(input)
        requested.push(url)
        if (stableUrls.includes(url)) return new Response('busy', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        expect(init?.redirect).toBe('error')
        return new Response(binary, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(binary.length) } })
      })
      const verifyBinary = vi.fn(fakeVerification)
      return {
        directory,
        binary,
        requested,
        unavailable,
        verifyBinary,
        options: {
          fetchImpl,
          architecture: 'x64' as const,
          createTemporaryDirectory: async () => directory,
          verifyBinary,
          onStableUnavailable: (detail: string) => unavailable.push(detail),
        },
      }
    }

    it('downloads a named version straight from the official directory and still checks the signature', async () => {
      const f = stableDownSetup()
      const result = await downloadLatestGrokBinary({ ...f.options, version: '1.0.46' })
      expect(result).toMatchObject({ version: '1.0.46', sourceUrl: 'https://x.ai/cli/grok-1.0.46-windows-x86_64.exe', size: f.binary.length })
      expect(f.requested).toEqual([...stableUrls, 'https://x.ai/cli/grok-1.0.46-windows-x86_64.exe'])
      expect(f.verifyBinary).toHaveBeenCalledWith('grok', result.binaryPath)
      expect(f.unavailable).toEqual([expect.stringMatching(/^按指定的 1\.0\.46 直接下载；Grok 官方版本查询失败：x\.ai：Grok 版本服务返回 HTTP 503/)])
    })

    it('still rejects a named version whose file fails the xAI signature check on every address', async () => {
      const f = stableDownSetup()
      f.verifyBinary.mockRejectedValue(new Error('原生 CLI 没有有效的 Authenticode 签名'))
      await expect(downloadLatestGrokBinary({ ...f.options, version: '1.0.46' }))
        .rejects.toThrow('Grok 官方二进制下载或签名校验失败')
      expect(f.verifyBinary).toHaveBeenCalledTimes(4)
      expect(fs.existsSync(f.directory)).toBe(false)
    })

    it.each([
      ['no version is named', undefined],
      ['the latest is asked for', 'latest'],
    ])('fails as before when %s, without downloading anything', async (_label, version) => {
      const f = stableDownSetup()
      await expect(downloadLatestGrokBinary({ ...f.options, ...(version ? { version } : {}) }))
        .rejects.toThrow('Grok 官方版本查询失败')
      expect(f.requested).toEqual(stableUrls)
      expect(f.unavailable).toEqual([])
    })

    it('refuses a malformed named version without downloading anything', async () => {
      const f = stableDownSetup()
      await expect(downloadLatestGrokBinary({ ...f.options, version: '1.0.46/../evil' }))
        .rejects.toThrow('指定的 Grok 版本号无效')
      expect(f.requested).toEqual(stableUrls)
      expect(f.unavailable).toEqual([])
    })

    it('stops on a cancel instead of downloading the named version', async () => {
      const f = stableDownSetup()
      const controller = new AbortController()
      const reason = new Error('客户取消了')
      controller.abort(reason)
      await expect(downloadLatestGrokBinary({ ...f.options, version: '1.0.46', signal: controller.signal })).rejects.toBe(reason)
      expect(f.requested).toEqual(stableUrls)
    })
  })

  describe('when the xAI download breaks part way', () => {
    const firstUrl = 'https://x.ai/cli/grok-1.0.62-windows-x86_64.exe'
    const secondUrl = 'https://x.ai/cli/grok-1.0.62-windows-x86_64'
    const binary = Buffer.alloc(2 * 1024 * 1024)
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 251
    const half = binary.length / 2

    function binaryResponse(body: BodyInit, headers: Record<string, string> = {}, status = 200): Response {
      return new Response(body, {
        status,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(binary.length), ...headers },
      })
    }

    /** Hands out the first half, then either fails like a reset connection or goes quiet. */
    function halfBody(after: 'reset' | 'stall'): ReadableStream<Uint8Array> {
      let pulls = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(new Uint8Array(binary.subarray(0, half)))
            return undefined
          }
          if (after === 'reset') {
            controller.error(new TypeError('terminated'))
            return undefined
          }
          return new Promise<void>(() => undefined)
        },
      })
    }

    function rangeResponse(headers: Record<string, string> = {}): Response {
      return binaryResponse(binary.subarray(half), {
        'Content-Length': String(binary.length - half),
        'Content-Range': `bytes ${half}-${binary.length - 1}/${binary.length}`,
        ETag: '"grok"',
        ...headers,
      }, 206)
    }

    function setup(answer: (url: string, range: string | null, call: number) => Response) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-download-'))
      temporaryDirectories.push(directory)
      const requests: Array<{ url: string; range: string | null; ifRange: string | null }> = []
      const fetchImpl = vi.fn<GrokVersionFetch>(async (input, init) => {
        const url = String(input)
        if (url === 'https://x.ai/cli/stable') return new Response('1.0.62\n', { status: 200, headers: { 'Content-Type': 'text/plain' } })
        expect(init?.redirect).toBe('error')
        const headers = new Headers(init?.headers)
        requests.push({ url, range: headers.get('range'), ifRange: headers.get('if-range') })
        return answer(url, headers.get('range'), requests.length)
      })
      const progress: Array<{ transferred: number; total: number; percent: number }> = []
      const waits: number[] = []
      return {
        requests,
        progress,
        waits,
        options: {
          fetchImpl,
          architecture: 'x64' as const,
          createTemporaryDirectory: async () => directory,
          verifyBinary: fakeVerification,
          onProgress: (event: { transferred: number; total: number; percent: number }) => progress.push(event),
          resumeOptions: {
            idleTimeoutMs: 50,
            wait: async (milliseconds: number) => {
              waits.push(milliseconds)
            },
          },
        },
      }
    }

    it('picks a reset download up where it stopped on the same address', async () => {
      const f = setup((_url, range) => range === null
        ? binaryResponse(halfBody('reset'), { ETag: '"grok"' })
        : rangeResponse())

      const result = await downloadLatestGrokBinary(f.options)

      expect(result).toMatchObject({ sourceUrl: firstUrl, size: binary.length })
      expect(result.sha256Hex).toBe(createHash('sha256').update(binary).digest('hex'))
      expect(fs.readFileSync(result.binaryPath).equals(binary)).toBe(true)
      expect(f.requests).toEqual([
        { url: firstUrl, range: null, ifRange: null },
        { url: firstUrl, range: `bytes=${half}-`, ifRange: '"grok"' },
      ])
      expect(f.progress[0]).toEqual({ transferred: half, total: binary.length, percent: 50 })
      expect(f.progress.at(-1)).toEqual({ transferred: binary.length, total: binary.length, percent: 100 })
    })

    it('picks a download that went quiet up instead of starting the next address from zero', async () => {
      const f = setup((_url, range) => range === null
        ? binaryResponse(halfBody('stall'), { ETag: '"grok"' })
        : rangeResponse())

      const result = await downloadLatestGrokBinary(f.options)

      expect(result.sourceUrl).toBe(firstUrl)
      expect(fs.readFileSync(result.binaryPath).equals(binary)).toBe(true)
      expect(f.requests.map((request) => request.range)).toEqual([null, `bytes=${half}-`])
    })

    it('moves on to the next address at once when this one answers a resume with the whole file', async () => {
      const f = setup((_url, range, call) => {
        if (call === 1) return binaryResponse(halfBody('reset'), { ETag: '"grok"' })
        if (range !== null) return binaryResponse(binary, { ETag: '"grok"' })
        return binaryResponse(binary)
      })

      const result = await downloadLatestGrokBinary(f.options)

      expect(result.sourceUrl).toBe(secondUrl)
      expect(fs.readFileSync(result.binaryPath).equals(binary)).toBe(true)
      expect(f.requests).toEqual([
        { url: firstUrl, range: null, ifRange: null },
        { url: firstUrl, range: `bytes=${half}-`, ifRange: '"grok"' },
        { url: secondUrl, range: null, ifRange: null },
      ])
      expect(f.waits).toHaveLength(1)
    })

    it('does not splice a resumed range that came from somewhere else', async () => {
      const f = setup((url, range) => {
        if (url === secondUrl) return binaryResponse(binary)
        if (range === null) return binaryResponse(halfBody('reset'), { ETag: '"grok"' })
        const moved = rangeResponse()
        Object.defineProperty(moved, 'url', { value: 'https://evil.example/grok.exe' })
        return moved
      })

      const result = await downloadLatestGrokBinary(f.options)

      expect(result.sourceUrl).toBe(secondUrl)
      expect(fs.readFileSync(result.binaryPath).equals(binary)).toBe(true)
      expect(f.requests.filter((request) => request.url === firstUrl).length).toBeGreaterThan(1)
    })

    it('still moves on at once when an address goes quiet before sending anything', async () => {
      const f = setup((url) => url === firstUrl
        ? binaryResponse(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }))
        : binaryResponse(binary))

      const result = await downloadLatestGrokBinary(f.options)

      expect(result.sourceUrl).toBe(secondUrl)
      expect(f.requests.map((request) => request.url)).toEqual([firstUrl, secondUrl])
      expect(f.waits).toEqual([])
    })

    it('reports a download that keeps going quiet as a timeout, as before', async () => {
      const f = setup(() => binaryResponse(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) })))

      await expect(downloadLatestGrokBinary(f.options))
        .rejects.toThrow('Grok 官方二进制下载或签名校验失败：x.ai：连接或下载超时')
    })

    it('stops without trying the next address when the customer cancels while waiting to resume', async () => {
      const cancel = new AbortController()
      const reason = new Error('客户取消了')
      const f = setup((_url, range) => range === null
        ? binaryResponse(halfBody('reset'), { ETag: '"grok"' })
        : rangeResponse())

      const failure = await downloadLatestGrokBinary({
        ...f.options,
        signal: cancel.signal,
        resumeOptions: {
          wait: async (_milliseconds: number, signal?: AbortSignal) => {
            cancel.abort(reason)
            throw signal?.reason
          },
        },
      }).catch((error: unknown) => error)

      expect(failure).toBe(reason)
      expect(f.requests.map((request) => request.url)).toEqual([firstUrl])
    })
  })

  describe('from the Xingmang bucket', () => {
    const bucketIndexUrl = `${desktopPackageBucketOrigin}/xingmang/offline/grok/latest.json`
    const binary = Buffer.alloc(1024 * 1024, 0x5b)
    const digest = createHash('sha256').update(binary).digest('hex')
    const bucketKey = `xingmang/offline/grok/windows-x64/sha256-${digest}/grok-1.0.46-windows-x86_64.exe`

    // The sync refreshes checkedAt every 6 hours; a fresh one by default (#1061 item 7).
    function bucketIndex(checkedAt: string | null = new Date().toISOString()): string {
      const file = (version: string, platformId: string, architecture: string, artifact: string) => {
        const key = `xingmang/offline/grok/${platformId}/sha256-${digest}/grok-${version}-${artifact}.exe`
        return {
          platformId, platform: 'windows', architecture, key, url: `${desktopPackageBucketOrigin}/${key}`, bytes: binary.length, sha256: digest,
          contentType: 'application/octet-stream', verification: 'windows-authenticode-xai', sourceUrl: `https://x.ai/cli/grok-${version}-${artifact}.exe`, cosEtag: '"etag"',
        }
      }
      return JSON.stringify({
        schemaVersion: 1, product: 'grok-cli', generatedAt: '2026-10-14T00:00:00.000Z', stable: { version: '1.0.52', url: 'https://x.ai/cli/stable' },
        releases: ['1.0.52', '1.0.46'].map((version) => ({
          version, files: [file(version, 'windows-x64', 'x64', 'windows-x86_64'), file(version, 'windows-arm64', 'arm64', 'windows-aarch64')],
        })),
        ...(checkedAt === null ? {} : { checkedAt }),
      })
    }

    function bucketSetup(options: { indexStatus?: number, onBinaryRequest?: () => void, xaiStable?: string, xaiStableStatus?: number, checkedAt?: string | null } = {}) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-download-'))
      temporaryDirectories.push(directory)
      const requested: string[] = []
      const routed: string[] = []
      const fallbacks: string[] = []
      const fetchImpl = vi.fn<GrokVersionFetch>(async (input, init) => {
        const url = String(input)
        requested.push(url)
        if (url === bucketIndexUrl) return new Response(bucketIndex(options.checkedAt), { status: options.indexStatus ?? 200, headers: { 'Content-Type': 'application/json' } })
        if (url.startsWith(desktopPackageBucketOrigin)) {
          options.onBinaryRequest?.()
          init?.signal?.throwIfAborted()
          return new Response(binary, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(binary.length) } })
        }
        if (url === 'https://x.ai/cli/stable' || url === 'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable') {
          return new Response(`${options.xaiStable ?? '1.0.52'}\n`, { status: options.xaiStableStatus ?? 200, headers: { 'Content-Type': 'text/plain' } })
        }
        return new Response(binary, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(binary.length) } })
      })
      return {
        directory, requested, routed, fallbacks, fetchImpl,
        options: {
          fetchImpl,
          architecture: 'x64' as const,
          version: '1.0.46',
          createTemporaryDirectory: async () => directory,
          verifyBinary: vi.fn(fakeVerification),
          bucket: { onFallback: (detail: string) => fallbacks.push(detail) },
          withVendorDownloadRoute: async <T>(operation: () => Promise<T>): Promise<T> => {
            routed.push('start')
            try { return await operation() } finally { routed.push('end') }
          },
        },
      }
    }

    it('downloads the named version from the bucket outside the download route and checks the xAI signature', async () => {
      const f = bucketSetup()
      const progress = vi.fn()
      const result = await downloadLatestGrokBinary({ ...f.options, onProgress: progress })
      expect(result).toMatchObject({ version: '1.0.46', sourceUrl: `${desktopPackageBucketOrigin}/${bucketKey}`, size: binary.length, sha256Hex: digest })
      expect(fs.readFileSync(result.binaryPath).equals(binary)).toBe(true)
      expect(f.requested).toEqual([bucketIndexUrl, `${desktopPackageBucketOrigin}/${bucketKey}`])
      expect(f.fetchImpl).toHaveBeenCalledWith(bucketIndexUrl, expect.objectContaining({ redirect: 'manual', credentials: 'omit' }))
      expect(f.options.verifyBinary).toHaveBeenCalledWith('grok', result.binaryPath)
      expect(f.routed).toEqual([])
      expect(f.fallbacks).toEqual([])
      expect(progress).toHaveBeenLastCalledWith({ transferred: binary.length, total: binary.length, percent: 100 })
    })

    it('goes to xAI inside the download route when the bucket index cannot be read', async () => {
      const f = bucketSetup({ indexStatus: 404 })
      const result = await downloadLatestGrokBinary(f.options)
      expect(result).toMatchObject({ version: '1.0.46', sourceUrl: 'https://x.ai/cli/grok-1.0.46-windows-x86_64.exe' })
      expect(f.requested).toEqual([bucketIndexUrl, 'https://x.ai/cli/stable', 'https://x.ai/cli/grok-1.0.46-windows-x86_64.exe'])
      expect(f.routed).toEqual(['start', 'end'])
      expect(f.fallbacks).toEqual(['grok-windows-x64：Grok 清单返回 HTTP 404'])
    })

    it('downloads the named version from xAI inside the download route when the bucket and xAI stable are both down', async () => {
      const f = bucketSetup({ indexStatus: 404, xaiStableStatus: 503 })
      const result = await downloadLatestGrokBinary(f.options)
      expect(result).toMatchObject({ version: '1.0.46', sourceUrl: 'https://x.ai/cli/grok-1.0.46-windows-x86_64.exe' })
      expect(f.requested).toEqual([
        bucketIndexUrl,
        'https://x.ai/cli/stable',
        'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable',
        'https://x.ai/cli/grok-1.0.46-windows-x86_64.exe',
      ])
      expect(f.options.verifyBinary).toHaveBeenCalledWith('grok', result.binaryPath)
      expect(f.routed).toEqual(['start', 'end'])
    })

    it('goes to xAI when the bucket binary fails the xAI signature check, and installs that one', async () => {
      const f = bucketSetup()
      f.options.verifyBinary.mockRejectedValueOnce(new Error('Grok CLI 签名不是 X.AI LLC'))
      const result = await downloadLatestGrokBinary(f.options)
      expect(result.sourceUrl).toBe('https://x.ai/cli/grok-1.0.46-windows-x86_64.exe')
      expect(f.options.verifyBinary).toHaveBeenCalledTimes(2)
      expect(f.fallbacks).toEqual(['grok-windows-x64：Grok CLI 签名不是 X.AI LLC'])
      expect(f.routed).toEqual(['start', 'end'])
    })

    it('takes the bucket stable for a latest install when it is newer than the installed version', async () => {
      const f = bucketSetup()
      const result = await downloadLatestGrokBinary({ ...f.options, version: undefined, installedVersion: '1.0.46' })
      expect(result.version).toBe('1.0.52')
      expect(result.sourceUrl).toBe(`${desktopPackageBucketOrigin}/xingmang/offline/grok/windows-x64/sha256-${digest}/grok-1.0.52-windows-x86_64.exe`)
      expect(f.routed).toEqual([])
    })

    it('asks xAI for a latest update when the bucket has nothing newer than the installed version', async () => {
      const f = bucketSetup({ xaiStable: '1.0.53' })
      const result = await downloadLatestGrokBinary({ ...f.options, version: 'latest', installedVersion: '1.0.52' })
      expect(result).toMatchObject({ version: '1.0.53', sourceUrl: 'https://x.ai/cli/grok-1.0.53-windows-x86_64.exe' })
      expect(f.requested).toEqual([bucketIndexUrl, 'https://x.ai/cli/stable', 'https://x.ai/cli/grok-1.0.53-windows-x86_64.exe'])
      expect(f.routed).toEqual(['start', 'end'])
      expect(f.fallbacks).toEqual(['grok-windows-x64：桶里的 1.0.52 不比本机的 1.0.52 新'])
    })

    it.each([
      ['a first install', null],
      ['an update', '1.0.46'],
    ])('asks xAI for %s of the latest when the bucket index was not checked for over a day', async (_label, installedVersion) => {
      const f = bucketSetup({ xaiStable: '1.0.53', checkedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() })
      const result = await downloadLatestGrokBinary({ ...f.options, version: undefined, installedVersion })
      expect(result).toMatchObject({ version: '1.0.53', sourceUrl: 'https://x.ai/cli/grok-1.0.53-windows-x86_64.exe' })
      expect(f.requested).toEqual([bucketIndexUrl, 'https://x.ai/cli/stable', 'https://x.ai/cli/grok-1.0.53-windows-x86_64.exe'])
      expect(f.routed).toEqual(['start', 'end'])
      expect(f.fallbacks).toEqual([expect.stringMatching(/^grok-windows-x64：存储桶清单超过 24 小时没和官方核对过/)])
    })

    it('still takes a named version from a bucket index that was not checked for over a day', async () => {
      const f = bucketSetup({ checkedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() })
      const result = await downloadLatestGrokBinary(f.options)
      expect(result.sourceUrl).toBe(`${desktopPackageBucketOrigin}/${bucketKey}`)
      expect(f.routed).toEqual([])
    })

    it('takes the latest from a bucket index written before the sync learned checkedAt', async () => {
      const f = bucketSetup({ checkedAt: null })
      const result = await downloadLatestGrokBinary({ ...f.options, version: undefined, installedVersion: null })
      expect(result).toMatchObject({ version: '1.0.52', sourceUrl: `${desktopPackageBucketOrigin}/xingmang/offline/grok/windows-x64/sha256-${digest}/grok-1.0.52-windows-x86_64.exe` })
      expect(f.routed).toEqual([])
      expect(f.fallbacks).toEqual([])
    })

    it('ignores the installed version when a version is named, so a rollback still comes from the bucket', async () => {
      const f = bucketSetup()
      const result = await downloadLatestGrokBinary({ ...f.options, installedVersion: '1.0.52' })
      expect(result.sourceUrl).toBe(`${desktopPackageBucketOrigin}/${bucketKey}`)
      expect(f.routed).toEqual([])
    })

    it('lets xAI decide a named version newer than the bucket stable', async () => {
      const f = bucketSetup({ xaiStable: '1.0.53' })
      const result = await downloadLatestGrokBinary({ ...f.options, version: '1.0.53' })
      expect(result).toMatchObject({ version: '1.0.53', sourceUrl: 'https://x.ai/cli/grok-1.0.53-windows-x86_64.exe' })
      expect(f.routed).toEqual(['start', 'end'])
      expect(f.fallbacks).toEqual(['grok-windows-x64：存储桶里没有要装的这一版 Grok，或清单格式对不上'])
    })

    it('stops on a cancel during the bucket download without asking xAI', async () => {
      const controller = new AbortController()
      const reason = new Error('客户取消了')
      const f = bucketSetup({ onBinaryRequest: () => controller.abort(reason) })
      await expect(downloadLatestGrokBinary({ ...f.options, signal: controller.signal })).rejects.toBe(reason)
      expect(f.requested).toEqual([bucketIndexUrl, `${desktopPackageBucketOrigin}/${bucketKey}`])
      expect(f.routed).toEqual([])
      expect(f.fallbacks).toEqual([])
      expect(fs.existsSync(f.directory)).toBe(false)
    })
  })

  it('installs verified grok/agent binaries and local version metadata in a protected root', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-install-'))
    temporaryDirectories.push(directory)
    const downloadDirectory = path.join(directory, 'download')
    const managedRoot = path.join(directory, 'managed')
    fs.mkdirSync(downloadDirectory)
    const binaryPath = path.join(downloadDirectory, 'grok.exe')
    const content = Buffer.from('signed-test-binary')
    fs.writeFileSync(binaryPath, content)
    const download: DownloadedGrokBinary = {
      directory: downloadDirectory,
      binaryPath,
      version: '0.2.112',
      sourceUrl: 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      size: content.length,
      sha256Hex: createHash('sha256').update(content).digest('hex'),
    }
    const applyWindowsAcl = vi.fn(async () => undefined)

    const installed = await installDownloadedGrokBinary(download, {
      platform: 'win32',
      managedRoot,
      applyWindowsAcl,
      verifyBinary: fakeVerification,
    })

    expect(fs.readFileSync(installed.executablePath)).toEqual(content)
    expect(fs.readFileSync(installed.agentPath)).toEqual(content)
    expect(JSON.parse(fs.readFileSync(path.join(managedRoot, 'version.json'), 'utf8'))).toMatchObject({
      version: '0.2.112',
      stable_version: '0.2.112',
    })
    expect(applyWindowsAcl).toHaveBeenCalledWith(managedRoot, process.env)
    await cleanupDownloadedGrokBinary(download)
    expect(fs.existsSync(downloadDirectory)).toBe(false)
  })

  it('installs into a current-user directory without applying administrator ACLs', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-user-install-'))
    temporaryDirectories.push(directory)
    const downloadDirectory = path.join(directory, 'download')
    const userRoot = path.join(directory, '.grok', 'bin')
    fs.mkdirSync(downloadDirectory)
    const binaryPath = path.join(downloadDirectory, 'grok.exe')
    const content = Buffer.from('signed-user-test-binary')
    fs.writeFileSync(binaryPath, content)
    const download: DownloadedGrokBinary = {
      directory: downloadDirectory,
      binaryPath,
      version: '0.2.112',
      sourceUrl: 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      size: content.length,
      sha256Hex: createHash('sha256').update(content).digest('hex'),
    }
    const applyWindowsAcl = vi.fn(async () => undefined)

    const installed = await installDownloadedGrokBinary(download, {
      platform: 'win32',
      managedRoot: userRoot,
      protectInstallDirectory: false,
      applyWindowsAcl,
      verifyBinary: fakeVerification,
    })

    expect(installed.installDirectory).toBe(userRoot)
    expect(fs.readFileSync(installed.executablePath)).toEqual(content)
    expect(fs.readFileSync(installed.agentPath)).toEqual(content)
    expect(fs.existsSync(path.join(userRoot, 'version.json'))).toBe(true)
    expect(applyWindowsAcl).not.toHaveBeenCalled()
  })

  it('restores both executables and metadata when post-install verification fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-rollback-'))
    temporaryDirectories.push(directory)
    const downloadDirectory = path.join(directory, 'download')
    const managedRoot = path.join(directory, 'managed')
    fs.mkdirSync(downloadDirectory)
    fs.mkdirSync(managedRoot)
    const binaryPath = path.join(downloadDirectory, 'grok.exe')
    const nextContent = Buffer.from('next-signed-test-binary')
    fs.writeFileSync(binaryPath, nextContent)
    const oldExecutable = Buffer.from('old-grok-binary')
    const oldAgent = Buffer.from('old-agent-binary')
    const oldMetadata = `${JSON.stringify({ version: '0.2.111', stable_version: '0.2.111' }, null, 2)}\n`
    fs.writeFileSync(path.join(managedRoot, 'grok.exe'), oldExecutable)
    fs.writeFileSync(path.join(managedRoot, 'agent.exe'), oldAgent)
    fs.writeFileSync(path.join(managedRoot, 'version.json'), oldMetadata, 'utf8')
    const download: DownloadedGrokBinary = {
      directory: downloadDirectory,
      binaryPath,
      version: '0.2.112',
      sourceUrl: 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      size: nextContent.length,
      sha256Hex: createHash('sha256').update(nextContent).digest('hex'),
    }
    let verificationCount = 0
    const verifier = vi.fn(async (provider: string, filePath: string) => {
      verificationCount += 1
      if (verificationCount === 5) throw new Error('模拟 grok.exe 安装后签名校验失败')
      return fakeVerification(provider, filePath)
    })

    await expect(installDownloadedGrokBinary(download, {
      platform: 'win32',
      managedRoot,
      applyWindowsAcl: async () => undefined,
      verifyBinary: verifier,
    })).rejects.toThrow('模拟 grok.exe 安装后签名校验失败')

    expect(fs.readFileSync(path.join(managedRoot, 'grok.exe'))).toEqual(oldExecutable)
    expect(fs.readFileSync(path.join(managedRoot, 'agent.exe'))).toEqual(oldAgent)
    expect(fs.readFileSync(path.join(managedRoot, 'version.json'), 'utf8')).toBe(oldMetadata)
    expect(fs.readdirSync(managedRoot).filter((name) => /\.(?:pending\.(?:exe|json)|old)$/.test(name))).toEqual([])
  })

  it('restores the complete previous installation after a process crash', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-crash-'))
    temporaryDirectories.push(directory)
    const managedRoot = path.join(directory, 'managed')
    const transaction = path.join(managedRoot, '.grok-transaction-crashed')
    fs.mkdirSync(transaction, { recursive: true })
    const old = {
      'grok.exe': Buffer.from('old-grok'),
      'agent.exe': Buffer.from('old-agent'),
      'version.json': Buffer.from('{"version":"0.2.111"}\n'),
    }
    for (const [fileName, content] of Object.entries(old)) {
      fs.writeFileSync(path.join(managedRoot, fileName), `new-${fileName}`, 'utf8')
      fs.writeFileSync(path.join(transaction, `previous-${fileName}`), content)
    }
    fs.writeFileSync(path.join(transaction, 'transaction.json'), `${JSON.stringify({
      schemaVersion: 1,
      targets: Object.keys(old).map((fileName) => ({ fileName, hadExisting: true })),
    }, null, 2)}\n`, 'utf8')

    await expect(recoverInterruptedGrokInstallation(managedRoot, 'win32')).resolves.toBe(true)

    for (const [fileName, content] of Object.entries(old)) {
      expect(fs.readFileSync(path.join(managedRoot, fileName))).toEqual(content)
    }
    expect(fs.existsSync(transaction)).toBe(false)
  })

  it('preserves a failed rollback transaction and recovers it on the next attempt', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-grok-rollback-failure-'))
    temporaryDirectories.push(directory)
    const downloadDirectory = path.join(directory, 'download')
    const managedRoot = path.join(directory, 'managed')
    fs.mkdirSync(downloadDirectory)
    fs.mkdirSync(managedRoot)
    const binaryPath = path.join(downloadDirectory, 'grok.exe')
    const nextContent = Buffer.from('next-signed-test-binary')
    fs.writeFileSync(binaryPath, nextContent)
    const old = {
      'grok.exe': Buffer.from('old-grok-binary'),
      'agent.exe': Buffer.from('old-agent-binary'),
      'version.json': Buffer.from('{"version":"0.2.111"}\n'),
    }
    for (const [fileName, content] of Object.entries(old)) {
      fs.writeFileSync(path.join(managedRoot, fileName), content)
    }
    const download: DownloadedGrokBinary = {
      directory: downloadDirectory,
      binaryPath,
      version: '0.2.112',
      sourceUrl: 'https://x.ai/cli/grok-0.2.112-windows-x86_64.exe',
      size: nextContent.length,
      sha256Hex: createHash('sha256').update(nextContent).digest('hex'),
    }
    let verificationCount = 0
    const verifier = vi.fn(async (provider: string, filePath: string) => {
      verificationCount += 1
      if (verificationCount === 5) throw new Error('模拟提交后校验失败')
      return fakeVerification(provider, filePath)
    })
    let renameCount = 0
    const rename = vi.fn(async (source: string, destination: string) => {
      renameCount += 1
      if (renameCount === 7) throw new Error('模拟旧版元数据恢复失败')
      await fs.promises.rename(source, destination)
    })

    await expect(installDownloadedGrokBinary(download, {
      platform: 'win32',
      managedRoot,
      applyWindowsAcl: async () => undefined,
      verifyBinary: verifier,
      fileOperations: {
        rename,
        rm: (target, options) => fs.promises.rm(target, options),
      },
    })).rejects.toBeInstanceOf(GrokRollbackError)
    expect(fs.readdirSync(managedRoot).filter((name) => name.startsWith('.grok-transaction-')))
      .toHaveLength(1)

    await expect(recoverInterruptedGrokInstallation(managedRoot, 'win32')).resolves.toBe(true)
    for (const [fileName, content] of Object.entries(old)) {
      expect(fs.readFileSync(path.join(managedRoot, fileName))).toEqual(content)
    }
    expect(fs.readdirSync(managedRoot).filter((name) => name.startsWith('.grok-transaction-')))
      .toEqual([])
  })
})

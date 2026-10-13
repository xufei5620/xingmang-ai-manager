import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  codexPluginCatalogBucketIndexUrl,
  downloadCodexPluginCatalogFromBucket,
  parseCodexPluginCatalogBucketIndex,
} from './codex-plugin-catalog-bucket'
import { desktopPackageBucketOrigin, DesktopBucketUnavailableError } from './desktop-package-bucket'

// Nothing here reaches the real bucket: every request goes to a fake fetch, and the index is
// built in the exact shape scripts/sync-codex-plugins-cos.cjs publishes.
const commit = '1dc19589aa0d3f1c2b4e5f60718293a4b5c6d7e8'
const body = Buffer.alloc(96 * 1024, 7)
const sha = createHash('sha256').update(body).digest('hex')

function artifactKey(digest = sha, sourceCommit = commit): string {
  return `xingmang/offline/codex-plugins/sha256-${digest}/openai-plugins-${sourceCommit}.tar.gz`
}

function index(overrides: Record<string, unknown> = {}, artifact: Record<string, unknown> = {}, source: Record<string, unknown> = {}): string {
  const key = artifactKey()
  return JSON.stringify({
    schemaVersion: 1,
    product: 'codex-plugin-catalog',
    generatedAt: '2026-10-13T16:00:00.000Z',
    source: { repository: 'openai/plugins', ref: 'main', commit, url: `https://codeload.github.com/openai/plugins/tar.gz/${commit}`, ...source },
    artifact: {
      key, url: `${desktopPackageBucketOrigin}/${key}`, bytes: body.length, sha256: sha, contentType: 'application/gzip',
      verification: 'github-commit-archive-manifests', cosEtag: '"etag"', ...artifact,
    },
    ...overrides,
  })
}

interface ServeOptions {
  indexText?: string
  indexStatus?: number
  archive?: Response | ((init: RequestInit | undefined) => Response)
}

function archiveResponse(data: Buffer = body, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: { 'content-type': 'application/gzip', 'content-length': String(body.length), ...headers },
  })
}

function serving(options: ServeOptions = {}): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === codexPluginCatalogBucketIndexUrl()) {
      return new Response(options.indexText ?? index(), { status: options.indexStatus ?? 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === `${desktopPackageBucketOrigin}/${artifactKey()}`) {
      const archive = options.archive ?? archiveResponse()
      return typeof archive === 'function' ? archive(init) : archive
    }
    throw new Error(`unexpected request ${url}`)
  }
  return { fetch, calls }
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopBucketUnavailableError)
    return error as Error
  }
  throw new Error('the bucket route unexpectedly succeeded')
}

describe('Codex plugin catalog bucket index', () => {
  it('reads the commit, address, size and digest the sync script wrote', () => {
    expect(codexPluginCatalogBucketIndexUrl()).toBe(`${desktopPackageBucketOrigin}/xingmang/offline/codex-plugins/latest.json`)
    expect(parseCodexPluginCatalogBucketIndex(index())).toEqual({
      commit, url: `${desktopPackageBucketOrigin}/${artifactKey()}`, bytes: body.length, sha256: sha,
    })
  })

  it.each([
    ['another product', index({ product: 'chatgpt' })],
    ['a newer schema', index({ schemaVersion: 2 })],
    ['another repository', index({}, {}, { repository: 'someone/plugins' })],
    ['another branch', index({}, {}, { ref: 'next' })],
    ['a short commit', index({}, {}, { commit: '1dc1958' })],
    ['a key outside the layout', index({}, { key: 'xingmang/offline/codex-plugins/latest.json' })],
    ['a url on another host', index({}, { url: `https://evil.example/${artifactKey()}` })],
    ['an upper-case digest', index({}, { sha256: sha.toUpperCase() })],
    ['another content type', index({}, { contentType: 'text/html' })],
    ['another verification label', index({}, { verification: 'none' })],
    ['a tiny archive', index({}, { bytes: 1024 })],
    ['a huge archive', index({}, { bytes: 151 * 1024 * 1024 })],
    ['not JSON', '<html>'],
    ['an oversized index', JSON.stringify({ ...JSON.parse(index()), padding: 'x'.repeat(64 * 1024) })],
  ])('refuses %s', (_name, text) => {
    expect(parseCodexPluginCatalogBucketIndex(text)).toBeNull()
  })
})

describe('downloadCodexPluginCatalogFromBucket', () => {
  it('returns the exact bytes the index describes, asking the fixed bucket without following redirects', async () => {
    const { fetch, calls } = serving()

    await expect(downloadCodexPluginCatalogFromBucket(fetch)).resolves.toEqual({ commit, compressed: body })
    expect(calls.map((call) => call.url)).toEqual([codexPluginCatalogBucketIndexUrl(), `${desktopPackageBucketOrigin}/${artifactKey()}`])
    for (const call of calls) {
      expect(call.init).toMatchObject({ redirect: 'manual', credentials: 'omit' })
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('accepts the generic binary type the bucket may report', async () => {
    const { fetch } = serving({ archive: archiveResponse(body, { 'content-type': 'application/octet-stream' }) })
    await expect(downloadCodexPluginCatalogFromBucket(fetch)).resolves.toMatchObject({ commit })
  })

  it.each([
    ['a missing index', serving({ indexStatus: 404, indexText: '<Error/>' }), /HTTP 404/],
    ['an index in another shape', serving({ indexText: index({ product: 'chatgpt' }) }), /格式对不上/],
    ['a redirect', serving({ archive: new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }) }), /跳转/],
    ['a server error', serving({ archive: new Response('busy', { status: 503 }) }), /HTTP 503/],
    ['an HTML page', serving({ archive: archiveResponse(body, { 'content-type': 'text/html' }) }), /对不上/],
    ['a different declared size', serving({ archive: archiveResponse(body, { 'content-length': String(body.length - 1) }) }), /对不上/],
    ['a different body', serving({ archive: archiveResponse(Buffer.alloc(body.length, 8)) }), /SHA-256/],
    ['a short body', serving({ archive: archiveResponse(body.subarray(0, body.length - 10)) }), /没下完/],
    ['a longer body', serving({ archive: archiveResponse(Buffer.concat([body, Buffer.from('extra')])) }), /比清单里写的大/],
  ])('gives up on %s so the caller can fall back', async (_name, { fetch }, message) => {
    expect((await failureOf(downloadCodexPluginCatalogFromBucket(fetch))).message).toMatch(message)
  })

  it('treats an unreachable bucket as unavailable rather than a customer-facing error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('fetch failed') })
    expect((await failureOf(downloadCodexPluginCatalogFromBucket(fetch))).message).toMatch(/fetch failed/)
  })

  it('stops when the projected wait is too long once the first half minute has passed', async () => {
    let time = 0
    const { fetch } = serving({
      archive: new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(1024)) },
      }), { status: 200, headers: { 'content-type': 'application/gzip', 'content-length': String(body.length) } }),
    })

    const error = await failureOf(downloadCodexPluginCatalogFromBucket(fetch, { now: () => (time += 20_000) }))
    expect(error.message).toMatch(/太慢/)
  })

  it('stops when no data arrives for a while, reporting why', async () => {
    const { fetch } = serving({
      archive: (init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
        },
      }), { status: 200, headers: { 'content-type': 'application/gzip', 'content-length': String(body.length) } }),
    })

    const error = await failureOf(downloadCodexPluginCatalogFromBucket(fetch, { idleMs: 20 }))
    expect(error.message).toMatch(/停住了/)
  })
})

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildResumeHeaders,
  downloadWithResume,
  DownloadStalledError,
  isExpectedContentRange,
  type ResumableDownloadOptions,
} from './download-retry'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryTarget(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-download-retry-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'package.bin')
}

function packageBytes(size = 64 * 1024): Buffer {
  const bytes = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31) % 251
  return bytes
}

/** A body that hands out `bytes` in 4 KB chunks and then either ends or breaks. */
function streamOf(bytes: Buffer, breakWith?: unknown): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        if (breakWith === undefined) controller.close()
        else controller.error(breakWith)
        return
      }
      const end = Math.min(bytes.byteLength, offset + 4096)
      controller.enqueue(new Uint8Array(bytes.subarray(offset, end)))
      offset = end
    },
  })
}

function neverEndingStream(prefix: Buffer): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise<void>(() => undefined)
      sent = true
      controller.enqueue(new Uint8Array(prefix))
      return undefined
    },
  })
}

interface RecordedRequest {
  headers: Record<string, string>
  signal?: AbortSignal
}

function fullResponse(body: ReadableStream<Uint8Array>, total: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Length': String(total), ETag: '"abc"', ...extra },
  })
}

function rangeResponse(bytes: Buffer, offset: number, breakWith?: unknown): Response {
  return new Response(streamOf(bytes.subarray(offset), breakWith), {
    status: 206,
    headers: {
      'Content-Length': String(bytes.byteLength - offset),
      'Content-Range': `bytes ${offset}-${bytes.byteLength - 1}/${bytes.byteLength}`,
    },
  })
}

function options(
  target: string,
  responses: Array<(request: RecordedRequest) => Response | Promise<Response>>,
  requests: RecordedRequest[],
  overrides: Partial<ResumableDownloadOptions> = {},
): ResumableDownloadOptions {
  return {
    targetPath: target,
    maximumBytes: 1024 * 1024,
    oversizeMessage: '安装包超过安全上限',
    request: async (headers, signal) => {
      requests.push({ headers })
      const next = responses.shift()
      if (!next) throw new Error('unexpected extra request')
      return next({ headers, signal })
    },
    acceptResponse: (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const header = response.headers.get('content-length')
      return header === null ? null : Number(header)
    },
    wait: async () => undefined,
    ...overrides,
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('downloadWithResume', () => {
  it('downloads a package in one go without asking for a range', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const requests: RecordedRequest[] = []

    const result = await downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes), bytes.byteLength),
    ], requests))

    expect(result.resumes).toBe(0)
    expect(result.size).toBe(bytes.byteLength)
    expect(result.sha256.toString('hex')).toBe(sha256(bytes))
    expect(fs.readFileSync(target).equals(bytes)).toBe(true)
    expect(requests).toEqual([{ headers: {} }])
  })

  it('picks a broken download up from where it stopped on the same route', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const cut = 20 * 1024
    const requests: RecordedRequest[] = []
    const progress: number[] = []
    const resumed: Array<[number, number]> = []
    const waits: number[] = []

    const result = await downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes.subarray(0, cut), new TypeError('fetch failed')), bytes.byteLength),
      () => rangeResponse(bytes, cut),
    ], requests, {
      onProgress: (transferred) => progress.push(transferred),
      onResume: (transferred, total) => resumed.push([transferred, total]),
      wait: async (milliseconds) => { waits.push(milliseconds) },
    }))

    expect(requests[1].headers).toEqual({ Range: `bytes=${cut}-`, 'If-Range': '"abc"' })
    expect(resumed).toEqual([[cut, bytes.byteLength]])
    expect(waits).toEqual([3_000])
    expect(result.resumes).toBe(1)
    expect(result.sha256.toString('hex')).toBe(sha256(bytes))
    expect(fs.readFileSync(target).equals(bytes)).toBe(true)
    // 进度接着走，不回到 0。
    expect(progress.every((value, index) => index === 0 || value > progress[index - 1])).toBe(true)
    expect(progress.at(-1)).toBe(bytes.byteLength)
  })

  it('treats a connection that closed early as a break and resumes it', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const cut = 8 * 1024
    const requests: RecordedRequest[] = []

    const result = await downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes.subarray(0, cut)), bytes.byteLength),
      () => rangeResponse(bytes, cut),
    ], requests))

    expect(result.resumes).toBe(1)
    expect(fs.readFileSync(target).equals(bytes)).toBe(true)
  })

  it('hands the original failure back when the route ignores the range, so the caller switches routes', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const breakError = new TypeError('fetch failed')
    const requests: RecordedRequest[] = []

    const error = await downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes.subarray(0, 10_000), breakError), bytes.byteLength),
      () => fullResponse(streamOf(bytes), bytes.byteLength),
    ], requests)).catch((cause: unknown) => cause)

    expect(error).toBe(breakError)
    expect(requests).toHaveLength(2)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('refuses a resumed body whose range or total does not match the first response', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const breakError = new TypeError('fetch failed')
    const requests: RecordedRequest[] = []

    const error = await downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes.subarray(0, 10_000), breakError), bytes.byteLength),
      () => new Response(streamOf(bytes.subarray(10_000)), {
        status: 206,
        headers: { 'Content-Range': `bytes 10000-${bytes.byteLength}/${bytes.byteLength + 1}` },
      }),
    ], requests)).catch((cause: unknown) => cause)

    expect(error).toBe(breakError)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('does not wait or retry when the route failed before sending anything', async () => {
    const target = temporaryTarget()
    const refused = new TypeError('fetch failed')
    const requests: RecordedRequest[] = []
    let waited = false

    const error = await downloadWithResume(options(target, [
      () => { throw refused },
    ], requests, { wait: async () => { waited = true } })).catch((cause: unknown) => cause)

    expect(error).toBe(refused)
    expect(requests).toHaveLength(1)
    expect(waited).toBe(false)
  })

  it('gives up after two resumes in a row that brought nothing new', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const requests: RecordedRequest[] = []
    const waits: number[] = []
    const reset = () => { throw new TypeError('fetch failed') }

    const error = await downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes.subarray(0, 10_000), new TypeError('socket hang up')), bytes.byteLength),
      reset,
      reset,
      reset,
    ], requests, { wait: async (milliseconds) => { waits.push(milliseconds) } })).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(TypeError)
    expect(waits).toEqual([3_000, 10_000])
    expect(requests).toHaveLength(3)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('never retries after the user cancelled while waiting to resume', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const controller = new AbortController()
    const cancelled = new Error('用户取消了')
    const requests: RecordedRequest[] = []

    const error = await downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes.subarray(0, 10_000), new TypeError('fetch failed')), bytes.byteLength),
    ], requests, {
      signal: controller.signal,
      wait: async () => {
        controller.abort(cancelled)
        throw cancelled
      },
    })).catch((cause: unknown) => cause)

    expect(error).toBe(cancelled)
    expect(requests).toHaveLength(1)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('reports a cancel during the transfer as the cancel, not as a break to resume', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const controller = new AbortController()
    const cancelled = new Error('用户取消了')
    const requests: RecordedRequest[] = []
    let waited = false

    const error = await downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes.subarray(0, 10_000), new TypeError('fetch failed')), bytes.byteLength),
    ], requests, {
      signal: controller.signal,
      onProgress: (transferred) => { if (transferred >= 8192) controller.abort(cancelled) },
      wait: async () => { waited = true },
    })).catch((cause: unknown) => cause)

    expect(error).toBe(cancelled)
    expect(waited).toBe(false)
  })

  it('resumes a transfer that stopped sending data without an error', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const cut = 4096
    const requests: RecordedRequest[] = []

    const result = await downloadWithResume(options(target, [
      () => fullResponse(neverEndingStream(bytes.subarray(0, cut)), bytes.byteLength),
      () => rangeResponse(bytes, cut),
    ], requests, { idleTimeoutMs: 30 }))

    expect(result.resumes).toBe(1)
    expect(fs.readFileSync(target).equals(bytes)).toBe(true)
  })

  it('names a stalled connection plainly when there is nothing to resume from', async () => {
    const target = temporaryTarget()
    const requests: RecordedRequest[] = []

    const error = await downloadWithResume(options(target, [
      ({ signal }) => new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ], requests, { responseTimeoutMs: 30 })).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DownloadStalledError)
    expect(requests).toHaveLength(1)
  })

  it('never resumes past a body that grew beyond its declared size', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const requests: RecordedRequest[] = []

    await expect(downloadWithResume(options(target, [
      () => fullResponse(streamOf(bytes), bytes.byteLength - 1),
    ], requests))).rejects.toThrow('安装包超过安全上限')
    expect(requests).toHaveLength(1)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('does not try to resume when the size was never declared', async () => {
    const target = temporaryTarget()
    const bytes = packageBytes()
    const breakError = new TypeError('fetch failed')
    const requests: RecordedRequest[] = []

    const error = await downloadWithResume(options(target, [
      () => new Response(streamOf(bytes.subarray(0, 10_000), breakError), { status: 200 }),
    ], requests, { acceptResponse: () => null })).catch((cause: unknown) => cause)

    expect(error).toBe(breakError)
    expect(requests).toHaveLength(1)
  })
})

describe('resume headers', () => {
  it('pins the resumed range to a strong ETag and falls back to Last-Modified', () => {
    expect(buildResumeHeaders(10, { etag: '"v1"', lastModified: 'Mon, 02 Dec 2024 22:15:00 GMT' }))
      .toEqual({ Range: 'bytes=10-', 'If-Range': '"v1"' })
    expect(buildResumeHeaders(10, { etag: 'W/"v1"', lastModified: 'Mon, 02 Dec 2024 22:15:00 GMT' }))
      .toEqual({ Range: 'bytes=10-', 'If-Range': 'Mon, 02 Dec 2024 22:15:00 GMT' })
    expect(buildResumeHeaders(10, { etag: null, lastModified: null })).toEqual({ Range: 'bytes=10-' })
  })

  it('accepts only the exact remaining range of the same-sized file', () => {
    expect(isExpectedContentRange('bytes 10-99/100', 10, 100)).toBe(true)
    expect(isExpectedContentRange('bytes 0-99/100', 10, 100)).toBe(false)
    expect(isExpectedContentRange('bytes 10-98/100', 10, 100)).toBe(false)
    expect(isExpectedContentRange('bytes 10-100/101', 10, 100)).toBe(false)
    expect(isExpectedContentRange('bytes 10-99/*', 10, 100)).toBe(false)
    expect(isExpectedContentRange(null, 10, 100)).toBe(false)
  })

  it('exposes a stall as its own error type', () => {
    expect(new DownloadStalledError().message).toContain('没有新数据')
  })
})

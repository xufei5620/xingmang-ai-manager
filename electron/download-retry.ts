import { createHash } from 'node:crypto'
import fs from 'node:fs'

/**
 * 大安装包（Codex 桌面端、Node.js、Git、Python）下到一半网络断了，以前直接换下一条
 * 线路从 0 开始；弱网客户几条线路轮一遍都碰上抖动就装不上。这里先在同一条线路上
 * 从断开的位置接着下，接不上再交还给调用方去换线路。
 *
 * What this module deliberately does not do:
 * - It never relaxes a caller's checks. The first response still goes through the
 *   caller's own acceptResponse, every byte still feeds the same SHA-256 the caller
 *   verifies afterwards, and a resumed body must match the exact byte range and total
 *   size the first response declared. A server that ignores the range or reports a
 *   different total ends the resume instead of being trusted.
 * - It never retries a download that had not delivered a single byte. A route that is
 *   down fails over to the next route exactly as before, without extra waiting.
 * - It never retries after the caller's own signal fired: that is either the user
 *   pressing cancel or the caller's overall deadline.
 */

export interface ResumableDownloadOptions {
  targetPath: string
  /** Mode for the newly created file (it is always created exclusively). */
  fileMode?: number
  /** Hard ceiling on bytes written, checked on every chunk. */
  maximumBytes: number
  /** Message for the error thrown when the body grows past the declared or maximum size. */
  oversizeMessage: string
  /**
   * Issues one GET for the package. `headers` holds the resume headers (empty on the
   * first request); the caller merges them into its own and keeps its redirect policy.
   */
  request(headers: Record<string, string>, signal: AbortSignal): Promise<Response>
  /** Checks the first full response and returns its declared size, or null when absent. */
  acceptResponse(response: Response): number | null
  /** The caller's cancel and overall-deadline signal. Once it fires nothing is retried. */
  signal?: AbortSignal
  onProgress?(transferred: number, total: number | null): void
  /** Called before waiting to pick up a broken download from where it stopped. */
  onResume?(transferred: number, total: number): void
  responseTimeoutMs?: number
  idleTimeoutMs?: number
  /** Waits between consecutive resume attempts that made no progress. */
  resumeDelaysMs?: readonly number[]
  /** Upper bound on resumes for one download, so a flapping link cannot loop forever. */
  maximumResumes?: number
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>
}

export interface ResumableDownloadResult {
  size: number
  total: number | null
  sha256: Buffer
  resumes: number
}

/** 连接上了但一直等不到数据：多半是网络断了，没有报错只是不动了。 */
export class DownloadStalledError extends Error {
  constructor() {
    super('下载中途没有新数据，网络可能断了')
    this.name = 'DownloadStalledError'
  }
}

export const defaultDownloadResumeDelaysMs: readonly number[] = [3_000, 10_000]
const defaultResponseTimeoutMs = 45_000
const defaultIdleTimeoutMs = 45_000
const defaultMaximumResumes = 6

/** Raised inside the loop for a break the next resume attempt may repair. */
class InterruptedTransfer extends Error {
  constructor(readonly cause: unknown) {
    super('download interrupted')
  }
}

/** The route answered a resume request with something other than the exact remaining range. */
class ResumeRefused extends Error {
  constructor() {
    super('这条线路不支持从断开处接着下载')
    this.name = 'ResumeRefused'
  }
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A strong ETag pins the resumed range to the same file; without one fall back to
 * Last-Modified. Weak ETags are not allowed in If-Range, so they are dropped.
 */
export function buildResumeHeaders(
  offset: number,
  validator: { etag: string | null; lastModified: string | null },
): Record<string, string> {
  const headers: Record<string, string> = { Range: `bytes=${offset}-` }
  if (validator.etag && !validator.etag.startsWith('W/')) headers['If-Range'] = validator.etag
  else if (validator.lastModified) headers['If-Range'] = validator.lastModified
  return headers
}

/** Accepts only `bytes <offset>-<total-1>/<total>` for exactly the range that was asked for. */
export function isExpectedContentRange(value: string | null, offset: number, total: number): boolean {
  const match = value?.trim().match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
  if (!match) return false
  return Number(match[1]) === offset
    && Number(match[2]) === total - 1
    && Number(match[3]) === total
}

async function writeFully(file: fs.promises.FileHandle, chunk: Uint8Array, position: number): Promise<void> {
  let written = 0
  while (written < chunk.byteLength) {
    const result = await file.write(chunk, written, chunk.byteLength - written, position + written)
    if (result.bytesWritten <= 0) throw new Error('安装包写入磁盘失败')
    written += result.bytesWritten
  }
}

export async function downloadWithResume(options: ResumableDownloadOptions): Promise<ResumableDownloadResult> {
  const outer = options.signal
  const responseTimeoutMs = options.responseTimeoutMs ?? defaultResponseTimeoutMs
  const idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs
  const resumeDelays = options.resumeDelaysMs ?? defaultDownloadResumeDelaysMs
  const maximumResumes = options.maximumResumes ?? defaultMaximumResumes
  const wait = options.wait ?? waitFor

  const hash = createHash('sha256')
  // Kept in one object because the per-request closure below updates it; plain
  // `let`s would stay narrowed to their initial null in the retry loop.
  const state: {
    file: fs.promises.FileHandle | null
    transferred: number
    total: number | null
    validator: { etag: string | null; lastModified: string | null }
  } = { file: null, transferred: 0, total: null, validator: { etag: null, lastModified: null } }
  let resumes = 0
  let failedResumesInARow = 0

  // One request plus its body. Transport failures come back as InterruptedTransfer;
  // everything the caller or this module rejects on purpose is thrown as is.
  async function transfer(resumeFrom: number | null): Promise<void> {
    const attempt = new AbortController()
    const abortFromOuter = () => attempt.abort(outer?.reason)
    if (outer?.aborted) abortFromOuter()
    outer?.addEventListener('abort', abortFromOuter, { once: true })
    const stalled = new DownloadStalledError()
    // Not every body stream is wired to the request's signal, so a read is raced
    // against the abort itself instead of trusting the stream to notice it.
    const aborted = new Promise<never>((_resolve, reject) => {
      attempt.signal.addEventListener('abort', () => reject(attempt.signal.reason), { once: true })
    })
    aborted.catch(() => undefined)
    let timer = setTimeout(() => attempt.abort(stalled), responseTimeoutMs)
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      let response: Response
      try {
        const headers = resumeFrom === null ? {} : buildResumeHeaders(resumeFrom, state.validator)
        response = await Promise.race([options.request(headers, attempt.signal), aborted])
      } catch (error) {
        throw new InterruptedTransfer(attempt.signal.reason === stalled ? stalled : error)
      }
      clearTimeout(timer)

      if (resumeFrom === null) {
        state.total = options.acceptResponse(response)
        if (state.total !== null && state.total > options.maximumBytes) throw new Error(options.oversizeMessage)
        state.validator = {
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        }
        if (!response.body) throw new Error('服务器没有返回安装包内容')
        state.file = await fs.promises.open(options.targetPath, 'wx', options.fileMode ?? 0o666)
      } else if (
        response.status !== 206
        || state.total === null
        || !isExpectedContentRange(response.headers.get('content-range'), resumeFrom, state.total)
        || !response.body
      ) {
        // 这条线路不支持接着下，或者文件已经换了：不拼接，交给调用方换线路。
        await response.body?.cancel().catch(() => undefined)
        throw new ResumeRefused()
      } else {
        await state.file?.truncate(resumeFrom)
      }

      const file = state.file
      if (!response.body || !file) throw new Error('服务器没有返回安装包内容')
      const total = state.total
      reader = response.body.getReader()
      while (true) {
        timer = setTimeout(() => attempt.abort(stalled), idleTimeoutMs)
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await Promise.race([reader.read(), aborted])
        } catch (error) {
          throw new InterruptedTransfer(attempt.signal.reason === stalled ? stalled : error)
        } finally {
          clearTimeout(timer)
        }
        if (chunk.done) break
        if (!chunk.value?.byteLength) continue
        const next = state.transferred + chunk.value.byteLength
        if (next > options.maximumBytes || (total !== null && next > total)) {
          await reader.cancel().catch(() => undefined)
          throw new Error(options.oversizeMessage)
        }
        await writeFully(file, chunk.value, state.transferred)
        // Hash only what reached the file, so a resume that truncates back to
        // `transferred` leaves the digest and the file describing the same bytes.
        hash.update(chunk.value)
        state.transferred = next
        options.onProgress?.(next, total)
      }
      // A connection closed cleanly but early is the same break as a reset one.
      if (total !== null && state.transferred < total) {
        throw new InterruptedTransfer(new Error('连接提前结束，安装包没下完'))
      }
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', abortFromOuter)
      if (attempt.signal.aborted) await reader?.cancel().catch(() => undefined)
    }
  }

  try {
    let resumeFrom: number | null = null
    let lastInterruption: unknown = null
    while (true) {
      const before = state.transferred
      try {
        await transfer(resumeFrom)
        break
      } catch (error) {
        if (outer?.aborted) {
          const cause = error instanceof InterruptedTransfer ? error.cause : error
          throw outer.reason ?? cause ?? new Error('下载已取消')
        }
        if (error instanceof ResumeRefused) throw lastInterruption ?? error
        if (!(error instanceof InterruptedTransfer)) throw error
        lastInterruption = error.cause
        // Nothing arrived yet: this route is down, not flaky. Fail over as before.
        const { file, transferred, total } = state
        if (!file || transferred === 0 || total === null) throw error.cause
        failedResumesInARow = resumeFrom !== null && transferred === before ? failedResumesInARow + 1 : 0
        if (resumes >= maximumResumes || failedResumesInARow >= resumeDelays.length) throw error.cause
        resumes += 1
        options.onResume?.(transferred, total)
        await wait(resumeDelays[failedResumesInARow] ?? resumeDelays.at(-1) ?? 0, outer)
        resumeFrom = transferred
      }
    }
    const finished = state.file
    if (!finished) throw new Error('服务器没有返回安装包内容')
    await finished.sync()
    await finished.close()
    state.file = null
    return { size: state.transferred, total: state.total, sha256: hash.digest(), resumes }
  } catch (error) {
    const opened = state.file
    state.file = null
    await opened?.close().catch(() => undefined)
    await fs.promises.rm(options.targetPath, { force: true }).catch(() => undefined)
    throw error
  }
}

// A package server that hands out one chunk at a time on a fake clock, and a driver that moves
// that clock only once the code under test has gone idle waiting for the next chunk. It lets a
// test run a download that takes tens of minutes through the real downloadWithResume, with the
// file still written, removed and hashed for real, in a couple of seconds.
//
// Test-only: tsconfig.electron.json excludes *.test-support.ts, so none of this reaches
// dist-electron.

import { vi } from 'vitest'

/**
 * One chunk every 40 seconds: never quiet long enough for the per-request idle timer in
 * downloadWithResume (45 seconds), so only the whole-download limits decide the outcome.
 */
export const slowChunkEveryMs = 40_000

export interface SlowDownload {
  enqueued: number
  reported: number
  /** The body is waiting for the clock to hand out its next chunk. */
  waiting: boolean
  /** The body was read to the end or cancelled; nothing on it waits for the clock any more. */
  finished: boolean
}

export interface SlowPackageServer {
  /** One entry per response handed out, oldest first. */
  readonly downloads: SlowDownload[]
  /** A 200 for `url` whose body trickles out `size` bytes of `fill`, `chunkBytes` at a time. */
  respond(url: string, size: number, fill: number, chunkBytes: number): Response
  /** Call once from the caller's progress callback for every chunk it reports. */
  reported(): void
  /** Settles with `work`, moving the fake clock one chunk at a time until it does. */
  drive<T>(work: Promise<T>): Promise<T>
}

export function createSlowPackageServer(): SlowPackageServer {
  const downloads: SlowDownload[] = []

  function respond(url: string, size: number, fill: number, chunkBytes: number): Response {
    const download: SlowDownload = { enqueued: 0, reported: 0, waiting: false, finished: false }
    downloads.push(download)
    let offset = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        download.waiting = true
        await new Promise((resolve) => setTimeout(resolve, slowChunkEveryMs))
        download.waiting = false
        if (download.finished) return
        if (offset >= size) {
          download.finished = true
          controller.close()
          return
        }
        const length = Math.min(chunkBytes, size - offset)
        controller.enqueue(new Uint8Array(length).fill(fill))
        offset += length
        download.enqueued += 1
      },
      cancel() {
        download.finished = true
      },
    }), { status: 200, headers: { 'content-length': String(size) } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }

  function reported(): void {
    const current = downloads.at(-1)
    if (current) current.reported += 1
  }

  // The clock only moves while the newest body is asking for its next chunk and every chunk
  // it already handed out has been reported. Anything else (a write, the switch to the next
  // source, the checks after the download) waits in real time, so slow disk work never shows
  // up as minutes of fake time without progress.
  function idle(): boolean {
    const current = downloads.at(-1)
    return Boolean(current && !current.finished && current.waiting && current.reported >= current.enqueued)
  }

  async function drive<T>(work: Promise<T>): Promise<T> {
    let settled = false
    work.then(() => { settled = true }, () => { settled = true })
    while (!settled) {
      for (let turn = 0; turn < 10_000 && !settled && !idle(); turn += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      if (!settled) await vi.advanceTimersByTimeAsync(slowChunkEveryMs)
    }
    return work
  }

  return { downloads, respond, reported, drive }
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexPayloadNearingBytes,
  codexPayloadNoticeTtlMs,
  codexPayloadRetryMs,
  codexPayloadStaleMs,
  codexRolloutSessionId,
  catchUpMaxFiles,
  createCodexPayloadLimitService,
  createCodexPayloadNoticeBoard,
  createCodexPayloadStateStore,
  createCodexRolloutWatcher,
  findRecentCodexRollouts,
  parseCodexPayloadState,
  parseCodexPayloadTooLarge,
  rolloutTailBytes,
  type CodexLargeSessionEvent,
  type CodexPayloadLimitDependencies,
  type CodexPayloadState,
  type CodexPayloadTooLargeEvent,
} from './codex-payload-limit'
import type { RelayRouteHoldResult } from './relay-route-controller'
import type { CodexPayloadNoticeKind } from './running-tools'

// Placeholders only: made-up session IDs and Cloudflare ray, the sites' public line addresses.
const sessionA = '00000000-0000-4000-8000-00000000000a'
const sessionB = '00000000-0000-4000-8000-00000000000b'
const lineOneUrl = 'https://xm.solov.cc/v1/responses'
const lineTwoUrl = 'https://xm-direct.solov.cc/v1/responses'
const historicalLineOneUrl = 'https://api.solov.cc/v1/responses'
const now = Date.parse('2026-10-28T08:00:00.000Z')
const minuteMs = 60_000
const dayMs = 24 * 60 * minuteMs

const directories: string[] = []

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop() as string, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-payload-'))
  directories.push(directory)
  return directory
}

function rolloutName(sessionId: string): string {
  return `rollout-2026-10-28T15-59-00-${sessionId}.jsonl`
}

const cloudflarePage = '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n'
  + '<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>cloudflare</center>\r\n</body>\r\n</html>'

function payloadMessage(url: string): string {
  return `unexpected status 413 Payload Too Large: ${cloudflarePage}, url: ${url}, cf-ray: 0000000000000000-LAX`
}

// 0.163、0.164 一轮没发出去时写的那一行（形状照实测，内容是占位）。
function turnFailedLine(url: string, at = now, message = payloadMessage(url)): string {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    ordinal: 9,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '00000000-0000-7000-8000-000000000001',
      last_agent_message: null,
      error: { message, codex_error_info: { http_connection_failed: { http_status_code: 413 } } },
    },
  })
}

function otherLine(text = 'hello'): string {
  return JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
}

describe('codex rollout session id', () => {
  it('takes the session id from a Codex rollout file name only', () => {
    expect(codexRolloutSessionId(rolloutName(sessionA))).toBe(sessionA)
    expect(codexRolloutSessionId(rolloutName(sessionA.toUpperCase()))).toBe(sessionA)
    for (const name of [
      `${rolloutName(sessionA)}.bak`,
      `rollout-2026-10-28-${sessionA}.jsonl`,
      `rollout-2026-10-28T15-59-00-${sessionA.slice(1)}.jsonl`,
      'notes.jsonl',
      '',
    ]) expect(codexRolloutSessionId(name)).toBeNull()
  })
})

describe('codex payload too large parser', () => {
  it('reads the address and the time from the line Codex writes when a turn is refused as too large', () => {
    expect(parseCodexPayloadTooLarge(turnFailedLine(lineOneUrl))).toEqual({ url: lineOneUrl, at: now })
    expect(parseCodexPayloadTooLarge(turnFailedLine(lineTwoUrl))).toEqual({ url: lineTwoUrl, at: now })
    // 老版本另写的 error 事件。
    const older = JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'error', message: payloadMessage(lineOneUrl) } })
    expect(parseCodexPayloadTooLarge(older)).toEqual({ url: lineOneUrl, at: now })
  })

  it('ignores other status codes and pages that only mention 413', () => {
    for (const message of [
      `unexpected status 401 Unauthorized: {"error":"invalid"}, url: ${lineOneUrl}, cf-ray: 0000000000000000-LAX`,
      `unexpected status 429 Too Many Requests: slow down, url: ${lineOneUrl}`,
      `unexpected status 500 Internal Server Error: 413 Payload Too Large, url: ${lineOneUrl}`,
      `unexpected status 502 Bad Gateway: ${cloudflarePage}, url: ${lineOneUrl}`,
      'unexpected status 413 Payload Too Large: no address here',
    ]) expect(parseCodexPayloadTooLarge(turnFailedLine(lineOneUrl, now, message))).toBeNull()
  })

  it('ignores reconnect notices, the conversation itself and anything that is not a turn result', () => {
    const quoted = payloadMessage(lineOneUrl)
    for (const line of [
      JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'stream_error', message: `Reconnecting... 2/5 (${quoted})` } }),
      otherLine(quoted),
      JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: quoted }] } } }),
      JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'task_complete', error: null, last_agent_message: quoted } }),
      JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'error', message: { text: quoted } } }),
    ]) expect(parseCodexPayloadTooLarge(line)).toBeNull()
  })

  it('takes the last address so a page cannot plant another one, and needs a valid time', () => {
    const planted = `unexpected status 413 Payload Too Large: <p>, url: ${lineTwoUrl}, </p>, url: ${lineOneUrl}, cf-ray: 0000000000000000-LAX`
    expect(parseCodexPayloadTooLarge(turnFailedLine(lineOneUrl, now, planted))?.url).toBe(lineOneUrl)
    const line = JSON.parse(turnFailedLine(lineOneUrl)) as Record<string, unknown>
    expect(parseCodexPayloadTooLarge(JSON.stringify({ ...line, timestamp: undefined }))).toBeNull()
    expect(parseCodexPayloadTooLarge(JSON.stringify({ ...line, timestamp: 'yesterday' }))).toBeNull()
    expect(parseCodexPayloadTooLarge(JSON.stringify({ ...line, type: 'response_item' }))).toBeNull()
  })

  it('never throws on broken or oversized lines', () => {
    for (const line of ['', '{', 'null', '[413, "Payload Too Large"]', '"413 Payload Too Large"', turnFailedLine(lineOneUrl).slice(0, -1)]) {
      expect(parseCodexPayloadTooLarge(line)).toBeNull()
    }
    expect(parseCodexPayloadTooLarge(turnFailedLine(lineOneUrl, now, `${payloadMessage(lineOneUrl)}${' '.repeat(64 * 1024)}`))).toBeNull()
  })
})

interface WatcherHarness {
  sessionsDirectory: string
  dayDirectory: string
  found: CodexPayloadTooLargeEvent[]
  large: CodexLargeSessionEvent[]
  delays: number[]
  scheduled: Array<{ callback: () => void; delayMs: number }>
  logs: string[]
  watcher: ReturnType<typeof createCodexRolloutWatcher>
  /** Runs the pending callback scheduled with this delay, as the timer would. */
  fire(delayMs: number): void
  /** Simulates the directory notification for a file under the sessions directory. */
  touch(relative: string | null): void
  /** Simulates the directory watch failing after it started. */
  breakWatch(): void
  filePath(sessionId: string): string
  relative(sessionId: string): string
  watchFails: { current: boolean }
}

function watcherHarness(options: { onPayloadTooLarge?: (event: CodexPayloadTooLargeEvent) => void } = {}): WatcherHarness {
  const root = temporaryDirectory()
  const sessionsDirectory = path.join(root, 'sessions')
  const dayDirectory = path.join(sessionsDirectory, '2026', '10', '28')
  fs.mkdirSync(dayDirectory, { recursive: true })
  const found: CodexPayloadTooLargeEvent[] = []
  const large: CodexLargeSessionEvent[] = []
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const delays: number[] = []
  const logs: string[] = []
  const watchFails = { current: false }
  let onChange: ((fileName: string | null) => void) | null = null
  let onError: (() => void) | null = null
  const watcher = createCodexRolloutWatcher({
    sessionsDirectory,
    onPayloadTooLarge: (event) => {
      found.push(event)
      options.onPayloadTooLarge?.(event)
    },
    onLargeSession: (event) => { large.push(event) },
    now: () => now,
    log: (_level, event) => { logs.push(event) },
    watch(directory, change, error) {
      if (watchFails.current) throw new Error('ENOENT')
      expect(directory).toBe(sessionsDirectory)
      onChange = change
      onError = error
      return { close() { onChange = null; onError = null } }
    },
    schedule(callback, delayMs) {
      const entry = { callback, delayMs }
      scheduled.push(entry)
      delays.push(delayMs)
      return () => {
        const index = scheduled.indexOf(entry)
        if (index >= 0) scheduled.splice(index, 1)
      }
    },
  })
  return {
    sessionsDirectory,
    dayDirectory,
    found,
    large,
    delays,
    scheduled,
    logs,
    watcher,
    watchFails,
    fire(delayMs) {
      const entry = scheduled.find((pending) => pending.delayMs === delayMs)
      if (!entry) throw new Error(`no ${delayMs} ms callback pending`)
      scheduled.splice(scheduled.indexOf(entry), 1)
      entry.callback()
    },
    touch(relative) { onChange?.(relative) },
    breakWatch() { onError?.() },
    filePath: (sessionId) => path.join(dayDirectory, rolloutName(sessionId)),
    relative: (sessionId) => path.join('2026', '10', '28', rolloutName(sessionId)),
  }
}

describe('codex rollout watcher', () => {
  it('reports a refused turn once with the session and the record size, and only reads what was added since', async () => {
    const run = watcherHarness()
    run.watcher.start()
    const file = run.filePath(sessionA)
    fs.writeFileSync(file, `${otherLine()}\n${turnFailedLine(lineOneUrl)}\n`)
    run.touch(run.relative(sessionA))
    // 一轮里连着写好几行：等一秒再读。
    expect(run.delays).toContain(1_000)
    await run.watcher.flush()
    expect(run.found).toEqual([{ sessionId: sessionA, url: lineOneUrl, at: now, rolloutBytes: fs.statSync(file).size }])
    expect(run.logs).toEqual(['codex-payload.watch-started'])

    fs.appendFileSync(file, `${otherLine()}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found).toHaveLength(1)

    fs.appendFileSync(file, `${turnFailedLine(lineOneUrl, now + 1)}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found.map((event) => event.at)).toEqual([now, now + 1])
    run.watcher.dispose()
  })

  it('waits for a line that is still being written', async () => {
    const run = watcherHarness()
    run.watcher.start()
    const file = run.filePath(sessionA)
    const line = turnFailedLine(lineOneUrl)
    fs.writeFileSync(file, `${otherLine()}\n${line.slice(0, 100)}`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found).toEqual([])
    fs.appendFileSync(file, `${line.slice(100)}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found).toHaveLength(1)
    run.watcher.dispose()
  })

  it('reads only the end of a record it sees for the first time and of a big write', async () => {
    const run = watcherHarness()
    run.watcher.start()
    const file = run.filePath(sessionA)
    const filler = `${otherLine('x'.repeat(1_000))}\n`.repeat(Math.ceil(rolloutTailBytes / 1_000) + 10)
    fs.writeFileSync(file, `${turnFailedLine(lineOneUrl)}\n${filler}`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found).toEqual([])

    // 一下子写进来比一次能读的还多：只读末尾，前面那行 413 不再回头找。
    fs.appendFileSync(file, `${turnFailedLine(lineOneUrl, now + 1)}\n${filler}${turnFailedLine(lineOneUrl, now + 2)}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found.map((event) => event.at)).toEqual([now + 2])
    run.watcher.dispose()
  })

  it('skips a line too long to read in one go and picks up the lines after it', async () => {
    const run = watcherHarness()
    run.watcher.start()
    const file = run.filePath(sessionA)
    fs.writeFileSync(file, `${otherLine()}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    // 一张截图那种一整行：比一次能读的还长，还没写完。
    fs.appendFileSync(file, otherLine('y'.repeat(rolloutTailBytes + 1_000)).slice(0, rolloutTailBytes + 500))
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    fs.appendFileSync(file, `"}]}}\n${turnFailedLine(lineOneUrl)}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found.map((event) => event.sessionId)).toEqual([sessionA])
    run.watcher.dispose()
  })

  it('ignores files that are not Codex rollouts and paths that leave the sessions directory', async () => {
    const run = watcherHarness()
    run.watcher.start()
    fs.writeFileSync(path.join(run.dayDirectory, 'notes.jsonl'), `${turnFailedLine(lineOneUrl)}\n`)
    const outside = path.join(path.dirname(run.sessionsDirectory), rolloutName(sessionB))
    fs.writeFileSync(outside, `${turnFailedLine(lineOneUrl)}\n`)
    for (const name of [path.join('2026', '10', '28', 'notes.jsonl'), path.join('..', rolloutName(sessionB)), outside, null]) run.touch(name)
    await run.watcher.flush()
    expect(run.found).toEqual([])
    run.watcher.dispose()
  })

  it.runIf(process.platform !== 'win32')('never reads through a symlink or a hard link planted in the sessions directory', async () => {
    const run = watcherHarness()
    run.watcher.start()
    const target = path.join(path.dirname(run.sessionsDirectory), 'elsewhere.jsonl')
    fs.writeFileSync(target, `${turnFailedLine(lineOneUrl)}\n`)
    fs.symlinkSync(target, run.filePath(sessionA))
    fs.linkSync(target, run.filePath(sessionB))
    run.touch(run.relative(sessionA))
    run.touch(run.relative(sessionB))
    await run.watcher.flush()
    expect(run.found).toEqual([])
    run.watcher.dispose()
  })

  it('reports a record that has grown past the early warning size every time it is read', async () => {
    const run = watcherHarness()
    run.watcher.start()
    const file = run.filePath(sessionA)
    fs.writeFileSync(file, `${otherLine()}\n`)
    // 稀疏文件：不真占那么多磁盘。
    fs.truncateSync(file, codexPayloadNearingBytes)
    fs.appendFileSync(file, `\n${otherLine()}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.large).toEqual([{ sessionId: sessionA, rolloutBytes: fs.statSync(file).size }])
    expect(run.found).toEqual([])
    run.watcher.dispose()
  })

  it('looks at recently written records again without a directory notification', async () => {
    const run = watcherHarness()
    run.watcher.start()
    expect(run.delays).toContain(30_000)
    const file = run.filePath(sessionA)
    fs.writeFileSync(file, `${otherLine()}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    fs.appendFileSync(file, `${turnFailedLine(lineOneUrl)}\n`)
    await run.watcher.pollNow()
    expect(run.found).toHaveLength(1)
    // 定时那一下也是同一件事，看完接着排下一次。
    fs.appendFileSync(file, `${turnFailedLine(lineOneUrl, now + 1)}\n`)
    run.fire(30_000)
    await run.watcher.flush()
    expect(run.found).toHaveLength(2)
    expect(run.scheduled.filter((entry) => entry.delayMs === 30_000)).toHaveLength(1)
    run.watcher.dispose()
  })

  it('keeps reading after a listener throws', async () => {
    const run = watcherHarness({ onPayloadTooLarge: () => { throw new Error('listener failed') } })
    run.watcher.start()
    const file = run.filePath(sessionA)
    fs.writeFileSync(file, `${turnFailedLine(lineOneUrl)}\n${turnFailedLine(lineOneUrl, now + 1)}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found).toHaveLength(2)
    run.watcher.dispose()
  })

  it('tries again a minute later when the sessions directory cannot be watched yet, and stops everything once disposed', async () => {
    const run = watcherHarness()
    run.watchFails.current = true
    run.watcher.start()
    expect(run.logs).toEqual([])
    run.watchFails.current = false
    run.fire(60_000)
    expect(run.logs).toEqual(['codex-payload.watch-started'])

    fs.writeFileSync(run.filePath(sessionA), `${turnFailedLine(lineOneUrl)}\n`)
    run.watcher.dispose()
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found).toEqual([])
    expect(run.scheduled).toEqual([])
  })

  it('picks up a refusal written just before the watch started, once', async () => {
    const run = watcherHarness()
    writeRollout(run.filePath(sessionA), `${otherLine()}\n${turnFailedLine(lineOneUrl)}\n`, now - minuteMs)
    run.watcher.start()
    await run.watcher.flush()
    expect(run.found).toEqual([{ sessionId: sessionA, url: lineOneUrl, at: now, rolloutBytes: fs.statSync(run.filePath(sessionA)).size }])
    await run.watcher.pollNow()
    await run.watcher.flush()
    expect(run.found).toHaveLength(1)
    run.watcher.dispose()
  })

  it('picks up a refusal written while the sessions directory could not be watched yet', async () => {
    const run = watcherHarness()
    run.watchFails.current = true
    run.watcher.start()
    // 头一回用 Codex：目录这一分钟里才有，413 那一行写完以后再没动过，不会再有目录通知。
    writeRollout(run.filePath(sessionA), `${turnFailedLine(lineOneUrl)}\n`, now)
    run.watchFails.current = false
    run.fire(60_000)
    await run.watcher.flush()
    expect(run.found.map((event) => event.sessionId)).toEqual([sessionA])
    run.watcher.dispose()
  })

  it('picks up what was written while the watch was broken without reporting anything twice', async () => {
    const run = watcherHarness()
    run.watcher.start()
    const file = run.filePath(sessionA)
    fs.writeFileSync(file, `${turnFailedLine(lineOneUrl)}\n`)
    run.touch(run.relative(sessionA))
    await run.watcher.flush()
    expect(run.found).toHaveLength(1)

    run.breakWatch()
    fs.appendFileSync(file, `${turnFailedLine(lineOneUrl, now + 1)}\n`)
    fs.utimesSync(file, new Date(now), new Date(now))
    writeRollout(run.filePath(sessionB), `${turnFailedLine(lineOneUrl, now + 2)}\n`, now)
    run.fire(60_000)
    await run.watcher.flush()
    expect(run.found.map((event) => [event.sessionId, event.at]).sort()).toEqual([
      [sessionA, now], [sessionA, now + 1], [sessionB, now + 2],
    ])
    run.watcher.dispose()
  })

  it('only looks back at a few records written in the last minutes in recent day folders', async () => {
    const run = watcherHarness()
    writeRollout(run.filePath(sessionB), `${turnFailedLine(lineOneUrl)}\n`, now - codexPayloadStaleMs - minuteMs)
    const recent = Array.from({ length: catchUpMaxFiles + 2 }, (_, index) => numberedSession(index))
    recent.forEach((sessionId, index) => writeRollout(run.filePath(sessionId), `${turnFailedLine(lineOneUrl)}\n`, now - index * 1_000))
    run.watcher.start()
    await run.watcher.flush()
    expect(run.found.map((event) => event.sessionId).sort()).toEqual(recent.slice(0, catchUpMaxFiles).sort())
    run.watcher.dispose()

    // 新开的对话一天一个文件夹，31 个以前的文件夹不再翻，哪怕里面的记录刚写过。
    const older = watcherHarness()
    writeRollout(older.filePath(sessionA), `${turnFailedLine(lineOneUrl)}\n`, now)
    for (let day = 1; day <= 31; day++) fs.mkdirSync(path.join(older.sessionsDirectory, '2026', '11', String(day).padStart(2, '0')), { recursive: true })
    expect(await findRecentCodexRollouts(older.sessionsDirectory, now)).toEqual([])
    fs.rmdirSync(path.join(older.sessionsDirectory, '2026', '11', '01'))
    expect(await findRecentCodexRollouts(older.sessionsDirectory, now)).toEqual([older.relative(sessionA)])
  })

  it('finds nothing when the sessions directory is missing and skips names that are not Codex date folders or rollouts', async () => {
    const root = temporaryDirectory()
    expect(await findRecentCodexRollouts(path.join(root, 'missing'), now)).toEqual([])
    const sessionsDirectory = path.join(root, 'sessions')
    for (const relative of [path.join('notes', '10', '28'), path.join('2026', 'oct', '28'), path.join('2026', '10', 'today')]) {
      fs.mkdirSync(path.join(sessionsDirectory, relative), { recursive: true })
      writeRollout(path.join(sessionsDirectory, relative, rolloutName(sessionA)), `${turnFailedLine(lineOneUrl)}\n`, now)
    }
    fs.mkdirSync(path.join(sessionsDirectory, '2026', '10', '28'), { recursive: true })
    writeRollout(path.join(sessionsDirectory, '2026', '10', '28', 'notes.jsonl'), `${turnFailedLine(lineOneUrl)}\n`, now)
    expect(await findRecentCodexRollouts(sessionsDirectory, now)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('never follows a symlinked date folder or rollout while looking back', async () => {
    const run = watcherHarness()
    const elsewhere = path.join(path.dirname(run.sessionsDirectory), 'elsewhere')
    fs.mkdirSync(path.join(elsewhere, '11', '01'), { recursive: true })
    writeRollout(path.join(elsewhere, '11', '01', rolloutName(sessionA)), `${turnFailedLine(lineOneUrl)}\n`, now)
    fs.symlinkSync(path.join(elsewhere, '11'), path.join(run.sessionsDirectory, '2026', '11'))
    const target = path.join(elsewhere, 'target.jsonl')
    writeRollout(target, `${turnFailedLine(lineOneUrl)}\n`, now)
    fs.symlinkSync(target, run.filePath(sessionB))
    run.watcher.start()
    await run.watcher.flush()
    expect(run.found).toEqual([])
    run.watcher.dispose()
  })
})

function writeRollout(file: string, content: string, modifiedAt: number): void {
  fs.writeFileSync(file, content)
  fs.utimesSync(file, new Date(modifiedAt), new Date(modifiedAt))
}

function numberedSession(index: number): string {
  return `00000000-0000-4000-8000-0000000001${index.toString(16).padStart(2, '0')}`
}

interface ServiceHarness {
  service: ReturnType<typeof createCodexPayloadLimitService>
  dependencies: CodexPayloadLimitDependencies
  notices: CodexPayloadNoticeKind[]
  writes: CodexPayloadState[]
  logs: Array<{ event: string; detail: Record<string, unknown> }>
  holdDirect: ReturnType<typeof vi.fn>
  followCodex: ReturnType<typeof vi.fn>
  clock: { current: number }
}

function serviceHarness(overrides: Partial<CodexPayloadLimitDependencies> & { hold?: RelayRouteHoldResult; followed?: boolean } = {}): ServiceHarness {
  const notices: CodexPayloadNoticeKind[] = []
  const writes: CodexPayloadState[] = []
  const logs: Array<{ event: string; detail: Record<string, unknown> }> = []
  const clock = { current: now }
  const holdDirect = vi.fn(async () => overrides.hold ?? 'switched')
  const followCodex = vi.fn(async () => overrides.followed ?? true)
  const dependencies: CodexPayloadLimitDependencies = {
    activeSiteId: () => 'solov',
    preference: () => 'auto',
    toolLine: () => 'primary',
    codexOnRelay: () => true,
    holdDirect,
    followCodex,
    notify: (kind) => { notices.push(kind) },
    readState: () => null,
    writeState: async (state) => { writes.push(state) },
    now: () => clock.current,
    log: (_level, event, _message, detail) => { logs.push({ event, detail }) },
    ...overrides,
  }
  return { service: createCodexPayloadLimitService(dependencies), dependencies, notices, writes, logs, holdDirect, followCodex, clock }
}

function refused(url: string, sessionId = sessionA, at = now): CodexPayloadTooLargeEvent {
  return { sessionId, url, at, rolloutBytes: 120 * 1024 * 1024 }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve))
}

describe('codex payload limit service', () => {
  it('moves a line 1 conversation to line 2, lets Codex follow, and logs the session without the address', async () => {
    const run = serviceHarness()
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.holdDirect).toHaveBeenCalledWith('solov', 'payload-too-large')
    expect(run.followCodex).toHaveBeenCalledWith('solov', 'switched')
    // 换成了：提示重开由 Codex 配置跟过去的那一步出。
    expect(run.notices).toEqual([])
    expect(run.logs).toEqual([{
      event: 'relay.route.payload-too-large',
      detail: { sessionId: sessionA, siteId: 'solov', from: 'primary', to: 'direct', action: 'switched', rolloutBytes: 120 * 1024 * 1024 },
    }])
    expect(JSON.stringify(run.logs)).not.toContain('solov.cc')
    await settle()
    expect(run.writes.at(-1)).toEqual({ handled: { [sessionA]: now }, handledDirect: {}, warned: {} })
  })

  it('handles each conversation once, also after a restart and when two reports arrive together', async () => {
    const run = serviceHarness()
    await Promise.all([run.service.payloadTooLarge(refused(lineOneUrl)), run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + 1))])
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + 2))
    expect(run.holdDirect).toHaveBeenCalledTimes(1)
    await settle()

    const saved = run.writes.at(-1) ?? null
    const restarted = serviceHarness({ readState: () => saved, preference: () => 'primary' })
    await restarted.service.payloadTooLarge(refused(lineOneUrl))
    expect(restarted.notices).toEqual([])
    await restarted.service.payloadTooLarge(refused(lineOneUrl, sessionB))
    expect(restarted.notices).toEqual(['locked'])
  })

  it('only asks for a new conversation when the line is locked to line 1', async () => {
    const run = serviceHarness({ preference: () => 'primary' })
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.holdDirect).not.toHaveBeenCalled()
    expect(run.followCodex).not.toHaveBeenCalled()
    expect(run.notices).toEqual(['locked'])
    expect(run.logs[0].detail).toMatchObject({ from: 'primary', to: null, action: 'locked' })

    const fixed = serviceHarness({ hold: 'fixed' })
    await fixed.service.payloadTooLarge(refused(lineOneUrl))
    expect(fixed.notices).toEqual(['locked'])
  })

  it('only asks for a new conversation when line 2 does not answer', async () => {
    const run = serviceHarness({ hold: 'unreachable' })
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.followCodex).not.toHaveBeenCalled()
    expect(run.notices).toEqual(['unreachable'])
    expect(run.logs[0].detail).toMatchObject({ action: 'unreachable', to: null })
  })

  // R29-02：线路 2 一时没查通、Codex 的配置一时没跟过去，以前记成处理过，这个对话以后再报都不管了。
  it('tries a conversation again a while after line 2 did not answer, and moves it once line 2 is back', async () => {
    const holdDirect = vi.fn<CodexPayloadLimitDependencies['holdDirect']>()
      .mockResolvedValueOnce('unreachable')
      .mockResolvedValue('switched')
    const run = serviceHarness({ holdDirect })
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.notices).toEqual(['unreachable'])
    // 客户接着发：一会儿以内不再查线路、不再提示。
    run.clock.current = now + minuteMs
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + minuteMs))
    expect(holdDirect).toHaveBeenCalledTimes(1)

    run.clock.current = now + codexPayloadRetryMs
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + codexPayloadRetryMs))
    expect(holdDirect).toHaveBeenCalledTimes(2)
    expect(run.followCodex).toHaveBeenCalledWith('solov', 'switched')
    expect(run.notices).toEqual(['unreachable'])
    expect(run.logs.map((entry) => entry.detail.action)).toEqual(['unreachable', 'switched'])
    // 换成了就算处理过。
    run.clock.current = now + 2 * codexPayloadRetryMs
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + 2 * codexPayloadRetryMs))
    expect(holdDirect).toHaveBeenCalledTimes(2)
    await settle()
    expect(run.writes.at(-1)?.handled).toEqual({ [sessionA]: now + codexPayloadRetryMs })
  })

  it('tries again after Codex could not follow to line 2, and reminds again when line 2 still does not answer', async () => {
    const followCodex = vi.fn<CodexPayloadLimitDependencies['followCodex']>()
      .mockRejectedValueOnce(new Error('config busy'))
      .mockResolvedValue(true)
    const run = serviceHarness({ followCodex })
    await run.service.payloadTooLarge(refused(lineOneUrl))
    run.clock.current = now + codexPayloadRetryMs
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + codexPayloadRetryMs))
    expect(followCodex).toHaveBeenCalledTimes(2)
    expect(run.notices).toEqual(['unfollowed'])

    const down = serviceHarness({ hold: 'unreachable' })
    await down.service.payloadTooLarge(refused(lineOneUrl))
    down.clock.current = now + codexPayloadRetryMs
    await down.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + codexPayloadRetryMs))
    expect(down.notices).toEqual(['unreachable', 'unreachable'])
  })

  it('does not remember a conversation that could not be moved, so a restart tries it again, and never calls it nearly full', async () => {
    const run = serviceHarness({ hold: 'unreachable' })
    await Promise.all([run.service.payloadTooLarge(refused(lineOneUrl)), run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + 1))])
    expect(run.holdDirect).toHaveBeenCalledTimes(1)
    await settle()
    expect(run.writes.at(-1)).toEqual({ handled: {}, handledDirect: {}, warned: {} })
    // 已经超过线路 1 的上限了：过了重试的那一阵也不说「快到了」。
    run.clock.current = now + 2 * codexPayloadRetryMs
    run.service.largeSession({ sessionId: sessionA, rolloutBytes: codexPayloadNearingBytes })
    expect(run.notices).toEqual(['unreachable'])

    const saved = run.writes.at(-1) ?? null
    const restarted = serviceHarness({ readState: () => saved })
    await restarted.service.payloadTooLarge(refused(lineOneUrl))
    expect(restarted.holdDirect).toHaveBeenCalledTimes(1)
  })

  it('asks for a new conversation when Codex could not be moved to line 2', async () => {
    const run = serviceHarness({ followed: false })
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.notices).toEqual(['unfollowed'])
    const failing = serviceHarness({ followCodex: async () => { throw new Error('config busy') } })
    await failing.service.payloadTooLarge(refused(lineOneUrl))
    expect(failing.notices).toEqual(['unfollowed'])
  })

  it('asks Codex to follow without switching when the site is already on line 2', async () => {
    const pinned = serviceHarness({ preference: () => 'direct' })
    await pinned.service.payloadTooLarge(refused(lineOneUrl))
    expect(pinned.holdDirect).not.toHaveBeenCalled()
    expect(pinned.followCodex).toHaveBeenCalledWith('solov', 'already')
    expect(pinned.notices).toEqual([])
    expect(pinned.logs[0].detail).toMatchObject({ action: 'already', to: 'direct' })

    const moved = serviceHarness({ hold: 'already' })
    await moved.service.payloadTooLarge(refused(lineOneUrl))
    expect(moved.followCodex).toHaveBeenCalledWith('solov', 'already')
  })

  it('only asks for a new conversation when it is too large for line 2 as well', async () => {
    const run = serviceHarness()
    await run.service.payloadTooLarge(refused(lineTwoUrl))
    expect(run.holdDirect).not.toHaveBeenCalled()
    expect(run.notices).toEqual(['too-large'])
    expect(run.logs[0].detail).toMatchObject({ siteId: 'solov', from: 'direct', to: null, action: 'too-large' })
  })

  // R29-02：以前一个会话只记一次，线路 1 上换过线的对话到了线路 2 再超就不吭声。
  it('still asks for a new conversation when a conversation moved off line 1 is too large for line 2 too, also after a restart', async () => {
    const run = serviceHarness()
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.followCodex).toHaveBeenCalledWith('solov', 'switched')
    await run.service.payloadTooLarge(refused(lineTwoUrl, sessionA, now + 1))
    await run.service.payloadTooLarge(refused(lineTwoUrl, sessionA, now + 2))
    expect(run.notices).toEqual(['too-large'])
    expect(run.holdDirect).toHaveBeenCalledTimes(1)
    expect(run.logs.map((entry) => entry.detail.action)).toEqual(['switched', 'too-large'])
    await settle()
    expect(run.writes.at(-1)).toEqual({ handled: { [sessionA]: now }, handledDirect: { [sessionA]: now }, warned: {} })

    const lineOneOnly = { handled: { [sessionA]: now }, handledDirect: {}, warned: {} }
    const restarted = serviceHarness({ readState: () => lineOneOnly })
    await restarted.service.payloadTooLarge(refused(lineOneUrl))
    expect(restarted.holdDirect).not.toHaveBeenCalled()
    await restarted.service.payloadTooLarge(refused(lineTwoUrl))
    expect(restarted.notices).toEqual(['too-large'])
  })

  it('leaves a conversation alone on line 1 once line 2 has asked for a new one', async () => {
    const run = serviceHarness()
    await run.service.payloadTooLarge(refused(lineTwoUrl))
    // 线路 2 坏了退回线路 1，同一个对话照样发不出去：不再换线、不再提示。
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + 1))
    run.service.largeSession({ sessionId: sessionA, rolloutBytes: codexPayloadNearingBytes })
    expect(run.holdDirect).not.toHaveBeenCalled()
    expect(run.followCodex).not.toHaveBeenCalled()
    expect(run.notices).toEqual(['too-large'])
    // 别的对话照常处理。
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionB))
    expect(run.holdDirect).toHaveBeenCalledTimes(1)
  })

  it('moves the historical account on its own site and leaves other sites and addresses alone', async () => {
    const historical = serviceHarness({ activeSiteId: () => 'solov-api' })
    await historical.service.payloadTooLarge(refused(historicalLineOneUrl))
    expect(historical.holdDirect).toHaveBeenCalledWith('solov-api', 'payload-too-large')
    expect(historical.followCodex).toHaveBeenCalledWith('solov-api', 'switched')

    const run = serviceHarness()
    for (const url of [historicalLineOneUrl, 'https://relay.example/v1/responses', 'http://127.0.0.1:18413/v1/responses', 'not a url']) {
      await run.service.payloadTooLarge(refused(url))
    }
    expect(run.holdDirect).not.toHaveBeenCalled()
    expect(run.notices).toEqual([])
    expect(run.logs).toEqual([])
    // 没管的不记成处理过：换回这个站的地址照样处理。
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.holdDirect).toHaveBeenCalledTimes(1)
  })

  it('ignores a refusal written long before or after now', async () => {
    const run = serviceHarness()
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now - codexPayloadStaleMs - 1))
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now + codexPayloadStaleMs + 1))
    expect(run.holdDirect).not.toHaveBeenCalled()
    await run.service.payloadTooLarge(refused(lineOneUrl, sessionA, now - codexPayloadStaleMs + 1))
    expect(run.holdDirect).toHaveBeenCalledTimes(1)
  })

  it('keeps working when the record cannot be read or stored', async () => {
    const run = serviceHarness({
      readState: () => { throw new Error('damaged') },
      writeState: async () => { throw new Error('disk full') },
    })
    await run.service.payloadTooLarge(refused(lineOneUrl))
    await settle()
    expect(run.logs.map((entry) => entry.event).sort()).toEqual(['codex-payload.persist-failed', 'relay.route.payload-too-large'])
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.holdDirect).toHaveBeenCalledTimes(1)
  })

  it('remembers at most 64 conversations for 30 days', async () => {
    const handled: Record<string, number> = {}
    for (let index = 0; index < 64; index++) handled[`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`] = now - dayMs + index
    handled['00000000-0000-4000-8000-0000000000ff'] = now - 31 * dayMs
    const run = serviceHarness({ readState: () => ({ handled, handledDirect: {}, warned: {} }) })
    await run.service.payloadTooLarge(refused(lineOneUrl))
    await settle()
    const kept = run.writes.at(-1)?.handled ?? {}
    expect(Object.keys(kept)).toHaveLength(64)
    expect(kept[sessionA]).toBe(now)
    expect(kept['00000000-0000-4000-8000-000000000000']).toBeUndefined()
    expect(kept['00000000-0000-4000-8000-0000000000ff']).toBeUndefined()
  })
})

describe('codex payload early warning', () => {
  const big: CodexLargeSessionEvent = { sessionId: sessionA, rolloutBytes: codexPayloadNearingBytes }

  it('warns once per conversation on line 1', async () => {
    const run = serviceHarness()
    run.service.largeSession(big)
    run.service.largeSession({ ...big, rolloutBytes: codexPayloadNearingBytes + 1 })
    expect(run.notices).toEqual(['nearing'])
    expect(run.logs).toEqual([{
      event: 'relay.route.payload-nearing',
      detail: { sessionId: sessionA, siteId: 'solov', line: 'primary', rolloutBytes: codexPayloadNearingBytes },
    }])
    await settle()
    expect(run.writes.at(-1)).toEqual({ handled: {}, handledDirect: {}, warned: { [sessionA]: now } })
    // 提醒过的对话真发不出去了照样处理。
    await run.service.payloadTooLarge(refused(lineOneUrl))
    expect(run.holdDirect).toHaveBeenCalledTimes(1)
  })

  it('stays quiet off line 1, off the account, when turned off, below the size or once handled', async () => {
    const cases: Array<Partial<CodexPayloadLimitDependencies>> = [
      { toolLine: () => 'direct' },
      { codexOnRelay: () => false },
      { warnNearing: false },
      { activeSiteId: () => 'other-site' },
    ]
    for (const overrides of cases) {
      const run = serviceHarness(overrides)
      run.service.largeSession(big)
      expect(run.notices).toEqual([])
    }
    const small = serviceHarness()
    small.service.largeSession({ ...big, rolloutBytes: codexPayloadNearingBytes - 1 })
    expect(small.notices).toEqual([])
    const handled = serviceHarness({ preference: () => 'primary' })
    await handled.service.payloadTooLarge(refused(lineOneUrl))
    handled.service.largeSession(big)
    expect(handled.notices).toEqual(['locked'])
  })
})

describe('codex payload state store', () => {
  it('round-trips the handled and warned conversations', async () => {
    const filePath = path.join(temporaryDirectory(), 'codex-payload-sessions.json')
    const store = createCodexPayloadStateStore(filePath)
    expect(store.readState()).toBeNull()
    const state: CodexPayloadState = { handled: { [sessionA]: now }, handledDirect: { [sessionA]: now + 1 }, warned: { [sessionB]: now - 1 } }
    await store.writeState(state)
    expect(createCodexPayloadStateStore(filePath).readState()).toEqual(state)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1, ...state })
  })

  it('still fits all three lists when each is full', async () => {
    const full: Record<string, number> = {}
    for (let index = 0; index < 64; index++) full[`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`] = now + index
    const state: CodexPayloadState = { handled: { ...full }, handledDirect: { ...full }, warned: { ...full } }
    const filePath = path.join(temporaryDirectory(), 'codex-payload-sessions.json')
    await createCodexPayloadStateStore(filePath).writeState(state)
    expect(createCodexPayloadStateStore(filePath).readState()).toEqual(state)
  })

  it('drops what it does not recognize and treats a damaged or oversized file as missing', () => {
    expect(parseCodexPayloadState(JSON.stringify({
      version: 1,
      handled: { [sessionA]: now, '../../etc': now, [sessionB]: -1, 'NOT-A-SESSION': now },
      warned: { [sessionB]: 1.5, [sessionA]: '2026-10-28' },
    }))).toEqual({ handled: { [sessionA]: now }, handledDirect: {}, warned: {} })
    // 以前存下的记录没有 handledDirect。
    expect(parseCodexPayloadState(JSON.stringify({ version: 1, handled: { [sessionA]: now }, warned: {} })))
      .toEqual({ handled: { [sessionA]: now }, handledDirect: {}, warned: {} })
    expect(parseCodexPayloadState(JSON.stringify({ version: 1 }))).toEqual({ handled: {}, handledDirect: {}, warned: {} })
    for (const text of ['', '{', 'null', '[]', JSON.stringify({ version: 2, handled: {} })]) expect(parseCodexPayloadState(text)).toBeNull()

    const filePath = path.join(temporaryDirectory(), 'codex-payload-sessions.json')
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, handled: { [sessionA]: now }, padding: 'x'.repeat(17 * 1024) }))
    expect(createCodexPayloadStateStore(filePath).readState()).toBeNull()
    expect(() => createCodexPayloadStateStore('codex-payload-sessions.json')).toThrow('Codex 对话大小记录必须使用绝对路径。')
  })
})

describe('codex payload notice board', () => {
  it('keeps the latest notice for half an hour with an id that never repeats', () => {
    const clock = { current: now }
    const board = createCodexPayloadNoticeBoard(() => clock.current)
    expect(board.current()).toBeUndefined()
    const first = board.show('locked')
    const second = board.show('too-large')
    expect(first).toEqual({ id: now, kind: 'locked' })
    expect(second).toEqual({ id: now + 1, kind: 'too-large' })
    expect(board.current()).toEqual(second)
    clock.current = now + codexPayloadNoticeTtlMs
    expect(board.current()).toBeUndefined()
    // 钟被往回拨过：当它过期了，不一直挂着。
    clock.current = now - minuteMs
    expect(board.current()).toBeUndefined()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAILURE_QUIET_MS,
  LONG_TURN_MS,
  WAITING_QUIET_MS,
  createCliHookEventMonitor,
  createCliTurnTracker,
  parseCliHookEvent,
  type CliHookEvent,
} from './cli-hook-events'
import type { TerminalNotice } from './platform/notifications'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-events-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true })
  }
})

function event(partial: Partial<CliHookEvent>): CliHookEvent {
  return { tool: 'claude', event: 'started', session: 's', at: 1_000_000, ...partial }
}

describe('parseCliHookEvent', () => {
  it('rebuilds a record from the allowed fields only', () => {
    const parsed = parseCliHookEvent(JSON.stringify({ version: 1, tool: 'claude', event: 'failed', reason: 'auth', session: 'a', at: 5, message: 'ignored' }))
    expect(parsed).toEqual({ tool: 'claude', event: 'failed', reason: 'auth', session: 'a', at: 5 })
  })

  it('keeps the start time a Codex finished record carries', () => {
    expect(parseCliHookEvent(JSON.stringify({ version: 1, tool: 'codex', event: 'finished', session: 't', at: 90, startedAt: 30 })))
      .toEqual({ tool: 'codex', event: 'finished', session: 't', at: 90, startedAt: 30 })
    expect(parseCliHookEvent(JSON.stringify({ version: 1, tool: 'codex', event: 'finished', session: 't', at: 90 })))
      .toEqual({ tool: 'codex', event: 'finished', session: 't', at: 90 })
  })

  it('rejects anything outside the fixed vocabulary', () => {
    for (const value of [
      'nope',
      '[]',
      { version: 2, tool: 'claude', event: 'finished', session: '', at: 1 },
      { version: 1, tool: 'grok', event: 'finished', session: '', at: 1 },
      { version: 1, tool: 'codex', event: 'failed', reason: 'auth', session: '', at: 1 },
      { version: 1, tool: 'codex', event: 'waiting', session: '', at: 1 },
      { version: 1, tool: 'claude', event: 'finished', session: '', at: 10, startedAt: 11 },
      { version: 1, tool: 'claude', event: 'finished', session: '', at: 10, startedAt: '1' },
      { version: 1, tool: 'claude', event: 'exploded', session: '', at: 1 },
      { version: 1, tool: 'claude', event: 'failed', reason: '<b>free money</b>', session: '', at: 1 },
      { version: 1, tool: 'claude', event: 'finished', session: '../../x', at: 1 },
      { version: 1, tool: 'claude', event: 'finished', session: '', at: -1 },
    ]) {
      expect(parseCliHookEvent(typeof value === 'string' ? value : JSON.stringify(value))).toBeNull()
    }
  })
})

describe('createCliTurnTracker', () => {
  it('only reports a finished turn that ran for at least a minute', () => {
    const tracker = createCliTurnTracker()
    expect(tracker.observe(event({ event: 'started', at: 0 }))).toBeNull()
    expect(tracker.observe(event({ event: 'finished', at: LONG_TURN_MS - 1 }))).toBeNull()
    tracker.observe(event({ event: 'started', at: 100_000 }))
    expect(tracker.observe(event({ event: 'finished', at: 100_000 + LONG_TURN_MS }))).toEqual({ tool: 'claude', event: 'finished' })
    // 没有配对的「开始」（钩子是这一轮中途才写进去的）不算。
    expect(tracker.observe(event({ event: 'finished', at: 999_999_999 }))).toBeNull()
    expect(tracker.observe(event({ event: 'finished', session: '', at: 999_999_999 }))).toBeNull()
  })

  it('keeps sessions and tools apart', () => {
    const tracker = createCliTurnTracker()
    tracker.observe(event({ event: 'started', session: 'a', at: 0 }))
    tracker.observe(event({ event: 'started', session: 'b', at: LONG_TURN_MS }))
    expect(tracker.observe(event({ event: 'finished', session: 'b', at: LONG_TURN_MS + 10 }))).toBeNull()
    expect(tracker.observe(event({ tool: 'gemini', event: 'finished', session: 'a', at: LONG_TURN_MS * 2 }))).toBeNull()
    expect(tracker.observe(event({ event: 'finished', session: 'a', at: LONG_TURN_MS * 2 }))).toEqual({ tool: 'claude', event: 'finished' })
  })

  it('says the same failure reason at most once per half hour', () => {
    const tracker = createCliTurnTracker()
    const failed = (at: number, reason: 'billing' | 'auth' = 'billing') => tracker.observe(event({ event: 'failed', reason, at }))
    expect(failed(0)).toEqual({ tool: 'claude', event: 'failed', reason: 'billing' })
    expect(failed(FAILURE_QUIET_MS - 1)).toBeNull()
    expect(failed(10, 'auth')).toEqual({ tool: 'claude', event: 'failed', reason: 'auth' })
    expect(failed(FAILURE_QUIET_MS)).toEqual({ tool: 'claude', event: 'failed', reason: 'billing' })
  })

  it('reminds about a waiting tool at most once every two minutes', () => {
    const tracker = createCliTurnTracker()
    expect(tracker.observe(event({ event: 'waiting', at: 0 }))).toEqual({ tool: 'claude', event: 'waiting' })
    expect(tracker.observe(event({ event: 'waiting', at: WAITING_QUIET_MS - 1 }))).toBeNull()
    expect(tracker.observe(event({ tool: 'gemini', event: 'waiting', at: 1 }))).toEqual({ tool: 'gemini', event: 'waiting' })
    expect(tracker.observe(event({ event: 'waiting', at: WAITING_QUIET_MS }))).toEqual({ tool: 'claude', event: 'waiting' })
  })

  it('measures a Codex turn from the start time it carries', () => {
    const tracker = createCliTurnTracker()
    expect(tracker.observe(event({ tool: 'codex', event: 'finished', startedAt: 0, at: LONG_TURN_MS - 1 }))).toBeNull()
    expect(tracker.observe(event({ tool: 'codex', event: 'finished', startedAt: 0, at: LONG_TURN_MS }))).toEqual({ tool: 'codex', event: 'finished' })
    expect(tracker.observe(event({ tool: 'codex', event: 'finished', at: LONG_TURN_MS * 5 }))).toBeNull()
  })

  it('does not call a failed turn finished afterwards', () => {
    const tracker = createCliTurnTracker()
    tracker.observe(event({ event: 'started', at: 0 }))
    tracker.observe(event({ event: 'failed', reason: 'busy', at: LONG_TURN_MS }))
    expect(tracker.observe(event({ event: 'finished', at: LONG_TURN_MS * 2 }))).toBeNull()
  })
})

describe('createCliHookEventMonitor', () => {
  function write(directory: string, at: number, record: Record<string, unknown>, suffix = 'json'): string {
    const name = `${at}-42-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}.${suffix}`
    fs.writeFileSync(path.join(directory, name), JSON.stringify(record))
    return name
  }

  function setup(now: number) {
    const directory = path.join(temporaryDirectory(), 'cli-events')
    const notices: Array<{ notice: TerminalNotice, key: string }> = []
    const monitor = createCliHookEventMonitor({
      directory,
      now: () => now,
      notify: (notice, key) => { notices.push({ notice, key }) },
      watch: () => ({ close: vi.fn() }),
    })
    monitor.start()
    return { directory, notices, monitor }
  }

  it('creates the directory, turns records into notices in time order and deletes what it read', () => {
    const now = 10_000_000
    const { directory, notices, monitor } = setup(now)
    write(directory, now - 1_000, { version: 1, tool: 'claude', event: 'finished', session: 's', at: now - 1_000 })
    write(directory, now - 1_000 - LONG_TURN_MS, { version: 1, tool: 'claude', event: 'started', session: 's', at: now - 1_000 - LONG_TURN_MS })
    write(directory, now - 500, { version: 1, tool: 'gemini', event: 'failed', reason: 'auth', session: '', at: now - 500 })
    monitor.sweep()
    expect(notices.map(({ notice }) => notice)).toEqual([
      { tool: 'claude', event: 'finished' },
      { tool: 'gemini', event: 'failed', reason: 'auth' },
    ])
    expect(new Set(notices.map(({ key }) => key)).size).toBe(2)
    expect(fs.readdirSync(directory)).toEqual([])
    monitor.dispose()
  })

  it('drops stale, oversized and linked records without notifying', () => {
    const now = 50_000_000
    const { directory, notices, monitor } = setup(now)
    write(directory, now - 11 * 60_000, { version: 1, tool: 'claude', event: 'failed', reason: 'billing', session: '', at: now - 11 * 60_000 })
    const big = `${now}-1-aaaaaaaa.json`
    fs.writeFileSync(path.join(directory, big), JSON.stringify({ version: 1, tool: 'claude', event: 'failed', reason: 'busy', session: '', at: now, pad: 'x'.repeat(8192) }))
    const outside = path.join(temporaryDirectory(), 'outside.json')
    fs.writeFileSync(outside, JSON.stringify({ version: 1, tool: 'claude', event: 'failed', reason: 'model', session: '', at: now }))
    if (process.platform !== 'win32') fs.symlinkSync(outside, path.join(directory, `${now}-2-bbbbbbbb.json`))
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'not ours')
    monitor.sweep()
    expect(notices).toEqual([])
    expect(fs.readdirSync(directory)).toEqual(['notes.txt'])
    expect(fs.existsSync(outside)).toBe(true)
    monitor.dispose()
  })

  it('leaves a fresh half-written file for the next sweep and cleans up an old one', () => {
    const now = 90_000_000
    const { directory, monitor } = setup(now)
    const fresh = write(directory, now, {}, 'tmp')
    const old = write(directory, now - 5 * 60_000, {}, 'tmp')
    const stale = new Date(now - 5 * 60_000)
    fs.utimesSync(path.join(directory, old), stale, stale)
    fs.utimesSync(path.join(directory, fresh), new Date(now), new Date(now))
    monitor.sweep()
    expect(fs.readdirSync(directory)).toEqual([fresh])
    monitor.dispose()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loginLaunchArgument } from './login-launch'
import {
  buildUnexpectedExitNotice,
  buildUnexpectedExitRelaunchArgs,
  describeUnexpectedExitError,
  parseUnexpectedExitEntries,
  recordUnexpectedExit,
  shouldRelaunchAfterUnexpectedExit,
  takeUnexpectedExitNotice,
  unexpectedExitRecordPath,
  unexpectedExitWindowMs,
  type UnexpectedExitEntry,
} from './unexpected-exit'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function dataDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-unexpected-exit-'))
  roots.push(root)
  return root
}

const minute = 60 * 1_000
const now = Date.UTC(2026, 8, 30, 12, 0, 0)

function entry(at: number, overrides: Partial<UnexpectedExitEntry> = {}): UnexpectedExitEntry {
  return { at, error: 'Error: boom', relaunched: true, notified: false, ...overrides }
}

describe('unexpected exit record', () => {
  it('relaunches only when no relaunch happened within the last ten minutes', () => {
    expect(shouldRelaunchAfterUnexpectedExit([], now)).toBe(true)
    expect(shouldRelaunchAfterUnexpectedExit([entry(now - 5 * minute)], now)).toBe(false)
    expect(shouldRelaunchAfterUnexpectedExit([entry(now - unexpectedExitWindowMs - 1)], now)).toBe(true)
    // A suppressed exit does not count as a relaunch: after a quiet stop and a
    // manual reopen, the next crash may come back once again.
    expect(shouldRelaunchAfterUnexpectedExit([entry(now - minute, { relaunched: false })], now)).toBe(true)
  })

  it('ignores malformed, future and oversized lines instead of failing the launch', () => {
    const content = [
      JSON.stringify(entry(now - minute)),
      'not json',
      JSON.stringify({ ...entry(now - 2 * minute), relaunched: 'yes' }),
      JSON.stringify(entry(now + minute)),
      JSON.stringify(entry(now - 3 * minute, { error: 'x'.repeat(1_000) })),
      JSON.stringify(entry(now - 4 * minute, { notified: true })),
      '',
    ].join('\r\n')
    expect(parseUnexpectedExitEntries(content, now)).toEqual([entry(now - 4 * minute, { notified: true }), entry(now - minute)])
  })

  it('keeps only the first line of the error and redacts keys, accounts and home paths', () => {
    const home = path.join(path.sep, 'home', 'alex')
    const error = new TypeError(`bad sk-abcdefghijklmnopqrstuvwxyz123456 at ${path.join(home, 'x.json')} for a@b.com\nsecond line`)
    const text = describeUnexpectedExitError(error, home)
    expect(text.startsWith('TypeError: bad ')).toBe(true)
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
    expect(text).not.toContain('alex')
    expect(text).not.toContain('a@b.com')
    expect(text).not.toContain('second line')
    expect(describeUnexpectedExitError(new Error('y'.repeat(1_000)), home)).toHaveLength(300)
    expect(describeUnexpectedExitError(undefined, home)).toBe('未知错误')
  })

  it('relaunches the first exit, suppresses a second one within ten minutes, and survives both on disk', () => {
    const recordPath = unexpectedExitRecordPath(dataDirectory())
    expect(recordUnexpectedExit(recordPath, { now: now - 3 * minute, error: 'Error: first' })).toEqual({ relaunch: true })
    // The relaunched process reads the record once and tells the user.
    expect(takeUnexpectedExitNotice(recordPath, now - 2 * minute)).toEqual({
      relaunched: true,
      exits: [{ at: now - 3 * minute, error: 'Error: first' }],
    })
    // Having been told must not reset the loop guard.
    expect(recordUnexpectedExit(recordPath, { now, error: 'Error: second' })).toEqual({ relaunch: false })
    expect(takeUnexpectedExitNotice(recordPath, now + minute)).toEqual({
      relaunched: false,
      exits: [{ at: now - 3 * minute, error: 'Error: first' }, { at: now, error: 'Error: second' }],
    })
    // Told once: the next launch stays silent.
    expect(takeUnexpectedExitNotice(recordPath, now + 2 * minute)).toBeNull()
  })

  it('forgets exits older than ten minutes once they have been shown', () => {
    const recordPath = unexpectedExitRecordPath(dataDirectory())
    recordUnexpectedExit(recordPath, { now, error: 'Error: old' })
    expect(takeUnexpectedExitNotice(recordPath, now + unexpectedExitWindowMs + minute)).not.toBeNull()
    expect(fs.existsSync(recordPath)).toBe(false)
    expect(recordUnexpectedExit(recordPath, { now: now + unexpectedExitWindowMs + 2 * minute, error: 'Error: new' })).toEqual({ relaunch: true })
  })

  it('stays silent and leaves nothing behind when there is no record', () => {
    const recordPath = unexpectedExitRecordPath(dataDirectory())
    expect(takeUnexpectedExitNotice(recordPath, now)).toBeNull()
    expect(fs.existsSync(recordPath)).toBe(false)
  })

  it('bounds the record by rewriting only the most recent entries when it fills up', () => {
    const recordPath = unexpectedExitRecordPath(dataDirectory())
    for (let index = 0; index < 20; index++) {
      recordUnexpectedExit(recordPath, { now: now + index * unexpectedExitWindowMs * 2, error: `Error: ${index}` })
    }
    const entries = parseUnexpectedExitEntries(fs.readFileSync(recordPath, 'utf8'), now + 40 * unexpectedExitWindowMs)
    expect(entries).toHaveLength(8)
    expect(entries[entries.length - 1].error).toBe('Error: 19')
  })

  it('builds the notice from the newest pending exit and lists at most three recent ones', () => {
    expect(buildUnexpectedExitNotice([entry(now, { notified: true })])).toBeNull()
    const notice = buildUnexpectedExitNotice([
      entry(now - 30 * minute, { notified: true }),
      entry(now - 9 * minute, { notified: true }),
      entry(now - 8 * minute, { notified: true }),
      entry(now - 7 * minute, { notified: true }),
      entry(now, { relaunched: false }),
    ])
    expect(notice?.relaunched).toBe(false)
    expect(notice?.exits.map((exit) => exit.at)).toEqual([now - 8 * minute, now - 7 * minute, now])
  })
})

describe('unexpected exit relaunch arguments', () => {
  it('brings the window back when it was open and keeps it in the tray when it was not', () => {
    expect(buildUnexpectedExitRelaunchArgs(['.', loginLaunchArgument], true)).toEqual(['.'])
    expect(buildUnexpectedExitRelaunchArgs(['.'], false)).toEqual(['.', loginLaunchArgument])
    expect(buildUnexpectedExitRelaunchArgs(['.', loginLaunchArgument], false)).toEqual(['.', loginLaunchArgument])
  })
})

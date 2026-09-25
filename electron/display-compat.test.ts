import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDisplayLaunchMode,
  clearDisplayCrashRecord,
  displayCrashRecordPath,
  displayCrashWindowMs,
  hasRepeatedDisplayCrashes,
  inspectDisplayLaunch,
  isDisplayCrash,
  parseDisplayCrashTimes,
  pruneStaleDisplayCrashRecord,
  recordDisplayCrash,
} from './display-compat'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function dataDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-display-compat-'))
  roots.push(root)
  return root
}

const minute = 60 * 1_000
const now = Date.UTC(2026, 8, 25, 12, 0, 0)

describe('display compat', () => {
  it('counts only abnormal exits of the GPU process as display crashes', () => {
    expect(isDisplayCrash({ type: 'GPU', reason: 'crashed' })).toBe(true)
    expect(isDisplayCrash({ type: 'GPU', reason: 'launch-failed' })).toBe(true)
    expect(isDisplayCrash({ type: 'GPU', reason: 'clean-exit' })).toBe(false)
    expect(isDisplayCrash({ type: 'Utility', reason: 'crashed' })).toBe(false)
  })

  it('switches to the compatible display only after two crashes within ten minutes', () => {
    expect(hasRepeatedDisplayCrashes([])).toBe(false)
    expect(hasRepeatedDisplayCrashes([now])).toBe(false)
    expect(hasRepeatedDisplayCrashes([now - displayCrashWindowMs - 1, now])).toBe(false)
    expect(hasRepeatedDisplayCrashes([now, now - displayCrashWindowMs])).toBe(true)
    expect(hasRepeatedDisplayCrashes([now - 60 * minute, now - 30 * minute, now - 29 * minute])).toBe(true)
  })

  it('lets an explicit user opt-out win over the automatic fallback', () => {
    const crashes = [now - minute, now]
    expect(buildDisplayLaunchMode({ hardwareAcceleration: undefined, crashTimes: [] })).toBe('accelerated')
    expect(buildDisplayLaunchMode({ hardwareAcceleration: true, crashTimes: crashes })).toBe('auto-compat')
    expect(buildDisplayLaunchMode({ hardwareAcceleration: false, crashTimes: crashes })).toBe('user-disabled')
    expect(buildDisplayLaunchMode({ hardwareAcceleration: false, crashTimes: [] })).toBe('user-disabled')
  })

  it('ignores malformed and future lines instead of failing the launch', () => {
    expect(parseDisplayCrashTimes(`${now}\r\nabc\n-5\n${now + minute}\n\n${now - minute}\n1.5\n`, now)).toEqual([now - minute, now])
  })

  it('records crashes durably and reads them back on the next launch', () => {
    const directory = dataDirectory()
    const recordPath = displayCrashRecordPath(directory)
    expect(inspectDisplayLaunch({ dataDirectory: directory, hardwareAcceleration: undefined, now })).toEqual({ mode: 'accelerated', recordPath, crashTimes: [] })
    recordDisplayCrash(recordPath, now - 2 * minute)
    expect(inspectDisplayLaunch({ dataDirectory: directory, hardwareAcceleration: undefined, now }).mode).toBe('accelerated')
    recordDisplayCrash(recordPath, now - minute)
    const launch = inspectDisplayLaunch({ dataDirectory: directory, hardwareAcceleration: undefined, now })
    expect(launch.mode).toBe('auto-compat')
    expect(launch.crashTimes).toEqual([now - 2 * minute, now - minute])
  })

  it('creates the data directory when the first crash happens before anything else wrote there', () => {
    const recordPath = displayCrashRecordPath(path.join(dataDirectory(), 'nested'))
    recordDisplayCrash(recordPath, now)
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(`${now}\n`)
  })

  it('stops appending once the record is already far past the threshold', () => {
    const recordPath = displayCrashRecordPath(dataDirectory())
    for (let index = 0; index < 40; index++) recordDisplayCrash(recordPath, now - 40 + index)
    expect(fs.readFileSync(recordPath, 'utf8').trim().split('\n')).toHaveLength(32)
  })

  it('treats an unreadable record as no crashes so the app still opens', () => {
    const directory = dataDirectory()
    fs.mkdirSync(displayCrashRecordPath(directory))
    const launch = inspectDisplayLaunch({ dataDirectory: directory, hardwareAcceleration: undefined, now })
    expect(launch.mode).toBe('accelerated')
    expect(launch.readError).toBeDefined()
  })

  it('drops a record whose crashes are all too old to ever pair with a new one', () => {
    const directory = dataDirectory()
    const recordPath = displayCrashRecordPath(directory)
    recordDisplayCrash(recordPath, now - 3 * displayCrashWindowMs)
    const stale = inspectDisplayLaunch({ dataDirectory: directory, hardwareAcceleration: undefined, now })
    expect(pruneStaleDisplayCrashRecord(stale, now)).toBe(true)
    expect(fs.existsSync(recordPath)).toBe(false)
  })

  it('keeps a record that is recent or still waiting for the user to choose', () => {
    const directory = dataDirectory()
    const recordPath = displayCrashRecordPath(directory)
    recordDisplayCrash(recordPath, now - minute)
    expect(pruneStaleDisplayCrashRecord(inspectDisplayLaunch({ dataDirectory: directory, hardwareAcceleration: undefined, now }), now)).toBe(false)
    recordDisplayCrash(recordPath, now - minute / 2)
    const later = now + 3 * displayCrashWindowMs
    const pending = inspectDisplayLaunch({ dataDirectory: directory, hardwareAcceleration: undefined, now: later })
    expect(pending.mode).toBe('auto-compat')
    expect(pruneStaleDisplayCrashRecord(pending, later)).toBe(false)
    expect(fs.existsSync(recordPath)).toBe(true)
  })

  it('starts counting from zero once the user has made a choice', async () => {
    const directory = dataDirectory()
    const recordPath = displayCrashRecordPath(directory)
    recordDisplayCrash(recordPath, now - minute)
    recordDisplayCrash(recordPath, now)
    await clearDisplayCrashRecord(recordPath)
    await clearDisplayCrashRecord(recordPath)
    expect(inspectDisplayLaunch({ dataDirectory: directory, hardwareAcceleration: undefined, now }).mode).toBe('accelerated')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlowPackageServer, fileOperationInFlight, isFileOperation, slowChunkEveryMs } from './slow-download.test-support'

let directory = ''

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-slow-download-'))
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

// What Node added to its active resources while `start` began one operation. Nothing can run
// between the two readings, so the difference is that operation and nothing else.
function resourcesStartedBy<T>(start: () => Promise<T>): { added: string[]; started: Promise<T> } {
  const before = process.getActiveResourcesInfo()
  const started = start()
  const added = [...process.getActiveResourcesInfo()]
  for (const resource of before) {
    const index = added.indexOf(resource)
    if (index >= 0) added.splice(index, 1)
  }
  return { added, started }
}

function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
}

describe('slow download driver', () => {
  it('recognises every kind of file operation the downloads make while it is in flight', async () => {
    const target = path.join(directory, 'package.exe')
    const opening = resourcesStartedBy(() => fs.promises.open(target, 'wx'))
    expect(opening.added.length).toBeGreaterThan(0)
    expect(opening.added.every(isFileOperation)).toBe(true)
    expect(fileOperationInFlight()).toBe(true)
    const handle = await opening.started

    const writing = resourcesStartedBy(() => handle.write(new Uint8Array(64 * 1024), 0, 64 * 1024, 0))
    expect(writing.added.length).toBeGreaterThan(0)
    expect(writing.added.every(isFileOperation)).toBe(true)
    await writing.started

    const closing = resourcesStartedBy(() => handle.close())
    expect(closing.added.length).toBeGreaterThan(0)
    expect(closing.added.every(isFileOperation)).toBe(true)
    await closing.started

    const checking = resourcesStartedBy(() => new Promise((resolve) => fs.stat(target, resolve)))
    expect(checking.added.length).toBeGreaterThan(0)
    expect(checking.added.every(isFileOperation)).toBe(true)
    await checking.started

    const removing = resourcesStartedBy(() => fs.promises.rm(target, { force: true }))
    expect(removing.added.length).toBeGreaterThan(0)
    expect(removing.added.every(isFileOperation)).toBe(true)
    await removing.started
  })

  // The ceiling flake (quality run 43011123157): file work that outlasted 10,000 event-loop
  // turns used to move the clock 40 seconds at a time while nothing was waiting on it.
  it('never moves the clock while the code under test is on the disk, however many turns that takes', async () => {
    fakeClock()
    const startedAt = Date.now()
    let turns = 0
    let counting = true
    function count(): void {
      turns += 1
      if (counting) setImmediate(count)
    }
    setImmediate(count)
    const busy = (async () => {
      try {
        while (turns < 15_000) await fs.promises.stat(directory)
      } finally {
        counting = false
      }
    })()

    await createSlowPackageServer().drive(busy)

    expect(turns).toBeGreaterThanOrEqual(15_000)
    expect(Date.now() - startedAt).toBe(0)
  })

  it('still moves the clock for code that waits on a fake timer of its own', async () => {
    fakeClock()
    const startedAt = Date.now()

    await createSlowPackageServer().drive(new Promise((resolve) => setTimeout(resolve, 100_000)))

    expect(Date.now() - startedAt).toBe(3 * slowChunkEveryMs)
  })
})

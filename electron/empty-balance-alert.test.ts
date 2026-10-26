import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmptyBalanceRecordStore, pruneEmptyBalanceRecord, resolveEmptyBalanceState } from './empty-balance-alert'

const directories: string[] = []

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-empty-balance-'))
  directories.push(directory)
  return directory
}

function readRecord(directory: string) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'balance-empty-notified.json'), 'utf8')) as Record<string, number>
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('empty balance state', () => {
  it('counts money in the wallet or a usable subscription as funded', () => {
    expect(resolveEmptyBalanceState(0.01, false)).toBe('funded')
    expect(resolveEmptyBalanceState(0.01, null)).toBe('funded')
    expect(resolveEmptyBalanceState(0, true)).toBe('funded')
  })

  it('calls a zero or negative wallet empty only once the subscription is known to be missing', () => {
    expect(resolveEmptyBalanceState(0, false)).toBe('empty')
    expect(resolveEmptyBalanceState(-0.2, false)).toBe('empty')
    // A subscription-only customer's wallet is always zero; wait for the subscription read.
    expect(resolveEmptyBalanceState(0, null)).toBe('unknown')
  })
})

describe('empty balance record', () => {
  it('lets only the first of two simultaneous readings claim the same empty spell', async () => {
    const store = createEmptyBalanceRecordStore(temporaryDirectory())
    const claims = await Promise.all([store.claim('solov:7', 1), store.claim('solov:7', 2)])
    expect(claims.sort()).toEqual([false, true])
    expect(await store.claim('solov:8', 3)).toBe(true)
  })

  it('remembers the claim across restarts until the wallet is funded again', async () => {
    const directory = temporaryDirectory()
    expect(await createEmptyBalanceRecordStore(directory).claim('solov:7', 1)).toBe(true)
    expect(readRecord(directory)).toEqual({ 'solov:7': 1 })

    const restarted = createEmptyBalanceRecordStore(directory)
    expect(await restarted.claim('solov:7', 2)).toBe(false)
    await restarted.release('solov:7')
    expect(readRecord(directory)).toEqual({})
    expect(await createEmptyBalanceRecordStore(directory).claim('solov:7', 3)).toBe(true)
  })

  it('does not touch the disk when a funded account has nothing to release', async () => {
    const directory = temporaryDirectory()
    await createEmptyBalanceRecordStore(directory).release('solov:7')
    expect(fs.existsSync(path.join(directory, 'balance-empty-notified.json'))).toBe(false)
  })

  it('treats a damaged record as empty and keeps working', async () => {
    const directory = temporaryDirectory()
    fs.writeFileSync(path.join(directory, 'balance-empty-notified.json'), '{not json')
    const store = createEmptyBalanceRecordStore(directory)
    expect(await store.claim('solov:7', 1)).toBe(true)
    expect(readRecord(directory)).toEqual({ 'solov:7': 1 })
  })

  it('keeps only well-formed entries and the most recent accounts', () => {
    expect(pruneEmptyBalanceRecord(null)).toEqual({})
    expect(pruneEmptyBalanceRecord([1])).toEqual({})
    expect(pruneEmptyBalanceRecord({ a: 1, b: 'x', c: Number.NaN, [`${'k'.repeat(161)}`]: 2 })).toEqual({ a: 1 })
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`solov:${index}`, index]))
    const kept = pruneEmptyBalanceRecord(many)
    expect(Object.keys(kept)).toHaveLength(32)
    expect(kept['solov:39']).toBe(39)
    expect(kept['solov:7']).toBeUndefined()
  })
})

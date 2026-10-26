import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBalanceAlerts,
  createSpendSpikeRecordStore,
  crossedLowBalance,
  readSpendBaseline,
  type BalanceAlertObservation,
} from './balance-alerts'
import type { NewApiAccountUsageQuery } from './new-api-client'
import { spendSpikeQuietPeriod, type SpendBaseline } from './spend-spike'

const unit = 500_000
const minute = 60_000

function dollars(value: number) {
  return value * unit
}

function alertsFixture(baseline: SpendBaseline = { hourQuota: dollars(10), weekQuota: dollars(10) }) {
  const notify = vi.fn()
  const readBaseline = vi.fn(async () => baseline)
  const notified = new Map<string, number>()
  const alerts = createBalanceAlerts({
    notify,
    readBaseline,
    readNotifiedAt: (account) => notified.get(account) ?? null,
    rememberNotifiedAt: (account, at) => { notified.set(account, at) },
  })
  let at = 1_000_000_000
  async function see(balance: number, overrides: Partial<BalanceAlertObservation> = {}) {
    at += minute
    await alerts.observe({ scope: 'solov:7', userId: 7, quota: dollars(balance), quotaPerUnit: unit, at, supportsUsage: true, subscribed: false, ...overrides })
  }
  return { notify, readBaseline, see, now: () => at }
}

describe('low balance crossing', () => {
  it('only counts a drop from at least five dollars to below five', () => {
    expect(crossedLowBalance(null, 1)).toBe(false)
    expect(crossedLowBalance(5, 4.99)).toBe(true)
    expect(crossedLowBalance(4.99, 1)).toBe(false)
    expect(crossedLowBalance(6, 5)).toBe(false)
  })
})

describe('balance alerts', () => {
  it('notifies once when the same account drops below five dollars', async () => {
    const h = alertsFixture()
    await h.see(6, { supportsUsage: false })
    await h.see(4, { supportsUsage: false })
    await h.see(3, { supportsUsage: false })
    expect(h.notify.mock.calls).toEqual([['balance', `balance:7:${h.now() - minute}`]])
  })

  it('does not call a wallet low while a usable subscription is paying first', async () => {
    const h = alertsFixture()
    await h.see(6, { supportsUsage: false, subscribed: true })
    await h.see(4, { supportsUsage: false, subscribed: true })
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('does not compare one account with the next', async () => {
    const h = alertsFixture()
    await h.see(6, { supportsUsage: false })
    await h.see(4, { scope: 'solov:8', userId: 8, supportsUsage: false })
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('skips a balance without a usable unit and keeps comparing with the last good one', async () => {
    const h = alertsFixture()
    await h.see(6, { supportsUsage: false })
    await h.see(4, { quotaPerUnit: 0, supportsUsage: false })
    expect(h.notify).not.toHaveBeenCalled()
    await h.see(3, { supportsUsage: false })
    expect(h.notify).toHaveBeenCalledOnce()
  })

  it('checks usage and reports a spending spike when the account can read usage', async () => {
    const h = alertsFixture()
    await h.see(100)
    await h.see(90)
    expect(h.readBaseline).toHaveBeenCalledOnce()
    expect(h.notify).toHaveBeenCalledWith('spend', `spend:7:${h.now()}`, { cents: 1000, multiple: null })
  })

  it('never reads usage for an account that cannot', async () => {
    const h = alertsFixture()
    await h.see(100, { supportsUsage: false })
    await h.see(90, { supportsUsage: false })
    expect(h.readBaseline).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
  })
})

describe('spend baseline', () => {
  it('reads the last hour and the last week by timestamp', async () => {
    const getUsage = vi.fn(async (query: NewApiAccountUsageQuery) => ({
      stats: { quota: query.endTimestamp! - query.startTimestamp! === 3600 ? 11 : 22 },
    }))
    const now = new Date('2026-10-26T12:00:00Z')
    expect(await readSpendBaseline({ dateOnly: false, getUsage }, now)).toEqual({ hourQuota: 11, weekQuota: 22 })
    const end = Math.floor(now.getTime() / 1000)
    expect(getUsage.mock.calls).toEqual([
      [{ type: 2, page: 1, pageSize: 1, startTimestamp: end - 3600, endTimestamp: end }],
      [{ type: 2, page: 1, pageSize: 1, startTimestamp: end - 7 * 86400, endTimestamp: end }],
    ])
  })

  it('falls back to a seven day date range for accounts that only query by date', async () => {
    const getUsage = vi.fn(async (_query: NewApiAccountUsageQuery) => ({ stats: { quota: 33 } }))
    const baseline = await readSpendBaseline({ dateOnly: true, getUsage }, new Date('2026-10-26T12:00:00Z'))
    expect(baseline).toEqual({ hourQuota: null, weekQuota: 33 })
    expect(getUsage).toHaveBeenCalledOnce()
    expect(getUsage.mock.calls[0]?.[0]).toMatchObject({ page: 1, pageSize: 1, startDate: expect.any(String), endDate: expect.any(String), timezone: expect.any(String) })
  })
})

describe('spend spike record store', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })
  function tempDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-spend-spike-'))
    directories.push(directory)
    return directory
  }

  it('remembers when each account was told, across a restart', async () => {
    const directory = tempDirectory()
    const at = 1_000_000_000
    const store = createSpendSpikeRecordStore(directory, () => at)
    expect(await store.readNotifiedAt('7')).toBeNull()
    await store.rememberNotifiedAt('7', at)
    expect(await store.readNotifiedAt('7')).toBe(at)
    const reopened = createSpendSpikeRecordStore(directory, () => at + minute)
    expect(await reopened.readNotifiedAt('7')).toBe(at)
  })

  it('drops records whose quiet period is over', async () => {
    const directory = tempDirectory()
    const at = 1_000_000_000
    await createSpendSpikeRecordStore(directory, () => at).rememberNotifiedAt('7', at)
    const later = createSpendSpikeRecordStore(directory, () => at + spendSpikeQuietPeriod)
    expect(await later.readNotifiedAt('7')).toBeNull()
  })

  it('treats an unreadable record as no record', async () => {
    const directory = tempDirectory()
    fs.writeFileSync(path.join(directory, 'spend-spike-notified.json'), '{not json')
    const store = createSpendSpikeRecordStore(directory, () => 1)
    expect(await store.readNotifiedAt('7')).toBeNull()
    await store.rememberNotifiedAt('7', 1)
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'spend-spike-notified.json'), 'utf8'))).toEqual({ 7: 1 })
  })
})

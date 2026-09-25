import { describe, expect, it, vi } from 'vitest'
import {
  createSpendSpikeWatch,
  evaluateSpendSpike,
  recordBalanceSample,
  spendSampleMaxGap,
  spendSpikeQuietPeriod,
  walletSpent,
  type BalanceSample,
  type SpendBaseline,
} from './spend-spike'

const unit = 500_000
const minute = 60_000

function dollars(value: number) {
  return value * unit
}

function watchFixture(baseline: SpendBaseline | (() => Promise<SpendBaseline>)) {
  const notified = new Map<string, number>()
  const notify = vi.fn()
  const readBaseline = vi.fn(typeof baseline === 'function' ? baseline : async () => baseline)
  const watch = createSpendSpikeWatch({
    readBaseline,
    notify,
    readNotifiedAt: (account) => notified.get(account) ?? null,
    rememberNotifiedAt: (account, at) => { notified.set(account, at) },
  })
  let at = 1_000_000_000
  async function see(balance: number, step = minute, scope = 'solov:7') {
    at += step
    await watch.observe({ scope, account: '7', quota: dollars(balance), quotaPerUnit: unit, at })
  }
  return { watch, notify, readBaseline, notified, see, now: () => at }
}

describe('spend spike samples', () => {
  it('keeps only the last hour of successful reads', () => {
    let samples: BalanceSample[] = []
    for (let index = 0; index <= 90; index += 10) samples = recordBalanceSample(samples, { at: index * minute, quota: 100 - index })
    expect(samples.map((sample) => sample.at / minute)).toEqual([30, 40, 50, 60, 70, 80, 90])
  })
  it('starts over when the clock moves backwards and ignores a repeated read', () => {
    const samples = [{ at: 10, quota: 5 }, { at: 20, quota: 4 }]
    expect(recordBalanceSample(samples, { at: 20, quota: 4 })).toEqual(samples)
    expect(recordBalanceSample(samples, { at: 5, quota: 9 })).toEqual([{ at: 5, quota: 9 }])
  })
  it('does not let a top-up cancel what was spent', () => {
    expect(walletSpent([{ at: 0, quota: 100 }, { at: minute, quota: 60 }, { at: 2 * minute, quota: 160 }, { at: 3 * minute, quota: 150 }])).toBe(50)
  })
  it('skips a stretch where reads failed or the computer slept', () => {
    expect(walletSpent([{ at: 0, quota: 100 }, { at: spendSampleMaxGap + 1, quota: 10 }, { at: spendSampleMaxGap + minute, quota: 5 }])).toBe(5)
  })
})

describe('spend spike decision', () => {
  it('needs both more than five dollars and five times the usual hour', () => {
    // 平时一周 $16.80 = 每小时约 $0.10。
    const week = dollars(16.8)
    expect(evaluateSpendSpike({ walletSpent: 0, baseline: { hourQuota: dollars(4.99), weekQuota: week + dollars(4.99) }, quotaPerUnit: unit })).toBeNull()
    expect(evaluateSpendSpike({ walletSpent: 0, baseline: { hourQuota: dollars(12.4), weekQuota: week + dollars(12.4) }, quotaPerUnit: unit }))
      .toEqual({ cents: 1240, multiple: 123 })
    // 平时每小时就花 $2 的人，一小时 $8 不算异常。
    expect(evaluateSpendSpike({ walletSpent: 0, baseline: { hourQuota: dollars(8), weekQuota: dollars(2 * 167 + 8) }, quotaPerUnit: unit })).toBeNull()
    expect(evaluateSpendSpike({ walletSpent: 0, baseline: { hourQuota: dollars(10), weekQuota: dollars(2 * 167 + 10) }, quotaPerUnit: unit }))
      .toEqual({ cents: 1000, multiple: 5 })
  })
  it('trusts the usage records over the wallet so buying a plan is not spending', () => {
    expect(evaluateSpendSpike({ walletSpent: dollars(20), baseline: { hourQuota: dollars(0.3), weekQuota: dollars(3) }, quotaPerUnit: unit })).toBeNull()
  })
  it('falls back to the wallet when the account cannot report a single hour', () => {
    expect(evaluateSpendSpike({ walletSpent: dollars(6), baseline: { hourQuota: null, weekQuota: dollars(6 + 1.67) }, quotaPerUnit: unit }))
      .toEqual({ cents: 600, multiple: 600 })
  })
  it('leaves the multiple out when there is no usual usage to compare with', () => {
    expect(evaluateSpendSpike({ walletSpent: 0, baseline: { hourQuota: dollars(7), weekQuota: dollars(7) }, quotaPerUnit: unit }))
      .toEqual({ cents: 700, multiple: null })
  })
})

describe('spend spike watch', () => {
  it('only reads usage once the wallet has dropped by five dollars within the hour', async () => {
    const h = watchFixture({ hourQuota: dollars(6), weekQuota: dollars(7) })
    await h.see(100)
    await h.see(97)
    expect(h.readBaseline).not.toHaveBeenCalled()
    await h.see(94)
    expect(h.readBaseline).toHaveBeenCalledOnce()
    expect(h.notify).toHaveBeenCalledOnce()
    expect(h.notify.mock.calls[0]![0]).toMatch(/^spend:7:\d+$/)
    expect(h.notify.mock.calls[0]![1]).toEqual({ cents: 600, multiple: 1002 })
  })
  it('stays quiet for six hours on the same account', async () => {
    const h = watchFixture({ hourQuota: dollars(6), weekQuota: dollars(7) })
    await h.see(100)
    await h.see(94)
    for (let index = 0; index < 20; index++) await h.see(94 - (index + 1) * 6, 10 * minute)
    expect(h.notify).toHaveBeenCalledOnce()
    await h.see(0, spendSpikeQuietPeriod)
    await h.see(-10)
    expect(h.notify).toHaveBeenCalledTimes(2)
  })
  it('does not re-read usage every refresh after a check said it was normal', async () => {
    const h = watchFixture({ hourQuota: dollars(6), weekQuota: dollars(6 * 168) })
    await h.see(100)
    for (let index = 1; index <= 10; index++) await h.see(100 - index * 6)
    expect(h.readBaseline).toHaveBeenCalledOnce()
    expect(h.notify).not.toHaveBeenCalled()
    await h.see(30, 10 * minute)
    expect(h.readBaseline).toHaveBeenCalledTimes(2)
  })
  it('gives up quietly when usage cannot be read and tries again later', async () => {
    const h = watchFixture(async () => { throw new Error('offline') })
    await h.see(100)
    await h.see(90)
    await h.see(80)
    expect(h.readBaseline).toHaveBeenCalledOnce()
    expect(h.notify).not.toHaveBeenCalled()
    await h.see(70, 15 * minute)
    expect(h.readBaseline).toHaveBeenCalledTimes(2)
  })
  it('forgets the previous account when the scope changes', async () => {
    const h = watchFixture({ hourQuota: dollars(6), weekQuota: dollars(7) })
    await h.see(100)
    await h.see(50, minute, 'solov:8')
    expect(h.readBaseline).not.toHaveBeenCalled()
  })
  it('drops a result that arrives after the account changed', async () => {
    let release: (value: SpendBaseline) => void = () => undefined
    const h = watchFixture(() => new Promise<SpendBaseline>((resolve) => { release = resolve }))
    await h.see(100)
    const pending = h.see(90)
    await h.see(10, minute, 'solov:8')
    release({ hourQuota: dollars(10), weekQuota: dollars(10) })
    await pending
    expect(h.notify).not.toHaveBeenCalled()
  })
})

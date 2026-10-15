import { describe, expect, it } from 'vitest'
import type { UsableSubscription } from '../../../../electron/subscription-summary'
import { balanceRunwayMeter, balanceRunwayText, buildBalanceRunway } from './balance-runway'

function plan(overrides: Partial<UsableSubscription> = {}): UsableSubscription {
  return { name: '月卡', remainingUsd: 20, endsAt: '2026-11-01T00:00:00Z', expiringSoon: false, lowRemaining: false, subscriptionOnly: false, ...overrides }
}

describe('balance runway', () => {
  it('divides the wallet by the average daily spend of the last seven days', () => {
    expect(buildBalanceRunway({ walletUsd: 30, subscription: null, weekUsageUsd: 14 })).toEqual({ usableUsd: 30, days: 15, low: false })
  })

  it('counts what is left on the subscription on top of the wallet', () => {
    expect(buildBalanceRunway({ walletUsd: 0, subscription: plan({ remainingUsd: 20 }), weekUsageUsd: 7 })?.days).toBe(20)
    expect(buildBalanceRunway({ walletUsd: 4, subscription: plan({ remainingUsd: 6 }), weekUsageUsd: 7 })?.usableUsd).toBe(10)
  })

  it('leaves the wallet out when the account only spends its subscription', () => {
    expect(buildBalanceRunway({ walletUsd: 100, subscription: plan({ remainingUsd: 3, subscriptionOnly: true }), weekUsageUsd: 7 })).toEqual({ usableUsd: 3, days: 3, low: true })
  })

  it('calls it low below seven days, whatever the amount', () => {
    expect(buildBalanceRunway({ walletUsd: 60, subscription: null, weekUsageUsd: 70 })).toMatchObject({ days: 6, low: true })
    expect(buildBalanceRunway({ walletUsd: 3, subscription: null, weekUsageUsd: 0.7 })).toMatchObject({ days: 30, low: false })
  })

  it('falls back to the $5 line when there is no usage to go by', () => {
    expect(buildBalanceRunway({ walletUsd: 4.99, subscription: null, weekUsageUsd: null })).toEqual({ usableUsd: 4.99, days: null, low: true })
    expect(buildBalanceRunway({ walletUsd: 5, subscription: null, weekUsageUsd: 0 })).toEqual({ usableUsd: 5, days: null, low: false })
  })

  it('never calls an unlimited subscription low and gives no day count for it', () => {
    expect(buildBalanceRunway({ walletUsd: 0, subscription: plan({ remainingUsd: null }), weekUsageUsd: 7 })).toEqual({ usableUsd: null, days: null, low: false })
  })

  it('says nothing until the balance has been read', () => {
    expect(buildBalanceRunway({ walletUsd: null, subscription: plan(), weekUsageUsd: 7 })).toBeNull()
    expect(balanceRunwayText(null)).toBeNull()
  })

  it('words the line the way the account card shows it', () => {
    expect(balanceRunwayText({ usableUsd: 30, days: 15, low: false })).toBe('按最近用量，约还能用 15 天')
    expect(balanceRunwayText({ usableUsd: 3, days: 3, low: true })).toBe('余额不多了，约还能用 3 天')
    expect(balanceRunwayText({ usableUsd: 0.2, days: 0, low: true })).toBe('余额不多了，不到 1 天就会用完')
    expect(balanceRunwayText({ usableUsd: 900, days: 400, low: false })).toBe('按最近用量，够用一年以上')
    expect(balanceRunwayText({ usableUsd: 4, days: null, low: true })).toBeNull()
  })

  it('fills the meter over thirty days and keeps a sliver when almost empty', () => {
    expect(balanceRunwayMeter(15)).toBe(50)
    expect(balanceRunwayMeter(0)).toBe(6)
    expect(balanceRunwayMeter(400)).toBe(100)
  })
})

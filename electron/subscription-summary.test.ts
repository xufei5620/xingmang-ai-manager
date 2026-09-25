import { describe, expect, it } from 'vitest'
import type { NewApiSubscription, NewApiSubscriptionSelf } from './new-api-client'
import { resolveUsableSubscription, subscriptionEndDate, subscriptionSummaryText } from './subscription-summary'

const now = Date.parse('2026-09-25T12:00:00Z')
const day = 86_400_000

function subscription(overrides: Partial<NewApiSubscription> = {}): NewApiSubscription {
  return {
    id: 1, planId: 7, status: 'active', source: 'order', amountTotal: 10 * 500_000, amountUsed: 2 * 500_000,
    startedAt: new Date(now - 10 * day).toISOString(), endsAt: new Date(now + 20 * day).toISOString(), nextResetAt: null,
    ...overrides,
  }
}

function self(subscriptions: NewApiSubscription[], billingPreference: NewApiSubscriptionSelf['billingPreference'] = null) {
  return { billingPreference, activeSubscriptions: subscriptions }
}

const options = { now, quotaPerUnit: 500_000 }

describe('resolveUsableSubscription', () => {
  it('reports the remaining dollars and end date of an active new-api subscription', () => {
    const result = resolveUsableSubscription(self([subscription()]), { ...options, planNames: new Map([[7, '月卡']]) })
    expect(result).toMatchObject({ name: '月卡', remainingUsd: 8, expiringSoon: false, lowRemaining: false, subscriptionOnly: false })
  })

  it('returns null without a subscription, so every wallet-only view stays as it was', () => {
    expect(resolveUsableSubscription(null, options)).toBeNull()
    expect(resolveUsableSubscription(self([]), options)).toBeNull()
  })

  it('ignores subscriptions that are expired, inactive or used up', () => {
    expect(resolveUsableSubscription(self([subscription({ endsAt: new Date(now - 1000).toISOString() })]), options)).toBeNull()
    expect(resolveUsableSubscription(self([subscription({ status: 'expired' })]), options)).toBeNull()
    expect(resolveUsableSubscription(self([subscription({ amountUsed: 10 * 500_000 })]), options)).toBeNull()
    expect(resolveUsableSubscription(self([subscription({ endsAt: 'not a date' })]), options)).toBeNull()
  })

  it('ignores the subscription when the billing preference only spends the wallet', () => {
    expect(resolveUsableSubscription(self([subscription()], 'wallet_only'), options)).toBeNull()
    expect(resolveUsableSubscription(self([subscription()], 'subscription_only'), options)?.subscriptionOnly).toBe(true)
  })

  it('treats a zero total as an uncapped plan', () => {
    expect(resolveUsableSubscription(self([subscription({ amountTotal: 0, amountUsed: 123 })]), options)).toMatchObject({ remainingUsd: null, lowRemaining: false })
  })

  it('flags a plan ending within three days or holding less than five dollars', () => {
    expect(resolveUsableSubscription(self([subscription({ endsAt: new Date(now + 2 * day).toISOString() })]), options)?.expiringSoon).toBe(true)
    expect(resolveUsableSubscription(self([subscription({ amountUsed: 6 * 500_000 })]), options)?.lowRemaining).toBe(true)
  })

  it('picks the subscription that lasts longest when several are usable', () => {
    const later = subscription({ id: 2, planId: 8, endsAt: new Date(now + 40 * day).toISOString() })
    expect(resolveUsableSubscription(self([subscription(), later]), options)?.endsAt).toBe(later.endsAt)
  })

  it('uses the tightest limited window of a history-account subscription', () => {
    const periods = subscription({
      amountTotal: null, amountUsed: null, groupName: '包月',
      quotaPeriods: [
        { period: 'daily', limit: 10, limitState: 'limited', used: 7, windowStartedAt: null },
        { period: 'weekly', limit: null, limitState: 'unlimited', used: 30, windowStartedAt: null },
        { period: 'monthly', limit: 100, limitState: 'limited', used: 20, windowStartedAt: null },
      ],
    })
    expect(resolveUsableSubscription(self([periods]), { now, quotaPerUnit: 1 })).toMatchObject({ name: '包月', remainingUsd: 3, lowRemaining: true })
    const spent = { ...periods, quotaPeriods: periods.quotaPeriods!.map((period) => period.period === 'daily' ? { ...period, used: 10 } : period) }
    expect(resolveUsableSubscription(self([spent]), { now, quotaPerUnit: 1 })).toBeNull()
  })
})

describe('subscriptionSummaryText', () => {
  it('writes the remaining amount and the local end date', () => {
    const endsAt = new Date(2026, 9, 3, 12).toISOString()
    expect(subscriptionEndDate(endsAt)).toBe('10 月 3 日')
    const base = { name: null, endsAt, expiringSoon: false, lowRemaining: false, subscriptionOnly: false }
    expect(subscriptionSummaryText({ ...base, remainingUsd: 12.3 }, (usd) => `$${usd.toFixed(2)}`)).toBe('剩余 $12.30 · 10 月 3 日到期')
    expect(subscriptionSummaryText({ ...base, remainingUsd: null }, (usd) => `$${usd}`)).toBe('10 月 3 日到期')
  })
})

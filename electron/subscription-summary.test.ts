import { describe, expect, it } from 'vitest'
import type { NewApiSubscription, NewApiSubscriptionSelf } from './new-api-client'
import {
  quotaPeriodResetAt,
  resolveUsableSubscription,
  subscriptionEndDate,
  subscriptionResetAt,
  subscriptionResetTime,
  subscriptionSummaryText,
} from './subscription-summary'

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

describe('subscription reset time', () => {
  it('passes on the next reset a new-api plan reports, but only while it is still ahead and before the plan ends', () => {
    const nextResetAt = new Date(now + 3 * 3_600_000).toISOString()
    expect(resolveUsableSubscription(self([subscription({ nextResetAt })]), options)?.resetsAt).toBe(nextResetAt)
    expect(resolveUsableSubscription(self([subscription()]), options)?.resetsAt).toBeNull()
    expect(resolveUsableSubscription(self([subscription({ nextResetAt: new Date(now - 1000).toISOString() })]), options)?.resetsAt).toBeNull()
    expect(resolveUsableSubscription(self([subscription({ nextResetAt: new Date(now + 30 * day).toISOString() })]), options)?.resetsAt).toBeNull()
    // Nothing to wait for on an uncapped plan.
    expect(resolveUsableSubscription(self([subscription({ nextResetAt, amountTotal: 0 })]), options)?.resetsAt).toBeNull()
  })

  // Rules checked against Wei-Shaw/sub2api user_subscription.go (see quotaPeriodResetAt).
  describe('history-account windows', () => {
    const started = Date.parse('2026-09-20T01:30:00Z')
    const history = { status: 'active', startedAt: new Date(started).toISOString(), endsAt: new Date(started + 30 * day).toISOString() }
    const todayStart = Date.parse('2026-09-24T16:00:00Z')
    function quotaWindow(period: 'daily' | 'weekly' | 'monthly', windowStartedAt: number | null, used = 1) {
      return { period, limit: 5, limitState: 'limited' as const, used, windowStartedAt: windowStartedAt === null ? null : new Date(windowStartedAt).toISOString() }
    }

    it('refills a daily window one day after the server midnight it started at', () => {
      expect(quotaPeriodResetAt(history, quotaWindow('daily', todayStart), now)).toBe(new Date(todayStart + day).toISOString())
    })

    it('never refills the daily quota of a plan that lasts one day or less', () => {
      const oneDay = { ...history, endsAt: new Date(started + day).toISOString() }
      expect(quotaPeriodResetAt(oneDay, quotaWindow('daily', Date.parse('2026-09-19T16:00:00Z')), started + 3_600_000)).toBeNull()
    })

    it('rolls weekly windows from their anchor, and from the start time for rows anchored at that midnight', () => {
      const weekStart = started + 7 * day
      expect(quotaPeriodResetAt(history, quotaWindow('weekly', weekStart), now + 7 * day)).toBe(new Date(weekStart + 7 * day).toISOString())
      const legacy = Date.parse('2026-09-19T16:00:00Z')
      expect(quotaPeriodResetAt(history, quotaWindow('weekly', legacy), now)).toBe(new Date(started + 7 * day).toISOString())
    })

    it('stays silent when the window has not opened, has already lapsed, or would only reset after the plan ends', () => {
      expect(quotaPeriodResetAt(history, quotaWindow('daily', null), now)).toBeNull()
      expect(quotaPeriodResetAt(history, quotaWindow('daily', todayStart - 2 * day), now)).toBeNull()
      expect(quotaPeriodResetAt(history, quotaWindow('monthly', started), now)).toBeNull()
      expect(quotaPeriodResetAt({ ...history, status: 'expired' }, quotaWindow('daily', todayStart), now)).toBeNull()
    })

    it('waits for the tightest window, and for the latest one when several are equally spent', () => {
      const daily = quotaWindow('daily', todayStart, 4)
      expect(subscriptionResetAt({ ...history, nextResetAt: null, quotaPeriods: [daily, quotaWindow('weekly', started, 2)] }, now))
        .toBe(new Date(todayStart + day).toISOString())
      const spentDay = quotaWindow('daily', todayStart, 5)
      expect(subscriptionResetAt({ ...history, nextResetAt: null, quotaPeriods: [spentDay, quotaWindow('weekly', started, 5)] }, now))
        .toBe(new Date(started + 7 * day).toISOString())
      // A spent window that never refills before the plan ends means no promise at all.
      expect(subscriptionResetAt({ ...history, nextResetAt: null, quotaPeriods: [spentDay, quotaWindow('monthly', started, 5)] }, now)).toBeNull()
    })

    it('carries the history-account reset into the usable subscription', () => {
      const periods = subscription({ ...history, amountTotal: null, amountUsed: null, quotaPeriods: [quotaWindow('daily', todayStart, 4)] })
      expect(resolveUsableSubscription(self([periods]), { now, quotaPerUnit: 1 })).toMatchObject({ remainingUsd: 1, resetsAt: new Date(todayStart + day).toISOString() })
    })
  })
})

describe('subscriptionSummaryText', () => {
  const at = new Date(2026, 8, 25, 20, 0)
  const base = { name: null, endsAt: new Date(2026, 9, 3, 12).toISOString(), expiringSoon: false, lowRemaining: false, subscriptionOnly: false }
  function money(usd: number) { return `$${usd.toFixed(2)}` }

  it('writes the remaining amount and the local end date', () => {
    expect(subscriptionEndDate(base.endsAt, at)).toBe('10月3日')
    expect(subscriptionSummaryText({ ...base, remainingUsd: 12.3 }, money, at)).toBe('剩余 $12.30 · 10月3日到期')
    expect(subscriptionSummaryText({ ...base, remainingUsd: null }, money, at)).toBe('10月3日到期')
  })

  it('adds the year to an end date outside the current year, so a yearly plan bought today does not read as ending today', () => {
    const endsAt = new Date(2027, 8, 25, 20, 0).toISOString()
    expect(subscriptionEndDate(endsAt, at)).toBe('2027年9月25日')
    expect(subscriptionSummaryText({ ...base, endsAt, remainingUsd: 12.3 }, money, at)).toBe('剩余 $12.30 · 2027年9月25日到期')
  })

  it('says when the remaining amount comes back once a reset time is known', () => {
    const resetsAt = new Date(2026, 8, 26, 0, 0).toISOString()
    const endsAt = new Date(2026, 10, 30, 12).toISOString()
    expect(subscriptionSummaryText({ ...base, endsAt, remainingUsd: 3.2, resetsAt }, money, at)).toBe('剩余 $3.20 · 明天 00:00 恢复 · 11月30日到期')
    expect(subscriptionSummaryText({ ...base, endsAt, remainingUsd: null, resetsAt }, money, at)).toBe('11月30日到期')
    // Read before the reset, written after it: the stale moment is dropped rather than shown as past.
    expect(subscriptionSummaryText({ ...base, endsAt, remainingUsd: 3.2, resetsAt }, money, new Date(2026, 8, 26, 0, 5))).toBe('剩余 $3.20 · 11月30日到期')
  })

  it('names today, tomorrow, a later date, or a later year for the reset moment', () => {
    expect(subscriptionResetTime(new Date(2026, 8, 25, 22, 30).toISOString(), at)).toBe('今天 22:30')
    expect(subscriptionResetTime(new Date(2026, 8, 26, 0, 0).toISOString(), at)).toBe('明天 00:00')
    expect(subscriptionResetTime(new Date(2026, 8, 28, 0, 0).toISOString(), at)).toBe('9月28日 00:00')
    expect(subscriptionResetTime(new Date(2027, 0, 1, 0, 0).toISOString(), new Date(2026, 11, 20, 9))).toBe('2027年1月1日 00:00')
    expect(subscriptionResetTime(new Date(2026, 8, 25, 19, 0).toISOString(), at)).toBeNull()
    expect(subscriptionResetTime('not a date', at)).toBeNull()
  })
})

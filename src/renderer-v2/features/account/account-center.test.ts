import { describe, expect, it } from 'vitest'
import {
  currentExpiryText,
  deviceActivityText,
  inviteRateText,
  inviteRuleText,
  keyCountText,
  keyExpiredTime,
  keyMetaParts,
  keyToolChoice,
  localSpendDays,
  passwordRules,
  runwayDaysText,
  shortDate,
  spendBarHeights,
  spendDayTitle,
  subscriptionOverview,
  subscriptionOverviewText,
  validatePasswordChange,
} from './account-center'

const now = new Date(2026, 9, 15, 9, 30)

describe('account center spend bars', () => {
  it('cuts the last seven days at local midnight and ends today at now', () => {
    const days = localSpendDays(now)
    expect(days).toHaveLength(7)
    expect(days.map((day) => day.label)).toEqual(['周五', '周六', '周日', '周一', '周二', '周三', '今天'])
    expect(new Date(days[0].start)).toEqual(new Date(2026, 9, 9))
    expect(days[0].end).toBe(days[1].start)
    expect(days[6].start).toBe(new Date(2026, 9, 15).getTime())
    expect(days[6].end).toBe(now.getTime())
    for (const day of days) expect(day.end - day.start).toBeLessThanOrEqual(25 * 3_600_000)
  })

  it('titles a bar with its date and weekday', () => {
    expect(spendDayTitle({ start: new Date(2026, 9, 9).getTime() }, '$1.20')).toBe('10 月 9 日 周五：$1.20')
  })

  it('scales bars to the busiest day and keeps small spends visible', () => {
    expect(spendBarHeights([0, 1, 10, 0.01])).toEqual([0, 10, 100, 4])
    expect(spendBarHeights([0, 0])).toEqual([0, 0])
  })
})

describe('account center wording', () => {
  it('says how long the balance lasts the way the home page does', () => {
    expect(runwayDaysText(12)).toBe('按最近用量约还能用 12 天')
    expect(runwayDaysText(0)).toBe('按最近用量不到 1 天就会用完')
    expect(runwayDaysText(400)).toBe('按最近用量够用一年以上')
  })

  it('adds the year only to dates outside this year', () => {
    expect(shortDate(new Date(2026, 9, 3), now)).toBe('10 月 3 日')
    expect(shortDate(new Date(2027, 0, 2), now)).toBe('2027 年 1 月 2 日')
    expect(shortDate('not a date', now)).toBe('')
  })

  it('counts keys and the ones tools are using', () => {
    expect(keyCountText(3, 1)).toBe('3 把，1 把正在被工具使用')
    expect(keyCountText(2, 0)).toBe('2 把')
  })

  it('names the invite rebate rate only when the server gave one', () => {
    expect(inviteRateText(10)).toBe('好友充值后返你 10%')
    expect(inviteRateText(undefined)).toBe('好友充值后你能拿返利')
    expect(inviteRateText(0)).toBe('好友充值后你能拿返利')
    expect(inviteRuleText(10)).toBe('好友用你的链接注册并充值，你得到充值金额的 10%。')
    expect(inviteRuleText(null)).toBe('好友用你的链接注册并充值后，你能拿到返利。')
  })

  it('describes each login device by how long ago it was active and its address', () => {
    const at = now.getTime()
    expect(deviceActivityText({ current: true, ip: '1.1.1.1', lastActiveAt: '' }, at)).toBe('正在使用')
    expect(deviceActivityText({ current: false, ip: '1.1.1.1', lastActiveAt: new Date(at - 3 * 86_400_000 - 5).toISOString() }, at)).toBe('3 天前活动 · 1.1.1.1')
    expect(deviceActivityText({ current: false, ip: '', lastActiveAt: new Date(at - 2 * 3_600_000).toISOString() }, at)).toBe('2 小时前活动')
    expect(deviceActivityText({ current: false, ip: '2.2.2.2', lastActiveAt: new Date(at - 60_000).toISOString() }, at)).toBe('刚刚活动 · 2.2.2.2')
    expect(deviceActivityText({ current: false, ip: '2.2.2.2', lastActiveAt: 'garbled' }, at)).toBe('2.2.2.2')
  })
})

describe('account center subscription card', () => {
  const quotaPerUnit = 500_000
  const subscription = { id: 1, planId: 7, status: 'active', source: 'order', amountTotal: 20 * quotaPerUnit, amountUsed: 5 * quotaPerUnit, startedAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-01T00:00:00Z', nextResetAt: null }

  it('shows the active plan ending last, with how much of it is used', () => {
    const later = { ...subscription, id: 2, planId: 8, endsAt: '2026-12-01T00:00:00Z' }
    const view = subscriptionOverview({ billingPreference: 'wallet_first', activeSubscriptions: [subscription, later] }, { now: now.getTime(), quotaPerUnit, planNames: new Map([[8, '月卡']]) })
    expect(view).toEqual({ name: '月卡', endsAt: later.endsAt, usedUsd: 5, totalUsd: 20, short: false, preference: 'wallet_first' })
  })

  it('still lists a plan when the account bills the wallet only', () => {
    expect(subscriptionOverview({ billingPreference: 'wallet_only', activeSubscriptions: [subscription] }, { now: now.getTime(), quotaPerUnit })?.preference).toBe('wallet_only')
  })

  it('marks a plan that is about to end or nearly used up', () => {
    const ending = { ...subscription, endsAt: new Date(now.getTime() + 86_400_000).toISOString() }
    expect(subscriptionOverview({ billingPreference: null, activeSubscriptions: [ending] }, { now: now.getTime(), quotaPerUnit })?.short).toBe(true)
    const drained = { ...subscription, amountUsed: 18 * quotaPerUnit }
    expect(subscriptionOverview({ billingPreference: null, activeSubscriptions: [drained] }, { now: now.getTime(), quotaPerUnit })?.short).toBe(true)
  })

  it('leaves out ended, inactive or unlimited usage and reads the tightest historical window', () => {
    expect(subscriptionOverview({ billingPreference: null, activeSubscriptions: [{ ...subscription, endsAt: '2026-01-01T00:00:00Z' }] }, { now: now.getTime(), quotaPerUnit })).toBeNull()
    expect(subscriptionOverview({ billingPreference: null, activeSubscriptions: [{ ...subscription, status: 'expired' }] }, { now: now.getTime(), quotaPerUnit })).toBeNull()
    expect(subscriptionOverview(null, { now: now.getTime(), quotaPerUnit })).toBeNull()
    const unlimited = subscriptionOverview({ billingPreference: null, activeSubscriptions: [{ ...subscription, amountTotal: 0 }] }, { now: now.getTime(), quotaPerUnit })
    expect(unlimited).toMatchObject({ usedUsd: null, totalUsd: null })
    const historical = subscriptionOverview({ billingPreference: null, activeSubscriptions: [{ ...subscription, groupName: '专享', quotaPeriods: [
      { period: 'daily', limit: 10, limitState: 'limited', used: 2, windowStartedAt: null },
      { period: 'monthly', limit: 100, limitState: 'limited', used: 95, windowStartedAt: null },
      { period: 'weekly', limit: null, limitState: 'unlimited', used: null, windowStartedAt: null },
    ] }] }, { now: now.getTime(), quotaPerUnit })
    expect(historical).toMatchObject({ name: '专享', usedUsd: 95, totalUsd: 100, short: false })
  })

  it('writes the plan line with or without a plan name', () => {
    expect(subscriptionOverviewText({ name: '月卡', endsAt: new Date(2026, 10, 1).toISOString() }, now)).toBe('月卡，11 月 1 日到期')
    expect(subscriptionOverviewText({ name: null, endsAt: new Date(2026, 10, 1).toISOString() }, now)).toBe('11 月 1 日到期')
  })
})

describe('account center password change', () => {
  it('uses each account kind\'s own length limits', () => {
    expect(passwordRules('solov')).toEqual({ minimum: 8, maximum: 20 })
    expect(passwordRules('solov-api')).toEqual({ minimum: 6, maximum: 256 })
  })

  it('checks the form in the order the user fills it', () => {
    const rules = passwordRules('solov')
    const check = (originalPassword: string, password: string, confirmPassword: string) => () => validatePasswordChange({ originalPassword, password, confirmPassword }, rules)
    expect(check('', 'abcdefgh', 'abcdefgh')).toThrow('请输入原密码')
    expect(check('old', 'short', 'short')).toThrow('新密码至少 8 位')
    expect(check('old', 'x'.repeat(21), 'x'.repeat(21))).toThrow('新密码不能超过 20 位')
    expect(check('old', 'abcdefgh', 'abcdefgx')).toThrow('两次密码不一致')
    expect(check('old', 'abcdefgh', 'abcdefgh')).not.toThrow()
  })
})

describe('account center keys', () => {
  it('turns the expiry choice into the server timestamp', () => {
    const at = now.getTime()
    expect(keyExpiredTime('never', { custom: '', current: 123, now: at })).toBe(-1)
    expect(keyExpiredTime('keep', { custom: '', current: 123, now: at })).toBe(123)
    expect(keyExpiredTime('30', { custom: '', current: -1, now: at })).toBe(Math.floor((at + 30 * 86_400_000) / 1000))
    expect(keyExpiredTime('90', { custom: '', current: -1, now: at })).toBe(Math.floor((at + 90 * 86_400_000) / 1000))
    expect(() => keyExpiredTime('custom', { custom: '', current: -1, now: at })).toThrow('请选一个到期日期')
    expect(() => keyExpiredTime('custom', { custom: '2026-10-01T00:00', current: -1, now: at })).toThrow('到期时间必须晚于现在。')
    expect(keyExpiredTime('custom', { custom: '2026-12-01T08:00', current: -1, now: at })).toBe(Math.floor(new Date('2026-12-01T08:00').getTime() / 1000))
  })

  it('describes a key by what it used, what is left, when it ends and when it was made', () => {
    const money = (quota: number) => `$${(quota / 100).toFixed(2)}`
    const key = { usedQuota: 150, remainQuota: 850, unlimitedQuota: false, expiredAt: new Date(2026, 11, 31).toISOString(), createdAt: new Date(2026, 8, 1).toISOString() }
    expect(keyMetaParts(key, money, now)).toEqual(['已用 $1.50', '剩余 $8.50', '12 月 31 日到期', '9 月 1 日创建'])
    expect(keyMetaParts({ ...key, unlimitedQuota: true, expiredAt: null, createdAt: '' }, money, now)).toEqual(['已用 $1.50', '不限额度', '永不过期'])
    expect(currentExpiryText(null, now)).toBe('永不过期')
  })

  it('greys out the tools already on this key or not installed, and flags official logins', () => {
    const claude = { provider: 'claude' as const, name: 'Claude Code', installed: true, official: false }
    expect(keyToolChoice(claude, true)).toEqual({ hint: '在用', disabled: true })
    expect(keyToolChoice({ ...claude, installed: false }, false)).toEqual({ hint: '未安装', disabled: true })
    expect(keyToolChoice({ ...claude, official: true }, false)).toEqual({ hint: '官方账号', disabled: false })
    expect(keyToolChoice({ ...claude, installed: null }, false)).toEqual({ hint: '', disabled: false })
  })
})

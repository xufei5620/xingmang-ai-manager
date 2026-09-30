import { describe, expect, it } from 'vitest'
import { activeRechargePromos, formatPromoDeadline, isRechargePromoTitle, localDayKey, nextPromoReminder, resolvePromoEndsAt, visiblePromo, type PromoAnnouncement, type PromoSource } from './promo-announcements'

const published = new Date(2026, 8, 28, 10, 0).getTime()

function entry(title: string, text: string, extra = '', publishedAt = new Date(published).toISOString()): PromoSource {
  return { id: `newapi-${title.length}-${text.length}`, title, text, timeline: { type: 'ongoing', publishedAt, extra } }
}

function promo(id: string, overrides: Partial<PromoAnnouncement> = {}): PromoAnnouncement {
  return { id, title: '国庆充值活动', text: '', publishedAt: published, endsAt: published + 86_400_000, endsExplicitly: true, ...overrides }
}

describe('recharge promo announcements', () => {
  it('treats only titles that mention 充值 as recharge promos', () => {
    expect(isRechargePromoTitle('国庆 充值 送 20%')).toBe(true)
    expect(isRechargePromoTitle('系统维护通知')).toBe(false)
  })

  it('reads the deadline from 截止 lines and from date ranges in local time', () => {
    expect(resolvePromoEndsAt('活动截止：2026-10-07 23:00', published)).toBe(new Date(2026, 9, 7, 23, 0).getTime())
    expect(resolvePromoEndsAt('截止 10月7日', published)).toBe(new Date(2026, 9, 7, 23, 59, 59).getTime())
    expect(resolvePromoEndsAt('活动时间：10月1日-10月7日', published)).toBe(new Date(2026, 9, 7, 23, 59, 59).getTime())
    expect(resolvePromoEndsAt('活动时间 2026年10月1日 至 2026年10月8日 12:00', published)).toBe(new Date(2026, 9, 8, 12, 0).getTime())
  })

  it('rolls a month-day deadline into next year only when it falls well before publishing', () => {
    const december = new Date(2026, 11, 28).getTime()
    expect(resolvePromoEndsAt('截止 1月3日', december)).toBe(new Date(2027, 0, 3, 23, 59, 59).getTime())
  })

  it('ignores deadlines that are missing, already before publishing or absurdly far away', () => {
    expect(resolvePromoEndsAt('充值满 100 送 20', published)).toBeNull()
    expect(resolvePromoEndsAt('截止 2026-09-01', published)).toBeNull()
    expect(resolvePromoEndsAt('截止 2062-10-07', published)).toBeNull()
    expect(resolvePromoEndsAt('截止 13月40日', published)).toBeNull()
  })

  it('keeps active promos newest first and drops expired or undated ones', () => {
    const now = new Date(2026, 8, 29, 12, 0).getTime()
    const entries: PromoSource[] = [
      entry('国庆充值活动', '截止 10月7日'),
      entry('旧充值活动', '截止 9月28日 20:00', '', new Date(2026, 8, 20).toISOString()),
      entry('中秋充值加赠', '满额送', '', new Date(2026, 8, 25).toISOString()),
      entry('很久以前的充值活动', '满额送', '', new Date(2026, 7, 1).toISOString()),
      { id: 'legacy', title: '系统公告 充值说明', text: '旧的系统公告没有发布时间' },
      entry('服务维护', '截止 10月7日'),
    ]
    const promos = activeRechargePromos(entries, now)
    expect(promos.map((item) => item.title)).toEqual(['国庆充值活动', '中秋充值加赠'])
    expect(promos[0].endsExplicitly).toBe(true)
    // 没写截止时间的按发布后 7 天算。
    expect(promos[1]).toMatchObject({ endsExplicitly: false, endsAt: new Date(2026, 8, 25).getTime() + 7 * 86_400_000 })
    expect(activeRechargePromos(entries, new Date(2026, 9, 8).getTime())).toEqual([])
  })

  it('words the deadline for a person and says nothing when it was only estimated', () => {
    const now = new Date(2026, 8, 29, 12, 0).getTime()
    expect(formatPromoDeadline({ endsAt: new Date(2026, 8, 29, 23, 59, 59).getTime(), endsExplicitly: true }, now)).toBe('今天 23:59 结束')
    expect(formatPromoDeadline({ endsAt: new Date(2026, 8, 30, 20, 0).getTime(), endsExplicitly: true }, now)).toBe('明天 20:00 结束')
    expect(formatPromoDeadline({ endsAt: new Date(2026, 9, 7, 23, 59, 59).getTime(), endsExplicitly: true }, now)).toBe('10月7日 23:59 结束，还剩 8 天')
    expect(formatPromoDeadline({ endsAt: now + 86_400_000, endsExplicitly: false }, now)).toBeNull()
  })

  it('shows the newest promo that was neither acknowledged nor snoozed today', () => {
    const promos = [promo('a'), promo('b')]
    expect(visiblePromo(promos, [], {}, '20260929')?.id).toBe('a')
    expect(visiblePromo(promos, ['a'], {}, '20260929')?.id).toBe('b')
    expect(visiblePromo(promos, ['a'], { b: '20260929' }, '20260929')).toBeNull()
    // 「今天不再提醒」第二天就失效。
    expect(visiblePromo(promos, ['a'], { b: '20260929' }, '20260930')?.id).toBe('b')
    expect(localDayKey(new Date(2026, 0, 5, 1).getTime())).toBe('20260105')
  })

  it('announces a new promo once, then reminds at most once a day and only by notification when in the background', () => {
    const base = { promos: [promo('a')], acknowledged: [], snoozed: {}, reminded: {}, readIds: [], today: '20260929', foreground: true }
    expect(nextPromoReminder(base)).toMatchObject({ kind: 'arrival', notify: true })
    expect(nextPromoReminder({ ...base, reminded: { a: '20260929' } })).toBeNull()
    expect(nextPromoReminder({ ...base, reminded: { a: '20260928' } })).toMatchObject({ kind: 'daily', notify: false })
    expect(nextPromoReminder({ ...base, reminded: { a: '20260928' }, foreground: false })).toMatchObject({ kind: 'daily', notify: true })
    // 读过的不算新活动。
    expect(nextPromoReminder({ ...base, readIds: ['a'], foreground: false })).toMatchObject({ kind: 'daily', notify: true })
    expect(nextPromoReminder({ ...base, acknowledged: ['a'] })).toBeNull()
    expect(nextPromoReminder({ ...base, snoozed: { a: '20260929' } })).toBeNull()
  })
})

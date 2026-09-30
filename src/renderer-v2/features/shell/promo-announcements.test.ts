import { describe, expect, it } from 'vitest'
import { activePromos, activeRechargePromos, buildPromoTiers, formatPromoDeadline, formatPromoShortDeadline, isRechargePromoTitle, promoPreviewLines, promoShortName, resolvePromoKind, stripSiteAddresses, localDayKey, nextPromoReminder, resolvePromoEndsAt, visiblePromo, type PromoAnnouncement, type PromoSource } from './promo-announcements'

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

describe('activity announcements beyond recharge', () => {
  it('counts invite titles as activities but keeps the big card to recharge ones', () => {
    expect(resolvePromoKind('国庆礼遇｜充值满赠')).toBe('recharge')
    expect(resolvePromoKind('国庆礼遇｜邀请有礼')).toBe('invite')
    expect(resolvePromoKind('系统维护通知')).toBeNull()
    const now = new Date(2026, 8, 29, 12, 0).getTime()
    const entries = [entry('国庆礼遇｜充值满赠', '截止 10月8日'), { ...entry('国庆礼遇｜邀请有礼', '邀请好友'), id: 'invite' }]
    expect(activePromos(entries, now).map((item) => item.kind).sort()).toEqual(['invite', 'recharge'])
    expect(activeRechargePromos(entries, now).map((item) => item.kind)).toEqual(['recharge'])
  })

  it('ends an invite without a written deadline seven days after publishing', () => {
    const [invite] = activePromos([entry('邀请有礼', '邀请好友一起用')], published)
    expect(invite.endsExplicitly).toBe(false)
    expect(invite.endsAt).toBe(published + 7 * 86_400_000)
    expect(activePromos([entry('邀请有礼', '邀请好友一起用')], published + 7 * 86_400_000)).toEqual([])
  })

  it('writes short deadlines for the activity bar and hides estimated ones', () => {
    const now = new Date(2026, 8, 30, 10, 0).getTime()
    const endsAt = new Date(2026, 9, 8, 23, 59, 59).getTime()
    expect(formatPromoShortDeadline({ endsAt, endsExplicitly: true }, now, true)).toBe('10月8日截止，还剩 8 天')
    expect(formatPromoShortDeadline({ endsAt, endsExplicitly: true }, now, false)).toBe('10月8日截止')
    expect(formatPromoShortDeadline({ endsAt: new Date(2026, 8, 30, 23, 59).getTime(), endsExplicitly: true }, now, true)).toBe('今天 23:59 截止')
    expect(formatPromoShortDeadline({ endsAt, endsExplicitly: false }, now, true)).toBeNull()
  })

  it('shortens titles to the part after the vertical bar', () => {
    expect(promoShortName('国庆礼遇 · 中秋同庆｜充值满赠')).toBe('充值满赠')
    expect(promoShortName('国庆充值活动')).toBe('国庆充值活动')
  })
})

describe('promo card text', () => {
  it('drops site addresses and the separators they leave behind', () => {
    expect(stripSiteAddresses('xm.solov.cc · 2026年10月1日—10月8日')).toBe('2026年10月1日—10月8日')
    expect(stripSiteAddresses('详见 https://example.com/topup?x=1 页面')).toBe('详见 页面')
    expect(stripSiteAddresses('需要 Node.js 18 以上，版本 v0.2.11，单价 1.5')).toBe('需要 Node.js 18 以上，版本 v0.2.11，单价 1.5')
  })

  it('keeps the first three body lines with their breaks instead of one long run', () => {
    const body = 'xm.solov.cc · 2026年10月1日—10月8日\n**单笔充值，最高赠送100%：**\n- 充¥100，送10%，到账$110\n- 充¥200，送20%，到账$240'
    expect(promoPreviewLines(body)).toEqual(['2026年10月1日—10月8日', '单笔充值，最高赠送100%：', '充¥100，送10%，到账$110…'])
    expect(promoPreviewLines('只有一行')).toEqual(['只有一行'])
    expect(promoPreviewLines('<style>.x{color:red}</style><p>活动说明</p>')).toEqual(['活动说明'])
  })

  it('builds bonus tiers from the top-up discounts, smallest first, skipping tiers without a bonus', () => {
    const discounts = { '110': 100 / 110, '240': 200 / 240, '4000': 0.5, '50': 1 }
    expect(buildPromoTiers([4000, 10, 50, 110, 240], discounts)).toEqual([
      { amount: 110, pay: 100, percent: 10 },
      { amount: 240, pay: 200, percent: 20 },
      { amount: 4000, pay: 2000, percent: 100 },
    ])
    expect(buildPromoTiers([10, 20], {})).toEqual([])
    expect(buildPromoTiers(undefined, discounts)).toEqual([])
  })
})

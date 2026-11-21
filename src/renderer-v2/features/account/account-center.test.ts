import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  affiliateTransferQuota,
  affiliateTransferTitleQuota,
  countAccountKeys,
  currentExpiryText,
  deviceActivityText,
  inviteRateText,
  inviteRuleText,
  keyCountText,
  keyEditChanges,
  keyEditUpdate,
  keyExpiredTime,
  type KeyEditForm,
  keyCanEnable,
  keyMetaParts,
  keyToolChoice,
  keyToolInstalled,
  limitKeyNameEdit,
  localSpendDays,
  passwordChangeFailure,
  passwordChangeUnconfirmedNotice,
  passwordRules,
  runwayDaysText,
  shortDate,
  spendBarHeights,
  spendDayTitle,
  subscriptionOverview,
  subscriptionOverviewText,
  validatePasswordChange,
} from './account-center'
import { passwordChangeUnconfirmedMessage } from '../../../../electron/password-change-unconfirmed'
import { errorMessage } from '../../business-common'

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
    expect(spendDayTitle({ start: new Date(2026, 9, 9).getTime() }, '$1.20')).toBe('10月9日 周五：$1.20')
  })

  it('scales bars to the busiest day and keeps small spends visible', () => {
    expect(spendBarHeights([0, 1, 10, 0.01])).toEqual([0, 10, 100, 4])
    expect(spendBarHeights([0, 0])).toEqual([0, 0])
  })
})

describe('account center wording', () => {
  it('says how long the balance lasts the way the home page does', () => {
    expect(runwayDaysText(12)).toBe('按近期用量预计可用 12 天')
    expect(runwayDaysText(0)).toBe('按近期用量预计不足 1 天')
    expect(runwayDaysText(400)).toBe('按近期用量可用一年以上')
  })

  it('adds the year only to dates outside this year', () => {
    expect(shortDate(new Date(2026, 9, 3), now)).toBe('10月3日')
    expect(shortDate(new Date(2027, 0, 2), now)).toBe('2027年1月2日')
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
    // D60：只有不到 5 分钟算「刚刚」，50 分钟前的不能也写「刚刚」。
    expect(deviceActivityText({ current: false, ip: '2.2.2.2', lastActiveAt: new Date(at - 5 * 60_000 + 1).toISOString() }, at)).toBe('刚刚活动 · 2.2.2.2')
    expect(deviceActivityText({ current: false, ip: '2.2.2.2', lastActiveAt: new Date(at - 5 * 60_000).toISOString() }, at)).toBe('5 分钟前活动 · 2.2.2.2')
    expect(deviceActivityText({ current: false, ip: '1.2.3.4', lastActiveAt: new Date(at - 35 * 60_000 - 20_000).toISOString() }, at)).toBe('35 分钟前活动 · 1.2.3.4')
    expect(deviceActivityText({ current: false, ip: '', lastActiveAt: new Date(at - 3_600_000 + 1).toISOString() }, at)).toBe('59 分钟前活动')
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
    expect(subscriptionOverviewText({ name: '月卡', endsAt: new Date(2026, 10, 1).toISOString() }, now)).toBe('月卡，11月1日到期')
    expect(subscriptionOverviewText({ name: null, endsAt: new Date(2026, 10, 1).toISOString() }, now)).toBe('11月1日到期')
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
  it('lets a key name through untouched while it fits the 50-byte server cap', () => {
    expect(limitKeyNameEdit('', 'x'.repeat(50))).toBeNull()
    expect(limitKeyNameEdit('', '星'.repeat(16))).toBeNull()
    expect(limitKeyNameEdit('星'.repeat(16), `${'星'.repeat(16)}ab`)).toBeNull()
  })

  it('cuts a pasted Chinese name at 16 characters, the most 50 bytes can hold', () => {
    expect(limitKeyNameEdit('', '星'.repeat(17))).toEqual({ value: '星'.repeat(16), caret: 16 })
    expect(limitKeyNameEdit('', 'x'.repeat(60))).toEqual({ value: 'x'.repeat(50), caret: 50 })
  })

  it('drops only what was just typed and keeps the existing name and caret', () => {
    const full = `${'星'.repeat(16)}ab`
    // A character typed in the middle of a full name is refused, not the name's last character.
    expect(limitKeyNameEdit(full, `星芒${full.slice(1)}`)).toEqual({ value: full, caret: 1 })
    expect(limitKeyNameEdit(full, `${full}c`)).toEqual({ value: full, caret: full.length })
    // Pasting over a selection keeps the part of the paste that fits.
    expect(limitKeyNameEdit(`ab${'星'.repeat(15)}`, `ab${'芒'.repeat(20)}`)).toEqual({ value: `ab${'芒'.repeat(16)}`, caret: 18 })
  })

  it('never splits an emoji and counts it as four bytes', () => {
    const name = 'x'.repeat(47)
    expect(limitKeyNameEdit(name, `${name}😀`)).toEqual({ value: name, caret: 47 })
    expect(limitKeyNameEdit('x'.repeat(46), `${'x'.repeat(46)}😀😀`)).toEqual({ value: `${'x'.repeat(46)}😀`, caret: 48 })
  })

  it('trims an already over-long name from the end once it is edited', () => {
    expect(limitKeyNameEdit('星'.repeat(20), `${'星'.repeat(20)}a`)).toEqual({ value: '星'.repeat(16), caret: 16 })
  })

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

  describe('editing an existing key (F01)', () => {
    const opened = { name: 'my key', group: 'default' }
    const untouched: KeyEditForm = { ...opened, quotaEdited: false, unlimited: true, quota: '0', expiry: 'keep', customExpiry: '' }
    const context = { quotaPerUnit: 500_000, siteId: 'solov' as const, now: now.getTime() }
    // What the key looks like when the editor saves: a $5 cap set a moment ago from the tool limits card,
    // while the list the editor was opened from still said "unlimited".
    const latest = { name: 'my key', group: 'default', remainQuota: 2_500_000, unlimitedQuota: false, expiredAt: '2026-12-31T00:00:00.000Z' }

    it('keeps a cap set elsewhere when only the name changes', () => {
      const changes = keyEditChanges({ ...untouched, name: 'renamed' }, opened, context)
      expect(changes).toEqual({ name: 'renamed' })
      expect(keyEditUpdate(7, changes, latest)).toEqual({
        id: 7,
        name: 'renamed',
        group: 'default',
        remainQuota: 2_500_000,
        unlimitedQuota: false,
        expiredTime: Math.floor(Date.parse('2026-12-31T00:00:00.000Z') / 1000),
      })
    })

    it('takes the name, group and expiry from the latest record when they were not edited', () => {
      const changes = keyEditChanges({ ...untouched, quotaEdited: true, unlimited: false, quota: '3' }, opened, context)
      expect(changes).toEqual({ quota: { remainQuota: 1_500_000, unlimitedQuota: false } })
      expect(keyEditUpdate(7, changes, { ...latest, name: 'renamed elsewhere', group: 'vip', unlimitedQuota: true, remainQuota: 0 })).toEqual({
        id: 7,
        name: 'renamed elsewhere',
        group: 'vip',
        remainQuota: 1_500_000,
        unlimitedQuota: false,
        expiredTime: Math.floor(Date.parse('2026-12-31T00:00:00.000Z') / 1000),
      })
    })

    it('still lifts a cap when the customer picks unlimited on purpose', () => {
      const changes = keyEditChanges({ ...untouched, quotaEdited: true, unlimited: true }, opened, context)
      expect(keyEditUpdate(7, changes, latest)).toMatchObject({ remainQuota: 0, unlimitedQuota: true })
    })

    it('uses the chosen group and expiry when they were edited', () => {
      const changes = keyEditChanges({ ...untouched, group: 'vip', expiry: 'never' }, opened, context)
      expect(changes).toEqual({ group: 'vip', expiredTime: -1 })
      expect(keyEditUpdate(7, changes, latest)).toMatchObject({ group: 'vip', expiredTime: -1, remainQuota: 2_500_000, unlimitedQuota: false })
    })

    it('writes an unlimited key back as unlimited without a quota', () => {
      expect(keyEditUpdate(7, {}, { ...latest, unlimitedQuota: true, remainQuota: 123, expiredAt: null })).toEqual({
        id: 7, name: 'my key', group: 'default', remainQuota: 0, unlimitedQuota: true, expiredTime: -1,
      })
    })

    it('refuses an edited cap that is not above zero before reading anything', () => {
      expect(() => keyEditChanges({ ...untouched, quotaEdited: true, unlimited: false, quota: '0' }, opened, context)).toThrow('请填写大于 0 的可用额度')
      expect(() => keyEditChanges({ ...untouched, quotaEdited: true, unlimited: false, quota: '' }, opened, context)).toThrow('请填写大于 0 的可用额度')
    })

    it('asks for a cap again, as before, when the untouched key has used its cap up', () => {
      expect(() => keyEditUpdate(7, { name: 'renamed' }, { ...latest, remainQuota: 0 })).toThrow('请填写大于 0 的可用额度')
    })

    it('keeps the cap in dollars for the other account backend', () => {
      const changes = keyEditChanges({ ...untouched, quotaEdited: true, unlimited: false, quota: '2.5' }, opened, { ...context, quotaPerUnit: 1, siteId: 'solov-api' })
      expect(changes.quota).toEqual({ remainQuota: 2.5, unlimitedQuota: false })
      expect(keyEditUpdate(7, { name: 'renamed' }, { ...latest, remainQuota: 4.75 })).toMatchObject({ remainQuota: 4.75, unlimitedQuota: false })
    })

    it('never lets a field the customer did not edit come from the stale form, with random inputs', () => {
      const key = fc.record({
        name: fc.string({ minLength: 1, maxLength: 20 }),
        group: fc.string({ minLength: 1, maxLength: 20 }),
        remainQuota: fc.integer({ min: 1, max: 1e12 }),
        unlimitedQuota: fc.boolean(),
        expiredAt: fc.option(fc.integer({ min: 1, max: 4_000_000_000 }).map((seconds) => new Date(seconds * 1000).toISOString()), { nil: null }),
      })
      fc.assert(fc.property(key, key, fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (stale, current, typedName, typedGroup) => {
        // The editor was opened from `stale`; the customer may have typed a name and a group but left the cap
        // and the expiry alone. Whatever was in the stale form, cap and expiry follow the current record.
        const form: KeyEditForm = {
          name: typedName || stale.name,
          group: typedGroup || stale.group,
          quotaEdited: false,
          unlimited: stale.unlimitedQuota,
          quota: String(stale.remainQuota / context.quotaPerUnit),
          expiry: 'keep',
          customExpiry: '',
        }
        const input = keyEditUpdate(9, keyEditChanges(form, stale, context), current)
        expect(input.unlimitedQuota).toBe(current.unlimitedQuota)
        expect(input.remainQuota).toBe(current.unlimitedQuota ? 0 : current.remainQuota)
        expect(input.expiredTime).toBe(current.expiredAt ? Math.floor(Date.parse(current.expiredAt) / 1000) : -1)
        expect(input.name).toBe(form.name === stale.name ? current.name : form.name)
        expect(input.group).toBe(form.group === stale.group ? current.group : form.group)
      }))
    })
  })

  it('describes a key by what it used, what is left, when it ends and when it was made', () => {
    const money = (quota: number) => `$${(quota / 100).toFixed(2)}`
    const key = { usedQuota: 150, remainQuota: 850, unlimitedQuota: false, expiredAt: new Date(2026, 11, 31).toISOString(), createdAt: new Date(2026, 8, 1).toISOString() }
    expect(keyMetaParts(key, money, now)).toEqual(['已用 $1.50', '剩余 $8.50', '12月31日到期', '9月1日创建'])
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

  it('offers 启用 on a disabled, expired or used-up key of the current account only (Q2)', () => {
    expect([1, 2, 3, 4, 0, 5].map((status) => keyCanEnable({ status }, 'solov'))).toEqual([false, true, true, true, false, false])
    // 历史账号的后台没有接「启用」，那边一把都不摆。
    expect([1, 2, 3, 4].map((status) => keyCanEnable({ status }, 'solov-api'))).toEqual([false, false, false, false])
  })

  it('counts a tool as installed when either Codex client is, and does not block on a failed detection', () => {
    expect(keyToolInstalled([{ installed: false }, { installed: true }])).toBe(true)
    expect(keyToolInstalled([{ installed: false }, { installed: false }])).toBe(false)
    expect(keyToolInstalled([{ installed: false }, { installed: false, detectionFailed: true }])).toBe(null)
    expect(keyToolInstalled([{ installed: true }, { installed: false, detectionFailed: true }])).toBe(true)
    expect(keyToolInstalled([{ installed: true, detectionFailed: true }])).toBe(null)
  })

  it('walks every key page before counting the keys a tool uses', async () => {
    const pages = [
      { total: 205, keys: Array.from({ length: 100 }, () => ({})) },
      { total: 205, keys: [...Array.from({ length: 99 }, () => ({})), { managedProvider: 'codex' }] },
      { total: 205, keys: [{ managedProvider: 'claude' }, { managedProvider: 'gemini' }, {}, {}, {}] },
    ]
    const asked: number[] = []
    const counted = await countAccountKeys(async ({ page }) => { asked.push(page); return pages[page - 1] }, (provider) => provider === 'claude' || provider === 'codex')
    expect(counted).toEqual({ total: 205, inUse: 2 })
    expect(asked).toEqual([1, 2, 3])
  })

  it('stops counting when a page comes back empty or the safety valve is reached', async () => {
    const asked: number[] = []
    expect(await countAccountKeys(async ({ page }) => { asked.push(page); return page === 1 ? { total: 300, keys: [{ managedProvider: 'grok' }] } : { total: 300, keys: [] } }, () => true)).toEqual({ total: 300, inUse: 1 })
    expect(asked).toEqual([1, 2])
    let calls = 0
    expect(await countAccountKeys(async () => { calls++; return { total: 1_000_000, keys: [{}] } }, () => false)).toEqual({ total: 1_000_000, inUse: 0 })
    expect(calls).toBe(100)
  })
})

describe('affiliateTransferQuota', () => {
  it('sends a historical account rebate whole and unrounded, whatever the field holds', () => {
    // 余额 F4：以前 $3.50 被四舍五入成 4（超过可转），$3.456 成 3（后台要全额），都转不进去。
    for (const available of [3.5, 3.456, 0.01, 100]) {
      expect(affiliateTransferQuota({ wholeOnly: true, amount: String(available), available, quotaPerUnit: 1 })).toBe(available)
      expect(affiliateTransferQuota({ wholeOnly: true, amount: '1', available, quotaPerUnit: 1 })).toBe(available)
    }
  })

  it('sends nothing for a historical account with no rebate left', () => {
    for (const available of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(affiliateTransferQuota({ wholeOnly: true, amount: '1', available, quotaPerUnit: 1 })).toBeNull()
    }
  })

  it('keeps the Xingmang account on whole units and lets it move part of the rebate', () => {
    expect(affiliateTransferQuota({ wholeOnly: false, amount: '0.4', available: 100, quotaPerUnit: 100 })).toBe(40)
    expect(affiliateTransferQuota({ wholeOnly: false, amount: '1', available: 100, quotaPerUnit: 100 })).toBe(100)
    expect(affiliateTransferQuota({ wholeOnly: false, amount: '3.5', available: 2_000_000, quotaPerUnit: 500_000 })).toBe(1_750_000)
    for (const amount of ['', '0', '-1', 'abc', '1.01']) {
      expect(affiliateTransferQuota({ wholeOnly: false, amount, available: 100, quotaPerUnit: 100 })).toBeNull()
    }
  })
})

describe('affiliateTransferTitleQuota', () => {
  it('names the part being moved instead of the whole rebate on a Xingmang account', () => {
    // 余额 F8-1：可转 $10、填了 $3，标题以前还写「把 $10.00 返利转入余额？」。
    expect(affiliateTransferTitleQuota({ wholeOnly: false, amount: '3', available: 5_000_000, quotaPerUnit: 500_000 })).toBe(1_500_000)
    expect(affiliateTransferTitleQuota({ wholeOnly: false, amount: '10', available: 5_000_000, quotaPerUnit: 500_000 })).toBe(5_000_000)
  })

  it('rounds the same way as the quota that is sent', () => {
    for (const amount of ['3.456', '0.4', '1.234567', '2']) {
      const input = { wholeOnly: false, amount, available: 5_000_000, quotaPerUnit: 500_000 }
      expect(affiliateTransferTitleQuota(input)).toBe(affiliateTransferQuota(input))
    }
  })

  it('names what was typed even when it is more than the rebate, so the title matches the field', () => {
    expect(affiliateTransferTitleQuota({ wholeOnly: false, amount: '20', available: 5_000_000, quotaPerUnit: 500_000 })).toBe(10_000_000)
  })

  it('falls back to the whole rebate while the field holds no positive amount', () => {
    for (const amount of ['', ' ', '0', '-1', 'abc', '0.0000001']) {
      expect(affiliateTransferTitleQuota({ wholeOnly: false, amount, available: 5_000_000, quotaPerUnit: 500_000 })).toBe(5_000_000)
    }
  })

  it('always names the whole rebate on a historical account, whatever the field holds', () => {
    for (const amount of ['', '1', '3.456']) {
      expect(affiliateTransferTitleQuota({ wholeOnly: true, amount, available: 3.456, quotaPerUnit: 1 })).toBe(3.456)
    }
  })
})

describe('passwordChangeFailure', () => {
  it('turns the main process\'s "no answer" sentence into the advice the password dialog shows (N6)', () => {
    const unconfirmed = new Error(`Error invoking remote method 'account:change-password': Error: ${passwordChangeUnconfirmedMessage}`)
    const shown = passwordChangeFailure(unconfirmed)
    expect(shown).toBeInstanceOf(Error)
    expect(errorMessage(shown)).toBe(passwordChangeUnconfirmedNotice)
    expect(passwordChangeUnconfirmedNotice).toBe('没等到账号服务的回话，新密码可能已经改好了。先别再改一次：下次登录时先试新密码，登不上再用原来的密码。')
  })

  it('hands every other failure on untouched', () => {
    const wrong = new Error("Error invoking remote method 'account:change-password': Error: 原密码错误")
    const timeout = new Error('连接账号服务超时，请检查网络后再试。')
    expect(passwordChangeFailure(wrong)).toBe(wrong)
    expect(passwordChangeFailure(timeout)).toBe(timeout)
    const longer = new Error(`前面还有话${passwordChangeUnconfirmedMessage}`)
    expect(passwordChangeFailure(longer)).toBe(longer)
  })
})

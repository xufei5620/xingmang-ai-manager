import type { AccountLoginSession, AccountSubscriptionBillingPreference, AccountSubscriptionSelf } from '../../../../electron/ipc-contract'
import { subscriptionExpiringDays, subscriptionLowUsd } from '../../../../electron/subscription-summary'

/**
 * 个人中心 v4（账号概览、账号安全、密钥管理、邀请返利）上那些由数据拼出来的话。都是纯函数，
 * 页面只管摆；字以字表批06为准，测试钉着。
 */

type Subscription = AccountSubscriptionSelf['activeSubscriptions'][number]

const dayMs = 86_400_000
const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 「10 月 3 日」；不是今年的写上年份，免得把明年到期看成今年。 */
export function shortDate(value: string | number | Date, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  return date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()} 年 ${day}`
}

export interface SpendDay {
  /** 本地零点（毫秒）。 */
  start: number
  /** 这一天结束（毫秒，不含）；今天到「现在」为止。 */
  end: number
  /** 柱子下面那个字：前六天写周几，最后一天写「今天」。 */
  label: string
}

/**
 * 「近 7 天花费」七根柱子各管哪一段。按本机的零点切：后台按天汇总时是按 UTC 零点切的，
 * 北京时间早上 8 点前「今天」那根会算到前一天去，所以一天一段分开读（每段不超过一天，
 * 后台按小时汇总），只取每段的合计。
 */
export function localSpendDays(now: Date, days = 7): SpendDay[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const result: SpendDay[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
    const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset + 1)
    result.push({
      start: start.getTime(),
      end: offset === 0 ? now.getTime() : next.getTime(),
      label: offset === 0 ? '今天' : weekdayNames[start.getDay()],
    })
  }
  return result
}

/**
 * 一段的查询区间（秒）：后台按「开始 ≤ 时间 ≤ 结束」取，相邻两段接缝那一秒不能算两遍，
 * 只有最后一段算到「现在」那一秒。账号概览的「近 7 天」和用量账单的每根柱子都按这个问。
 */
export function spendSegmentQuery(segment: Pick<SpendDay, 'start' | 'end'>, last: boolean): { startTimestamp: number; endTimestamp: number } {
  const startTimestamp = Math.floor(segment.start / 1000)
  return { startTimestamp, endTimestamp: Math.max(startTimestamp, Math.floor(segment.end / 1000) - (last ? 0 : 1)) }
}

/** 悬停在一根柱子上的那句：「10 月 3 日 周五：$1.20」。 */
export function spendDayTitle(day: Pick<SpendDay, 'start'>, amount: string): string {
  const date = new Date(day.start)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${weekdayNames[date.getDay()]}：${amount}`
}

/** 每根柱子的高度（百分比）：最多的那天算满；有花费的再少也留一点，看得出不是 0。 */
export function spendBarHeights(amounts: readonly number[]): number[] {
  const max = Math.max(0, ...amounts)
  return amounts.map((amount) => max > 0 && amount > 0 ? Math.max(4, Math.round(amount / max * 100)) : 0)
}

/** 余额下面那行「还能用多久」，和首页同一个算法（balance-runway），这里只管怎么说。 */
export function runwayDaysText(days: number): string {
  if (days > 365) return '按最近用量够用一年以上'
  if (days < 1) return '按最近用量不到 1 天就会用完'
  return `按最近用量约还能用 ${days} 天`
}

export interface SubscriptionOverview {
  name: string | null
  endsAt: string
  /** 已用和总额（美元）；不限额或后台没给能算的数时为 null，就不画进度条。 */
  usedUsd: number | null
  totalUsd: number | null
  /** 快到期或快用完：标签写「快用完了」，链接写「去续费」。 */
  short: boolean
  preference: AccountSubscriptionBillingPreference | null
}

function usageOf(subscription: Subscription, quotaPerUnit: number): { used: number; total: number } | null {
  if (subscription.quotaPeriods) {
    // 历史账号按日、周、月各有一个上限，最紧的那个说了算（同 subscription-summary）。
    let tightest: { used: number; total: number } | null = null
    for (const period of subscription.quotaPeriods) {
      if (period.limitState !== 'limited' || period.limit === null || period.used === null || period.limit <= 0) continue
      if (!tightest || period.limit - period.used < tightest.total - tightest.used) tightest = { used: period.used, total: period.limit }
    }
    return tightest
  }
  const total = subscription.amountTotal ?? 0
  if (total <= 0 || !(quotaPerUnit > 0)) return null
  return { used: (subscription.amountUsed ?? 0) / quotaPerUnit, total: total / quotaPerUnit }
}

/**
 * 「我的订阅」那张卡说哪一份：生效中、还没到期的里头到期最晚的那份。和首页「另有……」那行
 * 不一样，扣费顺序是「只用余额」时也照样列出来，订阅确实还在；没有就是 null（「没有订阅」）。
 */
export function subscriptionOverview(
  self: Pick<AccountSubscriptionSelf, 'billingPreference' | 'activeSubscriptions'> | null | undefined,
  { now, quotaPerUnit, planNames }: { now: number; quotaPerUnit: number; planNames?: ReadonlyMap<number, string> },
): SubscriptionOverview | null {
  if (!self) return null
  let best: Subscription | null = null
  for (const subscription of self.activeSubscriptions) {
    if (subscription.status !== 'active') continue
    const ends = Date.parse(subscription.endsAt)
    if (!Number.isFinite(ends) || ends <= now) continue
    if (!best || ends > Date.parse(best.endsAt)) best = subscription
  }
  if (!best) return null
  const usage = usageOf(best, quotaPerUnit)
  const remaining = usage ? Math.max(0, usage.total - usage.used) : null
  return {
    name: best.groupName?.trim() || planNames?.get(best.planId)?.trim() || null,
    endsAt: best.endsAt,
    usedUsd: usage ? Math.min(usage.used, usage.total) : null,
    totalUsd: usage ? usage.total : null,
    short: Date.parse(best.endsAt) - now <= subscriptionExpiringDays * dayMs || (remaining !== null && remaining < subscriptionLowUsd),
    preference: self.billingPreference,
  }
}

/** 订阅卡正文：「{套餐名}，{月} 月 {日} 日到期」；没有名字时只说哪天到期。 */
export function subscriptionOverviewText(subscription: Pick<SubscriptionOverview, 'name' | 'endsAt'>, now: Date = new Date()): string {
  const ends = `${shortDate(subscription.endsAt, now)}到期`
  return subscription.name ? `${subscription.name}，${ends}` : ends
}

/** 账号概览「密钥与设备」那一行：「3 把，1 把正在被工具使用」；没有工具在用时只写把数。 */
export function keyCountText(total: number, inUse: number): string {
  return inUse > 0 ? `${total} 把，${inUse} 把正在被工具使用` : `${total} 把`
}

/** 邀请卡、邀请页的那句比例；后台没给比例就不写数。 */
export function inviteRateText(rate: number | null | undefined): string {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? `好友充值后返你 ${rate}%` : '好友充值后你能拿返利'
}
export function inviteRuleText(rate: number | null | undefined): string {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
    ? `好友用你的链接注册并充值，你得到充值金额的 ${rate}%。`
    : '好友用你的链接注册并充值后，你能拿到返利。'
}

/**
 * 登录设备那一行的小字：这台是「正在使用」；别的写多久以前活动过、从哪个地址。后台没给地址
 * 或时间的那一半就不写。
 */
export function deviceActivityText(session: Pick<AccountLoginSession, 'current' | 'ip' | 'lastActiveAt'>, now: number): string {
  if (session.current) return '正在使用'
  const at = Date.parse(session.lastActiveAt)
  let when = ''
  if (Number.isFinite(at)) {
    const elapsed = Math.max(0, now - at)
    if (elapsed >= dayMs) when = `${Math.floor(elapsed / dayMs)} 天前活动`
    else if (elapsed >= 3_600_000) when = `${Math.floor(elapsed / 3_600_000)} 小时前活动`
    else when = '刚刚活动'
  }
  return [when, session.ip.trim()].filter(Boolean).join(' · ')
}

export interface PasswordRules {
  minimum: number
  maximum: number
}

/** 两种账号的密码长度不一样（T12）：历史账号 6 至 256 位，星芒账号 8 至 20 位。 */
export function passwordRules(siteId: 'solov' | 'solov-api'): PasswordRules {
  return siteId === 'solov-api' ? { minimum: 6, maximum: 256 } : { minimum: 8, maximum: 20 }
}

/** 修改密码弹窗点「保存新密码」之前的检查；不过就抛出那一句。 */
export function validatePasswordChange(input: { originalPassword: string; password: string; confirmPassword: string }, rules: PasswordRules): void {
  if (!input.originalPassword) throw new Error('请输入原密码')
  if (input.password.length < rules.minimum) throw new Error(`新密码至少 ${rules.minimum} 位`)
  if (input.password.length > rules.maximum) throw new Error(`新密码不能超过 ${rules.maximum} 位`)
  if (input.password !== input.confirmPassword) throw new Error('两次密码不一致')
}

export type KeyExpiryChoice = 'keep' | 'never' | '30' | '90' | 'custom'

/**
 * 密钥「到期时间」分段换成后台要的 Unix 秒；-1 = 永不过期。keep（编辑时「不改」）原样写回
 * 读到的那个（current），自定日期要晚于现在。
 */
export function keyExpiredTime(choice: KeyExpiryChoice, { custom, current, now }: { custom: string; current: number; now: number }): number {
  if (choice === 'keep') return current
  if (choice === 'never') return -1
  if (choice === '30' || choice === '90') return Math.floor((now + Number(choice) * dayMs) / 1000)
  if (!custom) throw new Error('请选一个到期日期')
  const at = new Date(custom).getTime()
  if (!Number.isFinite(at) || at <= now) throw new Error('到期时间必须晚于现在。')
  return Math.floor(at / 1000)
}

/** 编辑时「不改」下面那行「现在：{X}」的 X。 */
export function currentExpiryText(expiredAt: string | null, now: Date = new Date()): string {
  return expiredAt ? `${shortDate(expiredAt, now)}到期` : '永不过期'
}

/** 密钥那一行的小字：已用多少、还剩多少（或不限额度）、哪天到期、哪天建的。 */
export function keyMetaParts(
  key: { usedQuota: number; remainQuota: number; unlimitedQuota: boolean; expiredAt: string | null; createdAt: string },
  money: (quota: number) => string,
  now: Date = new Date(),
): string[] {
  const created = shortDate(key.createdAt, now)
  return [
    `已用 ${money(key.usedQuota)}`,
    key.unlimitedQuota ? '不限额度' : `剩余 ${money(key.remainQuota)}`,
    currentExpiryText(key.expiredAt, now),
    ...(created ? [`${created}创建`] : []),
  ]
}

/**
 * 「配置到工具」下拉里这个工具算不算装了：每一份检测结果没检测成是 null（不拦），装了是 true。
 * Codex CLI 和 Codex 桌面端共用一份配置，只装了桌面端也能把密钥写进去，所以两份合起来看，有一份装了就算装了。
 */
export function keyToolInstalled(statuses: ReadonlyArray<{ installed: boolean; detectionFailed?: boolean }>): boolean | null {
  const results = statuses.map((status) => status.detectionFailed ? null : status.installed)
  if (results.includes(true)) return true
  return results.includes(null) ? null : false
}

export interface KeyToolTarget {
  provider: 'claude' | 'codex' | 'grok'
  name: string
  /** 装没装；首页还没检测完时为 null，那就不拦。 */
  installed: boolean | null
  /** 现在用的是官方账号登录。 */
  official: boolean
}

/**
 * 「配置到工具」下拉里那个工具后面的小字和能不能点：已经在用这把的写「在用」、没装的写「未安装」，
 * 这两种点了也没意义；用官方账号的提醒一句，写进去会改用当前账号。
 */
export function keyToolChoice(target: KeyToolTarget, inUse: boolean): { hint: string; disabled: boolean } {
  if (inUse) return { hint: '在用', disabled: true }
  if (target.installed === false) return { hint: '未安装', disabled: true }
  return { hint: target.official ? '官方账号' : '', disabled: false }
}

// 翻页的安全阀，同主进程 account-key-quota 的那一个：一万把已经远超正常账号，翻到这里还没见底多半是后端分页出了问题。
const keyCountPageSize = 100
const keyCountPageLimit = 100

/**
 * 「密钥与设备」那张卡上的把数。后台一页最多给 100 把，工具在用的那把可能在后面几页，所以一直翻到见底再数「在用」；
 * 按已经看到的条数判断见底（同 account-key-quota），真翻到安全阀还没见底，就按已经看到的那些数。
 */
export async function countAccountKeys(
  listKeys: (query: { page: number; pageSize: number }) => Promise<{ total: number; keys: ReadonlyArray<{ managedProvider?: string }> }>,
  isInUse: (provider: string | undefined) => boolean,
): Promise<{ total: number; inUse: number }> {
  let total = 0
  let seen = 0
  let inUse = 0
  for (let page = 1; page <= keyCountPageLimit; page++) {
    const batch = await listKeys({ page, pageSize: keyCountPageSize })
    total = batch.total
    seen += batch.keys.length
    inUse += batch.keys.filter((key) => isInUse(key.managedProvider)).length
    if (!batch.keys.length || seen >= batch.total) break
  }
  return { total, inUse }
}

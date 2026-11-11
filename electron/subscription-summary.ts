// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

/**
 * 买了订阅的客户，钱包常常是 0：请求实际扣的是订阅，AI 工具照常能用，可首页、
 * 托盘和通知只看钱包，一直说「余额只剩 $0」，客户以为还得再充一笔（第十五批 2）。
 * 这里只回答一个问题：当前账号有没有一份「现在就能扣」的订阅，有的话剩多少、
 * 哪天到期。首页、跌破 $5 的通知（渲染层）和托盘（主进程）读的是同一个判断。
 *
 * 与 network-failure.ts 同理：这个模块进渲染包，永远不许依赖 node 或 electron
 * （I6，门禁见 scripts/verify-renderer-boundary.test.cjs 的 valueImportable）。
 */
import type { NewApiBillingPreference, NewApiSubscription, NewApiSubscriptionSelf, SubscriptionQuotaPeriod } from './new-api-client'

/** 到期前几天开始提醒续费。 */
export const subscriptionExpiringDays = 3
/** 剩余额度低于这个美元数就当「快用完」，和钱包的红线同一条。 */
export const subscriptionLowUsd = 5

export interface UsableSubscription {
  /** 套餐名；两个后端都拿不到时为 null，界面就不写名字。 */
  name: string | null
  /** 剩余美元；null = 不限额，或服务端没给出能算的数。 */
  remainingUsd: number | null
  endsAt: string
  expiringSoon: boolean
  lowRemaining: boolean
  /** 扣费偏好是「只用订阅」：到期或用完后不会转去扣余额。 */
  subscriptionOnly: boolean
  /** 剩余额度下次恢复的时间；不限额、不会再恢复或读不到时为 null，缺省同 null。 */
  resetsAt?: string | null
}

const dayMs = 86_400_000
const windowLengthMs: Record<SubscriptionQuotaPeriod['period'], number> = { daily: dayMs, weekly: 7 * dayMs, monthly: 30 * dayMs }

type ResettableSubscription = Pick<NewApiSubscription, 'status' | 'startedAt' | 'endsAt'>

/** 还在以后、又赶在到期之前的那一刻才算「会恢复」：到期那一刻以后再清零没有意义。 */
function upcoming(at: number, subscription: ResettableSubscription, now: number): string | null {
  const ends = Date.parse(subscription.endsAt)
  if (subscription.status !== 'active' || !Number.isFinite(at) || at <= now || !Number.isFinite(ends) || at >= ends) return null
  return new Date(at).toISOString()
}

/**
 * 历史账号一个额度窗口下次清零的时间；窗口还没开始算、这一期内不会再清零时为 null。
 *
 * Mirrors Wei-Shaw/sub2api backend/internal/service/user_subscription.go
 * (DailyResetTime / WeeklyResetTime / MonthlyResetTime / windowResetAnchor),
 * read on 2026-11-11 at main; the window rules are unchanged since the 270eac6
 * baseline in docs/archive/reliability-sub2api-2026-09-18.md:
 * - daily windows follow the server's calendar day. Every writer stores the
 *   window start as that day's 00:00 (server timezone), so the next reset is
 *   start + 24h without knowing which timezone the server runs in. A plan that
 *   lasts one day or less gets a one-time daily quota that never resets.
 * - weekly / monthly windows roll every 7 / 30 days from their anchor. Early
 *   rows anchored the first window at 00:00 of the start day; the server
 *   advances those from StartsAt instead, so do we.
 * - a null window start means the window has not been opened yet or has
 *   already lapsed (the server then reports its usage as 0): nothing to wait for.
 */
export function quotaPeriodResetAt(subscription: ResettableSubscription, period: SubscriptionQuotaPeriod, now: number): string | null {
  if (!period.windowStartedAt) return null
  const windowStart = Date.parse(period.windowStartedAt)
  const started = Date.parse(subscription.startedAt)
  if (!Number.isFinite(windowStart)) return null
  if (period.period === 'daily') {
    const ends = Date.parse(subscription.endsAt)
    if (Number.isFinite(started) && Number.isFinite(ends) && ends - started <= dayMs) return null
    return upcoming(windowStart + dayMs, subscription, now)
  }
  const anchor = Number.isFinite(started) && windowStart < started && started - windowStart < dayMs ? started : windowStart
  return upcoming(anchor + windowLengthMs[period.period], subscription, now)
}

/**
 * 「剩余 …」那个数下次什么时候变回来。星芒账号是服务端给的下次重置时间；历史账号按日、周、月
 * 各算各的，剩得最少的那个窗口说了算，几个窗口一样少时等最晚清零的那个。
 */
export function subscriptionResetAt(subscription: ResettableSubscription & Pick<NewApiSubscription, 'quotaPeriods' | 'nextResetAt'>, now: number): string | null {
  if (!subscription.quotaPeriods) {
    return subscription.nextResetAt ? upcoming(Date.parse(subscription.nextResetAt), subscription, now) : null
  }
  let tightest: number | null = null
  let resetsAt: string | null = null
  for (const period of subscription.quotaPeriods) {
    if (period.limitState !== 'limited' || period.limit === null || period.used === null) continue
    const left = Math.max(0, period.limit - period.used)
    const at = quotaPeriodResetAt(subscription, period, now)
    if (tightest === null || left < tightest) {
      tightest = left
      resetsAt = at
    } else if (left === tightest) {
      resetsAt = resetsAt === null || at === null ? null : Date.parse(at) > Date.parse(resetsAt) ? at : resetsAt
    }
  }
  return resetsAt
}

function remainingOf(subscription: NewApiSubscription, quotaPerUnit: number): { usable: boolean; remainingUsd: number | null } {
  if (subscription.quotaPeriods) {
    // Sub2API reports independent daily/weekly/monthly USD windows. The tightest
    // limited window decides whether a request can be billed right now.
    let remaining: number | null = null
    for (const period of subscription.quotaPeriods) {
      if (period.limitState !== 'limited' || period.limit === null || period.used === null) continue
      const left = Math.max(0, period.limit - period.used)
      remaining = remaining === null ? left : Math.min(remaining, left)
    }
    return { usable: remaining === null || remaining > 0, remainingUsd: remaining }
  }
  // new-api: amount_total 0 means the plan has no quota cap.
  const total = subscription.amountTotal ?? 0
  if (total <= 0) return { usable: true, remainingUsd: null }
  const left = Math.max(0, total - (subscription.amountUsed ?? 0))
  return { usable: left > 0, remainingUsd: quotaPerUnit > 0 ? left / quotaPerUnit : null }
}

/**
 * 有生效中、没过期、还有剩余额度的订阅，且扣费偏好不是「只用余额」时，返回到期
 * 最晚的那一份；否则 null（界面一切照旧按钱包说）。
 */
export function resolveUsableSubscription(
  self: Pick<NewApiSubscriptionSelf, 'billingPreference' | 'activeSubscriptions'> | null | undefined,
  { now, quotaPerUnit, planNames }: { now: number; quotaPerUnit: number; planNames?: ReadonlyMap<number, string> },
): UsableSubscription | null {
  if (!self) return null
  const preference: NewApiBillingPreference = self.billingPreference ?? 'subscription_first'
  if (preference === 'wallet_only') return null
  let best: UsableSubscription | null = null
  let bestEnds = 0
  for (const subscription of self.activeSubscriptions) {
    if (subscription.status !== 'active') continue
    const ends = Date.parse(subscription.endsAt)
    if (!Number.isFinite(ends) || ends <= now) continue
    const { usable, remainingUsd } = remainingOf(subscription, quotaPerUnit)
    if (!usable || ends <= bestEnds) continue
    bestEnds = ends
    best = {
      name: subscription.groupName?.trim() || planNames?.get(subscription.planId)?.trim() || null,
      remainingUsd,
      endsAt: subscription.endsAt,
      expiringSoon: ends - now <= subscriptionExpiringDays * 86_400_000,
      lowRemaining: remainingUsd !== null && remainingUsd < subscriptionLowUsd,
      subscriptionOnly: preference === 'subscription_only',
      resetsAt: remainingUsd === null ? null : subscriptionResetAt(subscription, now),
    }
  }
  return best
}

/**
 * 「10月3日」，按本机时区；不是今年的写上年份，一年期套餐别看成今天就到期（D52，规矩同个人中心的
 * shortDate；日期写法统一不带空格，同 calendar-time）。
 */
export function subscriptionEndDate(endsAt: string, now: Date = new Date()): string {
  const date = new Date(endsAt)
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}年${day}`
}

function pad(value: number): string { return String(value).padStart(2, '0') }

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 「明天 00:00」：额度下次恢复的那一刻，按本机时区。今天、明天直接说，再往后写日期（不是今年的带
 * 年份）；已经过了或读不出时为 null，就不写这一截。
 */
export function subscriptionResetTime(resetsAt: string, now: Date = new Date()): string | null {
  const date = new Date(resetsAt)
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now.getTime()) return null
  // 按日历天数差算；round 吸收夏令时那一天多出或少掉的一小时（同 calendar-time）。
  const days = Math.round((startOfLocalDay(date) - startOfLocalDay(now)) / dayMs)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 0) return `今天 ${clock}`
  if (days === 1) return `明天 ${clock}`
  return `${subscriptionEndDate(resetsAt, now)} ${clock}`
}

/**
 * 「剩余 $3.20 · 明天 00:00 恢复 · 10月3日到期」；读不到恢复时间就不写中间那截，不限额时只说到期日
 * （D60）。money 由调用方给，托盘和首页的金额写法不一样。
 */
export function subscriptionSummaryText(subscription: UsableSubscription, money: (usd: number) => string, now: Date = new Date()): string {
  const end = `${subscriptionEndDate(subscription.endsAt, now)}到期`
  if (subscription.remainingUsd === null) return end
  const reset = subscription.resetsAt ? subscriptionResetTime(subscription.resetsAt, now) : null
  return [`剩余 ${money(subscription.remainingUsd)}`, reset && `${reset} 恢复`, end].filter(Boolean).join(' · ')
}

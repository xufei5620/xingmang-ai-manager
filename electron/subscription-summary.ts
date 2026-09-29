/**
 * 买了订阅的客户，钱包常常是 0：请求实际扣的是订阅，AI 工具照常能用，可首页、
 * 托盘和通知只看钱包，一直说「余额只剩 $0」，客户以为还得再充一笔（第十五批 2）。
 * 这里只回答一个问题：当前账号有没有一份「现在就能扣」的订阅，有的话剩多少、
 * 哪天到期。首页、跌破 $5 的通知（渲染层）和托盘（主进程）读的是同一个判断。
 *
 * 与 network-failure.ts 同理：这个模块进渲染包，永远不许依赖 node 或 electron
 * （I6，门禁见 scripts/verify-renderer-boundary.test.cjs 的 valueImportable）。
 */
import type { NewApiBillingPreference, NewApiSubscription, NewApiSubscriptionSelf } from './new-api-client'

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
    }
  }
  return best
}

/** 「10 月 3 日」，按本机时区。 */
export function subscriptionEndDate(endsAt: string): string {
  const date = new Date(endsAt)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/**
 * 「剩余 $12.30 · 10 月 3 日到期」；不限额时只说到期日。money 由调用方给，
 * 托盘和首页的金额写法不一样。
 */
export function subscriptionSummaryText(subscription: UsableSubscription, money: (usd: number) => string): string {
  const end = `${subscriptionEndDate(subscription.endsAt)}到期`
  return subscription.remainingUsd === null ? end : `剩余 ${money(subscription.remainingUsd)} · ${end}`
}

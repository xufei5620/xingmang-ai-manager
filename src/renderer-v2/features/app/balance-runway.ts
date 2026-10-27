import { useEffect, useRef, useState } from 'react'
import type { UsableSubscription } from '../../../../electron/subscription-summary'
import type { BalanceUsage, ToolsApi } from '../tools/api'

/**
 * 「余额还能用多久」：侧栏账号卡上那行小字、进度条，和侧栏「充值」后面的「余额低」读同一个判断
 * （v4 方案问 6）。按最近 7 天的用量算，订阅剩下的额度也算进去；算不出用量时退回「不到 $5」。
 */
export interface BalanceRunway {
  /** 能花的美元：钱包加上订阅剩下的；订阅不限额时为 null。 */
  usableUsd: number | null
  /** 约还能用几天；订阅不限额、最近 7 天没用量或用量还没读到时为 null。 */
  days: number | null
  low: boolean
  /** 钱包是 $0、也没有订阅（和首页 homeWalletEmpty 同一个判断）：几处不再说「不到 1 天就会用完」，改说用完了。缺省 = 不是。 */
  empty?: boolean
}

/** 按最近用量不够这么多天就算余额低。 */
export const lowRunwayDays = 7
/** 算不出用量时的退路，和「余额跌破 $5」那条提醒同一个数。 */
export const lowBalanceFallbackUsd = 5
/** 进度条按这么多天算满。 */
const fullRunwayDays = 30

export function buildBalanceRunway({ walletUsd, subscription, weekUsageUsd }: {
  walletUsd: number | null
  subscription: UsableSubscription | null
  /** 最近 7 天花了多少美元；没读到为 null。 */
  weekUsageUsd: number | null
}): BalanceRunway | null {
  if (walletUsd === null) return null
  // 「只用订阅」的账号钱包里的钱不会被扣，只算订阅剩下的。
  const usableUsd = !subscription ? walletUsd
    : subscription.remainingUsd === null ? null
      : subscription.subscriptionOnly ? subscription.remainingUsd
        : walletUsd + subscription.remainingUsd
  const days = usableUsd !== null && weekUsageUsd !== null && weekUsageUsd > 0
    ? Math.max(0, Math.floor(usableUsd / (weekUsageUsd / 7)))
    : null
  const low = days !== null ? days < lowRunwayDays : usableUsd !== null && usableUsd < lowBalanceFallbackUsd
  return { usableUsd, days, low, ...(!subscription && walletUsd <= 0 ? { empty: true as const } : {}) }
}

/** 钱包是 $0、没订阅、按最近用量算出来「0 天」：这时说「不到 1 天就会用完」是错的，钱已经没了。 */
export function balanceRunwayEmpty(runway: BalanceRunway | null): runway is BalanceRunway & { days: number } {
  return runway?.empty === true && runway.days !== null && runway.days < 1
}

/** 账号卡上那行小字；天数算不出来时为 null，那一行留给别的说明。 */
export function balanceRunwayText(runway: BalanceRunway | null): string | null {
  if (!runway || runway.days === null) return null
  if (balanceRunwayEmpty(runway)) return '余额已经用完，充值后才能用'
  const lead = runway.low ? '余额不多了，' : '按最近用量，'
  if (runway.days > 365) return `${lead}够用一年以上`
  if (runway.days < 1) return `${lead}不到 1 天就会用完`
  return `${lead}约还能用 ${runway.days} 天`
}

/** 进度条宽度（百分比）：30 天算满，再少也留一点，看得出是条进度条。 */
export function balanceRunwayMeter(days: number): number {
  return Math.max(6, Math.min(100, Math.round(days / fullRunwayDays * 100)))
}

/** 侧栏一直在，用量却要多问后台两次：换账号时读一次，之后最多十分钟一次。 */
export const runwayUsageRefreshMs = 10 * 60_000

/**
 * 账号卡要的最近用量。跟着余额刷新（tick）看一眼：首页一分钟内读过的直接拿来，
 * 离上次自己读不到十分钟就不再问后台。scope 为 null（没登录、这个账号看不了用量）时不读。
 */
export function useRunwayUsage(api: Pick<ToolsApi, 'balanceUsage' | 'peekBalanceUsage'>, scope: string | null, tick: number | undefined): BalanceUsage | null {
  const [usage, setUsage] = useState<{ scope: string; usage: BalanceUsage } | null>(null)
  const loadedAt = useRef<{ scope: string; at: number } | null>(null)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  useEffect(() => {
    if (!scope) return
    const peeked = api.peekBalanceUsage(scope)
    if (peeked) setUsage({ scope, usage: peeked })
    const last = loadedAt.current
    if (last?.scope === scope && Date.now() - last.at < runwayUsageRefreshMs) return
    loadedAt.current = { scope, at: Date.now() }
    // 换了账号，上一个账号的用量回来了也不要。
    api.balanceUsage(scope).then((value) => { if (scopeRef.current === scope) setUsage({ scope, usage: value }) }, () => undefined)
  }, [api, scope, tick])
  return usage && usage.scope === scope ? usage.usage : null
}

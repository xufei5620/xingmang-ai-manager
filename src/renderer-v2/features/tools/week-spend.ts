import type { XingmangApi } from '../../../../electron/ipc-contract'
import { accountScope } from '../../account-context'
import { dollars } from '../../business-common'
import { createTtlCache } from './ttl-cache'

/**
 * 首页余额卡「近 7 天花费」的七根小柱子（v4 批 04）。一根是本机时区的一个自然日，最后一根是今天到现在。
 * 看板接口查 24 小时以内按小时分桶、超过就按 UTC 的天分桶：一次查七天，北京时间的「一天」会被
 * 切在下午四点。所以按本机的天一天查一次，只要每次查回来的合计。过完的天不会再变，记下来
 * 不再查，之后每次刷新只查今天这一根。
 */
export interface WeekSpendDay {
  /** 本机这一天 0 点（毫秒）。 */
  start: number
  /** 查到哪一刻为止（毫秒）：过完的天是下一天 0 点的前一秒，今天是现在。 */
  end: number
}

export function weekSpendDays(now: Date): WeekSpendDay[] {
  const days: WeekSpendDay[] = []
  for (let offset = 6; offset >= 0; offset--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset + 1).getTime()
    // 看板接口两头都算在内：过完的天截到下一天 0 点的前一秒，那一整点的数才不会两天都算一遍。
    days.push({ start, end: offset === 0 ? now.getTime() : next - 1000 })
  }
  return days
}

const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 柱子下面那个字：「周四」，最后一根写「今天」。 */
export function weekSpendLabel(start: number, today: boolean): string {
  return today ? '今天' : weekdayNames[new Date(start).getDay()]
}

/** 指到柱子上的那句：「10月8日 周四：$1.20」。 */
export function weekSpendHint(start: number, usd: number): string {
  const date = new Date(start)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdayNames[date.getDay()]}：${dollars(usd)}`
}

export interface WeekSpend {
  /** 哪个账号查的：换账号那一帧不能把上一个账号的柱子摆出来。 */
  scope: string
  days: Array<WeekSpendDay & { quota: number }>
}

/** 和余额卡上的用量同一个有效期：一分钟内回首页不再问后台。 */
export const weekSpendTtlMs = 60_000

export function createWeekSpendLoader(bridge: Pick<XingmangApi, 'getAccountSession' | 'getAccountDashboard'>, now: () => Date = () => new Date()) {
  // 过完的那几天：账号 + 那天 0 点 → 当天花了多少（额度单位）。
  const settled = new Map<string, number>()
  async function load(): Promise<WeekSpend> {
    const session = await bridge.getAccountSession()
    const scope = accountScope(session)
    const days = weekSpendDays(now())
    const quotas = await Promise.all(days.map(async (day, index) => {
      const key = `${scope}:${day.start}`
      const today = index === days.length - 1
      const known = settled.get(key)
      if (!today && known !== undefined) return known
      const data = await bridge.getAccountDashboard({ startTimestamp: Math.floor(day.start / 1000), endTimestamp: Math.floor(day.end / 1000) })
      // 只给全部累计、不分时段的后台画不出每天一根柱子。
      if (data.coverage === 'all-time-summary') throw new Error('这个账号读不出每天的花费')
      if (!today) settled.set(key, data.quota)
      return data.quota
    }))
    return { scope, days: days.map((day, index) => ({ ...day, quota: quotas[index] })) }
  }
  const cache = createTtlCache({ ttlMs: weekSpendTtlMs, load })
  return {
    /** scope 传了而缓存不是这个账号查的（换账号那一瞬间），作废后重查。 */
    async read(scope?: string): Promise<WeekSpend> {
      const owned = await cache.read()
      if (scope === undefined || owned.scope === scope) return owned
      cache.invalidate()
      return cache.read()
    },
    peek(scope: string): WeekSpend | null {
      const owned = cache.peek()
      return owned && owned.scope === scope ? owned : null
    },
    invalidate(): void {
      cache.invalidate()
      settled.clear()
    },
  }
}

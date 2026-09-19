import type { ManagedCliKeyLimit } from '../../../../electron/account-key-quota'
import type { ProviderId } from '../../../../electron/catalog'
import { dollars } from '../../business-common'
import { tools } from '../../registry/tools'

export interface ToolUsageRow {
  provider: ProviderId
  name: string
  /** 当前账号里已经签发过这个工具的托管密钥。没有就是这个工具还没配过。 */
  enabled: boolean
  unlimited: boolean
  /** 这个工具累计用掉多少(金额);没有密钥或后端没给数字时为 null。 */
  used: number | null
  /** 额度还剩多少;不限额或读不到时为 null。 */
  remaining: number | null
  /** 已用与剩余之和,也就是这个工具当前的额度;不限额或读不到时为 null。 */
  allowance: number | null
  /** 已用量占当前账号所有工具已用量的比例(0~1);没有任何用量时为 null。 */
  share: number | null
}

export interface ToolUsageSummary {
  rows: ToolUsageRow[]
  /** 各工具已用量之和;一把密钥都没有时为 null。 */
  used: number | null
  enabledCount: number
  /** 用得最多的那个工具;还没有任何用量时为 null。 */
  top: ToolUsageRow | null
}

export function toolUsageName(provider: ProviderId): string {
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}

// 额度是「还能再用多少」而不是月度预算(N4 拍板),所以这里的已用量也是
// 累计值,不是本月值。文案必须跟着说「累计」,否则用户会拿它当月账单看。
export function buildToolUsageSummary(limits: readonly ManagedCliKeyLimit[]): ToolUsageSummary {
  const counted = limits.filter((limit) => limit.key && typeof limit.used === 'number')
  const used = counted.length ? counted.reduce((sum, limit) => sum + (limit.used ?? 0), 0) : null
  const rows = limits.map((limit) => {
    const amount = limit.key ? limit.used : null
    return {
      provider: limit.provider,
      name: toolUsageName(limit.provider),
      enabled: Boolean(limit.key),
      unlimited: limit.unlimited,
      used: amount,
      remaining: limit.remaining,
      allowance:
        limit.unlimited || amount === null || limit.remaining === null ? null : amount + limit.remaining,
      share: used !== null && used > 0 && amount !== null ? amount / used : null,
    }
  })
  const ranked = rows.filter((row) => (row.used ?? 0) > 0).sort((left, right) => (right.used ?? 0) - (left.used ?? 0))
  return {
    rows,
    used,
    enabledCount: rows.filter((row) => row.enabled).length,
    top: ranked[0] ?? null,
  }
}

export function toolUsageShare(row: ToolUsageRow): string {
  if (row.share === null) return '—'
  const percent = Math.round(row.share * 100)
  if (percent === 0) return row.share > 0 ? '<1%' : '0%'
  return `${percent}%`
}

export function toolUsageUsed(row: ToolUsageRow): string {
  return row.enabled ? dollars(row.used) : '—'
}

export function toolUsageAllowance(row: ToolUsageRow): string {
  if (!row.enabled) return '—'
  if (row.unlimited) return '不限额'
  return dollars(row.allowance)
}

export function toolUsageRemaining(row: ToolUsageRow): string {
  if (!row.enabled) return '—'
  if (row.unlimited) return '不限额'
  return dollars(row.remaining)
}

/** 卡片副标题:一句话回答「钱花在哪个工具上了」。 */
export function toolUsageHeadline(summary: ToolUsageSummary): string {
  if (!summary.enabledCount) return '当前账号还没有为任何工具签发密钥，在首页配置一次工具就会自动签发。'
  if (summary.used === null) return '当前账号的用量暂未读到。'
  if (!summary.top) return `当前账号的 ${summary.enabledCount} 个工具都还没有产生用量。`
  const share = toolUsageShare(summary.top)
  return `当前账号累计已用 ${dollars(summary.used)}，其中 ${summary.top.name} 最多${share === '—' ? '' : `（${share}）`}。`
}

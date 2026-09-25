import { offlineBalanceText } from './online-status'

export interface BalanceStatusView {
  balanceLoading?: boolean
  balanceUpdatedAt?: number | null
  balanceError?: string | null
  /** 顶部断网横幅亮着时为 true：余额没读到不是余额出了问题，别写「更新失败」吓人。 */
  offline?: boolean
}

/** 余额旁边那几个字：断网时说「没网」，其余没读到的情形照旧说「更新失败」。 */
export function balanceFailureLabel(offline: boolean | undefined): string {
  return offline ? offlineBalanceText : '更新失败'
}

export function balanceStatusText({ balanceLoading, balanceUpdatedAt, balanceError, offline }: BalanceStatusView): string {
  const updated = typeof balanceUpdatedAt === 'number' ? new Date(balanceUpdatedAt) : null
  const lastUpdated = updated && Number.isFinite(updated.getTime())
    ? `最后更新于 ${updated.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : '余额尚未更新'
  if (balanceLoading) return `正在刷新余额；${lastUpdated}`
  if (balanceError && offline) return `${offlineBalanceText}；${lastUpdated}`
  if (balanceError) return `更新失败：${balanceError}；${lastUpdated}`
  return lastUpdated
}

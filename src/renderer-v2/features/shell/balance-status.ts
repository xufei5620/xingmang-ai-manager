export interface BalanceStatusView {
  balanceLoading?: boolean
  balanceUpdatedAt?: number | null
  balanceError?: string | null
}

export function balanceStatusText({ balanceLoading, balanceUpdatedAt, balanceError }: BalanceStatusView): string {
  const updated = typeof balanceUpdatedAt === 'number' ? new Date(balanceUpdatedAt) : null
  const lastUpdated = updated && Number.isFinite(updated.getTime())
    ? `最后更新于 ${updated.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : '余额尚未更新'
  if (balanceLoading) return `正在刷新余额；${lastUpdated}`
  if (balanceError) return `更新失败：${balanceError}；${lastUpdated}`
  return lastUpdated
}

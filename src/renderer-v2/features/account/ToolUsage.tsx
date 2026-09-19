import { useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { loadManagedCliKeys, resolveManagedCliKeyLimits } from '../../../../electron/account-key-quota'
import type { AccountSiteId } from '../../account-context'
import { ResultNotice, useResource } from '../../business-common'
import type { V2Bridge } from '../../types'
import { Button, Card, Pill, Skeleton, Table } from '../../ui'
import {
  buildToolUsageSummary,
  toolUsageAllowance,
  toolUsageHeadline,
  toolUsageRemaining,
  toolUsageShare,
  toolUsageUsed,
  type ToolUsageSummary,
} from './tool-usage'

type Balance = Awaited<ReturnType<V2Bridge['getAccountBalance']>>

export const toolUsageColumns = [
  { key: 'tool', label: '工具' },
  { key: 'used', label: '累计已用' },
  { key: 'share', label: '占比' },
  { key: 'allowance', label: '额度（已用 + 剩余）' },
  { key: 'remaining', label: '剩余' },
]

export function toolUsageRows(summary: ToolUsageSummary) {
  return summary.rows.map((row) => ({
    tool: (
      <>
        {row.name}
        {row.enabled ? null : <Pill>未启用</Pill>}
      </>
    ),
    provider: row.provider,
    used: toolUsageUsed(row),
    share: toolUsageShare(row),
    allowance: toolUsageAllowance(row),
    remaining: toolUsageRemaining(row),
  }))
}

export function ToolUsage({
  api,
  balance,
  siteId,
}: {
  api: V2Bridge
  balance: Balance
  siteId: AccountSiteId
}) {
  const load = useCallback(
    async () =>
      buildToolUsageSummary(
        resolveManagedCliKeyLimits(
          await loadManagedCliKeys((page, pageSize) => api.getAccountKeys({ page, pageSize }), siteId),
          balance.quotaPerUnit,
          siteId,
        ),
      ),
    [api, balance.quotaPerUnit, siteId],
  )
  const resource = useResource(load)
  return (
    <Card
      title="按工具分账"
      meta={resource.data ? toolUsageHeadline(resource.data) : '正在读取每个工具的用量…'}
      padding="none"
      testId="tool-usage"
      actions={
        <Button
          size="sm"
          icon={RefreshCw}
          loading={resource.loading}
          testId="tool-usage-refresh"
          onClick={() => void resource.reload()}
        >
          刷新
        </Button>
      }
    >
      <ResultNotice error={resource.error} />
      {resource.loading && !resource.data ? (
        <Skeleton rows={4} />
      ) : (
        <Table
          columns={toolUsageColumns}
          rows={resource.data ? toolUsageRows(resource.data) : []}
          rowKey={(row) => String(row.provider)}
          label="按工具分账"
          empty={resource.error ? '按工具分账读取失败' : '暂无工具用量'}
        />
      )}
    </Card>
  )
}

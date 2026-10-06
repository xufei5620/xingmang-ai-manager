import { useCallback } from 'react'
import { loadManagedCliKeys, resolveManagedCliKeyLimits } from '../../../../electron/account-key-quota'
import type { AccountSiteId } from '../../account-context'
import { FailureReason, ListReadFailure, useRefreshRequest, useResource } from '../../business-common'
import type { V2Bridge } from '../../types'
import { Card, Pill, Skeleton, Table } from '../../ui'
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
        {row.enabled ? null : <span className="v2-tool-usage-off"><Pill>未启用</Pill></span>}
      </>
    ),
    provider: row.provider,
    used: toolUsageUsed(row),
    share: toolUsageShare(row),
    allowance: toolUsageAllowance(row),
    remaining: toolUsageRemaining(row),
  }))
}

/**
 * 各工具累计用了多少。是从开始到现在的累计数，不跟用量看板上面的时间范围走，
 * 所以摆在那一页最下面，标题旁写明。
 */
export function ToolUsage({
  api,
  balance,
  siteId,
  refreshRequest,
}: {
  api: V2Bridge
  balance: Balance
  siteId: AccountSiteId
  /** 个人中心页头「刷新」点到用量看板时加一；缺省 = 只在打开时读一次。 */
  refreshRequest?: number
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
  useRefreshRequest(refreshRequest, () => void resource.reload())
  return (
    <Card
      title="各工具累计用量"
      meta="累计，不受上面时间范围影响"
      padding="none"
      testId="tool-usage"
    >
      {resource.error && !resource.loading ? (
        <ListReadFailure
          page="tool-usage"
          noun="各工具累计用量"
          description={<FailureReason error={resource.error} detail={resource.detail} />}
          retry={() => void resource.reload()}
        />
      ) : resource.loading && !resource.data ? (
        <Skeleton rows={4} />
      ) : (
        <>
          {resource.data && <p className="v2-tool-usage-headline">{toolUsageHeadline(resource.data)}</p>}
          <Table
            columns={toolUsageColumns}
            rows={resource.data ? toolUsageRows(resource.data) : []}
            rowKey={(row) => String(row.provider)}
            label="各工具累计用量"
            empty="暂无工具用量"
          />
        </>
      )}
    </Card>
  )
}

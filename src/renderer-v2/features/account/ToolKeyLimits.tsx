import { useCallback, useState } from 'react'
import { Gauge } from 'lucide-react'
import {
  buildManagedCliKeyLimitUpdate,
  loadManagedCliKeys,
  parseManagedCliKeyLimitAmount,
  resolveManagedCliKeyLimits,
  type ManagedCliKeyLimit,
} from '../../../../electron/account-key-quota'
import type { AccountSiteId } from '../../account-context'
import { ResultNotice, dollars, useOperation, useResource } from '../../business-common'
import { tools } from '../../registry/tools'
import type { V2Bridge } from '../../types'
import { Button, Card, Input, ListRow, Skeleton } from '../../ui'

type Balance = Awaited<ReturnType<V2Bridge['getAccountBalance']>>

export function toolKeyLimitName(provider: string): string {
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}

/** 编辑框里的初始值:不限额是空的,有上限就填当前剩余。 */
export function toolKeyLimitValue(limit: ManagedCliKeyLimit): string {
  return limit.unlimited || limit.remaining === null ? '' : String(Math.round(limit.remaining * 100) / 100)
}

export function toolKeyLimitDescription(limit: ManagedCliKeyLimit): string {
  if (!limit.key) return '还没有这把密钥，在首页配置一次这个工具就会自动签发。'
  const used = `已用 ${dollars(limit.used)}`
  return limit.unlimited ? `${used} · 不限额度` : `${used} · 上限剩余 ${dollars(limit.remaining)}`
}

export function ToolKeyLimitRow({
  limit,
  value,
  busy,
  disabled,
  onChange,
  onSave,
}: {
  limit: ManagedCliKeyLimit
  value: string
  busy: boolean
  disabled: boolean
  onChange(value: string): void
  onSave(): void
}) {
  const name = toolKeyLimitName(limit.provider)
  return (
    <ListRow
      icon={Gauge}
      title={name}
      desc={toolKeyLimitDescription(limit)}
      off={!limit.key}
      testId={`tool-key-limit-${limit.provider}`}
      actions={
        <>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="不限"
            disabled={disabled || !limit.key}
            aria-label={`${name} 的额度上限（USD）`}
            testId={`tool-key-limit-input-${limit.provider}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button
            size="sm"
            loading={busy}
            disabled={disabled || !limit.key}
            testId={`tool-key-limit-save-${limit.provider}`}
            onClick={onSave}
          >
            保存
          </Button>
        </>
      }
    />
  )
}

export function ToolKeyLimits({
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
      resolveManagedCliKeyLimits(
        await loadManagedCliKeys((page, pageSize) => api.getAccountKeys({ page, pageSize }), siteId),
        balance.quotaPerUnit,
        siteId,
      ),
    [api, balance.quotaPerUnit, siteId],
  )
  const resource = useResource(load)
  const operation = useOperation()
  // 只记用户改过的那几格。没改过的格子跟着刷新后的真实剩余额度走,
  // 免得保存完还停在旧数字上。
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const save = (limit: ManagedCliKeyLimit, value: string) =>
    void operation.execute(
      `limit-${limit.provider}`,
      async () => {
        const amount = parseManagedCliKeyLimitAmount(value)
        await api.updateAccountKey(buildManagedCliKeyLimitUpdate(limit, amount, balance.quotaPerUnit, siteId))
        setDrafts((current) => {
          const next = { ...current }
          delete next[limit.provider]
          return next
        })
        await resource.reload()
      },
      '额度上限已保存',
    )
  return (
    <Card
      title="每个工具的额度上限"
      meta="留空表示不限额。上限是这个工具还能再用多少，用完只停这一个工具，其余照常；额度不会自动恢复，重新填写即可放开。"
      testId="tool-key-limits"
    >
      <ResultNotice error={resource.error || operation.error} message={operation.message} />
      {resource.loading && !resource.data ? (
        <Skeleton rows={4} />
      ) : (
        (resource.data ?? []).map((limit) => {
          const value = drafts[limit.provider] ?? toolKeyLimitValue(limit)
          return (
            <ToolKeyLimitRow
              key={limit.provider}
              limit={limit}
              value={value}
              busy={operation.busy === `limit-${limit.provider}`}
              disabled={Boolean(operation.busy)}
              onChange={(next) => setDrafts((current) => ({ ...current, [limit.provider]: next }))}
              onSave={() => save(limit, value)}
            />
          )
        })
      )}
    </Card>
  )
}

import { useCallback, useRef, useState } from 'react'
import { Gauge } from 'lucide-react'
import {
  buildManagedCliKeyLimitUpdate,
  findAccountKeyById,
  loadManagedCliKeys,
  parseManagedCliKeyLimitAmount,
  resolveManagedCliKeyLimits,
  type ManagedCliKeyLimit,
} from '../../../../electron/account-key-quota'
import type { AccountSiteId } from '../../account-context'
import { ResultNotice, dollars, useOperation, useRefreshRequest, useResource } from '../../business-common'
import { useLatestRequest } from '../../latest-request'
import { tools } from '../../registry/tools'
import type { V2Bridge } from '../../types'
import { Button, Card, Input, ListRow, Pill, Skeleton } from '../../ui'

type Balance = Awaited<ReturnType<V2Bridge['getAccountBalance']>>

export function toolKeyLimitName(provider: string): string {
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}

/** 编辑框里的初始值:不限额是空的,有上限就填当前剩余。 */
export function toolKeyLimitValue(limit: ManagedCliKeyLimit): string {
  return limit.unlimited || limit.remaining === null ? '' : String(Math.round(limit.remaining * 100) / 100)
}

/** 上限已经用光:这个工具的请求从这一刻起会被拒绝。 */
export function toolKeyLimitReached(limit: ManagedCliKeyLimit): boolean {
  return Boolean(limit.key) && !limit.unlimited && limit.remaining !== null && limit.remaining <= 0
}

export function toolKeyLimitDescription(limit: ManagedCliKeyLimit): string {
  if (!limit.key) return '暂无此密钥，在首页配置该工具后将自动创建。'
  const used = `已用 ${dollars(limit.used)}`
  if (limit.unlimited) return `${used} · 不限额度`
  // 「上限剩余 $0.00」不告诉用户任何事:工具已经在报错了,而屏幕上只有一个零。
  // 目录里 noBalance 的正文(「充值到账后立即恢复」)在这里是错的——充值不会
  // 放开单个工具的上限,只有把上限改大才会,所以这句照 N4 的真实语义写。
  if (toolKeyLimitReached(limit)) return `${used} · 额度上限已用尽，该工具的请求将被拒绝；调高上限或留空即可恢复`
  return `${used} · 上限剩余 ${dollars(limit.remaining)}`
}

/**
 * 卡里摆哪几行：只摆已经有密钥的工具，次序和别处一样（工具注册表的次序）；
 * 还没配的工具只报个名字，配好后才出现在这里。
 */
export function toolKeyLimitLayout(limits: readonly ManagedCliKeyLimit[]): { rows: ManagedCliKeyLimit[]; missing: string[] } {
  const rank = (provider: string) => tools.findIndex((tool) => tool.id === provider)
  const ordered = [...limits].sort((left, right) => rank(left.provider) - rank(right.provider))
  return {
    rows: ordered.filter((limit) => limit.key),
    missing: ordered.filter((limit) => !limit.key).map((limit) => toolKeyLimitName(limit.provider)),
  }
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
  /** badInput:点保存那一刻,框里是不是打了浏览器读不成数的半截数。 */
  onSave(badInput: boolean): void
}) {
  const name = toolKeyLimitName(limit.provider)
  // 打成「-」「1e」时数字框交出来的值是空的，跟留空分不开，只有框自己的 validity 知道；
  // 而且从空打成「-」值没变，onChange 都不来，所以在点保存那一刻现读（表单 F10-b）。
  const field = useRef<HTMLInputElement>(null)
  return (
    <ListRow
      icon={Gauge}
      title={name}
      desc={toolKeyLimitDescription(limit)}
      badge={toolKeyLimitReached(limit) ? <Pill tone="bad">已到上限</Pill> : undefined}
      off={!limit.key}
      testId={`tool-key-limit-${limit.provider}`}
      actions={
        <>
          <Input
            ref={field}
            type="number"
            min="0"
            step="0.01"
            placeholder="不限"
            disabled={disabled || !limit.key}
            aria-label={`${name} 的额度上限（美元）`}
            testId={`tool-key-limit-input-${limit.provider}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button
            size="sm"
            loading={busy}
            disabled={disabled || !limit.key}
            testId={`tool-key-limit-save-${limit.provider}`}
            onClick={() => onSave(field.current?.validity.badInput ?? false)}
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
  username,
  refreshRequest,
  keysWritten,
  onSaved,
}: {
  api: V2Bridge
  balance: Balance
  siteId: AccountSiteId
  /** 当前账号的用户名，认星芒新签的「用户名-分组」那几把；缺省 = 只认以前的固定名。 */
  username?: string
  /** 个人中心页头「刷新」点到密钥页时加一；缺省 = 只在打开时读一次。 */
  refreshRequest?: number
  /** 下面密钥列表每写一次（改、建、撤销、换新）加一，这里跟着重读（F01）；缺省 = 不跟。 */
  keysWritten?: number
  /** 这里存好一个上限之后叫一下，好让下面的密钥列表也重读（F01）。 */
  onSaved?: () => void
}) {
  const load = useCallback(
    async () =>
      resolveManagedCliKeyLimits(
        await loadManagedCliKeys((page, pageSize) => api.getAccountKeys({ page, pageSize }), siteId, username),
        balance.quotaPerUnit,
        siteId,
        username,
      ),
    [api, balance.quotaPerUnit, siteId, username],
  )
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  useRefreshRequest(keysWritten, () => void resource.reload())
  // 保存前要先读一次这把密钥现在的样子；读的这会儿换了账号（这一页会整个换掉），旧的上限不再发出去。
  const latestKey = useLatestRequest()
  const operation = useOperation()
  // 只记用户改过的那几格。没改过的格子跟着刷新后的真实剩余额度走,
  // 免得保存完还停在旧数字上。
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const save = (limit: ManagedCliKeyLimit, value: string, badInput: boolean) =>
    void operation.execute(
      `limit-${limit.provider}`,
      async () => {
        const amount = parseManagedCliKeyLimitAmount(value, badInput)
        // 这里只改额度，名称、分组、到期日照这把密钥现在的样子写回去：下面列表、别的设备可能刚改过，
        // 这张卡上的还是打开时读的（F01）。整张列表翻完都没有这把，就照卡上的发，后台自己会说找不到。
        const live = latestKey.capture()
        const latest = limit.key ? await findAccountKeyById((query) => api.getAccountKeys(query), limit.key.id) : null
        if (!live()) return
        const fresh = latest ? { ...limit, key: latest, group: latest.group || limit.group } : limit
        await api.updateAccountKey(buildManagedCliKeyLimitUpdate(fresh, amount, balance.quotaPerUnit, siteId))
        setDrafts((current) => {
          const next = { ...current }
          delete next[limit.provider]
          return next
        })
        onSaved?.()
        await resource.reload()
      },
      '额度上限已保存',
    )
  const layout = toolKeyLimitLayout(resource.data ?? [])
  // 一个工具都还没配：整张卡收成一行灰字，不摆四行点不动的空行。读到过空的、刷新又没读到时
  // 照常出卡片，红条和「重新加载」才看得见。
  if (resource.data && !layout.rows.length && !operation.error && !resource.error)
    return (
      <p className="v2-business-key-limits-empty" data-testid="tool-key-limits">
        工具配置完成后，可在此为每个工具设置额度上限。
      </p>
    )
  return (
    <Card
      title="每个工具的额度上限"
      meta="留空表示不限额。上限为该工具的剩余可用额度，用尽后仅停用该工具，其他工具不受影响；额度不会自动恢复，重新填写即可解除。"
      testId="tool-key-limits"
    >
      <ResultNotice
        error={resource.error || operation.error}
        detail={resource.error ? resource.detail : operation.detail}
        message={operation.message}
        // 读不出来时就地再读一次，不用离开个人中心再回来（#1104 第 8 条）；保存失败那条不给，
        // 改的数还在格子里，再点「保存」就是重试。
        retry={resource.error ? { label: '重新加载', onClick: () => void resource.reload() } : undefined}
      />
      {resource.loading && !resource.data ? (
        <Skeleton rows={4} />
      ) : (
        layout.rows.map((limit) => {
          const value = drafts[limit.provider] ?? toolKeyLimitValue(limit)
          return (
            <ToolKeyLimitRow
              key={limit.provider}
              limit={limit}
              value={value}
              busy={operation.busy === `limit-${limit.provider}`}
              disabled={Boolean(operation.busy)}
              onChange={(next) => setDrafts((current) => ({ ...current, [limit.provider]: next }))}
              onSave={(badInput) => save(limit, value, badInput)}
            />
          )
        })
      )}
      {resource.data && layout.missing.length > 0 && (
        <p className="v2-business-key-limits-missing" data-testid="tool-key-limits-missing">
          {layout.missing.join('、')} 尚未配置，配置后将显示在此处。
        </p>
      )}
    </Card>
  )
}

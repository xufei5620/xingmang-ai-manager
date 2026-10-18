import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BarChart3, Copy, ListX, RefreshCw } from 'lucide-react'
import { Button, Card, Dialog, Empty, Notice, Pill, Segment, Select, Table } from '../../ui'
import {
  displayDate,
  dollars,
  FailureReason,
  ListReadFailure,
  Pagination,
  PlaceholderBar,
  RelativeTime,
  ResultNotice,
  useOperation,
  useRefreshRequest,
  useResource,
} from '../../business-common'
import { taskFilterFields, taskStates, usageFilterFields } from '../../registry/business'
import { AccountFilters, accountTimeRange } from '../../AccountFilters'
import { platformApi } from '../../platform-api'
import type { V2Bridge } from '../../types'
import type { AccountBalance, AccountDashboardData, AccountTaskRecord, AccountUsageQuery, AccountUsageRecord } from '../../../../electron/ipc-contract'
import { usageDateRange } from '../../../../electron/usage-date-range'
import type { AccountSiteId } from '../../account-context'
import { spendSegmentQuery } from './account-center'
import { ToolUsage } from './ToolUsage'
import { UsageDetails } from './UsageDetails'
import {
  frequentModels,
  isUsageRange,
  mergeDashboards,
  modelShares,
  modelShareTitle,
  quickFilterQuery,
  sub2ApiFilterId,
  sub2ApiUsageFilterFields,
  usageChartScale,
  usageEmptyText,
  usageHourBlocks,
  usageRangeStart,
  usageRanges,
  usageSegments,
  usageStatus,
  usageTickText,
  type UsageQuickFilter,
  type UsageRange,
} from './usage'

export type UsageView = 'calls' | 'tasks'

// 没读到的金额写「—」，不写「暂未读到」（同 pages-account 的 quotaMoney）。
function quotaMoney(quota: number | null | undefined, balance: AccountBalance) {
  return balance.quotaPerUnit > 0 && typeof quota === 'number' ? dollars(quota / balance.quotaPerUnit) : '—'
}

const pageSizes = [10, 20, 50, 100]
/**
 * 表格下面那一行：翻页，和「20 条 / 页」。一共不超过最小的一档时每页多少条都一样，
 * 整行不出；读不到时也不出（列表那里已经说了没读到）。
 */
function TableFoot({
  label,
  page,
  pageSize,
  total,
  failed,
  onPage,
  onPageSize,
}: {
  label: string
  page: number
  pageSize: number
  total: number
  failed: boolean
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}) {
  if (failed || total <= pageSizes[0]) return null
  return (
    <div className="v2-business-table-foot">
      <Pagination page={page} size={pageSize} total={total} onChange={onPage} />
      <Select
        aria-label={label}
        options={pageSizes.map((size) => ({ value: String(size), label: `${size} 条 / 页` }))}
        value={String(pageSize)}
        onChange={(event) => onPageSize(Number(event.target.value))}
      />
    </div>
  )
}

interface DashboardView {
  totals: Pick<AccountDashboardData, 'quota' | 'count' | 'tokens' | 'models'>
  /** 花费趋势的柱子；历史账号只有累计数时为 null。 */
  bars: Array<{ start: number; label: string; title: string; quota: number }> | null
}

/**
 * 用量看板要的数。星芒账号「7 天」「30 天」每根柱子按本地日、本地周各问一次再合起来（见 usageSegments），
 * 「24 小时」问一次按小时的桶；历史账号后台只回全部时间的累计，问一次就够。每次读都算到「现在」：
 * 分页切走再回来、点页头「刷新」，都要看到刚刚的用量。
 */
function useUsageDashboard(api: V2Bridge, enabled: boolean, trends: boolean, range: UsageRange, refreshRequest?: number) {
  const load = useCallback(async (): Promise<DashboardView | null> => {
    if (!enabled) return null
    const now = new Date()
    const endTimestamp = Math.floor(now.getTime() / 1000)
    if (!trends) {
      const data = await api.getAccountDashboard({ startTimestamp: endTimestamp - 7 * 86_400, endTimestamp })
      return { totals: data, bars: null }
    }
    if (range === '1') {
      const startTimestamp = usageRangeStart('1', now)
      const data = await api.getAccountDashboard({ startTimestamp, endTimestamp })
      return { totals: data, bars: data.coverage === 'all-time-summary' ? null : usageHourBlocks(startTimestamp, now, data.buckets) }
    }
    const segments = usageSegments(range, now)
    const parts = await Promise.all(segments.map((segment, index) => api.getAccountDashboard(spendSegmentQuery(segment, index === segments.length - 1))))
    if (parts.some((part) => part.coverage === 'all-time-summary')) return { totals: parts[parts.length - 1], bars: null }
    return { totals: mergeDashboards(parts), bars: segments.map((segment, index) => ({ ...segment, quota: parts[index].quota })) }
  }, [api, enabled, trends, range])
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  return resource
}

function SpendChart({ bars, balance }: { bars: NonNullable<DashboardView['bars']>; balance: AccountBalance }) {
  const amounts = bars.map((bar) => balance.quotaPerUnit > 0 ? bar.quota / balance.quotaPerUnit : 0)
  const scale = usageChartScale(amounts)
  const last = bars.length - 1
  return (
    <div className="v2-usage-chart" role="img" aria-label={bars.map((bar, index) => `${bar.title}：${dollars(amounts[index])}`).join('；')}>
      {scale.ticks.map((tick) => (
        <div key={tick} className="v2-usage-chart-line" style={{ bottom: `calc((100% - 8px) * ${scale.top > 0 ? tick / scale.top : 0})` }}>
          <span>{usageTickText(tick, scale.ticks)}</span>
        </div>
      ))}
      {bars.map((bar, index) => (
        <div key={bar.start} className={`v2-usage-chart-col${index === last ? ' is-current' : ''}`} title={`${bar.title}：${dollars(amounts[index])}`}>
          <div className="v2-usage-chart-bar" style={{ height: `${scale.top > 0 ? amounts[index] / scale.top * 100 : 0}%` }}>
            <span>{dollars(amounts[index])}</span>
          </div>
          <small>{bar.label}</small>
        </div>
      ))}
    </div>
  )
}

function UsageDashboard({
  dashboard,
  balance,
  trends,
  range,
  onRange,
}: {
  dashboard: ReturnType<typeof useUsageDashboard>
  balance: AccountBalance
  trends: boolean
  range: UsageRange
  onRange: (range: UsageRange) => void
}) {
  const failed = Boolean(dashboard.error) && !dashboard.loading
  const data = dashboard.data
  const summaryOnly = Boolean(data) ? data?.bars === null : !trends
  const days = Number(range)
  // 大字只放三种：数字、读取中的灰条、读不到时的「—」（下面一行小字说没读到）。
  function stat(title: string, value: string | undefined, small?: string, gold?: boolean) {
    return (
      <section className="v2-acct-card v2-usage-stat">
        <span className="v2-acct-muted">{title}</span>
        <strong className={`v2-usage-stat-value${gold ? ' is-gold' : ''}`} title={value === undefined && failed ? '暂时没有读到' : undefined}>
          {value ?? (failed ? '—' : <PlaceholderBar width="4em" />)}
        </strong>
        {value === undefined && failed ? <small>暂时没有读到</small> : small && <small>{small}</small>}
      </section>
    )
  }
  const shares = data ? modelShares(data.totals.models) : []
  const costUsd = data && balance.quotaPerUnit > 0 ? data.totals.quota / balance.quotaPerUnit : null
  return (
    <>
      {trends ? (
        <div className="v2-usage-range">
          <Segment label="统计时间" options={[...usageRanges]} value={range} onChange={(value) => { if (isUsageRange(value)) onRange(value) }} />
        </div>
      ) : (
        <section className="v2-acct-well v2-usage-summary-only">
          <strong>只有累计数</strong>
          <span className="v2-acct-muted">这个账号只提供从开始到现在的累计用量。</span>
        </section>
      )}
      {failed && (
        <Notice
          tone="bad"
          title="当前账号的用量暂时没有读到"
          body={<FailureReason error={dashboard.error} detail={dashboard.detail} />}
          testId="dashboard-error"
          actions={
            <Button size="sm" icon={RefreshCw} onClick={() => void dashboard.reload()} testId="dashboard-retry">
              重新加载
            </Button>
          }
        />
      )}
      <div className="v2-usage-stats" data-testid="usage-stats">
        {stat('总花费', data ? quotaMoney(data.totals.quota, balance) : undefined, trends && !summaryOnly && costUsd !== null ? `日均 ${dollars(costUsd / days)}` : undefined, true)}
        {stat('请求次数', data?.totals.count.toLocaleString())}
        {stat('处理 Token', data?.totals.tokens.toLocaleString())}
      </div>
      {trends && !summaryOnly && (
        <div className="v2-usage-charts">
          <section className="v2-acct-card">
            <div className="v2-acct-card-head"><h2>花费趋势</h2></div>
            {data?.bars && data.bars.some((bar) => bar.quota > 0) ? (
              <SpendChart bars={data.bars} balance={balance} />
            ) : failed ? (
              <div className="v2-business-chart-empty v2-usage-chart-empty" data-testid="dashboard-trend-error">
                <p>花费趋势暂时没有读到</p>
                <Button size="sm" icon={RefreshCw} onClick={() => void dashboard.reload()}>
                  重新加载
                </Button>
              </div>
            ) : (
              <div className="v2-business-chart-empty v2-usage-chart-empty">
                <p>{dashboard.loading ? '正在读取用量…' : '这个时间段还没有用量'}</p>
              </div>
            )}
          </section>
          <section className="v2-acct-card v2-usage-models" data-testid="usage-models">
            <div className="v2-acct-card-head"><h2>按模型</h2></div>
            {shares.length ? shares.map((model) => (
              <div className="v2-usage-model" key={model.model} title={modelShareTitle(model)}>
                <div className="v2-acct-kv">
                  <span className="v2-usage-model-name">{model.model}</span>
                  <span className="v2-acct-muted">{model.percent}%</span>
                  <b>{quotaMoney(model.quota, balance)}</b>
                </div>
                <span className="v2-acct-bar"><i style={{ width: `${model.percent}%` }} /></span>
              </div>
            )) : (
              <p className="v2-acct-muted">{dashboard.loading ? '正在读取模型统计…' : dashboard.error ? '模型统计读取失败' : '暂无模型统计'}</p>
            )}
          </section>
        </div>
      )}
    </>
  )
}

/** 「调用明细 | 异步任务」两段切换（只有两样都有的账号才出），和收起来时读屏用的那个标题。 */
function ViewSwitch({ view, both, onChange }: { view: UsageView; both: boolean; onChange: (view: UsageView) => void }) {
  if (!both) return <h2>{view === 'tasks' ? '异步任务' : '调用明细'}</h2>
  return (
    <>
      <h2 className="xm-visually-hidden">{view === 'tasks' ? '异步任务' : '调用明细'}</h2>
      <div data-usage-view-switch="true">
        <Segment
          options={[{ value: 'calls', label: '调用明细' }, { value: 'tasks', label: '异步任务' }]}
          value={view}
          onChange={(value) => onChange(value === 'tasks' ? 'tasks' : 'calls')}
        />
      </div>
    </>
  )
}

function sameDates(left: { startDate: string; endDate: string }, right: { startDate: string; endDate: string }) {
  return left.startDate === right.startDate && left.endDate === right.endDate
}

function AccountCalls({
  api,
  balance,
  siteId,
  trends,
  range,
  models,
  refreshRequest,
  switcher,
}: {
  api: V2Bridge
  balance: AccountBalance
  siteId: AccountSiteId
  trends: boolean
  range: UsageRange
  /** 看板那段时间里的模型，「常用模型」从这里挑。 */
  models: AccountDashboardData['models']
  refreshRequest?: number
  switcher: ReactNode
}) {
  const calendar = siteId === 'solov-api'
  // 历史账号默认最近 7 个日历日。页签只藏不卸、关窗只缩到托盘，挂上时算一次的话过了夜默认范围里就没有今天
  // （#1093 第 1 条）：每次读都按当时现算（load 里），筛选框里显示的默认日期跟着最近一次读换。
  const [defaultDates, setDefaultDates] = useState(() => usageDateRange({}))
  const timezone = defaultDates.timezone
  const [page, setPage] = useState(1)
  // 换了上面的时间范围就回第一页：停在「30 天」的第 3 页切到「24 小时」，那边可能根本没有第 3 页，
  // 列表空着、分页条也不出来，回不去。渲染时就对上，不先拿旧页码多问一次。
  const [pageRange, setPageRange] = useState(range)
  if (pageRange !== range) {
    setPageRange(range)
    setPage(1)
  }
  const [pageSize, setPageSize] = useState(20)
  // 历史账号的 filter 只在用户自己选了日期时才带日期，没带就是默认那 7 天。
  const [filter, setFilter] = useState<AccountUsageQuery>({})
  const [quick, setQuick] = useState<UsageQuickFilter>('all')
  const [selected, setSelected] = useState<AccountUsageRecord | null>(null)
  // 星芒账号没填起止时间时跟着上面「24 小时 / 7 天 / 30 天」走，「这段时间没有调用」才说得通；
  // 历史账号按整日查，没选日期时是读的这一刻往前数的最近 7 个日历日（usageDateRange）。
  // 自己选了日期的不换框里的默认：没动的那一格会跟着变，跟实际查的对不上。
  const load = useCallback(() => {
    const today = calendar && filter.startDate === undefined && filter.endDate === undefined ? usageDateRange({ timezone }) : null
    if (today) setDefaultDates((current) => sameDates(current, today) ? current : today)
    const ranged = today ?? (trends && !calendar && filter.startTimestamp === undefined && filter.endTimestamp === undefined
      ? { startTimestamp: usageRangeStart(range, new Date()), endTimestamp: Math.floor(Date.now() / 1000) }
      : {})
    return api.getAccountUsage({ ...ranged, ...filter, ...quickFilterQuery(quick), page, pageSize })
  }, [api, page, pageSize, filter, quick, trends, calendar, range, timezone])
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  const failed = Boolean(resource.error) && !resource.loading
  const frequent = frequentModels(models)
  const current = quick.startsWith('model:') ? quick.slice('model:'.length) : null
  const quickOptions = [
    { value: 'all', label: '全部' },
    ...[...frequent, ...(current && !frequent.includes(current) ? [current] : [])].map((model) => ({ value: `model:${model}`, label: model })),
    ...(calendar ? [] : [{ value: 'fail', label: '失败' }]),
  ]
  const records = resource.data?.records ?? []
  const filtered = quick !== 'all' || Object.values(filter).some((value) => value !== undefined && value !== '')
  const empty = usageEmptyText(filtered, quick === 'fail' || filter.type === 5)
  return (
    <>
      <div className="v2-usage-toolbar">
        {switcher}
        {quickOptions.length > 1 && (
          <Segment
            options={quickOptions}
            value={quick}
            onChange={(value) => {
              setQuick(value === 'fail' || value.startsWith('model:') ? value as UsageQuickFilter : 'all')
              setPage(1)
            }}
          />
        )}
        <span className="v2-usage-toolbar-gap" />
        <AccountFilters
          fields={calendar ? sub2ApiUsageFilterFields : usageFilterFields}
          primary={[]}
          initialValues={calendar ? defaultDates : undefined}
          note={calendar ? `按整日统计（时区 ${timezone}），包含结束日期全天。默认最近 7 个日历日。` : undefined}
          onApply={(values) => {
            if (calendar) {
              const dates = usageDateRange({ ...values, timezone })
              // 日期还是框里摆着的默认（没动过、点了「重置筛选」，或清空了）就不记，读的时候照样按当天现算。
              const picked = !sameDates(dates, defaultDates) && !sameDates(dates, usageDateRange({ timezone }))
              setFilter({ ...(picked ? dates : {}), modelName: values.modelName,
                apiKeyId: sub2ApiFilterId(values.apiKeyId), groupId: sub2ApiFilterId(values.groupId),
                ...(values.billingType === '0' || values.billingType === '1' ? { billingType: Number(values.billingType) as 0 | 1 } : {}) })
            } else {
              setFilter({
                ...accountTimeRange(values.start, values.end),
                modelName: values.modelName,
                group: values.group,
                tokenName: values.tokenName,
                requestId: values.requestId,
                upstreamRequestId: values.upstreamRequestId,
                ...(values.type ? { type: Number(values.type) } : {}),
              })
            }
            // 筛选框里另填了模型或日志类型：上面的快捷筛选让开，不然两边打架。
            if (values.modelName || values.type) setQuick('all')
            setPage(1)
          }}
        />
      </div>
      <Card padding="none">
        {failed ? (
          <ListReadFailure
            page="usage"
            noun="调用明细"
            description={<FailureReason error={resource.error} detail={resource.detail} />}
            retry={() => void resource.reload()}
          />
        ) : records.length ? (
          <Table
            columns={[
              { key: 'when', label: '时间' },
              { key: 'model', label: '模型' },
              { key: 'key', label: '密钥' },
              { key: 'tokens', label: '输入 / 输出 Token' },
              { key: 'amount', label: '花费' },
              { key: 'status', label: '状态' },
            ]}
            rows={records.map((row) => {
              const status = usageStatus(row)
              return {
                id: String(row.id),
                label: `${displayDate(row.createdAt)} ${row.modelName}`,
                when: <RelativeTime value={row.createdAt} />,
                model: <span className="v2-usage-mono">{row.modelName}</span>,
                key: row.tokenName || '—',
                tokens: `${row.promptTokens.toLocaleString('en-US')} / ${row.completionTokens.toLocaleString('en-US')}`,
                amount: row.type === 5 && row.quota <= 0 ? '—' : quotaMoney(row.quota, balance),
                status: <Pill tone={status.tone}>{status.label}</Pill>,
              }
            })}
            rowKey={(row) => String(row.id)}
            rowLabel={(row) => String(row.label)}
            onRowClick={(row) => setSelected(records.find((record) => String(record.id) === row.id) ?? null)}
            empty=""
            label="调用明细"
          />
        ) : resource.loading ? (
          <Empty icon={BarChart3} title="正在读取调用明细…" description="" />
        ) : (
          <Empty icon={ListX} title={empty.title} description={empty.description} />
        )}
      </Card>
      <TableFoot
        label="每页日志数量"
        page={page}
        pageSize={pageSize}
        total={resource.data?.total ?? 0}
        failed={failed}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size)
          setPage(1)
        }}
      />
      {selected && <UsageDetails record={selected} balance={balance} onClose={() => setSelected(null)} />}
    </>
  )
}

function AccountTasks({
  api,
  balance,
  accountScope,
  refreshRequest,
  switcher,
}: {
  api: V2Bridge
  balance: AccountBalance
  accountScope: string
  refreshRequest?: number
  switcher: ReactNode
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [filter, setFilter] = useState<Parameters<V2Bridge['getAccountTasks']>[0]>({})
  const [selected, setSelected] = useState<AccountTaskRecord | null>(null)
  const operation = useOperation()
  const load = useCallback(
    () => api.getAccountTasks({ ...filter, page, pageSize }),
    [api, page, pageSize, filter],
  )
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  const failed = Boolean(resource.error) && !resource.loading
  const observedStatuses = useRef(new Map<number, string>())
  useEffect(() => {
    for (const task of resource.data?.tasks ?? []) {
      const previous = observedStatuses.current.get(task.id)
      observedStatuses.current.set(task.id, task.status)
      if (previous && previous !== 'SUCCESS' && task.status === 'SUCCESS') {
        void platformApi()
          ?.notifyActivity(
            'task',
            `${accountScope}:${task.id}:${Date.parse(task.finishAt) || 0}`,
          )
          .catch(() => undefined)
      }
    }
    while (observedStatuses.current.size > 200)
      observedStatuses.current.delete(
        observedStatuses.current.keys().next().value!,
      )
  }, [resource.data, accountScope])
  const tasks = resource.data?.tasks ?? []
  const state = (task: AccountTaskRecord) => taskStates[task.status] ?? { label: '待确认', tone: 'neutral' as const }
  return (
    <>
      <div className="v2-usage-toolbar">
        {switcher}
        <span className="v2-usage-toolbar-gap" />
        <AccountFilters
          fields={taskFilterFields}
          primary={[]}
          onApply={(values) => {
            setFilter({
              ...accountTimeRange(values.start, values.end),
              platform: values.platform,
              taskId: values.taskId,
              status: values.status,
              action: values.action,
            })
            setPage(1)
          }}
        />
      </div>
      <ResultNotice {...operation} />
      <Card padding="none">
        {failed ? (
          <ListReadFailure
            page="tasks"
            noun="异步任务"
            description={<FailureReason error={resource.error} detail={resource.detail} />}
            retry={() => void resource.reload()}
          />
        ) : (
          <Table
            columns={[
              { key: 'task', label: '任务' },
              { key: 'model', label: '模型' },
              { key: 'status', label: '状态' },
              { key: 'cost', label: '消耗（USD）' },
            ]}
            rows={tasks.map((task) => ({
              id: String(task.id),
              label: task.taskId,
              task: <span className="v2-usage-mono">{task.taskId}</span>,
              model: task.originModelName || task.platform,
              status: (
                <Pill tone={state(task).tone}>
                  {state(task).label} {task.progress}
                </Pill>
              ),
              cost: quotaMoney(task.quota, balance),
            }))}
            rowKey={(row) => String(row.id)}
            rowLabel={(row) => String(row.label)}
            onRowClick={(row) => setSelected(tasks.find((task) => String(task.id) === row.id) ?? null)}
            empty={resource.loading ? '正在读取异步任务…' : '暂无异步任务'}
            label="异步任务"
          />
        )}
      </Card>
      <TableFoot
        label="每页任务数量"
        page={page}
        pageSize={pageSize}
        total={resource.data?.total ?? 0}
        failed={failed}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size)
          setPage(1)
        }}
      />
      {/* v4：任务详情从抽屉改成弹窗，字不变。 */}
      <Dialog
        open={Boolean(selected)}
        title="任务详情"
        onClose={() => setSelected(null)}
        testId="task-detail-dialog"
        footer={
          <>
            {selected?.resultUrl && (
              <Button
                variant="ghost"
                icon={Copy}
                onClick={() =>
                  void operation.execute(
                    'copy-task-result',
                    () => navigator.clipboard.writeText(selected.resultUrl ?? ''),
                    '结果链接已复制',
                  )
                }
              >
                复制结果链接
              </Button>
            )}
            <span className="v2-usage-detail-spacer" />
            <Button onClick={() => setSelected(null)}>关闭</Button>
          </>
        }
      >
        {selected && (
          <>
            <div className="v2-usage-detail-summary">
              <Pill tone={state(selected).tone}>{state(selected).label} {selected.progress}</Pill>
              <Pill>{selected.originModelName || selected.platform}</Pill>
            </div>
            <dl className="v2-usage-detail-kv">
              <div><dt>任务编号</dt><dd className="v2-usage-detail-mono">{selected.taskId}</dd></div>
              <div><dt>创建时间</dt><dd>{displayDate(selected.submitAt)}</dd></div>
              <div><dt>完成时间</dt><dd>{displayDate(selected.finishAt)}</dd></div>
              <div><dt>操作</dt><dd>{selected.action}</dd></div>
              <div><dt>状态</dt><dd>{state(selected).label}</dd></div>
              <div><dt>消耗（USD）</dt><dd>{quotaMoney(selected.quota, balance)}</dd></div>
              <div><dt>失败原因</dt><dd>{selected.failReason || '无'}</dd></div>
              <div><dt>结果链接</dt><dd className="v2-usage-detail-mono">{selected.resultUrl || '无'}</dd></div>
            </dl>
            <ResultNotice error={operation.error} detail={operation.detail} />
          </>
        )}
      </Dialog>
    </>
  )
}

/**
 * 个人中心「用量账单」（v4 第 07 批）：上面是用量看板（时间范围、三个数、花费趋势和按模型），
 * 下面「调用明细 | 异步任务」两段切换，最下面各工具累计用量。异步任务藏着时也挂着：
 * 它读回来才能在任务做完时发通知（同改版前）。
 */
export function AccountUsagePage({
  api,
  balance,
  siteId,
  username,
  accountScope,
  dashboard: dashboardOn,
  trends,
  calls: callsOn,
  tasks: tasksOn,
  view,
  onViewChange,
  refreshRequest,
}: {
  api: V2Bridge
  balance: AccountBalance
  siteId: AccountSiteId
  /** 当前账号的用户名，「各工具累计用量」靠它认星芒新签的「用户名-分组」那几把。 */
  username?: string
  accountScope: string
  /** 这个账号有没有用量看板、按天的趋势、调用明细、异步任务。 */
  dashboard: boolean
  trends: boolean
  calls: boolean
  tasks: boolean
  view: UsageView
  onViewChange: (view: UsageView) => void
  refreshRequest?: number
}) {
  const [range, setRange] = useState<UsageRange>('7')
  const dashboard = useUsageDashboard(api, dashboardOn, trends, range, refreshRequest)
  const shown: UsageView = !tasksOn ? 'calls' : !callsOn ? 'tasks' : view
  const both = callsOn && tasksOn
  // 点了切换：点的那颗按钮跟着那一段一起藏起来了，焦点交给新露出来那一段里同一组按钮。
  const section = useRef<HTMLElement>(null)
  const moveFocus = useRef(false)
  useLayoutEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    const visible = [...(section.current?.querySelectorAll<HTMLElement>('[data-usage-view-switch] button[aria-pressed="true"]') ?? [])]
      .find((button) => !button.closest('[hidden]'))
    visible?.focus()
  }, [shown])
  function switchView(next: UsageView) {
    moveFocus.current = true
    onViewChange(next)
  }
  return (
    <>
      {dashboardOn && <UsageDashboard dashboard={dashboard} balance={balance} trends={trends} range={range} onRange={setRange} />}
      {(callsOn || tasksOn) && (
        <section ref={section} className="v2-acct-section v2-usage-details">
          {callsOn && (
            <div hidden={shown !== 'calls'} data-testid="account-usage-section">
              <AccountCalls
                api={api}
                balance={balance}
                siteId={siteId}
                trends={trends}
                range={range}
                models={dashboard.data?.totals.models ?? []}
                refreshRequest={refreshRequest}
                switcher={<ViewSwitch view="calls" both={both} onChange={switchView} />}
              />
            </div>
          )}
          {tasksOn && (
            <div hidden={shown !== 'tasks'} data-anchor="tasks" data-testid="account-tasks-section">
              <AccountTasks
                api={api}
                balance={balance}
                accountScope={accountScope}
                refreshRequest={refreshRequest}
                switcher={<ViewSwitch view="tasks" both={both} onChange={switchView} />}
              />
            </div>
          )}
        </section>
      )}
      {dashboardOn && <ToolUsage api={api} balance={balance} siteId={siteId} username={username} refreshRequest={refreshRequest} />}
    </>
  )
}

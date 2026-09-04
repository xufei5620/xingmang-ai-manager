import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  Coins,
  FileWarning,
  Gauge,
  Hash,
  Layers3,
  LineChart,
  LoaderCircle,
  RefreshCw,
  Zap,
} from 'lucide-react'
import type { AccountBalance, AccountDashboardData } from '../../types'
import { errorMessage } from '../../error-message'
import { formatUsageCostUsd } from './account-center'

type DashboardRange = '24h' | '7d' | '30d'
type ConsumptionView = 'bar' | 'area'
type AnalysisView = 'trend' | 'share' | 'rank'

type ChartBucket = AccountDashboardData['buckets'][number]

const ranges: Array<{ value: DashboardRange; label: string; seconds: number }> = [
  { value: '24h', label: '24 小时', seconds: 24 * 60 * 60 },
  { value: '7d', label: '7 天', seconds: 7 * 24 * 60 * 60 },
  { value: '30d', label: '30 天', seconds: 30 * 24 * 60 * 60 },
]

function rangeQuery(range: DashboardRange): { startTimestamp: number; endTimestamp: number } {
  const endTimestamp = Math.floor(Date.now() / 1_000)
  const seconds = ranges.find((item) => item.value === range)?.seconds ?? ranges[0].seconds
  return { startTimestamp: endTimestamp - seconds, endTimestamp }
}

function compactMetric(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(Math.max(0, value))
}

function formatChartMetric(value: number, metric: 'quota' | 'count', quotaPerUnit: number | undefined): string {
  return metric === 'quota' ? formatUsageCostUsd(value, quotaPerUnit) : compactMetric(value)
}

function bucketLabel(timestamp: number, range: DashboardRange): string {
  const date = new Date(timestamp * 1_000)
  return range === '24h'
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function axisIndexes(length: number): Set<number> {
  if (length <= 6) return new Set(Array.from({ length }, (_, index) => index))
  const result = new Set<number>([0, length - 1])
  for (let index = 1; index < 5; index += 1) result.add(Math.round(index * (length - 1) / 5))
  return result
}

function DashboardChart({
  buckets,
  models,
  metric,
  kind,
  range,
  quotaPerUnit,
}: {
  buckets: ChartBucket[]
  models: string[]
  metric: 'quota' | 'count'
  kind: ConsumptionView
  range: DashboardRange
  quotaPerUnit: number | undefined
}) {
  const width = 960
  const height = 260
  const left = 48
  const top = 18
  const bottom = 42
  const plotWidth = width - left - 20
  const plotHeight = height - top - bottom
  const values = buckets.map((bucket) => metric === 'quota' ? bucket.quota : bucket.count)
  const maxValue = Math.max(1, ...values)
  const labels = axisIndexes(buckets.length)
  const x = (index: number) => left + (buckets.length <= 1 ? plotWidth / 2 : index * plotWidth / (buckets.length - 1))
  const y = (value: number) => top + plotHeight - value / maxValue * plotHeight
  const linePoints = buckets.map((bucket, index) => `${x(index)},${y(metric === 'quota' ? bucket.quota : bucket.count)}`).join(' ')

  return (
    <div className="account-dashboard-chart-scroll">
      <svg className="account-dashboard-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={metric === 'quota' ? '消费分布图' : '模型调用趋势图'}>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <g key={ratio}>
            <line x1={left} y1={top + plotHeight * ratio} x2={width - 20} y2={top + plotHeight * ratio} className="account-dashboard-grid-line" />
            <text x={left - 8} y={top + plotHeight * ratio + 4} textAnchor="end" className="account-dashboard-axis-label">
              {formatChartMetric(maxValue * (1 - ratio), metric, quotaPerUnit)}
            </text>
          </g>
        ))}
        {kind === 'bar' ? buckets.map((bucket, index) => {
          const barWidth = Math.max(6, Math.min(34, plotWidth / Math.max(1, buckets.length) * 0.62))
          let stacked = 0
          return (
            <g key={bucket.timestamp}>
              {models.map((model, modelIndex) => {
                const value = metric === 'quota' ? bucket.models[model]?.quota ?? 0 : bucket.models[model]?.count ?? 0
                const barHeight = value / maxValue * plotHeight
                const rect = <rect key={model} x={x(index) - barWidth / 2} y={top + plotHeight - stacked - barHeight} width={barWidth} height={barHeight} className={`account-dashboard-series series-${modelIndex % 6}`}><title>{`${model} · ${formatChartMetric(value, metric, quotaPerUnit)}`}</title></rect>
                stacked += barHeight
                return rect
              })}
            </g>
          )
        }) : (
          <>
            <polygon points={`${left},${top + plotHeight} ${linePoints} ${width - 20},${top + plotHeight}`} className="account-dashboard-area" />
            <polyline points={linePoints} className="account-dashboard-line" />
          </>
        )}
        {buckets.map((bucket, index) => labels.has(index) ? (
          <text key={bucket.timestamp} x={x(index)} y={height - 16} textAnchor="middle" className="account-dashboard-axis-label">{bucketLabel(bucket.timestamp, range)}</text>
        ) : null)}
      </svg>
    </div>
  )
}

export function AccountDashboardPanel({ balance }: { balance: AccountBalance | null }) {
  const [range, setRange] = useState<DashboardRange>('24h')
  const [consumptionView, setConsumptionView] = useState<ConsumptionView>('bar')
  const [analysisView, setAnalysisView] = useState<AnalysisView>('trend')
  const [dashboard, setDashboard] = useState<AccountDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const requestId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setFailure(null)
    try {
      const next = await window.xingmang.getAccountDashboard(rangeQuery(range))
      if (!mounted.current || requestId.current !== currentRequest) return
      setDashboard(next)
    } catch (error) {
      if (mounted.current && requestId.current === currentRequest) setFailure(errorMessage(error))
    } finally {
      if (mounted.current && requestId.current === currentRequest) setLoading(false)
    }
  }, [range])

  useEffect(() => { void load() }, [load])
  const summary = useMemo(() => {
    const fallback: AccountDashboardData = {
      startTimestamp: 0,
      endTimestamp: 0,
      buckets: [],
      models: [],
      quota: 0,
      count: 0,
      tokens: 0,
      discardedCount: 0,
    }
    if (!dashboard) return fallback
    // Keep an unexpected/mixed-version IPC response from taking down the
    // account center while the main process and renderer are being updated.
    return {
      ...fallback,
      ...dashboard,
      buckets: Array.isArray(dashboard.buckets) ? dashboard.buckets : [],
      models: Array.isArray(dashboard.models) ? dashboard.models : [],
    }
  }, [dashboard])
  const minutes = Math.max(1, ((dashboard?.endTimestamp ?? 0) - (dashboard?.startTimestamp ?? 0)) / 60)
  const visibleModels = summary.models.slice(0, 6).map((item) => item.model)
  const stats = [
    { label: '总调用数', value: compactMetric(summary.count), detail: '统计请求数', icon: Hash },
    { label: '总额度', value: formatUsageCostUsd(summary.quota, balance?.quotaPerUnit), detail: '统计消费额', icon: Coins },
    { label: '总 Token 数', value: compactMetric(summary.tokens), detail: '输入与输出总量', icon: Layers3 },
    { label: '平均 RPM', value: (summary.count / minutes).toFixed(2), detail: '每分钟请求数', icon: Gauge },
    { label: '平均 TPM', value: compactMetric(summary.tokens / minutes), detail: '每分钟 Token 数', icon: Zap },
  ]

  if (loading && !dashboard) return <section className="workspace-empty" aria-live="polite"><div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div><h2>正在汇总模型调用数据</h2></section>
  if (failure && !dashboard) return <div className="session-error" role="alert"><FileWarning size={18} /><div><strong>用量读取失败</strong><span>{failure}</span></div><button type="button" className="secondary-button" onClick={() => void load()}>重试</button></div>

  return (
    <div className="account-dashboard-panel">
      <header className="account-dashboard-toolbar">
        <div><span>模型调用分析</span><strong>消费、Token 与请求趋势</strong></div>
        <div className="account-dashboard-range" role="group" aria-label="看板时间范围">
          {ranges.map((item) => <button type="button" key={item.value} className={range === item.value ? 'active' : ''} aria-pressed={range === item.value} onClick={() => setRange(item.value)}>{item.label}</button>)}
          <button type="button" className="account-dashboard-refresh" title="刷新用量" aria-label="刷新用量" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
        </div>
      </header>

      {summary.discardedCount > 0 && (
        <div className="account-dashboard-discarded" role="status">
          已忽略 {summary.discardedCount.toLocaleString('zh-CN')} 条超出看板上限的记录
        </div>
      )}

      <section className="account-dashboard-stats" aria-label="模型调用统计">
        {stats.map(({ label, value, detail, icon: Icon }, index) => (
          <article key={label}><span className={`account-dashboard-stat-icon tone-${index}`}><Icon size={17} /></span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>
        ))}
      </section>

      {failure && <div className="account-dashboard-inline-error" role="alert"><span>{failure}</span><button type="button" onClick={() => void load()}><RefreshCw size={14} />重试</button></div>}

      {summary.buckets.length === 0 ? (
        <section className="account-dashboard-empty"><Activity size={24} /><strong>该时间范围暂无调用数据</strong><span>产生模型调用后，消费和趋势会自动显示在这里。</span></section>
      ) : (
        <>
          <section className="account-dashboard-chart-card">
            <header><div><span className="account-dashboard-chart-icon"><Coins size={16} /></span><strong>消费分布</strong><small>总计 {formatUsageCostUsd(summary.quota, balance?.quotaPerUnit)}</small></div><div className="account-dashboard-segmented"><button type="button" className={consumptionView === 'bar' ? 'active' : ''} onClick={() => setConsumptionView('bar')}><BarChart3 size={14} />柱状图</button><button type="button" className={consumptionView === 'area' ? 'active' : ''} onClick={() => setConsumptionView('area')}><LineChart size={14} />面积图</button></div></header>
            <DashboardChart buckets={summary.buckets} models={visibleModels} metric="quota" kind={consumptionView} range={range} quotaPerUnit={balance?.quotaPerUnit} />
            <div className="account-dashboard-legend">{summary.models.slice(0, 6).map((item, index) => <span key={item.model}><i className={`series-${index % 6}`} />{item.model}</span>)}</div>
          </section>

          <section className="account-dashboard-chart-card">
            <header><div><span className="account-dashboard-chart-icon analysis"><Activity size={16} /></span><strong>模型调用分析</strong><small>总计 {summary.count.toLocaleString('zh-CN')} 次</small></div><div className="account-dashboard-segmented"><button type="button" className={analysisView === 'trend' ? 'active' : ''} onClick={() => setAnalysisView('trend')}>调用趋势</button><button type="button" className={analysisView === 'share' ? 'active' : ''} onClick={() => setAnalysisView('share')}>调用占比</button><button type="button" className={analysisView === 'rank' ? 'active' : ''} onClick={() => setAnalysisView('rank')}>调用排行</button></div></header>
            {analysisView === 'trend' ? <DashboardChart buckets={summary.buckets} models={visibleModels} metric="count" kind="area" range={range} quotaPerUnit={balance?.quotaPerUnit} /> : (
              <div className={`account-dashboard-model-list ${analysisView}`}>
                {summary.models.slice(0, 10).map((item, index) => {
                  const share = summary.count > 0 ? item.count / summary.count * 100 : 0
                  return <article key={item.model}><span className="account-dashboard-rank">{index + 1}</span><div><strong>{item.model}</strong><span><i style={{ width: `${share}%` }} /></span></div><div><strong>{analysisView === 'share' ? `${share.toFixed(1)}%` : item.count.toLocaleString('zh-CN')}</strong><small>{formatUsageCostUsd(item.quota, balance?.quotaPerUnit)}</small></div></article>
                })}
              </div>
            )}
            <div className="account-dashboard-legend">{summary.models.slice(0, 6).map((item, index) => <span key={item.model}><i className={`series-${index % 6}`} />{item.model}</span>)}</div>
          </section>
        </>
      )}
    </div>
  )
}

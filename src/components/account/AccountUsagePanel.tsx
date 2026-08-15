import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Inbox,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type { AccountUsagePage, AccountUsageQuery, AccountUsageRecord } from '../../types'
import { errorMessage } from '../../error-message'
import { DialogBackdrop } from '../Dialog'
import {
  accountUsageTypeLabel,
  formatAccountUsageDate,
  formatUsageCostUsd,
} from './account-center'

const PAGE_SIZES = [10, 20, 50, 100] as const

export interface AccountUsageFilterDraft {
  startAt: string
  endAt: string
  modelName: string
  group: string
  type: string
  tokenName: string
  requestId: string
  upstreamRequestId: string
}

export const emptyAccountUsageFilters: AccountUsageFilterDraft = {
  startAt: '',
  endAt: '',
  modelName: '',
  group: '',
  type: '',
  tokenName: '',
  requestId: '',
  upstreamRequestId: '',
}

export function accountUsageTimestamp(value: string): number | undefined {
  if (!value) return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : undefined
}

export function buildAccountUsageQuery(
  filters: AccountUsageFilterDraft,
  page: number,
  pageSize: number,
): AccountUsageQuery {
  const query: AccountUsageQuery = { page, pageSize }
  const startTimestamp = accountUsageTimestamp(filters.startAt)
  const endTimestamp = accountUsageTimestamp(filters.endAt)
  const type = filters.type === '' ? undefined : Number(filters.type)
  if (startTimestamp !== undefined) query.startTimestamp = startTimestamp
  if (endTimestamp !== undefined) query.endTimestamp = endTimestamp
  if (Number.isInteger(type)) query.type = type
  if (filters.modelName.trim()) query.modelName = filters.modelName.trim()
  if (filters.group.trim()) query.group = filters.group.trim()
  if (filters.tokenName.trim()) query.tokenName = filters.tokenName.trim()
  if (filters.requestId.trim()) query.requestId = filters.requestId.trim()
  if (filters.upstreamRequestId.trim()) query.upstreamRequestId = filters.upstreamRequestId.trim()
  return query
}

export function accountUsagePagination(currentPage: number, totalPages: number): Array<number | null> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)
  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1])
  const sorted = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((left, right) => left - right)
  const result: Array<number | null> = []
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) result.push(null)
    result.push(page)
  })
  return result
}

function compactNumber(value: number): string {
  return Math.max(0, value).toLocaleString('zh-CN')
}

function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 1) return `${Math.round(seconds * 1_000)} ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

function millisecondsLabel(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  return milliseconds < 1_000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1_000).toFixed(2)} s`
}

function ratioLabel(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value}x`
}

function streamLabel(record: AccountUsageRecord): string {
  if (record.details.streamStatus?.status) return record.details.streamStatus.status
  return record.isStream ? '流式' : '非流式'
}

function tokensPerSecond(record: AccountUsageRecord): string {
  if (!record.isStream || record.useTimeSeconds <= 0 || record.completionTokens <= 0) return '—'
  return `${(record.completionTokens / record.useTimeSeconds).toFixed(1)} t/s`
}

function UsageDetailsDialog({
  record,
  quotaPerUnit,
  onClose,
}: {
  record: AccountUsageRecord
  quotaPerUnit: number | undefined
  onClose: () => void
}) {
  const details = record.details
  const detailRows: Array<[string, string]> = [
    ['日志类型', accountUsageTypeLabel(record.type)],
    ['记录时间', formatAccountUsageDate(record.createdAt)],
    ['总耗时', durationLabel(record.useTimeSeconds)],
    ['首字耗时', millisecondsLabel(details.firstResponseTimeMs)],
    ['流式状态', streamLabel(record)],
    ['输出速度', tokensPerSecond(record)],
    ['推理强度', details.reasoningEffort || '—'],
    ['输入 Token', compactNumber(record.promptTokens)],
    ['输出 Token', compactNumber(record.completionTokens)],
    ['缓存读取 Token', compactNumber(details.cacheTokens)],
    ['缓存写入 Token', compactNumber(details.cacheCreationTokens)],
    ['5 分钟缓存写入', compactNumber(details.cacheCreationTokens5m)],
    ['1 小时缓存写入', compactNumber(details.cacheCreationTokens1h)],
    ['计费模式', details.billingMode || '—'],
    ['命中档位', details.matchedTier || '—'],
    ['模型倍率', ratioLabel(details.modelRatio)],
    ['输出倍率', ratioLabel(details.completionRatio)],
    ['分组倍率', ratioLabel(details.groupRatio)],
    ['用户分组倍率', ratioLabel(details.userGroupRatio)],
    ['缓存倍率', ratioLabel(details.cacheRatio)],
    ['总费用', formatUsageCostUsd(record.quota, quotaPerUnit)],
  ]

  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={onClose}>
      <section className="account-usage-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="account-usage-detail-title">
        <header>
          <div>
            <span>{accountUsageTypeLabel(record.type)}</span>
            <h2 id="account-usage-detail-title">日志详情</h2>
            <p>{record.modelName || '未知模型'} · {record.tokenName || '未命名令牌'}</p>
          </div>
          <button type="button" className="icon-button" title="关闭日志详情" aria-label="关闭日志详情" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="account-usage-detail-body">
          <section className="account-usage-detail-grid">
            {detailRows.map(([label, value]) => (
              <div key={label}><span>{label}</span><strong>{value}</strong></div>
            ))}
          </section>
          <section className="account-usage-detail-identifiers">
            <div><span>请求 ID</span><code>{record.requestId || '—'}</code></div>
            <div><span>上游请求 ID</span><code>{record.upstreamRequestId || '—'}</code></div>
            <div><span>请求分组</span><code>{record.group || '—'}</code></div>
            <div><span>上游模型</span><code>{details.upstreamModelName || '—'}</code></div>
          </section>
          {(details.streamStatus?.endReason || details.streamStatus?.endError || details.streamStatus?.errors.length) ? (
            <section className="account-usage-detail-message">
              <h3>流状态</h3>
              {details.streamStatus.endReason && <p>结束原因：{details.streamStatus.endReason}</p>}
              {details.streamStatus.endError && <p>结束错误：{details.streamStatus.endError}</p>}
              {details.streamStatus.errors.map((entry, index) => <p key={`${index}-${entry}`}>{entry}</p>)}
            </section>
          ) : null}
          {record.content && (
            <section className="account-usage-detail-message">
              <h3>用户可见说明</h3>
              <p>{record.content}</p>
            </section>
          )}
        </div>
      </section>
    </DialogBackdrop>
  )
}

export function AccountUsagePanel({ quotaPerUnit }: { quotaPerUnit: number | undefined }) {
  const [draft, setDraft] = useState<AccountUsageFilterDraft>(emptyAccountUsageFilters)
  const [filters, setFilters] = useState<AccountUsageFilterDraft>(emptyAccountUsageFilters)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(20)
  const [usage, setUsage] = useState<AccountUsagePage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [selected, setSelected] = useState<AccountUsageRecord | null>(null)
  const requestId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const query = useMemo(() => buildAccountUsageQuery(filters, page, pageSize), [filters, page, pageSize])
  const load = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setFailure(null)
    try {
      const next = await window.xingmang.getAccountUsage(query)
      if (!mounted.current || currentRequest !== requestId.current) return
      setUsage(next)
    } catch (error) {
      if (mounted.current && currentRequest === requestId.current) setFailure(errorMessage(error))
    } finally {
      if (mounted.current && currentRequest === requestId.current) setLoading(false)
    }
  }, [query])

  useEffect(() => { void load() }, [load])

  const submit = () => {
    const start = accountUsageTimestamp(draft.startAt)
    const end = accountUsageTimestamp(draft.endAt)
    if (start !== undefined && end !== undefined && start > end) {
      setFailure('开始时间不能晚于结束时间')
      return
    }
    setFailure(null)
    setPage(1)
    setFilters({ ...draft })
  }

  const reset = () => {
    setDraft(emptyAccountUsageFilters)
    setFilters(emptyAccountUsageFilters)
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil((usage?.total ?? 0) / pageSize))
  const pagination = accountUsagePagination(page, totalPages)
  const hasAdvancedFilters = Boolean(filters.tokenName || filters.requestId || filters.upstreamRequestId)

  return (
    <div className="account-usage-panel">
      <header className="account-usage-heading">
        <strong>{usage?.total.toLocaleString('zh-CN') ?? '—'} 条记录</strong>
      </header>
      <section className="account-usage-filter-panel" aria-label="使用日志筛选">
        <div className="account-usage-filter-grid">
          <label><span>开始时间</span><input type="datetime-local" value={draft.startAt} onChange={(event) => setDraft((current) => ({ ...current, startAt: event.target.value }))} /></label>
          <label><span>结束时间</span><input type="datetime-local" value={draft.endAt} onChange={(event) => setDraft((current) => ({ ...current, endAt: event.target.value }))} /></label>
          <label><span>模型名称</span><input value={draft.modelName} maxLength={128} placeholder="例如 gpt-5" onChange={(event) => setDraft((current) => ({ ...current, modelName: event.target.value }))} /></label>
          <label><span>分组</span><input value={draft.group} maxLength={128} placeholder="全部分组" onChange={(event) => setDraft((current) => ({ ...current, group: event.target.value }))} /></label>
          <label><span>日志类型</span><select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value }))}><option value="">全部类型</option>{[0, 1, 2, 3, 4, 5, 6, 7].map((type) => <option value={type} key={type}>{accountUsageTypeLabel(type)}</option>)}</select></label>
        </div>
        {advancedOpen && (
          <div className="account-usage-filter-grid advanced">
            <label><span>令牌名称</span><input value={draft.tokenName} maxLength={128} placeholder="API Key 名称" onChange={(event) => setDraft((current) => ({ ...current, tokenName: event.target.value }))} /></label>
            <label><span>请求 ID</span><input value={draft.requestId} maxLength={128} placeholder="请求标识" onChange={(event) => setDraft((current) => ({ ...current, requestId: event.target.value }))} /></label>
            <label><span>上游请求 ID</span><input value={draft.upstreamRequestId} maxLength={256} placeholder="上游请求标识" onChange={(event) => setDraft((current) => ({ ...current, upstreamRequestId: event.target.value }))} /></label>
          </div>
        )}
        <div className="account-usage-filter-footer">
          <button type="button" className={`account-usage-advanced-toggle${advancedOpen ? ' expanded' : ''}`} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
            <SlidersHorizontal size={15} /><span>更多筛选{hasAdvancedFilters ? '（已启用）' : ''}</span><ChevronDown size={14} />
          </button>
          <div className="account-usage-filter-actions">
            <button type="button" className="secondary-button" disabled={loading} onClick={reset}><RotateCcw size={15} />重置</button>
            <button type="button" className="primary-button" disabled={loading} onClick={submit}><Search size={15} />搜索</button>
          </div>
        </div>
      </section>

      <section className="account-usage-stats" aria-label="使用日志统计">
        <div><span>筛选用量</span><strong>{usage ? formatUsageCostUsd(usage.stats.quota, quotaPerUnit) : '—'}</strong><small>当前筛选条件累计费用</small></div>
        <div><span>RPM</span><strong>{usage ? compactNumber(usage.stats.rpm) : '—'}</strong><small>每分钟请求峰值</small></div>
        <div><span>TPM</span><strong>{usage ? compactNumber(usage.stats.tpm) : '—'}</strong><small>每分钟 Token 峰值</small></div>
      </section>

      {failure && !usage ? (
        <div className="session-error" role="alert"><FileWarning size={18} /><div><strong>使用日志读取失败</strong><span>{failure}</span></div><button type="button" className="secondary-button" onClick={() => void load()}>重试</button></div>
      ) : (
        <section className="account-usage-table-shell" aria-busy={loading}>
          <div className="account-usage-table-scroll">
            <div className="account-usage-table-head" aria-hidden="true"><span>时间 / 类型</span><span>模型 / API Key</span><span>Token / 缓存</span><span>性能</span><span>费用</span><span>详情</span></div>
            <div className="account-usage-table-body">
              {(usage?.records ?? []).map((record) => (
                <button type="button" className="account-usage-table-row" key={record.id} onClick={() => setSelected(record)}>
                  <span><strong>{formatAccountUsageDate(record.createdAt)}</strong><small>{accountUsageTypeLabel(record.type)}</small></span>
                  <span className="account-usage-model-cell"><strong title={record.modelName || '未知模型'}>{record.modelName || '未知模型'}</strong><small title={`${record.tokenName || '未命名令牌'} · ${record.group || '默认分组'}`}>{record.tokenName || '未命名令牌'} · {record.group || '默认分组'}</small></span>
                  <span><strong>{compactNumber(record.promptTokens)} → {compactNumber(record.completionTokens)}</strong><small>缓存命中 {compactNumber(record.details.cacheTokens)}</small></span>
                  <span><strong>{streamLabel(record)} · {tokensPerSecond(record)}</strong><small>{durationLabel(record.useTimeSeconds)} · 首字 {millisecondsLabel(record.details.firstResponseTimeMs)}</small></span>
                  <span><strong>{formatUsageCostUsd(record.quota, quotaPerUnit)}</strong><small>{record.details.billingMode || '—'}</small></span>
                  <span className="account-usage-detail-link">查看<ChevronRight size={14} /></span>
                </button>
              ))}
              {!loading && usage?.records.length === 0 && (
                <div className="account-usage-empty"><Inbox size={22} /><strong>没有符合条件的日志</strong><span>调整筛选条件后重新搜索。</span></div>
              )}
            </div>
          </div>
          {loading && <div className="account-usage-loading"><LoaderCircle size={18} className="spin" />正在读取使用日志…</div>}
          {failure && usage && <div className="account-usage-inline-error" role="alert"><span>{failure}</span><button type="button" onClick={() => void load()}><RefreshCw size={14} />重试</button></div>}
          <footer className="account-usage-pagination">
            <div className="account-usage-page-size"><span>每页</span><select aria-label="每页日志数量" value={pageSize} disabled={loading} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select><span>条，共 {usage?.total ?? 0} 条</span></div>
            <div className="account-usage-page-buttons">
              <button type="button" title="第一页" aria-label="第一页" disabled={page <= 1 || loading} onClick={() => setPage(1)}><ChevronFirst size={15} /></button>
              <button type="button" title="上一页" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={15} /></button>
              {pagination.map((entry, index) => entry === null ? <span key={`ellipsis-${index}`}>…</span> : <button type="button" key={entry} className={entry === page ? 'active' : ''} aria-label={`第 ${entry} 页`} aria-current={entry === page ? 'page' : undefined} disabled={loading} onClick={() => setPage(entry)}>{entry}</button>)}
              <button type="button" title="下一页" aria-label="下一页" disabled={page >= totalPages || loading} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}><ChevronRight size={15} /></button>
              <button type="button" title="最后一页" aria-label="最后一页" disabled={page >= totalPages || loading} onClick={() => setPage(totalPages)}><ChevronLast size={15} /></button>
            </div>
          </footer>
        </section>
      )}

      {selected && <UsageDetailsDialog record={selected} quotaPerUnit={quotaPerUnit} onClose={() => setSelected(null)} />}
    </div>
  )
}

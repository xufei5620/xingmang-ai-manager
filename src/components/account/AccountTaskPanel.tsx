import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileWarning,
  Inbox,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from 'lucide-react'
import type { AccountTaskPage, AccountTaskQuery, AccountTaskRecord } from '../../types'
import { errorMessage } from '../../error-message'
import { DialogBackdrop } from '../Dialog'
import { formatAccountUsageDate, formatUsageCostUsd } from './account-center'
import { accountUsagePagination, accountUsageTimestamp } from './AccountUsagePanel'

const PAGE_SIZES = [10, 20, 50, 100] as const

export interface AccountTaskFilterDraft {
  startAt: string
  endAt: string
  platform: string
  taskId: string
  status: string
  action: string
}

export const emptyAccountTaskFilters: AccountTaskFilterDraft = {
  startAt: '',
  endAt: '',
  platform: '',
  taskId: '',
  status: '',
  action: '',
}

export function buildAccountTaskQuery(
  filters: AccountTaskFilterDraft,
  page: number,
  pageSize: number,
): AccountTaskQuery {
  const query: AccountTaskQuery = { page, pageSize }
  const startTimestamp = accountUsageTimestamp(filters.startAt)
  const endTimestamp = accountUsageTimestamp(filters.endAt)
  if (startTimestamp !== undefined) query.startTimestamp = startTimestamp
  if (endTimestamp !== undefined) query.endTimestamp = endTimestamp
  if (filters.platform.trim()) query.platform = filters.platform.trim()
  if (filters.taskId.trim()) query.taskId = filters.taskId.trim()
  if (filters.status) query.status = filters.status
  if (filters.action.trim()) query.action = filters.action.trim()
  return query
}

export function accountTaskStatusLabel(status: string): string {
  if (status === 'NOT_START') return '未开始'
  if (status === 'SUBMITTED') return '已提交'
  if (status === 'QUEUED') return '排队中'
  if (status === 'IN_PROGRESS') return '处理中'
  if (status === 'SUCCESS') return '已完成'
  if (status === 'FAILURE') return '失败'
  return status || '未知'
}

const TASK_PLATFORM_LABELS: Record<string, string> = {
  '1': 'OpenAI',
  '17': '阿里云',
  '24': 'Gemini',
  '35': '海螺视频',
  '41': 'Vertex AI',
  '45': '火山引擎',
  '50': '可灵',
  '51': '即梦',
  '52': 'Vidu',
  '54': '豆包视频',
  '55': 'Sora',
  gemini: 'Gemini',
  openai: 'OpenAI',
  kling: '可灵',
  jimeng: '即梦',
  vidu: 'Vidu',
  mj: 'Midjourney',
  suno: 'Suno',
}

export function accountTaskPlatformLabel(platform: string): string {
  const normalized = platform.trim()
  return TASK_PLATFORM_LABELS[normalized] ?? (normalized || '未知平台')
}

function taskDuration(record: AccountTaskRecord): string {
  if (!record.startAt || !record.finishAt) return '—'
  const milliseconds = Date.parse(record.finishAt) - Date.parse(record.startAt)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  const seconds = milliseconds / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function taskStatusTone(status: string): string {
  if (status === 'SUCCESS') return 'success'
  if (status === 'FAILURE') return 'danger'
  if (status === 'IN_PROGRESS') return 'progress'
  return 'neutral'
}

function TaskDetailsDialog({
  record,
  quotaPerUnit,
  onClose,
}: {
  record: AccountTaskRecord
  quotaPerUnit: number | undefined
  onClose: () => void
}) {
  const rows: Array<[string, string]> = [
    ['任务 ID', record.taskId || '—'],
    ['状态', accountTaskStatusLabel(record.status)],
    ['平台', accountTaskPlatformLabel(record.platform)],
    ['动作', record.action || '—'],
    ['分组', record.group || '—'],
    ['原始模型', record.originModelName || '—'],
    ['上游模型', record.upstreamModelName || '—'],
    ['进度', record.progress || '—'],
    ['费用', formatUsageCostUsd(record.quota, quotaPerUnit)],
    ['耗时', taskDuration(record)],
    ['提交时间', formatAccountUsageDate(record.submitAt)],
    ['开始时间', formatAccountUsageDate(record.startAt)],
    ['完成时间', formatAccountUsageDate(record.finishAt)],
  ]
  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={onClose}>
      <section className="account-task-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="account-task-detail-title">
        <header>
          <div>
            <span>{record.platform || '异步任务'}</span>
            <h2 id="account-task-detail-title">任务详情</h2>
            <p>{record.originModelName || record.upstreamModelName || record.action || '任务记录'}</p>
          </div>
          <button type="button" className="icon-button" title="关闭任务详情" aria-label="关闭任务详情" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="account-task-detail-body">
          <section className="account-task-detail-grid">
            {rows.map(([label, value]) => <div key={label}><span>{label}</span><strong title={value}>{value}</strong></div>)}
          </section>
          {record.failReason && <section className="account-task-detail-message danger"><h3>失败原因</h3><p>{record.failReason}</p></section>}
          {record.resultUrl && (
            <section className="account-task-detail-message">
              <h3>任务结果</h3>
              <code>{record.resultUrl}</code>
              <button type="button" className="secondary-button" onClick={() => void window.xingmang.openExternal(record.resultUrl)}>
                <ExternalLink size={15} />打开结果
              </button>
            </section>
          )}
        </div>
      </section>
    </DialogBackdrop>
  )
}

export function AccountTaskPanel({ quotaPerUnit }: { quotaPerUnit: number | undefined }) {
  const [draft, setDraft] = useState<AccountTaskFilterDraft>(emptyAccountTaskFilters)
  const [filters, setFilters] = useState<AccountTaskFilterDraft>(emptyAccountTaskFilters)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(20)
  const [taskPage, setTaskPage] = useState<AccountTaskPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [selected, setSelected] = useState<AccountTaskRecord | null>(null)
  const requestId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const query = useMemo(() => buildAccountTaskQuery(filters, page, pageSize), [filters, page, pageSize])
  const load = useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoading(true)
    setFailure(null)
    try {
      const next = await window.xingmang.getAccountTasks(query)
      if (!mounted.current || currentRequest !== requestId.current) return
      setTaskPage(next)
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
    setDraft(emptyAccountTaskFilters)
    setFilters(emptyAccountTaskFilters)
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil((taskPage?.total ?? 0) / pageSize))
  const pagination = accountUsagePagination(page, totalPages)

  return (
    <div className="account-task-panel">
      <header className="account-task-heading">
        <strong>{taskPage?.total.toLocaleString('zh-CN') ?? '—'} 条记录</strong>
      </header>
      <section className="account-task-filter-panel" aria-label="任务筛选">
        <div className="account-task-filter-grid">
          <label><span>开始时间</span><input type="datetime-local" value={draft.startAt} onChange={(event) => setDraft((current) => ({ ...current, startAt: event.target.value }))} /></label>
          <label><span>结束时间</span><input type="datetime-local" value={draft.endAt} onChange={(event) => setDraft((current) => ({ ...current, endAt: event.target.value }))} /></label>
          <label><span>平台</span><input value={draft.platform} maxLength={64} placeholder="全部平台" onChange={(event) => setDraft((current) => ({ ...current, platform: event.target.value }))} /></label>
          <label><span>任务 ID</span><input value={draft.taskId} maxLength={256} placeholder="task_..." onChange={(event) => setDraft((current) => ({ ...current, taskId: event.target.value }))} /></label>
          <label><span>状态</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}><option value="">全部状态</option>{['NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'UNKNOWN'].map((status) => <option key={status} value={status}>{accountTaskStatusLabel(status)}</option>)}</select></label>
          <label><span>动作</span><input value={draft.action} maxLength={64} placeholder="例如 video" onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))} /></label>
        </div>
        <div className="account-task-filter-actions">
          <button type="button" className="secondary-button" disabled={loading} onClick={reset}><RotateCcw size={15} />重置</button>
          <button type="button" className="primary-button" disabled={loading} onClick={submit}><Search size={15} />搜索</button>
        </div>
      </section>

      {failure && !taskPage ? (
        <div className="session-error" role="alert"><FileWarning size={18} /><div><strong>任务读取失败</strong><span>{failure}</span></div><button type="button" className="secondary-button" onClick={() => void load()}>重试</button></div>
      ) : (
        <section className="account-task-table-shell" aria-busy={loading}>
          <div className="account-task-table-scroll" role="table" aria-label="异步任务" aria-colcount={8}>
            <div className="account-task-table-head" role="row"><span role="columnheader">提交时间 / 状态</span><span role="columnheader">平台 / 动作</span><span role="columnheader">模型</span><span role="columnheader">分组</span><span role="columnheader">费用</span><span role="columnheader">进度 / 耗时</span><span role="columnheader">结果</span><span role="columnheader">详情</span></div>
            <div className="account-task-table-body" role="rowgroup">
              {(taskPage?.tasks ?? []).map((record) => (
                <div role="row" className="account-task-table-row" key={record.id} onClick={() => setSelected(record)}>
                  <span role="cell"><strong>{formatAccountUsageDate(record.submitAt)}</strong><small className={`account-task-status ${taskStatusTone(record.status)}`}>{accountTaskStatusLabel(record.status)}</small></span>
                  <span role="cell"><strong title={record.platform}>{accountTaskPlatformLabel(record.platform)}</strong><small>{record.action || '—'}</small></span>
                  <span role="cell"><strong title={record.originModelName || '未知模型'}>{record.originModelName || '未知模型'}</strong><small title={record.upstreamModelName || undefined}>{record.upstreamModelName && record.upstreamModelName !== record.originModelName ? record.upstreamModelName : '—'}</small></span>
                  <span role="cell"><strong title={record.group || '默认分组'}>{record.group || '默认分组'}</strong><small>{record.taskId || '—'}</small></span>
                  <span role="cell"><strong>{formatUsageCostUsd(record.quota, quotaPerUnit)}</strong><small>{record.quota.toLocaleString('zh-CN')} quota</small></span>
                  <span role="cell"><strong>{record.progress || '—'}</strong><small>{taskDuration(record)}</small></span>
                  <span role="cell"><strong>{record.resultUrl ? '可查看' : record.failReason ? '失败' : '—'}</strong><small>{record.failReason || '—'}</small></span>
                  <span role="cell" className="account-task-detail-link"><button type="button" className="ui-table-detail-action" aria-label={`查看任务 ${record.taskId || record.id}`} onClick={() => setSelected(record)}>查看<ChevronRight size={14} aria-hidden="true" /></button></span>
                </div>
              ))}
              {!loading && taskPage?.tasks.length === 0 && <div role="row"><div role="cell" aria-colspan={8} className="account-task-empty"><Inbox size={22} /><strong>没有符合条件的任务</strong><span>异步图片、视频和音频任务会显示在这里。</span></div></div>}
            </div>
          </div>
          {loading && <div className="account-task-loading"><LoaderCircle size={18} className="spin" />正在读取任务…</div>}
          {failure && taskPage && <div className="account-task-inline-error" role="alert"><span>{failure}</span><button type="button" onClick={() => void load()}><RefreshCw size={14} />重试</button></div>}
          <footer className="account-task-pagination">
            <div className="account-task-page-size"><span>每页</span><select aria-label="每页任务数量" value={pageSize} disabled={loading} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select><span>条，共 {taskPage?.total ?? 0} 条</span></div>
            <div className="account-task-page-buttons">
              <button type="button" title="第一页" aria-label="第一页" disabled={page <= 1 || loading} onClick={() => setPage(1)}><ChevronFirst size={15} /></button>
              <button type="button" title="上一页" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={15} /></button>
              {pagination.map((entry, index) => entry === null ? <span key={`ellipsis-${index}`}>…</span> : <button type="button" key={entry} className={entry === page ? 'active' : ''} aria-label={`第 ${entry} 页`} aria-current={entry === page ? 'page' : undefined} disabled={loading} onClick={() => setPage(entry)}>{entry}</button>)}
              <button type="button" title="下一页" aria-label="下一页" disabled={page >= totalPages || loading} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}><ChevronRight size={15} /></button>
              <button type="button" title="最后一页" aria-label="最后一页" disabled={page >= totalPages || loading} onClick={() => setPage(totalPages)}><ChevronLast size={15} /></button>
            </div>
          </footer>
        </section>
      )}

      {selected && <TaskDetailsDialog record={selected} quotaPerUnit={quotaPerUnit} onClose={() => setSelected(null)} />}
    </div>
  )
}

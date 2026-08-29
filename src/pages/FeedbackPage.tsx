import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ClipboardCopy,
  Clock3,
  Download,
  FileClock,
  FolderOpen,
  HardDrive,
  Info,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { DialogBackdrop } from '../components/Dialog'
import { errorMessage } from '../error-message'
import type { RuntimeLogEntry, RuntimeLogSnapshot } from '../types'

type RuntimeLevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error'
type FeedbackAction = 'copy' | 'export' | 'open' | 'clear' | null

export interface FeedbackPageApi {
  getRuntimeLogs(limit?: number): Promise<RuntimeLogSnapshot>
  copyFeedbackReport(): Promise<{ entries: number }>
  exportFeedbackReport(): Promise<{ outputPath: string } | null>
  openRuntimeLogDirectory(): Promise<boolean>
  clearRuntimeLogs(): Promise<void>
}

export interface FeedbackPageProps {
  api: FeedbackPageApi
  notify?: (message: { type: 'success' | 'error'; message: string }) => void
}

const levelLabels: Record<Exclude<RuntimeLevelFilter, 'all'>, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
}

const legacyIpcMessages: Readonly<Record<string, string>> = {
  'desktop:codex-status': 'Codex 桌面端运行状态检测完成',
  'setup:codex-status': 'Codex 初始化状态检测完成',
  'config:get': '工具配置读取完成',
  'repository:get-context': '仓库上下文读取完成',
  'settings:get': '应用设置读取完成',
  'update:get-state': '主程序更新状态读取完成',
  'window:set-mode': '窗口模式切换完成',
  'window:set-theme': '界面主题切换完成',
  'system:scan': '本机环境与 AI 工具检测完成',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function displayLogMessage(entry: RuntimeLogEntry): string {
  return entry.message === '调用完成'
    ? legacyIpcMessages[entry.event] ?? `${entry.event} 执行完成`
    : entry.message
}

function compactErrorDetail(entry: RuntimeLogEntry): string | null {
  if (entry.level !== 'error' && entry.level !== 'warn') return null
  const error = isRecord(entry.detail?.error) ? entry.detail.error : null
  if (!error) return null
  const parts: string[] = []
  if (typeof error.code === 'string' && error.code) parts.push(`错误码 ${error.code}`)
  if (typeof error.exitCode === 'number') parts.push(`退出码 ${error.exitCode}`)
  if (typeof error.executable === 'string' && error.executable) parts.push(`命令 ${error.executable}`)
  const output = [error.stderr, error.stdout]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  if (output) {
    const summary = output.trim().split(/\r?\n/).find(Boolean)?.slice(0, 320)
    if (summary) parts.push(summary)
  }
  return parts.length ? parts.join(' · ') : null
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function LevelIcon({ level }: { level: Exclude<RuntimeLevelFilter, 'all'> }) {
  if (level === 'error') return <AlertCircle size={15} />
  if (level === 'warn') return <TriangleAlert size={15} />
  if (level === 'info') return <Info size={15} />
  return <Clock3 size={15} />
}

function ClearLogsDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={busy ? () => undefined : onCancel}>
      <section className="extension-confirm-dialog feedback-clear-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-runtime-logs-title">
        <span className="extension-confirm-icon danger"><Trash2 size={20} /></span>
        <h2 id="clear-runtime-logs-title">清空运行日志</h2>
        <p>当前日志和轮转记录将被删除，此操作无法撤销。</p>
        <div className="extension-dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button className="danger-button" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
            清空日志
          </button>
        </div>
      </section>
    </DialogBackdrop>
  )
}

export function FeedbackPage({ api, notify }: FeedbackPageProps) {
  const [snapshot, setSnapshot] = useState<RuntimeLogSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<RuntimeLevelFilter>('all')
  const [source, setSource] = useState('all')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [busy, setBusy] = useState<FeedbackAction>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const requestSequence = useRef(0)
  const refreshInFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback((quiet = false, force = false): Promise<void> => {
    if (!force && refreshInFlight.current) return refreshInFlight.current
    const requestId = ++requestSequence.current
    const request = (async () => {
      if (!quiet) setLoading(true)
      try {
        const next = await api.getRuntimeLogs(1_000)
        if (requestId !== requestSequence.current) return
        setSnapshot(next)
        setError(null)
      } catch (cause) {
        if (requestId !== requestSequence.current) return
        setError(errorMessage(cause))
      } finally {
        if (!quiet && requestId === requestSequence.current) setLoading(false)
      }
    })()
    refreshInFlight.current = request
    void request.finally(() => {
      if (refreshInFlight.current === request) refreshInFlight.current = null
    })
    return request
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!autoRefresh) return undefined
    const timer = window.setInterval(() => {
      if (busy === null) void refresh(true)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, busy, refresh])

  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return (snapshot?.entries ?? []).filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false
      if (source !== 'all' && entry.source !== source) return false
      if (!normalized) return true
      const detail = entry.detail ? JSON.stringify(entry.detail) : ''
      return [entry.message, entry.source, entry.event, detail]
        .some((value) => value.toLowerCase().includes(normalized))
    })
  }, [level, query, snapshot, source])

  const perform = async (action: Exclude<FeedbackAction, null>, operation: () => Promise<void>) => {
    setBusy(action)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      notify?.({ type: 'error', message })
    } finally {
      setBusy(null)
    }
  }

  const counts = snapshot?.counts ?? { debug: 0, info: 0, warn: 0, error: 0 }

  return (
    <div className="page workspace-page operations-page feedback-page" data-page-id="feedback">
      <header className="page-header workspace-page-header">
        <div>
          <div className="eyebrow">FEEDBACK & DIAGNOSTICS</div>
          <h1>反馈与诊断</h1>
        </div>
        <div className="header-actions page-toolbar feedback-actions" role="toolbar" aria-label="反馈工具栏">
          <button className="icon-button" type="button" title="刷新日志" aria-label="刷新日志" onClick={() => void refresh()} disabled={loading || busy !== null}>
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
          </button>
          <button className="icon-button" type="button" title="打开日志目录" aria-label="打开日志目录" disabled={busy !== null} onClick={() => void perform('open', async () => {
            await api.openRuntimeLogDirectory()
          })}>
            {busy === 'open' ? <LoaderCircle className="spin" size={18} /> : <FolderOpen size={18} />}
          </button>
          <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void perform('export', async () => {
            const result = await api.exportFeedbackReport()
            if (result) notify?.({ type: 'success', message: `诊断报告已导出：${result.outputPath}` })
          })}>
            {busy === 'export' ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
            导出 TXT
          </button>
          <button className="primary-button" type="button" disabled={busy !== null} onClick={() => void perform('copy', async () => {
            const result = await api.copyFeedbackReport()
            notify?.({ type: 'success', message: `已复制脱敏反馈文本，共 ${result.entries} 条日志` })
          })}>
            {busy === 'copy' ? <LoaderCircle className="spin" size={16} /> : <ClipboardCopy size={16} />}
            复制反馈
          </button>
        </div>
      </header>

      {error && <div className="operation-error" role="alert"><AlertCircle size={16} />{error}</div>}

      <section className="environment-section feedback-summary" aria-label="运行日志摘要">
        <div className="section-heading">
          <div>
            <h2>运行日志</h2>
            <span>{snapshot ? `${formatTimestamp(snapshot.generatedAt)} · ${snapshot.entries.length}/${snapshot.total} 条` : '正在读取'}</span>
          </div>
          <code className="feedback-log-path" title={snapshot?.filePath}>{snapshot?.filePath ?? 'runtime.jsonl'}</code>
        </div>
        <div className="runtime-grid feedback-count-grid">
          <div className="runtime-cell feedback-count">
            <div className="runtime-icon"><FileClock size={17} /></div>
            <div className="runtime-copy"><div className="runtime-name">日志总数</div><span className="runtime-version">{snapshot?.total ?? 0} 条</span></div>
          </div>
          <div className="runtime-cell feedback-count is-error">
            <div className="runtime-icon"><AlertCircle size={17} /></div>
            <div className="runtime-copy"><div className="runtime-name">错误</div><span className="runtime-version">{counts.error} 条</span></div>
          </div>
          <div className="runtime-cell feedback-count is-warn">
            <div className="runtime-icon"><TriangleAlert size={17} /></div>
            <div className="runtime-copy"><div className="runtime-name">警告</div><span className="runtime-version">{counts.warn} 条</span></div>
          </div>
          <div className="runtime-cell feedback-count">
            <div className="runtime-icon"><HardDrive size={17} /></div>
            <div className="runtime-copy"><div className="runtime-name">占用空间</div><span className="runtime-version">{formatBytes(snapshot?.sizeBytes ?? 0)}</span></div>
          </div>
        </div>
      </section>

      <div className="management-toolbar management-toolbar-wrap feedback-toolbar">
        <label className="management-search feedback-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索消息、事件或详情" aria-label="搜索运行日志" />
        </label>
        <label className="feedback-select">
          <span>级别</span>
          <select value={level} onChange={(event) => setLevel(event.target.value as RuntimeLevelFilter)} aria-label="日志级别">
            <option value="all">全部级别</option>
            <option value="error">错误</option>
            <option value="warn">警告</option>
            <option value="info">信息</option>
            <option value="debug">调试</option>
          </select>
        </label>
        <label className="feedback-select">
          <span>来源</span>
          <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="日志来源">
            <option value="all">全部来源</option>
            {(snapshot?.sources ?? []).map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
        <label className="feedback-auto-refresh">
          <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
          <span>自动刷新</span>
        </label>
        <button className="icon-button compact feedback-clear-button" type="button" title="清空日志" aria-label="清空日志" disabled={busy !== null || !snapshot?.total} onClick={() => setClearOpen(true)}>
          <Trash2 size={16} />
        </button>
      </div>

      <section className="environment-section feedback-log-section" aria-labelledby="runtime-log-list-title">
        <div className="section-heading feedback-list-heading">
          <div>
            <h2 id="runtime-log-list-title">日志明细</h2>
            <span>{visibleEntries.length} 条匹配结果{snapshot?.truncated ? ' · 已限制为最近记录' : ''}</span>
          </div>
        </div>
        {loading && !snapshot ? (
          <div className="feedback-log-empty"><LoaderCircle className="spin" size={22} /><span>正在读取运行日志</span></div>
        ) : visibleEntries.length ? (
          <div className="feedback-log-list" role="log" aria-live="polite">
            {visibleEntries.map((entry) => (
              <article className={`feedback-log-row is-${entry.level}`} key={entry.id}>
                <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
                <span className={`feedback-level is-${entry.level}`}><LevelIcon level={entry.level} />{levelLabels[entry.level]}</span>
                <div className="feedback-log-copy">
                  <div><strong>{displayLogMessage(entry)}</strong><code>{entry.source}/{entry.event}</code></div>
                  {compactErrorDetail(entry) && <p className="feedback-error-summary">{compactErrorDetail(entry)}</p>}
                  {entry.detail && Object.keys(entry.detail).length > 0 && (
                    <details>
                      <summary>{entry.level === 'error' ? '查看完整错误详情' : '查看详情'}</summary>
                      <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="feedback-log-empty"><FileClock size={22} /><span>{snapshot?.total ? '没有匹配的日志' : '暂无运行日志'}</span></div>
        )}
      </section>

      {clearOpen && (
        <ClearLogsDialog
          busy={busy === 'clear'}
          onCancel={() => setClearOpen(false)}
          onConfirm={() => void perform('clear', async () => {
            const resumeAutoRefresh = autoRefresh
            requestSequence.current += 1
            // Invalidate both the response token and any request currently in
            // flight. A forced refresh below will repopulate the empty view
            // after the destructive operation completes.
            refreshInFlight.current = null
            setAutoRefresh(false)
            try {
              await api.clearRuntimeLogs()
              setClearOpen(false)
              setSnapshot(null)
              await refresh(false, true)
              notify?.({ type: 'success', message: '运行日志已清空' })
            } finally {
              setAutoRefresh(resumeAutoRefresh)
            }
          })}
        />
      )}
    </div>
  )
}

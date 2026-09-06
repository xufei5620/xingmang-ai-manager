import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Download,
  HeartPulse,
  LoaderCircle,
  Play,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
import { errorMessage } from '../error-message'
import './maintenance-v3.css'

export type HealthCheckState = 'pass' | 'warn' | 'fail' | 'error'

export interface HealthCheckItem {
  code: string
  title: string
  state: HealthCheckState
  summary: string
  details?: Record<string, boolean | number | string | null>
  durationMs: number
}

export interface HealthReport {
  version: 1
  generatedAt: string
  durationMs: number
  counts: Record<HealthCheckState, number>
  items: HealthCheckItem[]
}

export interface HealthPageApi {
  run(): Promise<HealthReport>
  exportLatest(): Promise<void>
}

export interface HealthPageProps {
  api: HealthPageApi
  initialReport?: HealthReport | null
  onResolve?: (item: HealthCheckItem) => void
}

const stateLabels: Record<HealthCheckState, string> = {
  pass: '通过',
  warn: '注意',
  fail: '失败',
  error: '异常',
}

function StateIcon({ state }: { state: HealthCheckState }) {
  if (state === 'pass') return <CheckCircle2 size={17} />
  if (state === 'warn') return <TriangleAlert size={17} />
  if (state === 'fail') return <ShieldAlert size={17} />
  return <AlertCircle size={17} />
}

export function HealthPage({ api, initialReport = null, onResolve }: HealthPageProps) {
  const [report, setReport] = useState<HealthReport | null>(initialReport)
  const [running, setRunning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialReportRef = useRef<HealthReport | null>(initialReport)
  const pendingRef = useRef(false)
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (initialReport === initialReportRef.current) return
    initialReportRef.current = initialReport
    if (pendingRef.current) return
    setReport(initialReport)
  }, [initialReport])

  const run = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    setRunning(true)
    setError(null)
    try {
      const next = await api.run()
      if (mounted.current) setReport(next)
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      pendingRef.current = false
      if (mounted.current) setRunning(false)
    }
  }

  const exportLatest = async () => {
    if (pendingRef.current || !report) return
    pendingRef.current = true
    setExporting(true)
    setError(null)
    try {
      await api.exportLatest()
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      pendingRef.current = false
      if (mounted.current) setExporting(false)
    }
  }

  return (
    <div className="page workspace-page operations-page maintenance-v3 health-v3" data-page-id="health">
      <header className="page-header workspace-page-header">
        <div>
          <h1>检查</h1>
          <p className="page-lead">环境 · 配置 · 网络</p>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="检查工具栏">
          <button className="secondary-button" type="button" onClick={exportLatest} disabled={!report || running || exporting}>
            {exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
            导出报告
          </button>
          <button className="primary-button" type="button" onClick={run} disabled={running || exporting}>
            {running ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
            {running ? '检查中' : '开始检查'}
          </button>
        </div>
      </header>

      {error && <div className="operation-error" role="alert"><AlertCircle size={16} />{error}</div>}

      {report ? (
        <>
          <section className="environment-section operations-summary" aria-label="诊断摘要">
            <div className="section-heading">
              <div>
                <h2>检查结果</h2>
                <span>{new Date(report.generatedAt).toLocaleString()} · {report.durationMs}ms</span>
              </div>
            </div>
            <div className="runtime-grid health-count-grid">
              {(['pass', 'warn', 'fail', 'error'] as const).map((state) => (
                <div className={`runtime-cell health-count is-${state}`} key={state}>
                  <div className="runtime-icon"><StateIcon state={state} /></div>
                  <div className="runtime-copy">
                    <div className="runtime-name">{stateLabels[state]}</div>
                    <span className="runtime-version">{report.counts[state]} 项</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="environment-section health-results" aria-labelledby="health-results-title">
            <div className="section-heading">
              <div>
                <h2 id="health-results-title">逐项结果</h2>
                <span>{report.items.length} 项检查</span>
              </div>
            </div>
            <div className="operations-list" role="list">
              {report.items.map((item) => (
                <article className={`operation-row health-row is-${item.state}`} key={item.code} role="listitem">
                  <div className="operation-status-icon"><StateIcon state={item.state} /></div>
                  <div className="operation-row-copy">
                    <div className="operation-row-title">
                      <strong>{item.title}</strong>
                      <span className={`operation-state is-${item.state}`}>{stateLabels[item.state]}</span>
                    </div>
                    <p>{item.summary}</p>
                    {item.details && Object.keys(item.details).length > 0 && <details className="health-detail-disclosure"><summary>检查详情</summary>
                      <dl className="operation-details">
                        {Object.entries(item.details).map(([name, value]) => (
                          <div key={name}><dt>{name}</dt><dd>{String(value ?? '-')}</dd></div>
                        ))}
                      </dl>
                    </details>}
                  </div>
                  <div className="health-row-actions"><span className="operation-duration">{item.durationMs}ms</span>
                    {item.state !== 'pass' && onResolve && <button type="button" className="secondary-button" disabled={running || exporting} onClick={() => {
                      if (pendingRef.current) return
                      try { onResolve(item) } catch (cause) { setError(errorMessage(cause)) }
                    }}>去处理<ArrowRight size={14} aria-hidden="true" /></button>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : running ? (
        <section className="workspace-empty" role="status"><LoaderCircle className="spin" size={24} aria-hidden="true" /><h2>正在检查本机状态</h2></section>
      ) : (
        <section className="workspace-empty" aria-labelledby="health-empty-title">
          <div className="workspace-empty-icon"><HeartPulse size={24} /></div>
          <h2 id="health-empty-title">还没检查过</h2>
        </section>
      )}
    </div>
  )
}

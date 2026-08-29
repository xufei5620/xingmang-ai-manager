import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  HeartPulse,
  LoaderCircle,
  Play,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
import { errorMessage } from '../error-message'

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

export function HealthPage({ api, initialReport = null }: HealthPageProps) {
  const [report, setReport] = useState<HealthReport | null>(initialReport)
  const [running, setRunning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const localReport = useRef<HealthReport | null>(initialReport)

  useEffect(() => {
    if (running || initialReport === localReport.current) return
    localReport.current = initialReport
    setReport(initialReport)
  }, [initialReport, running])

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const next = await api.run()
      localReport.current = next
      setReport(next)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRunning(false)
    }
  }

  const exportLatest = async () => {
    setExporting(true)
    setError(null)
    try {
      await api.exportLatest()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="page workspace-page operations-page" data-page-id="health">
      <header className="page-header workspace-page-header">
        <div>
          <div className="eyebrow">系统</div>
          <h1>健康诊断</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="诊断工具栏">
          <button className="secondary-button" type="button" onClick={exportLatest} disabled={!report || running || exporting}>
            {exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
            导出脱敏报告
          </button>
          <button className="primary-button" type="button" onClick={run} disabled={running || exporting}>
            {running ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
            {running ? '诊断中' : '运行诊断'}
          </button>
        </div>
      </header>

      {error && <div className="operation-error" role="alert"><AlertCircle size={16} />{error}</div>}

      {report ? (
        <>
          <section className="environment-section operations-summary" aria-label="诊断摘要">
            <div className="section-heading">
              <div>
                <h2>诊断摘要</h2>
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
                <h2 id="health-results-title">检查结果</h2>
                <span>每项检查独立超时，异常项不会阻塞其他结果</span>
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
                    {item.details && Object.keys(item.details).length > 0 && (
                      <dl className="operation-details">
                        {Object.entries(item.details).map(([name, value]) => (
                          <div key={name}><dt>{name}</dt><dd>{String(value ?? '-')}</dd></div>
                        ))}
                      </dl>
                    )}
                  </div>
                  <span className="operation-duration">{item.durationMs}ms</span>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : (
        <section className="workspace-empty" aria-labelledby="health-empty-title">
          <div className="workspace-empty-icon"><HeartPulse size={24} /></div>
          <h2 id="health-empty-title">尚未运行诊断</h2>
          <p>运行后将显示环境、配置、网络和权限状态</p>
        </section>
      )}
    </div>
  )
}

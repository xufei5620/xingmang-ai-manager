import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HealthPage, type HealthReport } from '../src/pages/HealthPage'
import { FeedbackPage, type FeedbackPageApi } from '../src/pages/FeedbackPage'
import { UpdatePage } from '../src/pages/UpdatePage'
import { TutorialPage } from '../src/pages/TutorialPage'
import { NavigationStateProvider } from '../src/components/shell/NavigationState'
import type { RuntimeLogSnapshot, UpdateSnapshot } from '../src/types'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'

const search = new URLSearchParams(location.search)
const view = search.get('view') ?? 'health'
const scenario = search.get('scenario') ?? 'normal'
document.documentElement.dataset.theme = search.get('theme') ?? 'dark'
document.documentElement.dataset.skin = search.get('theme') === 'light' ? 'dawn' : 'obsidian'
declare global {
  interface Window {
    maintenanceHarness: {
      runCalls: number
      exportHealthCalls: number
      resolved: string[]
      loadCalls: number
      previewCalls: number
      copyIds: Array<string | undefined>
      exportIds: Array<string | undefined>
      clearCalls: number
      updates: string[]
      supportCalls: number
      loadFailure: boolean
      releaseHealth: (success: boolean) => void
      releaseCopy: (success: boolean) => void
    }
  }
}
window.maintenanceHarness = { runCalls: 0, exportHealthCalls: 0, resolved: [], loadCalls: 0, previewCalls: 0, copyIds: [], exportIds: [], clearCalls: 0, updates: [], supportCalls: 0, loadFailure: scenario === 'logs-fail', releaseHealth: () => {}, releaseCopy: () => {} }

const report: HealthReport = { version: 1, generatedAt: '2026-09-07T00:00:00.000Z', durationMs: 240, counts: { pass: 1, warn: 1, fail: 1, error: 0 }, items: [
  { code: 'APP_RUNTIME', title: '应用环境', state: 'pass', summary: '运行正常', durationMs: 40 },
  { code: 'RUNTIME_NODE', title: 'Node.js', state: 'fail', summary: '版本过低', durationMs: 100, details: { detectedVersion: '16.0.0', path: 'C:\\Users\\fixture\\long-workspace-folder\\node.exe' } },
  { code: 'XINGMANG_NETWORK', title: '星芒网络', state: 'warn', summary: '接口响应较慢，请检查网络', durationMs: 100 },
] }
let cleared = false
const feedbackApi: FeedbackPageApi = {
  async getRuntimeLogs() {
    window.maintenanceHarness.loadCalls += 1
    if (window.maintenanceHarness.loadFailure) throw new Error('日志文件读取失败')
    const snapshot: RuntimeLogSnapshot = { generatedAt: '2026-09-07T00:00:00.000Z', directory: 'C:\\logs', filePath: 'C:\\logs\\runtime.jsonl', total: cleared ? 0 : 2, sizeBytes: 2048, truncated: false, sources: ['fixture'], counts: { debug: 0, info: cleared ? 0 : 1, warn: 0, error: cleared ? 0 : 1 }, entries: cleared ? [] : [
      { id: 'log-info', timestamp: '2026-09-07T00:00:00.000Z', level: 'info', source: 'fixture', event: 'ready', message: `当前日志 ${window.maintenanceHarness.loadCalls}`, detail: null },
      { id: 'log-error', timestamp: '2026-09-07T00:00:01.000Z', level: 'error', source: 'fixture', event: 'request.failed', message: '网络请求失败', detail: { error: { code: 'TIMEOUT', stderr: 'Request timed out' } } },
    ] }
    return snapshot
  },
  getFeedbackReport: scenario === 'legacy-feedback' ? undefined : async () => {
    window.maintenanceHarness.previewCalls += 1
    if (scenario === 'preview-fails-once' && window.maintenanceHarness.previewCalls === 1) throw new Error('报告生成失败')
    return { id: `report-${window.maintenanceHarness.previewCalls}`, text: `脱敏反馈报告\naccount=[REDACTED]\n固定快照 ${window.maintenanceHarness.previewCalls}`, entries: 2 }
  },
  async copyFeedbackReport(id) {
    window.maintenanceHarness.copyIds.push(id)
    if (scenario === 'copy-fails-once' && window.maintenanceHarness.copyIds.length === 1) throw new Error('剪贴板不可用')
    if (scenario === 'slow-copy') await new Promise<void>((resolve, reject) => { window.maintenanceHarness.releaseCopy = (success) => success ? resolve() : reject(new Error('剪贴板不可用')) })
    return { entries: 2 }
  },
  async exportFeedbackReport(id) { window.maintenanceHarness.exportIds.push(id); return scenario === 'export-cancel' ? null : { outputPath: 'C:\\exports\\report.txt' } },
  async openRuntimeLogDirectory() { return scenario !== 'directory-fails' },
  async clearRuntimeLogs() { window.maintenanceHarness.clearCalls += 1; cleared = true },
}

function Fixture() {
  const [destination, setDestination] = useState<string | null>(null)
  const [healthReport, setHealthReport] = useState<HealthReport | null>(search.get('report') === 'true' ? report : null)
  const [notice, setNotice] = useState('')
  const initialPhase = (search.get('phase') ?? 'error') as UpdateSnapshot['phase']
  const [update, setUpdate] = useState<UpdateSnapshot>({ phase: initialPhase, currentVersion: '0.1.31', availableVersion: initialPhase === 'disabled' ? null : '0.1.32', releaseName: '稳定性更新', releaseNotesText: '修复配置恢复与界面状态。', checkedAt: '2026-09-07T00:00:00.000Z', development: initialPhase === 'disabled', progress: initialPhase === 'downloading' ? { percent: 64, transferred: 640, total: 1000, bytesPerSecond: 128 } : null, error: initialPhase === 'error' ? { code: 'NETWORK', message: '下载请求失败' } : null })
  if (destination) return <div><h1>目标页面：{destination}</h1><button type="button" onClick={() => setDestination(null)}>{view === 'tutorial' ? '返回教程' : '返回检查'}</button></div>
  return <>
    {view === 'health' && <HealthPage initialReport={healthReport} api={{
      run: async () => {
        window.maintenanceHarness.runCalls += 1
        if (scenario === 'health-fails-once' && window.maintenanceHarness.runCalls === 1) throw new Error('检查执行失败')
        if (scenario === 'slow-health') await new Promise<void>((resolve, reject) => { window.maintenanceHarness.releaseHealth = (success) => success ? resolve() : reject(new Error('检查执行失败')) })
        if (scenario !== 'standalone-health') setHealthReport(report)
        return report
      },
      exportLatest: async () => { window.maintenanceHarness.exportHealthCalls += 1 },
    }} onResolve={(item) => { window.maintenanceHarness.resolved.push(item.code); setDestination(item.code) }} />}
    {view === 'feedback' && <FeedbackPage api={feedbackApi} notify={(message) => setNotice(message.message)} />}
    {view === 'update' && <UpdatePage state={update} busy={false}
      onCheck={async () => { window.maintenanceHarness.updates.push('check'); setUpdate((current) => ({ ...current, phase: 'available', error: null })) }}
      onDownload={async () => { window.maintenanceHarness.updates.push('download'); setUpdate((current) => ({ ...current, phase: 'downloading', error: null })) }}
      onRetryDownload={async () => { window.maintenanceHarness.updates.push('retry-download'); setUpdate((current) => ({ ...current, phase: 'downloading', error: null })) }}
      onInstall={async () => { window.maintenanceHarness.updates.push('install'); if (scenario === 'install-fails') throw new Error('安装未完成') }} />}
    {view === 'tutorial' && <TutorialPage onNavigate={(page) => setDestination(page)} onOpenAccountCenter={() => setDestination('account')} onOpenSupport={() => { window.maintenanceHarness.supportCalls += 1 }} />}
    <output hidden data-testid="notice">{notice}</output>
  </>
}
createRoot(document.getElementById('root')!).render(<NavigationStateProvider scope="maintenance-fixture"><Fixture /></NavigationStateProvider>)

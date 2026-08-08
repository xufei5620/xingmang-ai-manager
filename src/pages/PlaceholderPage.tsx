import { Inbox, RefreshCw, Sparkles } from 'lucide-react'
import { navigationItem, type PageId } from '../navigation'

const pageEyebrows: Record<Exclude<PageId, 'overview'>, string> = {
  sessions: 'SESSIONS',
  canvas: 'CANVAS',
  mcp: 'MODEL CONTEXT PROTOCOL',
  skills: 'SKILLS',
  plugins: 'EXTENSIONS',
  backups: 'CONFIGURATION',
  health: 'DIAGNOSTICS',
  maintenance: 'MAINTENANCE',
  feedback: 'FEEDBACK & DIAGNOSTICS',
  updates: 'UPDATES',
  settings: 'PREFERENCES',
}

export function PlaceholderPage({ pageId }: { pageId: Exclude<PageId, 'overview'> }) {
  const item = navigationItem(pageId)
  const Icon = item.icon
  // Placeholder destinations (currently just "canvas") have no feature behind
  // them yet, so they get an honest "coming soon" message instead of the
  // generic empty state used by real-but-unpopulated pages like Sessions.
  const comingSoon = item.placeholder === true

  return (
    <div className="page workspace-page" data-page-id={pageId}>
      <header className="page-header workspace-page-header">
        <div>
          <div className="eyebrow">{pageEyebrows[pageId]}</div>
          <h1>{item.label}</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label={`${item.label}工具栏`}>
          <button className="icon-button" type="button" title="刷新" aria-label="刷新" disabled>
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="workspace-empty" aria-labelledby={`${pageId}-empty-title`}>
        <div className="workspace-empty-icon"><Icon size={24} /></div>
        {comingSoon ? (
          <>
            <h2 id={`${pageId}-empty-title`}>即将上线</h2>
            <p><Sparkles size={15} /> {item.hint ?? '这项功能正在开发中'}</p>
          </>
        ) : (
          <>
            <h2 id={`${pageId}-empty-title`}>暂无可显示内容</h2>
            <p><Inbox size={15} /> 等待本机数据</p>
          </>
        )}
      </section>
    </div>
  )
}

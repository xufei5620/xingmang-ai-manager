import { Inbox, RefreshCw, Sparkles } from 'lucide-react'
import { navigationItem, type PageId } from '../navigation'

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
          <h1>{item.label}</h1>
          {item.hint ? <p className="page-lead">{item.hint}。</p> : null}
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
            <h2 id={`${pageId}-empty-title`}>这里还没有内容</h2>
            <p><Inbox size={15} /> 等本机数据出来就会显示</p>
          </>
        )}
      </section>
    </div>
  )
}

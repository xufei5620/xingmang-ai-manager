import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, Bell, Check, CircleHelp, Command, ExternalLink, Megaphone, RefreshCw, Search, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { DialogBackdrop } from '../Dialog'
import { navigationItems, type PageId } from '../../navigation'
import type { UpdateSnapshot } from '../../types'
import { useAnnouncements, type Announcement } from './useAnnouncements'
import './app-chrome.css'

export interface ShellNotice {
  id: string
  title: string
  detail: string
  target: PageId
  tone: 'info' | 'warning' | 'error'
}

export function updateNotice(state: UpdateSnapshot | null): ShellNotice | null {
  if (!state) return null
  if (state.error) return {
    id: `update:${state.error.code}`,
    title: '主程序更新需要处理',
    detail: state.error.message,
    target: 'updates',
    tone: 'error',
  }
  if (!['available', 'downloading', 'downloaded'].includes(state.phase)) return null
  return {
    id: `update:${state.availableVersion ?? state.currentVersion}:${state.phase}`,
    title: state.phase === 'downloaded' ? '更新已下载' : state.phase === 'downloading' ? '正在下载更新' : '发现新版本',
    detail: state.availableVersion ? `星芒 AI ${state.availableVersion}` : '查看主程序更新状态',
    target: 'updates',
    tone: 'info',
  }
}

export function ShellTopbar({ notices, platform, onNavigate, onHelp, loadAnnouncement, noticeScope = 'default', onOpenExternal }: {
  notices: readonly ShellNotice[]
  platform: string
  onNavigate: (page: PageId) => void
  onHelp: () => void
  loadAnnouncement?: () => Promise<Announcement | null>
  noticeScope?: string
  onOpenExternal?: (url: string) => void
}) {
  const [panel, setPanel] = useState<'commands' | 'notices' | 'announcement' | null>(null)
  const announcements = useAnnouncements(loadAnnouncement, noticeScope)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState(0)
  const titleId = useId()
  const queryRef = useRef<HTMLInputElement>(null)
  const callbackRef = useRef(onNavigate)
  callbackRef.current = onNavigate
  const shortcut = platform === 'macos' ? 'Cmd' : 'Ctrl'
  const items = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return navigationItems.filter((item) => `${item.label} ${item.hint ?? ''} ${item.id}`.toLocaleLowerCase().includes(needle))
  }, [query])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPanel('commands')
        setQuery('')
        setSelection(0)
      } else if (event.key === ',') {
        event.preventDefault()
        callbackRef.current('settings')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const navigate = (target: PageId) => {
    setPanel(null)
    onNavigate(target)
  }

  return <>
    <header className="shell-topbar" data-testid="shell-topbar">
      <button type="button" className="shell-command-trigger" onClick={() => {
        setQuery('')
        setSelection(0)
        setPanel('commands')
      }} aria-label="搜索页面与操作" aria-haspopup="dialog">
        <Search size={16} aria-hidden="true" /><span>搜索页面与操作</span><kbd>{shortcut}+K</kbd>
      </button>
      <div className="shell-topbar-actions">
        <button type="button" className="shell-action" onClick={() => { setPanel('announcement'); void announcements.refresh() }} aria-haspopup="dialog" disabled={!loadAnnouncement} title={loadAnnouncement ? '公告' : '登录后查看公告'}>
          <Megaphone size={17} aria-hidden="true" /><span>公告</span>{announcements.unread && <span className="shell-unread" aria-label="有未读公告" />}
        </button>
        <button type="button" className="shell-action" onClick={() => setPanel('notices')} aria-haspopup="dialog">
          <Bell size={17} aria-hidden="true" /><span>通知</span>
          {notices.length > 0 && <span className="shell-count">{notices.length}</span>}
        </button>
        <button type="button" className="shell-action" onClick={onHelp}>
          <CircleHelp size={17} aria-hidden="true" /><span>帮助与客服</span>
        </button>
      </div>
    </header>
    {panel && <DialogBackdrop className="shell-overlay" onDismiss={() => setPanel(null)}>
      <section className={`shell-panel shell-panel-${panel}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="shell-panel-head">
          {panel === 'commands' ? <Command size={20} /> : <Bell size={20} />}
          <h2 id={titleId}>{panel === 'commands' ? '搜索页面与操作' : panel === 'announcement' ? '公告' : '通知'}</h2>
          <button className="shell-icon-button" type="button" title="关闭" aria-label="关闭" onClick={() => setPanel(null)}><X size={18} /></button>
        </header>
        {panel === 'commands' ? <>
          <label className="shell-command-search"><Search size={18} aria-hidden="true" />
            <input ref={queryRef} data-initial-focus value={query} placeholder="搜索" aria-label="搜索页面" onChange={(event) => {
              setQuery(event.target.value)
              setSelection(0)
            }} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setSelection((current) => items.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length : 0)
              } else if (event.key === 'Enter' && items[selection]) {
                event.preventDefault()
                navigate(items[selection].id)
              }
            }} aria-controls="shell-command-results" aria-activedescendant={items[selection] ? `shell-command-${items[selection].id}` : undefined} role="combobox" aria-expanded="true" aria-autocomplete="list" />
          </label>
          <div className="shell-command-results" id="shell-command-results" role="listbox" aria-label="页面与操作">
            {items.map((item, index) => <button key={item.id} id={`shell-command-${item.id}`} type="button" role="option" aria-selected={selection === index} onClick={() => navigate(item.id)} onMouseMove={() => setSelection(index)}>
              <item.icon size={18} aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.hint}</small></span>
              {item.id === 'canvas' ? <ExternalLink size={14} aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />}
            </button>)}
            {items.length === 0 && <p className="shell-empty" role="status">没有匹配的页面</p>}
          </div>
        </> : panel === 'announcement' ? <>
          <div className="shell-announcement" aria-busy={announcements.loading}>
            {announcements.error && <p className="shell-announcement-error" role="alert">{announcements.error}</p>}
            {announcements.loading && <p role="status">正在读取公告</p>}
            {announcements.notice && <ReactMarkdown components={{
              img: ({ alt }) => <span>{alt || '公告图片'}</span>,
              a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) onOpenExternal?.(href) }}>{children}</a>,
            }}>{announcements.notice.text}</ReactMarkdown>}
            {!announcements.notice && !announcements.loading && !announcements.error && <p>暂无公告</p>}
          </div>
          <footer className="shell-announcement-actions">
            <button type="button" className="secondary-button" onClick={() => void announcements.refresh()} disabled={announcements.loading}><RefreshCw size={15} aria-hidden="true" />重新读取</button>
            {announcements.notice && <button type="button" className="primary-button" onClick={announcements.markRead} disabled={!announcements.unread}><Check size={15} aria-hidden="true" />标为已读</button>}
          </footer>
        </> : <div className="shell-notices">
          {notices.length === 0 ? <p className="shell-empty">暂无待处理通知</p> : notices.map((notice) => <button key={notice.id} type="button" className={`shell-notice tone-${notice.tone}`} onClick={() => navigate(notice.target)}>
            <span><strong>{notice.title}</strong><small>{notice.detail}</small></span><ArrowRight size={16} aria-hidden="true" />
          </button>)}
        </div>}
      </section>
    </DialogBackdrop>}
  </>
}

export function ShellStatusbar({ environment, account, balance, version, update, onNavigate, onAccount }: {
  environment: string
  account: string
  balance: string | null
  version: string
  update: UpdateSnapshot | null
  onNavigate: (page: PageId) => void
  onAccount: () => void
}) {
  return <footer className="shell-statusbar" data-testid="shell-statusbar">
    <button type="button" onClick={() => onNavigate('health')} title={environment}><span className="shell-status-dot" aria-hidden="true" />{environment}</button>
    <button type="button" className="shell-status-account" onClick={onAccount} title={account}>{account}</button>
    <span className="shell-status-spacer" />
    {balance && <button type="button" onClick={onAccount} title="账户余额">余额 {balance}</button>}
    <button type="button" onClick={() => onNavigate('updates')} title="主程序更新">v{version}{update?.phase === 'available' ? ' · 发现新版本' : update?.phase === 'downloading' ? ' · 下载中' : update?.phase === 'downloaded' ? ' · 已下载' : ''}</button>
  </footer>
}

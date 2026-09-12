import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, Bell, ChevronDown, CircleHelp, Globe, Menu as MenuIcon, PanelLeft, RefreshCw, Search, UserRound, Zap } from 'lucide-react'
import { Button, Coachmark, Dialog, Input, Logo, Tooltip } from '../../ui'
import { moreNavigation, shellNavigation, shellTour } from '../../registry/shell'
import { pageRegistry, type PageId } from '../../registry/pages'
import '../../styles/shell.css'
import { Starfield } from '../auth/Starfield'
import { LocalAvatar } from '../../LocalAvatar'
import type { AvatarIdentity } from '../../local-avatar'
import { readLocalPreference, writeLocalPreference } from '../app/preferences'
import type { SystemSnapshot } from '../../../../electron/ipc-contract'
import { networkLocationLabel } from './network'
import { balanceStatusText, type BalanceStatusView } from './balance-status'

interface AccountView extends BalanceStatusView { signedIn: boolean; supportsBilling?: boolean; supportsAnnouncements?: boolean; displayName?: string; email?: string; balance?: string; identity?: AvatarIdentity }
interface Adapter {
  navigate?(page: PageId): void
  openAccount?(): void
  switchAccount?(): void
  topUp?(): void
  refreshBalance?(): void
  logout?(): void
  openHelp?(): void
  openAnnouncements?(): void
  openNotifications?(): void
  openHealth?(): void
  openUpdates?(): void
  setSidebarCollapsed?(collapsed: boolean): void
}
interface ShellProps {
  activePage: PageId
  account: AccountView
  platform: 'win' | 'mac' | 'linux'
  adapter: Adapter
  environment?: string
  balance?: string
  version?: string
  /** Network location from the read-only system scan. */
  network?: SystemSnapshot['network']
  /** Kept for fixture compatibility; the status bar no longer presents it as a download source. */
  sourceLabel?: string
  installedCount?: number
  unread?: boolean
  banner?: ReactNode
  notification?: ReactNode
  tourOpen?: boolean
  onTourClose?(): void
  children: ReactNode
}

export function Shell({ activePage, account, platform, adapter, environment, balance, version, network, installedCount, unread, banner, notification, tourOpen, onTourClose, children }: ShellProps) {
  const [tourStep, setTourStep] = useState(0)
  useEffect(() => { if (tourOpen) setTourStep(0) }, [tourOpen])
  const [collapsed, setCollapsed] = useState(() => readLocalPreference('xingmang-v2-sidebar') === 'collapsed')
  const [more, setMore] = useState(false)
  const [command, setCommand] = useState(false)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const viewport = useRef<HTMLElement>(null)
  const scroll = useRef(new Map<PageId, number>())
  const navigateRef = useRef(adapter.navigate)
  navigateRef.current = adapter.navigate
  const results = pageRegistry.filter((page) => `${page.label} ${page.id}`.toLowerCase().includes(query.toLowerCase().trim()))
  const balanceStatus = balanceStatusText(account)
  const balanceTitle = `${account.balance ?? '暂未读到'}；${balanceStatus}`
  const balanceRefresh = account.signedIn && adapter.refreshBalance
    ? <Button size="xs" variant="ghost" icon={RefreshCw} aria-label="刷新余额" title={`刷新余额；${balanceStatus}`} loading={account.balanceLoading} onClick={adapter.refreshBalance} testId="sidebar-balance-refresh" />
    : null
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.isComposing || event.altKey || document.querySelector('dialog[open]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setCommand(true); setQuery(''); setSelection(0)
      }
      if (event.key === '/' && event.target instanceof Element && !event.target.closest('input, textarea, [contenteditable="true"]')) {
        const field = viewport.current?.querySelector<HTMLInputElement>('input[type="search"], input[aria-label*="搜索"]')
        if (field) { event.preventDefault(); field.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [])
  useEffect(() => {
    if (moreNavigation.includes(activePage)) setMore(true)
  }, [activePage])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const previous = scroll.current.get(activePage) ?? 0
    let restoring = true
    const observer = new ResizeObserver(() => restore())
    const finish = () => { restoring = false; observer.disconnect() }
    function restore() {
      if (!restoring) return
      element!.scrollTop = previous
      if (Math.abs(element!.scrollTop - previous) < 1) finish()
    }
    const remember = () => { if (!restoring) scroll.current.set(activePage, element.scrollTop) }
    const userScroll = () => { finish(); remember() }
    for (const child of element.children) observer.observe(child)
    restore()
    element.addEventListener('scroll', remember, { passive: true })
    element.addEventListener('wheel', userScroll, { passive: true })
    element.addEventListener('pointerdown', userScroll)
    return () => {
      // A programmatic scroll can be followed by navigation before Chromium
      // dispatches its scroll event. Read the live position during teardown so
      // fast page switches do not lose the user's last viewport location.
      scroll.current.set(activePage, element.scrollTop)
      observer.disconnect()
      element.removeEventListener('scroll', remember)
      element.removeEventListener('wheel', userScroll)
      element.removeEventListener('pointerdown', userScroll)
    }
  }, [activePage])
  function toggleSidebar() {
    setCollapsed((current) => {
      writeLocalPreference('xingmang-v2-sidebar', current ? 'expanded' : 'collapsed')
      adapter.setSidebarCollapsed?.(!current)
      return !current
    })
  }
  function navButton(id: PageId) {
    const definition = pageRegistry.find((page) => page.id === id)!
    const Icon = definition.icon
    const button = <button type="button" className={`v2-nav-item${activePage === id ? ' is-active' : ''}`} key={id}
      aria-label={definition.label} aria-current={activePage === id ? 'page' : undefined} data-testid={`nav-${id}`} data-navigation-id={id} onClick={() => adapter.navigate?.(id)}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" /><span>{definition.label}</span>{definition.external && <ArrowUpRight size={14} aria-hidden="true" />}
    </button>
    return collapsed ? <Tooltip key={id} text={definition.label}>{button}</Tooltip> : button
  }
  return <div className="v2-root" data-os={platform} data-testid="app-frame">
    <header className="v2-titlebar" data-testid="window-titlebar"><Logo kind="micro" height={20} /><span>星芒AI管理工具</span></header>
    <div className={`v2-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="v2-sidebar" data-testid="sidebar">
        <div className="v2-brand"><Logo kind="micro" height={32} />{!collapsed && <Logo kind="wordmark" height={32} />}
          <Button variant="ghost" size="xs" icon={PanelLeft} aria-label={collapsed ? '展开侧栏' : '收起侧栏'} title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={toggleSidebar} testId="sidebar-collapse" /></div>
        <nav className="v2-sidebar-nav" aria-label="主导航">{shellNavigation.map((group, index) => <div className="v2-nav-group" key={index}>{group.map(navButton)}</div>)}
          <button type="button" className="v2-nav-item" onClick={() => setMore((current) => !current)} aria-expanded={more} aria-label="更多" title={collapsed ? '更多' : undefined} data-testid="nav-more"><MenuIcon size={20} /><span>更多</span><ChevronDown size={16} /></button>
          {more && <div className="v2-more-navigation">{moreNavigation.map(navButton)}</div>}{navButton('settings')}
        </nav>
        <section className="v2-account-entry" data-testid="account-entry">
          <div className="v2-account-top"><button type="button" aria-label={account.signedIn ? `打开个人中心 ${account.displayName}` : '登录'} title={account.displayName ?? '登录'} onClick={adapter.openAccount}>
            <LocalAvatar identity={account.identity ?? null} name={account.displayName ?? '未登录'} />{!collapsed && <span className="v2-account-who"><strong>{account.displayName ?? '未登录'}</strong><small>{account.email ?? (account.signedIn ? '星芒账号' : '登录后自动配 Key')}</small></span>}
          </button><Button variant="ghost" size="xs" icon={ChevronDown} aria-label="切换账号" title="切换账号" onClick={adapter.switchAccount} /></div>
          <div className="v2-account-balance">
            {!collapsed ? <div className="v2-account-balance-summary" title={balanceTitle}>
              <div className="v2-account-balance-label"><small>余额</small>{balanceRefresh}</div>
              <strong>{account.balance ?? '暂未读到'}</strong>
            </div> : balanceRefresh}
            {account.supportsBilling !== false && <Button size="sm" variant="balance" icon={Zap} aria-label="充值" title="充值" onClick={adapter.topUp}>{collapsed ? undefined : '充值'}</Button>}
            {!collapsed && account.signedIn && account.balanceError && !account.balanceLoading && <small className="v2-balance-error" role="status" title={balanceStatus}>更新失败</small>}
          </div>
        </section>
      </aside>
      <div className="v2-workspace">
        <Starfield quiet paused={false} />
        <header className="v2-topbar" data-testid="shell-topbar"><button type="button" className="v2-command-trigger" onClick={() => { setCommand(true); setQuery(''); setSelection(0) }}><Search size={16} /><span>搜索、打开、跳转…</span><kbd>{platform === 'mac' ? '⌘K' : 'Ctrl K'}</kbd></button>
          <div className="v2-topbar-actions">{account.supportsAnnouncements !== false && <Button size="sm" icon={Bell} onClick={adapter.openAnnouncements} testId="announcement-open">公告{unread && <span className="v2-unread" />}</Button>}<Button size="sm" icon={CircleHelp} onClick={adapter.openHelp}>帮助与客服</Button></div>
        </header>
        {banner}
        <main ref={viewport} className={`v2-content${activePage === 'chat' ? ' v2-content-chat' : ''}`} data-testid="page-viewport">{children}</main>
        <footer className="v2-statusbar" data-testid="shell-statusbar"><button type="button" onClick={adapter.openHealth}><i className="v2-dot" />{environment ?? '环境待检测'}</button>
          <span className="v2-network-location network-location" data-testid="shell-network-location" title={network?.error ?? networkLocationLabel(network)}><Globe size={14} aria-hidden="true" />{networkLocationLabel(network)}</span><button type="button" onClick={adapter.openAccount}><i className="v2-dot" />{account.signedIn ? `已登录 ${account.displayName}` : '未登录'}</button>
          {(balance || account.balance) && <button type="button" onClick={adapter.topUp} title={balanceStatus} data-testid="statusbar-balance">余额 {balance ?? account.balance}{account.balanceLoading && <RefreshCw size={12} className="xm-spin" aria-label="正在刷新余额" />}{account.balanceError && !account.balanceLoading && <span className="v2-balance-error">更新失败</span>}</button>}{installedCount !== undefined && <span>{installedCount} 个工具已装</span>}
          <button type="button" className="v2-status-version" onClick={adapter.openUpdates}>{version ? `v${version}` : '版本读取中'}</button>
        </footer>
        {notification && <div className="v2-notification">{notification}</div>}
      </div>
    </div>
    {command && <Dialog open title="搜索、打开、跳转" onClose={() => setCommand(false)} width={640} initialFocus={searchRef} testId="command-palette">
      <Input ref={searchRef} type="search" aria-label="搜索页面" value={query} onChange={(event) => { setQuery(event.target.value); setSelection(0) }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setSelection((current) => results.length ? (current + 1) % results.length : 0) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setSelection((current) => results.length ? (current + results.length - 1) % results.length : 0) }
        else if (event.key === 'Enter' && results[selection]) { event.preventDefault(); adapter.navigate?.(results[selection].id); setCommand(false) }
      }} />
      <div className="v2-command-results" role="listbox" aria-label="页面与操作">{results.map((item, index) => <button role="option" aria-selected={index === selection} type="button" key={item.id} onClick={() => { adapter.navigate?.(item.id); setCommand(false) }}><item.icon size={18} /><span>{item.label}</span><ArrowRight size={14} /></button>)}</div>
      {!results.length && <p role="status">没有匹配的页面</p>}
    </Dialog>}
    <Coachmark open={Boolean(tourOpen && !command)} {...shellTour[tourStep]} step={tourStep + 1} count={shellTour.length} onNext={() => tourStep + 1 === shellTour.length ? onTourClose?.() : setTourStep((value) => value + 1)} onClose={() => onTourClose?.()} testId="shell-guide-tip" />
  </div>
}

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, Bell, ChevronDown, CircleHelp, Globe, Menu as MenuIcon, PanelLeft, RefreshCw, Search, UserRound, Zap } from 'lucide-react'
import { Button, Coachmark, Dialog, Input, Logo, Tooltip } from '../../ui'
import { moreNavigation, shellNavigation, shellTour } from '../../registry/shell'
import { pageRegistry, type PageId } from '../../registry/pages'
import '../../styles/shell.css'
import { errorMessage } from '../../business-common'
import { Starfield } from '../auth/Starfield'
import { LocalAvatar } from '../../LocalAvatar'
import type { AvatarIdentity } from '../../local-avatar'
import { readLocalPreference, writeLocalPreference } from '../app/preferences'
import type { SystemSnapshot } from '../../../../electron/ipc-contract'
import { networkLocationLabel } from './network'
import { balanceFailureLabel, balanceStatusText, type BalanceStatusView } from './balance-status'
import { OfflineBanner } from './OfflineBanner'
import { offlineActionMessage } from './online-status'
import { useOnlineStatus } from './useOnlineStatus'
import { commandGroupLabels, searchCommands, type CommandResult } from './command-search'
import { accelerationBonusSeconds, isAccelerationBonusCode, type AccelerationRedemptionResult } from '../../../../electron/acceleration-contract'

interface AccountView extends BalanceStatusView { signedIn: boolean; supportsBilling?: boolean; supportsAnnouncements?: boolean; displayName?: string; email?: string; sourceLabel?: string; balance?: string; /** 「订阅：剩余 $X · M 月 D 日到期」；没有能用的订阅时缺省。 */ subscription?: string; identity?: AvatarIdentity }
interface Adapter {
  /** section 是那一页里要落的分页、分组或教程主题；缺省 = 只跳页。 */
  navigate?(page: PageId, section?: string): void
  /** 顶部搜索什么都没搜到时，把输入的字带去教程页接着搜。 */
  searchTutorial?(query: string): void
  /** 当前账号能看到的个人中心分页；缺省 = 全部。 */
  accountTabVisible?(tab: string): boolean
  openAccount?(): void
  switchAccount?(): void
  topUp?(): void
  refreshBalance?(): void
  refreshNetwork?(): void
  logout?(): void
  openHelp?(): void
  openAnnouncements?(): void
  openNotifications?(): void
  openHealth?(): void
  openUpdates?(): void
  setSidebarCollapsed?(collapsed: boolean): void
  redeemAccelerationCode?(code: string): Promise<AccelerationRedemptionResult | null>
}
interface ShellProps {
  activePage: PageId
  account: AccountView
  platform: 'win' | 'mac' | 'linux'
  adapter: Adapter
  environment?: string
  balance?: string
  version?: string
  /** Observed network location, refreshed after a connection change. */
  network?: SystemSnapshot['network']
  networkRefreshing?: boolean
  /** Kept for fixture compatibility; the status bar no longer presents it as a download source. */
  sourceLabel?: string
  installedCount?: number
  /** 已安装工具里有多少个可以更新；0 或缺省时首页入口不挂角标。 */
  updatableCount?: number
  unread?: boolean
  banner?: ReactNode
  notification?: ReactNode
  tourOpen?: boolean
  onTourClose?(): void
  children: ReactNode
}

export function Shell({ activePage, account, platform, adapter, environment, balance, version, network, networkRefreshing = false, installedCount, updatableCount = 0, unread, banner, notification, tourOpen, onTourClose, children }: ShellProps) {
  const { offline } = useOnlineStatus()
  const [tourStep, setTourStep] = useState(0)
  useEffect(() => { if (tourOpen) setTourStep(0) }, [tourOpen])
  const [collapsed, setCollapsed] = useState(() => readLocalPreference('xingmang-v2-sidebar') === 'collapsed')
  const [more, setMore] = useState(false)
  const moreListRef = useRef<HTMLDivElement>(null)
  // 矮屏（1280×720、1080p 开 150% 缩放）上展开「更多」时，新出来的四项落在侧栏
  // 可视区下面，看起来像点了没反应，所以展开后把它们滚进来。
  useEffect(() => {
    if (more) moreListRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [more])
  const [command, setCommand] = useState(false)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState(0)
  const [bonusBusy, setBonusBusy] = useState(false)
  const [bonusFeedback, setBonusFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const commandEpoch = useRef(0)
  const bonusFlight = useRef<object | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLElement>(null)
  const scroll = useRef(new Map<PageId, number>())
  const navigateRef = useRef(adapter.navigate)
  navigateRef.current = adapter.navigate
  const shownPage = useRef<PageId | null>(null)
  const [pageAnnouncement, setPageAnnouncement] = useState('')
  const results = searchCommands(query, { accountTabVisible: adapter.accountTabVisible })
  const bonusAction = Boolean(adapter.redeemAccelerationCode && isAccelerationBonusCode(query))
  const resultCount = bonusAction ? 1 : results.length
  useEffect(() => () => { commandEpoch.current++; bonusFlight.current = null }, [])
  // 结果比列表高时，用方向键选到下面的项也要滚进来。
  useEffect(() => {
    resultsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [selection])
  function openCommand() {
    commandEpoch.current++
    setCommand(true); setQuery(''); setSelection(0); setBonusFeedback(null)
  }
  function closeCommand() { commandEpoch.current++; setCommand(false) }
  function openResult(item: CommandResult) {
    adapter.navigate?.(item.page, item.section); closeCommand()
  }
  function searchTutorial() {
    adapter.searchTutorial?.(query.trim().slice(0, 200)); closeCommand()
  }
  async function redeemBonus() {
    if (bonusFlight.current || !isAccelerationBonusCode(query) || !adapter.redeemAccelerationCode) return
    if (offline) { setBonusFeedback({ error: true, text: offlineActionMessage }); return }
    const flight = {}
    const epoch = commandEpoch.current
    bonusFlight.current = flight
    setBonusBusy(true); setBonusFeedback(null)
    try {
      const result = await adapter.redeemAccelerationCode(query.trim().toUpperCase())
      if (commandEpoch.current !== epoch || !result) return
      setBonusFeedback(result.status === 'redeemed'
        ? { error: false, text: `领取成功，已增加 ${result.addedSeconds / 60} 分钟加速时长。` }
        : result.status === 'already-redeemed'
          ? { error: false, text: '当前账号已在本机领取过该口令。' }
          : { error: true, text: '口令无效，请核对后重试。' })
    } catch (cause) {
      if (commandEpoch.current === epoch) setBonusFeedback({ error: true, text: errorMessage(cause, '领取失败，请稍后重试。') })
    } finally {
      if (bonusFlight.current === flight) { bonusFlight.current = null; setBonusBusy(false) }
    }
  }
  const balanceStatus = balanceStatusText({ ...account, offline })
  const balanceTitle = `${account.balance ?? '暂未读到'}；${account.subscription ? `${account.subscription}；` : ''}${balanceStatus}`
  const balanceRefresh = account.signedIn && adapter.refreshBalance
    ? <Button size="xs" variant="ghost" icon={RefreshCw} aria-label="刷新余额" title={`刷新余额；${balanceStatus}`} loading={account.balanceLoading} onClick={adapter.refreshBalance} testId="sidebar-balance-refresh" />
    : null
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.isComposing || event.altKey || document.querySelector('dialog[open]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); openCommand()
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
  // 切页之后焦点原来还停在侧栏按钮上：键盘用户要 Tab 穿过整条侧栏才到正文，读屏用户
  // 根本不知道页面换了。换页时把焦点交给正文区，并在播报区念一句页面名。首次渲染不动，
  // 开着弹窗不抢；新页面自己已经把焦点放进正文（比如聊天的输入框）也不抢。
  useEffect(() => {
    if (shownPage.current === null || shownPage.current === activePage) {
      shownPage.current = activePage
      return
    }
    shownPage.current = activePage
    setPageAnnouncement(`已切换到${pageRegistry.find((page) => page.id === activePage)?.label ?? '新页面'}`)
    const frame = requestAnimationFrame(() => {
      const main = viewport.current
      if (!main || document.querySelector('dialog[open]')) return
      const current = document.activeElement
      if (current && current !== main && main.contains(current) && !current.closest('[hidden], [inert]')) return
      main.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [activePage])
  function skipToContent(event: MouseEvent<HTMLAnchorElement>) {
    // 不改地址栏的 hash：只把焦点交给正文区，和切页时的落点一致。
    event.preventDefault()
    viewport.current?.focus({ preventScroll: true })
  }
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
    // 首页那张「你的工具」卡片上写着同一个数字，这里只是把它提到侧栏，
    // 让没打开首页的人也知道有几个工具能更新了。
    const badge = id === 'home' && updatableCount > 0 ? updatableCount : 0
    const label = badge ? `${definition.label}，${badge} 个工具可更新` : definition.label
    const button = <button type="button" className={`v2-nav-item${activePage === id ? ' is-active' : ''}`} key={id}
      aria-label={label} aria-current={activePage === id ? 'page' : undefined} data-testid={`nav-${id}`} data-navigation-id={id} onClick={() => adapter.navigate?.(id)}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" /><span>{definition.label}</span>{definition.external && <ArrowUpRight size={14} aria-hidden="true" />}
      {badge > 0 && <small className="v2-nav-badge" data-testid="nav-home-updates">{badge}</small>}
    </button>
    return collapsed ? <Tooltip key={id} text={label}>{button}</Tooltip> : button
  }
  return <div className="v2-root" data-os={platform} data-testid="app-frame">
    <header className="v2-titlebar" data-testid="window-titlebar"><Logo kind="micro" height={20} /><span>星芒AI管理工具</span></header>
    <div className={`v2-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="v2-sidebar" data-testid="sidebar">
        <a className="v2-skip-link" href="#v2-main" onClick={skipToContent} data-testid="shell-skip-to-content">跳到正文</a>
        <div className="v2-brand"><Logo kind="micro" height={32} />{!collapsed && <Logo kind="wordmark" height={32} />}
          <Button variant="ghost" size="xs" icon={PanelLeft} aria-label={collapsed ? '展开侧栏' : '收起侧栏'} title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={toggleSidebar} testId="sidebar-collapse" /></div>
        <nav className="v2-sidebar-nav" aria-label="主导航">
          {/* 「设置」不跟着滚：屏幕矮时滚动区先收缩，「设置」始终露在外面。 */}
          <div className="v2-sidebar-scroll" data-testid="sidebar-scroll">{shellNavigation.map((group, index) => <div className="v2-nav-group" key={index}>{group.map(navButton)}</div>)}
            <button type="button" className="v2-nav-item" onClick={() => setMore((current) => !current)} aria-expanded={more} aria-label="更多" title={collapsed ? '更多' : undefined} data-testid="nav-more"><MenuIcon size={20} /><span>更多</span><ChevronDown size={16} /></button>
            {more && <div className="v2-more-navigation" ref={moreListRef}>{moreNavigation.map(navButton)}</div>}
          </div>
          {navButton('settings')}
        </nav>
        <section className="v2-account-entry" data-testid="account-entry">
          <div className="v2-account-top"><button type="button" aria-label={account.signedIn ? `打开个人中心 ${account.displayName}` : '登录'} title={account.displayName ?? '登录'} onClick={adapter.openAccount}>
            <LocalAvatar identity={account.identity ?? null} name={account.displayName ?? '未登录'} />{!collapsed && <span className="v2-account-who"><strong>{account.displayName ?? '未登录'}</strong><small>{account.email ?? (account.signedIn ? account.sourceLabel ?? '星芒账号' : '登录后自动配 Key')}</small></span>}
          </button><Button variant="ghost" size="xs" icon={ChevronDown} aria-label="切换账号" title="切换账号" onClick={adapter.switchAccount} /></div>
          <div className="v2-account-balance">
            {!collapsed ? <div className="v2-account-balance-summary" title={balanceTitle}>
              <div className="v2-account-balance-label"><small>余额</small>{balanceRefresh}</div>
              <strong>{account.balance ?? '暂未读到'}</strong>
              {account.subscription && <small className="v2-account-balance-subscription" data-testid="sidebar-subscription">{account.subscription}</small>}
            </div> : balanceRefresh}
            {account.supportsBilling !== false && <Button size="sm" variant="balance" icon={Zap} aria-label="充值" title="充值" onClick={adapter.topUp}>{collapsed ? undefined : '充值'}</Button>}
            {!collapsed && account.signedIn && account.balanceError && !account.balanceLoading && <small className="v2-balance-error" role="status" title={balanceStatus}>{balanceFailureLabel(offline)}</small>}
          </div>
        </section>
      </aside>
      <div className="v2-workspace">
        <Starfield quiet paused={false} />
        <header className="v2-topbar" data-testid="shell-topbar"><button type="button" className="v2-command-trigger" onClick={openCommand}><Search size={16} /><span>搜索、打开、跳转…</span><kbd>{platform === 'mac' ? '⌘K' : 'Ctrl K'}</kbd></button>
          <div className="v2-topbar-actions">{account.supportsAnnouncements !== false && <Button size="sm" icon={Bell} onClick={adapter.openAnnouncements} testId="announcement-open">公告{unread && <span className="v2-unread" />}</Button>}<Button size="sm" icon={CircleHelp} onClick={adapter.openHelp}>帮助与客服</Button></div>
        </header>
        <OfflineBanner />
        {banner}
        <main ref={viewport} id="v2-main" tabIndex={-1} className={`v2-content${activePage === 'chat' ? ' v2-content-chat' : ''}`} data-testid="page-viewport">{children}</main>
        <p className="v2-visually-hidden" role="status" aria-live="polite" data-testid="shell-page-announcement">{pageAnnouncement}</p>
        <footer className="v2-statusbar" data-testid="shell-statusbar"><button type="button" onClick={adapter.openHealth}><i className="v2-dot" />{environment ?? '环境待检测'}</button>
          <button type="button" className="v2-network-location network-location" data-testid="shell-network-location"
            aria-label="刷新网络位置" aria-busy={networkRefreshing} disabled={networkRefreshing || !adapter.refreshNetwork}
            title={networkRefreshing ? '正在检测当前网络出口' : `${network?.error ?? networkLocationLabel(network)}；点击刷新网络位置`}
            onClick={adapter.refreshNetwork}>
            <Globe size={14} aria-hidden="true" /><span aria-live="polite">{networkRefreshing ? '正在检测网络位置…' : networkLocationLabel(network)}</span>
          </button><button type="button" onClick={adapter.openAccount}><i className="v2-dot" />{account.signedIn ? `已登录 ${account.displayName}` : '未登录'}</button>
          {(balance || account.balance) && <button type="button" onClick={adapter.topUp} title={account.subscription ? `${account.subscription}；${balanceStatus}` : balanceStatus} data-testid="statusbar-balance">余额 {balance ?? account.balance}{account.balanceLoading && <RefreshCw size={12} className="xm-spin" aria-label="正在刷新余额" />}{account.balanceError && !account.balanceLoading && <span className="v2-balance-error">{balanceFailureLabel(offline)}</span>}</button>}{installedCount !== undefined && <span>{installedCount} 个工具已装</span>}
          <button type="button" className="v2-status-version" onClick={adapter.openUpdates}>{version ? `v${version}` : '版本读取中'}</button>
        </footer>
        {notification && <div className="v2-notification">{notification}</div>}
      </div>
    </div>
    {command && <Dialog open title="搜索、打开、跳转" onClose={closeCommand} width={640} initialFocus={searchRef} testId="command-palette">
      <Input ref={searchRef} type="search" aria-label="搜索页面、设置和教程" value={query} onChange={(event) => { commandEpoch.current++; setQuery(event.target.value); setSelection(0); setBonusFeedback(null) }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setSelection((current) => resultCount ? (current + 1) % resultCount : 0) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setSelection((current) => resultCount ? (current + resultCount - 1) % resultCount : 0) }
        else if (event.key === 'Enter' && bonusAction) { event.preventDefault(); void redeemBonus() }
        else if (event.key === 'Enter' && results[selection]) { event.preventDefault(); openResult(results[selection]) }
      }} />
      <div ref={resultsRef} className="v2-command-results" role="listbox" aria-label="页面与操作">{bonusAction
        ? <button role="option" aria-selected={selection === 0} aria-busy={bonusBusy} disabled={bonusBusy} type="button" data-testid="command-acceleration-bonus" onClick={() => { void redeemBonus() }}>
          {bonusBusy ? <RefreshCw size={18} className="xm-spin" aria-hidden="true" /> : <Zap size={18} aria-hidden="true" />}<span>{bonusBusy ? '正在领取…' : `领取 ${accelerationBonusSeconds / 60} 分钟加速时长`}</span><ArrowRight size={14} aria-hidden="true" />
        </button>
        : results.map((item, index) => {
          const Icon = pageRegistry.find((page) => page.id === item.page)!.icon
          const heading = index === 0 || results[index - 1].group !== item.group
          // 分组标题只给看的人；读屏在每一项的名字里听到它属于哪一组。
          return <div className="v2-command-entry" key={item.key}>
            {heading && <p className="v2-command-group" aria-hidden="true" data-testid={`command-group-${item.group}`}>{commandGroupLabels[item.group]}</p>}
            <button role="option" aria-selected={index === selection} aria-label={item.group === 'page' ? item.label : `${commandGroupLabels[item.group]} · ${item.label}`} type="button" data-testid={`command-result-${item.key}`} onClick={() => openResult(item)}><Icon size={18} aria-hidden="true" /><span>{item.label}</span><ArrowRight size={14} aria-hidden="true" /></button>
          </div>
        })}</div>
      {bonusFeedback && <p role={bonusFeedback.error ? 'alert' : 'status'} data-testid="command-acceleration-feedback">{bonusFeedback.text}</p>}
      {!resultCount && <div className="v2-command-empty">
        <p role="status">没找到相关的页面或设置。</p>
        {adapter.searchTutorial && query.trim() && <Button size="sm" icon={Search} onClick={searchTutorial} testId="command-search-tutorial">{`去教程里搜「${query.trim().slice(0, 40)}」`}</Button>}
      </div>}
    </Dialog>}
    <Coachmark open={Boolean(tourOpen && !command)} {...shellTour[tourStep]} step={tourStep + 1} count={shellTour.length} onNext={() => tourStep + 1 === shellTour.length ? onTourClose?.() : setTourStep((value) => value + 1)} onClose={() => onTourClose?.()} testId="shell-guide-tip" />
  </div>
}

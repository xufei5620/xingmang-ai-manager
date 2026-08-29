import {
  ArrowUp,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  LoaderCircle,
  Moon,
  RotateCw,
  Settings2,
  Sun,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import logoUrl from '../../assets/icon.png'
import logoWhiteUrl from '../../assets/icon-white.png'
import { navigationItems, type NavigationGroup, type PageId } from '../navigation'
import type { RelaySite, UpdateSnapshot } from '../types'
import { AccountArea } from './account/AccountArea'
import type { AccountAreaStatus, AccountSnapshot } from './account/account-stub'

interface SidebarProps {
  activePage: PageId
  collapsed: boolean
  theme: 'light' | 'dark'
  appVersion: string
  updateState: UpdateSnapshot | null
  relaySite: RelaySite
  /** Whether the low-frequency system-management group is expanded for this session. */
  moreExpanded: boolean
  accountStatus: AccountAreaStatus
  accountSnapshot: AccountSnapshot
  onNavigate: (pageId: PageId) => void
  onToggleCollapsed: () => void
  onToggleTheme: () => void
  onToggleMoreExpanded: () => void
  onAccountLogin: () => void
  onAccountLogout: () => void
  onRecharge: () => void
  onConfigureCliKey: () => void
  /** 刷新余额 -- passed straight through to AccountArea. */
  onRefreshBalance: () => void
  onOpenAccountCenter: () => void
  /** Opens the 粘贴 Key dialog (W3b) -- passed straight through to AccountArea. */
  onPasteKey: () => void
  /** openExternal(relaySite.keysPageUrl) -- passed straight through to AccountArea. */
  onOpenKeysPage: () => void
}

export function ThemeToggle({
  theme,
  onToggle,
  className = '',
}: Pick<SidebarProps, 'theme'> & { onToggle: () => void; className?: string }) {
  const nextThemeName = theme === 'light' ? '暗色' : '亮色'
  return (
    <button
      type="button"
      className={`sidebar-control-button theme-toggle ${className}`.trim()}
      title={`切换到${nextThemeName}主题`}
      aria-label={`切换到${nextThemeName}主题`}
      data-sidebar-tooltip={`${nextThemeName}模式`}
      onClick={onToggle}
    >
      {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
      <span>{nextThemeName}</span>
    </button>
  )
}

export function Sidebar({
  activePage,
  collapsed,
  theme,
  appVersion,
  updateState,
  relaySite,
  moreExpanded,
  accountStatus,
  accountSnapshot,
  onNavigate,
  onToggleCollapsed,
  onToggleTheme,
  onToggleMoreExpanded,
  onAccountLogin,
  onAccountLogout,
  onRecharge,
  onConfigureCliKey,
  onRefreshBalance,
  onOpenAccountCenter,
  onPasteKey,
  onOpenKeysPage,
}: SidebarProps) {
  const navigationRef = useRef<HTMLElement>(null)
  const moreToggleRef = useRef<HTMLButtonElement>(null)
  const morePopoverRef = useRef<HTMLDivElement>(null)
  const [morePopoverPosition, setMorePopoverPosition] = useState({ top: 0, left: 80 })

  useLayoutEffect(() => {
    const navigation = navigationRef.current
    if (!collapsed || !navigation) return

    const pinHorizontalOrigin = () => {
      if (navigation.scrollLeft !== 0) navigation.scrollLeft = 0
    }
    navigation.scrollTop = 0
    pinHorizontalOrigin()

    // The shell width animates while collapsing. Chromium may restore the
    // expanded rail's horizontal offset on a later animation frame, after a
    // one-shot layout effect has already run. Keep the icon rail pinned for
    // the whole transition and for any later resize/scroll restoration.
    let remainingFrames = 18
    let animationFrame = 0
    const pinDuringTransition = () => {
      pinHorizontalOrigin()
      remainingFrames -= 1
      if (remainingFrames > 0) animationFrame = window.requestAnimationFrame(pinDuringTransition)
    }
    animationFrame = window.requestAnimationFrame(pinDuringTransition)
    const resizeObserver = new ResizeObserver(pinHorizontalOrigin)
    resizeObserver.observe(navigation)
    navigation.addEventListener('scroll', pinHorizontalOrigin, { passive: true })

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      navigation.removeEventListener('scroll', pinHorizontalOrigin)
    }
  }, [collapsed])

  useLayoutEffect(() => {
    if (!collapsed || !moreExpanded) return
    const updatePosition = () => {
      const anchor = moreToggleRef.current?.getBoundingClientRect()
      if (!anchor) return
      setMorePopoverPosition({
        top: Math.max(12, Math.min(anchor.top - 8, window.innerHeight - 228)),
        left: anchor.right + 8,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [collapsed, moreExpanded])

  useEffect(() => {
    if (!collapsed || !moreExpanded) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (moreToggleRef.current?.contains(target) || morePopoverRef.current?.contains(target)) return
      onToggleMoreExpanded()
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onToggleMoreExpanded()
      moreToggleRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [collapsed, moreExpanded, onToggleMoreExpanded])

  const updatePhase = updateState?.phase
  const showUpdate = updatePhase === 'available'
    || updatePhase === 'downloading'
    || updatePhase === 'downloaded'
  const updateLabel = updatePhase === 'downloaded'
    ? '主程序更新已就绪，点击安装'
    : updatePhase === 'downloading'
      ? '正在下载主程序更新'
      : `发现主程序新版本 ${updateState?.availableVersion ?? ''}`.trim()
  const groupLabels: Record<Exclude<NavigationGroup, 'more'>, string> = {
    use: '工作台',
    extensions: '扩展能力',
  }
  const renderItem = (item: (typeof navigationItems)[number], onSelected?: () => void) => {
    const Icon = item.icon
    return (
      <button
        key={item.id}
        type="button"
        className={`nav-item${activePage === item.id ? ' active' : ''}${item.id === 'overview' ? ' static-nav-item' : ''}`}
        data-navigation-id={item.id}
        data-sidebar-tooltip={item.label}
        title={item.hint ?? (collapsed ? item.label : undefined)}
        aria-current={activePage === item.id ? 'page' : undefined}
        // item.hint 本身挂在 aria-hidden 的图标上，屏幕阅读器读不到；这里在
        // 按钮上补一份可达的 aria-label，让 label 仍是主信息、hint 是补充说明。
        aria-label={item.hint ? `${item.label}：${item.hint}` : undefined}
        onClick={() => { onNavigate(item.id); onSelected?.() }}
      >
        <Icon size={18} />
        <span className="nav-label">{item.label}</span>
        {item.placeholder && <span className="nav-item-soon">即将</span>}
        {item.hint && (
          <span className="nav-item-hint" title={item.hint} aria-hidden="true">
            <CircleHelp size={12} />
          </span>
        )}
      </button>
    )
  }
  const systemItems = navigationItems.filter((item) => item.group === 'more')
  const collapsedSystemMenu = collapsed && moreExpanded ? createPortal(
    <div
      ref={morePopoverRef}
      className="nav-more-popover"
      id="sidebar-more-items"
      role="menu"
      aria-label="系统管理"
      style={morePopoverPosition}
    >
      <header><Settings2 size={16} /><strong>系统管理</strong></header>
      <div>{systemItems.map((item) => renderItem(item, onToggleMoreExpanded))}</div>
    </div>,
    document.body,
  ) : null

  return (
    <>
    <aside className="sidebar">
      <div className="brand-block">
        <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} className="brand-logo" alt="星芒AI" />
        <div>
          <div className="brand-name"><span>星芒</span>AI</div>
          <div className="brand-subtitle">v{appVersion}</div>
        </div>
        {showUpdate && (
          <button
            type="button"
            className={`brand-update-button phase-${updatePhase}`}
            title={updateLabel}
            aria-label={updateLabel}
            data-sidebar-tooltip={updateLabel}
            onClick={() => onNavigate('updates')}
          >
            <span className={`brand-update-ring phase-${updatePhase}`} aria-hidden="true">
              {updatePhase === 'downloading'
                ? <LoaderCircle size={17} className="spin" />
                : updatePhase === 'downloaded'
                  ? <RotateCw size={17} />
                  : <ArrowUp size={18} strokeWidth={2.4} />}
            </span>
          </button>
        )}
      </div>

      <nav ref={navigationRef} className="main-nav" aria-label="主导航">
        {(Object.keys(groupLabels) as Array<Exclude<NavigationGroup, 'more'>>).map((group) => (
          <div className="nav-group" key={group}>
            <div className="nav-group-label">{groupLabels[group]}</div>
            {navigationItems.filter((item) => item.group === group).map((item) => renderItem(item))}
          </div>
        ))}
        <div className="nav-group nav-group-more">
          <div className="nav-group-label">系统</div>
          <button
            ref={moreToggleRef}
            type="button"
            className={`nav-item nav-more-toggle${moreExpanded ? ' expanded' : ''}`}
            aria-expanded={moreExpanded}
            aria-controls="sidebar-more-items"
            aria-label="系统管理"
            title={collapsed ? '系统管理' : undefined}
            data-sidebar-tooltip="系统管理"
            onClick={onToggleMoreExpanded}
          >
            <Settings2 size={18} />
            <span className="nav-label">系统管理</span>
            <ChevronRight size={14} className="nav-more-chevron" />
          </button>
          {moreExpanded && !collapsed && (
            <div className="nav-more-items" id="sidebar-more-items">
              {systemItems.map((item) => renderItem(item))}
            </div>
          )}
        </div>
      </nav>

      <div className="sidebar-bottom">
        <AccountArea
          status={accountStatus}
          snapshot={accountSnapshot}
          relaySite={relaySite}
          onLogin={onAccountLogin}
          onLogout={onAccountLogout}
          onRecharge={onRecharge}
          onConfigureCliKey={onConfigureCliKey}
          onRefreshBalance={onRefreshBalance}
          onOpenAccountCenter={onOpenAccountCenter}
          onPasteKey={onPasteKey}
          onOpenKeysPage={onOpenKeysPage}
        />
        <div className="sidebar-controls">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button
            type="button"
            className="sidebar-control-button sidebar-collapse-button"
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            data-sidebar-tooltip={collapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
            <span>{collapsed ? '展开' : '收起'}</span>
          </button>
        </div>
      </div>
    </aside>
    {collapsedSystemMenu}
    </>
  )
}

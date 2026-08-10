import {
  BookOpen,
  ArrowUp,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  RotateCw,
  Sun,
} from 'lucide-react'
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
  updateState: UpdateSnapshot | null
  relaySite: RelaySite
  /** Whether the "更多" group is expanded (persisted to app-settings by the caller). */
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
      <span>{nextThemeName}模式</span>
    </button>
  )
}

export function Sidebar({
  activePage,
  collapsed,
  theme,
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
    use: '使用',
    extensions: '扩展',
  }
  const renderItem = (item: (typeof navigationItems)[number]) => {
    const Icon = item.icon
    return (
      <button
        key={item.id}
        type="button"
        className={`nav-item${activePage === item.id ? ' active' : ''}${item.id === 'overview' ? ' static-nav-item' : ''}`}
        data-sidebar-tooltip={item.label}
        aria-current={activePage === item.id ? 'page' : undefined}
        // item.hint 本身挂在 aria-hidden 的图标上，屏幕阅读器读不到；这里在
        // 按钮上补一份可达的 aria-label，让 label 仍是主信息、hint 是补充说明。
        aria-label={item.hint ? `${item.label}：${item.hint}` : undefined}
        onClick={() => onNavigate(item.id)}
      >
        <Icon size={18} />
        <span className="nav-label">{item.label}</span>
        {item.placeholder && <span className="nav-item-soon">soon</span>}
        {item.hint && (
          <span className="nav-item-hint" title={item.hint} aria-hidden="true">
            <CircleHelp size={12} />
          </span>
        )}
      </button>
    )
  }

  return (
    <aside className="sidebar">
      <div className="brand-block">
        <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} className="brand-logo" alt="星芒AI" />
        <div>
          <div className="brand-name"><span>星芒</span>AI</div>
          <div className="brand-subtitle">AI管理工具</div>
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

      <nav className="main-nav" aria-label="主导航">
        {(Object.keys(groupLabels) as Array<Exclude<NavigationGroup, 'more'>>).map((group) => (
          <div className="nav-group" key={group}>
            <div className="nav-group-label">{groupLabels[group]}</div>
            {navigationItems.filter((item) => item.group === group).map(renderItem)}
          </div>
        ))}
        <div className="nav-group nav-group-more">
          <button
            type="button"
            className={`nav-item nav-more-toggle${moreExpanded ? ' expanded' : ''}`}
            aria-expanded={moreExpanded}
            aria-controls="sidebar-more-items"
            data-sidebar-tooltip="更多"
            onClick={onToggleMoreExpanded}
          >
            <MoreHorizontal size={18} />
            <span className="nav-label">更多</span>
            <ChevronRight size={14} className="nav-more-chevron" />
          </button>
          {moreExpanded && (
            <div className="nav-more-items" id="sidebar-more-items">
              {navigationItems.filter((item) => item.group === 'more').map(renderItem)}
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
        <button
          className="official-site-button tutorial-docs-button"
          type="button"
          data-sidebar-tooltip="教程文档"
          onClick={() => void window.xingmang.openExternal('https://s4621e8xzb.feishu.cn/wiki/XLDLwdXDli3fj9kyMvsc5Qldnie?from=from_copylink')}
        >
          <span className="official-site-icon"><BookOpen size={17} /></span>
          <span className="official-site-copy">
            <strong>教程文档</strong>
            <small>售后群</small>
          </span>
          <ExternalLink size={13} className="official-site-external" />
        </button>
        <button
          className="official-site-button"
          type="button"
          data-sidebar-tooltip="官方网站"
          onClick={() => void window.xingmang.openExternal(relaySite.websiteUrl)}
        >
          <span className="official-site-icon"><Globe2 size={17} /></span>
          <span className="official-site-copy">
            <strong>官方网站</strong>
            <small>{relaySite.websiteUrl.replace(/^https:\/\//, '')}</small>
          </span>
          <ExternalLink size={13} className="official-site-external" />
        </button>
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
  )
}

import {
  BookOpen,
  ArrowUp,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Moon,
  RotateCw,
  Sun,
} from 'lucide-react'
import logoUrl from '../../assets/icon.png'
import logoWhiteUrl from '../../assets/icon-white.png'
import { navigationItems, type PageId } from '../navigation'
import type { UpdateSnapshot } from '../types'

interface SidebarProps {
  activePage: PageId
  collapsed: boolean
  theme: 'light' | 'dark'
  updateState: UpdateSnapshot | null
  onNavigate: (pageId: PageId) => void
  onToggleCollapsed: () => void
  onToggleTheme: () => void
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
  onNavigate,
  onToggleCollapsed,
  onToggleTheme,
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
        {navigationItems.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item${activePage === item.id ? ' active' : ''}${item.id === 'overview' ? ' static-nav-item' : ''}`}
              data-sidebar-tooltip={item.label}
              aria-current={activePage === item.id ? 'page' : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={18} />
              <span className="nav-label">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-bottom">
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
          onClick={() => void window.xingmang.openExternal('https://api.solov.cc')}
        >
          <span className="official-site-icon"><Globe2 size={17} /></span>
          <span className="official-site-copy">
            <strong>官方网站</strong>
            <small>api.solov.cc</small>
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

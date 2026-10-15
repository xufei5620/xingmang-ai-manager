import type { ReactNode } from 'react'
import { currentWindowOs, type WindowOs } from '../app/window-os'
import '../../styles/shell.css'

/**
 * 登录前那几屏的窗口条：v4 起和主界面的顶栏一样不写标题字，只留拖动区和右上角的按钮。
 * welcome：欢迎页的窗口条透明、没有底线，和下面的星空连成一片。
 */
export function AuthWindow({ children, platform, actions, variant }: { children: ReactNode; platform?: WindowOs; actions?: ReactNode; variant?: 'welcome' }) {
  const os = platform ?? currentWindowOs()
  return <div className={`v2-root auth-window${variant ? ` auth-window-${variant}` : ''}`} data-os={os}>
    <header className="v2-titlebar" data-testid="window-titlebar">{actions && <div className="auth-window-actions">{actions}</div>}</header>
    <div className="auth-window-content">{children}</div>
  </div>
}

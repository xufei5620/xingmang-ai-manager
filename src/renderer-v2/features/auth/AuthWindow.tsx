import type { ReactNode } from 'react'
import { Logo } from '../../ui'
import { currentWindowOs, type WindowOs } from '../app/window-os'
import '../../styles/shell.css'

export function AuthWindow({ children, platform }: { children: ReactNode; platform?: WindowOs }) {
  const os = platform ?? currentWindowOs()
  return <div className="v2-root auth-window" data-os={os}>
    <header className="v2-titlebar" data-testid="window-titlebar"><Logo kind="micro" height={20} /><span>星芒AI管理工具</span></header>
    <div className="auth-window-content">{children}</div>
  </div>
}

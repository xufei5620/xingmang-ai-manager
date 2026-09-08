import type { ReactNode } from 'react'
import { Logo } from '../../ui'
import '../../styles/shell.css'

export function AuthWindow({ children, platform }: { children: ReactNode; platform?: 'win' | 'mac' | 'linux' }) {
  const detected = typeof document === 'undefined' ? undefined : document.documentElement.dataset.os
  const os = platform ?? (detected === 'mac' || detected === 'linux' || detected === 'win' ? detected : typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? 'mac' : 'win')
  return <div className="v2-root auth-window" data-os={os}>
    <header className="v2-titlebar" data-testid="window-titlebar"><Logo kind="micro" height={20} /><span>星芒AI管理工具</span></header>
    <div className="auth-window-content">{children}</div>
  </div>
}

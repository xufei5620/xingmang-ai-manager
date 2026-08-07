import type { ReactNode } from 'react'
import type { PlatformCapabilities } from '../types'
import logoUrl from '../../assets/icon.png'
import logoWhiteUrl from '../../assets/icon-white.png'

export function AppFrame({ children, theme, platform }: {
  children: ReactNode
  theme: 'light' | 'dark'
  platform: PlatformCapabilities
}) {
  return (
    <div className="desktop-frame" data-platform-family={platform.platform}>
      <header className="window-titlebar">
        <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} alt="" aria-hidden="true" />
        <span>星芒AI管理工具</span>
      </header>
      <div className="desktop-content">{children}</div>
    </div>
  )
}

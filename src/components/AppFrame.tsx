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
        <div className="window-titlebar-brand">
          <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} alt="" aria-hidden="true" />
          <span>星芒 AI Manager</span>
        </div>
        <div className="window-titlebar-context" aria-hidden="true">
          <span className="window-titlebar-status" />
          <span>本机工作区</span>
        </div>
      </header>
      <div className="desktop-content">{children}</div>
    </div>
  )
}

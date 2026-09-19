import type { ReactNode } from 'react'
import { ErrorBoundary } from './ErrorBoundary'

// R-S10: App.tsx mounts its own ErrorBoundary inside PageViewport, so it only
// covers the page body. Sidebar, ShellTopbar, ShellStatusbar, every dialog,
// and App()'s own state and top-level effects all render above that boundary
// -- a throw in any of them unmounted the entire tree into a blank window,
// and packaged builds disable devtools, so killing the process was the only
// way out. This wrapper is the outermost thing the entry renders, which makes
// the crash panel (with its "导出诊断日志" button) the worst case instead.
export function RootShell({ children }: { children: ReactNode }) {
  return (
    // resetKey is constant because nothing navigates above App -- there is no
    // page id here to key an automatic retry off. Recovery is the fallback's
    // own buttons: "返回概览" clears the boundary, which remounts App from
    // scratch on its default overview page, and "重新加载" reloads the window.
    <ErrorBoundary resetKey="root" onReturnOverview={() => {}}>
      {children}
    </ErrorBoundary>
  )
}

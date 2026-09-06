import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import { AppFrame } from '../src/components/AppFrame'
import { Sidebar } from '../src/components/Sidebar'
import { ShellStatusbar, ShellTopbar, updateNotice, type ShellNotice } from '../src/components/shell/AppChrome'
import { NavigationStateProvider, PageViewport, useNavigationState } from '../src/components/shell/NavigationState'
import type { Announcement } from '../src/components/shell/useAnnouncements'
import type { PageId } from '../src/navigation'
import type { UpdateSnapshot } from '../src/types'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'
import './shell-navigation-fixture.css'

const params = new URLSearchParams(location.search)
const deferred = new Map<number, { resolve: (value: Announcement | null) => void; reject: (error: Error) => void }>()
const maliciousNotice = '<script>window.shellHarness.xss = true</script>\n<img src="https://attacker.invalid/html.png" onerror="window.shellHarness.xss = true">\n<iframe src="https://attacker.invalid/frame"></iframe>\n\n![远程图片](https://attacker.invalid/markdown.png)\n\n[恶意链接](javascript:alert(1))\n\n[官方说明](https://example.com/notice)'
const currentUpdate: UpdateSnapshot = { phase: 'available', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: '0.1.32', releaseNotesText: null, checkedAt: null, progress: null, error: null, development: true }
interface ShellHarness {
  navigations: string[]
  external: string[]
  helpCalls: number
  requests: Array<{ id: number; scope: string }>
  mode: 'normal' | 'error' | 'empty' | 'deferred' | 'malicious'
  xss: boolean
  releaseNotice: (id: number, text: string | null) => void
  failNotice: (id: number) => void
  releaseRows: () => void
  remountTopbar: () => void
  switchScope: (scope: string) => void
  navigate: (page: PageId) => void
  setNotices: (notices: ShellNotice[]) => void
}
declare global { interface Window { shellHarness: ShellHarness } }
window.shellHarness = {
  navigations: [], external: [], helpCalls: 0, requests: [], mode: (params.get('announcement') ?? 'normal') as ShellHarness['mode'], xss: false,
  releaseNotice(id, text) { deferred.get(id)?.resolve(text === null ? null : { id: `notice-${id}`, text }); deferred.delete(id) },
  failNotice(id) { deferred.get(id)?.reject(new Error('公告服务暂时不可用')); deferred.delete(id) },
  releaseRows() {}, remountTopbar() {}, switchScope() {}, navigate() {}, setNotices() {},
}

function PageContent({ page }: { page: PageId }) {
  const [ready, setReady] = useState(params.get('slow') !== 'true')
  const [filter, setFilter] = useNavigationState(`fixture.filter:${page}`, '')
  useEffect(() => { window.shellHarness.releaseRows = () => setReady(true) }, [])
  return <section className="fixture-content" data-testid="fixture-content" data-ready={ready}>
    <h1>{page}</h1>
    <label>筛选<input aria-label="页面筛选" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
    {ready ? Array.from({ length: 70 }, (_, index) => <article className="fixture-scroll-row" key={index}><strong>{page} / {index + 1}</strong><span>2026-09-07</span></article>) : <div className="fixture-pending" role="status">正在读取页面内容</div>}
  </section>
}

function Fixture() {
  const [page, setPage] = useState<PageId>('sessions')
  const [scope, setScope] = useState('account-a')
  const [topbarKey, setTopbarKey] = useState(0)
  const [theme, setTheme] = useState<'light' | 'dark'>(params.get('theme') === 'light' ? 'light' : 'dark')
  const [collapsed, setCollapsed] = useState(false)
  const [moreExpanded, setMoreExpanded] = useState(false)
  const [notices, setNotices] = useState<ShellNotice[]>([updateNotice(currentUpdate)!])
  const platform = platformCapabilitiesFor(params.get('platform') === 'macos' ? 'darwin' : 'win32', 'x64')
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const navigate = useCallback((target: PageId) => { window.shellHarness.navigations.push(target); setPage(target) }, [])
  window.shellHarness.navigate = navigate
  window.shellHarness.remountTopbar = () => setTopbarKey((current) => current + 1)
  window.shellHarness.switchScope = setScope
  window.shellHarness.setNotices = setNotices
  const loadAnnouncement = useCallback(async (): Promise<Announcement | null> => {
    const id = window.shellHarness.requests.length + 1
    window.shellHarness.requests.push({ id, scope })
    const mode = window.shellHarness.mode
    if (mode === 'empty') return null
    if (mode === 'error') throw new Error('公告服务暂时不可用')
    if (mode === 'deferred') return new Promise((resolve, reject) => deferred.set(id, { resolve, reject }))
    return { id: 'notice-stable-20260907', text: mode === 'malicious' ? maliciousNotice : `# 服务公告\n\n${scope} 的公告内容\n\n[官方说明](https://example.com/notice)` }
  }, [scope])
  return <AppFrame theme={theme} platform={platform}><NavigationStateProvider scope={scope}>
    <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar activePage={page} collapsed={collapsed} theme={theme} appVersion="0.1.31" updateState={currentUpdate} moreExpanded={moreExpanded}
        accountStatus="active" accountSnapshot={{ loggedIn: true, nickname: scope, quota: 8_000_000, quotaPerUnit: 500_000, usdExchangeRate: 7.3 }}
        onNavigate={navigate} onToggleCollapsed={() => setCollapsed((current) => !current)} onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        onToggleMoreExpanded={() => setMoreExpanded((current) => !current)} onAccountLogin={() => undefined} onAccountLogout={() => undefined}
        onRecharge={() => undefined} onConfigureCliKey={() => undefined} onRefreshBalance={() => undefined} onOpenAccountCenter={() => undefined} />
      <div className="shell-workspace">
        <ShellTopbar key={topbarKey} notices={notices} platform={platform.platform} onNavigate={navigate}
          onHelp={() => { window.shellHarness.helpCalls += 1 }} loadAnnouncement={loadAnnouncement} noticeScope={scope}
          onOpenExternal={(url) => { window.shellHarness.external.push(url) }} />
        <PageViewport viewKey={page}><PageContent key={page} page={page} /></PageViewport>
        <ShellStatusbar environment="本机环境已检测" account={`${scope}@example.com`} balance="$16.00" version="0.1.31" update={currentUpdate} onNavigate={navigate} onAccount={() => undefined} />
      </div>
    </div>
  </NavigationStateProvider></AppFrame>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

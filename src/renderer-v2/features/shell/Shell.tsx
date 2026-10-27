import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, Bell, CircleHelp, CreditCard, Download, Gauge, LogOut, Moon, PanelLeft, Play, RefreshCw, Search, SlidersHorizontal, Sparkles, Sun, Zap, type LucideIcon } from 'lucide-react'
import { Button, Coachmark, Dialog, Input, Logo, Tooltip } from '../../ui'
import { shellNavigation, shellTour, type ShellNavigationEntry } from '../../registry/shell'
import { pageRegistry, type PageId } from '../../registry/pages'
import { accountTabs, type SettingsItem } from '../../registry/business'
import '../../styles/shell.css'
import { errorMessage } from '../../business-common'
import { useLatestRequest } from '../../latest-request'
import { LocalAvatar } from '../../LocalAvatar'
import type { AvatarIdentity } from '../../local-avatar'
import type { EnvironmentStatus } from '../app/environment-status'
import { balanceRunwayMeter, balanceRunwayText, type BalanceRunway } from '../app/balance-runway'
import { readLocalPreference, writeLocalPreference } from '../app/preferences'
import { rowFocusEvent } from '../app/row-focus'
import type { SystemSnapshot } from '../../../../electron/ipc-contract'
import { networkLocationLabel, networkStatusLabel } from './network'
import { balanceFailureLabel, balanceStatusText, type BalanceStatusView } from './balance-status'
import { OfflineBanner } from './OfflineBanner'
import { offlineActionMessage } from './online-status'
import { useOnlineStatus } from './useOnlineStatus'
import { commandGroupLabels, searchCommands, type CommandAction, type CommandResult, type CommandTool } from './command-search'
import { tutorialTopicsFor } from '../../registry/tutorials'
import { accelerationBonusSeconds, isAccelerationBonusCode, type AccelerationRedemptionResult } from '../../../../electron/acceleration-contract'

interface AccountView extends BalanceStatusView {
  signedIn: boolean; supportsBilling?: boolean; supportsAnnouncements?: boolean; displayName?: string; email?: string
  /** 名字后面的小标签：历史账号挂「历史账号」，和星芒账号分得开；缺省 = 不挂。 */
  sourceTag?: string
  /** 正在恢复上次的登录（pending）或连不上、等着自动重试（retrying）：头像换成空白，金额位放占位条。 */
  restoring?: 'pending' | 'retrying'
  balance?: string
  /** 「订阅：剩余 $X · M 月 D 日到期」，只进状态栏余额的悬停说明；没有能用的订阅时缺省。 */
  subscription?: string
  /** 账号卡名字下面的套餐小标签：订阅名，没有订阅写「按量付费」；缺省 = 不挂。 */
  plan?: string
  /** 余额还能用多久：账号卡上那行小字和进度条、侧栏「充值」后面的「余额低」都读它；缺省 = 都不画。 */
  runway?: BalanceRunway | null
  identity?: AvatarIdentity
}
interface Adapter {
  /** section 是那一页里要落的分页、分组或教程主题；缺省 = 只跳页。 */
  navigate?(page: PageId, section?: string): void
  /** 顶部搜索什么都没搜到时，把输入的字带去教程页接着搜。 */
  searchTutorial?(query: string): void
  /** 当前账号能看到的个人中心分页；缺省 = 全部。 */
  accountTabVisible?(tab: string): boolean
  /** 这台电脑上有没有这一页（Linux 没有游戏加速）；缺省 = 都有。侧栏和搜索都按它。 */
  pageVisible?(page: PageId): boolean
  /** 这台电脑、这个登录状态下设置里有没有这一行（Windows 没有「卸载星芒」）；缺省 = 都有。只管搜索。 */
  settingsItemVisible?(item: SettingsItem): boolean
  openAccount?(): void
  switchAccount?(): void
  topUp?(): void
  refreshBalance?(): void
  refreshNetwork?(): void
  logout?(): void
  openHelp?(): void
  openAnnouncements?(): void
  openNotifications?(): void
  openHealth?(): void
  /** 搜索里的「开始检查」：去检查页并重新查一遍；缺省 = 只去检查页。 */
  startCheck?(): void
  openUpdates?(): void
  /** 顶栏的深浅色键；缺省 = 不放这颗键，搜索里也没有「切换到浅色 / 深色」。 */
  toggleTheme?(): void
  setSidebarCollapsed?(collapsed: boolean): void
  /** 搜索「工具」组列哪几个工具（v4 批 04）；缺省 = 不列。下面三个是选中后做的事，id 就是这里的 id。 */
  tools?: readonly CommandTool[]
  openTool?(id: string): void
  installTool?(id: string): void
  configureTool?(id: string): void
  redeemAccelerationCode?(code: string): Promise<AccelerationRedemptionResult | null>
}
interface ShellProps {
  activePage: PageId
  /** 个人中心现在摆着哪个分页：顶栏写「个人中心 / 页签名」，在充值页签时侧栏亮「充值」。 */
  accountTab?: string
  account: AccountView
  platform: 'win' | 'mac' | 'linux'
  adapter: Adapter
  theme?: 'light' | 'dark'
  /** 环境好不好：绿点「环境正常」、橙点「N 项需要处理」、灰点「环境待检测」；断网时状态栏写「没网」。 */
  environment?: EnvironmentStatus
  balance?: string
  version?: string
  /** 星芒有新版本：available = 还没装（「有新版本」），ready = 下好了（「重启后更新」）。 */
  update?: 'available' | 'ready'
  /** Observed network location, refreshed after a connection change. */
  network?: SystemSnapshot['network']
  networkRefreshing?: boolean
  /** 游戏加速连着时的线路名；状态栏网络那一项写「加速中 · 线路名」。缺省 = 没在加速。 */
  accelerationLine?: string
  /** 手机遥控 Codex 有渠道开着：状态栏亮「手机遥控中」，点了去设置里那张卡。缺省 = 没开。 */
  remoteActive?: boolean
  /** Kept for fixture compatibility; the status bar no longer presents it as a download source. */
  sourceLabel?: string
  installedCount?: number
  /** 已安装工具里有多少个可以更新；0 或缺省时首页入口不挂角标。 */
  updatableCount?: number
  unread?: boolean
  /** 公告弹层开着没有（铃铛的 aria-expanded）。 */
  announcementOpen?: boolean
  banner?: ReactNode
  notification?: ReactNode
  tourOpen?: boolean
  onTourClose?(): void
  children: ReactNode
}

// 窗口逻辑宽不到 1280（选了 110%，或窗口窄过自动缩放的下限）时侧栏自动收成窄条，不改你自己记的展开/收起。
// 判在 1272 而不是 1280：自动缩放本来就把逻辑宽算成 1280，可倍率取四位小数、窗口宽取整，真机上会差出不到一个
// 像素，不能因此把侧栏收掉；1272～1280 之间侧栏照样展开，只是正文两边的留白收窄一点，正文照样 1000 宽。
const narrowWindowQuery = '(max-width: 1271px)'
// 当前那一项滚进来时离上下边缘留一点，不落在渐隐里。
const navEdge = 16
const commandTitle = '搜索或跳转'
const commandPlaceholder = '输入页面、工具或操作，比如「充值」'
const actionIcons: Partial<Record<string, LucideIcon>> = {
  'action:recharge': CreditCard, 'action:usage': Gauge, 'action:check': Zap, 'action:help': CircleHelp, 'action:chat-parameters': SlidersHorizontal, 'account:logout': LogOut,
}
const toolActionIcons: Partial<Record<CommandAction, LucideIcon>> = { openTool: Play, installTool: Download, configureTool: SlidersHorizontal }

function useNarrowWindow() {
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(narrowWindowQuery).matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const media = matchMedia(narrowWindowQuery)
    function update() { setNarrow(media.matches) }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return narrow
}

export function Shell({ activePage, accountTab, account, platform, adapter, theme, environment, balance, version, update, network, networkRefreshing = false, accelerationLine, remoteActive = false, installedCount, updatableCount = 0, unread, announcementOpen = false, banner, notification, tourOpen, onTourClose, children }: ShellProps) {
  const { offline } = useOnlineStatus()
  const [tourStep, setTourStep] = useState(0)
  useEffect(() => { if (tourOpen) setTourStep(0) }, [tourOpen])
  const [collapsed, setCollapsed] = useState(() => readLocalPreference('xingmang-v2-sidebar') === 'collapsed')
  const narrow = useNarrowWindow()
  // 窗口窄、侧栏自动收着时点了展开：侧栏照原宽浮在正文上面，正文不挪不缩。这只是临时看一眼，不改你自己记的展开/收起。
  const [floatingOpen, setFloatingOpen] = useState(false)
  const floating = narrow && floatingOpen
  const rail = narrow ? !floating : collapsed
  const sidebarRef = useRef<HTMLElement>(null)
  // 窗口拉宽又变窄，侧栏回到收着的窄条，不自己浮出来。
  useEffect(() => { if (!narrow) setFloatingOpen(false) }, [narrow])
  // 浮着的时候点外面、按 Esc 就收回去；开着弹窗、或这一下 Esc 已经被别的浮层（抽屉、菜单）用掉了，就不跟着收。
  useEffect(() => {
    if (!floating) return
    function pointerdown(event: PointerEvent) {
      if (event.target instanceof Node && !sidebarRef.current?.contains(event.target)) setFloatingOpen(false)
    }
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !document.querySelector('dialog[open]')) setFloatingOpen(false)
    }
    document.addEventListener('pointerdown', pointerdown, true)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('pointerdown', pointerdown, true)
      document.removeEventListener('keydown', keydown)
    }
  }, [floating])
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<'top' | 'bottom' | 'both' | null>(null)
  // 上面那段导航放不下时自己滚：上下边缘渐隐，看得出还有。
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const element = scroller
    function measure() {
      const top = element.scrollTop > 1
      const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1
      setFade(top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    element.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', measure)
    }
  }, [rail])
  // 换页时当前那一项可能在滚出去的那段里：滚到看得见，不滚别的地方。
  useEffect(() => {
    const scroller = scrollerRef.current
    const item = scroller?.querySelector<HTMLElement>('.v2-nav-item.is-active')
    if (!scroller || !item) return
    const box = scroller.getBoundingClientRect()
    const rect = item.getBoundingClientRect()
    if (rect.top < box.top + navEdge) scroller.scrollTop -= box.top + navEdge - rect.top
    else if (rect.bottom > box.bottom - navEdge) scroller.scrollTop += rect.bottom - box.bottom + navEdge
  }, [activePage, rail])
  const [command, setCommand] = useState(false)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState(0)
  const [bonusBusy, setBonusBusy] = useState(false)
  const [bonusFeedback, setBonusFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const commandEpoch = useLatestRequest()
  const bonusFlight = useRef<object | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLElement>(null)
  const scroll = useRef(new Map<PageId, number>())
  const shownPage = useRef<PageId | null>(null)
  const [pageAnnouncement, setPageAnnouncement] = useState('')
  const results = searchCommands(query, {
    accountTabVisible: adapter.accountTabVisible, pageVisible: adapter.pageVisible, settingsItemVisible: adapter.settingsItemVisible,
    theme: adapter.toggleTheme ? theme : undefined, signedIn: account.signedIn && Boolean(adapter.logout), tools: adapter.tools,
  }, tutorialTopicsFor(platform))
  const bonusAction = Boolean(adapter.redeemAccelerationCode && isAccelerationBonusCode(query))
  const resultCount = bonusAction ? 1 : results.length
  useEffect(() => () => { bonusFlight.current = null }, [])
  // 结果比列表高时，用方向键选到下面的项也要滚进来。
  useEffect(() => {
    resultsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [selection])
  function openCommand() {
    commandEpoch.invalidate()
    setCommand(true); setQuery(''); setSelection(0); setBonusFeedback(null)
  }
  function closeCommand() { commandEpoch.invalidate(); setCommand(false) }
  function openResult(item: CommandResult) {
    closeCommand()
    if (item.action === 'check') { if (adapter.startCheck) adapter.startCheck(); else adapter.navigate?.('health') }
    else if (item.action === 'theme') adapter.toggleTheme?.()
    else if (item.action === 'help') adapter.openHelp?.()
    else if (item.action === 'logout') adapter.logout?.()
    else if (item.action === 'openTool' && item.tool) adapter.openTool?.(item.tool)
    else if (item.action === 'installTool' && item.tool) adapter.installTool?.(item.tool)
    else if (item.action === 'configureTool' && item.tool) adapter.configureTool?.(item.tool)
    else adapter.navigate?.(item.page, item.section)
  }
  function searchTutorial() {
    adapter.searchTutorial?.(query.trim().slice(0, 200)); closeCommand()
  }
  async function redeemBonus() {
    if (bonusFlight.current || !isAccelerationBonusCode(query) || !adapter.redeemAccelerationCode) return
    if (offline) { setBonusFeedback({ error: true, text: offlineActionMessage }); return }
    const flight = {}
    const epoch = commandEpoch.capture()
    bonusFlight.current = flight
    setBonusBusy(true); setBonusFeedback(null)
    try {
      const result = await adapter.redeemAccelerationCode(query.trim().toUpperCase())
      if (!epoch() || !result) return
      setBonusFeedback(result.status === 'redeemed'
        ? { error: false, text: `领取成功，已增加 ${result.addedSeconds / 60} 分钟加速时长。` }
        : result.status === 'already-redeemed'
          ? { error: false, text: '当前账号已在本机领取过该口令。' }
          : { error: true, text: '口令无效，请核对后重试。' })
    } catch (cause) {
      if (epoch()) setBonusFeedback({ error: true, text: errorMessage(cause, '领取失败，请稍后重试。') })
    } finally {
      if (bonusFlight.current === flight) { bonusFlight.current = null; setBonusBusy(false) }
    }
  }
  const balanceStatus = balanceStatusText({ ...account, offline })
  const balanceTitle = `${account.balance ?? '余额暂时没有读到'}；${balanceStatus}`
  // 还在恢复登录、头一回读余额：放灰色占位条；读过了没读到写「—」，不写「暂未读到」那么长一串。
  const balanceAmount = account.restoring || (account.signedIn && !account.balance && account.balanceLoading)
    ? <span className="v2-account-balance-placeholder" aria-hidden="true" data-testid="sidebar-balance-placeholder" />
    : account.balance
      ? <strong>{account.balance}</strong>
      : <strong title={account.signedIn ? '余额暂时没有读到，点刷新再试' : undefined} data-testid="sidebar-balance-unread">—</strong>
  const accountName = account.displayName ?? '未登录'
  const accountNote = account.email ?? (account.signedIn ? undefined : '登录后自动配密钥')
  const runway = account.signedIn ? account.runway ?? null : null
  const runwayLine = balanceRunwayText(runway)
  const lowBalance = Boolean(runway?.low)
  const emptyBalance = runway?.empty === true
  const balanceFailed = account.signedIn && Boolean(account.balanceError) && !account.balanceLoading
  const accountLabel = account.signedIn
    ? `个人中心：${accountName}${account.sourceTag ? `（${account.sourceTag}）` : ''}${account.balance ? `，余额 ${account.balance}` : ''}`
    : '登录'
  const rechargeActive = activePage === 'account' && accountTab === 'recharge'
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.isComposing || event.altKey || document.querySelector('dialog[open]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); openCommand()
      }
      if (event.key === '/' && event.target instanceof Element && !event.target.closest('input, textarea, [contenteditable="true"]')) {
        const field = viewport.current?.querySelector<HTMLInputElement>('input[type="search"], input[aria-label*="搜索"]')
        if (field) { event.preventDefault(); field.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [])
  // 切页之后焦点原来还停在侧栏按钮上：键盘用户要 Tab 穿过整条侧栏才到正文，读屏用户
  // 根本不知道页面换了。换页时把焦点交给正文区，并在播报区念一句页面名。首次渲染不动，
  // 开着弹窗不抢；新页面自己已经把焦点放进正文（比如聊天的输入框）也不抢。
  useEffect(() => {
    if (shownPage.current === null || shownPage.current === activePage) {
      shownPage.current = activePage
      return
    }
    shownPage.current = activePage
    setPageAnnouncement(`已切换到${pageRegistry.find((page) => page.id === activePage)?.label ?? '新页面'}`)
    const frame = requestAnimationFrame(() => {
      const main = viewport.current
      if (!main || document.querySelector('dialog[open]')) return
      const current = document.activeElement
      if (current && current !== main && main.contains(current) && !current.closest('[hidden], [inert]')) return
      main.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [activePage])
  // 详情抽屉在顶层（popover）里按窗口定位：告诉它正文从哪儿开始（顶栏、公告条、断网条都在上面），
  // 抽屉从那下面开始，不盖住它们的按钮。开机提示卡贴着正文左边，也要知道侧栏现在多宽。
  useLayoutEffect(() => {
    const main = viewport.current
    if (!main || typeof ResizeObserver === 'undefined') return
    const element = main
    const root = document.documentElement
    function measure() {
      const box = element.getBoundingClientRect()
      root.style.setProperty('--v2-content-top', `${Math.round(box.top)}px`)
      root.style.setProperty('--v2-content-left', `${Math.round(box.left)}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--v2-content-top')
      root.style.removeProperty('--v2-content-left')
    }
  }, [])
  function skipToContent(event: MouseEvent<HTMLAnchorElement>) {
    // 不改地址栏的 hash：只把焦点交给正文区，和切页时的落点一致。
    event.preventDefault()
    viewport.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const previous = scroll.current.get(activePage) ?? 0
    let restoring = true
    const observer = new ResizeObserver(() => restore())
    const finish = () => { restoring = false; observer.disconnect() }
    function restore() {
      if (!restoring) return
      element!.scrollTop = previous
      if (Math.abs(element!.scrollTop - previous) < 1) finish()
    }
    const remember = () => { if (!restoring) scroll.current.set(activePage, element.scrollTop) }
    const userScroll = () => { finish(); remember() }
    for (const child of element.children) observer.observe(child)
    restore()
    element.addEventListener('scroll', remember, { passive: true })
    element.addEventListener('wheel', userScroll, { passive: true })
    element.addEventListener('pointerdown', userScroll)
    // 从搜索或别的页跳过来要翻到某一行：那一行说了算，不再滚回上次的位置。
    element.addEventListener(rowFocusEvent, finish)
    return () => {
      // A programmatic scroll can be followed by navigation before Chromium
      // dispatches its scroll event. Read the live position during teardown so
      // fast page switches do not lose the user's last viewport location.
      scroll.current.set(activePage, element.scrollTop)
      observer.disconnect()
      element.removeEventListener('scroll', remember)
      element.removeEventListener('wheel', userScroll)
      element.removeEventListener('pointerdown', userScroll)
      element.removeEventListener(rowFocusEvent, finish)
    }
  }, [activePage])
  function toggleSidebar() {
    // 窗口窄时侧栏是自动收着的：点了浮在正文上展开、再点收回，不改你自己记的展开/收起。
    if (narrow) { setFloatingOpen((current) => !current); return }
    setCollapsed((current) => {
      writeLocalPreference('xingmang-v2-sidebar', current ? 'expanded' : 'collapsed')
      adapter.setSidebarCollapsed?.(!current)
      return !current
    })
  }
  // 浮着的侧栏里点了一页或账号卡：去那一页，侧栏收回去，不挡着刚打开的页。
  function foldAfterPick(event: MouseEvent<HTMLElement>) {
    if (floating && event.target instanceof Element && event.target.closest('.v2-nav-item, .v2-account-main')) setFloatingOpen(false)
  }
  // 用键盘把焦点移出侧栏（交给正文）时也收回去；焦点没去别处（点了窗口外面）就不动。
  function foldWhenFocusLeaves(event: FocusEvent<HTMLElement>) {
    if (floating && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setFloatingOpen(false)
  }
  function entryVisible(entry: ShellNavigationEntry) {
    return entry === 'recharge' ? account.supportsBilling !== false : adapter.pageVisible?.(entry) ?? true
  }
  function railTip(label: string, button: ReactNode, key: string) {
    return rail ? <Tooltip key={key} text={label} placement="right">{button}</Tooltip> : button
  }
  function navButton(id: PageId) {
    const definition = pageRegistry.find((page) => page.id === id)!
    const Icon = definition.icon
    // 首页那张「你的工具」卡片上写着同一个数字，这里只是把它提到侧栏，
    // 让没打开首页的人也知道有几个工具能更新了。
    const badge = id === 'home' && updatableCount > 0 ? updatableCount : 0
    const issues = id === 'health' ? environment?.issues ?? 0 : 0
    const label = badge ? `${definition.label}，${badge} 个工具可更新` : issues ? `${definition.label}，${issues} 项需要处理` : definition.label
    const button = <button type="button" className={`v2-nav-item${activePage === id ? ' is-active' : ''}`} key={id}
      aria-label={label} aria-current={activePage === id ? 'page' : undefined} data-testid={`nav-${id}`} data-navigation-id={id} onClick={() => adapter.navigate?.(id)}>
      <Icon size={16} strokeWidth={1.9} aria-hidden="true" /><span>{definition.label}</span>{definition.external && <ArrowUpRight className="v2-nav-external" size={13} aria-hidden="true" />}
      {badge > 0 && <small className="v2-nav-badge" data-testid="nav-home-updates">{badge}</small>}
      {issues > 0 && <small className="v2-nav-badge is-warn" data-testid="nav-health-issues">{issues}</small>}
    </button>
    return railTip(label, button, id)
  }
  // 「充值」不是一页，是个人中心的充值页签；余额按最近用量不够 7 天时后面挂「余额低」，钱包已经是 $0 的挂「余额为零」。
  function rechargeButton() {
    const tag = emptyBalance ? '余额为零' : '余额低'
    const label = lowBalance ? `充值，${tag}` : '充值'
    const button = <button type="button" className={`v2-nav-item${rechargeActive ? ' is-active' : ''}`} key="recharge"
      aria-label={label} aria-current={rechargeActive ? 'page' : undefined} data-testid="nav-recharge" onClick={adapter.topUp}>
      <CreditCard size={16} strokeWidth={1.9} aria-hidden="true" /><span>充值</span>
      {lowBalance && <small className="v2-nav-tag" data-testid="nav-recharge-low">{tag}</small>}
    </button>
    return railTip(label, button, 'recharge')
  }
  const pageLabel = pageRegistry.find((page) => page.id === activePage)?.label
  const accountTabLabel = activePage === 'account' ? accountTabs.find((tab) => tab.value === accountTab)?.label : undefined
  const environmentLabel = offline ? '没网' : environment?.label ?? '环境待检测'
  const environmentDot = offline ? ' is-bad' : environment?.tone === 'ok' ? ' is-ok' : environment?.tone === 'warn' ? ' is-warn' : ''
  // 历史账号没有用户名时是邮箱，状态栏放不下会省略，悬停看全文（#1133 第 3 条）。
  const userLine = account.signedIn ? `已登录 ${account.displayName}` : account.displayName ?? '未登录'
  const versionLabel = version ? `v${version}${update === 'available' ? ' · 有新版本' : update === 'ready' ? ' · 重启后更新' : ''}` : '版本读取中'
  const tour = shellTour[tourStep]
  return <div className="v2-root" data-os={platform} data-testid="app-frame">
    <div className={`v2-shell${rail ? ' sidebar-collapsed' : ''}${floating ? ' sidebar-floating' : ''}`} data-narrow={narrow || undefined}>
      <aside ref={sidebarRef} className="v2-sidebar" data-testid="sidebar" onClick={foldAfterPick} onBlur={foldWhenFocusLeaves}>
        <a className="v2-skip-link" href="#v2-main" onClick={skipToContent} data-testid="shell-skip-to-content">跳到正文</a>
        <div className="v2-brand"><Logo kind="micro" height={24} />{!rail && <Logo kind="wordmark" height={17} />}</div>
        <nav className="v2-sidebar-nav" aria-label="主导航">
          <div ref={scrollerRef} className="v2-sidebar-scroll" data-testid="sidebar-scroll" data-fade={fade ?? undefined}>{shellNavigation.map((group, index) => {
            const entries = group.entries.filter(entryVisible)
            if (!entries.length) return null
            return <div className="v2-nav-group" key={index} role={group.label ? 'group' : undefined} aria-label={group.label}>
              {group.label ? <p className="v2-nav-group-label" aria-hidden="true">{group.label}</p> : index > 0 && <hr className="v2-nav-separator" aria-hidden="true" />}
              {entries.map((entry) => entry === 'recharge' ? rechargeButton() : navButton(entry))}
            </div>
          })}</div>
          {/* 「设置」不跟着滚：屏幕矮时上面那段先收缩，它始终露在外面。「更多」里的几页在 v4 各有了去处
              （游戏加速、备份、更新并进设置，安装卸载拆到首页和检查页），「更多」跟着去掉了（第 10 批）。 */}
          <div className="v2-sidebar-pinned" data-testid="sidebar-pinned">
            {navButton('settings')}
          </div>
        </nav>
        <section className={`v2-account-entry${lowBalance ? ' is-low' : ''}${activePage === 'account' && !rechargeActive ? ' is-active' : ''}`} data-testid="account-entry">
          <button type="button" className="v2-account-main" aria-label={accountLabel} title={rail ? accountLabel : undefined} onClick={adapter.openAccount} data-testid="sidebar-account-open">
            <span className="v2-account-top">
              {account.restoring
                ? <span className="v2-account-placeholder" aria-hidden="true" data-testid="sidebar-account-placeholder">{account.restoring === 'pending' && <RefreshCw size={14} className="xm-spin" />}</span>
                : <LocalAvatar identity={account.identity ?? null} name={accountName} />}
              {!rail && <span className="v2-account-who">
                <span className="v2-account-name"><strong>{accountName}</strong>{account.signedIn && account.sourceTag && <small className="v2-account-tag" data-testid="sidebar-account-tag">{account.sourceTag}</small>}</span>
                {account.signedIn && account.plan
                  ? <span className="v2-account-plan" data-testid="sidebar-account-plan"><Sparkles size={11} strokeWidth={2.2} aria-hidden="true" /><span>{account.plan}</span></span>
                  : accountNote && <small>{accountNote}</small>}
              </span>}
            </span>
            {!rail && (account.signedIn || account.restoring) && <span className="v2-account-balance" title={balanceTitle}><span>余额</span>{balanceAmount}</span>}
            {!rail && runway?.days != null && <span className="v2-account-meter" aria-hidden="true"><i style={{ width: `${balanceRunwayMeter(runway.days)}%` }} /></span>}
            {!rail && runwayLine && <span className="v2-account-days" data-testid="sidebar-account-days">{runwayLine}</span>}
          </button>
          <button type="button" className="v2-account-rail" aria-label={rail ? '展开侧栏' : '收起侧栏'} title={rail ? '展开侧栏' : '收起侧栏'} onClick={toggleSidebar} data-testid="sidebar-collapse"><PanelLeft size={15} aria-hidden="true" /></button>
          {!rail && balanceFailed && <p className="v2-balance-error" role="status" title={balanceStatus}>{balanceFailureLabel(offline)}
            {adapter.refreshBalance && <Button size="xs" variant="ghost" icon={RefreshCw} aria-label="刷新余额" title={`刷新余额；${balanceStatus}`} onClick={adapter.refreshBalance} testId="sidebar-balance-refresh" />}</p>}
          {!rail && <span className="v2-account-mark" aria-hidden="true"><Logo kind="micro" height={76} /></span>}
        </section>
      </aside>
      <div className="v2-workspace">
        <header className="v2-topbar" data-testid="shell-topbar">
          <div className="v2-crumb" data-testid="window-titlebar">{accountTabLabel
            ? <>{pageLabel}<span aria-hidden="true">/</span><strong>{accountTabLabel}</strong></>
            : <strong>{pageLabel}</strong>}</div>
          <div className="v2-topbar-search"><button type="button" className="v2-command-trigger" onClick={openCommand}><Search size={14} aria-hidden="true" /><span>{commandTitle}</span><kbd>{platform === 'mac' ? '⌘ K' : 'Ctrl K'}</kbd></button></div>
          <div className="v2-topbar-actions">
            {adapter.toggleTheme && <button type="button" className="v2-topbar-icon" aria-label="切换深浅色" title="切换深浅色" onClick={adapter.toggleTheme} data-testid="shell-theme-toggle">{theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}</button>}
            {account.supportsAnnouncements !== false && <button type="button" className="v2-topbar-icon" aria-label="公告" title="公告" aria-haspopup="dialog" aria-expanded={announcementOpen} onClick={adapter.openAnnouncements} data-testid="announcement-open"><Bell size={16} aria-hidden="true" />{unread && <span className="v2-unread" />}</button>}
            <button type="button" className="v2-topbar-icon" aria-label="帮助与客服" title="帮助与客服" onClick={adapter.openHelp} data-testid="shell-help-open"><CircleHelp size={16} aria-hidden="true" /></button>
          </div>
        </header>
        <OfflineBanner />
        {banner}
        <main ref={viewport} id="v2-main" tabIndex={-1} className={`v2-content${activePage === 'chat' ? ' v2-content-chat' : ''}`} data-testid="page-viewport">{children}</main>
        <p className="v2-visually-hidden" role="status" aria-live="polite" data-testid="shell-page-announcement">{pageAnnouncement}</p>
        <footer className="v2-statusbar" data-testid="shell-statusbar">
          <button type="button" onClick={adapter.openHealth} title={environment?.detail} data-testid="statusbar-environment"><i className={`v2-dot${environmentDot}`} />{environmentLabel}</button>
          {environment?.node && <span data-testid="statusbar-node">{environment.node}</span>}
          <button type="button" className="v2-status-user" onClick={adapter.openAccount} title={userLine} data-testid="statusbar-user"><span>{userLine}</span></button>
          {(balance || account.balance) && <button type="button" onClick={adapter.topUp} title={account.subscription ? `${account.subscription}；${balanceStatus}` : balanceStatus} data-testid="statusbar-balance">余额 {balance ?? account.balance}{account.balanceLoading && <RefreshCw size={12} className="xm-spin" aria-label="正在刷新余额" />}{account.balanceError && !account.balanceLoading && <span className="v2-balance-error">{balanceFailureLabel(offline)}</span>}</button>}
          {/* 断网时只说「没网」，不再写一句「网络正常」。网络位置的全文（国家和 IP）在悬停说明里。
              加速中点它进「设置 › 网络加速」（v4 原型），不再是刷新网络位置；后台正测着位置时也点得动（#1104 第 10 条）。 */}
          {!offline && <button type="button" className="v2-network-location network-location" data-testid="shell-network-location"
            aria-label={accelerationLine ? `加速中 · ${accelerationLine}，查看网络加速` : '刷新网络位置'} aria-busy={networkRefreshing}
            disabled={accelerationLine ? !adapter.navigate : networkRefreshing || !adapter.refreshNetwork}
            title={networkRefreshing ? '正在检测当前网络出口' : `${network?.error ?? networkLocationLabel(network)}；${accelerationLine ? '点击查看网络加速' : '点击刷新网络位置'}`}
            onClick={accelerationLine ? () => adapter.navigate?.('acceleration') : adapter.refreshNetwork}>
            <span aria-live="polite">{networkRefreshing ? '正在检测网络位置…' : accelerationLine ? `加速中 · ${accelerationLine}` : networkStatusLabel(network)}</span>
          </button>}
          {remoteActive && <button type="button" className="v2-status-remote" onClick={() => adapter.navigate?.('settings', 'codex-remote')} disabled={!adapter.navigate} title="手机遥控 Codex 开着，点击查看或关闭" data-testid="statusbar-remote"><i className="v2-dot is-accent" />手机遥控中</button>}
          <span className="v2-status-spacer" />
          {installedCount !== undefined && <button type="button" onClick={() => adapter.navigate?.('home')} data-testid="statusbar-tools">已装 {installedCount} 个工具</button>}
          <button type="button" className={`v2-status-version${update ? ' has-update' : ''}`} onClick={adapter.openUpdates} data-testid="statusbar-version">{versionLabel}</button>
        </footer>
        {notification && <div className="v2-notification">{notification}</div>}
      </div>
    </div>
    {/* 没有标题行（读屏照样念「搜索或跳转」）；框顶钉在窗口约六分之一处，打字时不跳。 */}
    {command && <Dialog open headless title={commandTitle} onClose={closeCommand} width={640} initialFocus={searchRef} testId="command-palette">
      <div className="v2-command-search"><Search size={17} aria-hidden="true" /><Input ref={searchRef} type="search" aria-label={commandTitle} placeholder={commandPlaceholder} value={query} onChange={(event) => { commandEpoch.invalidate(); setQuery(event.target.value); setSelection(0); setBonusFeedback(null) }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setSelection((current) => resultCount ? (current + 1) % resultCount : 0) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setSelection((current) => resultCount ? (current + resultCount - 1) % resultCount : 0) }
        else if (event.key === 'Enter' && bonusAction) { event.preventDefault(); void redeemBonus() }
        else if (event.key === 'Enter' && results[selection]) { event.preventDefault(); openResult(results[selection]) }
      }} /><kbd className="v2-command-esc" aria-hidden="true">Esc</kbd></div>
      <div ref={resultsRef} className="v2-command-results" role="listbox" aria-label="页面与操作">{bonusAction
        ? <button role="option" aria-selected={selection === 0} aria-busy={bonusBusy} disabled={bonusBusy} type="button" data-testid="command-acceleration-bonus" onClick={() => { void redeemBonus() }}>
          {bonusBusy ? <RefreshCw size={15} className="xm-spin" aria-hidden="true" /> : <Zap size={15} aria-hidden="true" />}<span>{bonusBusy ? '正在领取…' : `领取 ${accelerationBonusSeconds / 60} 分钟加速时长`}</span><ArrowRight size={14} aria-hidden="true" />
        </button>
        : results.map((item, index) => {
          const Icon = item.action === 'theme' ? theme === 'dark' ? Sun : Moon : actionIcons[item.key] ?? (item.action && toolActionIcons[item.action]) ?? pageRegistry.find((page) => page.id === item.page)!.icon
          const heading = index === 0 || results[index - 1].group !== item.group
          // 分组标题只给看的人；读屏在每一项的名字里听到它属于哪一组。
          return <div className="v2-command-entry" key={item.key}>
            {heading && <p className="v2-command-group" aria-hidden="true" data-testid={`command-group-${item.group}`}>{commandGroupLabels[item.group]}</p>}
            <button role="option" aria-selected={index === selection} aria-label={item.group === 'page' ? item.label : `${commandGroupLabels[item.group]} · ${item.label}`} type="button" data-testid={`command-result-${item.key}`} onClick={() => openResult(item)}><Icon size={15} aria-hidden="true" /><span>{item.label}</span><ArrowRight size={14} aria-hidden="true" /></button>
          </div>
        })}</div>
      {bonusFeedback && <p role={bonusFeedback.error ? 'alert' : 'status'} data-testid="command-acceleration-feedback">{bonusFeedback.text}</p>}
      {!resultCount && <div className="v2-command-empty">
        <p role="status">{`没有找到「${query.trim().slice(0, 40)}」相关的内容`}</p>
        {adapter.searchTutorial && query.trim() && <Button size="sm" icon={Search} onClick={searchTutorial} testId="command-search-tutorial">{`去教程里搜「${query.trim().slice(0, 40)}」`}</Button>}
      </div>}
      <p className="v2-command-hint" data-testid="command-hint"><span><kbd>↑↓</kbd>选择</span><span><kbd>Enter</kbd>打开</span><span><kbd>Esc</kbd>关闭</span></p>
    </Dialog>}
    {/* 导览只在首页放（#1104 第 12 条）：第二步讲的是首页的工具卡片，开在别的页上只能指着侧栏的「首页」念卡片的说明。
        引导里点了「去聊天」「去充值」就先不出来，等回到首页再放，不把人从刚选的那一页拽走；放到一半去了别的页也先收起，回首页接着放。 */}
    <Coachmark open={Boolean(tourOpen && !command && activePage === 'home')} target={tour.target} placement={'placement' in tour ? tour.placement : undefined}
      body={typeof tour.body === 'string' ? tour.body : platform === 'mac' ? tour.body.mac : tour.body.win} label={`界面导览，第 ${tourStep + 1} 步`}
      step={tourStep + 1} count={shellTour.length} onNext={() => tourStep + 1 === shellTour.length ? onTourClose?.() : setTourStep((value) => value + 1)} onClose={() => onTourClose?.()} testId="shell-guide-tip" />
  </div>
}

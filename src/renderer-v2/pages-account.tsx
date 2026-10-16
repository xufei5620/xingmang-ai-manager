import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  Zap,
  HelpCircle,
  XCircle,
} from 'lucide-react'
import {
  BrandIcon,
  Button,
  Card,
  Dialog,
  Drawer,
  Empty,
  Input,
  ListRow,
  Menu,
  Notice,
  Pill,
  SearchInput,
  Segment,
  Select,
  SettingRow,
  Skeleton,
  Table,
  Toolbar,
} from './ui'
import {
  displayDate,
  dollars,
  errorMessage,
  failureWithDetail,
  FailureReason,
  ListReadFailure,
  ListState,
  Pagination,
  PlaceholderBar,
  overflowedPage,
  ResultNotice,
  useOperation,
  useRefreshRequest,
  useReloadWhenShown,
  useResource,
} from './business-common'
import {
  accountProfileAnchor,
  accountTabs,
  billingOptions,
  keyStates,
  orderStates,
  resolveAccountLanding,
  subscriptionStates,
  taskStates,
  taskFilterFields,
  usageFilterFields,
  type AccountLanding,
  type AccountTabValue,
} from './registry/business'
import { tools } from './registry/tools'
import type { V2Bridge } from './types'
import { accountOrigin, accountSiteId, accountSupports, visibleAccountTab, accountKeyQuota, type AccountSiteId } from './account-context'
import type { AccountSessionState } from '../../electron/ipc-contract'
import { isActiveProviderId, type ActiveProviderId } from '../../electron/catalog'
import { accountKeyExpiredTime } from '../../electron/account-key-quota'
import { AccountFilters, accountTimeRange, type AccountFilterField } from './AccountFilters'
import { usageDateRange } from '../../electron/usage-date-range'
import { platformApi } from './platform-api'
import {
  resolveRelaySite,
  type AccountPaymentWindowTerminalEvent,
} from '../../electron/ipc-contract'
import { LocalAvatar } from './LocalAvatar'
import { useSharedAccountBalance } from './features/app/balance-context'
import { AccountUsagePage, type UsageView } from './features/account/AccountUsage'
import { AccountOrders, AccountRecharge } from './features/account/AccountRecharge'
import { paymentMethodLabel } from './features/account/payment-method-label'
import { describeTopupTier, isQuotableAmount, sameTopupInfo, useTopupQuotes } from './features/account/topup-tier'
import { ToolKeyLimits } from './features/account/ToolKeyLimits'
import { ToolUsage } from './features/account/ToolUsage'
import { AccountOverview, type AccountSummary } from './features/account/AccountOverview'
import { AccountProfileDialog } from './features/account/AccountProfileDialog'
import { AccountSecurity } from './features/account/AccountSecurity'
import {
  currentExpiryText,
  inviteRuleText,
  keyExpiredTime,
  keyMetaParts,
  keyToolChoice,
  shortDate,
  type KeyExpiryChoice,
  type KeyToolTarget,
} from './features/account/account-center'
import type { LoginTarget } from './features/auth/api'
import { accountSources } from './features/auth/state'
import { KeyRewriteSkippedError } from './features/tools/account-bootstrap'
import { offlineActionMessage } from './features/shell/online-status'
import { requestRowFocus, useRowFocus } from './features/app/row-focus'
import { useOnlineStatus } from './features/shell/useOnlineStatus'
import {
  getSourceMarkerStorage,
  writeManualSourceMarker,
} from './features/tools/source-marker'
type Profile = Awaited<ReturnType<V2Bridge['getAccountProfile']>>
type Balance = Awaited<ReturnType<V2Bridge['getAccountBalance']>>
type AccountKey = Awaited<
  ReturnType<V2Bridge['getAccountKeys']>
>['keys'][number]
type Usage = Awaited<ReturnType<V2Bridge['getAccountUsage']>>['records'][number]
type Task = Awaited<ReturnType<V2Bridge['getAccountTasks']>>['tasks'][number]
type Plan = Awaited<ReturnType<V2Bridge['getAccountSubscriptionPlans']>>[number]
type PaymentMethod = Awaited<
  ReturnType<V2Bridge['getAccountTopupInfo']>
>['paymentMethods'][number]
type TopupInfo = Awaited<ReturnType<V2Bridge['getAccountTopupInfo']>>
type SubscriptionPaymentInput = Parameters<
  V2Bridge['createAccountSubscriptionPayment']
>[0]
type AccountTab = AccountTabValue
// 已下线的 CLI（Gemini，yoyo 2026-10-14）不在这里：账号页不再替它写 Key、列它的额度。
type Provider = ActiveProviderId
/** 首页那边某个工具的设置已经保存并读回；sequence 每次加一，同一个工具连存两次也认得出。 */
export interface ToolConfigConfirmation {
  provider: Provider
  sequence: number
}
// Codex CLI 与 Codex 桌面端共用一份配置，在用的是同一把 Key，所以只说「Codex」。
function keyToolName(provider: Provider): string {
  if (provider === 'codex') return 'Codex'
  return tools.find((tool) => tool.id === provider)?.name ?? provider
}
// 已下线的工具（Gemini）不在「配置到工具」里出现，也不往它的配置里写 Key；
// 主进程按本机缓存给密钥标的「在用」若是它，也不显示、撤销后不替它换新。
function isProvider(id: unknown): id is ActiveProviderId {
  return isActiveProviderId(id)
}
// 没读到的金额写「—」，不写「暂未读到」：小标签上是「消耗 —」「剩余 —」。
function quotaMoney(
  quota: number | null | undefined,
  balance: Balance | null,
) {
  return balance && balance.quotaPerUnit > 0 && typeof quota === 'number'
    ? dollars(quota / balance.quotaPerUnit)
    : '—'
}

export { passwordFormDirty, type PasswordFormState } from './features/account/AccountSecurity'

// 充值订阅这一页的纯函数搬到 features/account/recharge（v4 第 07 批），这里转出去给老测试和别处照旧引用。
export {
  buildSubscriptionPaymentInput,
  orderStateFor,
  paymentTerminalBody,
  paymentTerminalPresentation,
  resetTopupQuoteForMethod,
  subscriptionPaymentMethods,
  subscriptionStateFor,
  subscriptionToolsNotice,
  validateTopupAmount,
} from './features/account/recharge'
export { buildTopupBonus, type TopupBonus } from './features/account/topup-bonus'

/** Build the share link from the active relay site's public origin. */
export function buildAccountInviteLink(
  websiteUrl: string,
  affCode: string | null | undefined,
): string {
  const code = affCode?.trim()
  if (!code) return ''
  try {
    const url = new URL('/register', websiteUrl)
    url.searchParams.set('aff', code)
    return url.href
  } catch {
    return ''
  }
}

/** Convert an API ISO timestamp into the local value accepted by datetime-local. */
export function toDateTimeLocalValue(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 每个页签要先读到什么才画得出来。资料、余额分开读，一样没读到只挡要它的页签：
 * 充值订阅（连同下面的「我的订单」）、账号安全什么都不等，照常能进。
 */
export function accountTabNeeds(tab: AccountTab): { profile: boolean; balance: boolean } {
  if (tab === 'overview' || tab === 'invite') return { profile: true, balance: true }
  if (tab === 'recharge' || tab === 'security') return { profile: false, balance: false }
  return { profile: false, balance: true }
}

/** 页头名字下面那句：邮箱和哪种账号（v4 字表批06）。资料没读到就直说，不拿别的话顶上。 */
export function accountHeadLead(profile: Pick<Profile, 'username' | 'email'> | null, source: string): string {
  if (!profile) return '当前账号的资料暂时没有读到'
  return `${profile.email || profile.username} · ${source}`
}

type ReadFailure = { message: string; detail?: string }

/**
 * 个人中心六个页签，横排（v4）。左右方向键挪焦点，回车或空格才打开（手动激活），
 * 挪过去不会把每一页都读一遍。
 */
function AccountTabBar({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly AccountTab[]
  value: AccountTab
  onChange: (tab: AccountTab) => void
}) {
  function move(event: KeyboardEvent<HTMLButtonElement>, current: AccountTab) {
    if (event.nativeEvent.isComposing) return
    const index = tabs.indexOf(current)
    let target = index
    if (event.key === 'ArrowRight') target = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = tabs.length - 1
    else return
    event.preventDefault()
    document.getElementById(`v2-account-tab-${tabs[target]}`)?.focus()
  }
  return (
    <div className="xm-tabs v2-acct-tabs" role="tablist" aria-label="个人中心分区" data-testid="account-tabs">
      {tabs.map((tab) => (
        <button
          key={tab}
          id={`v2-account-tab-${tab}`}
          role="tab"
          type="button"
          aria-selected={value === tab}
          aria-controls={value === tab ? `v2-account-panel-${tab}` : undefined}
          tabIndex={value === tab ? 0 : -1}
          className={value === tab ? 'is-active' : ''}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => move(event, tab)}
        >
          {accountTabs.find((item) => item.value === tab)?.label}
        </button>
      ))}
    </div>
  )
}

/** 读取中那一页：和那一页内容差不多的灰色占位块，读到了原地换成内容，页面不往下跳。 */
function AccountPanelSkeleton({ tab }: { tab: AccountTab }) {
  if (tab === 'overview')
    return (
      <div className="v2-acct-overview" data-testid="account-loading">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index}><Skeleton rows={index < 2 ? 5 : 3} /></Card>
        ))}
      </div>
    )
  if (tab === 'usage' || tab === 'invite')
    return (
      <div className="v2-business-account-loading" data-testid="account-loading">
        <div className="v2-business-stat-grid">
          {Array.from({ length: 3 }, (_, index) => (
            <Card key={index}><Skeleton rows={2} /></Card>
          ))}
        </div>
        <Card><Skeleton rows={5} /></Card>
      </div>
    )
  return (
    <div className="v2-business-account-loading" data-testid="account-loading">
      <Card><Skeleton rows={6} /></Card>
    </div>
  )
}

/** 资料或余额读不到时，要它们的那一页正中：说没读到，原因照旧，给「重新加载」「联系客服」。 */
function AccountReadFailure({
  failure,
  onRetry,
  onOpenHelp,
}: {
  failure: ReadFailure
  onRetry: () => void
  onOpenHelp?: () => void
}) {
  return (
    <Empty
      testId="account-read-error"
      icon={XCircle}
      title="当前账号的资料暂时没有读到"
      description={<FailureReason error={failure.message} detail={failure.detail} />}
      action={
        <>
          <Button size="sm" icon={RefreshCw} onClick={onRetry} testId="account-read-retry">
            重新加载
          </Button>
          {onOpenHelp && (
            <Button size="sm" icon={HelpCircle} onClick={onOpenHelp} testId="account-read-support">
              联系客服
            </Button>
          )}
        </>
      }
    />
  )
}

export function AccountPage({
  api,
  initialTab,
  tabRequest,
  rechargeAmount,
  paymentReturn,
  accountSession,
  summary,
  keyTools,
  onLogin,
  onAccountChanged,
  onBack,
  onSwitchAccount,
  onRewriteKey,
  onConfigureTool,
  onToolConfigSaved,
  toolConfigConfirmed,
  onSubscriptionActivated,
  onSubscriptionPurchased,
  onOpenHelp,
  onOpenHealth,
  onTabChange,
  active,
}: {
  api: V2Bridge
  /** 要打开的页签，或页签里的某一节（「我的订单」「登录设备」…，见 accountSections）。 */
  initialTab?: AccountLanding
  /** 每次从外面点名要切到某个页签就加一；同一个页签再点一次也得切回去（Q29）。 */
  tabRequest?: number
  /** 从活动卡片点某一档进来时要选好的充值金额，跟着 tabRequest 一起变。缺省 = 默认金额。 */
  rechargeAmount?: number
  paymentReturn?: { sequence: number; order: string | null }
  /** 外壳手上的登录状态：页面自己读回来之前先拿它摆出页签。缺省 = 等页面自己读。 */
  accountSession?: AccountSessionState
  /** 外壳和首页同源的那几样数（还能用几天、能扣的订阅、近 7 天花费）；缺省 = 概览不写这几行。 */
  summary?: AccountSummary
  /** 「配置到工具」下拉里的工具，带装没装、是不是官方登录；缺省 = 只列名字，都能点。 */
  keyTools?: readonly KeyToolTarget[]
  onLogin?: (target?: LoginTarget) => void
  onAccountChanged?: () => void
  onBack?: () => void
  /** 打开「切换账号」框；缺省 = 概览「当前登录」那颗按钮灰着。 */
  onSwitchAccount?: () => void
  /** 撤销了工具正在用的 Key 之后，给那个工具换一把新的；缺省 = 不自动换（旧行为）。 */
  onRewriteKey?: (provider: Provider) => Promise<boolean>
  /** 打开某个工具的设置；自动换新不适用时（手填等），这是用户的下一步。缺省 = 不给按钮。 */
  onConfigureTool?: (provider: Provider) => void
  /** 「配置到工具」写成功后让首页重读配置；缺省 = 不通知（旧行为）。 */
  onToolConfigSaved?: () => void
  /** 某个工具的设置已保存并读回；每次加一。缺省 = 没有这个信号（旧行为）。 */
  toolConfigConfirmed?: ToolConfigConfirmation | null
  /** 订阅开通后把用得上它的工具换过去，返回换好的工具；缺省 = 不换（旧行为）。 */
  onSubscriptionActivated?: () => Promise<Provider[]>
  /** 订阅开通后让首页、侧栏那行订阅马上重读；缺省 = 等它自己几分钟后再读。 */
  onSubscriptionPurchased?: () => void
  /** 打开「联系客服」；缺省 = 不给这个按钮。 */
  onOpenHelp?: () => void
  /** 去「检查」页；缺省 = 订阅开通后工具没换过去时，不给「去检查页」。 */
  onOpenHealth?: () => void
  /** 现在摆出来的是哪个页签，顶栏的「个人中心 / 页签名」跟着它；缺省 = 不报。 */
  onTabChange?: (tab: AccountTab) => void
  /** 外壳说的「现在显示的是不是这一页」；缺省 = 只按页签算（旧行为）。 */
  active?: boolean
}) {
  const pageRef = useRef<HTMLElement>(null)
  const tabChange = useRef(onTabChange)
  tabChange.current = onTabChange
  const [tab, setTab] = useState<AccountTab>(resolveAccountLanding(initialTab).tab)
  // 「我的订单」按哪个订单号打开：外面付款回跳（paymentReturn）和充值页的「查看我的订单」
  // 共用一个递增编号，同一个订单号再点一次也会重新查。
  const [orderRequest, setOrderRequest] = useState(paymentReturn)
  useEffect(() => {
    if (paymentReturn) setOrderRequest((current) => ({ sequence: (current?.sequence ?? 0) + 1, order: paymentReturn.order }))
  }, [paymentReturn?.sequence])
  // 页签里的某一节（「我的订单」「登录设备」…）：切到它所在的页签，再翻到那一节。
  function openLanding(landing: AccountLanding) {
    const resolved = resolveAccountLanding(landing)
    if (resolved.anchor) requestRowFocus('account', resolved.anchor)
    setTab(resolved.tab)
  }
  function openOrders(order: string | null) {
    setOrderRequest((current) => ({ sequence: (current?.sequence ?? 0) + 1, order }))
    openLanding('orders')
  }
  const { store: balanceStore, snapshot: balanceState } = useSharedAccountBalance()
  const [visited, setVisited] = useState<AccountTab[]>([tab])
  useEffect(() => {
    setVisited((values) => (values.includes(tab) ? values : [...values, tab]))
  }, [tab])
  useEffect(() => {
    if (initialTab) setTab(resolveAccountLanding(initialTab).tab)
  }, [initialTab, tabRequest])
  const loadSession = useCallback(async () => {
    const session = await api.getAccountSession()
    return session.authenticated ? session : null
  }, [api])
  const sessionRead = useResource(loadSession)
  const session = sessionRead.data ?? (
    (sessionRead.loading || sessionRead.error) && accountSession?.authenticated ? accountSession : null
  )
  const signedOut = !sessionRead.loading && !sessionRead.error && !sessionRead.data
  const signedIn = Boolean(session)
  const detailsScope = session ? `${accountOrigin(session)}:${session.account?.userId ?? ''}` : ''
  // 已经读到过的资料、余额：刷新或改了东西以后再读没读到，手上这份留着，只在要它的那页顶上
  // 说一声（同改版前）。换了账号不沿用。
  const keptDetails = useRef<{ scope: string; profile: Profile | null; balance: Balance | null } | null>(null)
  // 和 useResource 一样只认最后发出去的那次：先发后到的旧结果上不了屏，也不能顶掉留着的那份。
  const detailsRequest = useRef(0)
  const loadDetails = useCallback(async () => {
    if (!detailsScope) return null
    const request = ++detailsRequest.current
    const [profile, balance] = await Promise.allSettled([
      api.getAccountProfile(),
      balanceStore ? balanceStore.refresh('foreground').then(() => {
        const state = balanceStore.getSnapshot()
        if (!state.balance) throw new Error(state.error || '余额暂时没有读到，请稍后重试。')
        return state.balance
      }) : api.getAccountBalance(),
    ])
    const kept = keptDetails.current?.scope === detailsScope ? keptDetails.current : null
    const next = {
      profile: profile.status === 'fulfilled' ? profile.value : kept?.profile ?? null,
      profileFailure: profile.status === 'rejected' ? failureWithDetail(profile.reason) : null,
      balance: balance.status === 'fulfilled' ? balance.value : kept?.balance ?? null,
      balanceFailure: balance.status === 'rejected' ? failureWithDetail(balance.reason) : null,
    }
    if (request === detailsRequest.current) {
      keptDetails.current = { scope: detailsScope, profile: next.profile, balance: next.balance }
    }
    return next
  }, [api, balanceStore, detailsScope])
  const details = useResource(loadDetails)
  const profile = details.data?.profile ?? null
  const balance = balanceStore && balanceState.balance ? balanceState.balance : details.data?.balance ?? null
  const detailsSettled = Boolean(details.data) || (!details.loading && Boolean(details.error))
  const site = session ? resolveRelaySite(accountSiteId(session)) : null
  const origin = session ? accountOrigin(session) : ''
  const accountId = session?.account?.userId ?? profile?.userId ?? 0
  const availableTabs = session ? accountTabs.filter((item) => visibleAccountTab(item.value, session)) : []
  const activeTab = availableTabs.some((item) => item.value === tab) ? tab : 'overview'
  useEffect(() => { tabChange.current?.(activeTab) }, [activeTab])
  // 页头「刷新」只重读点的时候停着的那一页；别的页签等切过去再说。
  const [refreshRequest, setRefreshRequest] = useState<{ tab: AccountTab; sequence: number }>({ tab: 'overview', sequence: 0 })
  // 「账号安全」里让设备下线以后，账号概览那张卡上的台数跟着重读。
  const [devicesChanged, setDevicesChanged] = useState(0)
  const refreshOf = (panel: AccountTab) => refreshRequest.tab === panel ? refreshRequest.sequence : 0
  // 「编辑资料」是页头铅笔打开的弹窗，不是页面上的一行：顶部搜索落到它时直接打开。
  const [profileOpen, setProfileOpen] = useState(false)
  // 「调用明细 | 异步任务」切到哪一段：顶部搜索落到「异步任务」时先切过去，那一节才露得出来。
  const [usageView, setUsageView] = useState<UsageView>('calls')
  // 充值页开着的支付窗口对应的订单：「我的订单」里那一行写「支付窗口开着」。
  const [openTradeNo, setOpenTradeNo] = useState<string | null>(null)
  useRowFocus('account', pageRef, true, (anchor) => {
    if (anchor === 'tasks') setUsageView('tasks')
    if (anchor !== accountProfileAnchor) return anchor
    setProfileOpen(true)
    return null
  })
  const reloadAccount = () => {
    void balanceStore?.refresh('manual')
    void sessionRead.reload()
    void details.reload()
    onAccountChanged?.()
  }
  const changed = () => {
    void balanceStore?.refresh('mutation')
    void sessionRead.reload()
    void details.reload()
    onAccountChanged?.()
  }
  function refreshAll() {
    reloadAccount()
    setRefreshRequest((current) => ({ tab: activeTab, sequence: current.sequence + 1 }))
  }
  function panelContent(panel: AccountTab) {
    if (!session) return null
    const needs = accountTabNeeds(panel)
    if ((needs.profile && !profile) || (needs.balance && !balance)) {
      const failure = (needs.profile && !profile ? details.data?.profileFailure : null)
        ?? (needs.balance && !balance ? details.data?.balanceFailure : null)
        ?? (details.error ? { message: details.error, detail: details.detail || undefined } : null)
      return failure && !details.loading
        ? <AccountReadFailure failure={failure} onRetry={reloadAccount} onOpenHelp={onOpenHelp} />
        : <AccountPanelSkeleton tab={panel} />
    }
    const stale = details.loading ? null : (needs.profile ? details.data?.profileFailure : null)
      ?? (needs.balance ? details.data?.balanceFailure : null)
    return (
      <>
        {stale && (
          <ResultNotice error={stale.message} detail={stale.detail} retry={{ label: '重新加载', onClick: reloadAccount }} />
        )}
        {panelBody(panel)}
      </>
    )
  }
  function panelBody(panel: AccountTab) {
    if (!session) return null
    const refresh = refreshOf(panel)
    switch (panel) {
      case 'overview':
        return profile && balance && (
          <AccountOverview
            api={api}
            profile={profile}
            balance={balance}
            session={session}
            summary={summary}
            refreshRequest={refresh}
            devicesChanged={devicesChanged}
            onNavigate={openLanding}
            onSwitchAccount={onSwitchAccount}
            active={(active ?? true) && activeTab === 'overview'}
            changed={changed}
          />
        )
      case 'usage':
        // 用量看板、调用明细、异步任务并成一页（v4 第 07 批）：看板在上，明细和任务两段切换。
        return balance && (
          <AccountUsagePage
            api={api}
            balance={balance}
            siteId={accountSiteId(session)}
            username={session.account?.username}
            accountScope={`${origin}:${accountId}`}
            dashboard={visibleAccountTab('dashboard', session)}
            trends={accountSupports(session, 'supportsDashboardTrends')}
            calls={accountSupports(session, 'supportsUsage')}
            tasks={visibleAccountTab('tasks', session)}
            view={usageView}
            onViewChange={setUsageView}
            refreshRequest={refresh}
          />
        )
      case 'keys':
        return balance && site && (
          <AccountKeys
            api={api}
            balance={balance}
            providerBaseUrls={site.providerBaseUrls}
            siteId={accountSiteId(session)}
            username={session.account?.username}
            keyTools={keyTools}
            onRewriteKey={onRewriteKey}
            onConfigureTool={onConfigureTool}
            onToolConfigSaved={onToolConfigSaved}
            toolConfigConfirmed={toolConfigConfirmed}
            refreshRequest={refresh}
          />
        )
      case 'recharge':
        // 「我的订单」在充值订阅最下面（v4）。
        return (
          <>
            <AccountRecharge
              api={api}
              balance={balance}
              session={session}
              summary={summary}
              changed={changed}
              refresh={reloadAccount}
              refreshRequest={refresh}
              subscriptionActivated={onSubscriptionActivated ? async () => (await onSubscriptionActivated()).map(keyToolName) : undefined}
              subscriptionPurchased={onSubscriptionPurchased}
              openOrders={openOrders}
              openHelp={onOpenHelp}
              openHealth={onOpenHealth}
              onPaymentChange={setOpenTradeNo}
              presetAmount={rechargeAmount}
              presetRequest={tabRequest}
              shown={(active ?? true) && activeTab === 'recharge'}
            />
            {visibleAccountTab('orders', session) && (
              <AccountOrders
                api={api}
                paymentReturn={orderRequest}
                refreshRequest={refresh}
                openTradeNo={openTradeNo}
                multiplierAccount={accountSiteId(session) === 'solov-api'}
              />
            )}
          </>
        )
      case 'security':
        return (
          <AccountSecurity
            api={api}
            session={session}
            refreshRequest={refresh}
            onChanged={changed}
            onDevicesChanged={() => {
              setDevicesChanged((value) => value + 1)
              changed()
            }}
            onOpenKeys={visibleAccountTab('keys', session) ? () => setTab('keys') : undefined}
          />
        )
      case 'invite':
        return profile && balance && site && (
          <AccountInvite
            api={api}
            profile={profile}
            balance={balance}
            changed={changed}
            inviteBaseUrl={site.websiteUrl}
          />
        )
    }
  }
  const source = session ? accountSources[accountSiteId(session)].label : ''
  const shownName = profile?.displayName || profile?.username || session?.account?.username || ''
  return (
    <section
      ref={pageRef}
      className="v2-page v2-business-account"
      data-page-id="account"
      data-testid="page-account"
    >
      <button
        type="button"
        className="v2-acct-back"
        aria-label="返回首页"
        title="回首页"
        onClick={onBack}
        disabled={!onBack}
        data-testid="account-back"
      >
        <ChevronLeft size={14} strokeWidth={2.2} aria-hidden="true" />回首页
      </button>
      <header className="v2-acct-hero">
        {signedIn && (
          <LocalAvatar
            identity={accountId ? { origin, userId: accountId } : null}
            name={shownName || '星'}
            size={48}
            testId="account-profile-avatar"
          />
        )}
        <div className="v2-acct-hero-copy">
          <div className="v2-acct-hero-name">
            {!signedIn ? <h1>个人中心</h1> : shownName ? <h1>{shownName}</h1> : <PlaceholderBar width="8em" />}
            {signedIn && (
              <Button
                variant="ghost"
                size="sm"
                icon={Pencil}
                aria-label="编辑资料"
                title="编辑资料"
                disabled={!profile}
                onClick={() => setProfileOpen(true)}
                testId="account-profile-edit"
              />
            )}
          </div>
          {signedIn && (
            <p>{detailsSettled ? accountHeadLead(profile, source) : <PlaceholderBar width="16em" testId="account-lead-loading" />}</p>
          )}
        </div>
        {signedIn && (
          <Button
            variant="ghost"
            icon={RefreshCw}
            aria-label="刷新"
            title="刷新"
            loading={sessionRead.loading || details.loading}
            onClick={refreshAll}
            testId="account-refresh"
          />
        )}
      </header>
      {signedOut ? (
        <Empty
          icon={UserRound}
          title="登录后查看个人中心"
          description="工具里已经写入的配置会继续保留。"
          action={
            <Button variant="primary" icon={UserRound} onClick={() => onLogin?.()}>
              登录账号
            </Button>
          }
        />
      ) : !session ? (
        sessionRead.error ? (
          <AccountReadFailure
            failure={{ message: sessionRead.error, detail: sessionRead.detail || undefined }}
            onRetry={reloadAccount}
            onOpenHelp={onOpenHelp}
          />
        ) : (
          <AccountPanelSkeleton tab={activeTab} />
        )
      ) : (
        <>
          <AccountTabBar
            tabs={availableTabs.map((item) => item.value)}
            value={activeTab}
            onChange={setTab}
          />
          <div className="v2-business-account-panels">
            {[...new Set([...visited, activeTab])].filter((panel) => visibleAccountTab(panel, session)).map((panel) => (
              <div
                className="v2-business-account-panel"
                role="tabpanel"
                id={`v2-account-panel-${panel}`}
                aria-labelledby={`v2-account-tab-${panel}`}
                key={`${origin}:${accountId}-${panel}`}
                hidden={panel !== activeTab}
              >
                {panelContent(panel)}
              </div>
            ))}
          </div>
        </>
      )}
      {profileOpen && profile && session && (
        <AccountProfileDialog
          key={detailsScope}
          api={api}
          profile={profile}
          identity={{ origin, userId: profile.userId }}
          editable={accountSupports(session, 'supportsProfileUpdate')}
          onClose={() => setProfileOpen(false)}
          onSaved={changed}
        />
      )}
    </section>
  )
}
// 分组不多时摆成分段（v4），多了或选中的那个已不可用时用下拉，免得一排挤不下、也好标「已不可用」。
const keyGroupSegmentLimit = 4
const keyExpiryChoices: ReadonlyArray<{ value: KeyExpiryChoice; label: string }> = [
  { value: 'never', label: '永不过期' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: 'custom', label: '自定日期' },
]
const keyQuotaChoices = [
  { value: 'unlimited', label: '不限额度' },
  { value: 'limited', label: '限额' },
]
// 「配置到工具」下拉里的工具：外壳没给（keyTools）时只列名字，装没装不知道就不拦。
function defaultKeyTools(): KeyToolTarget[] {
  return tools.flatMap((tool) => tool.kind === 'cli' && isProvider(tool.id)
    ? [{ provider: tool.id, name: tool.name, installed: null, official: false }]
    : [])
}
function isKeyExpiryChoice(value: string): value is KeyExpiryChoice {
  return value === 'keep' || keyExpiryChoices.some((choice) => choice.value === value)
}
function AccountKeys({
  api,
  balance,
  providerBaseUrls,
  siteId,
  username,
  keyTools,
  onRewriteKey,
  onConfigureTool,
  onToolConfigSaved,
  toolConfigConfirmed,
  refreshRequest,
}: {
  api: V2Bridge
  balance: Balance
  providerBaseUrls: Record<Provider, string>
  siteId: AccountSiteId
  /** 当前账号的用户名，「每个工具的额度上限」靠它认星芒新签的「用户名-分组」那几把。 */
  username?: string
  keyTools?: readonly KeyToolTarget[]
  onRewriteKey?: (provider: Provider) => Promise<boolean>
  onConfigureTool?: (provider: Provider) => void
  onToolConfigSaved?: () => void
  toolConfigConfirmed?: ToolConfigConfirmation | null
  refreshRequest?: number
}) {
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  // 搜索交给主进程翻完整张列表去筛（#495），以前只筛当前这 20 条，目标在第二页就
  // 显示「没有」。停手 300 毫秒再搜，免得每敲一个字都把整张列表翻一遍；换了搜索词
  // 从第一页看起。
  const [keyword, setKeyword] = useState('')
  useEffect(() => {
    const next = query.trim()
    if (next === keyword) return
    const timer = window.setTimeout(() => {
      setKeyword(next)
      setPage(1)
    }, next ? 300 : 0)
    return () => window.clearTimeout(timer)
  }, [query, keyword])
  const load = useCallback(
    async () => ({
      page: await api.getAccountKeys(keyword ? { page, pageSize: 20, keyword } : { page, pageSize: 20 }),
    }),
    [api, page, keyword],
  )
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  const operation = useOperation()
  // 「配置到工具」写的是工具的配置文件，没权限时说「写不进配置文件」（已知29）。
  const configureFailureTarget = operation.failed === 'configure' ? 'config' : undefined
  const keyTotal = resource.data?.page.total
  useEffect(() => {
    if (keyTotal === undefined) return
    const fallback = overflowedPage(page, keyTotal)
    if (fallback !== null) setPage(fallback)
  }, [keyTotal, page])
  const [editing, setEditing] = useState<AccountKey | 'new' | null>(null)
  // 新建成功后弹窗不关，原地说「已创建」，并告诉用户怎么让工具用它（v4）。
  const [created, setCreated] = useState('')
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  const [groups, setGroups] = useState<Awaited<ReturnType<V2Bridge['getAccountUsableGroups']>>>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupsError, setGroupsError] = useState('')
  const groupsRequest = useRef(0)
  const groupsPending = useRef<{ request: number; promise: Promise<void> } | null>(null)
  const groupsRequestedAt = useRef(0)
  const [quota, setQuota] = useState('10')
  const [unlimited, setUnlimited] = useState(false)
  const [expiry, setExpiry] = useState<KeyExpiryChoice>('never')
  const [customExpiry, setCustomExpiry] = useState('')
  const [removing, setRemoving] = useState<AccountKey | null>(null)
  // 撤销了工具在用的 Key、自动换新却没成：记下是哪个工具，好给一颗「再换一次」。
  // skipped = 这个工具的配置不归自动流程管（手填、来源没确认等），再换一次也还是跳过，
  // 要给的是「去设置」（#478）。
  const [replaceFailed, setReplaceFailed] = useState<{ provider: Provider; skipped: boolean } | null>(null)
  // 点「去设置」只是打开了设置窗口，用户可能取消，也可能保存失败，工具手里还是那把撤销掉的
  // Key。所以警告要等那个工具的设置真的保存、并读回之后才收起（#546）。只认点开之后
  // 新来的信号，之前留下的那次不算。
  const confirmedSequence = useRef(toolConfigConfirmed?.sequence ?? 0)
  useEffect(() => {
    if (!toolConfigConfirmed || toolConfigConfirmed.sequence === confirmedSequence.current) return
    confirmedSequence.current = toolConfigConfirmed.sequence
    setReplaceFailed((current) => current?.provider === toolConfigConfirmed.provider ? null : current)
  }, [toolConfigConfirmed])
  // 行内显示的完整密钥：只留一把，翻页、搜索、重读列表就收起，不在页面上多留。
  const [revealed, setRevealed] = useState<{ id: number; key: string } | null>(null)
  const revealing = useRef<number | null>(null)
  useEffect(() => setRevealed(null), [page, keyword, resource.data])
  const [selected, setSelected] = useState<{ key: AccountKey; provider: Provider } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const modelRequest = useRef(0)
  const toolTargets = keyTools ?? defaultKeyTools()
  useEffect(() => () => { groupsRequest.current++ }, [api, siteId])
  const refreshGroups = (force = false): Promise<void> => {
    if (operation.busy === 'save-key') return Promise.resolve()
    if (groupsPending.current?.request === groupsRequest.current) return groupsPending.current.promise
    // Pointer and focus are two events from one opening gesture. Share their
    // request instead of issuing two authenticated requests to the server.
    if (!force && Date.now() - groupsRequestedAt.current < 500) return Promise.resolve()
    groupsRequestedAt.current = Date.now()
    const request = ++groupsRequest.current
    setGroupsLoading(true)
    setGroupsError('')
    const promise = (async () => {
      try {
        const latest = await api.getAccountUsableGroups()
        if (groupsRequest.current !== request) return
        setGroups(latest)
        // Keep a user's selection during refresh. If it was removed, require
        // another explicit choice instead of silently changing the billed group.
        setGroup((selected) => selected || latest[0]?.name || '')
      } catch (cause) {
        // 这条错误是保存密钥的硬门槛（下方 save 直接拿 groupsError 拦截），压成一句
        // 固定话术会让「登录过期」「请求太频繁」「账号被封禁」三种完全不同的处境看起来
        // 都只是「刷新一下」，用户只能反复点刷新。过 errorMessage 拿到按原因分的文案，
        // 同时沿用它的脱敏（I13：主进程的错误里可能带绝对路径）。
        if (groupsRequest.current === request) {
          setGroupsError(errorMessage(cause, '分组读取失败，请刷新后重试。'))
        }
      } finally {
        if (groupsRequest.current === request) setGroupsLoading(false)
        if (groupsPending.current?.request === request) groupsPending.current = null
      }
    })()
    groupsPending.current = { request, promise }
    return promise
  }
  const refreshGroupsRef = useRef(refreshGroups)
  refreshGroupsRef.current = refreshGroups
  useEffect(() => {
    if (!editing || created) return
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void refreshGroupsRef.current()
    }
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    const interval = window.setInterval(refreshVisible, 30_000)
    return () => {
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
      window.clearInterval(interval)
    }
  }, [editing, created])
  const closeEditor = () => {
    groupsRequest.current++
    setEditing(null)
    setCreated('')
  }
  const edit = (key: AccountKey | 'new') => {
    setEditing(key)
    setCreated('')
    setName(key === 'new' ? '' : key.name)
    setGroup(key === 'new' ? '' : key.group)
    setGroups([])
    setUnlimited(key !== 'new' && key.unlimitedQuota)
    setQuota(
      key === 'new' ? '10' : String(key.remainQuota / balance.quotaPerUnit),
    )
    setExpiry(key === 'new' ? 'never' : 'keep')
    setCustomExpiry(key === 'new' ? '' : toDateTimeLocalValue(key.expiredAt))
    operation.clear()
    void refreshGroups(true)
  }
  const selectedGroupAvailable = groups.some((entry) => entry.name === group)
  const groupDescription = groups.find((entry) => entry.name === group)?.description?.trim()
  const save = () =>
    void operation.execute(
      'save-key',
      async () => {
        const amount = Number(quota)
        if (groupsLoading || groupsError || groupsPending.current?.request === groupsRequest.current) throw new Error('请先获取最新的可用分组。')
        if (!name.trim()) throw new Error('请给密钥起个名字')
        if (!group.trim() || !selectedGroupAvailable)
          throw new Error('当前没有可用分组，暂时无法保存密钥。')
        if (!unlimited && !(amount > 0)) throw new Error('请填写大于 0 的可用额度')
        const expiredTime = keyExpiredTime(expiry, {
          custom: customExpiry,
          current: editing && editing !== 'new' && expiry === 'keep' ? accountKeyExpiredTime(editing.expiredAt) : -1,
          now: Date.now(),
        })
        const input = {
          name: name.trim(),
          group,
          remainQuota: accountKeyQuota(amount, balance.quotaPerUnit, siteId, unlimited),
          unlimitedQuota: unlimited,
          expiredTime,
        }
        if (editing && editing !== 'new') {
          await api.updateAccountKey({ ...input, id: editing.id })
          closeEditor()
        } else {
          await api.createAccountKey(input)
          groupsRequest.current++
          setCreated(input.name)
        }
        await resource.reload()
        return input.name
      },
      (saved) => editing && editing !== 'new' ? `已保存「${saved}」` : '',
    )
  // 失败只记下工具，不把主进程的原话摆出来：这里要告诉用户的只有「点哪里」。
  const replaceKey = async (provider: Provider): Promise<boolean> => {
    let skipped = false
    const replaced = await onRewriteKey?.(provider).catch((error: unknown) => {
      skipped = error instanceof KeyRewriteSkippedError
      return false
    }) ?? false
    setReplaceFailed(replaced ? null : { provider, skipped })
    return replaced
  }
  const retryReplaceKey = (provider: Provider) =>
    operation.execute(
      'replace',
      async () => {
        if (!(await replaceKey(provider))) throw new Error(`${keyToolName(provider)} 还是没换上新密钥，请检查网络后再点一次。`)
        await resource.reload()
      },
      `${keyToolName(provider)} 已换上新密钥`,
    )
  function copyKey(key: AccountKey) {
    void operation.execute('copy', () => api.copyAccountKey(key.id), `已复制「${key.name}」的密钥，1 分钟后从剪贴板清除`)
  }
  function toggleReveal(key: AccountKey) {
    if (revealed?.id === key.id) {
      setRevealed(null)
      return
    }
    revealing.current = key.id
    void operation.execute('reveal', async () => setRevealed({ id: key.id, key: await api.revealAccountKey(key.id) }), '')
  }
  function configureTo(key: AccountKey, provider: Provider) {
    setSelected({ key, provider })
    setModels([])
    setModel('')
    const requestId = ++modelRequest.current
    void operation.execute(
      'models',
      async () => {
        const values = await api.listAccountKeyModels(key.id)
        if (requestId !== modelRequest.current) return
        setModels(values)
        setModel(values[0] ?? '')
      },
      '',
    )
  }
  function closeConfigure() {
    ++modelRequest.current
    setSelected(null)
  }
  const list = resource.data?.page.keys ?? []
  const now = new Date()
  const editingKey = editing && editing !== 'new' ? editing : null
  const groupControl = groups.length > 0 && groups.length <= keyGroupSegmentLimit && (!group || selectedGroupAvailable) ? (
    // 读分组的时机和下拉一样：点到或焦点进来就重读一次（同下面 Select 的 onFocus / onPointerDown）。
    <div className="v2-acct-field" onFocus={() => void refreshGroups()} onPointerDown={() => void refreshGroups()}>
      <span className="v2-acct-field-label">分组</span>
      <Segment
        label="密钥分组"
        options={groups.map((entry) => ({ value: entry.name, label: entry.name, disabled: operation.busy === 'save-key' }))}
        value={group}
        onChange={setGroup}
        testId="account-key-group-choices"
      />
      <small className="v2-acct-field-hint">{groupDescription || '分组决定这把密钥能用哪些模型、按什么价格算；拿不准就用已经选好的。'}</small>
    </div>
  ) : (
    <Select
      label="分组"
      testId="account-key-group"
      aria-label="密钥分组"
      disabled={!groups.length || operation.busy === 'save-key'}
      aria-busy={groupsLoading}
      onFocus={() => void refreshGroups()}
      onPointerDown={() => void refreshGroups()}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'F4'].includes(event.key)) void refreshGroups()
      }}
      options={
        [
          ...(!group ? [{ value: '', label: groupsLoading ? '正在读取分组…' : '暂无可用分组', disabled: true }]
            : !selectedGroupAvailable ? [{ value: group, label: `${group}（${groupsLoading ? '确认中' : '已不可用'}）`, disabled: true }] : []),
          ...groups.map((value) => ({
            value: value.name,
            label: value.name,
          })),
        ]
      }
      value={group}
      hint={groupDescription || '分组决定这把密钥能用哪些模型、按什么价格算；拿不准就用已经选好的。'}
      onChange={(event) => setGroup(event.target.value)}
    />
  )
  return (
    <>
      {/* 工具用的密钥在首页配置工具时会自动准备好，新手不该从这页手动建一把
          （新手引导梳理 9-25 第 5 条）。v4 收成最上面一行小字。 */}
      <div className="v2-acct-keys-top">
        <p className="v2-acct-muted" data-testid="account-keys-auto-hint">登录后每个工具会自动配好密钥，一般不用管。</p>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="搜索密钥或分组"
          testId="keys-search"
        />
        <Button
          variant="primary"
          size="sm"
          icon={Plus}
          onClick={() => edit('new')}
          testId="account-key-add"
        >
          新建密钥
        </Button>
      </div>
      <ToolKeyLimits api={api} balance={balance} siteId={siteId} username={username} refreshRequest={refreshRequest} />
      <ResultNotice {...operation} target={configureFailureTarget} />
      {replaceFailed && onRewriteKey && (replaceFailed.skipped ? (
        <Notice
          tone="warn"
          title={`${keyToolName(replaceFailed.provider)} 还在用刚撤销的密钥`}
          body={`${keyToolName(replaceFailed.provider)} 的配置不是按当前账号自动写的，这次没有替你改，它现在会连不上。${onConfigureTool ? '点「去设置」改用当前账号就好。' : '到首页打开它的设置，改用当前账号就好。'}`}
          testId="account-key-replace-skipped"
          actions={onConfigureTool && (
            <Button
              size="sm"
              icon={KeyRound}
              testId="account-key-replace-configure"
              onClick={() => onConfigureTool(replaceFailed.provider)}
            >
              去设置
            </Button>
          )}
        />
      ) : (
        <Notice
          tone="warn"
          title={`${keyToolName(replaceFailed.provider)} 暂时用不了`}
          body={`刚撤销的是 ${keyToolName(replaceFailed.provider)} 正在用的密钥，新密钥没有换上。点「再换一次」就好。`}
          testId="account-key-replace-failed"
          actions={
            <Button
              size="sm"
              icon={KeyRound}
              loading={operation.busy === 'replace'}
              disabled={Boolean(operation.busy)}
              testId="account-key-replace-retry"
              onClick={() => void retryReplaceKey(replaceFailed.provider)}
            >
              再换一次
            </Button>
          }
        />
      ))}
      <Card padding="none">
        <ListState
          page="keys"
          noun="密钥"
          loading={resource.loading}
          error={resource.error}
          count={list.length}
          query={query}
          filtered={Boolean(query)}
          retry={() => void resource.reload()}
          clear={() => setQuery('')}
          emptyTitle="还没有密钥"
          emptyDescription="新建一把，或者在工具配置里选「自动准备」。"
          searchTitle="没有找到相关密钥"
          searchDescription="换个名称或分组试试。"
          action={
            <Button size="sm" icon={Plus} onClick={() => edit('new')} testId="keys-empty-add">
              新建密钥
            </Button>
          }
        >
          {list.map((key) => {
            const status = keyStates[key.status as keyof typeof keyStates] ?? {
              label: '待确认',
              tone: 'neutral' as const,
            }
            const inUse = isProvider(key.managedProvider) ? key.managedProvider : null
            const shown = revealed?.id === key.id
            const usedShare = !key.unlimitedQuota && key.usedQuota + key.remainQuota > 0
              ? Math.min(100, Math.round(key.usedQuota / (key.usedQuota + key.remainQuota) * 100))
              : null
            return (
              <ListRow
                key={key.id}
                icon={KeyRound}
                title={key.name}
                testId={`account-key-row-${key.id}`}
                badge={
                  <>
                    <Pill>{key.group || '默认分组'}</Pill>
                    {inUse && (
                      <Pill tone="ok" dot testId={`account-key-in-use-${key.id}`}>
                        {keyToolName(inUse)} 在用
                      </Pill>
                    )}
                    {/* 「有效」不标，别的状态（停用、过期、额度用完）照旧标出来。 */}
                    {key.status !== 1 && <Pill tone={status.tone}>{status.label}</Pill>}
                  </>
                }
                desc={
                  <>
                    <span className="v2-acct-key-line">
                      <code className={shown ? 'is-shown' : undefined}>{shown ? revealed.key : key.maskedKey}</code>
                      <Button
                        variant="ghost"
                        size="xs"
                        icon={shown ? EyeOff : Eye}
                        aria-label={shown ? '隐藏密钥' : '显示密钥'}
                        title={shown ? '隐藏密钥' : '不要把完整密钥发给别人'}
                        loading={operation.busy === 'reveal' && revealing.current === key.id}
                        disabled={Boolean(operation.busy) && operation.busy !== 'reveal'}
                        onClick={() => toggleReveal(key)}
                      />
                      <Button
                        variant="ghost"
                        size="xs"
                        icon={Copy}
                        aria-label="复制密钥"
                        title="复制密钥"
                        disabled={Boolean(operation.busy)}
                        onClick={() => copyKey(key)}
                      />
                    </span>
                    <span className="v2-acct-key-meta">
                      {keyMetaParts(key, (value) => quotaMoney(value, balance), now).map((part) => <span key={part}>{part}</span>)}
                    </span>
                    {usedShare !== null && <span className="v2-acct-bar is-thin"><i style={{ width: `${usedShare}%` }} /></span>}
                  </>
                }
                actions={
                  <>
                    <Menu
                      label={`把密钥 ${key.name} 配置到工具`}
                      heading="把这把密钥写进"
                      // 一页好几把密钥，每行都有一颗「配置到工具」：读屏要念出是哪一把的。
                      anchor={<Button size="sm" iconRight={ChevronDown} disabled={Boolean(operation.busy)} aria-label={`把密钥 ${key.name} 配置到工具`}>配置到工具</Button>}
                      items={toolTargets.map((target) => {
                        const choice = keyToolChoice(target, inUse === target.provider)
                        return {
                          label: target.name,
                          hint: choice.hint || undefined,
                          disabled: choice.disabled,
                          onSelect: () => configureTo(key, target.provider),
                        }
                      })}
                    />
                    <Menu
                      label={`密钥 ${key.name} 的更多操作`}
                      anchor={<MoreHorizontal size={18} />}
                      items={[
                        {
                          label: '编辑',
                          icon: Pencil,
                          onSelect: () => edit(key),
                        },
                        {
                          label: '复制密钥',
                          icon: Copy,
                          disabled: Boolean(operation.busy),
                          onSelect: () => copyKey(key),
                        },
                        'divider',
                        {
                          label: '撤销密钥',
                          icon: Trash2,
                          danger: true,
                          onSelect: () => setRemoving(key),
                        },
                      ]}
                    />
                  </>
                }
              />
            )
          })}
        </ListState>
      </Card>
      <Pagination
        page={page}
        total={resource.data?.page.total ?? 0}
        failed={Boolean(resource.error)}
        onChange={setPage}
      />
      <Dialog
        open={Boolean(editing)}
        title={created ? '新建密钥' : editingKey ? `编辑「${editingKey.name}」` : '新建密钥'}
        onClose={closeEditor}
        busy={operation.busy === 'save-key'}
        testId="account-key-editor"
        footer={created ? (
          <Button variant="primary" onClick={closeEditor} testId="account-key-created-done">完成</Button>
        ) : (
          <>
            <Button onClick={closeEditor} disabled={operation.busy === 'save-key'}>取消</Button>
            <Button
              variant="primary"
              icon={KeyRound}
              loading={operation.busy === 'save-key'}
              disabled={groupsLoading || Boolean(groupsError) || !selectedGroupAvailable}
              onClick={save}
            >
              {editingKey ? '保存' : '创建密钥'}
            </Button>
          </>
        )}
      >
        {created ? (
          <div className="v2-acct-created" role="status" data-testid="account-key-created">
            <strong>「{created}」已创建</strong>
            <p>想让某个工具用它，在列表里点「配置到工具」。</p>
          </div>
        ) : (
          <>
            <ResultNotice error={operation.error} detail={operation.detail} />
            <ResultNotice error={groupsError} />
            <Input
              label="名称"
              value={name}
              maxLength={50}
              hint="方便你认出它"
              onChange={(event) => setName(event.target.value)}
            />
            {groupControl}
            {groupsError && (
              <Button variant="ghost" size="sm" icon={RefreshCw} testId="account-key-groups-refresh"
                loading={groupsLoading} disabled={groupsLoading || operation.busy === 'save-key'} onClick={() => void refreshGroups(true)}>
                刷新分组
              </Button>
            )}
            {groupsLoading && <p role="status">正在获取最新分组…</p>}
            {!groupsLoading && !groupsError && group && !selectedGroupAvailable && <p role="alert">原分组已不可用，请重新选择；已填写的内容仍保留。</p>}
            <div className="v2-acct-field">
              <span className="v2-acct-field-label">到期时间</span>
              <Segment
                label="到期时间"
                options={[...(editingKey ? [{ value: 'keep', label: '不改' }] : []), ...keyExpiryChoices]}
                value={expiry}
                onChange={(value) => {
                  if (isKeyExpiryChoice(value)) setExpiry(value)
                }}
                testId="account-key-expiry"
              />
              {editingKey && expiry === 'keep' && <small className="v2-acct-field-hint">现在：{currentExpiryText(editingKey.expiredAt, now)}</small>}
            </div>
            {expiry === 'custom' && (
              <Input
                label="到期日期"
                type="datetime-local"
                value={customExpiry}
                onChange={(event) => setCustomExpiry(event.target.value)}
                testId="account-key-expiry-custom"
              />
            )}
            <div className="v2-acct-field">
              <span className="v2-acct-field-label">额度</span>
              <Segment
                label="额度"
                options={keyQuotaChoices}
                value={unlimited ? 'unlimited' : 'limited'}
                onChange={(value) => setUnlimited(value === 'unlimited')}
                testId="account-key-quota-mode"
              />
            </div>
            {!unlimited && (
              <Input
                label="可用额度"
                type="number"
                min="0"
                step="0.01"
                hint="美元，用完后这把密钥会暂停，不影响账户余额"
                value={quota}
                onChange={(event) => setQuota(event.target.value)}
              />
            )}
          </>
        )}
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        title={removing ? `撤销「${removing.name}」？` : ''}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'revoke'}
              onClick={() => {
                if (removing)
                  void operation.execute(
                    'revoke',
                    async () => {
                      await api.revokeAccountKey(removing.id)
                      // 换新也算在这一下里：确认按钮一直转着，直到新 Key 写进工具。
                      const provider = onRewriteKey && isProvider(removing.managedProvider) ? removing.managedProvider : undefined
                      const replaced = provider ? await replaceKey(provider) : false
                      setRemoving(null)
                      await resource.reload()
                      return { name: removing.name, provider: provider && replaced ? provider : null }
                    },
                    (result) => result.provider
                      ? `已撤销「${result.name}」，${keyToolName(result.provider)} 已换用新的密钥`
                      : `已撤销「${result.name}」`,
                  )
              }}
            >
              撤销
            </Button>
          </>
        }
      >
        <p>撤销后这把密钥马上失效，找不回来。</p>
        {isProvider(removing?.managedProvider) && (
          <p>
            {onRewriteKey
              ? `${keyToolName(removing.managedProvider)} 正在用它，会马上换一把新的写进去，不影响使用。`
              : `${keyToolName(removing.managedProvider)} 正在用它，撤销后它会连不上。`}
          </p>
        )}
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        title={selected ? `把「${selected.key.name}」写进 ${toolTargets.find((target) => target.provider === selected.provider)?.name ?? keyToolName(selected.provider)}？` : ''}
        onClose={closeConfigure}
        footer={
          <>
            <Button onClick={closeConfigure}>取消</Button>
            <Button
              variant="primary"
              icon={KeyRound}
              disabled={!model}
              loading={operation.busy === 'configure'}
              onClick={() => {
                if (selected)
                  void operation.execute(
                    'configure',
                    async () => {
                      const provider = selected.provider
                      await api.saveConfigWithAccountKey({
                        keyId: selected.key.id,
                        provider,
                        model,
                        mode: 'merge',
                      })
                      writeManualSourceMarker(
                        getSourceMarkerStorage(),
                        providerBaseUrls[provider],
                        provider,
                        false,
                      )
                      setSelected(null)
                      // 这里写进去的是另一把没撤销的 Key，这个工具的撤销警告可以收起了。
                      setReplaceFailed((current) => current?.provider === provider ? null : current)
                      // 主进程保存这条路不发配置变更事件，首页那份快照得由这里叫它重读，
                      // 否则回到首页还是旧的来源和模型（#479）。
                      onToolConfigSaved?.()
                    },
                    '密钥已写入工具配置',
                  )
              }}
            >
              写入并改用当前账号
            </Button>
          </>
        }
      >
        <ResultNotice error={operation.error} detail={operation.detail} target={configureFailureTarget} />
        <p>写入后会改用当前账号，用量从余额里扣。原来的配置会先备份。{selected?.provider === 'codex' && 'Codex CLI 与桌面端共用同一份配置。'}</p>
        <Select
          aria-label="选择模型"
          options={models.map((value) => ({ value, label: value }))}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
      </Dialog>
    </>
  )
}
function AccountInvite({
  api,
  profile,
  balance,
  changed,
  inviteBaseUrl,
}: {
  api: V2Bridge
  profile: Profile
  balance: Balance
  changed: () => void
  inviteBaseUrl: string
}) {
  const operation = useOperation()
  const [transfer, setTransfer] = useState(false)
  const [amount, setAmount] = useState('')
  // 页面上只摆邀请码：完整链接里有站点地址，界面上不出现站点名；复制出去的还是完整链接。
  const invite = buildAccountInviteLink(inviteBaseUrl, profile.affCode)
  const transferable = quotaMoney(profile.affQuota, balance)
  const now = new Date()
  return (
    <>
      <ResultNotice {...operation} />
      <div className="v2-acct-invite">
        <section className="v2-acct-card is-focus" data-testid="account-invite-code-card">
          <h2>我的邀请码</h2>
          <div className="v2-acct-invite-code">
            <code data-testid="account-invite-code">{profile.affCode?.trim() || '—'}</code>
            <Button
              size="sm"
              icon={Copy}
              disabled={!invite}
              onClick={() =>
                void operation.execute(
                  'copy',
                  () => navigator.clipboard.writeText(invite),
                  '邀请链接已复制',
                )
              }
              testId="account-invite-link"
            >
              复制邀请链接
            </Button>
          </div>
          <p className="v2-acct-muted">{inviteRuleText(profile.affRebateRatePercent)}</p>
        </section>
        <section className="v2-acct-card">
          <h2>邀请成绩</h2>
          <div className="v2-acct-kv"><span>已邀请</span><b>{profile.affCount} 人</b></div>
          <div className="v2-acct-kv"><span>可转入余额</span><b className="v2-acct-number">{transferable}</b></div>
          <div className="v2-acct-kv"><span>累计获得返利</span><b>{quotaMoney(profile.affHistoryQuota, balance)}</b></div>
          <div>
            <Button
              size="sm"
              icon={Zap}
              disabled={profile.affQuota <= 0}
              onClick={() => {
                // 默认金额按点开这一刻的可转余额算。转出一部分后资料会重读，但这张卡不会重新挂上，
                // 只在挂上时算一次的话，再点开还是上一次的数，可能比现在剩下的还多。
                setAmount(String(profile.affQuota / balance.quotaPerUnit))
                setTransfer(true)
              }}
              testId="account-invite-transfer"
            >
              {profile.affQuota > 0 ? '转入余额' : '已全部转入'}
            </Button>
          </div>
        </section>
      </div>
      {/* 只有历史账号的后台给邀请名单；星芒账号没有，整节不显示。 */}
      {Boolean(profile.invitees?.length) && (
        <section className="v2-acct-section">
          <div className="v2-acct-section-head"><h2>邀请记录</h2></div>
          <Card padding="none" testId="account-invite-records">
            {profile.invitees?.map((item) => {
              const joined = item.createdAt ? shortDate(item.createdAt, now) : ''
              return (
                <ListRow
                  key={item.userId}
                  icon={UserRound}
                  title={item.email || item.username || '—'}
                  desc={joined ? `${joined}注册` : undefined}
                  actions={<Pill tone="ok">已返利 {quotaMoney(item.totalRebate, balance)}</Pill>}
                />
              )
            })}
          </Card>
        </section>
      )}
      <Dialog
        open={transfer}
        title={`把 ${transferable} 返利转入余额？`}
        onClose={() => setTransfer(false)}
        footer={
          <>
            <Button onClick={() => setTransfer(false)}>取消</Button>
            <Button
              variant="primary"
              icon={Zap}
              loading={operation.busy === 'transfer'}
              onClick={() =>
                void operation.execute(
                  'transfer',
                  async () => {
                    const quota = Math.round(
                      Number(amount) * balance.quotaPerUnit,
                    )
                    if (
                      !Number.isFinite(quota) ||
                      quota <= 0 ||
                      quota > profile.affQuota
                    )
                      throw new Error('转入金额不能超过可用返利。')
                    await api.transferAccountAffiliateQuota({ quota })
                    setTransfer(false)
                    changed()
                    return quota
                  },
                  (quota) => `${quotaMoney(quota, balance)} 已转入余额`,
                )
              }
            >
              转入余额
            </Button>
          </>
        }
      >
        <p>转入后可以直接用来调用模型，不能再转回返利。</p>
        <Input
          label="转入金额（USD）"
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </>
  )
}

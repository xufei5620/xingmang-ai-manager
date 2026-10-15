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
import { UsageDetails } from './features/account/UsageDetails'
import { buildTopupBonus } from './features/account/topup-bonus'
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

export function subscriptionPaymentMethods(
  plan: Plan,
  methods: PaymentMethod[],
  availability?: Pick<
    TopupInfo,
    | 'onlineTopupEnabled'
    | 'stripeTopupEnabled'
    | 'creemTopupEnabled'
    | 'waffoPancakeTopupEnabled'
  >,
) {
  return methods.filter(
    (method) => {
      const enabled = !availability
        || (method.provider === 'epay' && availability.onlineTopupEnabled)
        || (method.provider === 'stripe' && availability.stripeTopupEnabled)
        || (method.provider === 'creem' && availability.creemTopupEnabled)
        || (method.provider === 'waffo-pancake' && availability.waffoPancakeTopupEnabled)
      return enabled && (
        method.provider === 'epay' ||
        (method.provider === 'stripe' && Boolean(plan.stripePriceId)) ||
        (method.provider === 'creem' && Boolean(plan.creemProductId)) ||
        (method.provider === 'waffo-pancake' &&
          Boolean(plan.waffoPancakeProductId))
      )
    },
  )
}

/**
 * The IPC contract accepts a payment method only for the epay adapter. Stripe,
 * Creem, and Waffo-Pancake identify their checkout channel by provider alone.
 */
export function buildSubscriptionPaymentInput(
  planId: number,
  method: Pick<PaymentMethod, 'provider' | 'type'>,
): SubscriptionPaymentInput {
  if (method.provider === 'waffo') {
    throw new Error('该支付渠道暂不支持订阅。')
  }
  return method.provider === 'epay'
    ? { planId, provider: 'epay', paymentMethod: method.type }
    : { planId, provider: method.provider }
}

export function paymentTerminalPresentation(
  status: AccountPaymentWindowTerminalEvent['status'],
  confirming = false,
  kind: 'topup' | 'subscription' = 'topup',
): { tone: 'neutral' | 'warn' | 'bad' | 'ok'; title: string; body: string } {
  if (status === 'success' && kind === 'subscription') return {
    tone: 'ok', title: '订阅已开通', body: '服务端已确认付款，支付窗口已关闭，正在刷新订阅。',
  }
  if (status === 'success') return {
    tone: 'ok', title: '充值成功', body: '服务端已确认到账，余额已更新。',
  }
  if (status === 'expired') {
    return {
      tone: 'warn',
      title: '支付已超时',
      body: '这笔订单没有付成功，也不会再扣钱。要充值的话重新下一单；如果手机上显示已经扣款，点「查看我的订单」核对。',
    }
  }
  if (status === 'failed') {
    return {
      tone: 'bad',
      title: '支付没有完成',
      body: '支付渠道返回没有付成功。可以重新充值；如果手机上显示已经扣款，点「查看我的订单」核对。',
    }
  }
  if (status === 'unconfirmed') {
    return {
      tone: 'warn',
      title: '还没查到这笔订单到账',
      body: '如果手机上已经显示付款成功，可能是支付渠道慢了，稍后在「我的订单」里看。超过 30 分钟还没到账，请联系客服，并告诉客服订单号。',
    }
  }
  return confirming
    ? {
      tone: 'neutral',
      title: '支付窗口已关闭',
      body: '如果已经付过款，不用做什么：星芒还在确认到账，到了会自动更新余额。还没付的话，这笔订单放着就行，不会扣钱。',
    }
    : {
      tone: 'neutral',
      title: '支付窗口已关闭',
      body: '关闭支付窗口不会取消订单。付过款的话，到账后余额会自动更新，也可以点「查看我的订单」核对。',
    }
}

/** 提示正文：订单号跟在后面；后台还在确认时订单号放在下面那行「正在确认…」里。 */
export function paymentTerminalBody(event: AccountPaymentWindowTerminalEvent, kind: 'topup' | 'subscription' = 'topup'): string {
  const presentation = paymentTerminalPresentation(event.status, event.confirming, kind)
  if (!event.tradeNo) return presentation.body
  if (event.status === 'success' && kind === 'subscription') return `订单 ${event.tradeNo} 已付款，订阅已开通，正在刷新订阅。`
  if (event.status === 'success') return `订单 ${event.tradeNo} 已到账，余额已更新。`
  if (event.status === 'closed' && event.confirming) return presentation.body
  return `${presentation.body} 订单号 ${event.tradeNo}。`
}

/**
 * 订阅开通后，工具那边换没换过去的一句话。星芒账号的订阅不看 Key 在哪个分组，
 * 请求按「扣费偏好」自动先扣订阅，不用换；历史账号的订阅只对订阅分组里的 Key
 * 生效，要把用得上的工具换一把 Key（switched 就是换好的那几个工具的名字）。
 */
export function subscriptionToolsNotice(
  input: { followsPreference: true } | { followsPreference: false; switched: readonly string[] } | { followsPreference: false; error: string },
): { tone: 'ok' | 'warn'; title: string; body: string; action?: 'health' } {
  if (input.followsPreference) return {
    tone: 'ok', title: '工具不用重新设置', body: '工具发出的请求会按「扣费偏好」先用订阅额度。',
  }
  if ('error' in input) return {
    tone: 'warn', title: '订阅已开通，工具还没换过去', body: `${input.error} 可以到「检查」页点「重新写入 Key」再试一次。`, action: 'health',
  }
  if (input.switched.length) return {
    tone: 'ok', title: '工具已改用订阅额度', body: `${input.switched.join('、')} 已换成用这份订阅，不用重新打开设置。`,
  }
  return {
    tone: 'ok', title: '工具不用重新设置', body: '这份订阅对应的工具装好、登录后会自动用订阅额度。',
  }
}

export function validateTopupAmount(value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('充值数量必须是大于 0 的整数。')
  }
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    throw new Error('当前支付渠道的最低充值金额无效。')
  }
  if (value < minimum) {
    throw new Error(`充值数量不能低于 ${minimum}。`)
  }
  return value
}

export { buildTopupBonus, type TopupBonus } from './features/account/topup-bonus'

export function resetTopupQuoteForMethod(
  amount: string,
  method: Pick<PaymentMethod, 'minTopup'>,
  globalMinimum: number,
): { amount: string; quoteInvalidated: true } {
  const minimum = Math.max(globalMinimum, method.minTopup)
  const parsed = Number(amount)
  return {
    amount:
      Number.isSafeInteger(parsed) && parsed >= minimum
        ? amount
        : String(minimum),
    quoteInvalidated: true,
  }
}

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

export function orderStateFor(value: string) {
  return orderStates[value as keyof typeof orderStates] ?? {
    label: '待确认',
    tone: 'neutral' as const,
  }
}
export function subscriptionStateFor(status: string) {
  return Object.hasOwn(subscriptionStates, status)
    ? subscriptionStates[status]
    : { label: '待确认', tone: 'neutral' as const }
}
function PaymentOptions({
  methods,
  value,
  onChange,
}: {
  methods: PaymentMethod[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="支付方式"
      className="v2-business-payments"
    >
      {methods.map((method) => (
        <label
          className={`v2-business-payment${value === method.type ? ' is-selected' : ''}`}
          key={method.type}
        >
          <BrandIcon
            tool={
              method.provider === 'stripe'
                ? 'stripe'
                : /ali/i.test(method.type)
                  ? 'alipay'
                  : /wechat|wxpay/i.test(method.type)
                    ? 'wechat'
                    : method.provider
            }
            size={28}
          />
          <span>
            <strong>{paymentMethodLabel(method)}</strong>
            <small>支付金额以渠道页面为准</small>
          </span>
          <Input
            type="radio"
            aria-label={paymentMethodLabel(method)}
            name="account-payment"
            value={method.type}
            checked={value === method.type}
            onChange={() => onChange(method.type)}
          />
        </label>
      ))}
    </div>
  )
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

/** 页签里一节的小标题（「调用明细」「异步任务」「我的订单」）。 */
function AccountSection({ title, anchor, testId, children }: { title: string; anchor?: string; testId?: string; children: ReactNode }) {
  return (
    <section className="v2-acct-section" data-anchor={anchor} data-testid={testId}>
      <div className="v2-acct-section-head"><h2>{title}</h2></div>
      {children}
    </section>
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
  useRowFocus('account', pageRef, true, (anchor) => {
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
            changed={changed}
          />
        )
      case 'usage':
        // 用量看板、调用明细、异步任务并成一页（v4）：三块原样摆，这一页怎么改版归第 07 批。
        return balance && (
          <>
            {visibleAccountTab('dashboard', session) && <AccountDashboard api={api} balance={balance} session={session} refreshRequest={refresh} />}
            {accountSupports(session, 'supportsUsage') && (
              <AccountSection title="调用明细" testId="account-usage-section">
                <AccountUsage api={api} balance={balance} session={session} refreshRequest={refresh} />
              </AccountSection>
            )}
            {visibleAccountTab('tasks', session) && (
              <AccountSection title="异步任务" anchor="tasks" testId="account-tasks-section">
                <AccountTasks api={api} balance={balance} accountScope={`${origin}:${accountId}`} refreshRequest={refresh} />
              </AccountSection>
            )}
          </>
        )
      case 'keys':
        return balance && site && (
          <AccountKeys
            api={api}
            balance={balance}
            providerBaseUrls={site.providerBaseUrls}
            siteId={accountSiteId(session)}
            keyTools={keyTools}
            onRewriteKey={onRewriteKey}
            onConfigureTool={onConfigureTool}
            onToolConfigSaved={onToolConfigSaved}
            toolConfigConfirmed={toolConfigConfirmed}
            refreshRequest={refresh}
          />
        )
      case 'recharge':
        // 「我的订单」挪到充值订阅下面（v4）；充值这一块怎么改版归第 07 批。
        return (
          <>
            <AccountRecharge
              api={api}
              balance={balance}
              session={session}
              changed={changed}
              refresh={reloadAccount}
              refreshRequest={refresh}
              subscriptionActivated={onSubscriptionActivated}
              subscriptionPurchased={onSubscriptionPurchased}
              openOrders={openOrders}
              openHelp={onOpenHelp}
              openHealth={onOpenHealth}
              presetAmount={rechargeAmount}
              presetRequest={tabRequest}
              shown={(active ?? true) && activeTab === 'recharge'}
            />
            {visibleAccountTab('orders', session) && (
              <AccountSection title="我的订单" anchor="orders" testId="account-orders-section">
                <AccountOrders api={api} paymentReturn={orderRequest} refreshRequest={refresh} />
              </AccountSection>
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
      <ToolKeyLimits api={api} balance={balance} siteId={siteId} refreshRequest={refreshRequest} />
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
const sub2ApiUsageFilterFields: AccountFilterField[] = [
  { key: 'startDate', label: '开始日期', type: 'date' },
  { key: 'endDate', label: '结束日期', type: 'date' },
  { key: 'modelName', label: '模型名称' },
  { key: 'apiKeyId', label: 'Key ID', type: 'number' },
  { key: 'groupId', label: '分组 ID', type: 'number' },
  { key: 'billingType', label: '计费来源', options: [
    { value: '', label: '全部来源' }, { value: '0', label: '账户余额' }, { value: '1', label: '订阅额度' },
  ] },
]
// 筛选第一行常驻的框，其余收进「展开筛选」：表格不被筛选框挤出第一屏。
const usageFilterPrimary = ['start', 'end', 'modelName']
const sub2ApiUsageFilterPrimary = ['startDate', 'endDate', 'modelName']
const taskFilterPrimary = ['start', 'end', 'status']
const pageSizes = [10, 20, 50, 100]
/**
 * 表格下面那一行：翻页，和「20 条 / 页」。一共不超过最小的一档时每页多少条都一样，
 * 整行不出；读不到时也不出（列表那里已经说了没读到）。
 */
function TableFoot({
  label,
  page,
  pageSize,
  total,
  failed,
  onPage,
  onPageSize,
}: {
  label: string
  page: number
  pageSize: number
  total: number
  failed: boolean
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}) {
  if (failed || total <= pageSizes[0]) return null
  return (
    <div className="v2-business-table-foot">
      <Pagination page={page} size={pageSize} total={total} onChange={onPage} />
      <Select
        aria-label={label}
        options={pageSizes.map((size) => ({ value: String(size), label: `${size} 条 / 页` }))}
        value={String(pageSize)}
        onChange={(event) => onPageSize(Number(event.target.value))}
      />
    </div>
  )
}
function AccountUsage({
  api,
  balance,
  session,
  refreshRequest,
}: {
  api: V2Bridge
  balance: Balance
  session: AccountSessionState
  refreshRequest?: number
}) {
  const calendar = accountSiteId(session) === 'solov-api'
  const defaultDates = useMemo(() => usageDateRange({}), [])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [filter, setFilter] = useState<
    Parameters<V2Bridge['getAccountUsage']>[0]
  >(calendar ? defaultDates : {})
  const [selected, setSelected] = useState<Usage | null>(null)
  const load = useCallback(
    () => api.getAccountUsage({ ...filter, page, pageSize }),
    [api, page, pageSize, filter],
  )
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  const failed = Boolean(resource.error) && !resource.loading
  const stats = resource.data?.stats
  return (
    <>
      <AccountFilters
        fields={calendar ? sub2ApiUsageFilterFields : usageFilterFields}
        primary={calendar ? sub2ApiUsageFilterPrimary : usageFilterPrimary}
        initialValues={calendar ? defaultDates : undefined}
        onApply={(values) => {
          if (calendar) {
            const id = (value: string | undefined) => {
              if (!value) return undefined
              const parsed = Number(value)
              if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Key ID 和分组 ID 必须为正整数。')
              return parsed
            }
            setFilter({ ...usageDateRange({ ...values, timezone: defaultDates.timezone }), modelName: values.modelName,
              apiKeyId: id(values.apiKeyId), groupId: id(values.groupId),
              ...(values.billingType === '0' || values.billingType === '1' ? { billingType: Number(values.billingType) as 0 | 1 } : {}) })
            setPage(1)
            return
          }
          setFilter({
            ...accountTimeRange(values.start, values.end),
            modelName: values.modelName,
            group: values.group,
            tokenName: values.tokenName,
            requestId: values.requestId,
            upstreamRequestId: values.upstreamRequestId,
            ...(values.type ? { type: Number(values.type) } : {}),
          })
          setPage(1)
        }}
      />
      {calendar && <p>按整日统计（时区 {defaultDates.timezone}），包含结束日期全天。默认最近 7 个日历日。</p>}
      <Card
        title="调用明细"
        padding="none"
        actions={stats && (
          <span className="v2-business-usage-stats" data-testid="usage-stats">
            消耗 {quotaMoney(stats.quota, balance)} · RPM {stats.rpm} · TPM {stats.tpm}
          </span>
        )}
      >
        {failed ? (
          <ListReadFailure
            page="usage"
            noun="调用明细"
            description={<FailureReason error={resource.error} detail={resource.detail} />}
            retry={() => void resource.reload()}
          />
        ) : (
          <Table
            columns={[
              { key: 'when', label: '时间' },
              { key: 'model', label: '模型 / 分组' },
              { key: 'tokens', label: '输入 / 输出' },
              { key: 'amount', label: '消耗（USD）' },
              { key: 'duration', label: '耗时' },
              { key: 'action', label: '' },
            ]}
            rows={
              resource.data?.records.map((row) => ({
                id: String(row.id),
                when: displayDate(row.createdAt),
                model: (
                  <>
                    {row.modelName}
                    <small>{row.group}</small>
                  </>
                ),
                tokens: `${row.promptTokens} / ${row.completionTokens}`,
                amount: quotaMoney(row.quota, balance),
                duration: `${row.useTimeSeconds} 秒`,
                action: (
                  <Button size="sm" icon={Eye} onClick={() => setSelected(row)}>
                    详情
                  </Button>
                ),
              })) ?? []
            }
            rowKey={(row) => String(row.id)}
            empty={resource.loading ? '正在读取调用明细…' : '暂无调用明细'}
            label="调用明细"
          />
        )}
      </Card>
      <TableFoot
        label="每页日志数量"
        page={page}
        pageSize={pageSize}
        total={resource.data?.total ?? 0}
        failed={failed}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size)
          setPage(1)
        }}
      />
      {selected && <UsageDetails record={selected} balance={balance} onClose={() => setSelected(null)} />}
    </>
  )
}
function AccountDashboard({
  api,
  balance,
  session,
  refreshRequest,
}: {
  api: V2Bridge
  balance: Balance
  session: AccountSessionState
  refreshRequest?: number
}) {
  const supportsTrends = accountSupports(session, 'supportsDashboardTrends')
  const [days, setDays] = useState('7')
  // 每次读都算到「现在」：分页切走再回来、点页头「刷新」，都要看到刚刚的用量。
  const load = useCallback(() => {
    const endTimestamp = Math.floor(Date.now() / 1000)
    return api.getAccountDashboard({ startTimestamp: endTimestamp - Number(days) * 86400, endTimestamp })
  }, [api, days])
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  const failed = Boolean(resource.error) && !resource.loading
  const max = Math.max(
    1,
    ...(resource.data?.buckets.map((bucket) => bucket.quota) ?? []),
  )
  // 大字只放三种：数字、读取中的灰条、读不到时的「—」（下面一行小字说没读到）。
  function stat(title: string, value: string | undefined) {
    return (
      <Card title={title}>
        <strong className="v2-business-amount" title={value === undefined && failed ? '暂时没有读到' : undefined}>
          {value ?? (failed ? '—' : <PlaceholderBar width="4em" />)}
        </strong>
        {value === undefined && failed && <small>暂时没有读到</small>}
      </Card>
    )
  }
  return (
    <>
      <Toolbar
        left={
          supportsTrends ? <Select
            aria-label="统计时间"
            options={[
              { value: '1', label: '最近 24 小时' },
              { value: '7', label: '最近 7 天' },
              { value: '30', label: '最近 30 天' },
            ]}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          /> : <Pill>累计汇总 · 全部时间</Pill>
        }
      />
      {failed && (
        <Notice
          tone="bad"
          title="当前账号的用量暂时没有读到"
          body={<FailureReason error={resource.error} detail={resource.detail} />}
          testId="dashboard-error"
          actions={
            <Button size="sm" icon={RefreshCw} onClick={() => void resource.reload()} testId="dashboard-retry">
              重新加载
            </Button>
          }
        />
      )}
      <div className="v2-business-stat-grid">
        {stat('消耗', resource.data ? quotaMoney(resource.data.quota, balance) : undefined)}
        {stat('请求次数', resource.data?.count.toLocaleString())}
        {stat('Token 数', resource.data?.tokens.toLocaleString())}
      </div>
      {supportsTrends && resource.data?.coverage !== 'all-time-summary' ? <>
      <Card title="用量趋势">
        <div className="v2-business-chart" aria-label="用量趋势">
          {resource.data?.buckets.length ? (
            resource.data.buckets.map((bucket) => (
              <div
                key={bucket.timestamp}
                className="v2-business-chart-column"
                title={`${displayDate(bucket.timestamp)}：${quotaMoney(bucket.quota, balance)}`}
              >
                <div
                  style={{
                    height: `${Math.max(2, (bucket.quota / max) * 100)}%`,
                  }}
                />
                <small>
                  {new Date(bucket.timestamp * 1000).toLocaleDateString(
                    'zh-CN',
                    { month: 'numeric', day: 'numeric' },
                  )}
                </small>
              </div>
            ))
          ) : failed ? (
            <div className="v2-business-chart-empty" data-testid="dashboard-trend-error">
              <p>用量趋势暂时没有读到</p>
              <Button size="sm" icon={RefreshCw} onClick={() => void resource.reload()}>
                重新加载
              </Button>
            </div>
          ) : (
            <div className="v2-business-chart-empty">
              <p>{resource.loading ? '正在读取用量…' : '这个时间段还没有用量'}</p>
            </div>
          )}
        </div>
      </Card>
      <Card padding="none">
        <Table
          columns={[
            { key: 'model', label: '模型' },
            { key: 'count', label: '请求' },
            { key: 'tokens', label: 'Token' },
            { key: 'quota', label: '消耗（USD）' },
          ]}
          rows={
            resource.data?.models.map((row) => ({
              model: row.model,
              count: row.count,
              tokens: row.tokens,
              quota: quotaMoney(row.quota, balance),
            })) ?? []
          }
          rowKey={(row) => String(row.model)}
          empty={resource.loading ? '正在读取模型统计…' : resource.error ? '模型统计读取失败' : '暂无模型统计'}
        />
      </Card>
      </> : <Notice tone="neutral" title="仅提供累计汇总" body="当前客户端尚未接入该账号的趋势和模型统计。此处显示全部时间累计值。" />}
      <ToolUsage api={api} balance={balance} siteId={accountSiteId(session)} refreshRequest={refreshRequest} />
    </>
  )
}
function AccountTasks({
  api,
  balance,
  accountScope,
  refreshRequest,
}: {
  api: V2Bridge
  balance: Balance
  accountScope: string
  refreshRequest?: number
}) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [filter, setFilter] = useState<
    Parameters<V2Bridge['getAccountTasks']>[0]
  >({})
  const [selected, setSelected] = useState<Task | null>(null)
  const operation = useOperation()
  const load = useCallback(
    () => api.getAccountTasks({ ...filter, page, pageSize }),
    [api, page, pageSize, filter],
  )
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  const failed = Boolean(resource.error) && !resource.loading
  const observedStatuses = useRef(new Map<number, string>())
  useEffect(() => {
    for (const task of resource.data?.tasks ?? []) {
      const previous = observedStatuses.current.get(task.id)
      observedStatuses.current.set(task.id, task.status)
      if (previous && previous !== 'SUCCESS' && task.status === 'SUCCESS') {
        void platformApi()
          ?.notifyActivity(
            'task',
            `${accountScope}:${task.id}:${Date.parse(task.finishAt) || 0}`,
          )
          .catch(() => undefined)
      }
    }
    while (observedStatuses.current.size > 200)
      observedStatuses.current.delete(
        observedStatuses.current.keys().next().value!,
      )
  }, [resource.data, accountScope])
  return (
    <>
      <AccountFilters
        fields={taskFilterFields}
        primary={taskFilterPrimary}
        onApply={(values) => {
          setFilter({
            ...accountTimeRange(values.start, values.end),
            platform: values.platform,
            taskId: values.taskId,
            status: values.status,
            action: values.action,
          })
          setPage(1)
        }}
      />
      <ResultNotice {...operation} />
      <Card padding="none">
        {failed ? (
          <ListReadFailure
            page="tasks"
            noun="异步任务"
            description={<FailureReason error={resource.error} detail={resource.detail} />}
            retry={() => void resource.reload()}
          />
        ) : (
          <Table
            columns={[
              { key: 'task', label: '任务' },
              { key: 'model', label: '模型' },
              { key: 'status', label: '状态' },
              { key: 'cost', label: '消耗（USD）' },
              { key: 'action', label: '' },
            ]}
            rows={
              resource.data?.tasks.map((task) => ({
                id: task.id,
                task: task.taskId,
                model: task.originModelName || task.platform,
                status: (
                  <Pill tone={taskStates[task.status]?.tone ?? 'neutral'}>
                    {taskStates[task.status]?.label ?? '待确认'} {task.progress}
                  </Pill>
                ),
                cost: quotaMoney(task.quota, balance),
                action: (
                  <Button size="sm" icon={Eye} onClick={() => setSelected(task)}>
                    详情
                  </Button>
                ),
              })) ?? []
            }
            rowKey={(row) => String(row.id)}
            empty={resource.loading ? '正在读取异步任务…' : '暂无异步任务'}
            label="异步任务"
          />
        )}
      </Card>
      <TableFoot
        label="每页任务数量"
        page={page}
        pageSize={pageSize}
        total={resource.data?.total ?? 0}
        failed={failed}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size)
          setPage(1)
        }}
      />
      <Drawer
        open={Boolean(selected)}
        title="任务详情"
        onClose={() => setSelected(null)}
        footer={
          selected?.resultUrl && (
            <Button
              icon={Copy}
              onClick={() =>
                void operation.execute(
                  'copy-task-result',
                  () => navigator.clipboard.writeText(selected.resultUrl ?? ''),
                  '结果链接已复制',
                )
              }
            >
              复制结果链接
            </Button>
          )
        }
      >
        {selected && (
          <dl className="v2-business-kv">
            <dt>任务编号</dt>
            <dd>{selected.taskId}</dd>
            <dt>创建时间</dt>
            <dd>{displayDate(selected.submitAt)}</dd>
            <dt>完成时间</dt>
            <dd>{displayDate(selected.finishAt)}</dd>
            <dt>操作</dt>
            <dd>{selected.action}</dd>
            <dt>状态</dt>
            <dd>{taskStates[selected.status]?.label ?? '待确认'}</dd>
            <dt>失败原因</dt>
            <dd>{selected.failReason || '无'}</dd>
            <dt>结果链接</dt>
            <dd>{selected.resultUrl || '无'}</dd>
          </dl>
        )}
      </Drawer>
    </>
  )
}
function AccountOrders({
  api,
  paymentReturn,
  refreshRequest,
}: {
  api: V2Bridge
  paymentReturn?: { sequence: number; order: string | null }
  refreshRequest?: number
}) {
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState(paymentReturn?.order ?? '')
  const load = useCallback(
    () => api.getAccountTopupOrders({ page, pageSize: 20, keyword }),
    [api, page, keyword],
  )
  const resource = useResource(load)
  useRefreshRequest(refreshRequest, () => void resource.reload())
  const failed = Boolean(resource.error) && !resource.loading
  useEffect(() => api.onAccountPaymentWindowTerminal((event) => {
    if (event.status === 'success') void resource.reload()
  }), [api, resource.reload])
  useEffect(() => {
    if (!paymentReturn) return
    const order = paymentReturn.order ?? ''
    if (page === 1 && keyword === order) void resource.reload()
    else {
      setKeyword(order)
      setPage(1)
    }
  }, [paymentReturn?.sequence])
  return (
    <>
      <Toolbar
        search={
          <SearchInput
            value={keyword}
            onChange={(value) => {
              setKeyword(value)
              setPage(1)
            }}
            placeholder="搜索订单号"
          />
        }
      />
      <Card padding="none">
        {failed ? (
          <ListReadFailure
            page="orders"
            noun="订单"
            description={<FailureReason error={resource.error} detail={resource.detail} />}
            retry={() => void resource.reload()}
          />
        ) : (
          <Table
            columns={[
              { key: 'trade', label: '订单号' },
              { key: 'amount', label: '充值数量' },
              { key: 'paid', label: '支付金额' },
              { key: 'method', label: '支付方式' },
              { key: 'time', label: '创建时间' },
              { key: 'status', label: '状态' },
            ]}
            rows={
              resource.data?.orders.map((order) => ({
                id: order.id,
                trade: order.tradeNo,
                amount: order.amount,
                paid: order.money.toFixed(2),
                method: paymentMethodLabel({ name: '', type: order.paymentMethod }),
                time: displayDate(order.createdAt),
                status: (
                  <Pill tone={orderStateFor(order.status).tone}>
                    {orderStateFor(order.status).label}
                  </Pill>
                ),
              })) ?? []
            }
            rowKey={(row) => String(row.id)}
            empty={resource.loading ? '正在查询订单…' : '还没有订单'}
            label="我的订单"
          />
        )}
      </Card>
      <Pagination
        page={page}
        total={resource.data?.total ?? 0}
        failed={failed}
        onChange={setPage}
      />
    </>
  )
}
// 切回充值页时，上次读充值信息不到这么久就不重读（见 AccountRecharge 里的说明）。
const rechargeReloadAfterMs = 60_000
function AccountRecharge({
  api,
  balance,
  session,
  changed,
  refresh,
  refreshRequest,
  subscriptionActivated,
  subscriptionPurchased,
  openOrders,
  openHelp,
  openHealth,
  presetAmount,
  presetRequest,
  shown,
}: {
  api: V2Bridge
  /** 余额读不到时为 null：卡头不写「当前余额」，充值照常能用。 */
  balance: Balance | null
  session: AccountSessionState
  changed: () => void
  refresh: () => void
  /** 页头「刷新」点名到这一页时加一。 */
  refreshRequest?: number
  subscriptionActivated?: () => Promise<Provider[]>
  subscriptionPurchased?: () => void
  openOrders?: (order: string | null) => void
  openHelp?: () => void
  /** 去「检查」页；缺省 = 工具没换过去时不给「去检查页」。 */
  openHealth?: () => void
  presetAmount?: number
  presetRequest?: number
  /** 这一页正摆在客户眼前（个人中心在前台、停在「充值与订阅」）；缺省 = 切回来不重读（旧行为）。 */
  shown?: boolean
}) {
  // 充值信息和订阅分开读：订阅那边出错只影响「我的订阅」「选择订阅」两张卡，
  // 读到充值信息就能充值。
  const infoReadAt = useRef(0)
  const loadInfo = useCallback(() => {
    infoReadAt.current = Date.now()
    return api.getAccountTopupInfo()
  }, [api])
  const info = useResource(loadInfo)
  const loadSubscriptions = useCallback(async () => {
    const [plans, subscriptions] = await Promise.all([
      api.getAccountSubscriptionPlans(),
      api.getAccountSubscriptionSelf(),
    ])
    return { plans, subscriptions }
  }, [api])
  const subscriptions = useResource(loadSubscriptions)
  function reloadAll() {
    void info.reload()
    void subscriptions.reload()
  }
  useRefreshRequest(refreshRequest, reloadAll)
  // 档位、赠送、订阅价都在后台改，这一页却会一直挂着：切到别的页只是藏起来、不卸载，点关闭
  // 也只是缩到托盘，客户可能隔几天才回来。所以切回这一页、或者停在这一页的窗口回到前台时
  // 重读一次，摆着的就是后台现在的样子。一分钟内不重读第二次：每读一次，档位的实付都要
  // 逐档再试算一遍，来回点几下就会撞上服务端限流。
  const reloadIfStale = useRef(reloadAll)
  reloadIfStale.current = () => {
    if (Date.now() - infoReadAt.current >= rechargeReloadAfterMs) reloadAll()
  }
  useReloadWhenShown(shown, () => reloadIfStale.current())
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    function foreground() {
      if (shownRef.current && document.visibilityState !== 'hidden') reloadIfStale.current()
    }
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [])
  const operation = useOperation()
  const { offline } = useOnlineStatus()
  const [amount, setAmount] = useState(() => presetAmount ? String(presetAmount) : '10')
  // 已经停在充值页时再从活动卡片点另一档，也要换成那一档。
  useEffect(() => {
    if (!presetAmount) return
    setAmount(String(presetAmount))
    setQuote(null)
  }, [presetAmount, presetRequest])
  const [method, setMethod] = useState('')
  const [code, setCode] = useState('')
  // 报价连同同一时刻读到的折扣一起记：确认框里的「活动赠送」和应付金额出自同一次询问。
  // 折扣为 null = 这次没读到充值信息，确认框不写赠送。
  const [quote, setQuote] = useState<(Awaited<
    ReturnType<V2Bridge['quoteAccountTopupAmount']>
  > & { discounts: Record<string, number> | null }) | null>(null)
  const [purchase, setPurchase] = useState<Plan | null>(null)
  const [purchaseMethod, setPurchaseMethod] = useState('balance')
  const [redeemOpen, setRedeemOpen] = useState(false)
  const [payment, setPayment] = useState<{
    tradeNo: string | null
    kind: 'topup' | 'subscription'
    expiresAt: string | null
  } | null>(null)
  const [paymentTerminal, setPaymentTerminal] =
    useState<(AccountPaymentWindowTerminalEvent & { kind: 'topup' | 'subscription' }) | null>(null)
  const [subscriptionTools, setSubscriptionTools] = useState<ReturnType<typeof subscriptionToolsNotice> | null>(null)
  // 订阅开通（在线付款到账、兑换码兑成订阅）之后调一次。星芒账号不用换工具，只说一句；
  // 历史账号把用得上这份订阅的工具换一把放在订阅分组里的 Key。
  function applySubscriptionToTools() {
    subscriptionPurchased?.()
    if (accountSupports(session, 'supportsSubscriptionPreference')) {
      setSubscriptionTools(subscriptionToolsNotice({ followsPreference: true }))
      return
    }
    if (!subscriptionActivated) return
    setSubscriptionTools({ tone: 'ok', title: '正在把工具换成订阅额度', body: '换好之前工具照常能用。' })
    subscriptionActivated().then(
      (switched) => setSubscriptionTools(subscriptionToolsNotice({ followsPreference: false, switched: switched.map(keyToolName) })),
      (error: unknown) => setSubscriptionTools(subscriptionToolsNotice({ followsPreference: false, error: errorMessage(error, '工具这次没有换成功。') })),
    )
  }
  const applySubscriptionRef = useRef(applySubscriptionToTools)
  applySubscriptionRef.current = applySubscriptionToTools
  const paymentRef = useRef(payment)
  const openingPayment = useRef<AccountPaymentWindowTerminalEvent[] | null>(null)
  // 窗口关了、主进程还在后台确认的那笔订单号。结果晚到时即使提示已经收起，也要把结果摆出来。
  const followUp = useRef<{ tradeNo: string; kind: 'topup' | 'subscription' } | null>(null)
  const acceptPaymentTerminal = (event: AccountPaymentWindowTerminalEvent) => {
    const current = paymentRef.current
    if (!current) {
      const pending = followUp.current
      if (!pending || !event.tradeNo || event.tradeNo !== pending.tradeNo || event.status === 'closed') return
      followUp.current = null
      setPaymentTerminal({ ...event, kind: pending.kind })
      changed()
      reloadAll()
      if (event.status === 'success' && pending.kind === 'subscription') applySubscriptionRef.current()
      return
    }
    if (event.status === 'success' && (!event.tradeNo || event.tradeNo !== current.tradeNo)) return
    if (event.tradeNo && current.tradeNo && event.tradeNo !== current.tradeNo) return
    paymentRef.current = null
    followUp.current = event.status === 'closed' && event.confirming && event.tradeNo ? { tradeNo: event.tradeNo, kind: current.kind } : null
    setPayment(null)
    setPaymentTerminal({ ...event, kind: current.kind })
    changed()
    reloadAll()
    if (event.status === 'success' && current.kind === 'subscription') applySubscriptionRef.current()
  }
  // 支付回调是一次性事件：退订与重订之间到达的那一条没有人接，订单就此丢在
  // 「等待支付结果」上。`changed` 由 AccountPage 每次渲染新建，再上一层 App.tsx 传的
  // `onAccountChanged` 同样是行内箭头，所以把 `changed` 包成 useCallback 也挡不住
  // ——余额 store 每 30 秒 publish 一次就会重订一次。改成让订阅只依赖 `api`，回调
  // 本身从 ref 取最新的一份（与本文件 refreshGroupsRef 同一写法）。
  const acceptPaymentTerminalRef = useRef(acceptPaymentTerminal)
  acceptPaymentTerminalRef.current = acceptPaymentTerminal
  function paymentOpened(result: NonNullable<typeof payment>) {
    const buffered = openingPayment.current ?? []
    openingPayment.current = null
    paymentRef.current = result
    followUp.current = null
    setPaymentTerminal(null)
    setSubscriptionTools(null)
    setPayment(result)
    for (const event of buffered) acceptPaymentTerminal(event)
  }
  useEffect(() => {
    const available = info.data?.paymentMethods ?? []
    setMethod((current) =>
      available.some((item) => item.type === current)
        ? current
        : available[0]?.type ?? '',
    )
  }, [info.data?.paymentMethods])
  useEffect(
    () =>
      api.onAccountPaymentWindowTerminal((event) => {
        if (openingPayment.current) {
          if (openingPayment.current.length < 8) openingPayment.current.push(event)
          return
        }
        acceptPaymentTerminalRef.current(event)
      }),
    [api],
  )
  const methods = info.data?.paymentMethods ?? []
  const paymentMethod =
    methods.find((item) => item.type === method) ?? methods[0]
  const topupMinimum = Math.max(
    info.data?.minTopup ?? 1,
    paymentMethod?.minTopup ?? 0,
  )
  const presetAmounts = info.data?.amountOptions ?? [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
  const customAmount = isQuotableAmount(Number(amount), topupMinimum) ? Number(amount) : null
  const quoting = Boolean(info.data && paymentMethod) && !offline
  const tierQuotes = useTopupQuotes({
    quote: async (value) => (await api.quoteAccountTopupAmount({ amount: value })).payableAmount,
    presets: presetAmounts,
    custom: customAmount,
    enabled: quoting,
    resetKey: info.data,
  })
  function tierView(value: number) {
    const state = tierQuotes.get(value)
    return describeTopupTier({
      amount: value,
      // 算不了（断网、没有支付渠道）就不写「实付」；已经算好的照旧写。
      quote: typeof state === 'number' || quoting ? state : 'unavailable',
      discounts: info.data?.discounts,
      provider: paymentMethod?.provider,
      creditMultiplier: info.data?.creditMultiplier,
    })
  }
  const customTier = customAmount === null ? null : tierView(customAmount)
  const quoteBonus = quote?.discounts ? buildTopupBonus(quote.amount, quote.discounts) : null
  const quoteTopup = () =>
    void operation.execute(
      'quote',
      async () => {
        if (offline) throw new Error(offlineActionMessage)
        const value = validateTopupAmount(Number(amount), topupMinimum)
        if (!paymentMethod) throw new Error('暂时没有可用的支付渠道。')
        // 页面可能摆了很久，活动早就撤了或改了：充值信息和报价一起重新问，确认框写的赠送、
        // 卡片上的档位都按这一刻的来。充值信息这次没读到就不写赠送，不报一个可能已经没有的赠送。
        const [fresh, next] = await Promise.all([
          api.getAccountTopupInfo().catch(() => null),
          api.quoteAccountTopupAmount({ amount: value }),
        ])
        if (fresh && !sameTopupInfo(info.data, fresh)) info.setData(fresh)
        setQuote({ ...next, discounts: fresh?.discounts ?? null })
      },
      '',
    )
  const pay = () => {
    if (!quote || !paymentMethod) return
    void operation.execute(
      'payment',
      async () => {
        openingPayment.current = []
        try {
          const result = await api.createAccountTopupPayment({
            amount: quote.amount,
            paymentMethod: paymentMethod.type,
          })
          paymentOpened({ ...result, kind: 'topup', expiresAt: null })
        } finally { openingPayment.current = null }
        setQuote(null)
      },
      '',
    )
  }
  const purchasePlan = () => {
    if (!purchase) return
    void operation.execute(
      'subscribe',
      async () => {
        if (purchaseMethod === 'balance') {
          if (!accountSupports(session, 'supportsSubscriptionBalancePurchase')) throw new Error('当前账号暂不支持余额购买订阅。')
          await api.purchaseAccountSubscriptionWithBalance(purchase.id)
        } else {
          if (!accountSupports(session, 'supportsSubscriptionPayment')) throw new Error('当前账号暂不支持客户端购买订阅。')
          const payMethod = methods.find((item) => item.type === purchaseMethod)
          if (!payMethod || payMethod.provider === 'waffo')
            throw new Error('该支付渠道暂不支持订阅。')
          openingPayment.current = []
          try {
            const result = await api.createAccountSubscriptionPayment(
              buildSubscriptionPaymentInput(purchase.id, payMethod),
            )
            paymentOpened({ ...result, kind: 'subscription' })
          } finally { openingPayment.current = null }
        }
        setPurchase(null)
        await subscriptions.reload()
        changed()
        if (purchaseMethod === 'balance') applySubscriptionToTools()
      },
      purchaseMethod === 'balance'
        ? '订阅购买完成'
        : '支付窗口已打开，请在支付后刷新订阅',
    )
  }
  // 读不到就说读不到，手上有旧的一份也一样（同各页列表）：付完款再读订阅没成，不能还摆着「还没有订阅」。
  const infoFailed = Boolean(info.error) && !info.loading
  const noMethods = Boolean(info.data) && methods.length === 0
  const subscriptionsFailed = Boolean(subscriptions.error) && !subscriptions.loading
  return (
    <>
      <ResultNotice
        error={operation.error}
        detail={operation.detail}
        message={payment || paymentTerminal ? '' : operation.message}
      />
      <div className="v2-business-recharge-grid">
        <Card
          title="充值到账户余额"
          meta={balance ? `当前余额 ${dollars(balance.displayAmount)}` : undefined}
        >
          {infoFailed ? (
            <Empty
              testId="account-recharge-error"
              icon={XCircle}
              title="充值信息暂时没有读到"
              description={offline ? '现在连不上网，联网后点「重新加载」。' : <FailureReason error={info.error} detail={info.detail} />}
              action={
                <>
                  <Button size="sm" icon={RefreshCw} onClick={() => void info.reload()} testId="account-recharge-retry">
                    重新加载
                  </Button>
                  {openHelp && (
                    <Button size="sm" icon={HelpCircle} onClick={openHelp} testId="account-recharge-support">
                      联系客服
                    </Button>
                  )}
                </>
              }
            />
          ) : !info.data ? (
            <Skeleton rows={8} testId="account-recharge-loading" />
          ) : (
            <>
              {noMethods && (
                <Notice
                  tone="neutral"
                  title="暂时没有可用的支付渠道"
                  body="请稍后重试或联系客服。有充值码的话，可以在右边兑换。"
                  testId="account-recharge-no-methods"
                  actions={openHelp && (
                    <Button size="sm" icon={HelpCircle} onClick={openHelp}>
                      联系客服
                    </Button>
                  )}
                />
              )}
              {/* 没有支付渠道时档位、金额和「充值」整块变灰，点不了。 */}
              <fieldset className="v2-business-recharge-form" disabled={noMethods}>
                <div className="v2-business-suggestions-label">快捷金额</div>
                <div className="v2-business-suggestions">
                  {presetAmounts.map((value) => {
                    const tier = tierView(value)
                    const selected = Number(amount) === value
                    return (
                      <button
                        type="button"
                        key={value}
                        className={`v2-business-tier${selected ? ' is-selected' : ''}`}
                        aria-label={tier.label}
                        aria-pressed={selected}
                        onClick={() => { setAmount(String(value)); setQuote(null) }}
                      >
                        <span className="v2-business-tier-credited">到账 {tier.credited}</span>
                        {tier.paid !== null ? (
                          <span className="v2-business-tier-paid">实付 {tier.paid}</span>
                        ) : tier.quoting && (
                          <span className="v2-business-placeholder v2-business-tier-paid" aria-hidden="true" />
                        )}
                        {tier.bonus && <span className="v2-business-tier-bonus">{tier.bonus}</span>}
                      </button>
                    )
                  })}
                </div>
                <Input
                  label="自定义金额"
                  type="number"
                  min={topupMinimum}
                  step="1"
                  inputMode="numeric"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value)
                    setQuote(null)
                  }}
                />
                {customTier && (
                  <p className="v2-business-tier-note" data-testid="account-recharge-breakdown">
                    <span>到账 <strong>{customTier.credited}</strong></span>
                    {customTier.paid !== null ? (
                      <span>实付 <strong>{customTier.paid}</strong></span>
                    ) : customTier.quoting && <PlaceholderBar width="5em" />}
                    {customTier.bonus && <span className="has-bonus">{customTier.bonus}</span>}
                  </p>
                )}
                {/* 一个渠道都没有时上面那条提示已经说了，这里不留一块空的选择区。 */}
                {methods.length > 0 && (
                  <PaymentOptions
                    methods={methods}
                    value={paymentMethod?.type ?? ''}
                    onChange={(next) => {
                      const nextMethod = methods.find((item) => item.type === next)
                      setMethod(next)
                      setQuote(null)
                      if (nextMethod) {
                        setAmount(
                          resetTopupQuoteForMethod(amount, nextMethod, info.data?.minTopup ?? 1).amount,
                        )
                      }
                    }}
                  />
                )}
                <Button
                  variant="balance"
                  icon={CreditCard}
                  disabled={!paymentMethod || info.loading || Boolean(payment)}
                  loading={operation.busy === 'quote'}
                  onClick={quoteTopup}
                  testId="account-recharge-submit"
                >
                  充值
                </Button>
              </fieldset>
            </>
          )}
        </Card>
        <Card title="兑换充值码">
          <div className="v2-business-redeem">
            <Input
              label="充值码"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
            />
            <Button
              icon={Zap}
              disabled={
                !code.trim() || info.data?.redemptionEnabled === false
              }
              onClick={() => {
                // 断网时在这里就说，不先弹「确认兑换」再等请求超时。
                if (offline) void operation.execute('redeem', () => Promise.reject(new Error(offlineActionMessage)))
                else setRedeemOpen(true)
              }}
              testId="account-redeem"
            >
              兑换
            </Button>
          </div>
          <p>兑换成功后，余额和权益会自动更新。</p>
        </Card>
      </div>
      {(payment || paymentTerminal) && (
        <Notice
          tone={paymentTerminal ? paymentTerminalPresentation(paymentTerminal.status, paymentTerminal.confirming, paymentTerminal.kind).tone : 'neutral'}
          title={paymentTerminal ? paymentTerminalPresentation(paymentTerminal.status, paymentTerminal.confirming, paymentTerminal.kind).title : '等待支付结果'}
          body={paymentTerminal
            ? <>
              {paymentTerminalBody(paymentTerminal, paymentTerminal.kind)}
              {paymentTerminal.status === 'closed' && paymentTerminal.confirming && paymentTerminal.tradeNo && (
                <small className="v2-business-payment-confirming">正在确认订单 {paymentTerminal.tradeNo} 是否到账…</small>
              )}
            </>
            : payment?.kind === 'subscription'
              ? `订阅订单 ${payment.tradeNo || '待生成'}。付款后会自动关闭支付窗口并刷新订阅。`
              : `订单 ${payment?.tradeNo || '待生成'}。到账后将自动关闭支付窗口并刷新余额。`}
          testId="account-payment-notice"
          actions={
            <>
              {(!paymentTerminal || paymentTerminal.status === 'success') && (
                <Button
                  size="sm"
                  icon={RefreshCw}
                  onClick={() => {
                    refresh()
                    void subscriptions.reload()
                  }}
                >
                  刷新余额与订阅
                </Button>
              )}
              {paymentTerminal && paymentTerminal.status !== 'success' && openOrders && (
                <Button size="sm" onClick={() => openOrders(paymentTerminal.tradeNo)} testId="account-payment-orders">
                  查看我的订单
                </Button>
              )}
              {paymentTerminal?.status === 'unconfirmed' && openHelp && (
                <Button size="sm" icon={HelpCircle} onClick={openHelp}>
                  联系客服
                </Button>
              )}
              {payment ? (
                <Button
                  size="sm"
                  onClick={() =>
                    void operation.execute(
                      'close-payment',
                      async () => {
                        await api.closeAccountPaymentWindow()
                        paymentRef.current = null
                        setPayment(null)
                      },
                      '',
                    )
                  }
                >
                  关闭支付窗口
                </Button>
              ) : (
                <Button size="sm" onClick={() => setPaymentTerminal(null)}>
                  收起提示
                </Button>
              )}
            </>
          }
        />
      )}
      {subscriptionTools && (
        <Notice
          tone={subscriptionTools.tone}
          title={subscriptionTools.title}
          body={subscriptionTools.body}
          actions={
            <>
              {subscriptionTools.action === 'health' && openHealth && (
                <Button size="sm" onClick={openHealth} testId="account-subscription-health">
                  去检查页
                </Button>
              )}
              <Button size="sm" onClick={() => setSubscriptionTools(null)}>收起提示</Button>
            </>
          }
        />
      )}
      <Card title="我的订阅">
        {subscriptionsFailed ? (
          <ListReadFailure
            page="account-subscriptions"
            noun="订阅信息"
            description={<FailureReason error={subscriptions.error} detail={subscriptions.detail} />}
            retry={() => void subscriptions.reload()}
          />
        ) : (
          <>
            {accountSupports(session, 'supportsSubscriptionPreference') && <SettingRow
              title="扣费偏好"
              description="决定请求优先使用订阅还是账户余额"
              control={
                <Select
                  aria-label="扣费偏好"
                  options={billingOptions}
                  disabled={!subscriptions.data}
                  value={
                    subscriptions.data?.subscriptions.billingPreference ??
                    'subscription_first'
                  }
                  onChange={(event) => {
                    const preference = event.target.value
                    if (
                      preference === 'subscription_first' ||
                      preference === 'wallet_first' ||
                      preference === 'subscription_only' ||
                      preference === 'wallet_only'
                    )
                      void operation.execute(
                        'preference',
                        async () => {
                          await api.updateAccountSubscriptionPreference(preference)
                          await subscriptions.reload()
                        },
                        '扣费偏好已保存',
                      )
                  }}
                />
              }
            />}
            {subscriptions.data?.subscriptions.allSubscriptions.length ? (
              subscriptions.data.subscriptions.allSubscriptions.map((subscription) => (
                <ListRow
                  key={subscription.id}
                  icon={Zap}
                  title={
                    subscription.groupName || (subscription.source === 'sub2api' ? `订阅分组 ${subscription.planId}` : subscriptions.data?.plans.find(
                      (plan) => plan.id === subscription.planId,
                    )?.title ?? `订阅 ${subscription.planId}`)
                  }
                  badge={
                    <Pill tone={subscriptionStateFor(subscription.status).tone}>
                      {subscriptionStateFor(subscription.status).label}
                    </Pill>
                  }
                  desc={subscription.quotaPeriods ? <>
                    {subscription.quotaPeriods.map((period) => <span key={period.period} style={{ display: 'block' }}>
                      {{ daily: '日额度', weekly: '周额度', monthly: '月额度' }[period.period]}：
                      已用 {quotaMoney(period.used, balance)} · {period.limitState === 'unlimited' ? '不限额'
                        : period.limitState === 'unknown' ? '限额暂未提供'
                        : `限额 ${quotaMoney(period.limit, balance)} · 剩余 ${quotaMoney(period.used === null ? null : Math.max(0, period.limit! - period.used), balance)}`}
                    </span>)}
                    <span>到期 {displayDate(subscription.endsAt)}</span>
                  </> : `剩余 ${quotaMoney(subscription.amountTotal === null || subscription.amountUsed === null ? null : Math.max(0, subscription.amountTotal - subscription.amountUsed), balance)} · 到期 ${displayDate(subscription.endsAt)}`}
                />
              ))
            ) : (
              <p>{subscriptions.loading ? '正在读取订阅…' : '还没有订阅'}</p>
            )}
          </>
        )}
      </Card>
      {!subscriptionsFailed && <Card title="选择订阅">
        {!accountSupports(session, 'supportsSubscriptionPayment') && !accountSupports(session, 'supportsSubscriptionBalancePurchase') &&
          <Notice tone="neutral" title="订阅仅供查看" body="该账号的订阅购买与扣费规则请在官方网站管理。" />}
        {subscriptions.data?.plans.map((plan) => (
          <ListRow
            key={plan.id}
            icon={Zap}
            title={plan.title}
            desc={plan.subtitle}
            meta={`${plan.currency} ${plan.priceAmount.toFixed(2)}`}
            actions={
              (accountSupports(session, 'supportsSubscriptionPayment') || (plan.allowBalancePay && accountSupports(session, 'supportsSubscriptionBalancePurchase'))) && <Button
                icon={CreditCard}
                size="sm"
                onClick={() => {
                  setPurchase(plan)
                  setPurchaseMethod(
                    plan.allowBalancePay
                      ? 'balance'
                        : (subscriptionPaymentMethods(plan, methods, info.data ?? undefined)[0]?.type ??
                            ''),
                  )
                }}
              >
                购买
              </Button>
            }
          />
        ))}
      </Card>}
      <Dialog
        open={Boolean(quote)}
        title="确认充值报价"
        onClose={() => setQuote(null)}
        footer={
          <>
            <Button onClick={() => setQuote(null)}>取消</Button>
            <Button
              variant="balance"
              icon={CreditCard}
              loading={operation.busy === 'payment'}
              onClick={pay}
            >
              打开支付窗口
            </Button>
          </>
        }
      >
        <p>充值数量：{quote?.amount}</p>
        {quoteBonus && (
          <p data-testid="account-recharge-quote-bonus">
            活动赠送：{quoteBonus.bonus}（多送 {quoteBonus.percent}%），到账 {quote?.amount}
          </p>
        )}
        <p>
          应付金额：{quote?.payableAmount.toFixed(2)}
          （支付渠道币种以支付页面为准）
        </p>
        <p>支付方式：{paymentMethod ? paymentMethodLabel(paymentMethod) : ''}</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
      <Dialog
        open={redeemOpen}
        title="确认兑换到当前账号？"
        onClose={() => setRedeemOpen(false)}
        footer={
          <>
            <Button onClick={() => setRedeemOpen(false)}>取消</Button>
            <Button
              variant="primary"
              icon={Zap}
              loading={operation.busy === 'redeem'}
              onClick={() =>
                void operation.execute(
                  'redeem',
                  async () => {
                    const result = await api.redeemAccountTopupCode(code.trim())
                    setCode('')
                    setRedeemOpen(false)
                    changed()
                    void info.reload()
                    await subscriptions.reload()
                    if (result.type === 'subscription') applySubscriptionToTools()
                    return result.type
                  },
                  (type) => type === 'subscription' ? '订阅兑换成功'
                    : type === 'concurrency' ? '并发额度兑换成功' : '余额兑换成功',
                )
              }
            >
              确认兑换
            </Button>
          </>
        }
      >
        <p>兑换成功后，相应余额或权益会应用到当前账号。</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
      <Dialog
        open={Boolean(purchase)}
        title={`购买 ${purchase?.title ?? '订阅'}`}
        onClose={() => setPurchase(null)}
        footer={
          <>
            <Button onClick={() => setPurchase(null)}>取消</Button>
            <Button
              variant="balance"
              icon={CreditCard}
              loading={operation.busy === 'subscribe'}
              disabled={!purchaseMethod}
              onClick={purchasePlan}
            >
              {purchaseMethod === 'balance' ? '确认购买' : '打开支付窗口'}
            </Button>
          </>
        }
      >
        <p>
          {purchase?.currency} {purchase?.priceAmount.toFixed(2)}
        </p>
        <Select
          aria-label="订阅支付方式"
          options={[
            ...(purchase?.allowBalancePay
              ? [{ value: 'balance', label: '账户余额' }]
              : []),
            ...(purchase
              ? subscriptionPaymentMethods(purchase, methods, info.data ?? undefined)
              : []
            ).map((item) => ({ value: item.type, label: item.name })),
          ]}
          value={purchaseMethod}
          onChange={(event) => setPurchaseMethod(event.target.value)}
        />
        <ResultNotice error={operation.error} detail={operation.detail} />
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

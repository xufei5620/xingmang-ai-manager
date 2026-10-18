import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CreditCard, Gift, HelpCircle, Info, RefreshCw, TriangleAlert, Wallet, X, XCircle, Zap } from 'lucide-react'
import {
  BrandIcon,
  Button,
  Card,
  Dialog,
  Empty,
  Input,
  ListRow,
  Notice,
  Pill,
  SearchInput,
  Segment,
  Skeleton,
} from '../../ui'
import {
  displayDate,
  dollars,
  errorMessage,
  FailureReason,
  ListReadFailure,
  Pagination,
  PlaceholderBar,
  quotaMoney,
  RelativeTime,
  ResultNotice,
  useOperation,
  useRefreshRequest,
  useReloadWhenShown,
  useResource,
} from '../../business-common'
import { billingOptions } from '../../registry/business'
import { accountSupports } from '../../account-context'
import type { V2Bridge } from '../../types'
import type {
  AccountBalance,
  AccountPaymentWindowTerminalEvent,
  AccountSessionState,
  AccountSubscriptionBillingPreference,
  AccountSubscriptionPlan,
  AccountTopupAmountQuote,
  AccountTopupInfo,
} from '../../../../electron/ipc-contract'
import { buildBalanceRunway } from '../app/balance-runway'
import { offlineActionMessage } from '../shell/online-status'
import { useOnlineStatus } from '../shell/useOnlineStatus'
import type { AccountSummary } from './AccountOverview'
import { shortDate } from './account-center'
import { paymentMethodLabel } from './payment-method-label'
import { creditedMoney, describeTopupTier, isQuotableAmount, payableSymbol, sameTopupInfo, useTopupQuotes } from './topup-tier'
import {
  balancePurchaseLine,
  billingPreferenceNote,
  buildSubscriptionPaymentInput,
  orderPaidText,
  ordersSearchEmpty,
  orderStateFor,
  orderTail,
  orderTitle,
  paymentTerminalBody,
  paymentTerminalPresentation,
  planDurationText,
  planPriceText,
  planSubscription,
  planTermText,
  planUsageText,
  rechargeRunwayText,
  redeemSuccessText,
  resetTopupQuoteForMethod,
  subscriptionPaymentMethods,
  subscriptionStateFor,
  subscriptionToolsNotice,
  topupAmountError,
  topupCreditedUsd,
  topupGift,
  validateTopupAmount,
  type PaymentKind,
} from './recharge'

type PaymentMethod = AccountTopupInfo['paymentMethods'][number]
type Plan = AccountSubscriptionPlan

/** 正在等结果的那一笔：右栏「等待支付结果」要的几样，下单那一刻记下来（金额、到账或开通什么、怎么付）。 */
interface PendingPayment {
  tradeNo: string | null
  kind: PaymentKind
  expiresAt: string | null
  amount: string
  detail: string
  method: string
  planName: string | null
}
type PaymentTerminal = AccountPaymentWindowTerminalEvent & { kind: PaymentKind; planName: string | null }

function paymentBrand(method: Pick<PaymentMethod, 'provider' | 'type'>) {
  return method.provider === 'stripe'
    ? 'stripe'
    : /ali/i.test(method.type)
      ? 'alipay'
      : /wechat|wxpay/i.test(method.type)
        ? 'wechat'
        : method.provider
}

interface PayChoice {
  value: string
  label: string
  description: ReactNode
  leading: ReactNode
  disabled?: boolean
}

/** 付款方式的单选卡（充值表单两列、买套餐弹窗一列）：一个圆点、渠道标志、名字和下面一句小字。 */
function PayChoices({ name, choices, value, onChange, stacked }: { name: string; choices: PayChoice[]; value: string; onChange: (value: string) => void; stacked?: boolean }) {
  return (
    <div role="radiogroup" aria-label="支付方式" className={`v2-recharge-pay${stacked ? ' is-stacked' : ''}`}>
      {choices.map((choice) => (
        <label className={`v2-recharge-pay-option${value === choice.value ? ' is-selected' : ''}${choice.disabled ? ' is-disabled' : ''}`} key={choice.value}>
          <input
            type="radio"
            aria-label={choice.label}
            name={name}
            value={choice.value}
            checked={value === choice.value}
            disabled={choice.disabled}
            onChange={() => onChange(choice.value)}
          />
          <span className="v2-recharge-radio" aria-hidden="true" />
          <span className="v2-recharge-pay-icon" aria-hidden="true">{choice.leading}</span>
          <span className="v2-recharge-pay-copy">
            <strong>{choice.label}</strong>
            <small>{choice.description}</small>
          </span>
        </label>
      ))}
    </div>
  )
}

function channelChoice(method: PaymentMethod): PayChoice {
  return {
    value: method.type,
    label: paymentMethodLabel(method),
    description: '支付金额以渠道页面为准',
    leading: <BrandIcon tool={paymentBrand(method)} size={22} />,
  }
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return <div className="v2-acct-kv" data-testid={testId}><span>{label}</span>{children}</div>
}

// 切回充值页时，上次读充值信息不到这么久就不重读（见 AccountRecharge 里的说明）。
const rechargeReloadAfterMs = 60_000
const resultIcons = { ok: Check, warn: TriangleAlert, bad: X, neutral: Info } as const

export function AccountRecharge({
  api,
  balance,
  session,
  summary,
  changed,
  refresh,
  refreshRequest,
  subscriptionActivated,
  subscriptionPurchased,
  openOrders,
  openHelp,
  openHealth,
  onPaymentChange,
  presetAmount,
  presetRequest,
  shown,
}: {
  api: V2Bridge
  /** 余额读不到时为 null：卡头不写「当前余额」，右栏不写「充值后余额」，充值照常能用。 */
  balance: AccountBalance | null
  session: AccountSessionState
  /** 和首页同源的近 7 天花费、能扣的订阅：右栏「按最近用量」据此算；缺省 = 不写那一行。 */
  summary?: AccountSummary
  changed: () => void
  refresh: () => void
  /** 页头「刷新」点名到这一页时加一。 */
  refreshRequest?: number
  /** 历史账号订阅开通后把工具换过去，返回换好的工具名；缺省 = 不换（旧行为）。 */
  subscriptionActivated?: () => Promise<string[]>
  subscriptionPurchased?: () => void
  openOrders?: (order: string | null) => void
  openHelp?: () => void
  /** 去「检查」页；缺省 = 工具没换过去时不给「去检查页」。 */
  openHealth?: () => void
  /** 支付窗口开着的那一单（没有为 null）：「我的订单」那一行据此写「支付窗口开着」。 */
  onPaymentChange?: (tradeNo: string | null) => void
  presetAmount?: number
  presetRequest?: number
  /** 这一页正摆在客户眼前（个人中心在前台、停在「充值与订阅」）；缺省 = 切回来不重读（旧行为）。 */
  shown?: boolean
}) {
  // 充值信息和订阅分开读：订阅那边出错只影响「我的订阅」「订阅套餐」「扣费顺序」，
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
  // 选中的快捷金额，和自定义金额框里填的字。框里有字就按框里的算，清空了回到选中的那一档（同原型）。
  const [presetValue, setPresetValue] = useState(() => presetAmount || 10)
  const [custom, setCustom] = useState('')
  // 已经停在充值页时再从活动卡片点另一档，也要换成那一档。
  useEffect(() => {
    if (!presetAmount) return
    setPresetValue(presetAmount)
    setCustom('')
    dropQuote()
  }, [presetAmount, presetRequest])
  const [method, setMethod] = useState('')
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  // 报价连同同一时刻读到的优惠一起记：确认框里的「其中活动赠送」和应付金额出自同一次询问。
  // offer 为 null = 这次没读到充值信息，确认框不写赠送，不报一个可能已经没有的赠送。
  const [quote, setQuote] = useState<(AccountTopupAmountQuote & {
    offer: Pick<AccountTopupInfo, 'discounts' | 'creditMultiplier'> | null
  }) | null>(null)
  // 每问一次价加一，换档位、金额、渠道也加一：问价途中金额被换掉（停在这页时从活动卡片又点了
  // 一档），回来的那次报价按的是旧金额，不认它，不然确认框和付款都照旧金额走。
  const quoteRequest = useRef(0)
  function dropQuote() {
    quoteRequest.current += 1
    setQuote(null)
  }
  const [purchase, setPurchase] = useState<Plan | null>(null)
  const [purchaseMethod, setPurchaseMethod] = useState('balance')
  const [redeemOpen, setRedeemOpen] = useState(false)
  const [payment, setPayment] = useState<PendingPayment | null>(null)
  const [paymentTerminal, setPaymentTerminal] = useState<PaymentTerminal | null>(null)
  const [subscriptionTools, setSubscriptionTools] = useState<ReturnType<typeof subscriptionToolsNotice> | null>(null)
  const paymentChange = useRef(onPaymentChange)
  paymentChange.current = onPaymentChange
  const openTradeNo = payment?.tradeNo ?? null
  const paymentOpen = Boolean(payment)
  useEffect(() => { paymentChange.current?.(paymentOpen ? openTradeNo : null) }, [openTradeNo, paymentOpen])
  const activated = useRef(subscriptionActivated)
  activated.current = subscriptionActivated
  // 订阅开通（在线付款到账、余额买、兑换码兑成订阅）之后调一次。星芒账号不用换工具，只说一句；
  // 历史账号把用得上这份订阅的工具换一把放在订阅分组里的 Key。
  function applySubscriptionToTools() {
    subscriptionPurchased?.()
    if (accountSupports(session, 'supportsSubscriptionPreference')) {
      setSubscriptionTools(subscriptionToolsNotice({ followsPreference: true }))
      return
    }
    const activate = activated.current
    if (!activate) return
    setSubscriptionTools({ tone: 'ok', title: '正在把工具换成订阅额度', body: '换好之前工具照常能用。' })
    activate().then(
      (switched) => setSubscriptionTools(subscriptionToolsNotice({ followsPreference: false, switched })),
      (error: unknown) => setSubscriptionTools(subscriptionToolsNotice({ followsPreference: false, error: errorMessage(error, '工具这次没有换成功。') })),
    )
  }
  const applySubscriptionRef = useRef(applySubscriptionToTools)
  applySubscriptionRef.current = applySubscriptionToTools
  const paymentRef = useRef(payment)
  const openingPayment = useRef<AccountPaymentWindowTerminalEvent[] | null>(null)
  // 窗口关了、主进程还在后台确认的那笔订单号。结果晚到时即使提示已经收起，也要把结果摆出来。
  const followUp = useRef<{ tradeNo: string; kind: PaymentKind; planName: string | null } | null>(null)
  const acceptPaymentTerminal = (event: AccountPaymentWindowTerminalEvent) => {
    const current = paymentRef.current
    if (!current) {
      const pending = followUp.current
      if (!pending || !event.tradeNo || event.tradeNo !== pending.tradeNo || event.status === 'closed') return
      followUp.current = null
      setPaymentTerminal({ ...event, kind: pending.kind, planName: pending.planName })
      changed()
      reloadAll()
      if (event.status === 'success' && pending.kind === 'subscription') applySubscriptionRef.current()
      return
    }
    if (event.status === 'success' && (!event.tradeNo || event.tradeNo !== current.tradeNo)) return
    if (event.tradeNo && current.tradeNo && event.tradeNo !== current.tradeNo) return
    paymentRef.current = null
    followUp.current = event.status === 'closed' && event.confirming && event.tradeNo
      ? { tradeNo: event.tradeNo, kind: current.kind, planName: current.planName }
      : null
    setPayment(null)
    setPaymentTerminal({ ...event, kind: current.kind, planName: current.planName })
    changed()
    reloadAll()
    if (event.status === 'success' && current.kind === 'subscription') applySubscriptionRef.current()
  }
  // 支付回调是一次性事件：退订与重订之间到达的那一条没有人接，订单就此丢在
  // 「等待支付结果」上。`changed` 由 AccountPage 每次渲染新建，再上一层 App.tsx 传的
  // `onAccountChanged` 同样是行内箭头，所以把 `changed` 包成 useCallback 也挡不住
  // ——余额 store 每 30 秒 publish 一次就会重订一次。改成让订阅只依赖 `api`，回调
  // 本身从 ref 取最新的一份（与 pages-account 的 refreshGroupsRef 同一写法）。
  const acceptPaymentTerminalRef = useRef(acceptPaymentTerminal)
  acceptPaymentTerminalRef.current = acceptPaymentTerminal
  function paymentOpened(result: PendingPayment) {
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
  const amountText = custom !== '' ? custom : String(presetValue)
  const amountValue = isQuotableAmount(Number(amountText), topupMinimum) ? Number(amountText) : null
  // 框里填的不对，或者没填而默认那档低于这个渠道的最低额（渠道是自动选上的，没走下面换渠道时的重置），
  // 都在框下面说清楚，不然「充值」灰着没有一句话。
  const amountBad = Boolean(info.data) && amountValue === null
  const quoting = Boolean(info.data && paymentMethod) && !offline
  const tierQuotes = useTopupQuotes({
    quote: async (value) => (await api.quoteAccountTopupAmount({ amount: value })).payableAmount,
    presets: presetAmounts,
    // 选中的那个数也要问：它可能不在头几档里（活动卡片带来的、默认 10 不在后台的档位里），不问「实付」就一直转。
    custom: amountValue,
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
  const multiplier = info.data?.creditMultiplier
  const chosenTier = amountValue === null || !info.data ? null : tierView(amountValue)
  const chosenCredited = amountValue === null ? null : topupCreditedUsd(amountValue, multiplier)
  const chosenGift = amountValue === null || !info.data ? null : topupGift(amountValue, info.data)
  const balanceUsd = balance ? balance.displayAmount : null
  const afterUsd = balanceUsd !== null && chosenCredited !== null ? Math.round((balanceUsd + chosenCredited) * 100) / 100 : null
  const runway = afterUsd === null ? null : buildBalanceRunway({
    walletUsd: afterUsd,
    subscription: summary?.subscription ?? null,
    weekUsageUsd: summary?.weekUsageUsd ?? null,
  })
  const quoteCredited = quote ? topupCreditedUsd(quote.amount, quote.offer?.creditMultiplier ?? multiplier) : null
  const quoteGift = quote?.offer ? topupGift(quote.amount, quote.offer) : null
  const quoteTopup = () => {
    const request = ++quoteRequest.current
    void operation.execute(
      'quote',
      async () => {
        if (offline) throw new Error(offlineActionMessage)
        const value = validateTopupAmount(Number(amountText), topupMinimum)
        if (!paymentMethod) throw new Error('暂时没有可用的支付渠道。')
        // 页面可能摆了很久，活动早就撤了或改了：充值信息和报价一起重新问，确认框写的赠送、
        // 卡片上的档位都按这一刻的来。充值信息这次没读到就不写赠送，不报一个可能已经没有的赠送。
        const [fresh, next] = await Promise.all([
          api.getAccountTopupInfo().catch(() => null),
          api.quoteAccountTopupAmount({ amount: value }),
        ])
        if (fresh && !sameTopupInfo(info.data, fresh)) info.setData(fresh)
        // 金额在问价途中换了：不弹确认框，按钮回到「充值」，客户照新金额再点一次。
        if (request !== quoteRequest.current) return
        setQuote({ ...next, offer: fresh ? { discounts: fresh.discounts, creditMultiplier: fresh.creditMultiplier } : null })
      },
      '',
    )
  }
  const pay = () => {
    if (!quote || !paymentMethod) return
    const opened: Omit<PendingPayment, 'tradeNo'> = {
      kind: 'topup',
      expiresAt: null,
      amount: `${payableSymbol(paymentMethod.provider)}${quote.payableAmount.toFixed(2)}`,
      detail: creditedMoney(quoteCredited ?? quote.amount),
      method: paymentMethodLabel(paymentMethod),
      planName: null,
    }
    void operation.execute(
      'payment',
      async () => {
        openingPayment.current = []
        try {
          const result = await api.createAccountTopupPayment({
            amount: quote.amount,
            paymentMethod: paymentMethod.type,
          })
          paymentOpened({ ...opened, tradeNo: result.tradeNo })
        } finally { openingPayment.current = null }
        setQuote(null)
      },
      '已打开支付窗口',
    )
  }
  const purchaseLine = purchase ? balancePurchaseLine(balanceUsd, purchase) : null
  const purchasePlan = () => {
    if (!purchase) return
    const plan = purchase
    void operation.execute(
      'subscribe',
      async () => {
        if (purchaseMethod === 'balance') {
          if (!accountSupports(session, 'supportsSubscriptionBalancePurchase')) throw new Error('当前账号暂不支持余额购买订阅。')
          if (purchaseLine?.short) throw new Error('余额不够，换一种支付方式')
          await api.purchaseAccountSubscriptionWithBalance(plan.id)
        } else {
          if (!accountSupports(session, 'supportsSubscriptionPayment')) throw new Error('当前账号暂不支持客户端购买订阅。')
          const payMethod = methods.find((item) => item.type === purchaseMethod)
          if (!payMethod || payMethod.provider === 'waffo')
            throw new Error('该支付渠道暂不支持订阅。')
          openingPayment.current = []
          try {
            const result = await api.createAccountSubscriptionPayment(
              buildSubscriptionPaymentInput(plan.id, payMethod),
            )
            paymentOpened({
              ...result,
              kind: 'subscription',
              amount: planPriceText(plan),
              detail: [plan.title, planDurationText(plan)].filter(Boolean).join(' '),
              method: paymentMethodLabel(payMethod),
              planName: plan.title,
            })
          } finally { openingPayment.current = null }
        }
        setPurchase(null)
        await subscriptions.reload()
        changed()
        if (purchaseMethod === 'balance') applySubscriptionToTools()
      },
      purchaseMethod === 'balance' ? `${plan.title}已开通` : '已打开支付窗口',
    )
  }
  // 报价、充值码、买套餐三个弹窗共用一个 operation：打开时先清掉上一回的报错，弹窗里也只摆
  // 自己那个动作的失败。先点的别的动作（算价、存扣费顺序）赶在弹窗开着时才失败，只上页头那条。
  function dialogFailure(name: string) {
    return operation.failed === name ? { error: operation.error, detail: operation.detail } : {}
  }
  function openPurchase(plan: Plan) {
    const channels = subscriptionPaymentMethods(plan, methods, info.data ?? undefined)
    const short = balancePurchaseLine(balanceUsd, plan).short
    operation.clear()
    setPurchase(plan)
    setPurchaseMethod(plan.allowBalancePay && (!short || channels.length === 0) ? 'balance' : channels[0]?.type ?? '')
  }
  function openRedeem() {
    setCodeError('')
    operation.clear()
    setRedeemOpen(true)
  }
  const redeem = () => {
    const value = code.trim()
    if (!value) {
      setCodeError('请输入充值码')
      return
    }
    setCodeError('')
    void operation.execute(
      'redeem',
      async () => {
        // 断网时在这里就说，不先等请求超时。
        if (offline) throw new Error(offlineActionMessage)
        const result = await api.redeemAccountTopupCode(value)
        setCode('')
        setRedeemOpen(false)
        changed()
        void info.reload()
        await subscriptions.reload()
        if (result.type === 'subscription') applySubscriptionToTools()
        return result
      },
      (result) => redeemSuccessText(result, balance?.quotaPerUnit),
    )
  }
  function savePreference(preference: string) {
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
        '扣费顺序已保存',
      )
  }
  // 读不到就说读不到，手上有旧的一份也一样（同各页列表）：付完款再读订阅没成，不能还摆着「还没有订阅」。
  const infoFailed = Boolean(info.error) && !info.loading
  const noMethods = Boolean(info.data) && methods.length === 0
  const subscriptionsFailed = Boolean(subscriptions.error) && !subscriptions.loading
  const plans = subscriptions.data?.plans ?? []
  const ownSubscriptions = subscriptions.data?.subscriptions.allSubscriptions ?? []
  const preference: AccountSubscriptionBillingPreference = subscriptions.data?.subscriptions.billingPreference ?? 'subscription_first'
  // 扣费顺序只在用得上时摆：手上有订阅，或者已经改过（改成「只用订阅」以后订阅到期了，得改得回来）。
  const showPreference = accountSupports(session, 'supportsSubscriptionPreference') && Boolean(subscriptions.data)
    && (ownSubscriptions.length > 0 || preference !== 'subscription_first')
  const canBuy = (plan: Plan) => accountSupports(session, 'supportsSubscriptionPayment') || (plan.allowBalancePay && accountSupports(session, 'supportsSubscriptionBalancePurchase'))
  const terminal = paymentTerminal ? paymentTerminalPresentation(paymentTerminal.status, paymentTerminal.confirming, paymentTerminal.kind) : null
  const TerminalIcon = terminal ? resultIcons[terminal.tone] : Info
  const purchaseChoices: PayChoice[] = purchase ? [
    ...(purchase.allowBalancePay ? [{
      value: 'balance',
      label: '账户余额',
      description: purchaseLine?.text ?? '',
      leading: <Wallet size={16} />,
      disabled: purchaseLine?.short,
    }] : []),
    ...subscriptionPaymentMethods(purchase, methods, info.data ?? undefined).map(channelChoice),
  ] : []
  return (
    <>
      <ResultNotice error={operation.error} detail={operation.detail} message={payment || paymentTerminal ? '' : operation.message} />
      {paymentTerminal && terminal && (
        <section className={`v2-recharge-result is-${terminal.tone}`} role="status" data-testid="account-payment-notice">
          <span className="v2-recharge-result-icon" aria-hidden="true"><TerminalIcon size={16} strokeWidth={2.3} /></span>
          <div className="v2-recharge-result-copy">
            <h2>{terminal.title}</h2>
            <p>
              {paymentTerminalBody(paymentTerminal, paymentTerminal.kind, paymentTerminal.planName)}
              {paymentTerminal.status === 'closed' && paymentTerminal.confirming && paymentTerminal.tradeNo && (
                <small className="v2-business-payment-confirming">正在确认订单 {paymentTerminal.tradeNo} 是否到账…</small>
              )}
            </p>
            {paymentTerminal.status !== 'success' && (openOrders || (paymentTerminal.status === 'unconfirmed' && openHelp)) && (
              <div className="v2-recharge-result-actions">
                {openOrders && (
                  <Button size="sm" onClick={() => openOrders(paymentTerminal.tradeNo)} testId="account-payment-orders">
                    查看我的订单
                  </Button>
                )}
                {paymentTerminal.status === 'unconfirmed' && openHelp && (
                  <Button size="sm" variant="ghost" icon={HelpCircle} onClick={openHelp}>
                    联系客服
                  </Button>
                )}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" icon={X} aria-label="收起提示" title="收起提示" onClick={() => setPaymentTerminal(null)} />
        </section>
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
      <div className="v2-recharge-grid">
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
                  body="请稍后重试或联系客服。有充值码的话，点「有充值码？」兑换。"
                  testId="account-recharge-no-methods"
                  actions={openHelp && (
                    <Button size="sm" icon={HelpCircle} onClick={openHelp}>
                      联系客服
                    </Button>
                  )}
                />
              )}
              {/* 没有支付渠道时档位、金额和支付方式整块变灰，点不了；正在确认价格、等着付款时也先锁住，免得报价对不上。 */}
              <fieldset className="v2-business-recharge-form v2-recharge-form" disabled={noMethods || Boolean(payment) || operation.busy === 'quote'}>
                <div className="v2-recharge-label">快捷金额</div>
                <div className="v2-recharge-tiers">
                  {presetAmounts.map((value) => {
                    const tier = tierView(value)
                    const selected = custom === '' && presetValue === value
                    return (
                      <button
                        type="button"
                        key={value}
                        className={`v2-recharge-tier${selected ? ' is-selected' : ''}`}
                        aria-label={tier.label}
                        aria-pressed={selected}
                        onClick={() => { setPresetValue(value); setCustom(''); dropQuote() }}
                      >
                        {tier.bonus && <span className="v2-recharge-tier-gift">{tier.bonus}</span>}
                        <span className="v2-recharge-tier-credited"><small>到账</small>{tier.credited}</span>
                        {tier.paid !== null ? (
                          <span className="v2-recharge-tier-paid">实付 {tier.paid}</span>
                        ) : tier.quoting && (
                          <span className="v2-business-placeholder v2-recharge-tier-paid" aria-hidden="true" />
                        )}
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
                  placeholder={`最低 ${topupMinimum}，填整数`}
                  value={custom !== '' ? custom : presetAmounts.includes(presetValue) ? '' : String(presetValue)}
                  error={amountBad ? topupAmountError(topupMinimum) : undefined}
                  onChange={(event) => {
                    setCustom(event.target.value)
                    dropQuote()
                  }}
                />
                {/* 一个渠道都没有时上面那条提示已经说了，这里不留一块空的选择区。 */}
                {methods.length > 0 && (
                  <>
                    <hr className="v2-recharge-divider" />
                    <h3 className="v2-recharge-heading">支付方式</h3>
                    <PayChoices
                      name="account-payment"
                      choices={methods.map(channelChoice)}
                      value={paymentMethod?.type ?? ''}
                      onChange={(next) => {
                        const nextMethod = methods.find((item) => item.type === next)
                        setMethod(next)
                        dropQuote()
                        if (!nextMethod) return
                        const reset = resetTopupQuoteForMethod(amountText, nextMethod, info.data?.minTopup ?? 1).amount
                        if (reset === amountText) return
                        if (presetAmounts.includes(Number(reset))) {
                          setPresetValue(Number(reset))
                          setCustom('')
                        } else setCustom(reset)
                      }}
                    />
                  </>
                )}
              </fieldset>
            </>
          )}
        </Card>
        {payment ? (
          <aside className="v2-acct-card is-focus v2-recharge-aside" data-testid="account-payment-notice">
            <div className="v2-acct-card-head">
              <h2>等待支付结果</h2>
              <Pill tone="warn" dot>等待支付</Pill>
            </div>
            <div className="v2-recharge-big">{payment.amount}</div>
            <div className="v2-recharge-rows">
              <Row label="订单号"><span className="v2-recharge-trade">{payment.tradeNo || '待生成'}</span></Row>
              <Row label={payment.kind === 'subscription' ? '开通' : '到账'}><b>{payment.detail}</b></Row>
              <Row label="支付方式"><span>{payment.method}</span></Row>
            </div>
            <p className="v2-acct-note">
              {payment.kind === 'subscription' ? '付款后会自动关闭支付窗口，并刷新订阅。' : '到账后会自动关闭支付窗口，并刷新余额。'}
            </p>
            <div className="v2-recharge-aside-foot">
              <Button
                size="sm"
                loading={operation.busy === 'close-payment'}
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
              <button
                type="button"
                className="v2-acct-more"
                onClick={() => {
                  refresh()
                  void subscriptions.reload()
                }}
              >
                刷新余额与订阅
              </button>
            </div>
          </aside>
        ) : (
          <aside className="v2-acct-card is-focus v2-recharge-aside" data-testid="account-recharge-summary">
            <h2>本次充值</h2>
            <div className="v2-recharge-big-row">
              <span className="v2-recharge-big">{chosenCredited === null ? '—' : creditedMoney(chosenCredited)}</span>
              <span className="v2-acct-muted">到账</span>
            </div>
            <div className="v2-recharge-rows" data-testid="account-recharge-breakdown">
              <Row label="实付">
                {chosenTier?.paid ? <span>{chosenTier.paid}</span> : chosenTier?.quoting && quoting ? <PlaceholderBar width="4em" /> : <span>—</span>}
              </Row>
              {chosenGift && (
                <Row label="其中活动赠送"><span className="v2-recharge-gift">{creditedMoney(chosenGift.bonus)}（多送 {chosenGift.percent}%）</span></Row>
              )}
              {afterUsd !== null && <Row label="充值后余额"><b>{dollars(afterUsd)}</b></Row>}
              {runway?.days !== null && runway?.days !== undefined && (
                <Row label="按最近用量"><span>{rechargeRunwayText(runway.days)}</span></Row>
              )}
            </div>
            <Button
              variant="primary"
              icon={CreditCard}
              disabled={!paymentMethod || info.loading || noMethods || amountValue === null}
              loading={operation.busy === 'quote'}
              onClick={quoteTopup}
              testId="account-recharge-submit"
            >
              {operation.busy === 'quote' ? '正在确认价格…' : '充值'}
            </Button>
            {info.data?.redemptionEnabled !== false && (
              <button type="button" className="v2-acct-more v2-recharge-redeem-link" onClick={openRedeem} data-testid="account-recharge-redeem-open">
                有充值码？
              </button>
            )}
          </aside>
        )}
      </div>
      <Card title="我的订阅">
        {subscriptionsFailed ? (
          <ListReadFailure
            page="account-subscriptions"
            noun="订阅信息"
            description={<FailureReason error={subscriptions.error} detail={subscriptions.detail} />}
            retry={() => void subscriptions.reload()}
          />
        ) : ownSubscriptions.length ? (
          ownSubscriptions.map((subscription) => (
            <ListRow
              key={subscription.id}
              icon={Zap}
              title={
                subscription.groupName || (subscription.source === 'sub2api' ? `订阅分组 ${subscription.planId}` : plans.find(
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
                <span>{subscriptionExpiry(subscription.endsAt)}</span>
              </> : `剩余 ${quotaMoney(subscription.amountTotal === null || subscription.amountUsed === null ? null : Math.max(0, subscription.amountTotal - subscription.amountUsed), balance)} · ${subscriptionExpiry(subscription.endsAt)}`}
            />
          ))
        ) : (
          <p>{subscriptions.loading ? '正在读取订阅…' : '还没有订阅'}</p>
        )}
      </Card>
      {!subscriptionsFailed && plans.length > 0 && (
        <section className="v2-acct-section" data-testid="account-recharge-plans">
          <div className="v2-acct-section-head"><h2>订阅套餐</h2></div>
          {!accountSupports(session, 'supportsSubscriptionPayment') && !accountSupports(session, 'supportsSubscriptionBalancePurchase') &&
            <Notice tone="neutral" title="订阅仅供查看" body="该账号的订阅购买与扣费规则请在官方网站管理。" />}
          <div className="v2-recharge-plans">
            {plans.map((plan) => {
              const own = planSubscription(plan, ownSubscriptions)
              const term = planTermText(plan, balance?.quotaPerUnit)
              return (
                <section className="v2-acct-card v2-recharge-plan" key={plan.id}>
                  <div className="v2-acct-card-head">
                    <h3>{plan.title}</h3>
                    {own && <Pill tone="ok" dot>生效中</Pill>}
                  </div>
                  <div className="v2-recharge-plan-price">
                    <b>{planPriceText(plan)}</b>
                    {term && <span> {term}</span>}
                  </div>
                  {plan.subtitle && <p className="v2-acct-note">{plan.subtitle}</p>}
                  <div className="v2-recharge-plan-foot">
                    <span className="v2-acct-muted">{own ? planUsageText(own, balance?.quotaPerUnit) : ''}</span>
                    {canBuy(plan) && (
                      <Button icon={CreditCard} size="sm" disabled={Boolean(payment)} onClick={() => openPurchase(plan)}>
                        购买
                      </Button>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        </section>
      )}
      {!subscriptionsFailed && showPreference && (
        <section className="v2-acct-card v2-recharge-preference" data-testid="account-recharge-preference">
          <div className="v2-recharge-preference-head">
            <div>
              <h2>扣费顺序</h2>
              <p className="v2-acct-muted">同时有订阅和余额时，先扣哪一个</p>
            </div>
            <Segment
              label="扣费顺序"
              options={billingOptions.map((option) => ({ ...option, disabled: operation.busy === 'preference' }))}
              value={preference}
              onChange={savePreference}
            />
          </div>
          <p className="v2-recharge-preference-note"><Info size={14} aria-hidden="true" />{billingPreferenceNote(preference)}</p>
        </section>
      )}
      <Dialog
        open={Boolean(quote)}
        title="确认充值报价"
        onClose={() => setQuote(null)}
        footer={
          <>
            <Button onClick={() => setQuote(null)}>取消</Button>
            <Button
              variant="primary"
              icon={CreditCard}
              loading={operation.busy === 'payment'}
              onClick={pay}
            >
              打开支付窗口
            </Button>
          </>
        }
      >
        {quote && (
          <div className="v2-recharge-quote">
            <Row label="到账"><b>{creditedMoney(quoteCredited ?? quote.amount)}</b></Row>
            {quoteGift && (
              <Row label="其中活动赠送" testId="account-recharge-quote-bonus">
                <span className="v2-recharge-gift">{creditedMoney(quoteGift.bonus)}（多送 {quoteGift.percent}%）</span>
              </Row>
            )}
            <Row label="应付金额"><b>{payableSymbol(paymentMethod?.provider)}{quote.payableAmount.toFixed(2)}</b></Row>
            <Row label="支付方式"><span>{paymentMethod ? paymentMethodLabel(paymentMethod) : ''}</span></Row>
          </div>
        )}
        <p className="v2-acct-note">实际扣款以支付页面为准。付完后支付窗口会自动关闭，余额自动刷新。</p>
        <ResultNotice {...dialogFailure('payment')} />
      </Dialog>
      <Dialog
        open={redeemOpen}
        title="兑换充值码"
        onClose={() => setRedeemOpen(false)}
        busy={operation.busy === 'redeem'}
        footer={
          <>
            <Button onClick={() => setRedeemOpen(false)} disabled={operation.busy === 'redeem'}>取消</Button>
            <Button
              variant="primary"
              icon={Gift}
              loading={operation.busy === 'redeem'}
              onClick={redeem}
              testId="account-redeem"
            >
              兑换
            </Button>
          </>
        }
      >
        <Input
          label="充值码"
          mono
          value={code}
          error={codeError || undefined}
          onChange={(event) => {
            setCode(event.target.value)
            setCodeError('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              redeem()
            }
          }}
          autoComplete="off"
        />
        <p className="v2-acct-note">兑换到当前账号，余额和权益会自动更新。一个码只能用一次。</p>
        <ResultNotice {...dialogFailure('redeem')} />
      </Dialog>
      <Dialog
        open={Boolean(purchase)}
        title={`购买${purchase?.title ?? '订阅'}`}
        onClose={() => setPurchase(null)}
        busy={operation.busy === 'subscribe'}
        footer={
          <>
            <Button onClick={() => setPurchase(null)} disabled={operation.busy === 'subscribe'}>取消</Button>
            <Button
              variant="primary"
              icon={purchaseMethod === 'balance' ? Wallet : CreditCard}
              loading={operation.busy === 'subscribe'}
              disabled={!purchaseMethod}
              onClick={purchasePlan}
            >
              {purchaseMethod === 'balance' && purchase ? `用余额支付 ${planPriceText(purchase)}` : '打开支付窗口'}
            </Button>
          </>
        }
      >
        {purchase && (
          <div className="v2-recharge-plan-price">
            <b>{planPriceText(purchase)}</b>
            {planTermText(purchase, balance?.quotaPerUnit) && <span> {planTermText(purchase, balance?.quotaPerUnit)}</span>}
          </div>
        )}
        <div className="v2-recharge-label">支付方式</div>
        <PayChoices name="account-subscription-payment" choices={purchaseChoices} value={purchaseMethod} onChange={setPurchaseMethod} stacked />
        <ResultNotice {...dialogFailure('subscribe')} />
      </Dialog>
    </>
  )
}

// 「我的订阅」每份订阅那一行的到期：和账号概览、密钥行同一个写法（「10月1日到期」，#1133 第 6 条）；
// 读不出日期时照旧写原样。
function subscriptionExpiry(endsAt: string): string {
  const day = shortDate(endsAt)
  return day ? `${day}到期` : `到期 ${displayDate(endsAt)}`
}

/**
 * 「我的订单」：充值订阅这一页最下面一节，两行一条（v4）。支付窗口开着的那一单尾巴上写
 * 「支付窗口开着」；付款回跳、充值页「查看我的订单」都按订单号重新查（paymentReturn 每次加一）。
 */
export function AccountOrders({
  api,
  paymentReturn,
  refreshRequest,
  openTradeNo,
  multiplierAccount,
}: {
  api: V2Bridge
  paymentReturn?: { sequence: number; order: string | null }
  refreshRequest?: number
  /** 支付窗口开着的那一单；缺省 = 没有。 */
  openTradeNo?: string | null
  /** 历史账号：订单上记的是人民币那一档。 */
  multiplierAccount?: boolean
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
  // 付款有了结果（到账、超时、没付成、窗口关了）都重读一次，状态跟着变。
  useEffect(() => api.onAccountPaymentWindowTerminal(() => void resource.reload()), [api, resource.reload])
  // 刚打开支付窗口：新下的那一单要出现在列表里，标着「支付窗口开着」。
  const seenTradeNo = useRef(openTradeNo ?? null)
  useEffect(() => {
    const next = openTradeNo ?? null
    if (next === seenTradeNo.current) return
    seenTradeNo.current = next
    if (next) void resource.reload()
  }, [openTradeNo])
  useEffect(() => {
    if (!paymentReturn) return
    const order = paymentReturn.order ?? ''
    if (page === 1 && keyword === order) void resource.reload()
    else {
      setKeyword(order)
      setPage(1)
    }
  }, [paymentReturn?.sequence])
  const orders = resource.data?.orders ?? []
  return (
    <section className="v2-acct-section" data-anchor="orders" data-testid="account-orders-section">
      <div className="v2-acct-section-head">
        <h2>我的订单</h2>
        <SearchInput
          value={keyword}
          onChange={(value) => {
            setKeyword(value)
            setPage(1)
          }}
          placeholder="搜索订单号"
        />
      </div>
      <Card padding="none">
        {failed ? (
          <ListReadFailure
            page="orders"
            noun="订单"
            description={<FailureReason error={resource.error} detail={resource.detail} />}
            retry={() => void resource.reload()}
          />
        ) : orders.length ? (
          <div className="v2-recharge-orders" role="list" aria-label="我的订单">
            {orders.map((order) => {
              const state = orderStateFor(order.status)
              const paid = orderPaidText(order)
              return (
                <div className="v2-recharge-order" role="listitem" key={order.id}>
                  <span className="v2-acct-tile" aria-hidden="true"><CreditCard size={15} /></span>
                  <div className="v2-recharge-order-copy">
                    <strong>{orderTitle(order, Boolean(multiplierAccount))}</strong>
                    <p>
                      <span className="v2-recharge-trade">{order.tradeNo}</span>
                      ，{paymentMethodLabel({ name: '', type: order.paymentMethod })}
                      {paid && `，实付 ${paid}`}
                      ，<RelativeTime value={order.createdAt} />
                      {orderTail(order, openTradeNo)}
                    </p>
                  </div>
                  <Pill tone={state.tone}>{state.label}</Pill>
                </div>
              )
            })}
          </div>
        ) : resource.loading ? (
          <Empty icon={CreditCard} title="正在查询订单…" description="" />
        ) : keyword.trim() ? (
          <Empty icon={CreditCard} {...ordersSearchEmpty(keyword, Boolean(multiplierAccount))} />
        ) : (
          <Empty icon={CreditCard} title="还没有订单" description="充值后，订单会出现在这里。" />
        )}
      </Card>
      <Pagination
        page={page}
        total={resource.data?.total ?? 0}
        failed={failed}
        onChange={setPage}
      />
    </section>
  )
}

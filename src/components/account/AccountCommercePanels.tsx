import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BadgeCheck,
  Banknote,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Clock3,
  CreditCard,
  FileWarning,
  Gift,
  Inbox,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  Send,
  ShoppingBag,
  TicketCheck,
  Users,
  Wallet,
} from 'lucide-react'
import type {
  AccountBalance,
  AccountProfileDetail,
  AccountSubscriptionPlan,
  AccountSubscriptionBillingPreference,
  AccountSubscriptionPaymentInput,
  AccountSubscriptionSelf,
  AccountTopupInfo,
  AccountTopupOrdersPage,
} from '../../types'
import { errorMessage } from '../../error-message'
import type { ToastMessage } from '../Toast'
import { DialogBackdrop } from '../Dialog'
import { formatBalanceUsd } from './account-stub'
import { buildAccountInviteLink, formatAccountUsageDate } from './account-center'

export type AccountCommerceTab = 'subscriptions' | 'topup' | 'orders' | 'redeem' | 'invite'

const ORDER_PAGE_SIZE = 10
const PAYMENT_POLL_INTERVAL_MS = 3_000
const PAYMENT_POLL_LIMIT_MS = 10 * 60_000

export interface SubscriptionPaymentOption {
  id: string
  label: string
  description: string
  provider: 'balance' | AccountSubscriptionPaymentInput['provider']
  paymentMethod?: string
}

export function subscriptionPaymentOptions(
  plan: AccountSubscriptionPlan,
  topupInfo: AccountTopupInfo | null,
): SubscriptionPaymentOption[] {
  const options: SubscriptionPaymentOption[] = []
  if (plan.allowBalancePay) {
    options.push({ id: 'balance', label: '账户余额', description: '立即扣除账户余额并生效', provider: 'balance' })
  }
  if (topupInfo?.onlineTopupEnabled) {
    for (const method of topupInfo.paymentMethods.filter((entry) => entry.provider === 'epay')) {
      options.push({
        id: `epay:${method.type}`,
        label: method.name || method.type,
        description: '在软件内打开受控支付窗口',
        provider: 'epay',
        paymentMethod: method.type,
      })
    }
  }
  if (topupInfo?.stripeTopupEnabled && plan.stripePriceId) {
    options.push({ id: 'stripe', label: 'Stripe', description: '银行卡或 Stripe 支持的支付方式', provider: 'stripe' })
  }
  if (topupInfo?.creemTopupEnabled && plan.creemProductId) {
    options.push({ id: 'creem', label: 'Creem', description: '通过 Creem 安全结账', provider: 'creem' })
  }
  if (topupInfo?.waffoPancakeTopupEnabled && plan.waffoPancakeProductId) {
    options.push({
      id: 'waffo-pancake',
      label: 'Waffo Pancake',
      description: '通过 Waffo Pancake 安全结账',
      provider: 'waffo-pancake',
    })
  }
  return options
}

function billingPreferenceLabel(preference: AccountSubscriptionBillingPreference): string {
  if (preference === 'subscription_first') return '订阅优先'
  if (preference === 'wallet_first') return '余额优先'
  if (preference === 'subscription_only') return '仅使用订阅'
  return '仅使用余额'
}

export function parseIntegerTopupAmount(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function effectiveTopupMinimum(
  topupInfo: Pick<AccountTopupInfo, 'minTopup'> | null,
  method: Pick<AccountTopupInfo['paymentMethods'][number], 'minTopup'> | null,
): number {
  return Math.max(topupInfo?.minTopup ?? 0, method?.minTopup ?? 0)
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function amountLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function orderStatusLabel(status: AccountTopupOrdersPage['orders'][number]['status']): string {
  if (status === 'pending') return '等待支付'
  if (status === 'success') return '已到账'
  if (status === 'failed') return '支付失败'
  if (status === 'expired') return '已过期'
  return '状态未知'
}

function subscriptionDuration(plan: AccountSubscriptionPlan): string {
  const unit = plan.durationUnit === 'year'
    ? '年'
    : plan.durationUnit === 'month'
      ? '个月'
      : plan.durationUnit === 'day'
        ? '天'
        : plan.durationUnit === 'hour'
          ? '小时'
          : '个自定义周期'
  return `${plan.durationValue} ${unit}`
}

function resetPeriodLabel(plan: AccountSubscriptionPlan): string {
  if (plan.quotaResetPeriod === 'never') return '额度不重置'
  if (plan.quotaResetPeriod === 'daily') return '每日重置'
  if (plan.quotaResetPeriod === 'weekly') return '每周重置'
  if (plan.quotaResetPeriod === 'monthly') return '每月重置'
  return '按自定义周期重置'
}

function PanelLoading({ label }: { label: string }) {
  return (
    <section className="workspace-empty" aria-live="polite">
      <div className="workspace-empty-icon"><LoaderCircle size={24} className="spin" /></div>
      <h2>{label}</h2>
    </section>
  )
}

function PanelError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div className="session-error" role="alert">
      <FileWarning size={18} />
      <div><strong>{title}</strong><span>{message}</span></div>
      <button type="button" className="secondary-button" onClick={onRetry}>重试</button>
    </div>
  )
}

export function AccountCommercePanels({
  activeTab,
  profile,
  balance,
  onRefreshAccount,
  notify,
}: {
  activeTab: AccountCommerceTab | null
  profile: AccountProfileDetail | null
  balance: AccountBalance | null
  onRefreshAccount: () => Promise<void>
  notify?: (toast: ToastMessage) => void
}) {
  const mounted = useRef(true)
  const topupRequest = useRef(0)
  const ordersRequest = useRef(0)
  const subscriptionsRequest = useRef(0)
  const [topupInfo, setTopupInfo] = useState<AccountTopupInfo | null>(null)
  const [topupLoading, setTopupLoading] = useState(false)
  const [topupError, setTopupError] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [quote, setQuote] = useState<{ amount: number; payableAmount: number } | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [paymentConfirmOpen, setPaymentConfirmOpen] = useState(false)
  const [pendingPayment, setPendingPayment] = useState<{ tradeNo: string | null; startedAt: number } | null>(null)
  const [ordersPageNumber, setOrdersPageNumber] = useState(1)
  const [orders, setOrders] = useState<AccountTopupOrdersPage | null>(null)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersError, setOrdersError] = useState<string | null>(null)
  const [redeemCode, setRedeemCode] = useState('')
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [plans, setPlans] = useState<AccountSubscriptionPlan[] | null>(null)
  const [subscriptionSelf, setSubscriptionSelf] = useState<AccountSubscriptionSelf | null>(null)
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false)
  const [subscriptionsError, setSubscriptionsError] = useState<string | null>(null)
  const [purchaseTarget, setPurchaseTarget] = useState<AccountSubscriptionPlan | null>(null)
  const [purchaseMethodId, setPurchaseMethodId] = useState('')
  const [purchaseBusy, setPurchaseBusy] = useState(false)
  const [preferenceBusy, setPreferenceBusy] = useState(false)
  const [pendingSubscriptionPayment, setPendingSubscriptionPayment] = useState<{
    beforeIds: Set<number>
    startedAt: number
    expiresAt: string | null
  } | null>(null)
  const [copiedInvite, setCopiedInvite] = useState<'code' | 'link' | null>(null)
  const [affiliateAmount, setAffiliateAmount] = useState('')
  const [affiliateBusy, setAffiliateBusy] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadTopupInfo = useCallback(async () => {
    const requestId = ++topupRequest.current
    setTopupLoading(true)
    setTopupError(null)
    try {
      const next = await window.xingmang.getAccountTopupInfo()
      if (!mounted.current || requestId !== topupRequest.current) return
      setTopupInfo(next)
      const firstMethod = next.paymentMethods[0] ?? null
      setPaymentMethod((current) => next.paymentMethods.some((method) => method.type === current) ? current : (firstMethod?.type ?? ''))
      const minimum = effectiveTopupMinimum(next, firstMethod)
      const firstAmount = next.amountOptions.find((value) => value >= minimum) ?? minimum
      setAmount((current) => current || (firstAmount > 0 ? amountLabel(firstAmount) : ''))
    } catch (error) {
      if (mounted.current && requestId === topupRequest.current) setTopupError(errorMessage(error))
    } finally {
      if (mounted.current && requestId === topupRequest.current) setTopupLoading(false)
    }
  }, [])

  const loadOrders = useCallback(async (page = ordersPageNumber, quiet = false) => {
    const requestId = ++ordersRequest.current
    if (!quiet) setOrdersLoading(true)
    setOrdersError(null)
    try {
      const next = await window.xingmang.getAccountTopupOrders({ page, pageSize: ORDER_PAGE_SIZE })
      if (!mounted.current || requestId !== ordersRequest.current) return null
      setOrders(next)
      return next
    } catch (error) {
      if (mounted.current && requestId === ordersRequest.current && !quiet) setOrdersError(errorMessage(error))
      return null
    } finally {
      if (mounted.current && requestId === ordersRequest.current && !quiet) setOrdersLoading(false)
    }
  }, [ordersPageNumber])

  const loadSubscriptions = useCallback(async () => {
    const requestId = ++subscriptionsRequest.current
    setSubscriptionsLoading(true)
    setSubscriptionsError(null)
    try {
      const [nextPlans, nextSelf] = await Promise.all([
        window.xingmang.getAccountSubscriptionPlans(),
        window.xingmang.getAccountSubscriptionSelf(),
      ])
      if (!mounted.current || requestId !== subscriptionsRequest.current) return
      setPlans(nextPlans)
      setSubscriptionSelf(nextSelf)
    } catch (error) {
      if (mounted.current && requestId === subscriptionsRequest.current) setSubscriptionsError(errorMessage(error))
    } finally {
      if (mounted.current && requestId === subscriptionsRequest.current) setSubscriptionsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'topup' && !topupInfo && !topupLoading) void loadTopupInfo()
  }, [activeTab, topupInfo, topupLoading, loadTopupInfo])

  useEffect(() => {
    if (activeTab === 'orders') void loadOrders(ordersPageNumber)
  }, [activeTab, ordersPageNumber, loadOrders])

  useEffect(() => {
    if (activeTab === 'subscriptions' && !plans && !subscriptionsLoading) void loadSubscriptions()
    if (activeTab === 'subscriptions' && !topupInfo && !topupLoading) void loadTopupInfo()
  }, [activeTab, plans, subscriptionsLoading, loadSubscriptions, topupInfo, topupLoading, loadTopupInfo])

  const parsedAmount = parseIntegerTopupAmount(amount)
  const selectedMethod = topupInfo?.paymentMethods.find((method) => method.type === paymentMethod) ?? null
  const selectedMinimum = effectiveTopupMinimum(topupInfo, selectedMethod)
  useEffect(() => {
    if (activeTab !== 'topup' || !parsedAmount || !topupInfo || !selectedMethod || parsedAmount < selectedMinimum) {
      setQuote(null)
      setQuoteLoading(false)
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setQuoteLoading(true)
      void window.xingmang.quoteAccountTopupAmount({ amount: parsedAmount })
        .then((next) => { if (active) setQuote(next) })
        .catch((error: unknown) => {
          if (active) {
            setQuote(null)
            notify?.({ type: 'error', message: errorMessage(error) })
          }
        })
        .finally(() => { if (active) setQuoteLoading(false) })
    }, 260)
    return () => { active = false; window.clearTimeout(timer) }
  }, [activeTab, parsedAmount, topupInfo, selectedMethod, selectedMinimum, notify])

  useEffect(() => {
    if (!pendingPayment) return
    let active = true
    const check = async () => {
      if (!active) return
      if (Date.now() - pendingPayment.startedAt > PAYMENT_POLL_LIMIT_MS) {
        setPendingPayment(null)
        notify?.({ type: 'info', message: '已停止自动刷新，可在“我的订单”中手动查看最新状态' })
        return
      }
      const latest = await loadOrders(1, true)
      if (!latest || !active) return
      const order = pendingPayment.tradeNo
        ? latest.orders.find((entry) => entry.tradeNo === pendingPayment.tradeNo)
        : latest.orders.find((entry) => Date.parse(entry.createdAt) >= pendingPayment.startedAt - 30_000)
      if (!order || order.status === 'pending' || order.status === 'unknown') return
      setPendingPayment(null)
      if (order.status === 'success') {
        try {
          await onRefreshAccount()
          notify?.({ type: 'success', message: '支付已到账，账户余额已刷新' })
        } catch (error) {
          notify?.({ type: 'info', message: `支付已到账，但余额刷新失败：${errorMessage(error)}` })
        }
      } else {
        notify?.({ type: 'error', message: `订单${orderStatusLabel(order.status)}，请检查支付窗口或重新下单` })
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), PAYMENT_POLL_INTERVAL_MS)
    return () => { active = false; window.clearInterval(timer) }
  }, [pendingPayment, loadOrders, onRefreshAccount, notify])

  const submitPayment = async () => {
    if (!parsedAmount || !topupInfo || parsedAmount < selectedMinimum || !selectedMethod || !quote || paymentBusy) return
    setPaymentBusy(true)
    try {
      const opened = await window.xingmang.createAccountTopupPayment({ amount: parsedAmount, paymentMethod })
      setPaymentConfirmOpen(false)
      setPendingPayment({ tradeNo: opened.tradeNo, startedAt: Date.now() })
      notify?.({ type: 'info', message: '支付窗口已打开，完成支付后将自动刷新余额' })
    } catch (error) {
      notify?.({ type: 'error', message: errorMessage(error) })
    } finally {
      if (mounted.current) setPaymentBusy(false)
    }
  }

  const submitRedeem = async () => {
    const code = redeemCode.trim()
    if (!code || redeemBusy) return
    setRedeemBusy(true)
    try {
      const result = await window.xingmang.redeemAccountTopupCode(code)
      setRedeemCode('')
      await onRefreshAccount()
      notify?.({
        type: 'success',
        message: balance ? `兑换成功，已增加 ${formatBalanceUsd(result.quotaAdded, balance.quotaPerUnit)}` : '兑换成功',
      })
    } catch (error) {
      notify?.({ type: 'error', message: errorMessage(error) })
    } finally {
      if (mounted.current) setRedeemBusy(false)
    }
  }

  const confirmPurchase = async () => {
    if (!purchaseTarget || purchaseBusy) return
    const option = subscriptionPaymentOptions(purchaseTarget, topupInfo)
      .find((entry) => entry.id === purchaseMethodId)
    if (!option) return
    setPurchaseBusy(true)
    try {
      if (option.provider === 'balance') {
        await window.xingmang.purchaseAccountSubscriptionWithBalance(purchaseTarget.id)
        setPurchaseTarget(null)
        await Promise.all([loadSubscriptions(), onRefreshAccount()])
        notify?.({ type: 'success', message: `已购买订阅“${purchaseTarget.title}”` })
      } else {
        const beforeIds = new Set((subscriptionSelf?.allSubscriptions ?? []).map((entry) => entry.id))
        const result = await window.xingmang.createAccountSubscriptionPayment({
          planId: purchaseTarget.id,
          provider: option.provider,
          ...(option.paymentMethod ? { paymentMethod: option.paymentMethod } : {}),
        })
        setPurchaseTarget(null)
        setPendingSubscriptionPayment({ beforeIds, startedAt: Date.now(), expiresAt: result.expiresAt })
        notify?.({ type: 'info', message: '订阅支付窗口已打开，完成支付后将自动刷新订阅' })
      }
    } catch (error) {
      notify?.({ type: 'error', message: errorMessage(error) })
    } finally {
      if (mounted.current) setPurchaseBusy(false)
    }
  }

  const updateBillingPreference = async (next: AccountSubscriptionBillingPreference) => {
    if (!subscriptionSelf || preferenceBusy || next === subscriptionSelf.billingPreference) return
    const previous = subscriptionSelf.billingPreference
    setPreferenceBusy(true)
    setSubscriptionSelf((current) => current ? { ...current, billingPreference: next } : current)
    try {
      const normalized = await window.xingmang.updateAccountSubscriptionPreference(next)
      setSubscriptionSelf((current) => current ? { ...current, billingPreference: normalized } : current)
      notify?.({ type: 'success', message: `扣费顺序已更新为“${billingPreferenceLabel(normalized)}”` })
    } catch (error) {
      setSubscriptionSelf((current) => current ? { ...current, billingPreference: previous } : current)
      notify?.({ type: 'error', message: errorMessage(error) })
    } finally {
      if (mounted.current) setPreferenceBusy(false)
    }
  }

  const copyInvite = async (kind: 'code' | 'link', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedInvite(kind)
      window.setTimeout(() => { if (mounted.current) setCopiedInvite((current) => current === kind ? null : current) }, 1_500)
    } catch (error) {
      notify?.({ type: 'error', message: errorMessage(error) })
    }
  }

  const transferAffiliate = async () => {
    const dollars = parsePositiveNumber(affiliateAmount)
    if (!dollars) return
    if (!balance || affiliateBusy) return
    const quota = Math.round(dollars * balance.quotaPerUnit)
    if (quota <= 0 || !profile || quota > profile.affQuota) {
      notify?.({ type: 'error', message: '转入金额不能超过当前可转入奖励' })
      return
    }
    setAffiliateBusy(true)
    try {
      await window.xingmang.transferAccountAffiliateQuota({ quota })
      setAffiliateAmount('')
      await onRefreshAccount()
      notify?.({ type: 'success', message: '邀请奖励已转入账户余额' })
    } catch (error) {
      notify?.({ type: 'error', message: errorMessage(error) })
    } finally {
      if (mounted.current) setAffiliateBusy(false)
    }
  }

  const activeSubscriptions = subscriptionSelf?.activeSubscriptions ?? []
  const allSubscriptions = subscriptionSelf?.allSubscriptions ?? []
  const purchaseOptions = purchaseTarget ? subscriptionPaymentOptions(purchaseTarget, topupInfo) : []
  const selectedPurchaseOption = purchaseOptions.find((entry) => entry.id === purchaseMethodId) ?? null
  const purchaseCount = purchaseTarget
    ? allSubscriptions.filter((entry) => entry.planId === purchaseTarget.id).length
    : 0
  const purchaseLimitReached = Boolean(
    purchaseTarget?.maxPurchasePerUser
    && purchaseCount >= purchaseTarget.maxPurchasePerUser,
  )
  const balanceCost = purchaseTarget && balance
    ? Math.max(0, Math.ceil(purchaseTarget.priceAmount * balance.quotaPerUnit))
    : null
  const balanceInsufficient = selectedPurchaseOption?.provider === 'balance'
    && (balanceCost === null || !balance || balance.quota < balanceCost)
  const totalOrderPages = Math.max(1, Math.ceil((orders?.total ?? 0) / ORDER_PAGE_SIZE))
  const discount = paymentMethod ? topupInfo?.discounts[paymentMethod] : undefined
  const inviteLink = profile?.affCode ? buildAccountInviteLink(profile.affCode) : null
  const payableDifference = quote && quote.payableAmount !== quote.amount

  useEffect(() => {
    if (!purchaseTarget) {
      setPurchaseMethodId('')
      return
    }
    const options = subscriptionPaymentOptions(purchaseTarget, topupInfo)
    setPurchaseMethodId((current) => options.some((entry) => entry.id === current)
      ? current
      : (options[0]?.id ?? ''))
  }, [purchaseTarget, topupInfo])

  useEffect(() => {
    if (!pendingSubscriptionPayment) return
    let active = true
    let checking = false
    const check = async () => {
      if (!active || checking) return
      const hardDeadline = pendingSubscriptionPayment.startedAt + PAYMENT_POLL_LIMIT_MS
      const providerDeadline = pendingSubscriptionPayment.expiresAt
        ? Date.parse(pendingSubscriptionPayment.expiresAt)
        : Number.POSITIVE_INFINITY
      if (Date.now() > Math.min(hardDeadline, providerDeadline)) {
        setPendingSubscriptionPayment(null)
        notify?.({ type: 'info', message: '已停止自动刷新，可点击订阅页刷新查看最新状态' })
        return
      }
      checking = true
      try {
        const next = await window.xingmang.getAccountSubscriptionSelf()
        if (!active) return
        const created = next.allSubscriptions.find((entry) => !pendingSubscriptionPayment.beforeIds.has(entry.id))
        setSubscriptionSelf(next)
        if (!created) return
        setPendingSubscriptionPayment(null)
        await onRefreshAccount()
        notify?.({ type: 'success', message: '订阅已生效，账户信息已刷新' })
      } catch {
        // Payment polling is best effort; the next bounded interval retries.
      } finally {
        checking = false
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), PAYMENT_POLL_INTERVAL_MS)
    return () => { active = false; window.clearInterval(timer) }
  }, [pendingSubscriptionPayment, onRefreshAccount, notify])

  const topupPanel = useMemo(() => {
    if (topupLoading && !topupInfo) return <PanelLoading label="正在读取充值方式" />
    if (topupError && !topupInfo) return <PanelError title="充值配置读取失败" message={topupError} onRetry={() => void loadTopupInfo()} />
    if (!topupInfo) return null
    if (!topupInfo.onlineTopupEnabled) {
      return (
        <section className="workspace-empty">
          <div className="workspace-empty-icon"><CreditCard size={24} /></div>
          <h2>当前未开启在线充值</h2>
          <p>支付能力以服务器实时返回为准，可使用兑换码或联系售后。</p>
        </section>
      )
    }
    return (
      <div className="account-commerce-topup">
        <section className="account-commerce-form" aria-labelledby="account-topup-form-title">
          <header><Wallet size={18} /><div><h3 id="account-topup-form-title">充值金额</h3><p>支付方式、最低金额与折扣由服务器实时返回</p></div></header>
          {topupInfo.amountOptions.length > 0 && (
            <div className="account-amount-options" aria-label="快速选择充值金额">
              {topupInfo.amountOptions.map((option) => (
                <button key={option} type="button" className={Number(amount) === option ? 'active' : ''} onClick={() => setAmount(amountLabel(option))}>
                  {amountLabel(option)}
                </button>
              ))}
            </div>
          )}
          <label className="field extension-field">
            <span>自定义金额</span>
            <input type="number" min={topupInfo.minTopup} step="1" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} />
            <small className="field-hint">当前支付方式最低充值 {amountLabel(selectedMinimum)}，充值金额必须为整数。</small>
          </label>
          <fieldset className="account-payment-methods">
            <legend>支付方式</legend>
            {topupInfo.paymentMethods.map((method) => (
              <label key={`${method.provider}:${method.type}`} className={paymentMethod === method.type ? 'active' : ''}>
                <input
                  type="radio"
                  name="payment-method"
                  value={method.type}
                  checked={paymentMethod === method.type}
                  onChange={() => {
                    setPaymentMethod(method.type)
                    const minimum = effectiveTopupMinimum(topupInfo, method)
                    if ((parseIntegerTopupAmount(amount) ?? 0) < minimum) setAmount(amountLabel(minimum))
                  }}
                />
                <span className="account-payment-swatch" style={method.color ? { backgroundColor: method.color } : undefined}><CreditCard size={16} /></span>
                <span><strong>{method.name || method.type}</strong><small>最低 {amountLabel(effectiveTopupMinimum(topupInfo, method))}</small></span>
                {topupInfo.discounts[method.type] !== undefined && <em>{topupInfo.discounts[method.type]} 折扣系数</em>}
              </label>
            ))}
          </fieldset>
        </section>
        <aside className="account-payment-summary">
          <div><span>充值金额</span><strong>{parsedAmount ? amountLabel(parsedAmount) : '—'}</strong></div>
          <div><span>支付方式</span><strong>{selectedMethod?.name || '未选择'}</strong></div>
          {discount !== undefined && <div><span>折扣系数</span><strong>{discount}</strong></div>}
          <div className="account-payment-total">
            <span>预计实付</span>
            <strong>{quoteLoading ? '计算中…' : quote ? amountLabel(quote.payableAmount) : '—'}</strong>
            {payableDifference && <small>原金额 {amountLabel(quote.amount)}</small>}
          </div>
          {!topupInfo.paymentComplianceConfirmed && (
            <p className="account-payment-warning">当前支付合规确认未完成，服务器可能拒绝下单。</p>
          )}
          <button
            type="button"
            className="primary-button full"
            disabled={!parsedAmount || parsedAmount < selectedMinimum || !selectedMethod || quoteLoading || !quote || paymentBusy}
            onClick={() => setPaymentConfirmOpen(true)}
          >
            {paymentBusy ? <LoaderCircle className="spin" size={16} /> : <CreditCard size={16} />}
            {paymentBusy ? '正在创建订单…' : '确认充值'}
          </button>
          {pendingPayment && (
            <div className="account-payment-pending" role="status">
              <LoaderCircle className="spin" size={16} />
              <span><strong>正在等待支付结果</strong><small>完成后自动刷新余额，关闭窗口不代表支付成功。</small></span>
            </div>
          )}
        </aside>
      </div>
    )
  }, [topupLoading, topupInfo, topupError, loadTopupInfo, amount, paymentMethod, parsedAmount, selectedMethod, selectedMinimum, discount, quoteLoading, quote, payableDifference, paymentBusy, pendingPayment])

  const ordersPanel = ordersLoading && !orders
    ? <PanelLoading label="正在读取订单" />
    : ordersError && !orders
      ? <PanelError title="订单读取失败" message={ordersError} onRetry={() => void loadOrders(ordersPageNumber)} />
      : !orders || orders.orders.length === 0
        ? (
            <section className="workspace-empty">
              <div className="workspace-empty-icon"><Inbox size={24} /></div>
              <h2>暂无充值订单</h2>
              <p>在客户端发起充值后，订单状态会显示在这里。</p>
            </section>
          )
        : (
            <div className="account-orders">
              <div className="account-orders-toolbar">
                <span>共 {orders.total} 条订单</span>
                <button type="button" className="secondary-button" disabled={ordersLoading} onClick={() => void loadOrders(ordersPageNumber)}><RefreshCw size={15} />刷新</button>
              </div>
              <div className="account-orders-table">
                <div className="account-orders-head" aria-hidden="true"><span>订单号</span><span>创建时间</span><span>充值金额</span><span>实付</span><span>支付方式</span><span>状态</span></div>
                {orders.orders.map((order) => (
                  <div className="account-orders-row" key={order.id}>
                    <code title={order.tradeNo}>{order.tradeNo}</code>
                    <span>{formatAccountUsageDate(order.createdAt)}</span>
                    <span>{amountLabel(order.amount)}</span>
                    <strong>{amountLabel(order.money)}</strong>
                    <span>{order.paymentMethod || order.paymentProvider || '—'}</span>
                    <span className={`account-order-status is-${order.status}`}>{orderStatusLabel(order.status)}</span>
                  </div>
                ))}
              </div>
              <footer className="account-center-pagination">
                <span>{ordersPageNumber} / {totalOrderPages}</span>
                <div>
                  <button type="button" className="icon-button compact" aria-label="上一页" disabled={ordersPageNumber <= 1 || ordersLoading} onClick={() => setOrdersPageNumber((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button>
                  <button type="button" className="icon-button compact" aria-label="下一页" disabled={ordersPageNumber >= totalOrderPages || ordersLoading} onClick={() => setOrdersPageNumber((value) => value + 1)}><ChevronRight size={17} /></button>
                </div>
              </footer>
            </div>
          )

  const subscriptionsPanel = subscriptionsLoading && !plans
    ? <PanelLoading label="正在读取订阅方案" />
    : subscriptionsError && !plans
      ? <PanelError title="订阅信息读取失败" message={subscriptionsError} onRetry={() => void loadSubscriptions()} />
      : (
          <div className="account-subscriptions">
            {subscriptionSelf && (
              <section className="account-active-subscriptions">
                <header>
                  <BadgeCheck size={18} />
                  <div><h3>我的订阅</h3><p>{activeSubscriptions.length > 0 ? `${activeSubscriptions.length} 个订阅正在生效` : '当前没有生效中的订阅'}</p></div>
                  <label className="account-billing-preference">
                    <span>API 扣费顺序</span>
                    <select
                      value={subscriptionSelf.billingPreference}
                      disabled={preferenceBusy}
                      onChange={(event) => void updateBillingPreference(event.target.value as AccountSubscriptionBillingPreference)}
                    >
                      <option value="subscription_first" disabled={activeSubscriptions.length === 0}>订阅优先</option>
                      <option value="wallet_first">余额优先</option>
                      <option value="subscription_only" disabled={activeSubscriptions.length === 0}>仅使用订阅</option>
                      <option value="wallet_only">仅使用余额</option>
                    </select>
                  </label>
                  <button type="button" className="icon-button compact" title="刷新订阅" aria-label="刷新订阅" disabled={subscriptionsLoading} onClick={() => void loadSubscriptions()}>
                    <RefreshCw size={15} className={subscriptionsLoading ? 'spin' : ''} />
                  </button>
                </header>
                <div>
                  {allSubscriptions.length === 0 && <p className="account-subscription-empty">购买套餐后，订阅额度、状态和到期时间会显示在这里。</p>}
                  {allSubscriptions.map((subscription) => {
                    const plan = plans?.find((entry) => entry.id === subscription.planId)
                    return (
                      <article key={subscription.id}>
                        <span><strong>{plan?.title || `订阅 #${subscription.planId}`}</strong><small>{subscription.status}</small></span>
                        <span><small>已用额度</small><strong>{balance ? formatBalanceUsd(subscription.amountUsed, balance.quotaPerUnit) : subscription.amountUsed}</strong></span>
                        <span><small>到期时间</small><strong>{formatAccountUsageDate(subscription.endsAt)}</strong></span>
                      </article>
                    )
                  })}
                </div>
              </section>
            )}
            {!plans || plans.length === 0 ? (
              <section className="workspace-empty"><div className="workspace-empty-icon"><ShoppingBag size={24} /></div><h2>暂无可购买的订阅</h2><p>方案上线后会自动显示。</p></section>
            ) : (
              <div className="account-plan-grid">
                {plans.map((plan) => {
                  const count = allSubscriptions.filter((entry) => entry.planId === plan.id).length
                  const limitReached = plan.maxPurchasePerUser > 0 && count >= plan.maxPurchasePerUser
                  const paymentCount = subscriptionPaymentOptions(plan, topupInfo).length
                  return (
                  <article className="account-plan" key={plan.id}>
                    <header><span><PackageCheck size={18} /></span><div><h3>{plan.title}</h3><p>{plan.subtitle || '适用于稳定的 AI 工作流'}</p></div></header>
                    <div className="account-plan-price"><strong>{amountLabel(plan.priceAmount)}</strong><span>{plan.currency || '货币单位以服务器为准'} / {subscriptionDuration(plan)}</span></div>
                    <dl>
                      <div><dt>套餐额度</dt><dd>{balance ? formatBalanceUsd(plan.totalAmount, balance.quotaPerUnit) : plan.totalAmount}</dd></div>
                      <div><dt>额度周期</dt><dd>{resetPeriodLabel(plan)}</dd></div>
                      <div><dt>到期分组</dt><dd>{plan.downgradeGroup || '保持当前分组'}</dd></div>
                      {plan.maxPurchasePerUser > 0 && <div><dt>购买次数</dt><dd>{count} / {plan.maxPurchasePerUser}</dd></div>}
                    </dl>
                    <button type="button" className="primary-button full" disabled={limitReached || paymentCount === 0} onClick={() => setPurchaseTarget(plan)}>
                      <ShoppingBag size={16} />{limitReached ? '已达到购买上限' : paymentCount > 0 ? '购买订阅' : '当前没有可用支付方式'}
                    </button>
                  </article>
                  )
                })}
              </div>
            )}
          </div>
        )

  const redeemPanel = (
    <div className="account-redeem">
      <section>
        <span className="account-redeem-icon"><Gift size={22} /></span>
        <div><h3>兑换充值码</h3><p>输入有效兑换码，额度将直接加入当前账户。</p></div>
      </section>
      <label className="field extension-field"><span>兑换码</span><input value={redeemCode} autoComplete="off" placeholder="输入兑换码" onChange={(event) => setRedeemCode(event.target.value)} /></label>
      <button type="button" className="primary-button" disabled={!redeemCode.trim() || redeemBusy} onClick={() => void submitRedeem()}>{redeemBusy ? <LoaderCircle className="spin" size={16} /> : <TicketCheck size={16} />}{redeemBusy ? '正在兑换…' : '立即兑换'}</button>
    </div>
  )

  const invitePanel = !profile?.affCode || !inviteLink
    ? <section className="workspace-empty"><div className="workspace-empty-icon"><Users size={24} /></div><h2>暂无邀请码</h2><p>请稍后刷新账户资料或联系售后。</p></section>
    : (
        <div className="account-affiliate">
          <div className="account-affiliate-stats">
            <div><span>已邀请</span><strong>{profile.affCount} 人</strong></div>
            <div><span>可转入奖励</span><strong>{balance ? formatBalanceUsd(profile.affQuota, balance.quotaPerUnit) : profile.affQuota}</strong></div>
            <div><span>历史邀请奖励</span><strong>{balance ? formatBalanceUsd(profile.affHistoryQuota, balance.quotaPerUnit) : profile.affHistoryQuota}</strong></div>
          </div>
          <section className="account-affiliate-share">
            <h3>邀请好友</h3>
            <label className="field"><span>邀请码</span><div className="input-with-action"><input readOnly value={profile.affCode} onFocus={(event) => event.currentTarget.select()} /><button type="button" title="复制邀请码" onClick={() => void copyInvite('code', profile.affCode as string)}>{copiedInvite === 'code' ? <Check size={16} /> : <ClipboardCopy size={16} />}</button></div></label>
            <label className="field"><span>邀请链接</span><div className="input-with-action"><input readOnly value={inviteLink} onFocus={(event) => event.currentTarget.select()} /><button type="button" title="复制邀请链接" onClick={() => void copyInvite('link', inviteLink)}>{copiedInvite === 'link' ? <Check size={16} /> : <ClipboardCopy size={16} />}</button></div></label>
          </section>
          <section className="account-affiliate-transfer">
            <header><Send size={18} /><div><h3>奖励转入余额</h3><p>转入后可直接用于 API 消费或余额订阅。</p></div></header>
            <div className="account-affiliate-transfer-form">
              <label className="field"><span>转入金额（USD）</span><input type="number" min="0.01" step="0.01" value={affiliateAmount} onChange={(event) => setAffiliateAmount(event.target.value)} /></label>
              <button type="button" className="primary-button" disabled={!parsePositiveNumber(affiliateAmount) || affiliateBusy || !balance || profile.affQuota <= 0} onClick={() => void transferAffiliate()}>{affiliateBusy ? <LoaderCircle className="spin" size={16} /> : <Banknote size={16} />}转入余额</button>
            </div>
          </section>
        </div>
      )

  return (
    <>
      {activeTab === 'topup' && topupPanel}
      {activeTab === 'orders' && ordersPanel}
      {activeTab === 'subscriptions' && subscriptionsPanel}
      {activeTab === 'redeem' && redeemPanel}
      {activeTab === 'invite' && invitePanel}
      {paymentConfirmOpen && selectedMethod && parsedAmount && quote && (
        <DialogBackdrop
          className="config-modal-backdrop extension-backdrop"
          onDismiss={paymentBusy ? () => undefined : () => setPaymentConfirmOpen(false)}
        >
          <section className="extension-confirm-dialog account-payment-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="account-payment-confirm-title">
            <span className="extension-confirm-icon"><CreditCard size={20} /></span>
            <h2 id="account-payment-confirm-title">确认充值</h2>
            <div className="account-payment-confirm-summary">
              <div><span>充值金额</span><strong>{amountLabel(parsedAmount)}</strong></div>
              <div><span>支付方式</span><strong>{selectedMethod.name || selectedMethod.type}</strong></div>
              <div><span>预计实付</span><strong>{amountLabel(quote.payableAmount)}</strong></div>
            </div>
            <p>确认后将在软件内打开受控支付窗口。请核对收款信息，支付结果以“我的订单”状态为准。</p>
            <div className="extension-dialog-actions">
              <button type="button" className="secondary-button" disabled={paymentBusy} onClick={() => setPaymentConfirmOpen(false)}>取消</button>
              <button type="button" className="primary-button" disabled={paymentBusy} onClick={() => void submitPayment()}>
                {paymentBusy ? <LoaderCircle className="spin" size={16} /> : <CreditCard size={16} />}
                {paymentBusy ? '正在创建订单…' : `使用${selectedMethod.name || selectedMethod.type}支付`}
              </button>
            </div>
          </section>
        </DialogBackdrop>
      )}
      {purchaseTarget && (
        <DialogBackdrop className="config-modal-backdrop extension-backdrop" onDismiss={purchaseBusy ? () => undefined : () => setPurchaseTarget(null)}>
          <section className="extension-confirm-dialog account-purchase-dialog" role="alertdialog" aria-modal="true" aria-labelledby="account-purchase-title">
            <span className="extension-confirm-icon"><ShoppingBag size={20} /></span>
            <h2 id="account-purchase-title">购买“{purchaseTarget.title}”</h2>
            <div className="account-payment-confirm-summary">
              <div><span>套餐</span><strong>{purchaseTarget.title}</strong></div>
              <div><span>有效期</span><strong>{subscriptionDuration(purchaseTarget)}</strong></div>
              <div><span>应付金额</span><strong>{amountLabel(purchaseTarget.priceAmount)} {purchaseTarget.currency || ''}</strong></div>
            </div>
            {purchaseLimitReached ? (
              <p className="account-payment-warning">已达到此套餐的购买上限（{purchaseCount} / {purchaseTarget.maxPurchasePerUser}）。</p>
            ) : purchaseOptions.length === 0 ? (
              <p className="account-payment-warning">服务器当前没有为此套餐启用可用支付方式。</p>
            ) : (
              <fieldset className="account-payment-methods account-subscription-payment-methods">
                <legend>选择支付方式</legend>
                {purchaseOptions.map((option) => (
                  <label key={option.id} className={purchaseMethodId === option.id ? 'active' : ''}>
                    <input type="radio" name="subscription-payment-method" checked={purchaseMethodId === option.id} onChange={() => setPurchaseMethodId(option.id)} />
                    <span className="account-payment-swatch">{option.provider === 'balance' ? <Wallet size={16} /> : <CreditCard size={16} />}</span>
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    {option.provider === 'balance' && balance && balanceCost !== null && (
                      <em>{formatBalanceUsd(balance.quota, balance.quotaPerUnit)} 可用</em>
                    )}
                  </label>
                ))}
              </fieldset>
            )}
            {balanceInsufficient && <p className="account-payment-warning">账户余额不足，请选择其他支付方式或先充值。</p>}
            {pendingSubscriptionPayment && (
              <div className="account-payment-pending" role="status"><LoaderCircle className="spin" size={16} /><span><strong>正在等待订阅生效</strong><small>完成支付后软件会自动刷新。</small></span></div>
            )}
            <div className="extension-dialog-actions">
              <button type="button" className="secondary-button" disabled={purchaseBusy} onClick={() => setPurchaseTarget(null)}>取消</button>
              <button type="button" className="primary-button" disabled={purchaseBusy || purchaseLimitReached || !selectedPurchaseOption || balanceInsufficient} onClick={() => void confirmPurchase()}>{purchaseBusy ? <LoaderCircle className="spin" size={16} /> : <BadgeCheck size={16} />}{purchaseBusy ? '正在创建订单…' : '确认购买'}</button>
            </div>
          </section>
        </DialogBackdrop>
      )}
    </>
  )
}

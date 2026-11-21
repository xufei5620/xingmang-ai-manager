import type {
  AccountPaymentWindowTerminalEvent,
  AccountRedemptionResult,
  AccountSubscriptionBillingPreference,
  AccountSubscriptionPaymentInput,
  AccountSubscriptionPlan,
  AccountSubscriptionSelf,
  AccountTopupInfo,
  AccountTopupOrdersPage,
} from '../../../../electron/ipc-contract'
import { orderStates, subscriptionStates } from '../../registry/business'
import { dollars } from '../../business-common'
import { buildTopupBonus, type TopupBonus } from './topup-bonus'
import { formatAmount } from './topup-tier'
import { runwayDaysText, shortDate } from './account-center'
import { quotaPeriodResetAt, subscriptionResetAt, subscriptionResetTime } from '../../../../electron/subscription-summary'

/**
 * 充值订阅这一页（v4 第 07 批）上由数据拼出来的话和算出来的数。都是纯函数，页面只管摆；
 * 字以字表批07为准，测试钉着。
 */

type PaymentMethod = AccountTopupInfo['paymentMethods'][number]
type Subscription = AccountSubscriptionSelf['allSubscriptions'][number]
type QuotaPeriod = NonNullable<Subscription['quotaPeriods']>[number]
type Order = AccountTopupOrdersPage['orders'][number]
export type PaymentKind = 'topup' | 'subscription'

export function subscriptionPaymentMethods(
  plan: AccountSubscriptionPlan,
  methods: PaymentMethod[],
  availability?: Pick<
    AccountTopupInfo,
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
): AccountSubscriptionPaymentInput {
  if (method.provider === 'waffo') {
    throw new Error('该支付渠道暂不支持订阅。')
  }
  return method.provider === 'epay'
    ? { planId, provider: 'epay', paymentMethod: method.type }
    : { planId, provider: method.provider }
}

/** 页顶那条支付结果：超时、失败、待确认、窗口已关闭四种与原型逐字一致；成功的两句去掉了「服务端」（字表批07）。 */
export function paymentTerminalPresentation(
  status: AccountPaymentWindowTerminalEvent['status'],
  confirming = false,
  kind: PaymentKind = 'topup',
): { tone: 'neutral' | 'warn' | 'bad' | 'ok'; title: string; body: string } {
  if (status === 'success' && kind === 'subscription') return {
    tone: 'ok', title: '订阅已开通', body: '已付款，订阅已开通。',
  }
  if (status === 'success') return {
    tone: 'ok', title: '充值成功', body: '已到账，余额已更新。',
  }
  if (status === 'expired') {
    return {
      tone: 'warn',
      title: '支付已超时',
      body: '该订单未支付成功，不会产生扣费。如需充值，请重新下单；如已显示扣款，请点击「查看我的订单」核对。',
    }
  }
  if (status === 'failed') {
    return {
      tone: 'bad',
      title: '支付未完成',
      body: '支付渠道返回支付失败。请重新充值；如已显示扣款，请点击「查看我的订单」核对。',
    }
  }
  if (status === 'unconfirmed') {
    return {
      tone: 'warn',
      title: '暂未确认到账',
      body: '如已显示付款成功，可能是支付渠道处理延迟，请稍后在「我的订单」中查看。超过 30 分钟仍未到账，请提供订单号联系客服。',
    }
  }
  // 订阅不进余额：关窗后那两句换成「订阅会自动开通」，别的照充值那套。
  if (kind === 'subscription') return confirming
    ? {
      tone: 'neutral',
      title: '支付窗口已关闭',
      body: '如已付款，无需其他操作，确认后订阅将自动开通。未付款的订单不会产生扣费。',
    }
    : {
      tone: 'neutral',
      title: '支付窗口已关闭',
      body: '关闭支付窗口不会取消订单。如已付款，订阅将在确认后自动开通，也可点击「查看我的订单」核对。',
    }
  return confirming
    ? {
      tone: 'neutral',
      title: '支付窗口已关闭',
      body: '如已付款，无需其他操作，到账后余额将自动更新。未付款的订单不会产生扣费。',
    }
    : {
      tone: 'neutral',
      title: '支付窗口已关闭',
      body: '关闭支付窗口不会取消订单。如已付款，到账后余额将自动更新，也可点击「查看我的订单」核对。',
    }
}

/**
 * 提示正文：订单号跟在后面；后台还在确认时订单号放在下面那行「正在确认…」里。
 * 订阅开通的那句写套餐名（买的时候记下的），记不到就写「订阅」。
 */
export function paymentTerminalBody(event: AccountPaymentWindowTerminalEvent, kind: PaymentKind = 'topup', planName?: string | null): string {
  const presentation = paymentTerminalPresentation(event.status, event.confirming, kind)
  if (!event.tradeNo) return presentation.body
  if (event.status === 'success' && kind === 'subscription') return `订单 ${event.tradeNo} 已付款，${planName?.trim() || '订阅'}已开通。`
  if (event.status === 'success') return `订单 ${event.tradeNo} 已到账，余额已更新。`
  if (event.status === 'closed' && event.confirming) return presentation.body
  return `${presentation.body} 订单号 ${event.tradeNo}。`
}

/**
 * 订阅开通后，工具那边换没换过去的一句话。星芒账号的订阅不看 Key 在哪个分组，
 * 请求按「扣费顺序」自动先扣订阅，不用换；历史账号的订阅只对订阅分组里的 Key
 * 生效，要把用得上的工具换一把 Key（switched 就是换好的那几个工具的名字）。
 */
export function subscriptionToolsNotice(
  input: { followsPreference: true } | { followsPreference: false; switched: readonly string[] } | { followsPreference: false; error: string },
): { tone: 'ok' | 'warn'; title: string; body: string; action?: 'health' } {
  if (input.followsPreference) return {
    tone: 'ok', title: '工具无需重新设置', body: '工具请求将按「扣费顺序」优先使用订阅额度。',
  }
  if ('error' in input) return {
    tone: 'warn', title: '订阅已开通，工具尚未切换', body: `${input.error} 请前往「检查」页点击「重新写入密钥」。`, action: 'health',
  }
  if (input.switched.length) return {
    tone: 'ok', title: '工具已改用订阅额度', body: `${input.switched.join('、')} 已切换为该订阅，无需重新设置。`,
  }
  return {
    tone: 'ok', title: '工具无需重新设置', body: '对应工具安装并登录后，将自动使用订阅额度。',
  }
}

/** 充值数量的报错：不是整数、不够最低额，都说同一句（字表批07把两句合成了一句）。 */
export function topupAmountError(minimum: number): string {
  return `充值金额不能低于 ${minimum}，请输入整数`
}

export function validateTopupAmount(value: number, minimum: number): number {
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    throw new Error('当前支付渠道的最低充值金额无效。')
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value < minimum) {
    throw new Error(topupAmountError(minimum))
  }
  return value
}

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

/** 一档充值到账多少（美元）：带倍数的账号档位是实付，到账 = 档位 × 倍数；其余档位就是到账。 */
export function topupCreditedUsd(amount: number, creditMultiplier?: number): number {
  return creditMultiplier === undefined ? amount : Math.round(amount * creditMultiplier * 100) / 100
}

/**
 * 「其中活动赠送 {金额}（多送 {N}%）」那一行要的数，按到账单位（美元）算。带倍数的账号
 * 每一档同一个比例，多出来的就是送的；其余按后台给这一档配的折扣算（buildTopupBonus）。
 */
export function topupGift(amount: number, offer: { discounts?: Record<string, number> | null; creditMultiplier?: number }): TopupBonus | null {
  if (offer.creditMultiplier === undefined) return buildTopupBonus(amount, offer.discounts ?? undefined)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const percent = Math.round((offer.creditMultiplier - 1) * 100)
  const bonus = Math.round(amount * (offer.creditMultiplier - 1) * 100) / 100
  return percent > 0 && bonus > 0 ? { bonus, percent } : null
}

/** 套餐价：美元写「$」，人民币写「¥」，别的币种照写代码；整数不带小数。 */
export function planPriceText(plan: Pick<AccountSubscriptionPlan, 'priceAmount' | 'currency'>): string {
  const currency = (plan.currency || 'USD').toUpperCase()
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
  return `${symbol}${formatAmount(plan.priceAmount)}`
}

/** 套餐一期多长：「30 天」「1 个月」「1 年」「12 小时」；算不出来为 null，就不写这一截。 */
export function planDurationText(plan: Pick<AccountSubscriptionPlan, 'durationUnit' | 'durationValue' | 'customSeconds'>): string | null {
  if (plan.durationUnit === 'custom') {
    const seconds = plan.customSeconds
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null
    if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`
    if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`
    return null
  }
  const value = plan.durationValue
  if (!Number.isSafeInteger(value) || value <= 0) return null
  if (plan.durationUnit === 'day') return `${value} 天`
  if (plan.durationUnit === 'month') return `${value} 个月`
  if (plan.durationUnit === 'year') return `${value} 年`
  return `${value} 小时`
}

/** 套餐额度（美元）；历史账号的套餐不给总额、余额没读到时为 null，就不写「含……」。 */
export function planQuotaUsd(plan: Pick<AccountSubscriptionPlan, 'totalAmount'>, quotaPerUnit: number | null | undefined): number | null {
  return typeof plan.totalAmount === 'number' && plan.totalAmount > 0 && quotaPerUnit && quotaPerUnit > 0
    ? plan.totalAmount / quotaPerUnit
    : null
}

/**
 * 价格后面那截：「/ 30 天，含 $10.00 额度，每天重置额度」。周期、额度哪样算不出就不写哪样；
 * 有额度上限、又是每天重置的套餐才说「每天重置额度」（D60），不限额的重置了也看不出差别。
 */
export function planTermText(
  plan: Pick<AccountSubscriptionPlan, 'durationUnit' | 'durationValue' | 'customSeconds' | 'totalAmount'> & Partial<Pick<AccountSubscriptionPlan, 'quotaResetPeriod'>>,
  quotaPerUnit: number | null | undefined,
): string {
  const duration = planDurationText(plan)
  const quota = planQuotaUsd(plan, quotaPerUnit)
  const daily = plan.quotaResetPeriod === 'daily' && typeof plan.totalAmount === 'number' && plan.totalAmount > 0
  return [duration && `/ ${duration}`, quota !== null && `含 ${dollars(quota)} 额度`, daily && '每天重置额度'].filter(Boolean).join('，')
}

/**
 * 套餐卡对得上的自己那份订阅（「生效中」「已用 …，… 到期」）。历史账号订阅上的编号是订阅分组，
 * 跟套餐编号不是一回事，不去对。
 */
export function planSubscription(plan: Pick<AccountSubscriptionPlan, 'id'>, subscriptions: readonly Subscription[]): Subscription | null {
  return subscriptions.find((subscription) => subscription.source !== 'sub2api' && subscription.planId === plan.id && subscription.status === 'active') ?? null
}

/** 套餐卡底下那句：「已用 $3.20，11月13日到期」；已用读不到只写到期。 */
export function planUsageText(subscription: Pick<Subscription, 'amountUsed' | 'endsAt'>, quotaPerUnit: number | null | undefined, now: Date = new Date()): string {
  const ends = shortDate(subscription.endsAt, now)
  const used = typeof subscription.amountUsed === 'number' && quotaPerUnit && quotaPerUnit > 0 ? dollars(subscription.amountUsed / quotaPerUnit) : null
  const expiry = ends ? `${ends}到期` : ''
  return used === null ? expiry : expiry ? `已用 ${used}，${expiry}` : `已用 ${used}`
}

/**
 * 「我的订阅」里接在「剩余 …」后面的那截：「 · 明天 00:00 恢复」（D60）。星芒账号用服务端给的下次
 * 重置时间，历史账号每个窗口按各自的规矩算（subscription-summary）；读不到、不会再恢复时为空串。
 */
export function subscriptionResetSuffix(
  subscription: Pick<Subscription, 'status' | 'startedAt' | 'endsAt' | 'quotaPeriods' | 'nextResetAt'>,
  period: QuotaPeriod | null,
  now: Date = new Date(),
): string {
  const at = period ? quotaPeriodResetAt(subscription, period, now.getTime()) : subscriptionResetAt(subscription, now.getTime())
  const when = at ? subscriptionResetTime(at, now) : null
  return when ? ` · ${when} 恢复` : ''
}

/** 扣费顺序四个选项各自下面那句（字表批07；「只用订阅」按注里的建议句）。 */
export function billingPreferenceNote(preference: AccountSubscriptionBillingPreference): string {
  switch (preference) {
    case 'subscription_first': return '订阅额度用尽后自动改扣余额，使用不中断。'
    case 'wallet_first': return '余额用尽后扣除订阅额度。'
    case 'subscription_only': return '订阅额度用尽后停止使用，需续购订阅或更改扣费顺序。'
    case 'wallet_only': return '不使用订阅额度，全部用量从余额扣除。'
  }
}

/**
 * 买套餐时「账号余额」那一项下面那句，以及够不够付。只有标价是美元时才跟余额比：
 * 别的币种换算以后台为准，不在这里猜。
 */
export function balancePurchaseLine(balanceUsd: number | null, plan: Pick<AccountSubscriptionPlan, 'priceAmount' | 'currency'>): { text: string | null; short: boolean } {
  if (balanceUsd === null || (plan.currency || 'USD').toUpperCase() !== 'USD') return { text: null, short: false }
  const left = Math.round((balanceUsd - plan.priceAmount) * 100) / 100
  return left < 0
    ? { text: `余额 ${dollars(balanceUsd)}，还差 ${dollars(-left)}`, short: true }
    : { text: `余额 ${dollars(balanceUsd)}，扣完剩 ${dollars(left)}`, short: false }
}

/**
 * 买套餐的框里摆的套餐，跟后台这一刻的比出来的结果：price = 价格或币种变了；terms = 价格没变，
 * 时长、额度或额度重置的规矩变了；gone = 列表里已经没有这个套餐（下架了）。
 */
export type PurchasePlanChange = 'none' | 'price' | 'terms' | 'gone'

/**
 * 买套餐的框里是打开那一刻的套餐，框开着时后台可能改了价、改了内容或者下架了。下单只带套餐编号，
 * 服务端照它那一刻的价扣（余额买是直接扣，后面没有支付页再给客户看一眼），所以列表重读回来、
 * 点付款之前都按编号对一遍：拿到后台现在那份换进框里，客户看得到、付得着的那几样变了就报出来。
 */
export function followPurchasePlan(
  seen: AccountSubscriptionPlan,
  fresh: readonly AccountSubscriptionPlan[],
): { change: Exclude<PurchasePlanChange, 'gone'>; plan: AccountSubscriptionPlan } | { change: 'gone'; plan: null } {
  const plan = fresh.find((item) => item.id === seen.id)
  if (!plan) return { change: 'gone', plan: null }
  if (plan.priceAmount !== seen.priceAmount || planCurrency(plan) !== planCurrency(seen)) return { change: 'price', plan }
  if (
    planDurationText(plan) !== planDurationText(seen)
    || plan.totalAmount !== seen.totalAmount
    || plan.quotaResetPeriod !== seen.quotaResetPeriod
  ) return { change: 'terms', plan }
  return { change: 'none', plan }
}

function planCurrency(plan: Pick<AccountSubscriptionPlan, 'currency'>): string {
  return (plan.currency || 'USD').toUpperCase()
}

/** 框里那份套餐变了时框顶那条（N3，yoyo 11-21 要书面口吻）；没变为 null。price 那句把调整前后的价都写出来。 */
export function purchasePlanNotice(
  change: PurchasePlanChange,
  before: Pick<AccountSubscriptionPlan, 'priceAmount' | 'currency'>,
  after: Pick<AccountSubscriptionPlan, 'priceAmount' | 'currency'> | null,
): { title: string; body: string } | null {
  if (change === 'price' && after) return {
    title: '价格已更新',
    body: `价格由 ${planPriceText(before)} 调整为 ${planPriceText(after)}，请确认后重新支付。`,
  }
  if (change === 'terms') return { title: '套餐内容已更新', body: '套餐的时长或额度已调整，价格不变，请确认后重新支付。' }
  if (change === 'gone') return { title: '该套餐已下架', body: '请关闭此窗口，选择其他套餐。' }
  return null
}

/**
 * 买套餐的框里选哪种支付：能用余额、余额也够（或者没有别的渠道）就选余额，不然选第一个在线渠道。
 * 框开着时套餐换成了后台现在那份，客户已经选的那种还能用就不动它。
 */
export function purchaseMethodFor(
  plan: Pick<AccountSubscriptionPlan, 'allowBalancePay'>,
  channels: readonly Pick<PaymentMethod, 'type'>[],
  balanceShort: boolean,
  current?: string,
): string {
  const usable = current === 'balance'
    ? plan.allowBalancePay && !balanceShort
    : channels.some((channel) => channel.type === current)
  if (current && usable) return current
  return plan.allowBalancePay && (!balanceShort || channels.length === 0) ? 'balance' : channels[0]?.type ?? ''
}

/** 兑换成功的那句：余额写到账多少，结果里没有金额就只说余额已更新；订阅、并发额度两种照旧。 */
export function redeemSuccessText(result: AccountRedemptionResult, quotaPerUnit: number | null | undefined): string {
  if (result.type === 'subscription') return '订阅兑换成功'
  if (result.type === 'concurrency') return '并发额度兑换成功'
  return result.quotaAdded > 0 && quotaPerUnit && quotaPerUnit > 0
    ? `兑换成功，${dollars(result.quotaAdded / quotaPerUnit)} 已到账`
    : '兑换成功，余额已更新'
}

// 易支付渠道（支付宝、微信这类）收的是人民币；Stripe 这类以渠道页面为准，不乱标符号（同 payableSymbol）。
const yuanChannels = new Set(['epay', 'alipay', 'wxpay', 'wechat', 'wechatpay', 'qqpay'])

/** 订单上的「实付 …」；没有付款金额的订单（比如还没付）为 null，就不写这一截。 */
export function orderPaidText(order: Pick<Order, 'money' | 'paymentProvider' | 'paymentMethod'>): string | null {
  if (!Number.isFinite(order.money) || order.money <= 0) return null
  const channel = (order.paymentProvider || order.paymentMethod).trim().toLowerCase()
  return `${yuanChannels.has(channel) ? '¥' : ''}${order.money.toFixed(2)}`
}

// 星芒账号（new-api）的订阅订单号前缀，rc.40～rc.45 和上游 main 一样：易支付 SUBUSR、Stripe 和 Creem
// sub_ref_、Waffo Pancake WAFFO_PANCAKE_SUB-（上游分辨 Waffo Pancake 的订阅回调也是看这个前缀）。
// 充值单是 USR、ref_、WAFFO_PANCAKE-，不会撞。订阅单没付成之前只在订阅订单表里，客户能查的「我的订单」（充值表）里没有；
// 付成以后上游才往充值表补一行同单号、数量记 0 的成功记录（model/subscription.go upsertSubscriptionTopUpTx）。
const subscriptionTradeNoPrefixes = ['SUBUSR', 'sub_ref_', 'WAFFO_PANCAKE_SUB-']

/** 是不是星芒账号的订阅订单号。历史账号的订单号是另一套，不按这个认。 */
export function isSubscriptionTradeNo(tradeNo: string): boolean {
  const value = tradeNo.trim()
  return subscriptionTradeNoPrefixes.some((prefix) => value.startsWith(prefix))
}

/**
 * 「我的订单」一行的标题和第二行末尾那截。星芒账号的充值数量就是到账美元；历史账号订单上记的是
 * 付了多少人民币那一档，倍数可能早就改过，按人民币写，不拿现在的倍数去乘。星芒账号的订阅单在
 * 充值表里数量记 0，照充值写就成了「充值 $0」，所以按单号认出来写「开通订阅」。
 */
export function orderTitle(order: Pick<Order, 'amount' | 'tradeNo'>, multiplierAccount: boolean): string {
  if (!multiplierAccount && isSubscriptionTradeNo(order.tradeNo)) return '开通订阅'
  return `充值 ${multiplierAccount ? '¥' : '$'}${formatAmount(order.amount)}`
}
export function orderTail(order: Pick<Order, 'status' | 'tradeNo'>, openTradeNo: string | null | undefined): string {
  if (order.status === 'pending') return openTradeNo && order.tradeNo === openTradeNo ? '，支付窗口已打开' : '，未付款不会产生扣费'
  if (order.status === 'failed') return '，支付未完成，未扣款'
  if (order.status === 'expired') return '，支付失败，未扣款'
  return ''
}

/** 按订单号搜没搜到时的那两行。星芒账号的订阅单没付成之前查不到，不叫客户去核对单号。 */
export function ordersSearchEmpty(keyword: string, multiplierAccount: boolean): { title: string; description: string } {
  if (!multiplierAccount && isSubscriptionTradeNo(keyword)) return {
    title: '该订阅尚未开通',
    description: '订阅订单付款成功后显示在此处，未付款不会产生扣费。如已显示付款成功，请稍后查询；超过 30 分钟仍未开通，请联系客服。',
  }
  return { title: '未找到该订单', description: '请核对订单号，或清空搜索查看全部订单。' }
}

/**
 * 「我的订单」的「开发票」打开开票窗口以后那条提示（2026-11-11 yoyo 回「窗口改」批的原字）。
 * 开票中心另要登录一次，同一个账号登过就记着：星芒账号填用户名，历史账号填邮箱，和它自己登录页上写的一致。
 */
export function invoicePortalOpenedText(multiplierAccount: boolean): string {
  return `开票中心已在新窗口打开。如需登录，请使用当前账号的${multiplierAccount ? '邮箱' : '用户名'}和密码。`
}

/** 开票窗口没打开时那句（2026-11-02 批的原字，「窗口改」时照旧）。 */
export const invoicePortalOpenFailed = '开票中心打开失败，请稍后重试；如仍无法打开，请联系客服。'

/** 「本次充值」里「按最近用量」后面那句：跟账号概览同一套说法（runwayDaysText），左边已经写了「按最近用量」，这里去掉打头那几个字。 */
export function rechargeRunwayText(days: number): string {
  return runwayDaysText(days).replace(/^按近期用量/, '')
}

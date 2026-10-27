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

/**
 * 充值订阅这一页（v4 第 07 批）上由数据拼出来的话和算出来的数。都是纯函数，页面只管摆；
 * 字以字表批07为准，测试钉着。
 */

type PaymentMethod = AccountTopupInfo['paymentMethods'][number]
type Subscription = AccountSubscriptionSelf['allSubscriptions'][number]
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
  // 订阅不进余额：关窗后那两句换成「订阅会自动开通」，别的照充值那套。
  if (kind === 'subscription') return confirming
    ? {
      tone: 'neutral',
      title: '支付窗口已关闭',
      body: '如果已经付过款，不用做什么：星芒还在确认，付款成功后订阅会自动开通。还没付的话，这笔订单放着就行，不会扣钱。',
    }
    : {
      tone: 'neutral',
      title: '支付窗口已关闭',
      body: '关闭支付窗口不会取消订单。付过款的话，付款成功后订阅会自动开通，也可以点「查看我的订单」核对。',
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
    tone: 'ok', title: '工具不用重新设置', body: '工具发出的请求会按「扣费顺序」先用订阅额度。',
  }
  if ('error' in input) return {
    tone: 'warn', title: '订阅已开通，工具还没换过去', body: `${input.error} 可以到「检查」页点「重新写入密钥」再试一次。`, action: 'health',
  }
  if (input.switched.length) return {
    tone: 'ok', title: '工具已改用订阅额度', body: `${input.switched.join('、')} 已换成用这份订阅，不用重新打开设置。`,
  }
  return {
    tone: 'ok', title: '工具不用重新设置', body: '这份订阅对应的工具装好、登录后会自动用订阅额度。',
  }
}

/** 充值数量的报错：不是整数、不够最低额，都说同一句（字表批07把两句合成了一句）。 */
export function topupAmountError(minimum: number): string {
  return `充值数量不能低于 ${minimum}，请填整数`
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

/**
 * 点「充值」那一刻问到的价，跟右边「本次充值」摆着的是不是一回事。应付、到账、赠送都对得上，就直接打开支付窗口，
 * 不再弹「确认充值报价」让客户把右边看过的再看一遍；有一样变了（活动刚撤、刚改价）才弹框。
 * 右边还没算出实付（shown.paid 为 null）时对不上，照旧弹框。
 */
export function topupQuoteMatchesSummary(
  shown: { paid: string | null; credited: number | null; gift: TopupBonus | null },
  asked: { paid: string; credited: number; gift: TopupBonus | null },
): boolean {
  return shown.paid === asked.paid
    && shown.credited === asked.credited
    && (shown.gift?.bonus ?? null) === (asked.gift?.bonus ?? null)
    && (shown.gift?.percent ?? null) === (asked.gift?.percent ?? null)
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

/** 价格后面那截：「/ 30 天，含 $10.00 额度」。周期、额度哪样算不出就不写哪样。 */
export function planTermText(plan: Pick<AccountSubscriptionPlan, 'durationUnit' | 'durationValue' | 'customSeconds' | 'totalAmount'>, quotaPerUnit: number | null | undefined): string {
  const duration = planDurationText(plan)
  const quota = planQuotaUsd(plan, quotaPerUnit)
  return [duration && `/ ${duration}`, quota !== null && `含 ${dollars(quota)} 额度`].filter(Boolean).join('，')
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

/** 扣费顺序四个选项各自下面那句（字表批07；「只用订阅」按注里的建议句）。 */
export function billingPreferenceNote(preference: AccountSubscriptionBillingPreference): string {
  switch (preference) {
    case 'subscription_first': return '订阅额度用完后自动改扣余额，不会中断。'
    case 'wallet_first': return '余额用完后再扣订阅额度。'
    case 'subscription_only': return '订阅额度用完后就停下，要再买订阅或换一种扣费顺序。'
    case 'wallet_only': return '订阅额度留着不用，所有用量都从余额里扣。'
  }
}

/**
 * 买套餐时「账户余额」那一项下面那句，以及够不够付。只有标价是美元时才跟余额比：
 * 别的币种换算以后台为准，不在这里猜。
 */
export function balancePurchaseLine(balanceUsd: number | null, plan: Pick<AccountSubscriptionPlan, 'priceAmount' | 'currency'>): { text: string | null; short: boolean } {
  if (balanceUsd === null || (plan.currency || 'USD').toUpperCase() !== 'USD') return { text: null, short: false }
  const left = Math.round((balanceUsd - plan.priceAmount) * 100) / 100
  return left < 0
    ? { text: `余额 ${dollars(balanceUsd)}，还差 ${dollars(-left)}`, short: true }
    : { text: `余额 ${dollars(balanceUsd)}，扣完剩 ${dollars(left)}`, short: false }
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
  if (order.status === 'pending') return openTradeNo && order.tradeNo === openTradeNo ? '，支付窗口开着' : '，没付的话放着就行，不会扣钱'
  if (order.status === 'failed') return '，支付没有完成，没有扣款'
  if (order.status === 'expired') return '，没有付成功，不会扣钱'
  return ''
}

/** 按订单号搜没搜到时的那两行。星芒账号的订阅单没付成之前查不到，不叫客户去核对单号。 */
export function ordersSearchEmpty(keyword: string, multiplierAccount: boolean): { title: string; description: string } {
  if (!multiplierAccount && isSubscriptionTradeNo(keyword)) return {
    title: '这笔订阅还没开通',
    description: '订阅订单付款成功后才会出现在这里。没付的话放着就行，不会扣钱；手机上已经显示付款成功的话，稍后再查，超过 30 分钟还没开通请联系客服。',
  }
  return { title: '没有找到这个订单', description: '核对一下订单号，或者清空搜索看全部订单。' }
}

/** 「本次充值」里「按最近用量」后面那句：跟账号概览同一套说法（runwayDaysText），左边已经写了「按最近用量」，这里去掉打头那几个字。 */
export function rechargeRunwayText(days: number): string {
  return runwayDaysText(days).replace(/^按最近用量/, '')
}

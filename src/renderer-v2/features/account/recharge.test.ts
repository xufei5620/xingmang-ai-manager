import { describe, expect, it } from 'vitest'
import type { AccountSubscriptionSelf } from '../../../../electron/ipc-contract'
import {
  balancePurchaseLine,
  billingPreferenceNote,
  isSubscriptionTradeNo,
  orderPaidText,
  ordersSearchEmpty,
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
  topupCreditedUsd,
  topupGift,
} from './recharge'
import { creditedMoney } from './topup-tier'

type Subscription = AccountSubscriptionSelf['allSubscriptions'][number]

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 1,
    planId: 7,
    status: 'active',
    source: 'order',
    amountTotal: 1000,
    amountUsed: 320,
    startedAt: '2026-10-14T00:00:00Z',
    endsAt: '2026-11-13T12:00:00',
    nextResetAt: null,
    ...overrides,
  }
}

const duration = { durationUnit: 'day' as const, durationValue: 30, customSeconds: 0 }

describe('recharge', () => {
  it('credits a multiplier tier by its rate and treats other tiers as the credited amount', () => {
    expect(topupCreditedUsd(20)).toBe(20)
    expect(topupCreditedUsd(20, 1.1)).toBe(22)
    expect(topupCreditedUsd(15, 1 / 3)).toBe(5)
  })

  it('names the promotional gift in credited dollars for both kinds of account', () => {
    expect(topupGift(110, { discounts: { 110: 100 / 110 } })).toEqual({ bonus: 10, percent: 10 })
    expect(topupGift(20, { discounts: null })).toBeNull()
    expect(topupGift(100, { creditMultiplier: 1.2 })).toEqual({ bonus: 20, percent: 20 })
    // 倍数不到 1（一块钱买不到一美元）不是赠送。
    expect(topupGift(100, { creditMultiplier: 0.14 })).toBeNull()
    expect(topupGift(0, { creditMultiplier: 1.2 })).toBeNull()
  })

  it('writes plan prices with their currency and drops the decimals of whole amounts', () => {
    expect(planPriceText({ priceAmount: 10, currency: 'USD' })).toBe('$10')
    expect(planPriceText({ priceAmount: 9.9, currency: 'usd' })).toBe('$9.90')
    expect(planPriceText({ priceAmount: 68, currency: 'CNY' })).toBe('¥68')
    expect(planPriceText({ priceAmount: 5, currency: 'EUR' })).toBe('EUR 5')
    expect(planPriceText({ priceAmount: 5, currency: '' })).toBe('$5')
  })

  // 套餐价、订单标题、档位卡上的到账金额是同一种写法：整数不带小数，其余四舍五入到两位，
  // 不加千分位（跟 business-common 的 dollars 不一样）。三处逐字钉住，收成一份时一个字都不能变。
  it('writes plan prices, order titles and credited tiers with the same amount spelling', () => {
    const cases: Array<[number, string]> = [
      [0, '0'],
      [-0, '0'],
      [10, '10'],
      [23456, '23456'],
      [9.9, '9.90'],
      [9.95, '9.95'],
      [9.999, '10.00'],
      [0.1 + 0.2, '0.30'],
      [16.5, '16.50'],
      [1.005, '1.00'],
      [2.345, '2.35'],
      [0.004, '0.00'],
      [-3.5, '-3.50'],
      [-7, '-7'],
      [Number.MAX_SAFE_INTEGER, '9007199254740991'],
      [1e21, '1e+21'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
    ]
    for (const [value, text] of cases) {
      expect(planPriceText({ priceAmount: value, currency: 'USD' })).toBe(`$${text}`)
      expect(planPriceText({ priceAmount: value, currency: 'CNY' })).toBe(`¥${text}`)
      expect(orderTitle({ amount: value, tradeNo: 'USR7NOabc123' }, false)).toBe(`充值 $${text}`)
      expect(orderTitle({ amount: value, tradeNo: 'sub2_trade-31' }, true)).toBe(`充值 ¥${text}`)
      expect(creditedMoney(value)).toBe(`$${text}`)
    }
  })

  it('spells a plan period in days, months, years or hours and leaves out what it cannot tell', () => {
    expect(planDurationText(duration)).toBe('30 天')
    expect(planDurationText({ durationUnit: 'month', durationValue: 1, customSeconds: 0 })).toBe('1 个月')
    expect(planDurationText({ durationUnit: 'year', durationValue: 1, customSeconds: 0 })).toBe('1 年')
    expect(planDurationText({ durationUnit: 'hour', durationValue: 12, customSeconds: 0 })).toBe('12 小时')
    expect(planDurationText({ durationUnit: 'custom', durationValue: 0, customSeconds: 7 * 86_400 })).toBe('7 天')
    expect(planDurationText({ durationUnit: 'custom', durationValue: 0, customSeconds: 7_200 })).toBe('2 小时')
    expect(planDurationText({ durationUnit: 'custom', durationValue: 0, customSeconds: 90 })).toBeNull()
    expect(planDurationText({ durationUnit: 'day', durationValue: 0, customSeconds: 0 })).toBeNull()
  })

  it('follows the price with the period and the included quota when both are known', () => {
    expect(planTermText({ ...duration, totalAmount: 1000 }, 100)).toBe('/ 30 天，含 $10.00 额度')
    expect(planTermText({ ...duration, totalAmount: null }, 100)).toBe('/ 30 天')
    expect(planTermText({ ...duration, totalAmount: 1000 }, null)).toBe('/ 30 天')
    expect(planTermText({ durationUnit: 'custom', durationValue: 0, customSeconds: 90, totalAmount: 1000 }, 100)).toBe('含 $10.00 额度')
  })

  it('matches a plan card to its own active subscription but never to a Sub2API group id', () => {
    const own = subscription()
    expect(planSubscription({ id: 7 }, [subscription({ status: 'expired' }), own])).toBe(own)
    expect(planSubscription({ id: 8 }, [own])).toBeNull()
    expect(planSubscription({ id: 7 }, [subscription({ source: 'sub2api' })])).toBeNull()
  })

  it('says how much of a plan is used and when it ends', () => {
    const now = new Date('2026-10-15T08:00:00')
    expect(planUsageText(subscription(), 100, now)).toBe('已用 $3.20，11月13日到期')
    expect(planUsageText(subscription({ amountUsed: null }), 100, now)).toBe('11月13日到期')
    expect(planUsageText(subscription({ endsAt: '2027-01-02T12:00:00' }), 100, now)).toBe('已用 $3.20，2027年1月2日到期')
  })

  it('explains each billing order in one sentence', () => {
    expect(billingPreferenceNote('subscription_first')).toBe('订阅额度用完后自动改扣余额，不会中断。')
    expect(billingPreferenceNote('wallet_first')).toBe('余额用完后再扣订阅额度。')
    expect(billingPreferenceNote('subscription_only')).toBe('订阅额度用完后就停下，要再买订阅或换一种扣费顺序。')
    expect(billingPreferenceNote('wallet_only')).toBe('订阅额度留着不用，所有用量都从余额里扣。')
  })

  it('compares the balance with a dollar price only and says what is left or missing', () => {
    expect(balancePurchaseLine(12, { priceAmount: 10, currency: 'USD' })).toEqual({ text: '余额 $12.00，扣完剩 $2.00', short: false })
    expect(balancePurchaseLine(8.5, { priceAmount: 10, currency: 'USD' })).toEqual({ text: '余额 $8.50，还差 $1.50', short: true })
    expect(balancePurchaseLine(10, { priceAmount: 10, currency: 'USD' })).toEqual({ text: '余额 $10.00，扣完剩 $0.00', short: false })
    expect(balancePurchaseLine(100, { priceAmount: 68, currency: 'CNY' })).toEqual({ text: null, short: false })
    expect(balancePurchaseLine(null, { priceAmount: 10, currency: 'USD' })).toEqual({ text: null, short: false })
  })

  it('reports a redeemed balance code with the amount that arrived', () => {
    expect(redeemSuccessText({ quotaAdded: 500, type: 'balance' }, 100)).toBe('兑换成功，$5.00 已到账')
    expect(redeemSuccessText({ quotaAdded: 500 }, 0)).toBe('兑换成功，余额已更新')
    expect(redeemSuccessText({ quotaAdded: 0, type: 'subscription' }, 100)).toBe('订阅兑换成功')
    expect(redeemSuccessText({ quotaAdded: 0, type: 'concurrency' }, 100)).toBe('并发额度兑换成功')
  })

  it('writes order rows with the yuan sign only for yuan channels and says what an unpaid order means', () => {
    expect(orderPaidText({ money: 70, paymentProvider: 'epay', paymentMethod: 'alipay' })).toBe('¥70.00')
    expect(orderPaidText({ money: 10, paymentProvider: 'stripe', paymentMethod: 'stripe' })).toBe('10.00')
    expect(orderPaidText({ money: 0, paymentProvider: 'epay', paymentMethod: 'alipay' })).toBeNull()
    expect(orderTitle({ amount: 10, tradeNo: 'USR7NOabc123' }, false)).toBe('充值 $10')
    expect(orderTitle({ amount: 70, tradeNo: 'sub2_trade-31' }, true)).toBe('充值 ¥70')
    expect(orderTail({ status: 'pending', tradeNo: 'A' }, 'A')).toBe('，支付窗口开着')
    expect(orderTail({ status: 'pending', tradeNo: 'A' }, 'B')).toBe('，没付的话放着就行，不会扣钱')
    expect(orderTail({ status: 'failed', tradeNo: 'A' }, null)).toBe('，支付没有完成，没有扣款')
    expect(orderTail({ status: 'expired', tradeNo: 'A' }, null)).toBe('，没有付成功，不会扣钱')
    expect(orderTail({ status: 'success', tradeNo: 'A' }, null)).toBe('')
  })

  it('reuses the overview runway wording without repeating the row label', () => {
    expect(rechargeRunwayText(400)).toBe('够用一年以上')
    expect(rechargeRunwayText(0)).toBe('不到 1 天就会用完')
    expect(rechargeRunwayText(12)).toBe('约还能用 12 天')
  })

  // new-api writes a paid subscription into the top-up table with amount 0
  // (model/subscription.go upsertSubscriptionTopUpTx, rc.24 through rc.45).
  it('titles a paid subscription row instead of calling it a $0 top-up', () => {
    for (const tradeNo of ['SUBUSR7NOabc1231760000000', 'sub_ref_0a1b2c', 'WAFFO_PANCAKE_SUB-7-1760000000000-abcdef']) {
      expect(isSubscriptionTradeNo(tradeNo)).toBe(true)
      expect(orderTitle({ amount: 0, tradeNo }, false)).toBe('开通订阅')
    }
    for (const tradeNo of ['USR7NOabc1231760000000', 'ref_0a1b2c', 'WAFFO_PANCAKE-7-1760000000000-abcdef', 'XM-3']) {
      expect(isSubscriptionTradeNo(tradeNo)).toBe(false)
    }
    expect(orderTitle({ amount: 0, tradeNo: 'SUBUSR7NOabc' }, true)).toBe('充值 ¥0')
  })

  it('does not ask the customer to recheck the number of a subscription that has not been paid yet', () => {
    expect(ordersSearchEmpty(' SUBUSR7NOabc1231760000000 ', false)).toEqual({
      title: '这笔订阅还没开通',
      description: '订阅订单付款成功后才会出现在这里。没付的话放着就行，不会扣钱；手机上已经显示付款成功的话，稍后再查，超过 30 分钟还没开通请联系客服。',
    })
    expect(ordersSearchEmpty('USR7NOabc', false)).toEqual({ title: '没有找到这个订单', description: '核对一下订单号，或者清空搜索看全部订单。' })
    expect(ordersSearchEmpty('SUBUSR7NOabc', true).title).toBe('没有找到这个订单')
  })

  it('says a closed subscription window opens the plan rather than topping up the balance', () => {
    expect(paymentTerminalPresentation('closed', true, 'subscription').body).toBe('如果已经付过款，不用做什么：星芒还在确认，付款成功后订阅会自动开通。还没付的话，这笔订单放着就行，不会扣钱。')
    expect(paymentTerminalPresentation('closed', false, 'subscription').body).toBe('关闭支付窗口不会取消订单。付过款的话，付款成功后订阅会自动开通，也可以点「查看我的订单」核对。')
    expect(paymentTerminalPresentation('closed', true).body).toBe('如果已经付过款，不用做什么：星芒还在确认到账，到了会自动更新余额。还没付的话，这笔订单放着就行，不会扣钱。')
    expect(paymentTerminalPresentation('unconfirmed', false, 'subscription').title).toBe('还没查到这笔订单到账')
  })

  it('names the bought plan when a paid subscription opens', () => {
    expect(paymentTerminalBody({ status: 'success', tradeNo: 'XM-3' }, 'subscription', ' ')).toBe('订单 XM-3 已付款，订阅已开通。')
    expect(paymentTerminalBody({ status: 'success', tradeNo: null }, 'subscription', '专业版')).toBe('已付款，订阅已开通。')
  })
})

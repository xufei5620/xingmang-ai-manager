import { describe, expect, it } from 'vitest'
import { assertPaymentMethodShown, paymentMethodOffMessage, subscriptionPaymentType, withoutHiddenPaymentMethods } from './payment-methods-off'

describe('payment method switches', () => {
  const info = {
    onlineTopupEnabled: true,
    paymentMethods: [
      { name: '支付宝', type: 'alipay' },
      { name: '微信', type: 'WXPay' },
      { name: 'Stripe', type: 'stripe' },
    ],
  }

  it('drops hidden methods by type without caring about case, and keeps the rest of the info', () => {
    expect(withoutHiddenPaymentMethods(info, ['alipay', 'wxpay'])).toEqual({
      onlineTopupEnabled: true,
      paymentMethods: [{ name: 'Stripe', type: 'stripe' }],
    })
  })

  it('hands the same object back when nothing is hidden', () => {
    expect(withoutHiddenPaymentMethods(info, [])).toBe(info)
    expect(withoutHiddenPaymentMethods(info, ['qqpay'])).toBe(info)
  })

  it('names a subscription payment by the type the site lists it under', () => {
    expect(subscriptionPaymentType({ provider: 'epay', paymentMethod: 'alipay' })).toBe('alipay')
    expect(subscriptionPaymentType({ provider: 'stripe' })).toBe('stripe')
    expect(subscriptionPaymentType({ provider: 'waffo-pancake' })).toBe('waffo_pancake')
  })

  it('refuses a hidden method in plain words and lets the others through', () => {
    expect(() => assertPaymentMethodShown(' AliPay ', ['alipay'])).toThrow(paymentMethodOffMessage)
    expect(() => assertPaymentMethodShown('wxpay', ['alipay'])).not.toThrow()
    expect(() => assertPaymentMethodShown('alipay', [])).not.toThrow()
  })
})

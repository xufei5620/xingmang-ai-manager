import { describe, expect, it } from 'vitest'
import { paymentMethodLabel } from './payment-method-label'

describe('paymentMethodLabel', () => {
  it('turns bare channel codes into the names customers know', () => {
    expect(paymentMethodLabel({ name: 'alipay', type: 'alipay' })).toBe('支付宝')
    expect(paymentMethodLabel({ name: 'wxpay', type: 'wxpay' })).toBe('微信支付')
    expect(paymentMethodLabel({ name: '', type: 'alipay' })).toBe('支付宝')
  })

  it('keeps a display name the backend already set', () => {
    expect(paymentMethodLabel({ name: '支付宝', type: 'alipay' })).toBe('支付宝')
    expect(paymentMethodLabel({ name: 'Stripe', type: 'stripe' })).toBe('Stripe')
    expect(paymentMethodLabel({ name: '花呗分期', type: 'alipay' })).toBe('花呗分期')
  })

  it('leaves unknown codes as they are', () => {
    expect(paymentMethodLabel({ name: 'paypal', type: 'paypal' })).toBe('paypal')
  })

  it('names an order record the same way, though orders carry only the channel code', () => {
    expect(paymentMethodLabel({ name: '', type: 'alipay' })).toBe('支付宝')
    expect(paymentMethodLabel({ name: '', type: 'wxpay' })).toBe('微信支付')
    expect(paymentMethodLabel({ name: '', type: 'qqpay' })).toBe('QQ 钱包')
    expect(paymentMethodLabel({ name: '', type: 'stripe' })).toBe('Stripe')
    expect(paymentMethodLabel({ name: '', type: 'paypal' })).toBe('paypal')
    expect(paymentMethodLabel({ name: '', type: '' })).toBe('')
  })
})

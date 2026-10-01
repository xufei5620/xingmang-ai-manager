import { describe, expect, it } from 'vitest'
import { describeTopupTier, isQuotableAmount, payableSymbol } from './topup-tier'

describe('describeTopupTier', () => {
  it('shows credited, paid and bonus for a discounted tier', () => {
    expect(describeTopupTier({ amount: 110, quote: 100, discounts: { 110: 100 / 110 }, provider: 'epay' })).toEqual({
      credited: '$110',
      paid: '¥100.00',
      bonus: '送 10%',
      hasBonus: true,
      label: '到账 $110，实付 ¥100.00，送 10%',
    })
  })

  it('says there is no bonus when the account has no discount for the tier', () => {
    const tier = describeTopupTier({ amount: 50, quote: 365, discounts: {}, provider: 'epay' })
    expect(tier.bonus).toBe('无赠送')
    expect(tier.hasBonus).toBe(false)
    expect(tier.label).toBe('到账 $50，实付 ¥365.00，无赠送')
  })

  it('leaves the currency symbol off for channels that settle in their own currency', () => {
    expect(describeTopupTier({ amount: 20, quote: 16, discounts: { 20: 0.8 }, provider: 'stripe' }).paid).toBe('16.00')
    expect(payableSymbol(undefined)).toBe('')
  })

  it('shows a pending paid amount while the quote is on its way', () => {
    expect(describeTopupTier({ amount: 10, quote: 'loading', discounts: undefined, provider: 'epay' }).paid).toBe('正在计算')
    expect(describeTopupTier({ amount: 10, quote: undefined, discounts: undefined, provider: 'epay' }).paid).toBe('正在计算')
  })

  it('drops the paid amount instead of showing an error when the quote fails', () => {
    const tier = describeTopupTier({ amount: 240, quote: 'failed', discounts: { 240: 200 / 240 }, provider: 'epay' })
    expect(tier.paid).toBeNull()
    expect(tier.label).toBe('到账 $240，送 20%')
  })
})

describe('describeTopupTier for accounts whose tiers are the amount paid', () => {
  it('credits the tier times the multiplier and shows the same bonus on every tier', () => {
    expect(describeTopupTier({ amount: 200, quote: 200, discounts: {}, provider: 'epay', creditMultiplier: 1.1 })).toMatchObject({
      credited: '$220',
      paid: '¥200.00',
      bonus: '送 10%',
      label: '到账 $220，实付 ¥200.00，送 10%',
    })
    expect(describeTopupTier({ amount: 15, quote: 15, discounts: {}, provider: 'epay', creditMultiplier: 1.1 }).credited).toBe('$16.50')
  })

  it('shows no bonus when the multiplier is one', () => {
    expect(describeTopupTier({ amount: 10, quote: 10, discounts: {}, provider: 'epay', creditMultiplier: 1 })).toMatchObject({
      credited: '$10',
      bonus: '无赠送',
      hasBonus: false,
    })
  })
})

describe('isQuotableAmount', () => {
  it('only quotes whole amounts at or above the minimum', () => {
    expect(isQuotableAmount(10, 1)).toBe(true)
    expect(isQuotableAmount(5, 10)).toBe(false)
    expect(isQuotableAmount(12.5, 1)).toBe(false)
    expect(isQuotableAmount(Number.NaN, 1)).toBe(false)
    expect(isQuotableAmount(0, 0)).toBe(false)
  })
})

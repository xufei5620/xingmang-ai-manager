import { describe, expect, it } from 'vitest'
import { usageDetailFixture } from '../../testing/usage-fixture'
import { normalizedUsageTier, usageBillingMode, usageMoney, usageNumber, usageTierCondition, usageUnitPrice } from './usage-detail-view'

describe('usage detail formatting', () => {
  it('keeps billed amounts precise and distinguishes zero, missing, and tiny charges', () => {
    expect(usageMoney(0.7726)).toBe('$0.7726')
    expect(usageMoney(0.000002)).toBe('$0.000002')
    expect(usageMoney(0)).toBe('$0.0000')
    expect(usageMoney(null)).toBe('未提供')
    expect(usageMoney(Number.NaN)).toBe('未提供')
    expect(usageMoney(0.000000001)).toBe('< $0.00000001')
    expect(usageMoney(-0.7726)).toBe('-$0.7726')
  })

  it('shows token counts and USD per million prices without group multiplication', () => {
    expect(usageNumber(368531)).toBe('368,531')
    expect(usageNumber(4778)).toBe('4,778')
    expect(usageUnitPrice(25)).toBe('$25/M')
    expect(usageUnitPrice(0)).toBe('$0/M')
    expect(usageUnitPrice(null)).toBe('未提供')
    expect(usageUnitPrice(0.000000001)).toBe('< $0.00000001/M')
  })

  it('uses the logged mode and does not mislabel a zero model price as per-call billing', () => {
    const record = usageDetailFixture('legacy')
    record.details.modelPrice = 0
    expect(usageBillingMode(record)).toBe('按 Token 计费')
    record.details.modelPrice = 0.1
    expect(usageBillingMode(record)).toBe('按次计费')
    record.details.billingMode = 'tiered_expr'
    expect(usageBillingMode(record)).toBe('动态计费')
  })

  it('uses the same tier-label normalization as the backend while preserving threshold units', () => {
    expect(normalizedUsageTier(' LONG ')).toBe('long')
    expect(usageTierCondition({ variable: 'length', operator: '<', value: 272000 })).toBe('上下文长度 < 272,000')
  })
})

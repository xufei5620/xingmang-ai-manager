import { describe, expect, it } from 'vitest'
import { parseAccountUsageDetails, parseAccountUsageRecord } from './new-api-client'
import { parseNewApiUsagePricing, parseUsagePricingTiers } from './usage-pricing-parser'

const encoded = (expression: string) => Buffer.from(expression, 'utf8').toString('base64')
const exampleExpression = 'len < 272000 ? tier("short", p * 10 + c * 50 + cr * 1 + cc * 12.5 + cc1h * 12.5) : tier("long", p * 25 + c * 75 + cr * 2 + cc * 25 + cc1h * 25)'

describe('account usage pricing', () => {
  it('preserves the actual request metadata and resolves the displayed long-context tariff', () => {
    const record = parseAccountUsageRecord({
      id: 12, created_at: 1_789_189_200, type: 2, model_name: 'gpt-6-astra',
      prompt_tokens: 368_531, completion_tokens: 311, quota: 386_300,
      token_name: 'xingmang-desktop-codex', group: 'GPT-中转/订阅',
      use_time: 16, is_stream: true, request_id: 'request-123',
      other: JSON.stringify({
        cache_tokens: 368_000, frt: 4_778, reasoning_effort: 'xhigh',
        billing_mode: 'tiered_expr', expr_b64: encoded(exampleExpression),
        matched_tier: 'long', group_ratio: 1, model_ratio: 999,
      }),
    })
    expect(record).toMatchObject({
      promptTokens: 368_531, completionTokens: 311, quota: 386_300,
      tokenName: 'xingmang-desktop-codex', group: 'GPT-中转/订阅', useTimeSeconds: 16,
      details: {
        cacheTokens: 368_000, firstResponseTimeMs: 4_778, reasoningEffort: 'xhigh',
        matchedTier: 'long', groupRatio: 1,
        unitPrices: { input: 25, output: 75, cacheRead: 2, cacheCreation: 25, cacheCreation1h: 25 },
      },
    })
    expect(record?.details.pricingTiers).toMatchObject([
      {
        label: 'short', conditions: [{ variable: 'length', operator: '<', value: 272_000 }],
        prices: { input: 10, output: 50, cacheRead: 1, cacheCreation: 12.5, cacheCreation1h: 12.5 },
      },
      { label: 'long', conditions: [], prices: { input: 25, output: 75 } },
    ])
    expect(JSON.stringify(record)).not.toContain('expr_b64')
    expect(JSON.stringify(record)).not.toContain('tier(')
  })

  it('normalizes legacy ratios to USD/M without applying the group multiplier twice', () => {
    const details = parseAccountUsageDetails({
      model_price: -1, model_ratio: 1.5, completion_ratio: 5,
      cache_ratio: 0.1, cache_creation_ratio: 1.25,
      cache_creation_ratio_5m: 1.25, cache_creation_ratio_1h: 2,
      image_ratio: 2, audio_ratio: 3, audio_completion_ratio: 4,
      group_ratio: 0.5, user_group_ratio: 0.25,
    })
    expect(details.unitPrices).toEqual({
      input: 3, output: 15, cacheRead: expect.closeTo(0.3), cacheCreation: 3.75,
      cacheCreation5m: 3.75, cacheCreation1h: 6, imageInput: 6,
      imageOutput: null, audioInput: 9, audioOutput: 36,
    })
    expect(details).toMatchObject({ groupRatio: 0.5, userGroupRatio: 0.25 })
  })

  it('requires both audio ratios and applies the backend audio output tariff', () => {
    const pricing = parseNewApiUsagePricing({ model_ratio: 1.5, audio_ratio: 3, audio_completion_ratio: 4 })
    // calculateAudioQuota bills audio output as token count * model ratio *
    // audio ratio * audio completion ratio (500,000 quota units per USD).
    const audioOutputTokens = 250_000
    const quota = audioOutputTokens * 1.5 * 3 * 4
    expect(pricing.unitPrices?.audioOutput).toBe(36)
    expect(audioOutputTokens / 1_000_000 * pricing.unitPrices!.audioOutput!).toBe(quota / 500_000)
    expect(parseNewApiUsagePricing({ model_ratio: 1.5, audio_completion_ratio: 4 }).unitPrices?.audioOutput).toBeNull()
    expect(parseNewApiUsagePricing({ model_ratio: 1.5, audio_ratio: 3 }).unitPrices?.audioOutput).toBeNull()
    expect(parseNewApiUsagePricing({ model_ratio: 1.5, audio_ratio: 0, audio_completion_ratio: 4 }).unitPrices?.audioOutput).toBe(0)
  })

  it('retains unknown prices as null and accepts explicitly free token prices', () => {
    expect(parseNewApiUsagePricing({})).toEqual({})
    expect(parseNewApiUsagePricing({ model_price: 2, model_ratio: 1 })).toEqual({})
    expect(parseNewApiUsagePricing({ model_ratio: -1 })).toEqual({})
    expect(parseNewApiUsagePricing({ model_ratio: Number.POSITIVE_INFINITY })).toEqual({})
    expect(parseNewApiUsagePricing({ model_ratio: Number.MAX_VALUE })).toEqual({})
    expect(parseNewApiUsagePricing({ model_price: 0, model_ratio: 0, completion_ratio: 3 }).unitPrices)
      .toMatchObject({ input: 0, output: 0, cacheRead: null })
    expect(parseNewApiUsagePricing({ model_ratio: 1, completion_ratio: -1 }).unitPrices?.output).toBeNull()
  })

  it('never guesses the matched dynamic tier or falls back to a legacy model ratio', () => {
    for (const matched_tier of [undefined, '', 'unknown']) {
      const pricing = parseNewApiUsagePricing({
        billing_mode: 'tiered_expr', expr_b64: encoded(exampleExpression), matched_tier, model_ratio: 99,
      })
      expect(pricing.pricingTiers).toHaveLength(2)
      expect(pricing.unitPrices).toBeUndefined()
    }
    const duplicate = 'p < 10 ? tier("base", p * 1) : tier(" base ", p * 2)'
    expect(parseNewApiUsagePricing({
      billing_mode: 'tiered_expr', expr_b64: encoded(duplicate), matched_tier: 'BASE',
    }).unitPrices).toBeUndefined()
  })

  it('accepts versioned tiers, inclusive conditions, Unicode labels, scientific notation and media fields', () => {
    const tiers = parseUsagePricingTiers(encoded(
      'v1:(p <= 2e5 && c >= 1.5e+3 ? tier("标准", p * 3 + c * 15 + img * 3 + img_o * 30 + ai * 10 + ao * 40) : tier("长上下文", p * 6 + c * 22.5))',
    ))
    expect(tiers).toMatchObject([
      {
        label: '标准', conditions: [
          { variable: 'input', operator: '<=', value: 200_000 },
          { variable: 'output', operator: '>=', value: 1_500 },
        ],
        prices: { imageInput: 3, imageOutput: 30, audioInput: 10, audioOutput: 40, cacheRead: null },
      },
      { label: '长上下文', conditions: [] },
    ])
    expect(parseUsagePricingTiers(encoded('len > 100 ? tier("large", p * 2) : p * 0 + c * 0'))).toHaveLength(1)
  })

  it('rejects unknown or executable syntax in full instead of extracting misleading partial prices', () => {
    const invalidExpressions = [
      'tier("base", p * 2) * 100',
      'tier("base", p * 2 + c * 3); globalThis.__usagePricingExecuted = true',
      'tier("base", p * 2 + c * 3) + require("fs")',
      'tier("base", p * 2 * 100 + c * 3)',
      'tier("base", p * 2 + p * 8)',
      'tier("base", p * -2 + c * 3)',
      'tier("base", p * 1e999 + c * 3)',
      'tier("base", p * NaN + c * 3)',
      'tier("base", p * 2 + unknown * 3)',
      'tier("base", p * 2 + c * 3) trailing',
      'len < 10 ? tier("small", p * 2) : tier("large", p * 3) garbage',
      'v3:tier("base", p * 2)',
    ]
    for (const expression of invalidExpressions) {
      expect(parseUsagePricingTiers(encoded(expression)), expression).toEqual([])
    }
    expect(Object.hasOwn(globalThis, '__usagePricingExecuted')).toBe(false)
  })

  it('bounds expressions, nesting, tiers and conditions and rejects malformed encodings', () => {
    expect(parseUsagePricingTiers('%%%')).toEqual([])
    expect(parseUsagePricingTiers(Buffer.from([0xff, 0xfe]).toString('base64'))).toEqual([])
    expect(parseUsagePricingTiers(encoded(`tier("${'x'.repeat(129)}", p * 1)`))).toEqual([])
    expect(parseUsagePricingTiers(encoded(`tier("bad\nlabel", p * 1)`))).toEqual([])
    expect(parseUsagePricingTiers(encoded(`${'('.repeat(40)}tier("x", p * 1)${')'.repeat(40)}`))).toEqual([])
    expect(parseUsagePricingTiers(encoded(`${'p < 10 ? tier("x", p * 1) : '.repeat(33)}tier("last", p * 2)`))).toEqual([])
    expect(parseUsagePricingTiers(encoded(`${Array(9).fill('p < 10').join(' && ')} ? tier("x", p * 1) : tier("y", p * 2)`))).toEqual([])
    expect(parseUsagePricingTiers(encoded(' '.repeat(32_769)))).toEqual([])
  })

  it('keeps sensitive extra fields and formulas out of the explicit usage DTO', () => {
    const details = parseAccountUsageDetails({
      billing_mode: 'tiered_expr', expr_b64: encoded('tier("base", p * 2 + c * 4)'),
      matched_tier: 'base', admin_info: { api_key: 'secret-123' }, ip: '127.0.0.1',
      tier_admin_rules: { password: 'hidden-password' },
    })
    expect(details.unitPrices?.input).toBe(2)
    expect(JSON.stringify(details)).not.toMatch(/expr_b64|tier\(|secret-123|hidden-password|127\.0\.0\.1/)
    expect(parseAccountUsageDetails('bad json').unitPrices).toBeUndefined()
  })
})

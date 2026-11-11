import { describe, expect, it } from 'vitest'
import { buildAccountPriceList } from './account-price-list'
import type { NewApiModelPrice } from './new-api-client'

function model(patch: Partial<NewApiModelPrice> & { model: string }): NewApiModelPrice {
  return { quotaType: 0, modelPrice: 0, expressionPriced: false, ...patch }
}

describe('account price list', () => {
  it('prices token models per million tokens at each group ratio, output by the completion ratio', () => {
    const list = buildAccountPriceList({
      models: [model({ model: 'gpt-5.6-sol', modelRatio: 0.625, completionRatio: 8, groups: ['GPT', 'default'] })],
      groupRatios: { GPT: 1, default: 2 },
    })
    expect(list.rows).toEqual([
      { model: 'gpt-5.6-sol', group: 'default', kind: 'token', input: 2.5, output: 20 },
      { model: 'gpt-5.6-sol', group: 'GPT', kind: 'token', input: 1.25, output: 10 },
    ])
  })

  it('treats a missing completion ratio as output priced like input', () => {
    const list = buildAccountPriceList({ models: [model({ model: 'embed', modelRatio: 0.05, groups: ['GPT'] })], groupRatios: { GPT: 1 } })
    expect(list.rows).toEqual([{ model: 'embed', group: 'GPT', kind: 'token', input: 0.1, output: 0.1 }])
  })

  it('prices per-call models per call, and gives tiered models a row without a number', () => {
    const list = buildAccountPriceList({
      models: [
        model({ model: 'gpt-image-2', quotaType: 1, modelPrice: 0.04, groups: ['图片模型'] }),
        model({ model: 'claude-tiered', expressionPriced: true, modelRatio: 1, groups: ['Claude'] }),
      ],
      groupRatios: { 图片模型: 1.5, Claude: 1 },
    })
    // Groups sort the way the zh-CN collation puts them, which is Chinese names first.
    expect(list.rows).toEqual([
      { model: 'gpt-image-2', group: '图片模型', kind: 'call', perCall: 0.06 },
      { model: 'claude-tiered', group: 'Claude', kind: 'tiered' },
    ])
  })

  it('lists a model enabled for all groups under every usable group, and skips groups this account cannot use', () => {
    const list = buildAccountPriceList({
      models: [
        model({ model: 'everywhere', modelRatio: 1, completionRatio: 1, groups: ['all'] }),
        model({ model: 'elsewhere', modelRatio: 1, completionRatio: 1, groups: ['vip', 'GPT'] }),
      ],
      groupRatios: { GPT: 1, Claude: 1 },
    })
    expect(list.rows.map((row) => `${row.group}/${row.model}`)).toEqual(['Claude/everywhere', 'GPT/elsewhere', 'GPT/everywhere'])
  })

  it('leaves out entries it cannot price rather than showing a wrong number', () => {
    const list = buildAccountPriceList({
      models: [
        model({ model: 'no-groups', modelRatio: 1 }),
        model({ model: 'no-ratio', groups: ['GPT'] }),
        model({ model: 'absurd', modelRatio: 1e9, groups: ['GPT'] }),
        model({ model: 'absurd-call', quotaType: 1, modelPrice: 1e9, groups: ['GPT'] }),
        model({ model: 'unknown-type', quotaType: 7, modelRatio: 1, groups: ['GPT'] }),
      ],
      groupRatios: { GPT: 1 },
    })
    expect(list.rows).toEqual([])
  })

  it('does not treat inherited object keys as usable groups', () => {
    const list = buildAccountPriceList({ models: [model({ model: 'm', modelRatio: 1, groups: ['constructor', 'toString'] })], groupRatios: {} })
    expect(list.rows).toEqual([])
  })
})

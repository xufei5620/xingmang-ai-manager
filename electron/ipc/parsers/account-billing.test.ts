import { describe, expect, it } from 'vitest'
import { parseAccountAffiliateTransferInput, parseAccountTopupOrdersQuery } from './account-billing'

describe('parseAccountTopupOrdersQuery', () => {
  it('trims the order search keyword', () => {
    expect(parseAccountTopupOrdersQuery({ page: 2, pageSize: 20, keyword: ' trade-7 ' }))
      .toEqual({ page: 2, pageSize: 20, keyword: 'trade-7' })
  })

  it('treats a keyword made only of spaces as no keyword', () => {
    // 中文输入法下按空格出的是全角空格（U+3000）。
    for (const keyword of ['', ' ', '　', ' 　\t ', ' '.repeat(128)]) {
      expect(parseAccountTopupOrdersQuery({ page: 1, pageSize: 20, keyword }))
        .toEqual({ page: 1, pageSize: 20, keyword: undefined })
    }
  })

  it('still rejects a keyword that is too long, carries NUL or is not a string', () => {
    for (const keyword of [' '.repeat(129), 'x'.repeat(129), 'trade\0-7', 7, null, ['trade-7']]) {
      expect(() => parseAccountTopupOrdersQuery({ keyword })).toThrow('订单搜索词格式错误')
    }
  })
})

describe('parseAccountAffiliateTransferInput', () => {
  it('keeps the Xingmang account on whole quota units', () => {
    expect(parseAccountAffiliateTransferInput({ quota: 500_000 })).toEqual({ quota: 500_000 })
    for (const quota of [0, -1, 1.5, 3.456, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100', null]) {
      expect(() => parseAccountAffiliateTransferInput({ quota })).toThrow('邀请额度格式错误')
      expect(() => parseAccountAffiliateTransferInput({ quota }, false)).toThrow('邀请额度格式错误')
    }
  })

  it('passes a historical account rebate with cents through unrounded', () => {
    // 历史账号 1 个单位 = 1 美元，返利按比例算出来带小数；后台只收和可转返利一分不差的全额（余额 F4）。
    for (const quota of [3.5, 3.456, 0.01, 1e-7, 100]) {
      expect(parseAccountAffiliateTransferInput({ quota }, true)).toEqual({ quota })
    }
  })

  it('still rejects a historical account amount that is not a finite positive number', () => {
    for (const quota of [0, -0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '3.5', null, undefined, [3.5]]) {
      expect(() => parseAccountAffiliateTransferInput({ quota }, true)).toThrow('邀请额度格式错误')
    }
    for (const value of [null, 3.5, '3.5', [3.5]]) {
      expect(() => parseAccountAffiliateTransferInput(value, true)).toThrow('邀请额度转余额信息格式错误')
    }
  })
})

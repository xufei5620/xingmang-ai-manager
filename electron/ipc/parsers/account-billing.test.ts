import { describe, expect, it } from 'vitest'
import { parseAccountTopupOrdersQuery } from './account-billing'

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

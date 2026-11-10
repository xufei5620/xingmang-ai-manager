import { describe, expect, it } from 'vitest'
import type { AccountDashboardData } from '../../../../electron/ipc-contract'
import { spendSegmentQuery } from './account-center'
import {
  frequentModels,
  priceListCells,
  priceListMoney,
  mergeDashboards,
  modelShares,
  modelShareTitle,
  quickFilterQuery,
  sub2ApiFilterId,
  usageCalendarNote,
  usageChartScale,
  usageEmptyText,
  usageFailedFree,
  usageHourBlocks,
  usageRangeStart,
  usageSegments,
  usageStatus,
  usageTickText,
} from './usage'

// 本机时间构造，换了时区跑结果也一样。
const now = new Date(2026, 9, 15, 10, 30)
const seconds = (date: Date) => Math.floor(date.getTime() / 1000)

function dashboard(quota: number, models: Array<[string, number, number]>): AccountDashboardData {
  return {
    startTimestamp: 0,
    endTimestamp: 0,
    discardedCount: 0,
    quota,
    count: models.reduce((sum, [, count]) => sum + count, 0),
    tokens: 1000,
    models: models.map(([model, count, modelQuota]) => ({ model, count, tokens: 500, quota: modelQuota })),
    buckets: [],
    coverage: 'range',
  }
}

function bucket(at: Date, quota: number): AccountDashboardData['buckets'][number] {
  return { timestamp: seconds(at), quota, count: 1, tokens: 10, models: {} }
}

describe('usage', () => {
  it('starts the day ranges at local midnight and the 24 hour range no later than a day ago', () => {
    expect(usageRangeStart('1', now)).toBeLessThanOrEqual(seconds(now) - 86_400)
    expect(usageRangeStart('7', now)).toBe(seconds(new Date(2026, 9, 9)))
    expect(usageRangeStart('30', now)).toBe(seconds(new Date(2026, 8, 16)))
  })

  it('backs the 24 hour range off to the whole hour so the oldest hourly row still comes back', () => {
    // new-api 把看板数据记在整点上（created_at - created_at % 3600），只回 created_at >= 起点的行。
    const at = new Date(Date.UTC(2026, 9, 15, 2, 34, 55))
    const start = usageRangeStart('1', at)
    expect(start).toBe(Date.UTC(2026, 9, 14, 2) / 1000)
    const used = seconds(at) - 86_400 + 60
    expect(used - used % 3_600).toBeGreaterThanOrEqual(start)
    expect(usageRangeStart('1', new Date(Date.UTC(2026, 9, 15, 2)))).toBe(Date.UTC(2026, 9, 14, 2) / 1000)
  })

  it('gives the week one bar per local day, titled like the overview without the amount', () => {
    const days = usageSegments('7', now)
    expect(days).toHaveLength(7)
    expect(days[6]).toMatchObject({ label: '今天', start: new Date(2026, 9, 15).getTime(), end: now.getTime() })
    expect(days[6].title).toBe('10月15日 周四')
    expect(days[0].start).toBe(new Date(2026, 9, 9).getTime())
  })

  it('gives the month one bar per week counted back from today, the oldest one shorter', () => {
    const weeks = usageSegments('30', now)
    expect(weeks).toHaveLength(5)
    expect(weeks[4]).toMatchObject({ label: '10/9', title: '10月9日至10月15日', end: now.getTime() })
    expect(weeks[0]).toMatchObject({ label: '9/16', title: '9月16日至9月17日' })
    expect(weeks[1].start).toBe(weeks[0].end)
  })

  it('never counts the second where two bars meet twice', () => {
    const [first, second] = usageSegments('7', now)
    const a = spendSegmentQuery(first, false)
    const b = spendSegmentQuery(second, false)
    expect(a.endTimestamp).toBe(b.startTimestamp - 1)
    expect(spendSegmentQuery({ start: 0, end: now.getTime() }, true).endTimestamp).toBe(seconds(now))
  })

  it('folds hourly buckets into four hour blocks on the local clock', () => {
    const start = usageRangeStart('1', now)
    const blocks = usageHourBlocks(start, now, [
      bucket(new Date(2026, 9, 15, 9), 30),
      bucket(new Date(2026, 9, 15, 8, 30), 20),
      bucket(new Date(2026, 9, 14, 13), 5),
    ])
    expect(blocks[0]).toMatchObject({ label: '8 点', start: new Date(2026, 9, 14, 8).getTime(), quota: 0 })
    expect(blocks.at(-1)).toMatchObject({ label: '8 点', title: '10月15日 8 点', quota: 50 })
    expect(blocks.find((block) => block.start === new Date(2026, 9, 14, 12).getTime())?.quota).toBe(5)
    expect(blocks).toHaveLength(7)
  })

  it('adds up the parts and merges models of the same name', () => {
    const merged = mergeDashboards([dashboard(10, [['a', 1, 6], ['b', 2, 4]]), dashboard(5, [['a', 3, 5]])])
    expect(merged.quota).toBe(15)
    expect(merged.count).toBe(6)
    expect(merged.tokens).toBe(2000)
    expect(merged.models).toEqual([{ model: 'a', count: 4, tokens: 1000, quota: 11 }, { model: 'b', count: 2, tokens: 500, quota: 4 }])
  })

  it('picks a round chart top with at most four steps', () => {
    expect(usageChartScale([0, 0])).toEqual({ top: 0, ticks: [] })
    expect(usageChartScale([1.3, 0.2])).toEqual({ top: 1.5, ticks: [0, 0.5, 1, 1.5] })
    expect(usageChartScale([7.2])).toEqual({ top: 8, ticks: [0, 2, 4, 6, 8] })
    expect(usageChartScale([0.03])).toEqual({ top: 0.03, ticks: [0, 0.01, 0.02, 0.03] })
    expect(usageTickText(1, [0, 0.5, 1])).toBe('$1.0')
    expect(usageTickText(4, [0, 2, 4])).toBe('$4')
  })

  it('lists the five costliest models with their share of the spend', () => {
    const models = dashboard(0, [['a', 1, 50], ['b', 9, 30], ['c', 1, 10], ['d', 1, 5], ['e', 1, 3], ['f', 1, 2]]).models
    const shares = modelShares(models)
    expect(shares.map((model) => model.model)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(shares[0].percent).toBe(50)
    expect(modelShareTitle({ count: 1234, tokens: 5678 })).toBe('1,234 次请求，5,678 Token')
    expect(frequentModels(models)).toEqual(['b', 'a'])
  })

  it('turns the quick filters into the query fields', () => {
    expect(quickFilterQuery('all')).toEqual({})
    expect(quickFilterQuery('fail')).toEqual({ type: 5 })
    expect(quickFilterQuery('model:gpt-5')).toEqual({ modelName: 'gpt-5' })
  })

  it('says whether a failed call was charged', () => {
    expect(usageStatus({ type: 2, quota: 10 })).toEqual({ label: '成功', tone: 'ok' })
    expect(usageStatus({ type: 5, quota: 0 })).toEqual({ label: '失败，未扣费', tone: 'warn' })
    expect(usageStatus({ type: 5, quota: 3 })).toEqual({ label: '失败', tone: 'bad' })
    expect(usageStatus({ type: 6, quota: 0 })).toEqual({ label: '退款', tone: 'neutral' })
    expect(usageFailedFree({ type: 5, quota: 0 })).toBe(true)
    expect(usageFailedFree({ type: 2, quota: 0 })).toBe(false)
  })

  it('words an empty list by what was filtered', () => {
    expect(usageEmptyText(false, false)).toEqual({ title: '这段时间没有调用', description: '' })
    expect(usageEmptyText(true, false)).toEqual({ title: '这段时间没有调用', description: '换个筛选条件看看。' })
    expect(usageEmptyText(true, true)).toEqual({ title: '这段时间没有失败的调用', description: '换个筛选条件看看。' })
  })

  it('accepts only positive whole numbers for the Sub2API key and group filters', () => {
    expect(sub2ApiFilterId(undefined)).toBeUndefined()
    expect(sub2ApiFilterId('')).toBeUndefined()
    expect(sub2ApiFilterId('4')).toBe(4)
    expect(() => sub2ApiFilterId('0')).toThrow('密钥编号和分组编号要填正整数。')
    expect(() => sub2ApiFilterId('1.5')).toThrow('密钥编号和分组编号要填正整数。')
  })

  it('leaves the time zone out of the calendar note on a Beijing clock and says it follows this computer otherwise', () => {
    const instant = new Date(Date.UTC(2026, 10, 9, 16, 30))
    const plain = '按整日统计，包含结束日期全天，默认最近 7 天。'
    expect(usageCalendarNote('Asia/Shanghai', instant)).toBe(plain)
    // 跟北京同一个钟的时区也不提。
    expect(usageCalendarNote('Asia/Hong_Kong', instant)).toBe(plain)
    expect(usageCalendarNote('Asia/Tokyo', instant)).toBe(`${plain}按这台电脑的时间算。`)
    expect(usageCalendarNote('America/Los_Angeles', instant)).toBe(`${plain}按这台电脑的时间算。`)
    expect(usageCalendarNote('UTC', instant)).toBe(`${plain}按这台电脑的时间算。`)
    expect(usageCalendarNote('Not/A_Zone', instant)).toBe(`${plain}按这台电脑的时间算。`)
    for (const note of [usageCalendarNote('Asia/Tokyo', instant), usageCalendarNote('Asia/Shanghai', instant)]) expect(note).not.toMatch(/[A-Za-z]/)
  })
})

describe('usage price table cells', () => {
  it('shows at least two decimals, more for cheap models, and never rounds a tiny price down to zero', () => {
    expect(priceListMoney(10)).toBe('$10.00')
    expect(priceListMoney(1.25)).toBe('$1.25')
    expect(priceListMoney(0.075)).toBe('$0.075')
    expect(priceListMoney(0)).toBe('$0.00')
    expect(priceListMoney(0.0000001)).toBe('< $0.000001')
  })

  it('puts a per-call price in the input cell and gives tiered pricing words instead of a number', () => {
    expect(priceListCells({ model: 'm', group: 'g', kind: 'token', input: 1.25, output: 10 })).toEqual({ input: '$1.25', output: '$10.00' })
    expect(priceListCells({ model: 'm', group: 'g', kind: 'call', perCall: 0.04 })).toEqual({ input: '$0.04 / 次', output: '—' })
    expect(priceListCells({ model: 'm', group: 'g', kind: 'tiered' })).toEqual({ input: '分档计价', output: '—' })
  })
})

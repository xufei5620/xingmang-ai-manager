import { describe, expect, it } from 'vitest'
import type { XingmangApi } from '../../../../electron/ipc-contract'
import { createWeekSpendLoader, readSettledWeekSpend, sameWeekSpend, weekSpendDays, weekSpendHint, weekSpendKey, weekSpendLabel, type WeekSpend, type WeekSpendStorage } from './week-spend'

type Range = { startTimestamp: number; endTimestamp: number }

function fixture(sessions: Array<{ userId: number }>, coverage: string = 'range') {
  const asked: Range[] = []
  let session = 0
  const bridge = {
    getAccountSession: async () => ({ siteId: 'solov', account: sessions[Math.min(session, sessions.length - 1)] }),
    getAccountDashboard: async (range: Range) => {
      asked.push(range)
      // 每天花的额度 = 那天 0 点所在的日期号，看得出是哪一天。
      return { quota: new Date(range.startTimestamp * 1000).getDate() * 1000, coverage }
    },
  } as unknown as Pick<XingmangApi, 'getAccountSession' | 'getAccountDashboard'>
  return { bridge, asked, nextAccount: () => { session += 1 } }
}

function memoryStorage(): WeekSpendStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) } }
}

function askedDates(asked: Range[]): number[] {
  return asked.map((range) => new Date(range.startTimestamp * 1000).getDate())
}

describe('home week spend', () => {
  it('splits the last seven local days, ending today at the current moment', () => {
    const now = new Date(2026, 9, 15, 14, 30)
    const days = weekSpendDays(now)
    expect(days).toHaveLength(7)
    expect(days[0].start).toBe(new Date(2026, 9, 9).getTime())
    expect(days[6].start).toBe(new Date(2026, 9, 15).getTime())
    expect(days[6].end).toBe(now.getTime())
    // 过完的天截到下一天 0 点的前一秒，相邻两天不会把同一刻算两遍。
    expect(days[0].end).toBe(new Date(2026, 9, 10).getTime() - 1000)
    for (let index = 1; index < days.length; index++) expect(days[index].start).toBe(days[index - 1].end + 1000)
  })

  it('names each bar by its weekday and the last one 今天', () => {
    expect(weekSpendLabel(new Date(2026, 9, 15).getTime(), false)).toBe('周四')
    expect(weekSpendLabel(new Date(2026, 9, 15).getTime(), true)).toBe('今天')
    expect(weekSpendHint(new Date(2026, 9, 8).getTime(), 1.2)).toBe('10月8日 周四：$1.20')
  })

  it('asks for each day once and afterwards only for today', async () => {
    const { bridge, asked } = fixture([{ userId: 7 }])
    let now = new Date(2026, 9, 15, 14, 30)
    const loader = createWeekSpendLoader(bridge, () => now)
    const first = await loader.read()
    expect(first.scope).toBe('xm-account:7')
    expect(first.days.map((day) => day.quota)).toEqual([9, 10, 11, 12, 13, 14, 15].map((date) => date * 1000))
    expect(asked).toHaveLength(7)
    expect(loader.peek('xm-account:7')).toBe(first)
    // 换账号时作废的是缓存；过完的天按账号记着、不会再变，换回来只再问今天。
    loader.invalidate()
    now = new Date(2026, 9, 15, 15, 0)
    asked.length = 0
    await loader.read()
    expect(askedDates(asked)).toEqual([15])
  })

  it('remembers the settled days across restarts, so a cold start only asks for today', async () => {
    const { bridge, asked } = fixture([{ userId: 7 }])
    const storage = memoryStorage()
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 15, 14, 30), storage).read()
    expect(asked).toHaveLength(7)
    asked.length = 0
    const restarted = await createWeekSpendLoader(bridge, () => new Date(2026, 9, 15, 18, 0), storage).read()
    expect(askedDates(asked)).toEqual([15])
    expect(restarted.days.map((day) => day.quota)).toEqual([9, 10, 11, 12, 13, 14, 15].map((date) => date * 1000))
    // 第二天头一次开：昨天那根这时才过完，再问一次它和今天。
    asked.length = 0
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 16, 9, 0), storage).read()
    expect(askedDates(asked)).toEqual([15, 16])
  })

  it('does not remember a day asked within an hour after it ended', async () => {
    const { bridge, asked } = fixture([{ userId: 7 }])
    const storage = memoryStorage()
    // 零点刚过：后台隔几分钟才把最后那一阵的用量落库，昨天这时问到的数先不当准。
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 16, 0, 30), storage).read()
    expect(asked).toHaveLength(7)
    asked.length = 0
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 16, 0, 45), storage).read()
    expect(askedDates(asked)).toEqual([15, 16])
    asked.length = 0
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 16, 1, 0), storage).read()
    expect(askedDates(asked)).toEqual([15, 16])
    asked.length = 0
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 16, 1, 5), storage).read()
    expect(askedDates(asked)).toEqual([16])
  })

  it('keeps only the days still inside the week', async () => {
    const { bridge } = fixture([{ userId: 7 }])
    const storage = memoryStorage()
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 15, 14, 30), storage).read()
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 18, 14, 30), storage).read()
    expect([...readSettledWeekSpend(storage, 'xm-account:7').keys()].map((start) => new Date(start).getDate()))
      .toEqual([12, 13, 14, 15, 16, 17])
  })

  it('stores each account on its own and ignores anything that does not look like what it wrote', async () => {
    const { bridge, asked, nextAccount } = fixture([{ userId: 7 }, { userId: 8 }])
    const storage = memoryStorage()
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 15, 14, 30), storage).read()
    nextAccount()
    asked.length = 0
    await createWeekSpendLoader(bridge, () => new Date(2026, 9, 15, 14, 30), storage).read()
    expect(asked).toHaveLength(7)
    expect(readSettledWeekSpend(storage, 'xm-account:7').size).toBe(6)
    expect(readSettledWeekSpend(storage, 'xm-account:8').size).toBe(6)

    const day = new Date(2026, 9, 14).getTime()
    for (const raw of [
      JSON.stringify({ version: 2, owner: 'xm-account:8', days: [[day, 1]] }),
      // 版本 1 是不核对账号那时记的，可能混着另一个账号的数（D11）。
      JSON.stringify({ version: 1, owner: 'xm-account:7', days: [[day, 1]] }),
      JSON.stringify({ version: 3, owner: 'xm-account:7', days: [[day, 1]] }),
      JSON.stringify({ version: 2, owner: 'xm-account:7', days: [[day, -1], [day, Number.NaN], ['x', 1], [day]] }),
      JSON.stringify({ version: 2, owner: 'xm-account:7', days: [[day, 1]], padding: 'x'.repeat(2048) }),
      '{not json',
    ]) {
      storage.items.set(weekSpendKey('xm-account:7'), raw)
      expect(readSettledWeekSpend(storage, 'xm-account:7').size).toBe(0)
    }
    expect(readSettledWeekSpend(null, 'xm-account:7').size).toBe(0)
  })

  it('still draws the bars when local storage refuses to save them', async () => {
    const { bridge, asked } = fixture([{ userId: 7 }])
    const storage: WeekSpendStorage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
    const first = await createWeekSpendLoader(bridge, () => new Date(2026, 9, 15, 14, 30), storage).read()
    expect(first.days).toHaveLength(7)
    expect(asked).toHaveLength(7)
  })

  it('reuses the settled days when only the cache expired', async () => {
    const { bridge, asked } = fixture([{ userId: 7 }])
    let clock = new Date(2026, 9, 15, 14, 30)
    const loader = createWeekSpendLoader(bridge, () => clock)
    await loader.read()
    asked.length = 0
    clock = new Date(2026, 9, 15, 14, 45)
    // 缓存作废以后再读（这里借 scope 对不上那条路作废）：过完的天还记着，只再问今天。
    await loader.read('xm-account:other')
    expect(asked.map((range) => new Date(range.startTimestamp * 1000).getDate())).toEqual([15])
  })

  it('never shows the previous account bars after switching accounts', async () => {
    const { bridge, nextAccount } = fixture([{ userId: 7 }, { userId: 8 }])
    const loader = createWeekSpendLoader(bridge, () => new Date(2026, 9, 15, 14, 30))
    await loader.read('xm-account:7')
    nextAccount()
    expect(loader.peek('xm-account:8')).toBeNull()
    expect((await loader.read('xm-account:8')).scope).toBe('xm-account:8')
  })

  // 11-18 D11：读会话和查看板是两次调用。这里的看板照主进程的规矩办：带了「替谁查」、
  // 而当前账号已经不是它，就拒掉；没带就照旧回当前账号的数（旧代码就是这样把 B 的数记到 A 名下的）。
  function switchingFixture() {
    let current = 7
    let switchAfterDashboardCalls = Number.POSITIVE_INFINITY
    const asked: Array<{ day: number; userId: number }> = []
    const bridge = {
      getAccountSession: async () => ({ siteId: 'solov', authenticated: true, account: { userId: current } }),
      getAccountDashboard: (range: Range, expected?: string) => {
        if (asked.length >= switchAfterDashboardCalls) current = 8
        if (expected !== undefined && expected !== `xm-account:${current}`) return Promise.reject(new Error('账号刚刚切换，请重试'))
        asked.push({ day: new Date(range.startTimestamp * 1000).getDate(), userId: current })
        // A（7）每天花 100，B（8）每天花 900，一眼看得出是谁的。
        return Promise.resolve({ quota: current === 7 ? 100 : 900, coverage: 'range' })
      },
    } as unknown as Pick<XingmangApi, 'getAccountSession' | 'getAccountDashboard'>
    return {
      bridge,
      asked,
      switchTo(userId: number) { current = userId },
      switchAfter(calls: number) { switchAfterDashboardCalls = calls },
    }
  }

  it('never files the next account spend under the account a load started with', async () => {
    const { bridge, switchTo } = switchingFixture()
    const storage = memoryStorage()
    const clock = () => new Date(2026, 9, 15, 14, 30)
    const original = bridge.getAccountSession
    // 会话读回来是 A，紧接着换成 B，七天的看板都还没问。
    bridge.getAccountSession = async () => {
      const session = await original()
      switchTo(8)
      return session
    }
    await expect(createWeekSpendLoader(bridge, clock, storage).read()).rejects.toThrow('账号刚刚切换')
    expect(readSettledWeekSpend(storage, 'xm-account:7').size).toBe(0)
    // 换回 A、重开软件：A 的柱子是 A 自己的数。
    bridge.getAccountSession = original
    switchTo(7)
    const reopened = await createWeekSpendLoader(bridge, clock, storage).read()
    expect(reopened.scope).toBe('xm-account:7')
    expect(reopened.days.map((day) => day.quota)).toEqual([100, 100, 100, 100, 100, 100, 100])
  })

  it('keeps what it got for the first account when the switch lands halfway, and nothing of the second', async () => {
    const { bridge, asked, switchTo, switchAfter } = switchingFixture()
    const storage = memoryStorage()
    let clock = new Date(2026, 9, 15, 14, 30)
    const loader = createWeekSpendLoader(bridge, () => clock, storage)
    // 问到第三天时换成 B：前三天是 A 的、照记；后面四次带着 A 去问，全被拒。
    switchAfter(3)
    await expect(loader.read()).rejects.toThrow('账号刚刚切换')
    expect([...readSettledWeekSpend(storage, 'xm-account:7').values()]).toEqual([100, 100, 100])
    expect(readSettledWeekSpend(storage, 'xm-account:8').size).toBe(0)

    // 换号时界面会作废缓存；B 查自己的，记在 B 名下。
    switchAfter(Number.POSITIVE_INFINITY)
    loader.invalidate()
    const second = await loader.read('xm-account:8')
    expect(second.scope).toBe('xm-account:8')
    expect(second.days.map((day) => day.quota)).toEqual([900, 900, 900, 900, 900, 900, 900])
    expect([...readSettledWeekSpend(storage, 'xm-account:8').values()]).toEqual([900, 900, 900, 900, 900, 900])

    // A→B→A：换回 A，A 记着的三天不再问，问的只有没记下的那几天，全是 A 的数。
    switchTo(7)
    loader.invalidate()
    clock = new Date(2026, 9, 15, 14, 45)
    asked.length = 0
    const back = await loader.read('xm-account:7')
    expect(asked.map((entry) => entry.day)).toEqual([12, 13, 14, 15])
    expect(asked.every((entry) => entry.userId === 7)).toBe(true)
    expect(back.days.map((day) => day.quota)).toEqual([100, 100, 100, 100, 100, 100, 100])
    expect([...readSettledWeekSpend(storage, 'xm-account:7').values()]).toEqual([100, 100, 100, 100, 100, 100])
  })

  it('refuses an account whose backend only reports an all-time total', async () => {
    const { bridge } = fixture([{ userId: 7 }], 'all-time-summary')
    await expect(createWeekSpendLoader(bridge, () => new Date(2026, 9, 15)).read()).rejects.toThrow('该账号无法获取每日花费')
  })
})

describe('home week spend comparison', () => {
  const day = (start: number, quota: number, end = start + 1) => ({ start, end, quota })
  const spend = (scope: string, days: WeekSpend['days']): WeekSpend => ({ scope, days })

  // R8: the home page keeps what it already shows when a re-read draws the same bars.
  it('treats a re-read with the same bars as unchanged even though today ends later', () => {
    const before = spend('xm-account:7', [day(1, 10), day(2, 20, 50)])
    expect(sameWeekSpend(before, spend('xm-account:7', [day(1, 10), day(2, 20, 90)]))).toBe(true)
    expect(sameWeekSpend(before, before)).toBe(true)
    expect(sameWeekSpend(null, null)).toBe(true)
  })

  it('sees another account, another day or a new spend as a change', () => {
    const before = spend('xm-account:7', [day(1, 10), day(2, 20)])
    expect(sameWeekSpend(before, spend('xm-account:8', [day(1, 10), day(2, 20)]))).toBe(false)
    expect(sameWeekSpend(before, spend('xm-account:7', [day(2, 20), day(3, 0)]))).toBe(false)
    expect(sameWeekSpend(before, spend('xm-account:7', [day(1, 10), day(2, 25)]))).toBe(false)
    expect(sameWeekSpend(before, spend('xm-account:7', [day(1, 10)]))).toBe(false)
    expect(sameWeekSpend(before, null)).toBe(false)
  })
})

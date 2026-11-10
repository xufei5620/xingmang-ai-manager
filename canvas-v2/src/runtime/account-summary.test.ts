import { describe, expect, it } from 'vitest'
import type { CanvasAccountSummary } from '../host'
import {
  accountBalanceText,
  accountSummaryAriaLabel,
  accountSummaryFocusIntervalMs,
  accountSummaryRefreshDue,
  accountSummaryTitle,
  createAccountSummaryController,
  parseCanvasAccountSummary,
  type CanvasAccountSummaryState,
} from './account-summary'

const summary: CanvasAccountSummary = { siteLabel: '星芒账号', accountLabel: 'yo***3', balanceUsd: 12.4, subscriptionLabel: null, readAt: '2026-11-10T03:00:00.000Z' }
const at = Date.parse('2026-11-10T03:00:00.000Z')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('canvas account summary', () => {
  it('writes the balance the way the desktop main window does', () => {
    expect(accountBalanceText(12.4)).toBe('$12.40')
    expect(accountBalanceText(23456.789)).toBe('$23,456.79')
    expect(accountBalanceText(0)).toBe('$0.00')
    expect(accountBalanceText(null)).toBe('—')
    expect(accountBalanceText(Number.NaN)).toBe('—')
  })

  it('accepts the documented answer and treats null as signed out', () => {
    expect(parseCanvasAccountSummary(summary)).toEqual(summary)
    expect(parseCanvasAccountSummary(null)).toBeNull()
    expect(parseCanvasAccountSummary({ siteLabel: '历史账号', accountLabel: null, balanceUsd: null, readAt: null })).toEqual({ siteLabel: '历史账号', accountLabel: null, balanceUsd: null, subscriptionLabel: null, readAt: null })
    // A historical account can be spent below zero.
    expect(parseCanvasAccountSummary({ ...summary, balanceUsd: -0.35 })?.balanceUsd).toBe(-0.35)
  })

  it('rejects answers that are not the documented shape', () => {
    for (const value of [undefined, 'x', [], {}, { ...summary, siteLabel: '' }, { ...summary, siteLabel: 3 }, { ...summary, accountLabel: 3 },
      { ...summary, balanceUsd: '12' }, { ...summary, balanceUsd: Number.POSITIVE_INFINITY }, { ...summary, balanceUsd: 2e9 },
      { ...summary, readAt: 'yesterday' }, { ...summary, readAt: 1 }, { ...summary, subscriptionLabel: 1 }]) {
      expect(() => parseCanvasAccountSummary(value), JSON.stringify(value)).toThrow('账号信息格式不对')
    }
  })

  it('strips hidden characters and cuts labels that would crowd the toolbar', () => {
    const parsed = parseCanvasAccountSummary({ ...summary, siteLabel: '星芒‮账号\n', accountLabel: `${'a'.repeat(60)}​`, subscriptionLabel: '   ' })
    expect(parsed?.siteLabel).toBe('星芒账号')
    expect(parsed?.accountLabel).toHaveLength(40)
    expect(parsed?.accountLabel?.endsWith('…')).toBe(true)
    expect(parsed?.subscriptionLabel).toBeNull()
  })

  it('says which account, the balance, how fresh it is and what a click does', () => {
    expect(accountSummaryTitle({ state: 'ready', summary }, at + 20_000)).toBe('星芒账号 · yo***3\n余额 $12.40（刚刚读的）\n画布出图用的就是这个账号的额度，点一下重新读余额')
    expect(accountSummaryTitle({ state: 'ready', summary }, at + 5 * 60_000)).toContain('余额 $12.40（5 分钟前读的）')
    expect(accountSummaryTitle({ state: 'ready', summary }, at + 3 * 3_600_000)).toContain('（3 小时前读的）')
    expect(accountSummaryTitle({ state: 'ready', summary: { ...summary, accountLabel: null, balanceUsd: null, readAt: null } }, at)).toBe('星芒账号\n余额还没读到\n画布出图用的就是这个账号的额度，点一下重新读余额')
    expect(accountSummaryTitle({ state: 'ready', summary: { ...summary, subscriptionLabel: '订阅可用到 12-01' } }, at)).toContain('\n订阅可用到 12-01\n')
    expect(accountSummaryTitle({ state: 'ready', summary, refreshFailed: true }, at)).toContain('\n刚才重新读没读到，显示的是上次读到的\n')
    expect(accountSummaryTitle({ state: 'failed' }, at)).toBe('余额暂时没有读到，点一下再试')
    expect(accountSummaryTitle({ state: 'loading' }, at)).toBe('正在读余额')
    expect(accountSummaryAriaLabel({ state: 'ready', summary })).toBe('余额 $12.40，星芒账号 · yo***3，点一下重新读')
  })

  it('asks again only after the interval, and when the clock went backwards', () => {
    expect(accountSummaryRefreshDue(null, at, accountSummaryFocusIntervalMs)).toBe(true)
    expect(accountSummaryRefreshDue(at, at + 59_000, accountSummaryFocusIntervalMs)).toBe(false)
    expect(accountSummaryRefreshDue(at, at + 60_000, accountSummaryFocusIntervalMs)).toBe(true)
    expect(accountSummaryRefreshDue(at, at - 1, accountSummaryFocusIntervalMs)).toBe(true)
    expect(accountSummaryRefreshDue(at, at, 0)).toBe(true)
  })
})

describe('canvas account summary controller', () => {
  function controller(read: () => Promise<unknown>, clock = { now: at }) {
    const states: CanvasAccountSummaryState[] = []
    const instance = createAccountSummaryController({ read, onChange: (state) => states.push(state), now: () => clock.now })
    return { instance, states, clock }
  }

  it('shows the answer, and hides the chip when nobody is signed in', async () => {
    const answers: unknown[] = [summary, null]
    const { instance, states } = controller(async () => answers.shift())
    expect(instance.state()).toEqual({ view: { state: 'loading' }, refreshing: false })
    await instance.refresh(0)
    expect(states.map((state) => state.refreshing)).toEqual([true, false])
    expect(instance.state()).toEqual({ view: { state: 'ready', summary }, refreshing: false })
    await instance.refresh(0)
    expect(instance.state()).toEqual({ view: null, refreshing: false })
  })

  it('keeps the last balance when a later read fails, and says so', async () => {
    const answers: Array<() => unknown> = [() => summary, () => { throw new Error('网络断了') }]
    const { instance } = controller(async () => answers.shift()?.())
    await instance.refresh(0)
    await instance.refresh(0)
    expect(instance.state().view).toEqual({ state: 'ready', summary, refreshFailed: true })
  })

  it('says it could not read when the first read fails or the answer is malformed', async () => {
    const failing = controller(async () => { throw new Error('no') })
    await failing.instance.refresh(0)
    expect(failing.instance.state().view).toEqual({ state: 'failed' })
    const malformed = controller(async () => ({ balanceUsd: 3 }))
    await malformed.instance.refresh(0)
    expect(malformed.instance.state().view).toEqual({ state: 'failed' })
  })

  it('asks once for clicks and focus inside the interval', async () => {
    let calls = 0
    const { instance, clock } = controller(async () => { calls += 1; return summary })
    await instance.refresh(0)
    clock.now += 30_000
    await instance.refresh(accountSummaryFocusIntervalMs)
    expect(calls).toBe(1)
    clock.now += 30_000
    await instance.refresh(accountSummaryFocusIntervalMs)
    expect(calls).toBe(2)
  })

  it('runs one read at a time and asks again after a run ended during it', async () => {
    const first = deferred<unknown>()
    const reads = [() => first.promise, async () => ({ ...summary, balanceUsd: 12.28 })]
    let calls = 0
    const { instance } = controller(() => { calls += 1; return reads.shift()!() })
    const opening = instance.refresh(0)
    void instance.refresh(accountSummaryFocusIntervalMs)
    void instance.refresh(0)
    expect(calls).toBe(1)
    first.resolve(summary)
    await opening
    expect(calls).toBe(2)
    expect(instance.state().view).toEqual({ state: 'ready', summary: { ...summary, balanceUsd: 12.28 } })
  })

  it('drops an answer that arrives after the workspace went away', async () => {
    const late = deferred<unknown>()
    const { instance, states } = controller(() => late.promise)
    const reading = instance.refresh(0)
    instance.dispose()
    late.resolve(summary)
    await reading
    expect(states).toEqual([{ view: { state: 'loading' }, refreshing: true }])
    await instance.refresh(0)
    expect(states).toHaveLength(1)
  })
})

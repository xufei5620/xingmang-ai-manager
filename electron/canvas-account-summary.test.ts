import { describe, expect, it, vi } from 'vitest'
import { buildCanvasAccountSummary, canvasAccountSummaryFreshMs, createCanvasAccountSummaryReader, maskCanvasAccountLabel } from './canvas-account-summary'

const at = Date.parse('2026-11-10T03:00:00.000Z')

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('canvas account summary', () => {
  it('half-hides the account name with three stars whatever its length', () => {
    expect(maskCanvasAccountLabel('yoyo123')).toBe('yo***3')
    expect(maskCanvasAccountLabel('abcde')).toBe('ab***e')
    expect(maskCanvasAccountLabel('abcd')).toBe('a***d')
    expect(maskCanvasAccountLabel('ab')).toBe('a***')
    expect(maskCanvasAccountLabel('星芒用户')).toBe('星***户')
    expect(maskCanvasAccountLabel(' \u0007 ')).toBeNull()
    expect(maskCanvasAccountLabel(null)).toBeNull()
  })

  it('keeps nothing of an email but its first character', () => {
    // A historical account without a username carries its email in that field.
    expect(maskCanvasAccountLabel('alice.wang@company.example')).toBe('a***@***')
    expect(maskCanvasAccountLabel('@example.com')).toBe('***@***')
  })

  it('builds the four things the chip shows and nothing else', () => {
    const summary = buildCanvasAccountSummary({ siteId: 'solov', username: 'yoyo123', balance: { quota: 6_200_000, quotaPerUnit: 500_000 }, balanceReadAt: at, subscriptionLabel: null })
    expect(summary).toEqual({ siteLabel: '星芒账号', accountLabel: 'yo***3', balanceUsd: 12.4, subscriptionLabel: null, readAt: '2026-11-10T03:00:00.000Z' })
    expect(Object.keys(summary).sort()).toEqual(['accountLabel', 'balanceUsd', 'readAt', 'siteLabel', 'subscriptionLabel'])
    expect(buildCanvasAccountSummary({ siteId: 'solov-api', username: 'alice@qq.com', balance: { quota: -50_000, quotaPerUnit: 500_000 }, balanceReadAt: at, subscriptionLabel: null }))
      .toEqual({ siteLabel: '历史账号', accountLabel: 'a***@***', balanceUsd: -0.1, subscriptionLabel: null, readAt: '2026-11-10T03:00:00.000Z' })
    expect(buildCanvasAccountSummary({ siteId: 'solov', username: 'yoyo123', balance: null, balanceReadAt: null, subscriptionLabel: '剩余 USD 12.30 · 10月3日到期' }))
      .toEqual({ siteLabel: '星芒账号', accountLabel: 'yo***3', balanceUsd: null, subscriptionLabel: '订阅剩余 USD 12.30 · 10月3日到期', readAt: null })
    // No conversion rate yet: no balance, and no read time that would claim one.
    expect(buildCanvasAccountSummary({ siteId: 'solov', username: 'yoyo123', balance: { quota: 1, quotaPerUnit: 0 }, balanceReadAt: at, subscriptionLabel: null }))
      .toMatchObject({ balanceUsd: null, readAt: null })
  })
})

describe('canvas account summary reader', () => {
  function fixture(options: { readAt?: number | null; signedIn?: boolean } = {}) {
    const state = {
      clock: at,
      spentAt: null as number | null,
      account: options.signedIn === false ? null : { key: 'solov:7', siteId: 'solov' as const, username: 'yoyo123' },
      balance: options.readAt === null ? null : { quota: 6_200_000, quotaPerUnit: 500_000 },
      readAt: options.readAt === undefined ? at - 60_000 : options.readAt,
    }
    const readBalance = vi.fn(async () => {
      state.balance = { quota: 6_000_000, quotaPerUnit: 500_000 }
      state.readAt = state.clock
    })
    const read = createCanvasAccountSummaryReader({
      current: () => state.account,
      latest: () => ({ balance: state.balance, readAt: state.readAt, subscriptionLabel: null }),
      readBalance,
      spentAt: () => state.spentAt,
      now: () => state.clock,
    })
    return { state, readBalance, read }
  }

  it('answers null without reading anything when nobody is signed in', async () => {
    const { read, readBalance } = fixture({ signedIn: false })
    await expect(read()).resolves.toBeNull()
    expect(readBalance).not.toHaveBeenCalled()
  })

  it('answers a fresh balance as it is and reads a stale one once', async () => {
    const fresh = fixture({ readAt: at - 5_000 })
    await expect(fresh.read()).resolves.toMatchObject({ balanceUsd: 12.4, readAt: new Date(at - 5_000).toISOString() })
    expect(fresh.readBalance).not.toHaveBeenCalled()

    const stale = fixture()
    await expect(stale.read()).resolves.toMatchObject({ balanceUsd: 12, readAt: new Date(at).toISOString() })
    expect(stale.readBalance).toHaveBeenCalledTimes(1)
  })

  it('reads the site at most once per interval however often the canvas asks', async () => {
    const { state, read, readBalance } = fixture()
    readBalance.mockImplementation(async () => { throw new Error('网络断了') })
    await expect(read()).resolves.toMatchObject({ balanceUsd: 12.4 })
    for (let index = 0; index < 20; index += 1) await read()
    expect(readBalance).toHaveBeenCalledTimes(1)
    state.clock += canvasAccountSummaryFreshMs
    await read()
    expect(readBalance).toHaveBeenCalledTimes(2)
  })

  it('reads again right after a run ended, even within the interval, and only once', async () => {
    const { read, readBalance, state } = fixture({ readAt: at - 5_000 })
    await read()
    expect(readBalance).not.toHaveBeenCalled()
    state.clock += 2_000
    state.spentAt = state.clock
    await expect(read()).resolves.toMatchObject({ balanceUsd: 12, readAt: new Date(state.clock).toISOString() })
    await read()
    expect(readBalance).toHaveBeenCalledTimes(1)
    // A failed read after the run is not retried in a loop either.
    readBalance.mockImplementation(async () => { throw new Error('网络断了') })
    state.clock += 1_000
    state.spentAt = state.clock
    await read()
    await read()
    expect(readBalance).toHaveBeenCalledTimes(2)
  })

  it('shares one read between calls that arrive while it is under way', async () => {
    const { read, readBalance, state } = fixture()
    const gate = deferred()
    readBalance.mockImplementation(async () => {
      await gate.promise
      state.balance = { quota: 5_000_000, quotaPerUnit: 500_000 }
      state.readAt = state.clock
    })
    const first = read()
    const second = read()
    gate.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([expect.objectContaining({ balanceUsd: 10 }), expect.objectContaining({ balanceUsd: 10 })])
    expect(readBalance).toHaveBeenCalledTimes(1)
  })

  it('reads for a new account right away even if the previous one was just read', async () => {
    const { read, readBalance, state } = fixture()
    await read()
    state.account = { key: 'solov-api:9', siteId: 'solov' as const, username: 'other' }
    state.balance = null
    state.readAt = null
    await expect(read()).resolves.toMatchObject({ accountLabel: 'ot***r', balanceUsd: 12 })
    expect(readBalance).toHaveBeenCalledTimes(2)
  })

  it('answers for whoever is signed in when the read returns, not who asked', async () => {
    const { read, readBalance, state } = fixture()
    readBalance.mockImplementation(async () => { state.account = null })
    await expect(read()).resolves.toBeNull()
  })
})

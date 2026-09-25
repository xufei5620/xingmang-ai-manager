import { describe, expect, it, vi } from 'vitest'
import type { AccountSubscriptionSelf } from '../../../../electron/ipc-contract'
import { createAccountSubscriptionCache, subscriptionCacheMaxAge } from './subscription-cache'

const named: AccountSubscriptionSelf = {
  billingPreference: null, allSubscriptions: [],
  activeSubscriptions: [{ id: 1, planId: 3, status: 'active', source: 'sub2api', groupName: '包月', amountTotal: null, amountUsed: null, startedAt: '', endsAt: '', nextResetAt: null }],
}
const unnamed: AccountSubscriptionSelf = { ...named, activeSubscriptions: [{ ...named.activeSubscriptions[0], groupName: undefined }] }

function fixture(self = named) {
  let clock = 1_000
  const readSelf = vi.fn<() => Promise<AccountSubscriptionSelf>>().mockResolvedValue(self)
  const readPlanNames = vi.fn<() => Promise<ReadonlyMap<number, string>>>().mockResolvedValue(new Map([[3, '月卡']]))
  const cache = createAccountSubscriptionCache({ readSelf, readPlanNames, now: () => clock })
  return { cache, readSelf, readPlanNames, advance: (ms: number) => { clock += ms } }
}

describe('account subscription cache', () => {
  it('reads at most once per few minutes for the same account', async () => {
    const { cache, readSelf, advance } = fixture()
    await cache.refreshIfStale('a')
    await cache.refreshIfStale('a')
    advance(subscriptionCacheMaxAge - 1)
    await cache.refreshIfStale('a')
    expect(readSelf).toHaveBeenCalledTimes(1)
    advance(1)
    await cache.refreshIfStale('a')
    expect(readSelf).toHaveBeenCalledTimes(2)
    expect(cache.getSnapshot()).toMatchObject({ scope: 'a', self: named })
  })

  it('only reads plan names when a subscription arrives without one', async () => {
    const named = fixture()
    await named.cache.refreshIfStale('a')
    expect(named.readPlanNames).not.toHaveBeenCalled()
    const bare = fixture(unnamed)
    await bare.cache.refreshIfStale('a')
    expect(bare.cache.getSnapshot().planNames.get(3)).toBe('月卡')
  })

  it('drops the previous account at once and reads the new one immediately', async () => {
    const { cache, readSelf } = fixture()
    await cache.refreshIfStale('a')
    const pending = cache.refreshIfStale('b')
    expect(cache.getSnapshot()).toMatchObject({ scope: 'b', self: null })
    await pending
    expect(readSelf).toHaveBeenCalledTimes(2)
    await cache.refreshIfStale(null)
    expect(cache.getSnapshot()).toMatchObject({ scope: null, self: null })
  })

  it('keeps the last good read when a later read fails', async () => {
    const { cache, readSelf, advance } = fixture()
    await cache.refreshIfStale('a')
    readSelf.mockRejectedValueOnce(new Error('offline'))
    advance(subscriptionCacheMaxAge)
    await cache.refreshIfStale('a')
    expect(cache.getSnapshot().self).toBe(named)
  })

  it('ignores a read that lands after the account changed', async () => {
    const { cache, readSelf } = fixture()
    let release!: (value: AccountSubscriptionSelf) => void
    readSelf.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = cache.refreshIfStale('a')
    readSelf.mockResolvedValueOnce(unnamed)
    await cache.refreshIfStale('b')
    release(named)
    await first
    expect(cache.getSnapshot()).toMatchObject({ scope: 'b', self: unnamed })
  })
})

import { describe, expect, it } from 'vitest'
import {
  accountKeyAmount,
  accountKeyExpiredTime,
  accountKeyQuota,
  buildManagedCliKeyLimitUpdate,
  findAccountKeyById,
  inheritedKeySettings,
  isKeyQuotaExhaustedMessage,
  loadManagedCliKeys,
  managedKeyQuotaExhaustedMessage,
  parseManagedCliKeyLimitAmount,
  resolveManagedCliKeyLimits,
} from './account-key-quota'
import type { AccountKey } from './ipc-contract'

function key(overrides: Partial<AccountKey> & Pick<AccountKey, 'id' | 'name'>): AccountKey {
  return {
    maskedKey: 'sk-••••••••0001',
    group: 'Claude-MAX订阅',
    status: 1,
    remainQuota: 0,
    unlimitedQuota: true,
    usedQuota: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    expiredAt: null,
    accessedAt: null,
    ...overrides,
  }
}

describe('account key quota conversion', () => {
  it('converts a typed amount into each backend unit', () => {
    expect(accountKeyQuota(0.25, 500_000, 'solov', false)).toBe(125_000)
    expect(accountKeyQuota(0.25, 1, 'solov-api', false)).toBe(0.25)
    expect(accountKeyQuota(0, 1, 'solov-api', true)).toBe(0)
  })

  it('refuses an amount that cannot become a usable limit', () => {
    expect(() => accountKeyQuota(0, 1, 'solov-api', false)).toThrow('大于 0')
    expect(() => accountKeyQuota(0.0000001, 500_000, 'solov', false)).toThrow('范围')
    expect(() => accountKeyQuota(1, 0, 'solov', false)).toThrow('大于 0')
  })

  it('converts a backend quota back into a display amount and reports unusable input as unknown', () => {
    expect(accountKeyAmount(125_000, 500_000)).toBe(0.25)
    expect(accountKeyAmount(0.25, 1)).toBe(0.25)
    expect(accountKeyAmount(null, 500_000)).toBeNull()
    expect(accountKeyAmount(Number.NaN, 500_000)).toBeNull()
    expect(accountKeyAmount(125_000, 0)).toBeNull()
  })

  it('reads an amount typed by the user and treats a blank field as no limit', () => {
    expect(parseManagedCliKeyLimitAmount('  12.5 ')).toBe(12.5)
    expect(parseManagedCliKeyLimitAmount('')).toBeNull()
    expect(parseManagedCliKeyLimitAmount('   ')).toBeNull()
    expect(() => parseManagedCliKeyLimitAmount('0')).toThrow('大于 0')
    expect(() => parseManagedCliKeyLimitAmount('-3')).toThrow('大于 0')
    expect(() => parseManagedCliKeyLimitAmount('abc')).toThrow('大于 0')
  })

  it('writes an expiry back as the server sentinel or whole seconds, and refuses an unreadable one', () => {
    expect(accountKeyExpiredTime(null)).toBe(-1)
    expect(accountKeyExpiredTime('')).toBe(-1)
    expect(accountKeyExpiredTime('2026-09-18T10:00:30.900Z')).toBe(Math.floor(Date.parse('2026-09-18T10:00:30.900Z') / 1000))
    expect(() => accountKeyExpiredTime('never')).toThrow('无法识别')
  })
})

describe('managed CLI key limits', () => {
  const keys = [
    key({ id: 3, name: 'xingmang-desktop-claude', group: 'Claude-MAX订阅', unlimitedQuota: false, remainQuota: 2_500_000, usedQuota: 500_000 }),
    key({ id: 4, name: 'xingmang-desktop-codex', group: 'GPT-中转/订阅', usedQuota: 1_000_000 }),
    key({ id: 9, name: 'my-own-key', group: 'GPT-中转/订阅' }),
  ]

  it('resolves one row per tool with its used and remaining amounts', () => {
    const limits = resolveManagedCliKeyLimits(keys, 500_000, 'solov')
    expect(limits.map((limit) => limit.provider)).toEqual(['claude', 'codex', 'grok', 'gemini'])
    expect(limits[0]).toMatchObject({ keyName: 'xingmang-desktop-claude', unlimited: false, remaining: 5, used: 1 })
    expect(limits[1]).toMatchObject({ unlimited: true, remaining: null, used: 2 })
    expect(limits[3]).toMatchObject({ key: null, unlimited: true, remaining: null, used: null })
    expect(limits[3].group).toBe('Gemini-中转/订阅')
  })

  it('uses the other backend group names and unit when that account is active', () => {
    const limits = resolveManagedCliKeyLimits(
      [key({ id: 1, name: 'xingmang-desktop-codex', group: 'Codex_pro', unlimitedQuota: false, remainQuota: 3.25, usedQuota: 1.75 })],
      1,
      'solov-api',
    )
    expect(limits[1]).toMatchObject({ group: 'Codex_pro', unlimited: false, remaining: 3.25, used: 1.75 })
    expect(limits[0].group).toBe('Claude-MAX(不限客户端)')
  })

  it('prefers the key the main process marked as in use over an older same-named key', () => {
    const keys = [
      key({ id: 11, name: 'xingmang-desktop-claude' }),
      key({ id: 30, name: 'xingmang-desktop-claude', unlimitedQuota: false, remainQuota: 5, managedProvider: 'claude' }),
      key({ id: 31, name: 'renamed-by-user', group: 'Codex_pro', managedProvider: 'codex' }),
    ]
    const limits = resolveManagedCliKeyLimits(keys, 500_000, 'solov')
    expect(limits[0].key?.id).toBe(30)
    expect(limits[0].unlimited).toBe(false)
    expect(limits[1].key?.id).toBe(31)
  })

  it('prefers the key this program provisions when a hand-made key shares its name', () => {
    const duplicates = [
      key({ id: 11, name: 'xingmang-desktop-claude', group: '另一个分组' }),
      key({ id: 12, name: 'xingmang-desktop-claude', group: 'Claude-MAX订阅' }),
    ]
    expect(resolveManagedCliKeyLimits(duplicates, 500_000, 'solov')[0].key?.id).toBe(12)
    expect(resolveManagedCliKeyLimits(duplicates.slice(0, 1), 500_000, 'solov')[0].key?.id).toBe(11)
  })

  it('builds a limit update in each backend unit and keeps the key name, group and expiry', () => {
    const expiredAt = '2027-01-01T00:00:00.000Z'
    const [claude] = resolveManagedCliKeyLimits([key({ id: 3, name: 'xingmang-desktop-claude', expiredAt })], 500_000, 'solov')
    expect(buildManagedCliKeyLimitUpdate(claude, 20, 500_000, 'solov')).toEqual({
      id: 3,
      name: 'xingmang-desktop-claude',
      group: 'Claude-MAX订阅',
      remainQuota: 10_000_000,
      unlimitedQuota: false,
      expiredTime: Date.parse(expiredAt) / 1000,
    })
    const other = resolveManagedCliKeyLimits([key({ id: 7, name: 'xingmang-desktop-codex', group: 'Codex_pro' })], 1, 'solov-api')[1]
    expect(buildManagedCliKeyLimitUpdate(other, 12.5, 1, 'solov-api')).toMatchObject({ id: 7, remainQuota: 12.5, unlimitedQuota: false, expiredTime: -1 })
  })

  it('clears a limit back to unlimited without asking for an amount', () => {
    const [claude] = resolveManagedCliKeyLimits([key({ id: 3, name: 'xingmang-desktop-claude', unlimitedQuota: false, remainQuota: 100 })], 500_000, 'solov')
    expect(buildManagedCliKeyLimitUpdate(claude, null, 500_000, 'solov')).toMatchObject({ remainQuota: 0, unlimitedQuota: true })
  })

  it('refuses to build an update for a tool whose key does not exist yet', () => {
    const [claude] = resolveManagedCliKeyLimits([], 500_000, 'solov')
    expect(() => buildManagedCliKeyLimitUpdate(claude, 5, 500_000, 'solov')).toThrow('还没有对应的密钥')
  })

  it('falls back to the provisioning group when the backend reports no group for the key', () => {
    const [claude] = resolveManagedCliKeyLimits([key({ id: 3, name: 'xingmang-desktop-claude', group: '' })], 1, 'solov-api')
    expect(buildManagedCliKeyLimitUpdate(claude, 1, 1, 'solov-api').group).toBe('Claude-MAX(不限客户端)')
  })
})

describe('loadManagedCliKeys', () => {
  it('pages until the list is exhausted and keeps only the managed keys', async () => {
    const pages = [
      { total: 150, keys: [key({ id: 1, name: 'other' }), key({ id: 2, name: 'xingmang-desktop-claude' }), key({ id: 4, name: 'renamed', managedProvider: 'gemini' })] },
      { total: 150, keys: [key({ id: 3, name: 'xingmang-desktop-grok', group: 'Grok-中转/订阅' })] },
    ]
    const requested: Array<[number, number]> = []
    const found = await loadManagedCliKeys(async (page, pageSize) => {
      requested.push([page, pageSize])
      return pages[page - 1] ?? { total: 150, keys: [] }
    }, 'solov')
    expect(requested).toEqual([[1, 100], [2, 100]])
    expect(found.map((entry) => entry.id)).toEqual([2, 4, 3])
  })

  it('stops after the first page once it already covers the whole list', async () => {
    let calls = 0
    await loadManagedCliKeys(async () => {
      calls++
      return { total: 2, keys: [key({ id: 1, name: 'xingmang-desktop-claude' })] }
    }, 'solov')
    expect(calls).toBe(1)
  })

  it('stops at the safety page limit instead of paging an unbounded list', async () => {
    let calls = 0
    await loadManagedCliKeys(async () => {
      calls++
      return { total: 100_000, keys: [key({ id: calls, name: 'other' })] }
    }, 'solov')
    expect(calls).toBe(5)
  })
})

describe('isKeyQuotaExhaustedMessage', () => {
  it('recognizes a used-up per-key cap but not an empty account balance', () => {
    for (const message of [
      '模型查询失败，服务返回 401：该令牌额度已用尽 TokenStatusExhausted[sk-***]',
      'API Error: 401 该令牌额度已用尽',
      'token quota is not enough, token remain quota: $0.00',
      'The token quota has been used up',
      'API key 额度已用完',
    ]) expect(isKeyQuotaExhaustedMessage(message)).toBe(true)
    for (const message of ['用户额度不足', 'user quota is not enough', '无效的令牌', '模型查询失败，服务返回 401']) {
      expect(isKeyQuotaExhaustedMessage(message)).toBe(false)
    }
  })
})

describe('inheritedKeySettings', () => {
  const now = Date.parse('2026-09-22T00:00:00.000Z')

  it('carries the remaining cap and the expiry over to a replacement', () => {
    expect(inheritedKeySettings(key({ id: 1, name: 'a', unlimitedQuota: false, remainQuota: 2.5, expiredAt: '2027-01-01T00:00:00.000Z' }), now))
      .toEqual({ remainQuota: 2.5, unlimitedQuota: false, expiredTime: Date.parse('2027-01-01T00:00:00.000Z') / 1000 })
    expect(inheritedKeySettings(key({ id: 1, name: 'a', expiredAt: '2027-01-01T00:00:00.000Z' }), now))
      .toEqual({ remainQuota: 0, unlimitedQuota: true, expiredTime: Date.parse('2027-01-01T00:00:00.000Z') / 1000 })
  })

  it('has nothing to carry over for an unlimited key that never expires', () => {
    expect(inheritedKeySettings(key({ id: 1, name: 'a' }), now)).toBeNull()
  })

  it('refuses to issue a replacement for a used-up cap or an expired key', () => {
    expect(() => inheritedKeySettings(key({ id: 1, name: 'a', unlimitedQuota: false, remainQuota: 0 }), now))
      .toThrow(managedKeyQuotaExhaustedMessage)
    expect(() => inheritedKeySettings(key({ id: 1, name: 'a', expiredAt: '2026-01-01T00:00:00.000Z' }), now))
      .toThrow('原来那把密钥已经到期了')
  })
})

describe('findAccountKeyById', () => {
  it('pages through the key list and stops at the last page', async () => {
    const pages = [
      { total: 150, keys: Array.from({ length: 100 }, (_, index) => key({ id: index + 1, name: `k${index}` })) },
      { total: 150, keys: [key({ id: 140, name: 'target' })] },
    ]
    const listKeys = async ({ page }: { page: number }) => pages[page - 1]
    await expect(findAccountKeyById(listKeys, 140)).resolves.toMatchObject({ name: 'target' })
    await expect(findAccountKeyById(listKeys, 999)).resolves.toBeNull()
  })
})

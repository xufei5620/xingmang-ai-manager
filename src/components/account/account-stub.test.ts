import { describe, expect, it } from 'vitest'
import {
  computeBalanceUsd,
  formatBalanceUsd,
  LOW_BALANCE_THRESHOLD_USD,
  resolveAccountAreaStatus,
  resolveAccountSnapshotFromSearch,
  shouldShowManualKeyEntry,
  type AccountSnapshot,
} from './account-stub'

function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    loggedIn: true,
    nickname: '星芒用户',
    quota: 12_500_000,
    quotaPerUnit: 500_000,
    usdExchangeRate: 7.3,
    ...overrides,
  }
}

describe('computeBalanceUsd', () => {
  it('divides quota by quotaPerUnit, matching electron/new-api-client.ts computeBalanceDisplay', () => {
    expect(computeBalanceUsd(2_500_000, 500_000)).toBe(5)
  })

  it('supports fractional results', () => {
    expect(computeBalanceUsd(1_250_000, 500_000)).toBe(2.5)
  })

  it('falls back to 0 instead of throwing when quotaPerUnit is missing or zero', () => {
    expect(computeBalanceUsd(1_000, 0)).toBe(0)
  })

  it('falls back to 0 for a negative or non-finite quotaPerUnit', () => {
    expect(computeBalanceUsd(1_000, -500_000)).toBe(0)
    expect(computeBalanceUsd(1_000, Number.NaN)).toBe(0)
  })
})

describe('resolveAccountAreaStatus', () => {
  it('is guest whenever loggedIn is false, regardless of quota', () => {
    expect(resolveAccountAreaStatus(snapshot({ loggedIn: false, quota: 50_000_000 }))).toBe('guest')
  })

  it('is active when the balance is at or above the low-balance threshold', () => {
    const atThreshold = LOW_BALANCE_THRESHOLD_USD * 500_000
    expect(resolveAccountAreaStatus(snapshot({ quota: atThreshold, quotaPerUnit: 500_000 }))).toBe('active')
  })

  it('is low-balance once the balance drops below the threshold', () => {
    const belowThreshold = LOW_BALANCE_THRESHOLD_USD * 500_000 - 1
    expect(resolveAccountAreaStatus(snapshot({ quota: belowThreshold, quotaPerUnit: 500_000 }))).toBe('low-balance')
  })
})

describe('formatBalanceUsd', () => {
  it('formats as a USD string with two decimal places', () => {
    expect(formatBalanceUsd(2_500_000, 500_000)).toBe('$5.00')
  })

  it('rounds to two decimal places', () => {
    expect(formatBalanceUsd(1_234_567, 500_000)).toBe('$2.47')
  })
})

describe('resolveAccountSnapshotFromSearch', () => {
  it('defaults to signed-out when no query param is present', () => {
    expect(resolveAccountSnapshotFromSearch('').loggedIn).toBe(false)
  })

  it('defaults to signed-out for an unrecognized value', () => {
    expect(resolveAccountSnapshotFromSearch('?accountState=nonsense').loggedIn).toBe(false)
  })

  it('returns a logged-in, above-threshold snapshot for ?accountState=active', () => {
    const result = resolveAccountSnapshotFromSearch('?accountState=active')
    expect(result.loggedIn).toBe(true)
    expect(resolveAccountAreaStatus(result)).toBe('active')
  })

  it('returns a logged-in, below-threshold snapshot for ?accountState=low-balance', () => {
    const result = resolveAccountSnapshotFromSearch('?accountState=low-balance')
    expect(result.loggedIn).toBe(true)
    expect(resolveAccountAreaStatus(result)).toBe('low-balance')
  })
})

describe('shouldShowManualKeyEntry', () => {
  it('is true for a manual-key site (sub2api today)', () => {
    expect(shouldShowManualKeyEntry('manual-key')).toBe(true)
  })

  it('is false for a new-api backed site (solov today)', () => {
    expect(shouldShowManualKeyEntry('new-api')).toBe(false)
  })
})

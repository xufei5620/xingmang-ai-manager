import { describe, expect, it } from 'vitest'
import type { AccountBalance, AccountSessionState } from '../../types'
import { resolveAccountSnapshot } from './account-session'

const authenticatedSession: AccountSessionState = {
  authenticated: true,
  account: { userId: 42, username: 'nova', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 },
}

const balance: AccountBalance = {
  quota: 1_000_000,
  usedQuota: 250_000,
  quotaPerUnit: 500_000,
  quotaDisplayType: 'USD',
  usdExchangeRate: 7.3,
  displayAmount: 2,
}

describe('resolveAccountSnapshot', () => {
  it('builds a logged-in snapshot from a real authenticated session and balance', () => {
    expect(resolveAccountSnapshot(authenticatedSession, balance, '')).toEqual({
      loggedIn: true,
      nickname: 'nova',
      quota: 1_000_000,
      quotaPerUnit: 500_000,
      usdExchangeRate: 7.3,
    })
  })

  it('falls back to the guest snapshot when there is no session at all', () => {
    expect(resolveAccountSnapshot(null, null, '')).toMatchObject({ loggedIn: false })
  })

  it('falls back to the guest snapshot when the session reports unauthenticated', () => {
    const snapshot = resolveAccountSnapshot({ authenticated: false, account: null }, balance, '')
    expect(snapshot).toMatchObject({ loggedIn: false })
  })

  it('falls back rather than showing a half-populated state while balance is still loading', () => {
    // The window between a successful login and its follow-up
    // account:get-balance call resolving -- session is authenticated but
    // there is no balance yet.
    const snapshot = resolveAccountSnapshot(authenticatedSession, null, '')
    expect(snapshot).toMatchObject({ loggedIn: false })
  })

  it('still honors the ?accountState= QA preview while genuinely signed out', () => {
    const snapshot = resolveAccountSnapshot(null, null, '?accountState=low-balance')
    expect(snapshot).toMatchObject({ loggedIn: true, nickname: '星芒用户' })
  })

  it('prefers the real authenticated snapshot over the QA preview query param', () => {
    const snapshot = resolveAccountSnapshot(authenticatedSession, balance, '?accountState=low-balance')
    expect(snapshot).toEqual({
      loggedIn: true,
      nickname: 'nova',
      quota: 1_000_000,
      quotaPerUnit: 500_000,
      usdExchangeRate: 7.3,
    })
  })
})

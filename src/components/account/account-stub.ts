// Account-area skeleton (W4, docs/OVERNIGHT-PLAN.md). Deliberately not wired to
// the real `account:get-status` / `account:get-balance` IPC channels W3 built —
// this wave is UI-only. Every value here is a stand-in so the three account-area
// states (signed out / signed in / low balance) can be reviewed and iterated on
// before any production account ever touches this screen.

import type { RelaySite } from '../../types'

export type AccountAreaStatus = 'guest' | 'active' | 'low-balance'

/**
 * True when the active relay site has no login/register/个人中心 UI of its
 * own (W3b, sub2api-style sites) -- AccountArea.tsx branches on this before
 * even looking at `status`/`snapshot` below: a manual-key site always shows
 * the 粘贴 Key entry point instead of the guest/active/low-balance states,
 * regardless of whatever new-api session this app happens to still be
 * holding from a previous site (see AccountArea.tsx's own comment on why
 * that session is deliberately left alone rather than logged out).
 */
export function shouldShowManualKeyEntry(accountBackend: RelaySite['accountBackend']): boolean {
  return accountBackend === 'manual-key'
}

export interface AccountSnapshot {
  loggedIn: boolean
  nickname: string
  /** Integer quota units, same shape as NewApiAccountProfile.quota (electron/new-api-client.ts). */
  quota: number
  /** Quota units per $1, same shape as NewApiAccountStatus.quotaPerUnit — never hardcode the ratio. */
  quotaPerUnit: number
  usdExchangeRate: number
}

// Placeholder threshold pending a real product decision once account:get-balance
// is wired into this UI (tracked for a later wave); $5 just needs to be low
// enough that the "active" stub snapshot below stays comfortably above it.
export const LOW_BALANCE_THRESHOLD_USD = 5

export const ACCOUNT_STATE_QUERY_PARAM = 'accountState'

const GUEST_SNAPSHOT: AccountSnapshot = {
  loggedIn: false,
  nickname: '',
  quota: 0,
  quotaPerUnit: 500_000,
  usdExchangeRate: 7.3,
}

// Stub values only — shaped like a real xm.solov.cc response (quotaPerUnit /
// usdExchangeRate lifted from docs/RECON-new-api.md's live probe) so nothing
// about this UI needs to change once account:get-balance is wired in for real.
const STUB_SNAPSHOTS: Record<'active' | 'low-balance', AccountSnapshot> = {
  active: {
    loggedIn: true,
    nickname: '星芒用户',
    quota: 12_500_000,
    quotaPerUnit: 500_000,
    usdExchangeRate: 7.3,
  },
  'low-balance': {
    loggedIn: true,
    nickname: '星芒用户',
    quota: 900_000,
    quotaPerUnit: 500_000,
    usdExchangeRate: 7.3,
  },
}

/**
 * quota -> USD. Mirrors `computeBalanceDisplay` in electron/new-api-client.ts
 * (kept as an independent copy: src/ cannot import electron/ code, see
 * CLAUDE.md I6/I7) so swapping the stub snapshot for a real
 * account:get-balance response later requires no formatting changes here.
 */
export function computeBalanceUsd(quota: number, quotaPerUnit: number): number {
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return 0
  return quota / quotaPerUnit
}

export function resolveAccountAreaStatus(snapshot: AccountSnapshot): AccountAreaStatus {
  if (!snapshot.loggedIn) return 'guest'
  const balanceUsd = computeBalanceUsd(snapshot.quota, snapshot.quotaPerUnit)
  return balanceUsd < LOW_BALANCE_THRESHOLD_USD ? 'low-balance' : 'active'
}

export function formatBalanceUsd(quota: number, quotaPerUnit: number): string {
  return `$${computeBalanceUsd(quota, quotaPerUnit).toFixed(2)}`
}

/**
 * Dev-only override so all three account-area states can be eyeballed
 * (`?accountState=active` / `?accountState=low-balance`) without a real
 * login — mirrors the `?theme=` override `initialTheme()` already reads in
 * app-shared.ts. Any other value, including no param at all, falls back to
 * signed-out: nobody should ever appear logged in before a real session
 * exists.
 */
export function resolveAccountSnapshotFromSearch(search: string): AccountSnapshot {
  const requested = new URLSearchParams(search).get(ACCOUNT_STATE_QUERY_PARAM)
  if (requested === 'active' || requested === 'low-balance') return STUB_SNAPSHOTS[requested]
  return GUEST_SNAPSHOT
}

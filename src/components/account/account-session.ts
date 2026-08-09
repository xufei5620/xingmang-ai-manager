// Maps the real account:get-session / account:get-balance IPC responses into
// the same AccountSnapshot shape the sidebar already renders (see
// account-stub.ts) -- so AccountArea.tsx needed zero changes to go from
// stubbed to real data.
import type { AccountBalance, AccountSessionState } from '../../types'
import { resolveAccountSnapshotFromSearch, type AccountSnapshot } from './account-stub'

/**
 * Falls back to resolveAccountSnapshotFromSearch -- real guest state, or the
 * `?accountState=` dev/QA preview it already supports -- whenever there is
 * no authenticated session with a balance loaded yet. That covers both the
 * genuine signed-out case and the brief window between a successful login
 * and its follow-up account:get-balance call resolving, so the account area
 * never flashes a half-populated "logged in with $0" state.
 */
export function resolveAccountSnapshot(
  session: AccountSessionState | null,
  balance: AccountBalance | null,
  search: string,
): AccountSnapshot {
  if (session?.authenticated && session.account && balance) {
    return {
      loggedIn: true,
      nickname: session.account.username,
      quota: balance.quota,
      quotaPerUnit: balance.quotaPerUnit,
      usdExchangeRate: balance.usdExchangeRate,
    }
  }
  return resolveAccountSnapshotFromSearch(search)
}

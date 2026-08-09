// Pure helpers for the 个人中心 (account center) page (W4a). Kept in their own
// module instead of inlined in AccountCenterPage.tsx: src/ has no DOM test
// environment (CLAUDE.md T7 -- no vitest.config.ts, default `node`
// environment, zero render() calls anywhere under src/), so these pure
// functions are the only part of the page's logic that can actually be unit
// tested. Quota-to-USD *math* is deliberately not duplicated here -- see
// account-stub.ts's computeBalanceUsd, reused below by formatUsageCostUsd.
// account-stub.ts's formatBalanceUsd is itself unchanged and still reused
// as-is by AccountArea and this page's profile tab (balance/used-quota
// totals, always well above a cent). The usage tab's per-row 费用 column
// needs its own formatUsageCostUsd below, though: a single request's quota
// is usually sub-cent (typically $0.001~$0.1), and formatBalanceUsd's
// toFixed(2) would round almost every row down to a misleading "$0.00"
// that reads as broken rather than merely small.

import { computeBalanceUsd, formatBalanceUsd } from './account-stub'

const inviteBaseUrl = 'https://xm.solov.cc/register'

// Opens in the system browser (I12, href-exact-match allowlisted in
// electron/main.ts) -- the desktop session's cookies/access token never
// travel there, so the user authenticates again on the web the same way
// anyone would for an online payment; this app never handles card/payment
// details itself. Shared by the 充值 tab (AccountCenterPage.tsx) and the
// sidebar's own recharge button (App.tsx) so the two "去充值" entry points
// can never drift onto different URLs.
export const WALLET_URL = 'https://xm.solov.cc/wallet'

/**
 * Builds a shareable invite link from the current user's own affCode.
 * Mirrors QuantumNous/new-api's own web frontend exactly: sign-up-form.tsx
 * reads the referral code from a plain `aff` query parameter via
 * `new URLSearchParams(window.location.search).get('aff')` and later sends
 * it back as `aff_code` on registration -- confirmed by reading that file
 * directly at the upstream `main` branch and the exact v1.0.0-rc.22 /
 * v1.0.0-rc.24 tags (byte-identical across all three, the latter two
 * bracketing xm.solov.cc's own pinned version). `/register` is used as the
 * link target rather than `/sign-up` only because it reads more clearly as
 * an invite destination -- the two are equivalent, since
 * web/src/routes/(auth)/register.tsx 302-redirects to `/sign-up` while
 * preserving the full query string.
 */
export function buildAccountInviteLink(affCode: string): string {
  return `${inviteBaseUrl}?aff=${encodeURIComponent(affCode)}`
}

// model.Log's Type constants (model/log.go), confirmed identical at the
// v1.0.0-rc.22 and v1.0.0-rc.24 tags: don't use iota, values are wire-stable.
const logTypeLabels: Readonly<Record<number, string>> = {
  0: '未知',
  1: '充值',
  2: '消费',
  3: '管理',
  4: '系统',
  5: '错误',
  6: '退款',
  7: '登录',
}

/** Maps new-api's numeric usage-log type to a Chinese label for the 用量 tab. */
export function accountUsageTypeLabel(type: number): string {
  return logTypeLabels[type] ?? `未知类型(${type})`
}

const usageDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** Formats a usage record's ISO createdAt for display; tolerates a blank or unparseable value. */
export function formatAccountUsageDate(iso: string): string {
  if (!iso) return '时间未知'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '时间未知' : usageDateFormatter.format(parsed)
}

/**
 * quota -> USD display string for the 用量 tab's 费用 column. Below $0.01
 * this switches from formatBalanceUsd's fixed 2 decimals to a
 * trailing-zero-trimmed higher precision (up to 6 decimal places) so a real
 * sub-cent cost (e.g. $0.0023) stays visible instead of collapsing to a
 * misleading "$0.00" -- a genuinely zero-cost record still shows "$0.00".
 *
 * quotaPerUnit is treated as unusable (0/NaN/negative/undefined -- the last
 * covers the usage tab having loaded before the balance request resolves)
 * and returns the '—' placeholder rather than risk a "$0.00" that would be
 * indistinguishable from a real zero-cost row.
 */
export function formatUsageCostUsd(quota: number, quotaPerUnit: number | undefined): string {
  if (typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return '—'
  const usd = computeBalanceUsd(quota, quotaPerUnit)
  if (usd === 0) return '$0.00'
  if (Math.abs(usd) >= 0.01) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
}

// common.TokenStatus* (model/token.go), confirmed identical at the
// v1.0.0-rc.24 tag: 1 enabled, 2 disabled, 3 expired, 4 exhausted (out of
// remain_quota). 0 is a documented-invalid sentinel ("don't use 0, 0 is the
// default value!") that should never arrive from a real token row, but a
// labeled-unknown fallback (matching accountUsageTypeLabel's own precedent
// above) keeps a future/unexpected value from rendering as a blank cell.
const keyStatusLabels: Readonly<Record<number, string>> = {
  1: '启用中',
  2: '已禁用',
  3: '已过期',
  4: '额度已用尽',
}

/** Maps new-api's numeric Token.Status to a Chinese label for the Key 管理 tab (W4b). */
export function accountKeyStatusLabel(status: number): string {
  return keyStatusLabels[status] ?? `未知状态(${status})`
}

/**
 * quota -> USD for the Key 管理 tab's 额度/已用 columns (W4b). Unlike
 * formatUsageCostUsd above, a Key's remain_quota/used_quota are typically
 * whole-dollar-scale (the same integer-quota convention as account balance,
 * not a single request's sub-cent cost), so this reuses formatBalanceUsd's
 * plain 2-decimal formatting rather than formatUsageCostUsd's
 * trailing-zero-trimmed higher precision. quotaPerUnit is guarded the same
 * way formatUsageCostUsd guards it: unusable (0/NaN/negative/undefined --
 * the last covers the Key 列表 tab having loaded before the profile tab's
 * balance request resolves) returns the '—' placeholder rather than a
 * misleading "$0.00".
 */
export function formatKeyQuotaUsd(quota: number, quotaPerUnit: number | undefined): string {
  if (typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return '—'
  return formatBalanceUsd(quota, quotaPerUnit)
}

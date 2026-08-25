import { readBoundedResponseText } from './bounded-response'
import {
  decodeJwtPayload,
  identityFromCodexAuthTokens,
  officialChatGptPlanLabel,
} from './official-account-identity'

const usageUrl = 'https://chatgpt.com/backend-api/wham/usage'
const defaultTimeoutMs = 8_000
const defaultMaxResponseBytes = 256 * 1024
const redirectStatuses = new Set([301, 302, 303, 307, 308])

export interface OfficialChatGptWindow {
  id: string
  label: string
  remainingPercent: number
  resetAt: string | null
}

export interface OfficialChatGptAccount {
  planLabel: string | null
  renewsAt: string | null
  resetCredits: number | null
  windows: OfficialChatGptWindow[]
  checkedAt: string
}

export type OfficialUsageFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface OfficialUsageRequest {
  accessToken: string
  accountId?: string | null
}

const fiveHourWindowSeconds = 18_000
const weeklyWindowSeconds = 604_800

/**
 * Window kind comes from `limit_window_seconds` on the wire, not from
 * primary/secondary slot and not from reset remaining time.
 * CPA never infers this: Claude headers are already named 5h/7d, and Codex
 * usage is not classified at all. ChatGPT usage uses the same two exact
 * window sizes (5h = 18000, week = 604800).
 */
export function windowLabelFromSeconds(seconds: number | null, nameHint?: string): string {
  const prefix = nameHint?.trim() ? `${nameHint.trim().slice(0, 40)} ` : ''
  if (seconds === fiveHourWindowSeconds) return `${prefix}5 小时限额`.trim()
  if (seconds === weeklyWindowSeconds) return `${prefix}周限额`.trim()
  if (seconds !== null && seconds % 86_400 === 0 && seconds >= 86_400) {
    return `${prefix}${seconds / 86_400} 天限额`.trim()
  }
  if (seconds !== null && seconds % 3_600 === 0 && seconds >= 3_600) {
    return `${prefix}${seconds / 3_600} 小时限额`.trim()
  }
  return `${prefix}限额`.trim()
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function remainingPercentFromUsed(used: unknown): number | null {
  const parsed = finiteNumber(used)
  if (parsed === null) return null
  return Math.max(0, Math.min(100, Math.round(100 - parsed)))
}

// Reset time is a separate wire field. It must not feed window labels.
function resetAtFromWindow(window: Record<string, unknown>, now: Date): string | null {
  const resetAt = finiteNumber(window.reset_at)
  if (resetAt !== null) {
    const ms = resetAt > 1e12 ? resetAt : resetAt * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const resetAfter = finiteNumber(window.reset_after_seconds)
  if (resetAfter !== null && resetAfter > 0) {
    return new Date(now.getTime() + resetAfter * 1000).toISOString()
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readWindow(
  id: string,
  label: string,
  value: unknown,
  now: Date = new Date(),
): OfficialChatGptWindow | null {
  const window = asRecord(value)
  if (!window) return null
  const remainingPercent = remainingPercentFromUsed(window.used_percent)
  const seconds = finiteNumber(window.limit_window_seconds)
  const limitSeconds = seconds !== null && seconds > 0 ? seconds : null
  if (remainingPercent === null) return null
  return {
    id,
    label: windowLabelFromSeconds(limitSeconds, label),
    remainingPercent,
    resetAt: resetAtFromWindow(window, now),
  }
}

function additionalLimitName(entry: Record<string, unknown>, fallback: string): string {
  for (const key of ['name', 'limit_name', 'model', 'title', 'label']) {
    if (typeof entry[key] === 'string' && entry[key].trim()) return entry[key].trim().slice(0, 40)
  }
  return fallback
}

export function parseOfficialChatGptUsage(
  payload: unknown,
  fallback: { planLabel?: string | null; renewsAt?: string | null } = {},
): OfficialChatGptAccount | null {
  const root = asRecord(payload)
  if (!root) return null
  const rateLimit = asRecord(root.rate_limit)
  const now = new Date()
  const windows: OfficialChatGptWindow[] = []
  if (rateLimit) {
    const primary = readWindow('primary', '', rateLimit.primary_window, now)
    const secondary = readWindow('secondary', '', rateLimit.secondary_window, now)
    if (primary) windows.push(primary)
    if (secondary) windows.push(secondary)
  }

  const extra = root.additional_rate_limits
  if (Array.isArray(extra)) {
    extra.slice(0, 4).forEach((entry, index) => {
      const record = asRecord(entry)
      if (!record) return
      const name = additionalLimitName(record, `附加限额 ${index + 1}`)
      const nested = asRecord(record.rate_limit) ?? record
      const first = readWindow(`extra-${index}-primary`, name, nested.primary_window, now)
      const second = readWindow(`extra-${index}-secondary`, name, nested.secondary_window, now)
      if (first) windows.push(first)
      if (second) windows.push(second)
    })
  } else if (extra && typeof extra === 'object') {
    Object.entries(extra as Record<string, unknown>).slice(0, 4).forEach(([name, entry], index) => {
      const record = asRecord(entry)
      if (!record) return
      const nested = asRecord(record.rate_limit) ?? record
      const first = readWindow(`extra-${index}-primary`, name, nested.primary_window, now)
      const second = readWindow(`extra-${index}-secondary`, name, nested.secondary_window, now)
      if (first) windows.push(first)
      if (second) windows.push(second)
    })
  }

  const resetCreditsRoot = asRecord(root.rate_limit_reset_credits)
  const resetCredits = typeof resetCreditsRoot?.available_count === 'number'
    && Number.isInteger(resetCreditsRoot.available_count)
    && resetCreditsRoot.available_count >= 0
    && resetCreditsRoot.available_count <= 99
    ? resetCreditsRoot.available_count
    : null
  const planType = typeof root.plan_type === 'string' ? root.plan_type : null
  return {
    planLabel: officialChatGptPlanLabel(planType) ?? fallback.planLabel ?? null,
    renewsAt: fallback.renewsAt ?? null,
    resetCredits,
    windows: windows.slice(0, 6),
    checkedAt: new Date().toISOString(),
  }
}

export function officialUsageAccessToken(tokens: unknown): OfficialUsageRequest | null {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null
  const record = tokens as Record<string, unknown>
  if (typeof record.access_token !== 'string' || record.access_token.length < 16) return null
  const claims = decodeJwtPayload(record.access_token)
  const exp = typeof claims?.exp === 'number' ? claims.exp : null
  if (exp !== null && exp * 1000 <= Date.now() + 60_000) return null
  return {
    accessToken: record.access_token,
    accountId: officialUsageAccountId(record),
  }
}

function officialUsageAccountId(record: Record<string, unknown>): string | null {
  if (typeof record.account_id === 'string' && isDisplayAccountId(record.account_id)) {
    return record.account_id
  }
  const claims = decodeJwtPayload(record.id_token) ?? decodeJwtPayload(record.access_token)
  const auth = claims?.['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id
  return typeof accountId === 'string' && isDisplayAccountId(accountId) ? accountId : null
}

function isDisplayAccountId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,80}$/.test(value)
}

function identityOnlyAccount(
  tokens: unknown,
  options: {
    now?: Date
    fallback?: { planLabel?: string | null; renewsAt?: string | null }
  },
): OfficialChatGptAccount | null {
  const identity = identityFromCodexAuthTokens(tokens)
  const planLabel = options.fallback?.planLabel ?? identity.planLabel
  const renewsAt = options.fallback?.renewsAt ?? identity.renewsAt
  return planLabel || renewsAt
    ? {
        planLabel: planLabel ?? null,
        renewsAt: renewsAt ?? null,
        resetCredits: null,
        windows: [],
        checkedAt: (options.now ?? new Date()).toISOString(),
      }
    : null
}

export async function fetchOfficialChatGptUsage(
  tokens: unknown,
  options: {
    fetchImpl?: OfficialUsageFetch
    now?: Date
    fallback?: { planLabel?: string | null; renewsAt?: string | null }
  } = {},
): Promise<OfficialChatGptAccount | null> {
  const request = officialUsageAccessToken(tokens)
  if (!request) return identityOnlyAccount(tokens, options)

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), defaultTimeoutMs)
  try {
    const response = await fetchImpl(usageUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${request.accessToken}`,
        ...(request.accountId ? { 'ChatGPT-Account-Id': request.accountId } : {}),
      },
    })
    if (redirectStatuses.has(response.status) || !response.ok) {
      return identityOnlyAccount(tokens, options)
    }
    const origin = new URL(response.url || usageUrl)
    if (
      origin.protocol !== 'https:'
      || origin.hostname !== 'chatgpt.com'
      || origin.username !== ''
      || origin.password !== ''
    ) {
      return identityOnlyAccount(tokens, options)
    }
    const text = await readBoundedResponseText(response, defaultMaxResponseBytes, 'ChatGPT 用量')
    return parseOfficialChatGptUsage(JSON.parse(text) as unknown, {
      planLabel: options.fallback?.planLabel,
      renewsAt: options.fallback?.renewsAt,
    })
  } catch {
    return identityOnlyAccount(tokens, options)
  } finally {
    clearTimeout(timer)
  }
}

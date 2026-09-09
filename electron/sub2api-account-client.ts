import {
  accountRealms, captureRealmLogin, isRealmRecord, parseRealmSavedAccount, requireRealmUserId,
  RealmAccountError, type RealmCredential, type RealmLoginInput, type RealmSavedAccount, type RealmSessionBackend,
} from './realm-account'
import { sub2ApiManagedCliKeyProfiles, providerIds, type ProviderId } from './catalog'
import { summarizeKeySecret } from './key-secret-summary'

export interface Sub2ApiAccountClientOptions {
  /** Required injection; no default production fetch and no renderer-provided base URL. */
  fetchImpl(input: string, init: RequestInit): Promise<Response>
  timeoutMs?: number
  maxResponseBytes?: number
  now?: () => number
}

export interface Sub2ApiKeySummary {
  readonly id: string
  readonly name: string
  readonly groupId: string | null
  readonly status: 'active' | 'inactive' | 'quota_exhausted' | 'expired'
  readonly quota?: number
  readonly quotaUsed?: number
  readonly createdAt?: string
  readonly expiresAt?: string | null
  readonly lastUsedAt?: string | null
  readonly maskedKey?: string
  /** Main-only exact matching; strip before renderer DTO mapping. */
  readonly keyFingerprint?: string
}

export interface Sub2ApiGroupSummary {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly status: string
  readonly rateMultiplier?: number
}

export interface Sub2ApiProfile {
  readonly userId: string
  readonly email: string
  readonly username: string
  readonly balance: number
  readonly status: string
  readonly role: string | null
  readonly avatarUrl: string | null
  readonly balanceNotifyEnabled: boolean | null
  readonly balanceNotifyThreshold: number | null
}

export interface Sub2ApiManagedCliKey {
  readonly provider: ProviderId
  readonly group: string
  readonly id: string
  readonly name: string
  readonly key: string
}

export interface Sub2ApiAccountClient extends RealmSessionBackend {
  getPublicSettings(signal: AbortSignal): Promise<{ siteName: string; turnstileEnabled: boolean }>
  restore(saved: RealmSavedAccount, signal: AbortSignal, onRotation?: (saved: RealmSavedAccount) => void | Promise<void>): Promise<RealmSavedAccount>
  getBalance(saved: RealmSavedAccount, signal: AbortSignal): Promise<{ amount: string; unit: 'sub2api-balance' }>
  listKeys(saved: RealmSavedAccount, page: number, pageSize: number, signal: AbortSignal): Promise<{ items: Sub2ApiKeySummary[]; total: number }>
  revealKey(saved: RealmSavedAccount, id: string, signal: AbortSignal): Promise<string>
  getKey(saved: RealmSavedAccount, id: string, signal: AbortSignal): Promise<Sub2ApiKeySummary>
  createKey(saved: RealmSavedAccount, input: Sub2ApiKeyCreateInput, signal: AbortSignal): Promise<Sub2ApiKeySummary>
  updateKey(saved: RealmSavedAccount, id: string, input: Sub2ApiKeyUpdateInput, signal: AbortSignal): Promise<Sub2ApiKeySummary>
  revokeKey(saved: RealmSavedAccount, id: string, signal: AbortSignal): Promise<void>
  listGroups(saved: RealmSavedAccount, signal: AbortSignal): Promise<Sub2ApiGroupSummary[]>
  getProfile(saved: RealmSavedAccount, signal: AbortSignal): Promise<Sub2ApiProfile>
  updateProfile(saved: RealmSavedAccount, input: { username?: string; avatarUrl?: string | null; balanceNotifyEnabled?: boolean; balanceNotifyThreshold?: number | null }, signal: AbortSignal): Promise<Sub2ApiProfile>
  changePassword(saved: RealmSavedAccount, input: { oldPassword: string; newPassword: string }, signal: AbortSignal): Promise<void>
  /** Native Sub2API account-center endpoints. Payloads are validated/mapped by the relay adapter. */
  getUsage(saved: RealmSavedAccount, query: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  getDashboard(saved: RealmSavedAccount, query: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  getTasks(saved: RealmSavedAccount, query: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  getPaymentConfig(saved: RealmSavedAccount, signal: AbortSignal): Promise<unknown>
  getPaymentCheckoutInfo(saved: RealmSavedAccount, signal: AbortSignal): Promise<unknown>
  listPaymentOrders(saved: RealmSavedAccount, query: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  listSubscriptionPlans(saved: RealmSavedAccount, signal: AbortSignal): Promise<unknown>
  getSubscriptions(saved: RealmSavedAccount, path: 'active' | 'all' | 'progress' | 'summary', signal: AbortSignal): Promise<unknown>
  getAffiliate(saved: RealmSavedAccount, signal: AbortSignal): Promise<unknown>
  transferAffiliate(saved: RealmSavedAccount, signal: AbortSignal): Promise<unknown>
}

export interface Sub2ApiKeyCreateInput {
  name: string
  groupId: string | null
  /** Native USD, zero means unlimited. */
  quota?: number
  expiresInDays?: number
}

export interface Sub2ApiKeyUpdateInput {
  name: string
  groupId: string | null
  quota: number
  /** ISO timestamp, or empty string to clear expiry. */
  expiresAt: string
}

/**
 * Ensure the four desktop keys exist in the user's visible Sub2API groups.
 * Existing keys are reused by exact name/group; a newly created key is
 * revealed once because the create endpoint intentionally returns no secret.
 * The caller must persist the returned encrypted cache and must never retry
 * this operation after an ambiguous POST result.
 */
export async function provisionSub2ApiManagedCliKeys(
  client: Pick<Sub2ApiAccountClient, 'listGroups' | 'listKeys' | 'createKey' | 'revealKey'>,
  saved: RealmSavedAccount,
  signal: AbortSignal,
): Promise<Sub2ApiManagedCliKey[]> {
  const groups = await client.listGroups(saved, signal)
  const keys: Sub2ApiKeySummary[] = []
  for (let page = 1; ; page += 1) {
    if (page > 1000) throw new RealmAccountError('PROTOCOL')
    const batch = await client.listKeys(saved, page, 100, signal)
    const seen = new Set(keys.map((key) => key.id))
    if (batch.items.some((key) => seen.has(key.id))) throw new RealmAccountError('PROTOCOL')
    keys.push(...batch.items)
    if (keys.length >= batch.total) break
    if (!batch.items.length) throw new RealmAccountError('PROTOCOL')
  }
  const result: Sub2ApiManagedCliKey[] = []
  for (const provider of providerIds) {
    const profile = sub2ApiManagedCliKeyProfiles[provider]
    const matches = groups.filter((entry) => entry.name === profile.group && entry.status === 'active')
    if (matches.length !== 1) throw new RealmAccountError('UNSUPPORTED')
    const group = matches[0]
    const existing = keys.find((entry) => entry.name === profile.keyName && entry.groupId === group.id && entry.status === 'active')
    const summary = existing ?? await client.createKey(saved, { name: profile.keyName, groupId: group.id }, signal)
    const key = await client.revealKey(saved, summary.id, signal)
    result.push(Object.freeze({ provider, group: profile.group, id: summary.id, name: summary.name, key }))
  }
  return result
}

export interface Sub2ApiSessionExecutor {
  /** The latest credential, including any rotated refresh token. */
  session(): RealmSavedAccount
  /** Refreshes at most once concurrently and publishes the rotated credential. */
  refresh(signal: AbortSignal): Promise<RealmSavedAccount>
  /**
   * Runs an operation and, when explicitly enabled, retries one GET-like
   * operation after a definitive unauthorized response. The returned session
   * must be persisted by the caller when it differs from the input session.
   */
  executeWithRefresh<T>(
    operation: (saved: RealmSavedAccount, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    options?: { retryOnUnauthorized?: boolean },
  ): Promise<{ value: T; session: RealmSavedAccount }>
}

/**
 * Small main-process seam for sub2api token rotation. It deliberately knows
 * only how to restore a session; business methods remain separate so writes
 * can opt out of retrying an ambiguous request.
 */
export function createSub2ApiSessionExecutor(
  initial: RealmSavedAccount,
  client: Pick<Sub2ApiAccountClient, 'restore'>,
  options: { onSessionChange?: (saved: RealmSavedAccount) => void | Promise<void> } = {},
): Sub2ApiSessionExecutor {
  let current = parseRealmSavedAccount(initial)
  if (current.realmId !== 'api-account' || current.credential.kind !== 'sub2api') {
    throw new RealmAccountError('INVALID')
  }
  let refreshInFlight: Promise<RealmSavedAccount> | null = null

  async function publish(candidate: RealmSavedAccount, base: RealmSavedAccount): Promise<RealmSavedAccount> {
    const parsed = parseRealmSavedAccount(candidate)
    if (parsed.realmId !== 'api-account' || parsed.credential.kind !== 'sub2api'
      || parsed.userId !== base.userId) throw new RealmAccountError('PROTOCOL')
    current = parsed
    await options.onSessionChange?.(current)
    return current
  }

  async function refresh(signal: AbortSignal): Promise<RealmSavedAccount> {
    if (refreshInFlight) return refreshInFlight
    const base = current
    const pending = (async () => {
      const candidate = await client.restore(base, signal, async (rotated) => { await publish(rotated, base) })
      return publish(candidate, base)
    })()
    refreshInFlight = pending
    try { return await pending } finally {
      if (refreshInFlight === pending) refreshInFlight = null
    }
  }

  async function executeWithRefresh<T>(
    operation: (saved: RealmSavedAccount, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    options: { retryOnUnauthorized?: boolean } = {},
  ): Promise<{ value: T; session: RealmSavedAccount }> {
    const retry = options.retryOnUnauthorized === true
    // Also wait for durable rotation publication, not only the HTTP refresh.
    if (refreshInFlight) await refreshInFlight
    const attempt = current
    try {
      return { value: await operation(attempt, signal), session: current }
    } catch (error) {
      if (!retry || !(error instanceof RealmAccountError) || error.code !== 'UNAUTHORIZED') throw error
      // Another request may already have rotated the token while this one was
      // in flight. Adopt that result without issuing a second refresh.
      const refreshed = refreshInFlight ? await refreshInFlight : current === attempt ? await refresh(signal) : current
      const value = await operation(refreshed, signal)
      return { value, session: current }
    }
  }

  return Object.freeze({ session: () => current, refresh, executeWithRefresh })
}

function protocol(): never { throw new RealmAccountError('PROTOCOL') }

function wireId(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) protocol()
  return String(value)
}

function apiSession(value: RealmSavedAccount): RealmSavedAccount & { credential: Extract<RealmCredential, { kind: 'sub2api' }> } {
  const saved = parseRealmSavedAccount(value)
  if (saved.realmId !== 'api-account' || saved.credential.kind !== 'sub2api') throw new RealmAccountError('INVALID')
  return { ...saved, credential: saved.credential }
}

function parseUser(value: unknown): { userId: string; username: string; balance: number; email: string } {
  if (!isRealmRecord(value) || value.status !== 'active') protocol()
  const userId = wireId(value.id)
  const username = typeof value.username === 'string' && value.username.trim() ? value.username : value.email
  if ((value.email !== undefined && (typeof value.email !== 'string' || value.email.length > 320))
    || typeof username !== 'string' || !username.trim() || username.length > 256
    || /[\u0000-\u001f\u007f]/.test(username) || typeof value.balance !== 'number'
    || !Number.isFinite(value.balance) || Math.abs(value.balance) > Number.MAX_SAFE_INTEGER) protocol()
  return { userId, username: username.trim(), balance: value.balance,
    email: typeof value.email === 'string' ? value.email.trim() : '' }
}

function parseProfile(value: unknown): Sub2ApiProfile {
  const user = parseUser(value)
  if (!user.email) protocol()
  const role = value && isRealmRecord(value) && typeof value.role === 'string' ? value.role : null
  const avatarUrl = value && isRealmRecord(value) && typeof value.avatar_url === 'string' ? value.avatar_url : null
  const notify = value && isRealmRecord(value) && typeof value.balance_notify_enabled === 'boolean' ? value.balance_notify_enabled : null
  const threshold = value && isRealmRecord(value) && typeof value.balance_notify_threshold === 'number' && Number.isFinite(value.balance_notify_threshold)
    ? value.balance_notify_threshold : null
  return Object.freeze({ userId: user.userId, email: user.email, username: user.username, balance: user.balance,
    status: String(value && isRealmRecord(value) ? value.status : 'active'), role, avatarUrl,
    balanceNotifyEnabled: notify, balanceNotifyThreshold: threshold })
}

function groupSummary(value: unknown): Sub2ApiGroupSummary {
  if (!isRealmRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256
    || typeof value.platform !== 'string' || !value.platform.trim() || value.platform.length > 64
    || typeof value.status !== 'string' || !value.status.trim()) protocol()
  if (value.rate_multiplier !== undefined && (typeof value.rate_multiplier !== 'number' || !Number.isFinite(value.rate_multiplier) || value.rate_multiplier < 0)) protocol()
  return Object.freeze({ id: String(value.id), name: value.name.trim(), platform: value.platform.trim(), status: value.status.trim(),
    ...(value.rate_multiplier === undefined ? {} : { rateMultiplier: value.rate_multiplier as number }) })
}

function optionalKeyDate(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) protocol()
  return new Date(value).toISOString()
}

function keySummary(value: unknown, userId: string): Sub2ApiKeySummary {
  if (!isRealmRecord(value) || wireId(value.user_id) !== userId || typeof value.name !== 'string'
    || value.name.length > 256 || /[\u0000-\u001f\u007f]/.test(value.name)
    || !['active', 'inactive', 'quota_exhausted', 'expired'].includes(String(value.status))) protocol()
  for (const field of ['quota', 'quota_used']) {
    const amount = value[field]
    if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER)) protocol()
  }
  return Object.freeze({ id: wireId(value.id), name: value.name,
    ...summarizeKeySecret(value.key),
    groupId: value.group_id === null ? null : wireId(value.group_id),
    status: value.status as Sub2ApiKeySummary['status'],
    ...(value.quota === undefined ? {} : { quota: value.quota as number }),
    ...(value.quota_used === undefined ? {} : { quotaUsed: value.quota_used as number }),
    ...(value.created_at === undefined ? {} : { createdAt: optionalKeyDate(value.created_at) ?? '' }),
    ...(value.expires_at === undefined ? {} : { expiresAt: optionalKeyDate(value.expires_at) }),
    ...(value.last_used_at === undefined ? {} : { lastUsedAt: optionalKeyDate(value.last_used_at) }) })
}

/**
 * Ordinary user endpoints verified against the bundled Wei-Shaw/sub2api source.
 * Uses native DTOs, not fabricated NewApi quota/cookie/group-name mappings.
 */
export function createSub2ApiAccountClient(options: Sub2ApiAccountClientOptions): Sub2ApiAccountClient {
  const origin = accountRealms['api-account'].origin
  const timeoutMs = options.timeoutMs ?? 10000
  const maxBytes = options.maxResponseBytes ?? 512 * 1024
  const now = options.now ?? Date.now
  if (typeof options.fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw new RealmAccountError('INVALID')

  async function request(route: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: unknown, token: string | null, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new RealmAccountError('ABORTED')
    const url = new URL(`/api/v1${route}`, origin)
    if (url.origin !== origin || url.username || url.password || url.hash) throw new RealmAccountError('INVALID')
    const controller = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectStop: (error: Error) => void = () => undefined
    let stopCode: 'TIMEOUT' | 'ABORTED' | undefined
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject })
    function stop(code: 'TIMEOUT' | 'ABORTED'): void {
      if (stopCode) return
      stopCode = code
      controller.abort()
      if (reader) void reader.cancel().catch(() => undefined)
      rejectStop(new RealmAccountError(code))
    }
    function onAbort(): void { stop('ABORTED') }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
    if (signal.aborted) onAbort()
    try {
      const load = (async () => {
        const response = await options.fetchImpl(url.href, {
          method, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
          headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        reader = response.body?.getReader()
        if (controller.signal.aborted) throw new RealmAccountError(stopCode ?? 'ABORTED')
        if (response.redirected || (response.status >= 300 && response.status < 400)
          || (response.url && new URL(response.url).href !== url.href)) protocol()
        if (response.status === 401) throw new RealmAccountError('UNAUTHORIZED')
        if (!response.ok) throw new RealmAccountError('NETWORK')
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !reader) protocol()
        const declaredLength = response.headers.get('content-length')
        if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) protocol()
        const chunks: Uint8Array[] = []
        let length = 0
        let chunkCount = 0
        while (true) {
          const next = await reader.read()
          if (controller.signal.aborted) throw new RealmAccountError(stopCode ?? 'ABORTED')
          if (next.done) break
          length += next.value.byteLength
          chunkCount += 1
          if (chunkCount > 65536) protocol()
          if (length > maxBytes) protocol()
          chunks.push(next.value)
        }
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        let payload: unknown
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { protocol() }
        if (!isRealmRecord(payload) || payload.code !== 0 || !Object.hasOwn(payload, 'data')) protocol()
        return payload.data
      })()
      return await Promise.race([load, stopped])
    } catch (error) {
      if (stopCode) throw new RealmAccountError(stopCode)
      throw error instanceof RealmAccountError ? error : new RealmAccountError('NETWORK')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      controller.abort()
      if (reader) void reader.cancel().catch(() => undefined)
    }
  }

  function tokens(value: unknown): Extract<RealmCredential, { kind: 'sub2api' }> {
    if (!isRealmRecord(value) || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') protocol()
    let expiresAt: number | null = null
    if (value.expires_in !== undefined) {
      if (typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0) protocol()
      expiresAt = now() + value.expires_in * 1000
    }
    // Reuse the envelope validator to bound all opaque credential fields.
    try {
      const saved = parseRealmSavedAccount({ version: 2, realmId: 'api-account', origin, userId: '1', username: 'validation',
        credential: { kind: 'sub2api', accessToken: value.access_token, refreshToken: value.refresh_token ?? null, expiresAt } })
      if (saved.credential.kind !== 'sub2api') protocol()
      return saved.credential
    } catch { return protocol() }
  }

  async function me(saved: RealmSavedAccount, signal: AbortSignal) {
    const session = apiSession(saved)
    const user = parseUser(await request('/auth/me', 'GET', undefined, session.credential.accessToken, signal))
    if (user.userId !== session.userId) protocol()
    return user
  }

  function queryString(query: Record<string, unknown>): string {
    const params = new URLSearchParams()
    // Relay methods use camelCase while the native wire API uses snake_case.
    const wireKeys: Record<string, string> = {
      pageSize: 'page_size', apiKeyId: 'api_key_id', groupId: 'group_id',
      requestType: 'request_type', nativeCompactionV2: 'native_compaction_v2',
      billingType: 'billing_type', billingMode: 'billing_mode',
      startDate: 'start_date', endDate: 'end_date', sortBy: 'sort_by',
      sortOrder: 'sort_order', modelSource: 'model_source',
    }
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      params.set(wireKeys[key] ?? key, typeof value === 'boolean' ? value ? 'true' : 'false' : String(value))
    }
    const encoded = params.toString()
    return encoded ? `?${encoded}` : ''
  }

  async function authedRequest(saved: RealmSavedAccount, route: string, signal: AbortSignal): Promise<unknown> {
    const session = apiSession(saved)
    return request(route, 'GET', undefined, session.credential.accessToken, signal)
  }

  return Object.freeze({
    realmId: 'api-account',
    getPublicSettings: async (signal: AbortSignal) => {
      const data = await request('/settings/public', 'GET', undefined, null, signal)
      if (!isRealmRecord(data) || typeof data.site_name !== 'string' || !data.site_name.trim() || data.site_name.length > 256
        || typeof data.turnstile_enabled !== 'boolean') protocol()
      return { siteName: data.site_name.trim(), turnstileEnabled: data.turnstile_enabled }
    },
    authenticate: async (input: RealmLoginInput, signal: AbortSignal) => {
      const captured = captureRealmLogin(input)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(captured.identifier)) throw new RealmAccountError('INVALID')
      let data: unknown
      try {
        data = await request('/auth/login', 'POST', { email: captured.identifier, password: captured.password,
          ...(captured.turnstileToken === undefined ? {} : { turnstile_token: captured.turnstileToken }) }, null, signal)
      } catch (error) {
        // AuthService.Login returns HTTP 401 for INVALID_CREDENTIALS. Scope
        // this type to the password POST; /me, profile and refresh 401s must
        // never make automatic routing try another account backend.
        if (error instanceof RealmAccountError && error.code === 'UNAUTHORIZED') throw new RealmAccountError('LOGIN_REJECTED')
        throw error
      }
      if (!isRealmRecord(data)) protocol()
      if (data.requires_2fa === true) throw new RealmAccountError('TWO_FACTOR_REQUIRED')
      const user = parseUser(data.user)
      return parseRealmSavedAccount({ version: 2, realmId: 'api-account', origin,
        userId: user.userId, username: user.username, credential: tokens(data) })
    },
    restore: async (saved: RealmSavedAccount, signal: AbortSignal, onRotation?: (saved: RealmSavedAccount) => void | Promise<void>) => {
      const original = apiSession(saved)
      let candidate: RealmSavedAccount = original
      try {
        const user = await me(original, signal)
        candidate = parseRealmSavedAccount({ ...original, username: user.username })
      } catch (error) {
        if (!(error instanceof RealmAccountError) || error.code !== 'UNAUTHORIZED' || !original.credential.refreshToken) throw error
        const refreshed = await request('/auth/refresh', 'POST', { refresh_token: original.credential.refreshToken }, null, signal)
        candidate = parseRealmSavedAccount({ ...original, credential: tokens(refreshed) })
        // Refresh tokens rotate on the server before /me is retried. Publish
        // the replacement even if subsequent identity verification times out.
        await onRotation?.(candidate)
        const user = await me(candidate, signal)
        candidate = parseRealmSavedAccount({ ...candidate, username: user.username })
      }
      return candidate
    },
    getBalance: async (saved: RealmSavedAccount, signal: AbortSignal) => {
      const user = await me(saved, signal)
      return { amount: String(user.balance), unit: 'sub2api-balance' as const }
    },
    listKeys: async (saved: RealmSavedAccount, page: number, pageSize: number, signal: AbortSignal) => {
      const session = apiSession(saved)
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RealmAccountError('INVALID')
      const data = await request(`/keys?page=${page}&page_size=${pageSize}`, 'GET', undefined, session.credential.accessToken, signal)
      if (!isRealmRecord(data) || !Array.isArray(data.items) || data.items.length > pageSize
        || typeof data.total !== 'number' || !Number.isSafeInteger(data.total) || data.total < data.items.length) protocol()
      const items = data.items.map((item) => keySummary(item, session.userId))
      if (new Set(items.map((item) => item.id)).size !== items.length) protocol()
      return { items, total: data.total }
    },
    revealKey: async (saved: RealmSavedAccount, id: string, signal: AbortSignal) => {
      const session = apiSession(saved)
      const data = await request(`/keys/${requireRealmUserId(id)}`, 'GET', undefined, session.credential.accessToken, signal)
      const summary = keySummary(data, session.userId)
      if (summary.id !== id || !isRealmRecord(data) || typeof data.key !== 'string' || !data.key || data.key.length > 4096
        || /[\s*\u0000-\u001f\u007f]/.test(data.key)) protocol()
      return data.key
    },
    getKey: async (saved: RealmSavedAccount, id: string, signal: AbortSignal) => {
      const session = apiSession(saved)
      const summary = keySummary(await request(`/keys/${requireRealmUserId(id)}`, 'GET', undefined, session.credential.accessToken, signal), session.userId)
      if (summary.id !== id) protocol()
      return summary
    },
    createKey: async (saved: RealmSavedAccount, input: Sub2ApiKeyCreateInput, signal: AbortSignal) => {
      const session = apiSession(saved)
      if (!isRealmRecord(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100
        || /[\u0000-\u001f\u007f]/.test(input.name)) throw new RealmAccountError('INVALID')
      const groupId = input.groupId === null ? null : Number(requireRealmUserId(input.groupId))
      if (input.quota !== undefined && (typeof input.quota !== 'number' || !Number.isFinite(input.quota) || input.quota < 0 || input.quota > Number.MAX_SAFE_INTEGER)) throw new RealmAccountError('INVALID')
      if (input.expiresInDays !== undefined && (!Number.isSafeInteger(input.expiresInDays) || input.expiresInDays <= 0 || input.expiresInDays > 365000)) throw new RealmAccountError('INVALID')
      // No write retry: an ambiguous network outcome must not mint a second paid-account key.
      const data = await request('/keys', 'POST', { name: input.name.trim(), group_id: groupId,
        ...(input.quota === undefined ? {} : { quota: input.quota }),
        ...(input.expiresInDays === undefined ? {} : { expires_in_days: input.expiresInDays }) }, session.credential.accessToken, signal)
      const summary = keySummary(data, session.userId)
      if (summary.groupId !== input.groupId) protocol()
      return summary
    },
    updateKey: async (saved: RealmSavedAccount, id: string, input: Sub2ApiKeyUpdateInput, signal: AbortSignal) => {
      const session = apiSession(saved)
      if (!isRealmRecord(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100
        || /[\u0000-\u001f\u007f]/.test(input.name) || typeof input.quota !== 'number' || !Number.isFinite(input.quota)
        || input.quota < 0 || input.quota > Number.MAX_SAFE_INTEGER || typeof input.expiresAt !== 'string'
        || (input.expiresAt !== '' && !Number.isFinite(Date.parse(input.expiresAt)))) throw new RealmAccountError('INVALID')
      // The server treats a null group as "unchanged" on update, so clearing
      // a bound group cannot be represented faithfully by this endpoint.
      if (input.groupId === null) throw new RealmAccountError('UNSUPPORTED')
      const data = await request(`/keys/${requireRealmUserId(id)}`, 'PUT', { name: input.name.trim(),
        group_id: Number(requireRealmUserId(input.groupId)), quota: input.quota, expires_at: input.expiresAt }, session.credential.accessToken, signal)
      const summary = keySummary(data, session.userId)
      if (summary.id !== id || summary.groupId !== input.groupId) protocol()
      return summary
    },
    revokeKey: async (saved: RealmSavedAccount, id: string, signal: AbortSignal) => {
      const session = apiSession(saved)
      await request(`/keys/${requireRealmUserId(id)}`, 'DELETE', undefined, session.credential.accessToken, signal)
    },
    listGroups: async (saved: RealmSavedAccount, signal: AbortSignal) => {
      const session = apiSession(saved)
      const data = await request('/groups/available', 'GET', undefined, session.credential.accessToken, signal)
      if (!Array.isArray(data)) protocol()
      const groups = data.map(groupSummary)
      if (new Set(groups.map((group) => group.id)).size !== groups.length) protocol()
      return groups
    },
    getProfile: async (saved: RealmSavedAccount, signal: AbortSignal) => {
      const session = apiSession(saved)
      const profile = parseProfile(await request('/user/profile', 'GET', undefined, session.credential.accessToken, signal))
      if (profile.userId !== session.userId) protocol()
      return profile
    },
    updateProfile: async (saved: RealmSavedAccount, input: { username?: string; avatarUrl?: string | null; balanceNotifyEnabled?: boolean; balanceNotifyThreshold?: number | null }, signal: AbortSignal) => {
      const session = apiSession(saved)
      if (!isRealmRecord(input) || Object.keys(input).length === 0) throw new RealmAccountError('INVALID')
      const body: Record<string, unknown> = {}
      if (input.username !== undefined) {
        if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 256 || /[\u0000-\u001f\u007f]/.test(input.username)) throw new RealmAccountError('INVALID')
        body.username = input.username.trim()
      }
      if (input.avatarUrl !== undefined) {
        if (input.avatarUrl !== null && (typeof input.avatarUrl !== 'string' || input.avatarUrl.length > 2048 || /[\u0000-\u001f\u007f]/.test(input.avatarUrl))) throw new RealmAccountError('INVALID')
        body.avatar_url = input.avatarUrl
      }
      if (input.balanceNotifyEnabled !== undefined) {
        if (typeof input.balanceNotifyEnabled !== 'boolean') throw new RealmAccountError('INVALID')
        body.balance_notify_enabled = input.balanceNotifyEnabled
      }
      if (input.balanceNotifyThreshold !== undefined) {
        if (input.balanceNotifyThreshold !== null && (typeof input.balanceNotifyThreshold !== 'number' || !Number.isFinite(input.balanceNotifyThreshold) || input.balanceNotifyThreshold < 0)) throw new RealmAccountError('INVALID')
        body.balance_notify_threshold = input.balanceNotifyThreshold
      }
      if (Object.keys(body).length === 0) throw new RealmAccountError('INVALID')
      const profile = parseProfile(await request('/user', 'PUT', body, session.credential.accessToken, signal))
      if (profile.userId !== session.userId) protocol()
      return profile
    },
    changePassword: async (saved: RealmSavedAccount, input: { oldPassword: string; newPassword: string }, signal: AbortSignal) => {
      const session = apiSession(saved)
      if (!isRealmRecord(input) || typeof input.oldPassword !== 'string' || !input.oldPassword || input.oldPassword.length > 4096
        || typeof input.newPassword !== 'string' || input.newPassword.length < 6 || input.newPassword.length > 4096) throw new RealmAccountError('INVALID')
      await request('/user/password', 'PUT', { old_password: input.oldPassword, new_password: input.newPassword }, session.credential.accessToken, signal)
    },
    getUsage: async (saved: RealmSavedAccount, query: Record<string, unknown>, signal: AbortSignal) => authedRequest(saved, `/usage${queryString(query)}`, signal),
    getDashboard: async (saved: RealmSavedAccount, query: Record<string, unknown>, signal: AbortSignal) => authedRequest(saved, `/usage/dashboard/stats${queryString(query)}`, signal),
    // Sub2API has no media/task queue equivalent to new-api's /api/task/self.
    // Do not alias this to /usage: that would make the task tab display usage
    // rows with an incompatible schema.
    getTasks: async () => { throw new RealmAccountError('UNSUPPORTED') },
    getPaymentConfig: async (saved: RealmSavedAccount, signal: AbortSignal) => authedRequest(saved, '/payment/config', signal),
    getPaymentCheckoutInfo: async (saved: RealmSavedAccount, signal: AbortSignal) => authedRequest(saved, '/payment/checkout-info', signal),
    listPaymentOrders: async (saved: RealmSavedAccount, query: Record<string, unknown>, signal: AbortSignal) => authedRequest(saved, `/payment/orders/my${queryString(query)}`, signal),
    listSubscriptionPlans: async (saved: RealmSavedAccount, signal: AbortSignal) => authedRequest(saved, '/payment/plans', signal),
    getSubscriptions: async (saved: RealmSavedAccount, path: 'active' | 'all' | 'progress' | 'summary', signal: AbortSignal) => {
      const route = path === 'all' ? '/subscriptions' : path === 'active' ? '/subscriptions/active' : `/subscriptions/${path}`
      return authedRequest(saved, route, signal)
    },
    getAffiliate: async (saved: RealmSavedAccount, signal: AbortSignal) => authedRequest(saved, '/user/aff', signal),
    transferAffiliate: async (saved: RealmSavedAccount, signal: AbortSignal) => {
      const session = apiSession(saved)
      return request('/user/aff/transfer', 'POST', {}, session.credential.accessToken, signal)
    },
  })
}

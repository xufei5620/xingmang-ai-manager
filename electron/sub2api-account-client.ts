import {
  accountRealms, captureRealmLogin, isRealmRecord, parseRealmSavedAccount, requireRealmUserId,
  RealmAccountError, type RealmCredential, type RealmLoginInput, type RealmSavedAccount, type RealmSessionBackend,
} from './realm-account'
import { managedCliKeyProfiles, providerIds, type ProviderId } from './catalog'

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
}

export interface Sub2ApiGroupSummary {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly status: string
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
  getBalance(saved: RealmSavedAccount, signal: AbortSignal): Promise<{ amount: string; unit: 'sub2api-balance' }>
  listKeys(saved: RealmSavedAccount, page: number, pageSize: number, signal: AbortSignal): Promise<{ items: Sub2ApiKeySummary[]; total: number }>
  revealKey(saved: RealmSavedAccount, id: string, signal: AbortSignal): Promise<string>
  createKey(saved: RealmSavedAccount, input: { name: string; groupId: string | null }, signal: AbortSignal): Promise<Sub2ApiKeySummary>
  revokeKey(saved: RealmSavedAccount, id: string, signal: AbortSignal): Promise<void>
  listGroups(saved: RealmSavedAccount, signal: AbortSignal): Promise<Sub2ApiGroupSummary[]>
  getProfile(saved: RealmSavedAccount, signal: AbortSignal): Promise<Sub2ApiProfile>
  updateProfile(saved: RealmSavedAccount, input: { username?: string; avatarUrl?: string | null; balanceNotifyEnabled?: boolean; balanceNotifyThreshold?: number | null }, signal: AbortSignal): Promise<Sub2ApiProfile>
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
  const keys = await client.listKeys(saved, 1, 100, signal)
  const result: Sub2ApiManagedCliKey[] = []
  for (const provider of providerIds) {
    const profile = managedCliKeyProfiles[provider]
    const group = groups.find((entry) => entry.name === profile.group)
    if (!group) throw new RealmAccountError('UNSUPPORTED')
    const existing = keys.items.find((entry) => entry.name === profile.keyName && entry.groupId === group.id && entry.status === 'active')
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
): Sub2ApiSessionExecutor {
  let current = parseRealmSavedAccount(initial)
  if (current.realmId !== 'api-account' || current.credential.kind !== 'sub2api') {
    throw new RealmAccountError('INVALID')
  }
  let refreshInFlight: Promise<RealmSavedAccount> | null = null

  async function refresh(signal: AbortSignal): Promise<RealmSavedAccount> {
    if (refreshInFlight) return refreshInFlight
    const base = current
    const pending = (async () => {
      const candidate = parseRealmSavedAccount(await client.restore(base, signal))
      if (candidate.realmId !== 'api-account' || candidate.credential.kind !== 'sub2api'
        || candidate.userId !== base.userId) throw new RealmAccountError('PROTOCOL')
      current = candidate
      return candidate
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
    const attempt = current
    try {
      return { value: await operation(attempt, signal), session: current }
    } catch (error) {
      if (!retry || !(error instanceof RealmAccountError) || error.code !== 'UNAUTHORIZED') throw error
      // Another request may already have rotated the token while this one was
      // in flight. Adopt that result without issuing a second refresh.
      const refreshed = current === attempt ? await refresh(signal) : current
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
  return Object.freeze({ id: String(value.id), name: value.name.trim(), platform: value.platform.trim(), status: value.status.trim() })
}

function keySummary(value: unknown, userId: string): Sub2ApiKeySummary {
  if (!isRealmRecord(value) || wireId(value.user_id) !== userId || typeof value.name !== 'string'
    || value.name.length > 256 || /[\u0000-\u001f\u007f]/.test(value.name)
    || !['active', 'inactive', 'quota_exhausted', 'expired'].includes(String(value.status))) protocol()
  return Object.freeze({ id: wireId(value.id), name: value.name,
    groupId: value.group_id === null ? null : wireId(value.group_id),
    status: value.status as Sub2ApiKeySummary['status'] })
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

  return Object.freeze({
    realmId: 'api-account',
    authenticate: async (input: RealmLoginInput, signal: AbortSignal) => {
      const captured = captureRealmLogin(input)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(captured.identifier)) throw new RealmAccountError('INVALID')
      const data = await request('/auth/login', 'POST', { email: captured.identifier, password: captured.password,
        ...(captured.turnstileToken === undefined ? {} : { turnstile_token: captured.turnstileToken }) }, null, signal)
      if (!isRealmRecord(data)) protocol()
      if (data.requires_2fa === true) throw new RealmAccountError('TWO_FACTOR_REQUIRED')
      const user = parseUser(data.user)
      return parseRealmSavedAccount({ version: 2, realmId: 'api-account', origin,
        userId: user.userId, username: user.username, credential: tokens(data) })
    },
    restore: async (saved: RealmSavedAccount, signal: AbortSignal) => {
      const original = apiSession(saved)
      let candidate: RealmSavedAccount = original
      try {
        const user = await me(original, signal)
        candidate = parseRealmSavedAccount({ ...original, username: user.username })
      } catch (error) {
        if (!(error instanceof RealmAccountError) || error.code !== 'UNAUTHORIZED' || !original.credential.refreshToken) throw error
        const refreshed = await request('/auth/refresh', 'POST', { refresh_token: original.credential.refreshToken }, null, signal)
        candidate = parseRealmSavedAccount({ ...original, credential: tokens(refreshed) })
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
    createKey: async (saved: RealmSavedAccount, input: { name: string; groupId: string | null }, signal: AbortSignal) => {
      const session = apiSession(saved)
      if (!isRealmRecord(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100
        || /[\u0000-\u001f\u007f]/.test(input.name)) throw new RealmAccountError('INVALID')
      const groupId = input.groupId === null ? null : Number(requireRealmUserId(input.groupId))
      // No write retry: an ambiguous network outcome must not mint a second paid-account key.
      const data = await request('/keys', 'POST', { name: input.name.trim(), group_id: groupId }, session.credential.accessToken, signal)
      const summary = keySummary(data, session.userId)
      if (summary.groupId !== input.groupId) protocol()
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
  })
}

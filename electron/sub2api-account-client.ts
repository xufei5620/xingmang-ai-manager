import {
  accountRealms, captureRealmLogin, isRealmRecord, parseRealmSavedAccount, requireRealmUserId,
  RealmAccountError, type RealmCredential, type RealmLoginInput, type RealmSavedAccount, type RealmSessionBackend,
} from './realm-account'

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

export interface Sub2ApiAccountClient extends RealmSessionBackend {
  getBalance(saved: RealmSavedAccount, signal: AbortSignal): Promise<{ amount: string; unit: 'sub2api-balance' }>
  listKeys(saved: RealmSavedAccount, page: number, pageSize: number, signal: AbortSignal): Promise<{ items: Sub2ApiKeySummary[]; total: number }>
  revealKey(saved: RealmSavedAccount, id: string, signal: AbortSignal): Promise<string>
  createKey(saved: RealmSavedAccount, input: { name: string; groupId: string | null }, signal: AbortSignal): Promise<Sub2ApiKeySummary>
  revokeKey(saved: RealmSavedAccount, id: string, signal: AbortSignal): Promise<void>
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

function parseUser(value: unknown): { userId: string; username: string; balance: number } {
  if (!isRealmRecord(value) || value.status !== 'active') protocol()
  const userId = wireId(value.id)
  const username = typeof value.username === 'string' && value.username.trim() ? value.username : value.email
  if (typeof username !== 'string' || !username.trim() || username.length > 256
    || /[\u0000-\u001f\u007f]/.test(username) || typeof value.balance !== 'number'
    || !Number.isFinite(value.balance) || Math.abs(value.balance) > Number.MAX_SAFE_INTEGER) protocol()
  return { userId, username: username.trim(), balance: value.balance }
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
 * Ordinary user endpoints verified against Wei-Shaw/sub2api@270eac6.
 * Uses neutral DTOs, not fabricated NewApiQuota/cookie/group-name mappings.
 * This client is not yet registered in the shipping xm-only SiteRuntime.
 */
export function createSub2ApiAccountClient(options: Sub2ApiAccountClientOptions): Sub2ApiAccountClient {
  const origin = accountRealms['api-account'].origin
  const timeoutMs = options.timeoutMs ?? 10000
  const maxBytes = options.maxResponseBytes ?? 512 * 1024
  const now = options.now ?? Date.now
  if (typeof options.fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw new RealmAccountError('INVALID')

  async function request(route: string, method: 'GET' | 'POST' | 'DELETE', body: unknown, token: string | null, signal: AbortSignal): Promise<unknown> {
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
  })
}

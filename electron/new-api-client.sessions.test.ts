import { describe, expect, it, vi } from 'vitest'
import { createNewApiClient, NewApiSessionChangedError, type NewApiFetch } from './new-api-client'

function response(data: unknown, options: { status?: number; success?: boolean; cookies?: string[]; message?: string } = {}): Response {
  const result = new Response(JSON.stringify({ success: options.success ?? true, message: options.message ?? '', data }), { status: options.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  for (const cookie of options.cookies ?? []) result.headers.append('set-cookie', cookie)
  return result
}
function user(userId: number) { return { id: userId, username: `user-${userId}`, role: 1, group: 'default', quota: userId * 100, used_quota: 0 } }
function loginResponse(userId: number) { return response({ access_token: `access-${userId}`, access_expires_at: null, user: user(userId) }, { cookies: [`refresh_token=cookie-${userId}`] }) }
function refreshResponse(userId: number) { return response({ access_token: `refreshed-${userId}`, access_expires_at: null }, { cookies: [`refresh_token=cookie-${userId}`] }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
type Handler = (pathname: string, init: RequestInit) => Response | Promise<Response> | undefined
function harness(timeoutMs = 1000) {
  let handler: Handler | undefined
  const fetchImpl = vi.fn<NewApiFetch>(async (url, init = {}) => {
    const pathname = new URL(url).pathname
    const overridden = handler?.(pathname, init)
    if (overridden) return overridden
    const headers = init.headers as Record<string, string>
    if (pathname === '/api/user/login') return loginResponse(Number(JSON.parse(String(init.body)).username))
    if (pathname === '/api/user/auth/refresh') return refreshResponse(Number(headers.Cookie.match(/cookie-(\d+)/)?.[1] ?? 0))
    if (pathname === '/api/status') return response({ quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 1 })
    if (pathname === '/api/user/self') return response(user(Number(headers['New-Api-User'])))
    throw new Error(`Unexpected fixture request: ${pathname}`)
  })
  const onSessionChange = vi.fn()
  const client = createNewApiClient({ baseUrl: 'https://accounts.test.internal', timeoutMs, fetchImpl, onSessionChange })
  return { client, fetchImpl, onSessionChange, setHandler: (next: Handler) => { handler = next }, login: (id: number) => client.login({ username: String(id), password: 'fixture-password' }) }
}
const target = (userId: number) => ({ userId, cookies: [`refresh_token=cookie-${userId}`] })
const userHeader = (init: RequestInit) => (init.headers as Record<string, string>)['New-Api-User']

describe('saved session switching', () => {
  it('exposes a main-process revision for ownership intents but keeps token refresh in the same revision', async () => {
    const h = harness()
    const before = h.client.getSessionRevision()
    await h.login(1)
    const loggedIn = h.client.getSessionRevision()
    expect(loggedIn).toBeGreaterThan(before)
    await h.client.refreshAccessToken()
    expect(h.client.getSessionRevision()).toBe(loggedIn)
    const slowLogin = deferred<Response>()
    h.setHandler((pathname) => pathname === '/api/user/login' ? slowLogin.promise : undefined)
    const attempted = expect(h.login(1)).rejects.toThrow()
    expect(h.client.getSessionRevision()).toBeGreaterThan(loggedIn)
    const pendingLogin = h.client.getSessionRevision()
    h.client.logout()
    expect(h.client.getSessionRevision()).toBeGreaterThan(pendingLogin)
    slowLogin.resolve(loginResponse(1))
    await attempted
  })

  it('keeps the active account until candidate refresh and matching profile both succeed', async () => {
    const h = harness()
    await h.login(1)
    const candidate = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/self' && userHeader(init) === '2' ? candidate.promise : undefined)
    const switching = h.client.switchSession(target(2))
    await vi.waitFor(() => expect(h.fetchImpl.mock.calls.some(([url, init]) => new URL(url).pathname === '/api/user/self' && userHeader(init!) === '2')).toBe(true))
    expect(h.client.getSessionState().account?.userId).toBe(1)
    expect(h.onSessionChange).toHaveBeenCalledTimes(1)
    candidate.resolve(response(user(2)))
    await expect(switching).resolves.toBe(true)
    expect(h.client.getSessionState().account?.userId).toBe(2)
    expect(h.client.getPersistableSession()).toEqual(target(2))
  })

  it.each(['refresh-401', 'profile-401', 'wrong-profile', 'timeout'] as const)('preserves the active account when target validation fails: %s', async (failure) => {
    const h = harness(20)
    await h.login(1)
    const before = h.client.getSessionState()
    h.setHandler((pathname, init) => {
      if (pathname === '/api/user/auth/refresh' && failure === 'refresh-401') return response(null, { status: 401, success: false })
      if (pathname === '/api/user/auth/refresh' && failure === 'timeout') return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
      if (pathname === '/api/user/self' && failure === 'profile-401') return response(null, { status: 401, success: false })
      if (pathname === '/api/user/self' && failure === 'wrong-profile') return response(user(99))
    })
    if (failure === 'timeout') await expect(h.client.switchSession(target(2))).rejects.toThrow('请求超时')
    else await expect(h.client.switchSession(target(2))).resolves.toBe(false)
    expect(h.client.getSessionState()).toEqual(before)
    expect(h.client.getPersistableSession()).toEqual(target(1))
    expect(h.onSessionChange).toHaveBeenCalledTimes(1)
  })

  it.each(['logout', 'login'] as const)('does not commit a delayed switch after a newer %s intent', async (action) => {
    const h = harness()
    await h.login(1)
    const candidate = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/self' && userHeader(init) === '2' ? candidate.promise : undefined)
    const rejected = expect(h.client.switchSession(target(2))).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await vi.waitFor(() => expect(h.fetchImpl.mock.calls.some(([url, init]) => new URL(url).pathname === '/api/user/self' && userHeader(init!) === '2')).toBe(true))
    if (action === 'logout') h.client.logout()
    else await h.login(3)
    candidate.resolve(response(user(2)))
    await rejected
    expect(h.client.getSessionState().account?.userId ?? null).toBe(action === 'logout' ? null : 3)
  })

  it('does not resurrect a startup restore after a new login', async () => {
    const h = harness()
    const refresh = deferred<Response>()
    h.setHandler((pathname) => pathname === '/api/user/auth/refresh' ? refresh.promise : undefined)
    const rejected = expect(h.client.restoreSession(target(1))).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await h.login(2)
    refresh.resolve(refreshResponse(1))
    await rejected
    expect(h.client.getSessionState().account?.userId).toBe(2)
    expect(h.fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname === '/api/user/self')).toHaveLength(0)
  })

  it('does not commit an old login after logout or a newer login attempt', async () => {
    const h = harness()
    const login = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/login' && JSON.parse(String(init.body)).username === '1' ? login.promise : undefined)
    const rejected = expect(h.login(1)).rejects.toBeInstanceOf(NewApiSessionChangedError)
    h.client.logout()
    await h.login(2)
    login.resolve(loginResponse(1))
    await rejected
    expect(h.client.getSessionState().account?.userId).toBe(2)
  })

  it('rejects malformed cookies before making a request or changing the current owner', async () => {
    const h = harness()
    await h.login(1)
    const requests = h.fetchImpl.mock.calls.length
    await expect(h.client.switchSession({ userId: 2, cookies: ['value\r\nInjected: yes'] })).resolves.toBe(false)
    await expect(h.client.switchSession({ userId: 2, cookies: [] })).resolves.toBe(false)
    expect(h.fetchImpl).toHaveBeenCalledTimes(requests)
    expect(h.client.getSessionState().account?.userId).toBe(1)
  })
})

describe('session ownership of asynchronous responses', () => {
  it.each([true, false])('rejects a stale successful/401 response after switching without refreshing or clearing the new owner: success=%s', async (success) => {
    const h = harness()
    await h.login(1)
    const self = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/self' && userHeader(init) === '1' ? self.promise : undefined)
    const rejected = expect(h.client.getBalance()).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await h.client.switchSession(target(2))
    self.resolve(success ? response(user(1)) : response(null, { status: 401, success: false }))
    await rejected
    expect(h.client.getSessionState().account?.userId).toBe(2)
    expect(h.fetchImpl.mock.calls.filter(([url, init]) => new URL(url).pathname === '/api/user/auth/refresh' && (init?.headers as Record<string, string>).Cookie === 'refresh_token=cookie-1')).toHaveLength(0)
  })

  it.each([true, false])('old proactive refresh never replaces or clears a switched account: success=%s', async (success) => {
    const h = harness()
    await h.login(1)
    const refresh = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/auth/refresh' && (init.headers as Record<string, string>).Cookie === 'refresh_token=cookie-1' ? refresh.promise : undefined)
    const rejected = expect(h.client.refreshAccessToken()).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await h.client.switchSession(target(2))
    refresh.resolve(success ? refreshResponse(1) : response(null, { status: 401, success: false }))
    await rejected
    expect(h.client.getPersistableSession()).toEqual(target(2))
    expect(h.onSessionChange.mock.calls.map(([value]) => value?.userId)).toEqual([1, 2])
  })

  it.each([true, false])('old silent refresh never replaces or clears a switched account: success=%s', async (success) => {
    const h = harness()
    await h.login(1)
    const refresh = deferred<Response>()
    const started = deferred<void>()
    h.setHandler((pathname, init) => {
      if (pathname === '/api/user/self' && userHeader(init) === '1') return response(null, { status: 401, success: false })
      if (pathname === '/api/user/auth/refresh' && (init.headers as Record<string, string>).Cookie === 'refresh_token=cookie-1') { started.resolve(); return refresh.promise }
    })
    const rejected = expect(h.client.getBalance()).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await started.promise
    await h.client.switchSession(target(2))
    refresh.resolve(success ? refreshResponse(1) : response(null, { status: 401, success: false }))
    await rejected
    expect(h.client.getPersistableSession()).toEqual(target(2))
    expect(h.onSessionChange.mock.calls.map(([value]) => value?.userId)).toEqual([1, 2])
  })

  it('shares one refresh among parallel calls for the same session', async () => {
    const h = harness()
    await h.login(1)
    const refresh = deferred<Response>()
    h.setHandler((pathname) => pathname === '/api/user/auth/refresh' ? refresh.promise : undefined)
    const first = h.client.refreshAccessToken()
    const second = h.client.refreshAccessToken()
    expect(h.fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname === '/api/user/auth/refresh')).toHaveLength(1)
    refresh.resolve(refreshResponse(1))
    await Promise.all([first, second])
    expect(h.onSessionChange).toHaveBeenCalledTimes(2)
  })

  it('does not replace a newer password-change token with an older refresh response', async () => {
    const h = harness()
    await h.login(1)
    const refresh = deferred<Response>()
    h.setHandler((pathname, init) => {
      if (pathname === '/api/user/auth/refresh') return refresh.promise
      if (pathname === '/api/user/self' && init.method === 'PUT') return response({ access_token: 'new-password-token', access_expires_at: null })
    })
    const refreshing = h.client.refreshAccessToken()
    await h.client.changePassword({ originalPassword: 'old', newPassword: 'new' })
    refresh.resolve(refreshResponse(1))
    await refreshing
    await h.client.getBalance()
    const lastSelf = h.fetchImpl.mock.calls.filter(([url, init]) => new URL(url).pathname === '/api/user/self' && init?.method === 'GET').at(-1)
    expect((lastSelf?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer new-password-token')
  })

  it('does not commit a stale password rotation into the new account', async () => {
    const h = harness()
    await h.login(1)
    const changed = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/self' && init.method === 'PUT' ? changed.promise : undefined)
    const rejected = expect(h.client.changePassword({ originalPassword: 'old', newPassword: 'new' })).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await h.client.switchSession(target(2))
    changed.resolve(response({ access_token: 'old-owner-token', access_expires_at: null }))
    await rejected
    expect(h.client.getPersistableSession()).toEqual(target(2))
  })

  it('does not sign out the new owner when an old current-device revocation finishes', async () => {
    const h = harness()
    await h.login(1)
    const revoked = deferred<Response>()
    const sid = '123e4567-e89b-42d3-a456-426614174000'
    h.setHandler((pathname) => pathname === `/api/user/sessions/${sid}` ? revoked.promise : undefined)
    const rejected = expect(h.client.revokeLoginSession(sid)).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await h.client.switchSession(target(2))
    revoked.resolve(response({ revoked_sid: sid, current: true }))
    await rejected
    expect(h.client.getPersistableSession()).toEqual(target(2))
  })

  it('distinguishes a fresh login to the same account from its previous session owner', async () => {
    const h = harness()
    await h.login(1)
    const self = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/self' && userHeader(init) === '1' ? self.promise : undefined)
    const rejected = expect(h.client.getBalance()).rejects.toBeInstanceOf(NewApiSessionChangedError)
    h.client.logout()
    await h.login(1)
    self.resolve(response(user(1)))
    await rejected
    expect(h.client.getPersistableSession()).toEqual(target(1))
  })

  it('lets the newest switch intent win even when the first target finishes later', async () => {
    const h = harness()
    await h.login(1)
    const first = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/auth/refresh' && (init.headers as Record<string, string>).Cookie === 'refresh_token=cookie-2' ? first.promise : undefined)
    const rejected = expect(h.client.switchSession(target(2))).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await expect(h.client.switchSession(target(3))).resolves.toBe(true)
    first.resolve(refreshResponse(2))
    await rejected
    expect(h.client.getPersistableSession()).toEqual(target(3))
  })

  it('stops a multi-request operation before its next authenticated action after switching', async () => {
    const h = harness()
    await h.login(1)
    const listing = deferred<Response>()
    h.setHandler((pathname) => pathname === '/api/token/' ? listing.promise : undefined)
    const rejected = expect(h.client.findExistingCliKey('fixture-')).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await h.client.switchSession(target(2))
    listing.resolve(response([{ id: 1, name: 'fixture-key' }]))
    await rejected
    expect(h.fetchImpl.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/key'))).toBe(false)
  })
})

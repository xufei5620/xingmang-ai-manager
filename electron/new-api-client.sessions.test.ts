import { describe, expect, it, vi } from 'vitest'
import { createNewApiClient, createSessionRequestGate, NewApiSessionChangedError, type NewApiClientOptions, type NewApiFetch } from './new-api-client'

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
function harness(timeoutMs = 1000, options: Pick<NewApiClientOptions, 'onCredentialRotation'> = {}) {
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
    // rc.40: a password change first trades the current password for a one-time proof.
    if (pathname === '/api/verify') return response({ proof_token: 'fixture-proof', expires_at: 1_790_000_000, method: 'password', scope: 'account.password.change' })
    throw new Error(`Unexpected fixture request: ${pathname}`)
  })
  const onSessionChange = vi.fn()
  const onCredentialRotation = vi.fn(options.onCredentialRotation)
  const client = createNewApiClient({ baseUrl: 'https://accounts.test.internal', timeoutMs, fetchImpl, onSessionChange, onCredentialRotation })
  return { client, fetchImpl, onSessionChange, onCredentialRotation, setHandler: (next: Handler) => { handler = next }, login: (id: number) => client.login({ username: String(id), password: 'fixture-password' }) }
}
const target = (userId: number) => ({ userId, cookies: [`refresh_token=cookie-${userId}`] })
const userHeader = (init: RequestInit) => (init.headers as Record<string, string>)['New-Api-User']
function requestsTo(fetchImpl: ReturnType<typeof harness>['fetchImpl'], pathname: string, method?: string) {
  return fetchImpl.mock.calls.filter(([url, init]) => new URL(url).pathname === pathname && (method === undefined || (init?.method ?? 'GET') === method))
}
function authorization(call: Parameters<NewApiFetch> | undefined): string | undefined {
  return (call?.[1]?.headers as Record<string, string> | undefined)?.Authorization
}
// Several macrotask turns: long enough for a request the client is free to send to reach fetch.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('saved session switching', () => {
  it('persists candidate cookies before /self fails while retaining the active account', async () => {
    const h = harness()
    await h.login(1)
    const before = h.client.getSessionState()
    h.setHandler((pathname) => {
      if (pathname === '/api/user/auth/refresh') return response({ access_token: 'candidate-token' }, { cookies: ['refresh_token=cookie-2-rotated'] })
      if (pathname === '/api/user/self') return response(null, { status: 503, success: false })
    })
    await expect(h.client.switchSession(target(2))).rejects.toThrow()
    expect(h.onCredentialRotation).toHaveBeenCalledExactlyOnceWith({ userId: 2, cookies: ['refresh_token=cookie-2-rotated'] })
    expect(h.client.getSessionState()).toEqual(before)
    expect(h.client.getPersistableSession()).toEqual(target(1))
    expect(h.onSessionChange).toHaveBeenCalledTimes(1)
  })

  it('persists startup rotation without authenticating if the following profile request fails', async () => {
    const h = harness()
    h.setHandler((pathname) => {
      if (pathname === '/api/user/auth/refresh') return response({ access_token: 'candidate-token' }, { cookies: ['refresh_token=cookie-1-rotated'] })
      if (pathname === '/api/user/self') return response(null, { status: 503, success: false })
    })
    await expect(h.client.restoreSession(target(1))).rejects.toThrow()
    expect(h.onCredentialRotation).toHaveBeenCalledExactlyOnceWith({ userId: 1, cookies: ['refresh_token=cookie-1-rotated'] })
    expect(h.client.getSessionState().authenticated).toBe(false)
    expect(h.onSessionChange).not.toHaveBeenCalled()
  })

  it('awaits candidate cookie persistence before querying the restored profile', async () => {
    const saved = deferred<void>()
    const started = deferred<void>()
    const h = harness(1000, { onCredentialRotation: async () => { started.resolve(); await saved.promise } })
    const restoring = h.client.restoreSession(target(1))
    await started.promise
    expect(h.fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/api/user/self')).toBe(false)
    expect(h.client.getSessionState().authenticated).toBe(false)
    saved.resolve()
    await expect(restoring).resolves.toBe(true)
  })

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
  it('retains rotated cookies after a silent-refresh business retry fails', async () => {
    const h = harness()
    await h.login(1)
    let selfCalls = 0
    h.setHandler((pathname) => {
      if (pathname === '/api/user/auth/refresh') return response({ access_token: 'rotated-token' }, { cookies: ['refresh_token=cookie-1-rotated'] })
      if (pathname === '/api/user/self') return response(null, { status: ++selfCalls === 1 ? 401 : 503, success: false })
    })
    await expect(h.client.getBalance()).rejects.toThrow()
    expect(h.onCredentialRotation).toHaveBeenCalledExactlyOnceWith({ userId: 1, cookies: ['refresh_token=cookie-1-rotated'] })
    expect(h.client.getPersistableSession()).toEqual({ userId: 1, cookies: ['refresh_token=cookie-1-rotated'] })
    expect(h.client.getSessionState().authenticated).toBe(true)
  })

  it('keeps new cookies in memory on persistence failure without exposing callback secrets', async () => {
    const h = harness(1000, { onCredentialRotation: async () => { throw new Error('private-cookie-in-error') } })
    await h.login(1)
    h.setHandler((pathname) => {
      if (pathname === '/api/user/auth/refresh') return response({ access_token: 'rotated-token' }, { cookies: ['refresh_token=cookie-1-rotated'] })
      if (pathname === '/api/user/self') return response(null, { status: 401, success: false })
    })
    await expect(h.client.getBalance()).rejects.toThrow('安全存储保存失败')
    expect(h.client.getPersistableSession()).toEqual({ userId: 1, cookies: ['refresh_token=cookie-1-rotated'] })
    expect(h.client.getSessionState().authenticated).toBe(true)
    expect(h.onSessionChange.mock.calls.some(([value]) => value === null)).toBe(false)
  })

  it('never publishes stale rotation over a newer login to the same account', async () => {
    const h = harness()
    await h.login(1)
    const refresh = deferred<Response>()
    h.setHandler((pathname) => pathname === '/api/user/auth/refresh' ? refresh.promise : undefined)
    const rejected = expect(h.client.refreshAccessToken()).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await h.login(1)
    refresh.resolve(response({ access_token: 'old-rotation' }, { cookies: ['refresh_token=stale-rotated-cookie'] }))
    await rejected
    expect(h.onCredentialRotation).not.toHaveBeenCalled()
    expect(h.client.getPersistableSession()).toEqual(target(1))
  })

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

  // A refresh that is already on the wire finishes before the change starts
  // (createSessionRequestGate), so an older refresh answer can no longer land
  // on top of the token the change hands back.
  it('lets a refresh already on the wire finish before changing the password, and keeps the change token', async () => {
    const h = harness()
    await h.login(1)
    const refresh = deferred<Response>()
    h.setHandler((pathname, init) => {
      if (pathname === '/api/user/auth/refresh') return refresh.promise
      if (pathname === '/api/user/self' && init.method === 'PUT') return response({ access_token: 'new-password-token', access_expires_at: null })
    })
    const refreshing = h.client.refreshAccessToken()
    const changing = h.client.changePassword({ originalPassword: 'old', newPassword: 'new' })
    await settle()
    expect(requestsTo(h.fetchImpl, '/api/verify')).toHaveLength(0)
    refresh.resolve(refreshResponse(1))
    await refreshing
    await changing
    expect(authorization(requestsTo(h.fetchImpl, '/api/verify')[0])).toBe('Bearer refreshed-1')
    await h.client.getBalance()
    expect(authorization(requestsTo(h.fetchImpl, '/api/user/self', 'GET').at(-1))).toBe('Bearer new-password-token')
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
    h.setHandler((pathname) => {
      if (pathname === '/api/user/self/groups') return response({ fixture: { desc: 'fixture group' } })
      if (pathname === '/api/token/') return listing.promise
      return undefined
    })
    const rejected = expect(h.client.provisionCliKey({ group: 'fixture' })).rejects.toBeInstanceOf(NewApiSessionChangedError)
    await h.client.switchSession(target(2))
    listing.resolve(response([{ id: 1, name: 'fixture-key', group: 'fixture', status: 1, unlimited_quota: true, expired_time: -1 }]))
    await rejected
    expect(h.fetchImpl.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/key'))).toBe(false)
  })
})

// 2026-10-27：找回密码第 3 步刚用临时密码登上就改密码，界面同时在读余额。服务端改完密码、
// 给账号发完提醒邮件之后才把这台电脑的登录升到新版本；中间到的请求被拒，续期时整个登录被作废。
describe('password change runs alone on the login', () => {
  it('waits for an account read already on the wire before proving the password', async () => {
    const h = harness()
    await h.login(1)
    const self = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/self' && init.method !== 'PUT' ? self.promise : undefined)
    const balance = h.client.getBalance()
    await vi.waitFor(() => expect(requestsTo(h.fetchImpl, '/api/user/self', 'GET')).toHaveLength(1))
    const changing = h.client.changePassword({ originalPassword: 'old', newPassword: 'new' })
    await settle()
    expect(requestsTo(h.fetchImpl, '/api/verify')).toHaveLength(0)
    self.resolve(response(user(1)))
    await balance
    await expect(changing).resolves.toEqual({ changed: true })
    const order = h.fetchImpl.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${new URL(url).pathname}`).filter((entry) => !entry.endsWith('/api/status'))
    expect(order).toEqual(['POST /api/user/login', 'GET /api/user/self', 'POST /api/verify', 'PUT /api/user/self'])
  })

  it('holds account reads that start during the change until it is answered, then sends them with the token it handed back', async () => {
    const h = harness()
    await h.login(1)
    const changed = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/self' && init.method === 'PUT' ? changed.promise : undefined)
    const changing = h.client.changePassword({ originalPassword: 'old', newPassword: 'new' })
    await vi.waitFor(() => expect(requestsTo(h.fetchImpl, '/api/user/self', 'PUT')).toHaveLength(1))
    const balance = h.client.getBalance()
    const profile = h.client.getProfile()
    await settle()
    expect(requestsTo(h.fetchImpl, '/api/user/self', 'GET')).toHaveLength(0)
    changed.resolve(response({ access_token: 'new-password-token', access_expires_at: null }))
    await changing
    await balance
    await profile
    const reads = requestsTo(h.fetchImpl, '/api/user/self', 'GET')
    expect(reads).toHaveLength(2)
    expect(reads.map(authorization)).toEqual(['Bearer new-password-token', 'Bearer new-password-token'])
    expect(requestsTo(h.fetchImpl, '/api/user/auth/refresh')).toHaveLength(0)
    expect(h.client.getSessionState().authenticated).toBe(true)
  })

  it('lets the held reads through once a failed change is answered', async () => {
    const h = harness()
    await h.login(1)
    const changed = deferred<Response>()
    h.setHandler((pathname, init) => pathname === '/api/user/self' && init.method === 'PUT' ? changed.promise : undefined)
    const changing = h.client.changePassword({ originalPassword: 'old', newPassword: 'new' })
    await vi.waitFor(() => expect(requestsTo(h.fetchImpl, '/api/user/self', 'PUT')).toHaveLength(1))
    const balance = h.client.getBalance()
    changed.resolve(response(null, { success: false, message: '服务器开小差了' }))
    await expect(changing).rejects.toThrow()
    await expect(balance).resolves.toMatchObject({ quota: 100 })
    expect(authorization(requestsTo(h.fetchImpl, '/api/user/self', 'GET')[0])).toBe('Bearer access-1')
  })
})

describe('createSessionRequestGate', () => {
  it('runs shared work side by side', async () => {
    const gate = createSessionRequestGate()
    const first = deferred<string>()
    const second = deferred<string>()
    const started: string[] = []
    const a = gate.shared(() => { started.push('a'); return first.promise })
    const b = gate.shared(() => { started.push('b'); return second.promise })
    await settle()
    expect(started).toEqual(['a', 'b'])
    first.resolve('a'); second.resolve('b')
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b'])
  })

  it('starts exclusive work only after the shared work already running has settled', async () => {
    const gate = createSessionRequestGate()
    const running = deferred<void>()
    const events: string[] = []
    const shared = gate.shared(async () => { await running.promise; events.push('shared done') })
    const exclusive = gate.exclusive(async () => { events.push('exclusive') })
    await settle()
    expect(events).toEqual([])
    running.resolve()
    await Promise.all([shared, exclusive])
    expect(events).toEqual(['shared done', 'exclusive'])
  })

  it('holds shared work that arrives while exclusive work is waiting or running', async () => {
    const gate = createSessionRequestGate()
    const running = deferred<void>()
    const holding = deferred<void>()
    const events: string[] = []
    const first = gate.shared(async () => { await running.promise; events.push('first shared') })
    const exclusive = gate.exclusive(async () => { events.push('exclusive start'); await holding.promise; events.push('exclusive end') })
    const waitingBehind = gate.shared(async () => { events.push('queued while draining') })
    running.resolve()
    await vi.waitFor(() => expect(events).toContain('exclusive start'))
    const lateArrival = gate.shared(async () => { events.push('queued while running') })
    await settle()
    expect(events).toEqual(['first shared', 'exclusive start'])
    holding.resolve()
    await Promise.all([first, exclusive, waitingBehind, lateArrival])
    expect(events.slice(0, 3)).toEqual(['first shared', 'exclusive start', 'exclusive end'])
    expect(events.slice(3).sort()).toEqual(['queued while draining', 'queued while running'])
  })

  it('runs two exclusive pieces one after the other', async () => {
    const gate = createSessionRequestGate()
    const holding = deferred<void>()
    const events: string[] = []
    const first = gate.exclusive(async () => { events.push('first start'); await holding.promise; events.push('first end') })
    const second = gate.exclusive(async () => { events.push('second') })
    await settle()
    expect(events).toEqual(['first start'])
    holding.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first start', 'first end', 'second'])
  })

  it('opens again after exclusive work fails', async () => {
    const gate = createSessionRequestGate()
    await expect(gate.exclusive(async () => { throw new Error('change failed') })).rejects.toThrow('change failed')
    await expect(gate.shared(async () => 'read')).resolves.toBe('read')
  })
})

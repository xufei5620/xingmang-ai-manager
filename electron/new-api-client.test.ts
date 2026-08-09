import { describe, expect, it, vi } from 'vitest'
import {
  buildCliKeyName,
  computeBalanceDisplay,
  createNewApiClient,
  extractSessionCookies,
  findCliKeyIdByName,
  NewApiAuthenticationError,
  parseAccountProfile,
  parseAccountStatus,
  parseCliKeySecret,
  parseLoginResponseData,
  parseRefreshResponseData,
  type NewApiFetch,
} from './new-api-client'

const testBaseUrl = 'https://xm.test.internal'

function jsonResponse(body: unknown, init: ResponseInit = {}, setCookies: string[] = []): Response {
  const headers = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> ?? {}) }
  const response = new Response(JSON.stringify(body), { status: 200, ...init, headers })
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
  return response
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url })
  return response
}

const statusData = {
  system_name: '星芒AI',
  version: 'v1.0.0-rc.22-solov1',
  setup: true,
  quota_per_unit: 500_000,
  quota_display_type: 'USD',
  usd_exchange_rate: 7.3,
  register_enabled: true,
  password_register_enabled: true,
  email_verification: true,
  turnstile_check: false,
}

function statusResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({ success: true, message: '', data: { ...statusData, ...overrides } })
}

function userData(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    username: 'tester',
    group: 'default',
    role: 1,
    quota: 1_000_000,
    used_quota: 250_000,
    ...overrides,
  }
}

function loginResponse(
  overrides: Record<string, unknown> = {},
  setCookies: string[] = ['refresh_token=cookie-value-1; Path=/; HttpOnly'],
): Response {
  return jsonResponse({
    success: true,
    message: '',
    data: {
      access_token: 'test-access-token-abc',
      access_expires_at: '2026-08-10T00:00:00.000Z',
      user: userData(overrides),
    },
  }, {}, setCookies)
}

function failureResponse(message: string, status = 200): Response {
  return jsonResponse({ success: false, message, data: null }, { status })
}

// Logs a fresh client in against a throwaway mock and hands back both, so
// balance/CLI-key tests can start from an authenticated session without
// repeating the login boilerplate.
async function authenticatedClient(fetchImpl: ReturnType<typeof vi.fn<NewApiFetch>>) {
  fetchImpl.mockResolvedValueOnce(loginResponse())
  const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
  await client.login({ username: 'tester', password: 'correct horse battery staple' })
  fetchImpl.mockClear()
  return client
}

describe('parseAccountStatus', () => {
  it('reads the switches, version and quota_per_unit needed for onboarding decisions', () => {
    expect(parseAccountStatus({ ...statusData })).toEqual({
      systemName: '星芒AI',
      version: 'v1.0.0-rc.22-solov1',
      setupComplete: true,
      quotaPerUnit: 500_000,
      quotaDisplayType: 'USD',
      usdExchangeRate: 7.3,
      registerEnabled: true,
      passwordRegisterEnabled: true,
      emailVerificationEnabled: true,
      turnstileCheckEnabled: false,
    })
  })

  it('never invents a quota_per_unit when the field is missing', () => {
    const { quotaPerUnit } = parseAccountStatus({})
    expect(quotaPerUnit).toBe(0)
  })

  it('rejects a non-object payload', () => {
    expect(() => parseAccountStatus('nope')).toThrow('响应格式异常')
    expect(() => parseAccountStatus(null)).toThrow('响应格式异常')
  })
})

describe('parseAccountProfile', () => {
  it('extracts the fields required to build auth headers plus optional enrichment', () => {
    expect(parseAccountProfile(userData())).toEqual({
      userId: 42,
      username: 'tester',
      group: 'default',
      role: 1,
      quota: 1_000_000,
      usedQuota: 250_000,
    })
  })

  it('defaults optional fields to null without failing the whole parse', () => {
    expect(parseAccountProfile({ id: 7, username: 'bare' })).toEqual({
      userId: 7,
      username: 'bare',
      group: null,
      role: null,
      quota: null,
      usedQuota: null,
    })
  })

  it('requires a positive integer id and non-empty username', () => {
    expect(() => parseAccountProfile({ id: 0, username: 'x' })).toThrow('账号信息响应格式异常')
    expect(() => parseAccountProfile({ id: 1, username: '' })).toThrow('账号信息响应格式异常')
    expect(() => parseAccountProfile(null)).toThrow('账号信息响应格式异常')
  })
})

describe('parseLoginResponseData / parseRefreshResponseData', () => {
  it('parses a full login payload', () => {
    const data = parseLoginResponseData({
      access_token: 'abc',
      access_expires_at: '2026-08-10T00:00:00.000Z',
      user: userData(),
    })
    expect(data.accessToken).toBe('abc')
    expect(data.accessExpiresAt).toBe('2026-08-10T00:00:00.000Z')
    expect(data.account.userId).toBe(42)
  })

  it('normalizes a numeric epoch-seconds expiry into an ISO string', () => {
    const data = parseLoginResponseData({ access_token: 'abc', access_expires_at: 0, user: userData() })
    expect(data.accessExpiresAt).toBe(new Date(0).toISOString())
  })

  it('requires access_token', () => {
    expect(() => parseLoginResponseData({ user: userData() })).toThrow('缺少访问令牌')
  })

  it('rejects a login payload with no user object', () => {
    expect(() => parseLoginResponseData({ access_token: 'abc' })).toThrow('账号信息响应格式异常')
  })

  it('parses a refresh payload without requiring a user object', () => {
    const data = parseRefreshResponseData({ access_token: 'new-token', access_expires_at: '2026-08-11T00:00:00.000Z' })
    expect(data).toEqual({ accessToken: 'new-token', accessExpiresAt: '2026-08-11T00:00:00.000Z' })
  })

  it('requires access_token on refresh too', () => {
    expect(() => parseRefreshResponseData({})).toThrow('缺少访问令牌')
  })
})

describe('extractSessionCookies', () => {
  it('strips cookie attributes down to bare name=value pairs', () => {
    const headers = new Headers()
    headers.append('set-cookie', 'refresh_token=abc123; Path=/; HttpOnly; SameSite=Lax')
    headers.append('set-cookie', 'other=xyz; Path=/')
    expect(extractSessionCookies(headers)).toEqual(['refresh_token=abc123', 'other=xyz'])
  })

  it('returns an empty array when no cookies were set', () => {
    expect(extractSessionCookies(new Headers())).toEqual([])
  })

  it('drops malformed entries without a name=value pair', () => {
    const headers = new Headers()
    headers.append('set-cookie', 'malformed-without-equals')
    expect(extractSessionCookies(headers)).toEqual([])
  })
})

describe('computeBalanceDisplay', () => {
  it('divides quota by quota_per_unit', () => {
    expect(computeBalanceDisplay(1_000_000, 500_000)).toBe(2)
  })

  it('refuses to divide by a zero or invalid conversion rate', () => {
    expect(() => computeBalanceDisplay(100, 0)).toThrow('无法获取余额换算比例')
    expect(() => computeBalanceDisplay(100, Number.NaN)).toThrow('无法获取余额换算比例')
    expect(() => computeBalanceDisplay(100, -1)).toThrow('无法获取余额换算比例')
  })
})

describe('buildCliKeyName', () => {
  it('produces a unique, bounded-length name with the expected shape', () => {
    const name = buildCliKeyName()
    expect(name).toMatch(/^xingmang-desktop-[0-9a-z]+-[0-9a-f]{12}$/)
    expect(name.length).toBeLessThanOrEqual(128)
    expect(buildCliKeyName()).not.toBe(buildCliKeyName())
  })

  it('accepts a custom prefix', () => {
    expect(buildCliKeyName('custom')).toMatch(/^custom-/)
  })
})

describe('findCliKeyIdByName / parseCliKeySecret', () => {
  it('finds a matching id from a bare array', () => {
    expect(findCliKeyIdByName([{ id: 1, name: 'a' }, { id: 2, name: 'target' }], 'target')).toBe(2)
  })

  it('finds a matching id nested under common wrapper keys', () => {
    expect(findCliKeyIdByName({ items: [{ id: 5, name: 'target' }] }, 'target')).toBe(5)
    expect(findCliKeyIdByName({ data: [{ id: 6, name: 'target' }] }, 'target')).toBe(6)
  })

  it('returns null when nothing matches', () => {
    expect(findCliKeyIdByName([{ id: 1, name: 'other' }], 'target')).toBeNull()
    expect(findCliKeyIdByName('not a collection', 'target')).toBeNull()
  })

  it('extracts the plaintext key from a data.key field or a bare string', () => {
    expect(parseCliKeySecret({ key: 'sk-plain-text' })).toBe('sk-plain-text')
    expect(parseCliKeySecret('sk-plain-text')).toBe('sk-plain-text')
  })

  it('returns null when no usable key is present', () => {
    expect(parseCliKeySecret({})).toBeNull()
    expect(parseCliKeySecret({ key: '' })).toBeNull()
    expect(parseCliKeySecret(null)).toBeNull()
  })
})

describe('createNewApiClient construction', () => {
  it('defaults to the xm.solov.cc origin when no baseUrl is given', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(statusResponse())
    const client = createNewApiClient({ fetchImpl })
    await client.getStatus()
    expect(new URL(String(fetchImpl.mock.calls[0][0])).origin).toBe('https://xm.solov.cc')
  })

  it('rejects a non-https base URL', () => {
    expect(() => createNewApiClient({ baseUrl: 'http://xm.solov.cc' })).toThrow('https')
  })

  it('rejects a base URL carrying embedded credentials', () => {
    expect(() => createNewApiClient({ baseUrl: 'https://user:pass@xm.solov.cc' })).toThrow('不含凭据')
  })

  it('rejects a malformed base URL', () => {
    expect(() => createNewApiClient({ baseUrl: 'not a url' })).toThrow('格式无效')
  })

  it('rejects an out-of-range timeout', () => {
    expect(() => createNewApiClient({ timeoutMs: 0 })).toThrow(TypeError)
    expect(() => createNewApiClient({ timeoutMs: 200_000 })).toThrow(TypeError)
  })

  it('rejects an invalid response size cap', () => {
    expect(() => createNewApiClient({ maxResponseBytes: 0 })).toThrow(TypeError)
    expect(() => createNewApiClient({ maxResponseBytes: -1 })).toThrow(TypeError)
  })
})

describe('getStatus', () => {
  it('fetches and parses GET /api/status without authentication', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(statusResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.getStatus()).resolves.toMatchObject({ version: 'v1.0.0-rc.22-solov1', quotaPerUnit: 500_000 })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/status`)
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('surfaces a clear error when the envelope reports failure', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse('维护中', 503))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.getStatus()).rejects.toThrow('维护中')
  })
})

describe('login', () => {
  it('captures the access token and refresh cookie internally without leaking them in the result', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(loginResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    const result = await client.login({ username: 'tester', password: 'correct horse battery staple' })

    expect(result).toEqual({
      account: {
        userId: 42,
        username: 'tester',
        group: 'default',
        role: 1,
        quota: 1_000_000,
        usedQuota: 250_000,
      },
      accessExpiresAt: '2026-08-10T00:00:00.000Z',
    })
    expect(Object.keys(result)).not.toContain('accessToken')
    expect(JSON.stringify(result)).not.toContain('test-access-token-abc')
    expect(client.isAuthenticated()).toBe(true)
    expect(client.getSessionState()).toEqual({ authenticated: true, account: result.account })

    const [, init] = fetchImpl.mock.calls[0]
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ username: 'tester', password: 'correct horse battery staple' })
  })

  it('rejects empty credentials before making a network call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.login({ username: '  ', password: '' })).rejects.toThrow('请输入用户名和密码')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a clean failure message on invalid credentials without exposing the password', async () => {
    const password = 'hunter2-secret'
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse(`invalid login for password ${password}`))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    let message = ''
    try {
      await client.login({ username: 'tester', password })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(password)
    expect(client.isAuthenticated()).toBe(false)
  })

  it('rejects a response with no access_token', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(
      jsonResponse({ success: true, message: '', data: { user: userData() } }),
    )
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.login({ username: 'tester', password: 'x' })).rejects.toThrow('缺少访问令牌')
  })

  it('optionally forwards a Turnstile token', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(loginResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await client.login({ username: 'tester', password: 'x', turnstileToken: 'ts-token' })
    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({ turnstile: 'ts-token' })
  })
})

describe('logout / session guards', () => {
  it('requires login before balance or CLI-key operations', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.getBalance()).rejects.toThrow('请先登录星芒账号')
    await expect(client.provisionCliKey()).rejects.toThrow('请先登录星芒账号')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('clears the session in memory and reports unauthenticated afterwards', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    expect(client.isAuthenticated()).toBe(true)

    client.logout()

    expect(client.isAuthenticated()).toBe(false)
    expect(client.getSessionState()).toEqual({ authenticated: false, account: null })
    await expect(client.getBalance()).rejects.toThrow('请先登录星芒账号')
  })
})

describe('getBalance', () => {
  it('converts quota using the live quota_per_unit from /api/status, not a remembered value', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)

    fetchImpl
      .mockResolvedValueOnce(statusResponse({ quota_per_unit: 250_000 }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userData({ quota: 1_000_000, used_quota: 500_000 }) }))

    const balance = await client.getBalance()

    expect(balance).toEqual({
      quota: 1_000_000,
      usedQuota: 500_000,
      quotaPerUnit: 250_000,
      quotaDisplayType: 'USD',
      usdExchangeRate: 7.3,
      displayAmount: 4,
    })
  })

  it('sends both Authorization and New-Api-User together on the authenticated call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userData() }))

    await client.getBalance()

    const selfCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('/api/user/self'))
    expect(selfCall).toBeDefined()
    const headers = selfCall?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-access-token-abc')
    expect(headers['New-Api-User']).toBe('42')
  })

  it('clears the session and throws a typed error on a 401 response', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(failureResponse('AuthVersion 已变化', 401))

    await expect(client.getBalance()).rejects.toBeInstanceOf(NewApiAuthenticationError)
    expect(client.isAuthenticated()).toBe(false)
    await expect(client.getBalance()).rejects.toThrow('请先登录星芒账号')
  })

  it('fails clearly when the account has no numeric quota', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: { id: 42, username: 'tester' } }))

    await expect(client.getBalance()).rejects.toThrow('服务未返回余额')
  })
})

describe('provisionCliKey (create -> list -> reveal three-call flow)', () => {
  it('creates, looks up by name, and reveals the plaintext key in order', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)

    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: true }))
      .mockImplementationOnce(async () => {
        const createdName = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).name as string
        return jsonResponse({ success: true, message: '', data: [{ id: 99, name: createdName }] })
      })
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: { key: 'sk-plaintext-value' } }))

    const result = await client.provisionCliKey()

    expect(result.id).toBe(99)
    expect(result.key).toBe('sk-plaintext-value')
    expect(result.name).toMatch(/^xingmang-desktop-/)

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const [createUrl, createInit] = fetchImpl.mock.calls[0]
    expect(String(createUrl)).toBe(`${testBaseUrl}/api/token/`)
    expect(createInit?.method).toBe('POST')
    const [listUrl, listInit] = fetchImpl.mock.calls[1]
    expect(String(listUrl)).toBe(`${testBaseUrl}/api/token/`)
    expect(listInit?.method).toBe('GET')
    const [keyUrl, keyInit] = fetchImpl.mock.calls[2]
    expect(String(keyUrl)).toBe(`${testBaseUrl}/api/token/99/key`)
    expect(keyInit?.method).toBe('POST')

    for (const [, init] of fetchImpl.mock.calls) {
      const headers = init?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-access-token-abc')
      expect(headers['New-Api-User']).toBe('42')
    }
  })

  it('honors explicit name/quota overrides in the create request body', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: [{ id: 1, name: 'my-custom-name' }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: { key: 'sk-x' } }))

    await client.provisionCliKey({ name: 'my-custom-name', unlimitedQuota: false, remainQuota: 12_345, expiredTime: 999 })

    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ name: 'my-custom-name', remain_quota: 12_345, unlimited_quota: false, expired_time: 999 })
  })

  it('fails the whole flow if the create call is rejected', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('已达到 Key 数量上限'))

    await expect(client.provisionCliKey()).rejects.toThrow('已达到 Key 数量上限')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('asks the caller to retry if the freshly created token cannot be found by name', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: [{ id: 1, name: 'someone-elses-key' }] }))

    await expect(client.provisionCliKey()).rejects.toThrow('未能定位新记录')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails clearly if the reveal-key step returns no usable key', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: true }))
      .mockImplementationOnce(async () => {
        const createdName = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).name as string
        return jsonResponse({ success: true, message: '', data: [{ id: 7, name: createdName }] })
      })
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: {} }))

    await expect(client.provisionCliKey()).rejects.toThrow('明文读取失败')
  })
})

describe('refreshAccessToken', () => {
  it('replays the captured Set-Cookie value and rotates the access token', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: { access_token: 'rotated-token', access_expires_at: '2026-08-12T00:00:00.000Z' },
    }))

    await client.refreshAccessToken()

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/user/auth/refresh`)
    expect((init?.headers as Record<string, string>).Cookie).toBe('refresh_token=cookie-value-1')

    fetchImpl.mockResolvedValueOnce(statusResponse())
    fetchImpl.mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userData() }))
    await client.getBalance()
    // calls[0] is the refresh above; getBalance then fires status (calls[1])
    // and self (calls[2]) in parallel, in that construction order.
    const selfHeaders = fetchImpl.mock.calls[2][1]?.headers as Record<string, string>
    expect(selfHeaders.Authorization).toBe('Bearer rotated-token')
  })

  it('refuses to refresh when no cookie was ever captured', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    fetchImpl.mockResolvedValueOnce(loginResponse({}, []))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await client.login({ username: 'tester', password: 'x' })
    fetchImpl.mockClear()

    await expect(client.refreshAccessToken()).rejects.toThrow('没有可用的登录凭据')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('network hardening (I10)', () => {
  it('enforces the request timeout with a bounded AbortSignal', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockImplementation((_url, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    ))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl, timeoutMs: 5 })
    await expect(client.getStatus()).rejects.toThrow('请求超时')
  })

  it('rejects a response whose declared Content-Length exceeds the cap', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(
      jsonResponse({ success: true, message: '', data: {} }, { headers: { 'Content-Length': '99999999' } }),
    )
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl, maxResponseBytes: 1024 })
    await expect(client.getStatus()).rejects.toThrow('安全上限')
  })

  it('rejects a response that streams past the cap even without a declared length', async () => {
    const oversized = JSON.stringify({ success: true, message: '', data: { blob: 'x'.repeat(2048) } })
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(new Response(oversized, { status: 200 }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl, maxResponseBytes: 256 })
    await expect(client.getStatus()).rejects.toThrow('安全上限')
  })

  it('rejects a redirect response instead of following it', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://attacker.example/api/status' } }),
    )
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.getStatus()).rejects.toThrow('重定向')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects a response reporting a final URL outside the configured origin', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(
      withUrl(statusResponse(), 'https://attacker.example/api/status'),
    )
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.getStatus()).rejects.toThrow('不受信任的地址')
  })

  it('accepts a response whose final URL matches the configured origin', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(withUrl(statusResponse(), `${testBaseUrl}/api/status`))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.getStatus()).resolves.toMatchObject({ version: 'v1.0.0-rc.22-solov1' })
  })
})

describe('redaction (I13)', () => {
  it('never lets an echoed access token surface in a CLI-key failure message', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('token Bearer test-access-token-abc rejected by upstream'))

    let message = ''
    try {
      await client.provisionCliKey()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain('test-access-token-abc')
  })

  it('strips control characters and caps the length of upstream error text', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(
      failureResponse(`broken\nmessage\twith control chars ${'x'.repeat(500)}`),
    )
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    let message = ''
    try {
      await client.getStatus()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain('\n')
    expect(message).not.toContain('\t')
    expect(message.length).toBeLessThanOrEqual(300)
  })
})

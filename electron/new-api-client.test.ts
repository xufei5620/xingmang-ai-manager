import { describe, expect, it, vi } from 'vitest'
import {
  buildCliKeyName,
  computeBalanceDisplay,
  createNewApiClient,
  extractSessionCookies,
  findCliKeyIdByName,
  findNewestCliKeyIdByNamePrefix,
  NewApiAuthenticationError,
  parseAccountKey,
  parseAccountKeysPage,
  parseAccountProfile,
  parseAccountProfileDetail,
  parseAccountStatus,
  parseAccountUsagePage,
  parseAccountUsageRecord,
  parseChangePasswordResponseData,
  parseCliKeySecret,
  parseLoginResponseData,
  parseRefreshResponseData,
  parseResetPasswordResponseData,
  type NewApiFetch,
} from './new-api-client'

function registerAckResponse(): Response {
  // RECON never confirmed a response shape for /api/user/register beyond the
  // shared {success, message, data} envelope, so the fixture keeps `data`
  // minimal on purpose -- see the comment on register() in new-api-client.ts.
  return jsonResponse({ success: true, message: '', data: null })
}

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

// buildSelfUserData's (controller/user.go) full field set -- what GET
// /api/user/self actually returns, confirmed identical at the v1.0.0-rc.22
// and v1.0.0-rc.24 tags. userData() above only models the narrower subset
// parseAccountProfile (used by login/session/balance) reads.
function userDetailData(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    username: 'tester',
    display_name: 'Tester Display',
    role: 1,
    status: 1,
    email: 'tester@example.com',
    group: 'default',
    quota: 1_000_000,
    used_quota: 250_000,
    request_count: 12,
    aff_code: 'ABC123',
    aff_count: 3,
    aff_quota: 0,
    aff_history_quota: 0,
    inviter_id: 0,
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

describe('parseAccountProfileDetail', () => {
  it('extracts the wider field set the 个人中心 profile/邀请 tabs need', () => {
    expect(parseAccountProfileDetail(userDetailData())).toEqual({
      userId: 42,
      username: 'tester',
      displayName: 'Tester Display',
      email: 'tester@example.com',
      group: 'default',
      quota: 1_000_000,
      usedQuota: 250_000,
      requestCount: 12,
      affCode: 'ABC123',
      affCount: 3,
    })
  })

  it('never leaks a plaintext apiKey/access_token field even if present on the payload (I3)', () => {
    const withSecrets = { ...userDetailData(), access_token: 'sk-should-never-appear', apiKey: 'sk-also-never' }
    const parsed = parseAccountProfileDetail(withSecrets) as unknown as Record<string, unknown>
    expect(parsed.access_token).toBeUndefined()
    expect(parsed.apiKey).toBeUndefined()
    expect(Object.values(parsed)).not.toContain('sk-should-never-appear')
    expect(Object.values(parsed)).not.toContain('sk-also-never')
  })

  it('defaults optional fields to null/0 without failing the whole parse', () => {
    expect(parseAccountProfileDetail({ id: 7, username: 'bare' })).toEqual({
      userId: 7,
      username: 'bare',
      displayName: null,
      email: null,
      group: null,
      quota: 0,
      usedQuota: 0,
      requestCount: 0,
      affCode: null,
      affCount: 0,
    })
  })

  it('requires a positive integer id and non-empty username', () => {
    expect(() => parseAccountProfileDetail({ id: 0, username: 'x' })).toThrow('账号资料响应格式异常')
    expect(() => parseAccountProfileDetail({ id: 1, username: '' })).toThrow('账号资料响应格式异常')
    expect(() => parseAccountProfileDetail(null)).toThrow('账号资料响应格式异常')
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

describe('parseResetPasswordResponseData', () => {
  it('wraps the bare password string the success envelope carries as `data`', () => {
    expect(parseResetPasswordResponseData('freshly-generated-1')).toEqual({ newPassword: 'freshly-generated-1' })
  })

  it('rejects a non-string payload', () => {
    expect(() => parseResetPasswordResponseData(null)).toThrow('未返回新密码')
    expect(() => parseResetPasswordResponseData({ key: 'not-this-shape' })).toThrow('未返回新密码')
    expect(() => parseResetPasswordResponseData(undefined)).toThrow('未返回新密码')
  })

  it('rejects an empty or whitespace-only string', () => {
    expect(() => parseResetPasswordResponseData('')).toThrow('未返回新密码')
    expect(() => parseResetPasswordResponseData('   ')).toThrow('未返回新密码')
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

describe('parseAccountUsageRecord', () => {
  const rawLog = {
    id: 501,
    user_id: 42,
    created_at: 1_754_784_000, // 2025-08-10T00:00:00Z, arbitrary fixed epoch-seconds fixture
    type: 2,
    content: 'internal detail, not surfaced',
    username: 'tester',
    token_name: 'xingmang-desktop-abc',
    model_name: 'claude-3-5-sonnet',
    quota: 12_345,
    prompt_tokens: 1_000,
    completion_tokens: 200,
    use_time: 3,
    is_stream: true,
    channel: 7,
    channel_name: 'internal-channel',
    token_id: 99,
    group: 'default',
    ip: '203.0.113.1',
    other: '{}',
  }

  it('converts the wire\'s Unix-seconds created_at into an ISO string and picks the customer-facing fields', () => {
    expect(parseAccountUsageRecord(rawLog)).toEqual({
      id: 501,
      createdAt: new Date(1_754_784_000 * 1000).toISOString(),
      type: 2,
      modelName: 'claude-3-5-sonnet',
      promptTokens: 1_000,
      completionTokens: 200,
      quota: 12_345,
      isStream: true,
    })
  })

  it('drops relay-internal fields (channel/token/ip/content/other) rather than forwarding them', () => {
    const parsed = parseAccountUsageRecord(rawLog) as unknown as Record<string, unknown>
    for (const internalKey of ['channel', 'channel_name', 'token_id', 'token_name', 'ip', 'content', 'other', 'group']) {
      expect(parsed[internalKey]).toBeUndefined()
    }
  })

  it('returns null for a malformed entry instead of throwing, so one bad row degrades gracefully', () => {
    expect(parseAccountUsageRecord({ id: 0 })).toBeNull()
    expect(parseAccountUsageRecord({})).toBeNull()
    expect(parseAccountUsageRecord('not a record')).toBeNull()
    expect(parseAccountUsageRecord(null)).toBeNull()
  })

  it('falls back to an empty createdAt when created_at is missing or not a number', () => {
    expect(parseAccountUsageRecord({ id: 1 })?.createdAt).toBe('')
    expect(parseAccountUsageRecord({ id: 1, created_at: 'not-a-number' })?.createdAt).toBe('')
  })
})

describe('parseAccountUsagePage', () => {
  it('reads page/page_size/total from the PageInfo envelope and parses each item', () => {
    const page = parseAccountUsagePage({
      page: 2,
      page_size: 8,
      total: 17,
      items: [
        { id: 1, created_at: 1_754_784_000, type: 2, model_name: 'a', prompt_tokens: 1, completion_tokens: 2, quota: 3, is_stream: false },
        { id: 2, created_at: 1_754_784_100, type: 6, model_name: 'b', prompt_tokens: 4, completion_tokens: 5, quota: 6, is_stream: true },
      ],
    })
    expect(page.page).toBe(2)
    expect(page.pageSize).toBe(8)
    expect(page.total).toBe(17)
    expect(page.records).toHaveLength(2)
    expect(page.records[0].id).toBe(1)
    expect(page.records[1].id).toBe(2)
  })

  it('silently skips malformed rows instead of failing the whole page', () => {
    const page = parseAccountUsagePage({
      page: 1,
      page_size: 10,
      total: 2,
      items: [{ id: 1, model_name: 'ok' }, { id: 0 }, 'not-a-record', null],
    })
    expect(page.records).toHaveLength(1)
    expect(page.records[0].id).toBe(1)
  })

  it('defaults to page 1 / page size 10 / total 0 / empty records for a malformed envelope', () => {
    expect(parseAccountUsagePage(null)).toEqual({ page: 1, pageSize: 10, total: 0, records: [] })
    expect(parseAccountUsagePage({})).toEqual({ page: 1, pageSize: 10, total: 0, records: [] })
    expect(parseAccountUsagePage({ items: 'not-an-array' })).toEqual({ page: 1, pageSize: 10, total: 0, records: [] })
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

describe('findNewestCliKeyIdByNamePrefix', () => {
  it('returns null when nothing matches the prefix', () => {
    expect(findNewestCliKeyIdByNamePrefix([{ id: 1, name: 'xingmang-desktop-abc' }], 'xingmang-canvas-')).toBeNull()
    expect(findNewestCliKeyIdByNamePrefix('not a collection', 'xingmang-canvas-')).toBeNull()
  })

  it('matches a single prefixed entry', () => {
    expect(findNewestCliKeyIdByNamePrefix(
      [{ id: 7, name: 'xingmang-canvas-abc123' }],
      'xingmang-canvas-',
    )).toEqual({ id: 7, name: 'xingmang-canvas-abc123' })
  })

  it('picks the highest id (most recently created) when several match', () => {
    expect(findNewestCliKeyIdByNamePrefix(
      [
        { id: 3, name: 'xingmang-canvas-old' },
        { id: 9, name: 'xingmang-canvas-newest' },
        { id: 5, name: 'xingmang-canvas-middle' },
      ],
      'xingmang-canvas-',
    )).toEqual({ id: 9, name: 'xingmang-canvas-newest' })
  })

  it('does not match a name that merely contains the prefix elsewhere, or an unrelated prefix', () => {
    expect(findNewestCliKeyIdByNamePrefix(
      [{ id: 1, name: 'my-xingmang-canvas-abc' }, { id: 2, name: 'xingmang-desktop-abc' }],
      'xingmang-canvas-',
    )).toBeNull()
  })

  it('ignores entries with a non-positive-integer id', () => {
    expect(findNewestCliKeyIdByNamePrefix(
      [{ id: 0, name: 'xingmang-canvas-a' }, { id: -1, name: 'xingmang-canvas-b' }, { id: 1.5, name: 'xingmang-canvas-c' }],
      'xingmang-canvas-',
    )).toBeNull()
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

describe('sendEmailVerification', () => {
  it('sends GET /api/verification with the email as a query parameter, no body or auth headers', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await client.sendEmailVerification('New-User@Example.com')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/verification?email=new-user%40example.com`)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['New-Api-User']).toBeUndefined()
    expect(headers.turnstile).toBeUndefined()
  })

  it('trims and lowercases the email before building the query string', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await client.sendEmailVerification('  Mixed-Case@Example.com  ')

    expect(String(fetchImpl.mock.calls[0][0])).toContain('email=mixed-case%40example.com')
  })

  it('percent-encodes characters that are not valid bare in a query string', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await client.sendEmailVerification('a+tag@example.com')

    expect(String(fetchImpl.mock.calls[0][0])).toContain('email=a%2Btag%40example.com')
  })

  it('rejects an empty email before making a network call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendEmailVerification('   ')).rejects.toThrow('请输入邮箱地址')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves without a value on success', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendEmailVerification('a@example.com')).resolves.toBeUndefined()
  })

  it('judges success from the response body, not the HTTP status -- 200 + success:false is still a failure', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse('SMTP 服务器未配置'))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendEmailVerification('a@example.com')).rejects.toThrow('SMTP 服务器未配置')
  })

  it('surfaces the server message on a 429 per-IP rate-limit response', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse('发送过于频繁，请稍后再试', 429))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendEmailVerification('a@example.com')).rejects.toThrow('发送过于频繁')
  })

  it('surfaces an "already registered" rejection the same way as any other failure', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse('该邮箱已注册'))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendEmailVerification('a@example.com')).rejects.toThrow('该邮箱已注册')
  })
})

describe('sendPasswordResetEmail', () => {
  it('sends GET /api/reset_password with the email as a query parameter, no body or auth headers', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await client.sendPasswordResetEmail('New-User@Example.com')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/reset_password?email=new-user%40example.com`)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['New-Api-User']).toBeUndefined()
  })

  it('trims and lowercases the email before building the query string', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await client.sendPasswordResetEmail('  Mixed-Case@Example.com  ')

    expect(String(fetchImpl.mock.calls[0][0])).toContain('email=mixed-case%40example.com')
  })

  it('rejects an empty email before making a network call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendPasswordResetEmail('   ')).rejects.toThrow('请输入邮箱地址')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves without a value on success', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendPasswordResetEmail('a@example.com')).resolves.toBeUndefined()
  })

  // Anti-enumeration is enforced server-side (controller/misc.go's
  // SendPasswordResetEmail unconditionally replies {success:true}, whether
  // or not model.GetUniqueUserByEmail finds an account for the address) --
  // there is nothing for the client to branch on, so a resolved call for an
  // address that has no account looks identical to one that does. This test
  // documents that indistinguishability rather than re-testing server logic
  // this file has no access to.
  it('resolves the same way regardless of whether the address has an account, by construction', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendPasswordResetEmail('unregistered@example.com')).resolves.toBeUndefined()
  })

  it('judges success from the response body, not the HTTP status -- 200 + success:false is still a failure', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse('参数错误'))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendPasswordResetEmail('a@example.com')).rejects.toThrow('参数错误')
  })

  it('surfaces the server message on a rate-limit response', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse('操作频繁，请稍后再试', 429))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.sendPasswordResetEmail('a@example.com')).rejects.toThrow('操作频繁')
  })
})

describe('register', () => {
  it('posts username, email, password and verification_code from the input', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(registerAckResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await client.register({
      username: 'new-user',
      email: 'new-user@example.com',
      password: 'correct horse battery staple',
      verificationCode: '123456',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/user/register`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      username: 'new-user',
      password: 'correct horse battery staple',
      email: 'new-user@example.com',
      verification_code: '123456',
    })
  })

  it('trims the username the same way it trims the email', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(registerAckResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await client.register({
      username: '  padded-name  ',
      email: '  a@example.com  ',
      password: 'correct horse battery staple',
      verificationCode: '000000',
    })

    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body.username).toBe('padded-name')
    expect(body.email).toBe('a@example.com')
  })

  it('includes aff_code only when the caller supplies one', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(registerAckResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await client.register({
      username: 'user',
      email: 'a@example.com',
      password: 'correct horse battery staple',
      verificationCode: '000000',
    })
    expect(JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))).not.toHaveProperty('aff_code')

    fetchImpl.mockClear().mockResolvedValue(registerAckResponse())
    await client.register({
      username: 'user',
      email: 'a@example.com',
      password: 'correct horse battery staple',
      verificationCode: '000000',
      affCode: 'promo-1',
    })
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body.aff_code).toBe('promo-1')
  })

  it('rejects empty username, email, password, or verification code before making a network call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.register({
      username: '  ',
      email: 'a@example.com',
      password: 'correct horse battery staple',
      verificationCode: '123456',
    })).rejects.toThrow('请输入用户名')
    await expect(client.register({
      username: 'user',
      email: '  ',
      password: 'correct horse battery staple',
      verificationCode: '123456',
    })).rejects.toThrow('请输入邮箱地址')
    await expect(client.register({
      username: 'user',
      email: 'a@example.com',
      password: '',
      verificationCode: '123456',
    })).rejects.toThrow('请输入密码')
    await expect(client.register({
      username: 'user',
      email: 'a@example.com',
      password: 'correct horse battery staple',
      verificationCode: '  ',
    })).rejects.toThrow('请输入邮箱验证码')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves to undefined on success without assuming an undocumented response shape', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(registerAckResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.register({
      username: 'user',
      email: 'a@example.com',
      password: 'correct horse battery staple',
      verificationCode: '123456',
    })).resolves.toBeUndefined()
  })

  it('surfaces the server-reported failure message on a rejected registration', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse('该邮箱已注册'))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.register({
      username: 'user',
      email: 'a@example.com',
      password: 'correct horse battery staple',
      verificationCode: '123456',
    })).rejects.toThrow('该邮箱已注册')
  })

  it('redacts an echoed password and verification code from a failure message (I13)', async () => {
    const password = 'hunter2-secret-password'
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(
      failureResponse(`rejected: password ${password} code 654321 invalid`),
    )
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    let message = ''
    try {
      await client.register({ username: 'user', email: 'a@example.com', password, verificationCode: '654321' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(password)
    expect(message).not.toContain('654321')
  })
})

describe('resetPassword', () => {
  it('posts the trimmed email and token from the input', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(
      jsonResponse({ success: true, message: '', data: 'freshly-generated-1' }),
    )
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    const result = await client.resetPassword({ email: '  New-User@Example.com  ', token: '  abc123token  ' })

    expect(result).toEqual({ newPassword: 'freshly-generated-1' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/user/reset`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'new-user@example.com', token: 'abc123token' })
  })

  it('rejects an empty email or token before making a network call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.resetPassword({ email: '   ', token: 'abc123' })).rejects.toThrow('请输入邮箱地址')
    await expect(client.resetPassword({ email: 'a@example.com', token: '   ' })).rejects.toThrow('请输入重置码')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('surfaces the server-reported failure message for an invalid or expired reset link', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(failureResponse('重置链接非法或已过期'))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.resetPassword({ email: 'a@example.com', token: 'stale-token' })).rejects.toThrow('重置链接非法或已过期')
  })

  it('rejects a success envelope whose data is not a usable password string', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(jsonResponse({ success: true, message: '', data: null }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.resetPassword({ email: 'a@example.com', token: 'abc123' })).rejects.toThrow('未返回新密码')
  })

  it('redacts an echoed token from a failure message (I13) -- it is as sensitive as a password', async () => {
    const token = 'super-secret-reset-token-value'
    const fetchImpl = vi.fn<NewApiFetch>().mockResolvedValue(
      failureResponse(`rejected: token ${token} invalid`),
    )
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    let message = ''
    try {
      await client.resetPassword({ email: 'a@example.com', token })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(token)
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

describe('getProfile', () => {
  it('requires login before it can be called', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.getProfile()).rejects.toThrow('请先登录星芒账号')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('makes exactly one authenticated GET /api/user/self call -- unlike getBalance, no /api/status round trip', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userDetailData() }))

    const profile = await client.getProfile()

    expect(profile).toEqual({
      userId: 42,
      username: 'tester',
      displayName: 'Tester Display',
      email: 'tester@example.com',
      group: 'default',
      quota: 1_000_000,
      usedQuota: 250_000,
      requestCount: 12,
      affCode: 'ABC123',
      affCount: 3,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/user/self`)
    expect(init?.method).toBe('GET')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-access-token-abc')
    expect(headers['New-Api-User']).toBe('42')
  })

  it('clears the session and throws a typed error on a 401 response', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('登录状态已失效', 401))

    await expect(client.getProfile()).rejects.toBeInstanceOf(NewApiAuthenticationError)
    expect(client.isAuthenticated()).toBe(false)
  })
})

describe('getUsage', () => {
  it('requires login before it can be called', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.getUsage()).rejects.toThrow('请先登录星芒账号')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('calls GET /api/log/self with no query string when no input is given', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: { page: 1, page_size: 10, total: 0, items: [] },
    }))

    const page = await client.getUsage()

    expect(page).toEqual({ page: 1, pageSize: 10, total: 0, records: [] })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/log/self`)
    expect(init?.method).toBe('GET')
  })

  it('forwards page/pageSize as the p/page_size query parameters', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: { page: 3, page_size: 8, total: 25, items: [] },
    }))

    await client.getUsage({ page: 3, pageSize: 8 })

    const [url] = fetchImpl.mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/api/log/self')
    expect(parsed.searchParams.get('p')).toBe('3')
    expect(parsed.searchParams.get('page_size')).toBe('8')
  })

  it('parses the returned items into usage records', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: {
        page: 1,
        page_size: 10,
        total: 1,
        items: [{ id: 1, created_at: 1_754_784_000, type: 2, model_name: 'claude-3-5-sonnet', prompt_tokens: 10, completion_tokens: 20, quota: 30, is_stream: false }],
      },
    }))

    const page = await client.getUsage()

    expect(page.records).toEqual([{
      id: 1,
      createdAt: new Date(1_754_784_000 * 1000).toISOString(),
      type: 2,
      modelName: 'claude-3-5-sonnet',
      promptTokens: 10,
      completionTokens: 20,
      quota: 30,
      isStream: false,
    }])
  })

  it('clears the session and throws a typed error on a 401 response', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('登录状态已失效', 401))

    await expect(client.getUsage()).rejects.toBeInstanceOf(NewApiAuthenticationError)
    expect(client.isAuthenticated()).toBe(false)
  })
})

describe('parseAccountKey', () => {
  it('reads the metadata fields and converts unix-second timestamps to ISO', () => {
    const key = parseAccountKey({
      id: 7,
      user_id: 42,
      key: 'sk-masked-abcd****1234',
      status: 1,
      name: 'xingmang-desktop-abc',
      created_time: 1_754_784_000,
      accessed_time: 1_754_800_000,
      expired_time: 1_754_900_000,
      remain_quota: 500_000,
      unlimited_quota: false,
      used_quota: 12_345,
      group: 'default',
    })
    expect(key).toEqual({
      id: 7,
      name: 'xingmang-desktop-abc',
      status: 1,
      remainQuota: 500_000,
      unlimitedQuota: false,
      usedQuota: 12_345,
      createdAt: new Date(1_754_784_000 * 1000).toISOString(),
      expiredAt: new Date(1_754_900_000 * 1000).toISOString(),
      accessedAt: new Date(1_754_800_000 * 1000).toISOString(),
    })
  })

  it('never copies the key field into the DTO even though the server includes a masked key (I3)', () => {
    const payload = {
      id: 1,
      name: 'test',
      status: 1,
      key: 'sk-attacker-should-never-see-this-fragment',
      remain_quota: 0,
      unlimited_quota: true,
      used_quota: 0,
      created_time: 1_754_784_000,
    }
    const key = parseAccountKey(payload)
    expect(key).not.toBeNull()
    expect(Object.keys(key as object).sort()).toEqual(
      ['accessedAt', 'createdAt', 'expiredAt', 'id', 'name', 'remainQuota', 'status', 'unlimitedQuota', 'usedQuota'].sort(),
    )
    expect(JSON.stringify(key)).not.toContain('sk-attacker')
  })

  it('treats a non-positive expired_time (including the -1 never-expires sentinel) as no expiry', () => {
    expect(parseAccountKey({ id: 1, name: 'a', expired_time: -1, created_time: 1 })?.expiredAt).toBeNull()
    expect(parseAccountKey({ id: 1, name: 'a', expired_time: 0, created_time: 1 })?.expiredAt).toBeNull()
  })

  it('treats a zero accessed_time (never used yet) as null', () => {
    expect(parseAccountKey({ id: 1, name: 'a', accessed_time: 0, created_time: 1 })?.accessedAt).toBeNull()
  })

  it('returns null for a non-record payload or a missing/invalid id', () => {
    expect(parseAccountKey(null)).toBeNull()
    expect(parseAccountKey('not-a-record')).toBeNull()
    expect(parseAccountKey({ name: 'a' })).toBeNull()
    expect(parseAccountKey({ id: 0, name: 'a' })).toBeNull()
    expect(parseAccountKey({ id: -1, name: 'a' })).toBeNull()
  })
})

describe('parseAccountKeysPage', () => {
  it('reads page/page_size/total from the PageInfo envelope and parses each item', () => {
    const page = parseAccountKeysPage({
      page: 2,
      page_size: 8,
      total: 3,
      items: [
        { id: 1, name: 'a', status: 1, created_time: 1_754_784_000 },
        { id: 2, name: 'b', status: 2, created_time: 1_754_784_100 },
      ],
    })
    expect(page.page).toBe(2)
    expect(page.pageSize).toBe(8)
    expect(page.total).toBe(3)
    expect(page.keys).toHaveLength(2)
    expect(page.keys[0].id).toBe(1)
    expect(page.keys[1].id).toBe(2)
  })

  it('silently skips malformed rows instead of failing the whole page', () => {
    const page = parseAccountKeysPage({
      page: 1,
      page_size: 10,
      total: 1,
      items: [{ id: 1, name: 'ok' }, { id: 0 }, 'not-a-record', null],
    })
    expect(page.keys).toHaveLength(1)
    expect(page.keys[0].id).toBe(1)
  })

  it('defaults to page 1 / page size 10 / total 0 / empty keys for a malformed envelope', () => {
    expect(parseAccountKeysPage(null)).toEqual({ page: 1, pageSize: 10, total: 0, keys: [] })
    expect(parseAccountKeysPage({})).toEqual({ page: 1, pageSize: 10, total: 0, keys: [] })
    expect(parseAccountKeysPage({ items: 'not-an-array' })).toEqual({ page: 1, pageSize: 10, total: 0, keys: [] })
  })
})

describe('parseChangePasswordResponseData', () => {
  it('reads the fresh access token and expiry from a successful password-change bundle', () => {
    const data = parseChangePasswordResponseData({
      access_token: 'new-access-token-after-change',
      token_type: 'Bearer',
      access_expires_at: '2026-08-10T01:00:00.000Z',
      session: { sid: 'abc', current: true },
    })
    expect(data).toEqual({
      accessToken: 'new-access-token-after-change',
      accessExpiresAt: '2026-08-10T01:00:00.000Z',
    })
  })

  it('returns null instead of throwing when access_token is missing (e.g. a non-password-changing update)', () => {
    expect(parseChangePasswordResponseData({})).toBeNull()
    expect(parseChangePasswordResponseData(null)).toBeNull()
    expect(parseChangePasswordResponseData({ access_token: '' })).toBeNull()
  })
})

describe('listKeys', () => {
  it('requires login before it can be called', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.listKeys()).rejects.toThrow('请先登录星芒账号')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('calls GET /api/token/ with no query string when no input is given', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: { page: 1, page_size: 10, total: 0, items: [] },
    }))

    const page = await client.listKeys()

    expect(page).toEqual({ page: 1, pageSize: 10, total: 0, keys: [] })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/token/`)
    expect(init?.method).toBe('GET')
  })

  it('forwards page/pageSize as the p/page_size query parameters', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: { page: 2, page_size: 5, total: 12, items: [] },
    }))

    await client.listKeys({ page: 2, pageSize: 5 })

    const [url] = fetchImpl.mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/api/token/')
    expect(parsed.searchParams.get('p')).toBe('2')
    expect(parsed.searchParams.get('page_size')).toBe('5')
  })

  it('never surfaces the wire key field through the full fetch -> parse round trip (I3)', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: {
        page: 1,
        page_size: 10,
        total: 1,
        items: [{ id: 1, name: 'a', status: 1, key: 'sk-should-never-leak', created_time: 1_754_784_000 }],
      },
    }))

    const page = await client.listKeys()

    expect(JSON.stringify(page)).not.toContain('sk-should-never-leak')
  })

  it('clears the session and throws a typed error on a 401 response', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('登录状态已失效', 401))

    await expect(client.listKeys()).rejects.toBeInstanceOf(NewApiAuthenticationError)
    expect(client.isAuthenticated()).toBe(false)
  })
})

describe('revokeKey', () => {
  it('requires login before it can be called', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.revokeKey(1)).rejects.toThrow('请先登录星芒账号')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends DELETE /api/token/:id with the authenticated headers', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({ success: true, message: '' }))

    await client.revokeKey(99)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/token/99`)
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-access-token-abc')
    expect(headers['New-Api-User']).toBe('42')
  })

  it('rejects a non-integer or non-positive id before making a network call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)

    await expect(client.revokeKey(1.5)).rejects.toThrow('Key ID 格式错误')
    await expect(client.revokeKey(0)).rejects.toThrow('Key ID 格式错误')
    await expect(client.revokeKey(-1)).rejects.toThrow('Key ID 格式错误')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('surfaces the server-reported failure message when the token cannot be deleted', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('记录不存在'))

    await expect(client.revokeKey(404)).rejects.toThrow('记录不存在')
  })

  it('clears the session and throws a typed error on a 401 response', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('登录状态已失效', 401))

    await expect(client.revokeKey(1)).rejects.toBeInstanceOf(NewApiAuthenticationError)
    expect(client.isAuthenticated()).toBe(false)
  })
})

describe('changePassword', () => {
  it('requires login before it can be called', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })
    await expect(client.changePassword({ originalPassword: 'old12345', newPassword: 'new12345' }))
      .rejects.toThrow('请先登录星芒账号')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an empty original or new password before making a network call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)

    await expect(client.changePassword({ originalPassword: '', newPassword: 'new12345' }))
      .rejects.toThrow('请输入原密码')
    await expect(client.changePassword({ originalPassword: 'old12345', newPassword: '' }))
      .rejects.toThrow('请输入新密码')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends PUT /api/user/self with password and original_password', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: {
        access_token: 'rotated-access-token',
        token_type: 'Bearer',
        access_expires_at: '2026-08-10T02:00:00.000Z',
        session: {},
      },
    }))

    const result = await client.changePassword({ originalPassword: 'old-password-1', newPassword: 'new-password-2' })

    expect(result).toEqual({ changed: true })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(`${testBaseUrl}/api/user/self`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({ password: 'new-password-2', original_password: 'old-password-1' })
  })

  it('adopts the fresh access token in place so the very next call uses it without a re-login', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: { access_token: 'rotated-access-token', token_type: 'Bearer', access_expires_at: null, session: {} },
    }))
    await client.changePassword({ originalPassword: 'old-password-1', newPassword: 'new-password-2' })

    fetchImpl.mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userDetailData() }))
    await client.getProfile()

    const [, init] = fetchImpl.mock.calls[1]
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer rotated-access-token')
  })

  it('still resolves successfully when the response carries no usable bundle, without touching the existing access token', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: null }))

    await expect(client.changePassword({ originalPassword: 'old-password-1', newPassword: 'new-password-2' }))
      .resolves.toEqual({ changed: true })

    fetchImpl.mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userDetailData() }))
    await client.getProfile()
    const [, init] = fetchImpl.mock.calls[1]
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-access-token-abc')
  })

  it('surfaces the server-reported failure message for a wrong original password', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('原密码错误'))

    await expect(client.changePassword({ originalPassword: 'wrong-password', newPassword: 'new-password-2' }))
      .rejects.toThrow('原密码错误')
  })

  it('redacts both plaintext passwords from an echoed failure message (I13)', async () => {
    const originalPassword = 'super-secret-original-pw'
    const newPassword = 'super-secret-new-pw'
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse(`rejected: ${originalPassword} / ${newPassword} invalid`))

    let message = ''
    try {
      await client.changePassword({ originalPassword, newPassword })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(originalPassword)
    expect(message).not.toContain(newPassword)
  })

  it('clears the session and throws a typed error on a 401 response', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('登录状态已失效', 401))

    await expect(client.changePassword({ originalPassword: 'old-password-1', newPassword: 'new-password-2' }))
      .rejects.toBeInstanceOf(NewApiAuthenticationError)
    expect(client.isAuthenticated()).toBe(false)
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

describe('findExistingCliKey (list -> reveal, used to avoid re-provisioning)', () => {
  it('makes only the list call and returns null when nothing matches the prefix', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      success: true,
      message: '',
      data: [{ id: 1, name: 'xingmang-desktop-abc' }],
    }))

    await expect(client.findExistingCliKey('xingmang-canvas-')).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET')
  })

  it('reveals and returns the newest matching token without creating a new one', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        message: '',
        data: [
          { id: 3, name: 'xingmang-canvas-old' },
          { id: 9, name: 'xingmang-canvas-newest' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: { key: 'sk-reused-value' } }))

    const result = await client.findExistingCliKey('xingmang-canvas-')

    expect(result).toEqual({ id: 9, name: 'xingmang-canvas-newest', key: 'sk-reused-value' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [listUrl, listInit] = fetchImpl.mock.calls[0]
    expect(String(listUrl)).toBe(`${testBaseUrl}/api/token/`)
    expect(listInit?.method).toBe('GET')
    const [keyUrl, keyInit] = fetchImpl.mock.calls[1]
    expect(String(keyUrl)).toBe(`${testBaseUrl}/api/token/9/key`)
    expect(keyInit?.method).toBe('POST')
  })

  it('returns null (not an error) when the matched token cannot be revealed', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: [{ id: 4, name: 'xingmang-canvas-x' }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: {} }))

    await expect(client.findExistingCliKey('xingmang-canvas-')).resolves.toBeNull()
  })

  it('propagates a genuine request failure from the list call', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('服务暂不可用'))

    await expect(client.findExistingCliKey('xingmang-canvas-')).rejects.toThrow('服务暂不可用')
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

describe('silent 401 refresh-and-retry (withSession)', () => {
  it('refreshes once and transparently retries the whole call on a single 401', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(failureResponse('AuthVersion 已变化', 401))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        message: '',
        data: { access_token: 'rotated-token', access_expires_at: null },
      }))
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userData() }))

    const balance = await client.getBalance()

    expect(balance.quota).toBe(1_000_000)
    expect(client.isAuthenticated()).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(5)
    // call order: status, self (401), refresh, status (retry), self (retry)
    const [refreshUrl] = fetchImpl.mock.calls[2]
    expect(String(refreshUrl)).toBe(`${testBaseUrl}/api/user/auth/refresh`)
    const retriedSelfHeaders = fetchImpl.mock.calls[4][1]?.headers as Record<string, string>
    expect(retriedSelfHeaders.Authorization).toBe('Bearer rotated-token')
  })

  it('attempts exactly one refresh, then surfaces the original 401 when the refresh call itself fails', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(failureResponse('AuthVersion 已变化', 401))
      .mockRejectedValueOnce(new TypeError('network down'))

    await expect(client.getBalance()).rejects.toBeInstanceOf(NewApiAuthenticationError)
    expect(client.isAuthenticated()).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(String(fetchImpl.mock.calls[2][0])).toBe(`${testBaseUrl}/api/user/auth/refresh`)
  })

  it('gives up after exactly one refresh attempt when the retried call 401s again (bounded retry, no loop)', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(failureResponse('AuthVersion 已变化', 401))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        message: '',
        data: { access_token: 'rotated-token', access_expires_at: null },
      }))
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(failureResponse('AuthVersion 仍然异常', 401))

    await expect(client.getBalance()).rejects.toBeInstanceOf(NewApiAuthenticationError)
    expect(client.isAuthenticated()).toBe(false)
    // Exactly 5 calls -- a second refresh attempt would make this 6 or more.
    expect(fetchImpl).toHaveBeenCalledTimes(5)
  })

  it('does not attempt a refresh at all for a non-401 failure', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    fetchImpl.mockResolvedValueOnce(failureResponse('已达到 Key 数量上限'))

    await expect(client.provisionCliKey()).rejects.toThrow('已达到 Key 数量上限')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(client.isAuthenticated()).toBe(true)
  })
})

describe('onSessionChange', () => {
  it('fires with {userId, cookies} on login and with null on logout', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const onSessionChange = vi.fn()
    fetchImpl.mockResolvedValueOnce(loginResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl, onSessionChange })

    await client.login({ username: 'tester', password: 'correct horse battery staple' })
    expect(onSessionChange).toHaveBeenCalledTimes(1)
    expect(onSessionChange).toHaveBeenLastCalledWith({ userId: 42, cookies: ['refresh_token=cookie-value-1'] })

    client.logout()
    expect(onSessionChange).toHaveBeenCalledTimes(2)
    expect(onSessionChange).toHaveBeenLastCalledWith(null)
  })

  it('fires again with rotated cookies after a silent refresh-and-retry', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const onSessionChange = vi.fn()
    fetchImpl.mockResolvedValueOnce(loginResponse())
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl, onSessionChange })
    await client.login({ username: 'tester', password: 'x' })
    onSessionChange.mockClear()

    fetchImpl
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(failureResponse('expired', 401))
      .mockResolvedValueOnce(jsonResponse(
        { success: true, message: '', data: { access_token: 'rotated-token', access_expires_at: null } },
        {},
        ['refresh_token=cookie-value-2'],
      ))
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userData() }))

    await client.getBalance()

    expect(onSessionChange).toHaveBeenCalledWith({ userId: 42, cookies: ['refresh_token=cookie-value-2'] })
  })
})

describe('getPersistableSession', () => {
  it('returns null when signed out', () => {
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl: vi.fn<NewApiFetch>() })
    expect(client.getPersistableSession()).toBeNull()
  })

  it('returns the current userId and cookies when signed in', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)
    expect(client.getPersistableSession()).toEqual({ userId: 42, cookies: ['refresh_token=cookie-value-1'] })
  })
})

describe('restoreSession', () => {
  it('refreshes, re-fetches the profile, and authenticates on a valid persisted credential', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const onSessionChange = vi.fn()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl, onSessionChange })
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        message: '',
        data: { access_token: 'restored-token', access_expires_at: null },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userData() }))

    const restored = await client.restoreSession({ userId: 42, cookies: ['refresh_token=persisted-cookie'] })

    expect(restored).toBe(true)
    expect(client.isAuthenticated()).toBe(true)
    expect(client.getSessionState()).toEqual({
      authenticated: true,
      account: { userId: 42, username: 'tester', group: 'default', role: 1, quota: 1_000_000, usedQuota: 250_000 },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [refreshUrl, refreshInit] = fetchImpl.mock.calls[0]
    expect(String(refreshUrl)).toBe(`${testBaseUrl}/api/user/auth/refresh`)
    expect((refreshInit?.headers as Record<string, string>).Cookie).toBe('refresh_token=persisted-cookie')
    const [selfUrl, selfInit] = fetchImpl.mock.calls[1]
    expect(String(selfUrl)).toBe(`${testBaseUrl}/api/user/self`)
    expect((selfInit?.headers as Record<string, string>).Authorization).toBe('Bearer restored-token')
    expect((selfInit?.headers as Record<string, string>)['New-Api-User']).toBe('42')
    expect(onSessionChange).toHaveBeenCalledWith({ userId: 42, cookies: ['refresh_token=persisted-cookie'] })
  })

  it('is a no-op returning true when a session already exists', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = await authenticatedClient(fetchImpl)

    await expect(client.restoreSession({ userId: 1, cookies: ['whatever=x'] })).resolves.toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves false without any network call on a malformed persisted credential', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.restoreSession({ userId: 0, cookies: ['x=y'] })).resolves.toBe(false)
    await expect(client.restoreSession({ userId: 1, cookies: [] })).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves false (does not throw) when the refresh cookie is already dead', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    fetchImpl.mockResolvedValueOnce(failureResponse('refresh token invalid', 401))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.restoreSession({ userId: 42, cookies: ['refresh_token=stale'] })).resolves.toBe(false)
    expect(client.isAuthenticated()).toBe(false)
  })

  it('resolves false when the post-refresh self call 401s', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        message: '',
        data: { access_token: 'x', access_expires_at: null },
      }))
      .mockResolvedValueOnce(failureResponse('nope', 401))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.restoreSession({ userId: 42, cookies: ['refresh_token=stale'] })).resolves.toBe(false)
    expect(client.isAuthenticated()).toBe(false)
  })

  it('rethrows (does not silently return false) on a network failure, so a caller can tell "gone" apart from "unreachable"', async () => {
    const fetchImpl = vi.fn<NewApiFetch>().mockRejectedValueOnce(new TypeError('network down'))
    const onSessionChange = vi.fn()
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl, onSessionChange })

    await expect(client.restoreSession({ userId: 42, cookies: ['refresh_token=x'] })).rejects.toThrow()
    expect(client.isAuthenticated()).toBe(false)
    expect(onSessionChange).not.toHaveBeenCalled()
  })

  it('resolves false if the refreshed profile belongs to a different user than the persisted userId', async () => {
    const fetchImpl = vi.fn<NewApiFetch>()
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        message: '',
        data: { access_token: 'x', access_expires_at: null },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: '', data: userData({ id: 999 }) }))
    const client = createNewApiClient({ baseUrl: testBaseUrl, fetchImpl })

    await expect(client.restoreSession({ userId: 42, cookies: ['refresh_token=x'] })).resolves.toBe(false)
    expect(client.isAuthenticated()).toBe(false)
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

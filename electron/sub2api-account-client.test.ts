import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { createSub2ApiAccountClient, createSub2ApiSessionExecutor, provisionSub2ApiManagedCliKeys, type Sub2ApiAccountClientOptions } from './sub2api-account-client'
import { parseRealmSavedAccount, RealmAccountError, type RealmSavedAccount } from './realm-account'

const secret = 'private-access-token'
const user = { id: 7, username: 'api-user', email: 'user@example.test', balance: 12.5, status: 'active' }
const auth = { access_token: secret, refresh_token: 'private-refresh-token', expires_in: 3600, token_type: 'Bearer', user }
const key = { id: 4, user_id: 7, key: 'sk-private-value', name: 'CLI', group_id: 3, status: 'active' }
const signal = () => new AbortController().signal
const input = { identifier: 'user@example.test', password: 'private-password' }
function response(data: unknown): Response { return Response.json({ code: 0, message: 'ok', data }) }
function saved(): RealmSavedAccount {
  return parseRealmSavedAccount({ version: 2, realmId: 'api-account', origin: 'https://api.solov.cc', userId: '7', username: user.username,
    credential: { kind: 'sub2api', accessToken: secret, refreshToken: 'private-refresh-token', expiresAt: null } })
}
function fixture(queue: (Response | Error)[], extra: Partial<Sub2ApiAccountClientOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const client = createSub2ApiAccountClient({ now: () => 1000000, fetchImpl: async (url, init) => {
    calls.push({ url, init }); const next = queue.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    return next
  }, ...extra })
  return { client, calls }
}
function hasCode(code: string) { return (error: unknown) => error instanceof RealmAccountError && error.code === code }

describe('sub2api user-account adapter', () => {
  it('authenticates only against the fixed api realm with no cookies or redirects', async () => {
    const example = fixture([response(auth)])
    const account = await example.client.authenticate(input, signal())
    assert.equal(account.realmId, 'api-account'); assert.equal(account.credential.kind, 'sub2api')
    assert.equal(example.calls[0].url, 'https://api.solov.cc/api/v1/auth/login')
    assert.equal(example.calls[0].init.credentials, 'omit'); assert.equal(example.calls[0].init.redirect, 'manual')
    assert.equal(new Headers(example.calls[0].init.headers).get('authorization'), null)
    assert.deepEqual(JSON.parse(String(example.calls[0].init.body)), { email: input.identifier, password: input.password })
  })
  it('does not coerce a username to an email or try another site', async () => {
    const example = fixture([])
    await assert.rejects(example.client.authenticate({ ...input, identifier: 'not-an-email' }, signal()), hasCode('INVALID'))
    assert.equal(example.calls.length, 0)
  })
  it('rejects 2FA challenges without persisting or exposing their temporary token', async () => {
    const example = fixture([response({ requires_2fa: true, temp_token: 'very-private-temporary-token' })])
    await assert.rejects(example.client.authenticate(input, signal()), (error: unknown) => hasCode('TWO_FACTOR_REQUIRED')(error)
      && !String(error).includes('very-private'))
  })
  it('reads native balance without inventing a new-api quota conversion', async () => {
    const example = fixture([response(user)])
    assert.deepEqual(await example.client.getBalance(saved(), signal()), { amount: '12.5', unit: 'sub2api-balance' })
    assert.equal(new Headers(example.calls[0].init.headers).get('authorization'), `Bearer ${secret}`)
    assert.equal(new Headers(example.calls[0].init.headers).get('new-api-user'), null)
  })
  it('strips full key values and retains numeric group ids in list summaries', async () => {
    const example = fixture([response({ items: [key], total: 1 })])
    const page = await example.client.listKeys(saved(), 1, 20, signal())
    assert.deepEqual(page, { items: [{ id: '4', name: 'CLI', groupId: '3', status: 'active' }], total: 1 })
    assert.ok(!JSON.stringify(page).includes('sk-private'))
  })
  it('reveals a key only through the explicit operation', async () => {
    assert.equal(await fixture([response(key)]).client.revealKey(saved(), '4', signal()), 'sk-private-value')
  })
  it('creates a key with a group id rather than a new-api group name', async () => {
    const example = fixture([response(key)])
    await example.client.createKey(saved(), { name: 'CLI', groupId: '3' }, signal())
    assert.deepEqual(JSON.parse(String(example.calls[0].init.body)), { name: 'CLI', group_id: 3 })
  })
  it('lists user-visible groups from the native groups endpoint', async () => {
    const example = fixture([response([
      { id: 11, name: 'Codex_pro', platform: 'openai', status: 'active', description: 'hidden fields ignored' },
      { id: 12, name: 'Claude-MAX(不限客户端)', platform: 'anthropic', status: 'active' },
    ])])
    assert.deepEqual(await example.client.listGroups(saved(), signal()), [
      { id: '11', name: 'Codex_pro', platform: 'openai', status: 'active' },
      { id: '12', name: 'Claude-MAX(不限客户端)', platform: 'anthropic', status: 'active' },
    ])
    assert.equal(new URL(example.calls[0].url).pathname, '/api/v1/groups/available')
  })
  it('reads and updates the native user profile', async () => {
    const profile = { ...user, email: 'user@example.test', role: 'user', avatar_url: 'https://img.example/avatar.png',
      balance_notify_enabled: true, balance_notify_threshold: 2.5 }
    const example = fixture([response(profile), response({ ...profile, username: 'renamed' })])
    assert.deepEqual(await example.client.getProfile(saved(), signal()), {
      userId: '7', email: profile.email, username: profile.username, balance: profile.balance, status: 'active', role: 'user',
      avatarUrl: profile.avatar_url, balanceNotifyEnabled: true, balanceNotifyThreshold: 2.5,
    })
    assert.equal(new URL(example.calls[0].url).pathname, '/api/v1/user/profile')
    const updated = await example.client.updateProfile(saved(), { username: 'renamed', avatarUrl: null, balanceNotifyEnabled: false }, signal())
    assert.equal(updated.username, 'renamed')
    assert.deepEqual(JSON.parse(String(example.calls[1].init.body)), { username: 'renamed', avatar_url: null, balance_notify_enabled: false })
    assert.equal(new URL(example.calls[1].url).pathname, '/api/v1/user')
    assert.equal(example.calls[1].init.method, 'PUT')
  })

  it('creates and reveals the four requested managed groups without duplicate active keys', async () => {
    const groups = [
      { id: '1', name: 'Codex_pro', platform: 'openai', status: 'active' },
      { id: '2', name: 'Claude-MAX(不限客户端)', platform: 'anthropic', status: 'active' },
      { id: '3', name: 'Gemini', platform: 'gemini', status: 'active' },
      { id: '4', name: 'grok-heavy', platform: 'grok', status: 'active' },
    ]
    const created: Array<{ name: string; groupId: string | null }> = []
    const managed = await provisionSub2ApiManagedCliKeys({
      listGroups: async () => groups,
      listKeys: async () => ({ items: [], total: 0 }),
      createKey: async (_saved, input) => {
        created.push(input)
        return { id: String(created.length), name: input.name, groupId: input.groupId, status: 'active' }
      },
      revealKey: async (_saved, id) => `sk-managed-${id}`,
    }, saved(), signal())
    assert.deepEqual(created, [
      { name: 'xingmang-desktop-claude', groupId: '2' },
      { name: 'xingmang-desktop-codex', groupId: '1' },
      { name: 'xingmang-desktop-grok', groupId: '4' },
      { name: 'xingmang-desktop-gemini', groupId: '3' },
    ])
    assert.deepEqual(managed.map(({ provider, group, key }) => ({ provider, group, key })), [
      { provider: 'claude', group: 'Claude-MAX(不限客户端)', key: 'sk-managed-1' },
      { provider: 'codex', group: 'Codex_pro', key: 'sk-managed-2' },
      { provider: 'grok', group: 'grok-heavy', key: 'sk-managed-3' },
      { provider: 'gemini', group: 'Gemini', key: 'sk-managed-4' },
    ])
  })
  it('does not automatically retry a possibly committed write', async () => {
    const example = fixture([new Error('private transport detail')])
    await assert.rejects(example.client.createKey(saved(), { name: 'CLI', groupId: '3' }, signal()), RealmAccountError)
    assert.equal(example.calls.length, 1)
  })
  it('refreshes a failed saved session once and verifies the same user before accepting it', async () => {
    const example = fixture([new Response('', { status: 401 }), response({ ...auth, access_token: 'rotated-access' }), response(user)])
    const restored = await example.client.restore(saved(), signal())
    assert.equal(restored.credential.kind === 'sub2api' && restored.credential.accessToken, 'rotated-access')
    assert.deepEqual(example.calls.map((call) => new URL(call.url).pathname), ['/api/v1/auth/me', '/api/v1/auth/refresh', '/api/v1/auth/me'])
    assert.deepEqual(JSON.parse(String(example.calls[1].init.body)), { refresh_token: 'private-refresh-token' })
  })
  it('does not refresh on a temporary server failure', async () => {
    const example = fixture([new Response('', { status: 503 })])
    await assert.rejects(example.client.restore(saved(), signal()), hasCode('NETWORK'))
    assert.equal(example.calls.length, 1)
  })
  it('does not refresh indefinitely after repeated unauthorized responses', async () => {
    const example = fixture([new Response('', { status: 401 }), response(auth), new Response('', { status: 401 })])
    await assert.rejects(example.client.restore(saved(), signal()), hasCode('UNAUTHORIZED'))
    assert.equal(example.calls.length, 3)
  })
  it('rejects a different user after refreshing', async () => {
    const example = fixture([new Response('', { status: 401 }), response(auth), response({ ...user, id: 8 })])
    await assert.rejects(example.client.restore(saved(), signal()), hasCode('PROTOCOL'))
  })
  it('does not send xm credentials to api', async () => {
    const example = fixture([])
    const xm = parseRealmSavedAccount({ version: 2, realmId: 'xm-account', origin: 'https://xm.solov.cc', userId: '7', username: 'xm', credential: { kind: 'new-api', cookies: ['xm-cookie'] } })
    await assert.rejects(example.client.getBalance(xm, signal()), hasCode('INVALID'))
    assert.equal(example.calls.length, 0)
  })
  for (const status of [301, 302, 303, 307, 308]) {
    it(`rejects redirect ${status}`, async () => {
      const example = fixture([new Response('', { status, headers: { location: 'https://other.example.test' } })])
      await assert.rejects(example.client.authenticate(input, signal()), hasCode('PROTOCOL'))
      assert.equal(example.calls.length, 1)
    })
  }
  it('rejects an unexpected response URL even if a transport followed the redirect', async () => {
    const reply = response(auth)
    Object.defineProperty(reply, 'url', { value: 'https://other.example.test/auth/login' })
    await assert.rejects(fixture([reply]).client.authenticate(input, signal()), hasCode('PROTOCOL'))
  })
  for (const data of [{ ...auth, user: { ...user, id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...auth, access_token: 'bad\r\nheader' }, { ...auth, token_type: 'Basic' },
    { ...auth, expires_in: -1 }, { ...auth, user: { ...user, balance: null } }]) {
    it(`rejects incompatible auth data ${JSON.stringify(data).slice(-55)}`, async () => {
      await assert.rejects(fixture([response(data)]).client.authenticate(input, signal()), hasCode('PROTOCOL'))
    })
  }
  for (const data of [{ ...key, user_id: 8 }, { ...key, id: 5 }, { ...key, key: 'sk-****' }]) {
    it(`rejects an invalid or foreign key ${data.id}:${data.user_id}:${data.key.length}`, async () => {
      await assert.rejects(fixture([response(data)]).client.revealKey(saved(), '4', signal()), hasCode('PROTOCOL'))
    })
  }
  it('rejects invalid pagination before issuing a request', async () => {
    const example = fixture([])
    for (const [page, size] of [[0, 20], [1, 101], [1.5, 10]]) await assert.rejects(example.client.listKeys(saved(), page, size, signal()), hasCode('INVALID'))
    assert.equal(example.calls.length, 0)
  })
  for (const reply of [new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } }),
    Response.json({ code: 9, message: 'private token in upstream message' }), response({ ...auth, padding: 'x'.repeat(2000) })]) {
    it(`rejects unexpected or oversized JSON without exposing upstream content`, async () => {
      await assert.rejects(fixture([reply], { maxResponseBytes: 1024 }).client.authenticate(input, signal()), (error: unknown) =>
        error instanceof RealmAccountError && !String(error).includes('private token'))
    })
  }
  it('enforces the timeout even when an injected transport ignores abort', async () => {
    const client = createSub2ApiAccountClient({ timeoutMs: 20, fetchImpl: async () => new Promise<Response>(() => undefined) })
    await assert.rejects(client.authenticate(input, signal()), hasCode('TIMEOUT'))
  })
  it('enforces the timeout while reading a stalled body', async () => {
    let canceled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) }, cancel() { canceled = true } })
    const reply = new Response(stream, { headers: { 'content-type': 'application/json' } })
    await assert.rejects(fixture([reply], { timeoutMs: 20 }).client.authenticate(input, signal()), hasCode('TIMEOUT'))
    assert.equal(canceled, true)
  })
  it('does not start a request with an already aborted signal', async () => {
    const example = fixture([]); const controller = new AbortController(); controller.abort()
    await assert.rejects(example.client.authenticate(input, controller.signal), hasCode('ABORTED'))
    assert.equal(example.calls.length, 0)
  })
})

describe('sub2api session executor', () => {
  it('serializes concurrent refreshes and returns the rotated credential', async () => {
    const first = saved()
    const rotated = parseRealmSavedAccount({ ...first, credential: {
      kind: 'sub2api', accessToken: 'rotated-access-token', refreshToken: 'rotated-refresh-token', expiresAt: 2000000,
    } })
    let restoreCalls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor = createSub2ApiSessionExecutor(first, {
      restore: async () => { restoreCalls += 1; await gate; return rotated },
    })
    let attempts = 0
    const operation = async (session: RealmSavedAccount) => {
      attempts += 1
      if (session.credential.kind === 'sub2api' && session.credential.accessToken === secret) {
        throw new RealmAccountError('UNAUTHORIZED')
      }
      return 'ok'
    }
    const one = executor.executeWithRefresh(operation, signal(), { retryOnUnauthorized: true })
    const two = executor.executeWithRefresh(operation, signal(), { retryOnUnauthorized: true })
    await Promise.resolve()
    assert.equal(restoreCalls, 1)
    release()
    const [a, b] = await Promise.all([one, two])
    assert.equal(a.value, 'ok'); assert.equal(b.value, 'ok')
    assert.equal(a.session.credential.kind, 'sub2api')
    assert.equal(a.session.credential.accessToken, 'rotated-access-token')
    const latest = executor.session()
    assert.equal(latest.credential.kind, 'sub2api')
    if (latest.credential.kind === 'sub2api') assert.equal(latest.credential.refreshToken, 'rotated-refresh-token')
    assert.equal(attempts, 4)
  })

  it('does not retry writes when retry is disabled', async () => {
    const executor = createSub2ApiSessionExecutor(saved(), { restore: async () => {
      throw new Error('refresh must not run')
    } })
    let calls = 0
    await assert.rejects(executor.executeWithRefresh(async () => {
      calls += 1
      throw new RealmAccountError('UNAUTHORIZED')
    }, signal()), hasCode('UNAUTHORIZED'))
    assert.equal(calls, 1)
  })
})

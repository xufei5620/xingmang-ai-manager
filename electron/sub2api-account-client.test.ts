import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { createSub2ApiAccountClient, type Sub2ApiAccountClientOptions } from './sub2api-account-client'
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

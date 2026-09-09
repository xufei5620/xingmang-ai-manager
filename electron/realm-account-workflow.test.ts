import { strict as assert } from 'node:assert'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, it } from 'vitest'
import {
  parseRealmSavedAccount, realmAccountSummary, realmForExplicitSite, realmOwnerKey, RealmAccountError,
  type AccountRealmId, type RealmSavedAccount, type RealmSessionBackend,
} from './realm-account'
import { createRealmAccountVault, migrateLegacySavedAccount, realmStorageScope, type RealmVaultStorage } from './realm-account-vault'
import { createRealmSwitchCoordinator } from './realm-switch-coordinator'
import { assertRealmCapability, buildRealmCapabilities, realmAccountView, realmFeatures } from './realm-capabilities'
import { createSub2ApiAccountClient } from './sub2api-account-client'
import { createNewApiRealmBackend, type IsolatedNewApiRealmClient } from './new-api-realm-backend'

function account(realmId: AccountRealmId = 'xm-account', userId = '7'): RealmSavedAccount {
  return parseRealmSavedAccount({ version: 2, realmId, userId, username: `user-${userId}`,
    origin: realmId === 'xm-account' ? 'https://xm.solov.cc' : 'https://api.solov.cc',
    credential: realmId === 'xm-account' ? { kind: 'new-api', cookies: [`session=private-${userId}`] }
      : { kind: 'sub2api', accessToken: `access-${userId}`, refreshToken: `refresh-${userId}`, expiresAt: null } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function storageFixture() {
  const key = randomBytes(32)
  let content: string | null = null
  let available = true
  let failWrite = false
  let writes = 0
  const storage: RealmVaultStorage = {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes])
    },
    decryptString: (value) => {
      const bytes = Buffer.from(value)
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    },
    read: async () => content,
    writeAtomic: async (next) => { if (failWrite) throw new Error('private file detail'); content = next; writes += 1 },
  }
  return { storage, vault: createRealmAccountVault(storage), content: () => content, writes: () => writes,
    setAvailable(value: boolean) { available = value }, setFail(value: boolean) { failWrite = value },
    corrupt(value: string) { content = value } }
}

function workflow(enabledRealms: AccountRealmId[] = ['xm-account', 'api-account']) {
  const store = storageFixture()
  const calls: string[] = []
  let failApi = false
  const backends: RealmSessionBackend[] = (['xm-account', 'api-account'] as const).map((realmId) => ({
    realmId,
    authenticate: async () => { calls.push(`login:${realmId}`); if (realmId === 'api-account' && failApi) throw new RealmAccountError('UNAUTHORIZED'); return account(realmId) },
    restore: async (saved) => { calls.push(`restore:${realmId}`); return saved },
  }))
  const coordinator = createRealmSwitchCoordinator({ backends, enabledRealms, vault: store.vault,
    quiesce: async () => { calls.push('quiesce') } })
  return { ...store, coordinator, calls, backends, failApi() { failApi = true } }
}
const login = { identifier: 'person@example.test', password: 'private-password' }
function hasCode(code: string) { return (error: unknown) => error instanceof RealmAccountError && error.code === code }

describe('realm account contracts and encrypted vault', () => {
  for (const site of ['solov', 'sub2api']) it(`keeps historical ${site} on xm`, () => assert.equal(realmForExplicitSite(site), 'xm-account'))
  it('assigns a fresh site id to api', () => assert.equal(realmForExplicitSite('solov-api'), 'api-account'))
  for (const value of [null, undefined, '', ' solov', 'SOLOV', 'xm.solov.cc', 'https://api.solov.cc', {}, ['solov']]) {
    it(`rejects invalid selection ${JSON.stringify(value)}`, () => assert.throws(() => realmForExplicitSite(value), hasCode('INVALID')))
  }
  it('separates equal numeric ids across realms in keys and filesystem scopes', () => {
    const xm = account(); const api = account('api-account')
    assert.notEqual(realmOwnerKey(xm), realmOwnerKey(api))
    assert.notEqual(realmStorageScope(xm), realmStorageScope(api))
    assert.match(realmStorageScope(xm), /^[a-f0-9]{64}$/)
  })
  for (const userId of ['../7', '07', '0', '-1', '7.0', '1e2', '9007199254740992', 7]) {
    it(`rejects noncanonical or unsafe ids ${String(userId)}`, () => assert.throws(() => parseRealmSavedAccount({ ...account(), userId }), hasCode('INVALID')))
  }
  for (const origin of ['https://api.solov.cc', 'https://xm.solov.cc/', 'http://xm.solov.cc', 'https://xm.solov.cc.evil.test']) {
    it(`rejects xm envelopes with a different origin ${origin}`, () => assert.throws(() => parseRealmSavedAccount({ ...account(), origin }), hasCode('INVALID')))
  }
  it('rejects credentials for the wrong backend', () => assert.throws(() => parseRealmSavedAccount({ ...account(), credential: account('api-account').credential }), hasCode('INVALID')))
  it('does not expose credentials in summaries', () => {
    for (const realmId of ['xm-account', 'api-account'] as const) {
      assert.deepEqual(Object.keys(realmAccountSummary(account(realmId))).sort(), ['id', 'origin', 'realmId', 'userId', 'username'])
    }
  })
  it('persists two realms without overwriting matching user ids', async () => {
    const example = storageFixture()
    await Promise.all([example.vault.activate(account()), example.vault.activate(account('api-account'))])
    assert.equal((await example.vault.list()).length, 2)
    assert.equal((await example.vault.active())?.realmId, 'api-account')
    assert.equal((await example.vault.get(account()))?.credential.kind, 'new-api')
    assert.ok(!Buffer.from(example.content()!, 'base64').includes(Buffer.from('private-7')))
  })
  it('captures credential input before enqueueing', async () => {
    const example = storageFixture()
    const cookies = ['session=original']
    const pending = example.vault.activate({ ...account(), credential: { kind: 'new-api', cookies } })
    cookies[0] = 'session=changed'
    await pending
    assert.deepEqual((await example.vault.active())?.credential, { kind: 'new-api', cookies: ['session=original'] })
  })
  it('preserves encrypted bytes and active selection when writing fails', async () => {
    const example = storageFixture()
    await example.vault.activate(account())
    const before = example.content()
    example.setFail(true)
    await assert.rejects(example.vault.activate(account('api-account')), hasCode('STORAGE'))
    assert.equal(example.content(), before)
    example.setFail(false)
    assert.equal((await example.vault.active())?.realmId, 'xm-account')
    await example.vault.activate(account('api-account'))
    assert.equal((await example.vault.active())?.realmId, 'api-account')
  })
  it('does not fall back to plaintext when encryption is unavailable', async () => {
    const example = storageFixture(); example.setAvailable(false)
    await assert.rejects(example.vault.activate(account()), hasCode('STORAGE'))
    assert.equal(example.writes(), 0)
  })
  for (const corrupt of ['not-base64!', 'Zg==', 'a'.repeat(600000)]) {
    it(`does not overwrite corrupt ciphertext of length ${corrupt.length}`, async () => {
      const example = storageFixture(); example.corrupt(corrupt)
      await assert.rejects(example.vault.activate(account()), hasCode('STORAGE'))
      assert.equal(example.content(), corrupt); assert.equal(example.writes(), 0)
    })
  }
  it('rejects duplicate accounts and dangling active pointers on read', async () => {
    for (const document of [{ version: 2, activeId: null, accounts: [account(), account()] },
      { version: 2, activeId: 'unknown', accounts: [account()] }]) {
      const example = storageFixture()
      example.corrupt(Buffer.from(example.storage.encryptString(JSON.stringify(document))).toString('base64'))
      await assert.rejects(example.vault.list(), hasCode('STORAGE'))
    }
  })
  it('does not exceed the saved-account limit or evict an old account', async () => {
    const example = storageFixture()
    for (let i = 1; i <= 16; i += 1) await example.vault.activate(account('xm-account', String(i)))
    await assert.rejects(example.vault.activate(account('api-account')), hasCode('STORAGE'))
    assert.equal((await example.vault.list()).length, 16)
  })
  it('migrates legacy xm records idempotently without overwriting a newer credential', async () => {
    const example = storageFixture()
    const legacy = { origin: 'https://xm.solov.cc', userId: 7, username: 'old', cookies: ['old-cookie'] }
    assert.equal((await example.vault.importLegacy([legacy])), 1)
    assert.equal(await example.vault.active(), null)
    await example.vault.activate(account())
    assert.equal(await example.vault.importLegacy([legacy]), 0)
    assert.equal((await example.vault.active())?.username, 'user-7')
  })
  it('never guesses an origin during legacy migration', () => {
    for (const origin of [undefined, 'https://api.solov.cc', 'https://xm.solov.cc/']) {
      assert.throws(() => migrateLegacySavedAccount({ origin, userId: 7, username: 'old', cookies: ['old'] }), hasCode('INVALID'))
    }
  })
  it('distinguishes sign-out from forgetting an inactive account', async () => {
    const example = storageFixture()
    await example.vault.activate(account()); await example.vault.activate(account('api-account'))
    await assert.rejects(example.vault.forget(account('api-account')), hasCode('BUSY'))
    await example.vault.signOut()
    assert.equal(await example.vault.active(), null)
    assert.equal((await example.vault.list()).length, 1)
    await example.vault.forget(account())
    assert.equal((await example.vault.list()).length, 0)
  })
})

describe('realm switch coordinator', () => {
  it('keeps both accounts and restores the selected realm after restart', async () => {
    const example = workflow()
    await example.coordinator.login('solov', login)
    await example.coordinator.login('solov-api', login)
    await example.coordinator.switchAccount(account())
    assert.equal((await example.vault.list()).length, 2)
    const restarted = createRealmSwitchCoordinator({ ...example, enabledRealms: ['xm-account', 'api-account'],
      quiesce: async () => undefined })
    assert.equal((await restarted.restoreActive()).account?.realmId, 'xm-account')
  })
  it('does not send a password to another backend after a failed login', async () => {
    const example = workflow(); await example.coordinator.login('solov', login); example.failApi()
    await assert.rejects(example.coordinator.login('solov-api', login), hasCode('UNAUTHORIZED'))
    assert.equal(example.coordinator.snapshot().account?.realmId, 'xm-account')
    assert.equal(example.calls.filter((call) => call === 'login:xm-account').length, 1)
  })
  it('does not authenticate a disabled site or silently recover it as xm', async () => {
    const example = workflow(['xm-account'])
    assert.throws(() => example.coordinator.login('solov-api', login), hasCode('DISABLED'))
    await example.vault.activate(account('api-account'))
    await assert.rejects(example.coordinator.restoreActive(), hasCode('DISABLED'))
    assert.ok(!example.calls.some((call) => call.startsWith('login:') || call.startsWith('restore:')))
    assert.equal((await example.vault.active())?.realmId, 'api-account')
  })
  it('rejects concurrent switch requests and operations during switching', async () => {
    const gate = deferred<RealmSavedAccount>()
    const example = workflow(); example.backends[1].authenticate = async () => gate.promise
    const switching = example.coordinator.login('solov-api', login)
    assert.equal(example.coordinator.snapshot().phase, 'switching')
    await assert.rejects(example.coordinator.login('solov', login), hasCode('BUSY'))
    await assert.rejects(example.coordinator.execute(async () => 1), hasCode('BUSY'))
    gate.resolve(account('api-account')); await switching
  })
  it('preserves previous memory and disk state after an activation write failure', async () => {
    const example = workflow(); await example.coordinator.login('solov', login); example.setFail(true)
    await assert.rejects(example.coordinator.login('solov-api', login), hasCode('STORAGE'))
    assert.equal(example.coordinator.snapshot().account?.realmId, 'xm-account')
    example.setFail(false)
    assert.equal((await example.vault.active())?.realmId, 'xm-account')
  })
  it('rejects stale values and stale errors after a switch', async () => {
    for (const fail of [false, true]) {
      const example = workflow(); await example.coordinator.login('solov', login)
      const gate = deferred<number>(); let aborted = false
      const result = example.coordinator.execute(async (_session, signal) => { signal.addEventListener('abort', () => { aborted = true }); return gate.promise })
      await example.coordinator.login('solov-api', login)
      if (fail) gate.reject(new Error('private prior-account message')); else gate.resolve(42)
      await assert.rejects(result, hasCode('STALE')); assert.equal(aborted, true)
    }
  })
  it('requires a final ownership check even after a promise completed', async () => {
    const example = workflow(); await example.coordinator.login('solov', login)
    const result = await example.coordinator.execute(async () => 'old value')
    example.coordinator.assertCurrent(result)
    assert.throws(() => example.coordinator.assertCurrent({ ...result }), hasCode('STALE'))
    await example.coordinator.login('solov', login)
    assert.throws(() => example.coordinator.assertCurrent(result), hasCode('STALE'))
  })
  it('invalidates old result leases even if a switch rolls back', async () => {
    const example = workflow(); await example.coordinator.login('solov', login)
    const result = await example.coordinator.execute(async () => 'old')
    example.failApi(); await assert.rejects(example.coordinator.login('solov-api', login))
    assert.throws(() => example.coordinator.assertCurrent(result), hasCode('STALE'))
  })
  it('rejects candidate identity mismatches before persistence', async () => {
    const example = workflow(); example.backends[1].authenticate = async () => account()
    await assert.rejects(example.coordinator.login('solov-api', login), hasCode('PROTOCOL'))
    assert.equal(example.writes(), 0)
    await example.vault.activate(account('api-account'))
    example.backends[1].restore = async () => account('api-account', '8')
    await assert.rejects(example.coordinator.switchAccount(account('api-account')), hasCode('PROTOCOL'))
    assert.equal((await example.vault.active())?.userId, '7')
  })
  it('does not start authentication when quiescence rejects a running CLI', async () => {
    const example = workflow()
    const coordinator = createRealmSwitchCoordinator({ ...example, enabledRealms: ['xm-account', 'api-account'],
      quiesce: async () => { throw new RealmAccountError('BUSY') } })
    await assert.rejects(coordinator.login('solov', login), hasCode('BUSY'))
    assert.equal(example.calls.length, 0)
  })
  it('ignores a late prepared session after a timeout', async () => {
    const example = workflow(); const gate = deferred<RealmSavedAccount>()
    example.backends[1].authenticate = async () => gate.promise
    const coordinator = createRealmSwitchCoordinator({ ...example, enabledRealms: ['xm-account', 'api-account'],
      quiesce: async () => undefined, prepareTimeoutMs: 20 })
    await assert.rejects(coordinator.login('solov-api', login), hasCode('TIMEOUT'))
    gate.resolve(account('api-account')); await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(await example.vault.active(), null)
    assert.equal(coordinator.snapshot().phase, 'signed-out')
  })
  it('rejects forgetting the current account through the inactive-account action', async () => {
    const example = workflow(); await example.coordinator.login('solov', login)
    await assert.rejects(example.coordinator.forget(account()), hasCode('BUSY'))
    await example.coordinator.signOut()
    assert.equal(example.coordinator.snapshot().phase, 'signed-out')
  })
})

describe('realm capability policy and UI projection', () => {
  it('disallows api registration even when all backend features are advertised', () => {
    const snapshot = buildRealmCapabilities({ realmId: 'api-account', enabled: true, authenticated: true, verified: realmFeatures })
    assert.equal(snapshot.features.registration.reason, 'registration-xm-only')
    assert.equal(realmAccountView(snapshot).canRegisterHere, false)
    assert.throws(() => assertRealmCapability(snapshot, 'registration'), hasCode('UNSUPPORTED'))
  })
  it('hides all unverified account sections instead of showing empty fake data', () => {
    const snapshot = buildRealmCapabilities({ realmId: 'api-account', enabled: true, authenticated: true, verified: ['balance', 'keyRead'] })
    assert.deepEqual(realmAccountView(snapshot).sections, ['balance', 'keys'])
    assert.equal(snapshot.features.billing.reason, 'unverified')
  })
  it('fails closed for every feature of a disabled realm', () => {
    const snapshot = buildRealmCapabilities({ realmId: 'api-account', enabled: false, authenticated: true, verified: realmFeatures })
    assert.ok(Object.values(snapshot.features).every((feature) => !feature.available))
  })
  it('allows xm registration without allowing authenticated data while signed out', () => {
    const snapshot = buildRealmCapabilities({ realmId: 'xm-account', enabled: true, authenticated: false, verified: realmFeatures })
    assert.equal(snapshot.features.registration.available, true)
    assert.equal(snapshot.features.balance.reason, 'sign-in-required')
  })
})

describe('isolated new-api session bridge', () => {
  it('uses an isolated xm client and never installs candidates into the active client', async () => {
    const calls: string[] = []
    let authenticated = false
    const factory = (options: { baseUrl: string }): IsolatedNewApiRealmClient => {
      assert.equal(options.baseUrl, 'https://xm.solov.cc')
      return {
        login: async () => { calls.push('login'); authenticated = true },
        restoreSession: async (saved) => { assert.equal(saved.userId, 7); calls.push('restore'); authenticated = true; return true },
        getSessionState: () => ({ authenticated, account: authenticated ? { userId: 7, username: 'xm' } : null }),
        getPersistableSession: () => authenticated ? { userId: 7, cookies: ['session=cookie'] } : null,
        logout: () => { calls.push('cleanup'); authenticated = false },
      }
    }
    const backend = createNewApiRealmBackend(factory)
    const saved = await backend.authenticate(login, new AbortController().signal)
    assert.equal(authenticated, false); assert.equal(saved.realmId, 'xm-account')
    await backend.restore(saved, new AbortController().signal)
    assert.deepEqual(calls, ['login', 'cleanup', 'restore', 'cleanup'])
  })
})


describe('integrated dual-realm mock workflow', () => {
  it('uses the real api adapter through the vault and coordinator without mixing the xm session', async () => {
    const store = storageFixture()
    const calls: string[] = []
    const api = createSub2ApiAccountClient({ fetchImpl: async (url, init) => {
      calls.push(url)
      assert.equal(new URL(url).origin, 'https://api.solov.cc')
      const data = url.endsWith('/auth/login')
        ? { access_token: 'api-access', refresh_token: 'api-refresh', token_type: 'Bearer',
            user: { id: 7, username: 'api-seven', status: 'active', balance: 9.75 } }
        : { id: 7, username: 'api-seven', status: 'active', balance: 9.75 }
      if (!url.endsWith('/auth/login')) assert.equal(new Headers(init.headers).get('authorization'), 'Bearer api-access')
      return Response.json({ code: 0, data })
    } })
    const xm: RealmSessionBackend = { realmId: 'xm-account', authenticate: async () => account(), restore: async (saved) => saved }
    const coordinator = createRealmSwitchCoordinator({ backends: [xm, api], enabledRealms: ['xm-account', 'api-account'],
      vault: store.vault, quiesce: async () => undefined })
    await coordinator.login('sub2api', login)
    assert.equal(coordinator.snapshot().account?.realmId, 'xm-account')
    assert.equal(calls.length, 0)
    await coordinator.login('solov-api', login)
    const result = await coordinator.execute((session, signal) => api.getBalance(session, signal))
    coordinator.assertCurrent(result)
    assert.deepEqual(result.value, { amount: '9.75', unit: 'sub2api-balance' })
    await coordinator.switchAccount(account())
    assert.throws(() => coordinator.assertCurrent(result), hasCode('STALE'))
    assert.equal((await store.vault.list()).length, 2)
    assert.equal((await store.vault.get(account()))?.credential.kind, 'new-api')
    assert.ok(!JSON.stringify(coordinator.snapshot()).includes('api-access'))
  })
})

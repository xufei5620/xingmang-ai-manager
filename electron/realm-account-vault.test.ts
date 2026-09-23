import { strict as assert } from 'node:assert'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, it } from 'vitest'
import {
  parseRealmSavedAccount, realmAccountSummary, realmForExplicitSite, realmOwnerKey, RealmAccountError,
  type AccountRealmId, type RealmSavedAccount,
} from './realm-account'
import { createRealmAccountVault, migrateLegacySavedAccount, realmStorageScope, type RealmVaultStorage } from './realm-account-vault'

function account(realmId: AccountRealmId = 'xm-account', userId = '7'): RealmSavedAccount {
  return parseRealmSavedAccount({ version: 2, realmId, userId, username: `user-${userId}`,
    origin: realmId === 'xm-account' ? 'https://xm.solov.cc' : 'https://api.solov.cc',
    credential: realmId === 'xm-account' ? { kind: 'new-api', cookies: [`session=private-${userId}`] }
      : { kind: 'sub2api', accessToken: `access-${userId}`, refreshToken: `refresh-${userId}`, expiresAt: null } })
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
    await assert.rejects(example.vault.activate(account('api-account')), hasCode('ACCOUNT_LIMIT'))
    assert.equal((await example.vault.list()).length, 16)
    // 已经存着的账号再登录一次不算新增，满了也照样能登。
    await example.vault.activate(account('xm-account', '3'))
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

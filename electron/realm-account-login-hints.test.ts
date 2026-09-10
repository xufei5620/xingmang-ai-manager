import { describe, expect, it } from 'vitest'
import { parseRealmSavedAccount } from './realm-account'
import { createRealmAccountVault, normalizeRealmLoginIdentifier, type RealmVaultStorage } from './realm-account-vault'

function account(api = false) {
  return parseRealmSavedAccount({ version: 2, realmId: api ? 'api-account' : 'xm-account', userId: '7',
    origin: api ? 'https://api.solov.cc' : 'https://xm.solov.cc', username: 'profile-name',
    credential: api ? { kind: 'sub2api', accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresAt: null }
      : { kind: 'new-api', cookies: ['session=test-cookie'] } })
}
function fixture() {
  let content: string | null = null
  let fail = false
  const storage: RealmVaultStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text), decryptString: (bytes) => Buffer.from(bytes).toString('utf8'),
    read: async () => content,
    writeAtomic: async (next) => { if (fail) throw new Error('disk busy'); content = next },
  }
  return { vault: createRealmAccountVault(storage), storage, fail: (value: boolean) => { fail = value },
    content: () => content,
    document: () => JSON.parse(Buffer.from(content!, 'base64').toString('utf8')) as { loginHints?: unknown[] },
    setDocument: (value: unknown) => { content = Buffer.from(JSON.stringify(value)).toString('base64') } }
}

describe('encrypted realm login routing hints', () => {
  it('returns no preference for unknown identifiers and matches only the active profile in old vaults', async () => {
    const f = fixture()
    expect(await f.vault.preferredLoginSite('same@example.test')).toBeNull()
    await f.vault.activate(account())
    expect(await f.vault.preferredLoginSite('profile-name')).toBe('solov')
    expect(await f.vault.preferredLoginSite('other-profile')).toBeNull()
    expect(await f.vault.latestLoginHint()).toBeNull()
    expect(f.document().loginHints).toBeUndefined()
  })
  it('records the entered identifier and normalizes email aliases without guessing from the profile', async () => {
    const f = fixture()
    await f.vault.activate(account(true), '  Same@Example.TEST  ')
    expect(await f.vault.preferredLoginSite('same@example.test')).toBe('solov-api')
    expect(await f.vault.preferredLoginSite('SAME@EXAMPLE.TEST')).toBe('solov-api')
    expect(await f.vault.preferredLoginSite('profile-name')).toBe('solov-api')
    expect(f.document().loginHints).toEqual([{ identifier: 'same@example.test', realmId: 'api-account', userId: '7' }])
    expect(JSON.stringify(f.document().loginHints)).not.toMatch(/password|credential|accessToken|refreshToken|test-access|test-cookie/)
  })
  it('preserves case for ordinary usernames', async () => {
    const f = fixture()
    await f.vault.activate(account(), '  Alice  ')
    expect(await f.vault.preferredLoginSite('Alice')).toBe('solov')
    expect(await f.vault.preferredLoginSite('alice')).toBeNull()
    expect(normalizeRealmLoginIdentifier('user@not-a-domain')).toBe('user@not-a-domain')
  })
  it('atomically replaces the preference only when a different account activation succeeds', async () => {
    const f = fixture()
    await f.vault.activate(account(), 'same@example.test')
    const before = f.content()
    f.fail(true)
    await expect(f.vault.activate(account(true), 'same@example.test')).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.content()).toBe(before)
    expect(await f.vault.preferredLoginSite('same@example.test')).toBe('solov')
    expect((await f.vault.active())?.realmId).toBe('xm-account')
    f.fail(false)
    await f.vault.activate(account(true), 'same@example.test')
    expect(await f.vault.preferredLoginSite('same@example.test')).toBe('solov-api')
    expect((await f.vault.list())).toHaveLength(2)
  })
  it('serializes competing successful activations so hint and active pointer agree', async () => {
    const f = fixture()
    await Promise.all([f.vault.activate(account(), 'same@example.test'), f.vault.activate(account(true), 'same@example.test')])
    expect((await f.vault.active())?.realmId).toBe('api-account')
    expect(await f.vault.preferredLoginSite('same@example.test')).toBe('solov-api')
    expect(f.document().loginHints).toHaveLength(1)
  })
  it('keeps routing preferences after logout or forgetting without retaining credentials', async () => {
    const f = fixture()
    await f.vault.activate(account(), 'xm@example.test')
    await f.vault.activate(account(true), 'api@example.test')
    await f.vault.forget(account())
    await f.vault.signOut()
    const restarted = createRealmAccountVault(f.storage)
    expect(await restarted.active()).toBeNull()
    expect(await restarted.list()).toEqual([])
    expect(await restarted.preferredLoginSite('xm@example.test')).toBe('solov')
    expect(await restarted.preferredLoginSite('api@example.test')).toBe('solov-api')
    expect(Buffer.from(f.content()!, 'base64').toString('utf8')).not.toMatch(/test-access-token|test-refresh-token|test-cookie/)
  })
  it('does not alter preferences when restoring or silently refreshing a saved session', async () => {
    const f = fixture()
    await f.vault.activate(account(true), 'same@example.test')
    await f.vault.activate(account())
    await f.vault.updateSession(account())
    expect(await f.vault.preferredLoginSite('same@example.test')).toBe('solov-api')
  })
  it('returns only the latest successful identifier and realm for remembered-login routing', async () => {
    const f = fixture()
    await f.vault.activate(account(), 'First@Example.TEST')
    await f.vault.activate(account(true), 'Second@example.test')
    await f.vault.preferredLoginSite('first@example.test')
    await f.vault.signOut()
    expect(await f.vault.latestLoginHint()).toEqual({ identifier: 'second@example.test', realmId: 'api-account' })
    await f.vault.activate(account(), 'First@example.test')
    expect(await f.vault.latestLoginHint()).toEqual({ identifier: 'first@example.test', realmId: 'xm-account' })
  })
  it('uses a matching legacy active email without guessing inactive profiles or unrelated input', async () => {
    const f = fixture()
    await f.vault.activate({ ...account(), username: 'older@example.test' })
    await f.vault.activate({ ...account(true), username: 'Same@Example.TEST' })
    expect(await f.vault.preferredLoginSite('same@example.test')).toBe('solov-api')
    expect(await f.vault.preferredLoginSite('older@example.test')).toBeNull()
    expect(await f.vault.preferredLoginSite('unrelated@example.test')).toBeNull()
  })
  it('bounds hints at 64 and retains the most recent successful uses', async () => {
    const f = fixture()
    for (let index = 0; index < 64; index++) await f.vault.activate(account(), `user-${index}`)
    await f.vault.activate(account(true), 'user-0')
    await f.vault.activate(account(), 'user-64')
    expect(f.document().loginHints).toHaveLength(64)
    expect(await f.vault.preferredLoginSite('user-0')).toBe('solov-api')
    expect(await f.vault.preferredLoginSite('user-1')).toBeNull()
    expect(await f.vault.preferredLoginSite('user-64')).toBe('solov')
    expect(await f.vault.list()).toHaveLength(2)
  })
  for (const value of [null, '', '   ', 'a\nb', 'a\0b', 'x'.repeat(257), { identifier: 'a' }]) {
    it(`rejects invalid routing identifiers of type ${typeof value}`, () => {
      const f = fixture()
      expect(() => normalizeRealmLoginIdentifier(value)).toThrow()
      expect(() => f.vault.activate(account(), value as string)).toThrow()
      expect(f.content()).toBeNull()
    })
  }
  for (const hint of [
    { identifier: 'same@example.test', realmId: 'unknown', userId: '7' },
    { identifier: 'same@example.test', realmId: 'api-account', userId: '../7' },
    { identifier: 'Same@Example.TEST', realmId: 'api-account', userId: '7' },
    { identifier: 'same@example.test', realmId: 'api-account', userId: '7', password: 'unexpected' },
  ]) it('rejects malformed persisted hints without replacing the encrypted document', async () => {
    const f = fixture()
    f.setDocument({ version: 2, activeId: null, accounts: [], loginHints: [hint] })
    const before = f.content()
    await expect(f.vault.preferredLoginSite('same@example.test')).rejects.toMatchObject({ code: 'STORAGE' })
    await expect(f.vault.activate(account())).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.content()).toBe(before)
  })
  it('rejects duplicate and oversized persisted hint lists', async () => {
    const hint = { identifier: 'same@example.test', realmId: 'api-account', userId: '7' }
    for (const loginHints of [[hint, hint], Array.from({ length: 65 }, (_, index) => ({ ...hint, identifier: `user-${index}` }))]) {
      const f = fixture()
      f.setDocument({ version: 2, activeId: null, accounts: [], loginHints })
      await expect(f.vault.list()).rejects.toMatchObject({ code: 'STORAGE' })
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createRealmAccountService, type RealmAccountServiceOptions, type RealmAccountSiteId } from './realm-account-service'
import { createRealmAccountVault, type RealmVaultStorage } from './realm-account-vault'
import { parseRealmSavedAccount, RealmAccountError, type RealmSavedAccount } from './realm-account'
import type { RelayBackendCapabilities, RelayBackendClient } from './relay-backend'
import type { NewApiLoginInput, NewApiSessionState } from './new-api-client'
import { NewApiLoginRejectedError } from './new-api-client'
import { savedAccountId } from './saved-accounts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function saved(siteId: RealmAccountSiteId = 'solov', userId = '7', token = 'test-original'): RealmSavedAccount {
  return parseRealmSavedAccount({ version: 2, realmId: siteId === 'solov' ? 'xm-account' : 'api-account',
    userId, username: 'same@example.test', origin: siteId === 'solov' ? 'https://xm.solov.cc' : 'https://api.solov.cc',
    credential: siteId === 'solov' ? { kind: 'new-api', cookies: [`session=${token}`] }
      : { kind: 'sub2api', accessToken: token, refreshToken: 'test-refresh', expiresAt: null } })
}
function vaultFixture() {
  let content: string | null = null
  let fail = false
  let available = true
  // Crypto correctness is covered by realm-account-workflow.test.ts; this
  // fixture exposes the durable document so failure atomicity is observable.
  const storage: RealmVaultStorage = {
    isEncryptionAvailable: () => available, encryptString: (text) => Buffer.from(text),
    decryptString: (value) => Buffer.from(value).toString('utf8'), read: async () => content,
    writeAtomic: async (value) => { if (fail) throw new Error('disk failure'); content = value },
  }
  return { vault: createRealmAccountVault(storage), content: () => content,
    fail: (value: boolean) => { fail = value }, available: (value: boolean) => { available = value } }
}
const capabilities: RelayBackendCapabilities = {
  supportsRegistration: true, supportsPasswordReset: true, supportsKeyManagement: true, supportsUsage: true,
  supportsBilling: true, supportsSubscriptions: true, supportsProfileUpdate: true, supportsSessionManagement: true,
  supportsAutoKeyProvision: true, supportsAccountSession: true,
}
function fixture(overrides: Partial<RealmAccountServiceOptions> = {}) {
  const disk = vaultFixture()
  let authenticationPolicy: (siteId: RealmAccountSiteId, input: NewApiLoginInput) => void = () => undefined
  const clients: Array<{ siteId: RealmAccountSiteId; client: RelayBackendClient; restore: ReturnType<typeof vi.fn>;
    emit(value: RealmSavedAccount | null): void; failLogin: boolean; restoreError: Error | null;
    restoreValid: boolean; balance: () => Promise<unknown> }> = []
  const createClient: RealmAccountServiceOptions['createClient'] = (siteId, callback) => {
    let current: RealmSavedAccount | null = null
    const state = (): NewApiSessionState => ({ authenticated: current !== null,
      account: current ? { userId: Number(current.userId), username: current.username, group: null, role: null, quota: 100, usedQuota: 0 } : null })
    const emit = (value: RealmSavedAccount | null) => { current = value; callback(value) }
    const client = {
      capabilities, getSessionState: state, getBalance: () => item.balance(),
      getStatus: vi.fn(async () => ({ siteId })), register: vi.fn(async () => undefined),
      getLegalDocument: vi.fn(async () => ({ siteId })),
      changePassword: vi.fn(async () => { emit(null); return { changed: true } }),
      revokeLoginSession: vi.fn(async () => { emit(null); return { revoked: true, current: true } }),
      login: vi.fn(async (input: NewApiLoginInput) => {
        authenticationPolicy(siteId, input)
        if (item.failLogin || input.password === 'bad') throw new RealmAccountError('UNAUTHORIZED')
        emit(saved(siteId, input.username === '8' ? '8' : '7'))
        return { account: state().account!, accessExpiresAt: null }
      }),
      logout: vi.fn(() => emit(null)),
      getPersistableSession: () => current?.credential.kind === 'new-api'
        ? { userId: Number(current.userId), cookies: [...current.credential.cookies] } : null,
    } as unknown as RelayBackendClient
    const restore = vi.fn(async (value: RealmSavedAccount) => {
      if (item.restoreError) throw item.restoreError
      if (!item.restoreValid) return false
      emit(saved(siteId, value.userId, 'test-rotated-once'))
      return true
    })
    const item = { siteId, client, restore, emit, failLogin: false, restoreError: null as Error | null,
      restoreValid: true, balance: async (): Promise<unknown> => ({ quota: 100 }) }
    clients.push(item)
    return { client, restore, getSavedAccount: () => current }
  }
  const quiesce = vi.fn(async (): Promise<void> => undefined)
  const options = { ...disk, createClient, quiesce, ...overrides }
  const service = createRealmAccountService(options)
  return { ...disk, options, clients, service, quiesce,
    authenticationPolicy: (policy: typeof authenticationPolicy) => { authenticationPolicy = policy } }
}
const login = { username: 'same@example.test', password: 'test-password', siteId: 'solov' as const }

describe('realm account service', () => {
  it('promotes the real login client without a second refresh or restore', async () => {
    const f = fixture()
    const proxy = f.service.client
    const result = await f.service.login(login)
    expect(result.siteId).toBe('solov')
    expect(result.realmId).toBe('xm-account')
    expect(proxy).toBe(f.service.client)
    expect(f.clients[1].restore).not.toHaveBeenCalled()
    expect(f.clients[1].client.logout).not.toHaveBeenCalled()
    expect((await f.vault.active())?.credential).toEqual(saved().credential)
    expect(proxy.getSessionState().account?.userId).toBe(7)
  })
  it('keeps equal emails and user ids separate across the two backends', async () => {
    const f = fixture()
    await f.service.login(login)
    await f.service.login({ ...login, siteId: 'solov-api' })
    const summaries = await f.service.listSavedAccounts()
    expect(summaries.map((entry) => entry.id)).toEqual([
      savedAccountId('https://xm.solov.cc', 7), savedAccountId('https://api.solov.cc', 7),
    ])
    expect(JSON.stringify(summaries)).not.toMatch(/credential|cookie|accessToken|test-original/)
    expect(f.service.client.getActiveSiteId?.()).toBe('solov-api')
    const restored = await f.service.switchSavedAccount(summaries[0].id)
    expect(restored.siteId).toBe('solov')
    expect(f.clients[3].restore).toHaveBeenCalledTimes(1)
    expect((await f.vault.active())?.credential).toEqual(saved('solov', '7', 'test-rotated-once').credential)
  })
  it('leaves the active client and bytes unchanged after a failed commit', async () => {
    const f = fixture()
    await f.service.login(login)
    const original = f.content()
    const client = f.clients[1].client
    f.fail(true)
    await expect(f.service.login({ ...login, siteId: 'solov-api' })).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.content()).toBe(original)
    expect(f.service.getSiteId()).toBe('solov')
    expect(client.logout).not.toHaveBeenCalled()
    expect(f.clients[2].client.logout).toHaveBeenCalledTimes(1)
    f.fail(false)
    await expect(f.service.client.getBalance()).resolves.toEqual({ quota: 100 })
  })
  it('never sends credentials to a fallback backend after a login failure', async () => {
    const f = fixture()
    await f.service.login(login)
    await expect(f.service.login({ ...login, siteId: 'solov-api', password: 'bad' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(f.clients.map((entry) => entry.siteId)).toEqual(['solov', 'solov', 'solov-api'])
    expect(f.service.getSiteId()).toBe('solov')
  })
  it('waits for real quiescence and rejects new business or concurrent transitions', async () => {
    const gate = deferred<void>()
    const f = fixture({ quiesce: () => gate.promise })
    const pending = f.service.login(login)
    expect(() => f.service.assertReady()).toThrow(RealmAccountError)
    await expect(f.service.client.getBalance()).rejects.toMatchObject({ code: 'BUSY' })
    await expect(f.service.logout()).rejects.toMatchObject({ code: 'BUSY' })
    expect(f.clients).toHaveLength(1)
    expect(f.service.client.getSessionState().authenticated).toBe(false)
    gate.resolve()
    await pending
    expect(f.clients).toHaveLength(2)
    expect(() => f.service.assertReady()).not.toThrow()
  })
  it('does not prepare a candidate after quiescence has timed out', async () => {
    const gate = deferred<void>()
    const f = fixture({ quiesce: () => gate.promise, prepareTimeoutMs: 10 })
    await expect(f.service.login(login)).rejects.toMatchObject({ code: 'TIMEOUT' })
    gate.resolve()
    await Promise.resolve()
    expect(f.clients).toHaveLength(1)
    expect(f.service.client.getSessionState().authenticated).toBe(false)
    expect(await f.vault.active()).toBeNull()
  })
  for (const reject of [false, true]) it(`rejects stale ${reject ? 'errors' : 'values'} after a backend switch`, async () => {
    const f = fixture()
    await f.service.login(login)
    const gate = deferred<unknown>()
    f.clients[1].balance = () => gate.promise
    const pending = f.service.client.getBalance()
    await f.service.login({ ...login, siteId: 'solov-api' })
    if (reject) gate.reject(new Error('old private account error'))
    else gate.resolve({ quota: 1 })
    await expect(pending).rejects.toMatchObject({ code: 'STALE' })
  })
  it('increments the global revision for the same account login and failed attempts', async () => {
    const f = fixture()
    await f.service.login(login)
    const before = f.service.client.getSessionRevision!()
    const gate = deferred<unknown>()
    f.clients[1].balance = () => gate.promise
    const pending = f.service.client.getBalance()
    await f.service.login(login)
    expect(f.service.client.getSessionRevision!()).toBeGreaterThan(before)
    gate.resolve({ quota: 1 })
    await expect(pending).rejects.toMatchObject({ code: 'STALE' })
    const next = f.service.client.getSessionRevision!()
    await expect(f.service.login({ ...login, password: 'bad' })).rejects.toThrow()
    expect(f.service.client.getSessionRevision!()).toBeGreaterThan(next)
  })
  it('binds retained proxy functions to the client active when invoked', async () => {
    const f = fixture()
    const balance = f.service.client.getBalance
    await f.service.login({ ...login, siteId: 'solov-api' })
    f.clients[1].balance = async () => ({ quota: 8 })
    await expect(balance()).resolves.toEqual({ quota: 8 })
  })
  it('updates refresh credentials without activating a detached account', async () => {
    const f = fixture()
    await f.service.login(login)
    const originalRevision = f.service.client.getSessionRevision!()
    f.clients[1].emit(saved('solov', '7', 'test-new-cookie'))
    await f.service.client.getBalance()
    expect(f.service.client.getSessionRevision!()).toBe(originalRevision)
    expect((await f.vault.active())?.credential).toEqual(saved('solov', '7', 'test-new-cookie').credential)
    await f.service.login({ ...login, siteId: 'solov-api' })
    f.clients[1].emit(saved('solov', '7', 'test-late-cookie'))
    await f.service.client.getBalance()
    expect((await f.vault.active())?.realmId).toBe('api-account')
    expect((await f.vault.get(saved()))?.credential).toEqual(saved('solov', '7', 'test-new-cookie').credential)
  })
  it('surfaces refresh persistence failures and allows a later recovery login', async () => {
    const f = fixture()
    await f.service.login(login)
    f.fail(true)
    f.clients[1].balance = async () => { f.clients[1].emit(saved('solov', '7', 'test-new-cookie')); return { quota: 10 } }
    await expect(f.service.client.getBalance()).rejects.toMatchObject({ code: 'STORAGE' })
    f.fail(false)
    await expect(f.service.login(login)).resolves.toMatchObject({ siteId: 'solov' })
  })
  it('retains a cookie rotated while quiescing even when the candidate login fails', async () => {
    const f = fixture()
    await f.service.login(login)
    const gate = deferred<void>()
    f.quiesce.mockImplementationOnce(() => gate.promise)
    const pending = f.service.login({ ...login, siteId: 'solov-api', password: 'bad' })
    f.clients[1].emit(saved('solov', '7', 'test-during-quiescence'))
    gate.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect((await f.vault.active())?.credential).toEqual(saved('solov', '7', 'test-during-quiescence').credential)
  })
  it('does not overwrite a same-owner candidate with a late refresh during its commit', async () => {
    const f = fixture()
    await f.service.login(login)
    f.options.vault = { ...f.vault, activate: async (candidate) => {
      const pending = f.vault.activate(candidate)
      f.clients[1].emit(saved('solov', '7', 'test-late-old-cookie'))
      await pending
    } }
    await f.service.login(login)
    expect((await f.vault.active())?.credential).toEqual(saved().credential)
    expect(f.service.client.getSessionState().authenticated).toBe(true)
  })
  it('does not let change-listener errors turn a committed login into failure', async () => {
    const f = fixture({ onChanged: () => { throw new Error('window already destroyed') } })
    await expect(f.service.login(login)).resolves.toMatchObject({ siteId: 'solov' })
    expect((await f.vault.active())?.userId).toBe('7')
    expect(f.service.client.getSessionState().authenticated).toBe(true)
  })
  it('notifies committed identity changes only after business operations are ready', async () => {
    const observed: boolean[] = []
    let assertReady = () => undefined as void
    const f = fixture({ onChanged: () => {
      try { assertReady(); observed.push(true) } catch { observed.push(false) }
    } })
    assertReady = f.service.assertReady
    await f.service.login(login)
    await f.service.login({ ...login, siteId: 'solov-api' })
    await f.service.logout()
    expect(observed).toEqual([true, true, true])
  })
  it('persists logout before clearing the active client and never restores it again', async () => {
    const f = fixture()
    await f.service.login(login)
    f.fail(true)
    await expect(f.service.logout()).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.service.client.getSessionState().authenticated).toBe(true)
    f.fail(false)
    await f.service.logout()
    expect(f.service.client.getSessionState().authenticated).toBe(false)
    expect(await f.vault.active()).toBeNull()
    const restarted = createRealmAccountService(f.options)
    expect(await restarted.restoreActive()).toBe(false)
    expect(await restarted.listSavedAccounts()).toEqual([])
  })
  it('does not fall back to plaintext or temporary logged-in state without encryption', async () => {
    const f = fixture()
    f.available(false)
    await expect(f.service.login(login)).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.service.client.getSessionState().authenticated).toBe(false)
    expect(f.content()).toBeNull()
    expect(f.clients).toHaveLength(1)
  })
  it('keeps public registration on new-api while a sub2api account is active', async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: 'solov-api' })
    await f.service.client.register({ username: 'new', email: 'new@example.test', password: 'test-password' })
    expect(f.clients[2].siteId).toBe('solov')
    expect(f.clients[2].client.register).toHaveBeenCalledOnce()
    expect(f.clients[1].client.register).not.toHaveBeenCalled()
    expect(f.service.getSiteId()).toBe('solov-api')
  })
  it('preserves saved sessions on network restore errors and removes explicit invalid sessions', async () => {
    for (const invalid of [false, true]) {
      const f = fixture()
      await f.vault.activate(saved('solov-api'))
      const restarted = createRealmAccountService({ ...f.options, createClient: (siteId, callback) => {
        const result = f.options.createClient(siteId, callback)
        const item = f.clients[f.clients.length - 1]
        item.restoreValid = !invalid
        item.restoreError = invalid ? null : new RealmAccountError('NETWORK')
        return result
      } })
      if (invalid) {
        await expect(restarted.restoreActive()).resolves.toBe(false)
        expect(await f.vault.active()).toBeNull()
      } else {
        await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'NETWORK' })
        expect((await f.vault.active())?.realmId).toBe('api-account')
      }
      expect(restarted.client.getSessionState().authenticated).toBe(false)
    }
  })
  it('returns success for a password change that intentionally expires its own session', async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: 'solov-api' })
    await expect(f.service.client.changePassword({ originalPassword: 'test-old', newPassword: 'test-new' })).resolves.toEqual({ changed: true })
    expect(f.service.client.getSessionState().authenticated).toBe(false)
    expect(await f.vault.active()).toBeNull()
  })
  it('still rejects a password-change result after an external switch', async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: 'solov-api' })
    const gate = deferred<{ changed: true }>()
    f.clients[1].client.changePassword = async () => gate.promise
    const pending = f.service.client.changePassword({ originalPassword: 'test-old', newPassword: 'test-new' })
    await f.service.login(login)
    gate.resolve({ changed: true })
    await expect(pending).rejects.toMatchObject({ code: 'STALE' })
  })
  it('returns success when new-api revokes the current device session', async () => {
    const f = fixture()
    await f.service.login(login)
    await expect(f.service.client.revokeLoginSession('test-current-session')).resolves.toEqual({ revoked: true, current: true })
    expect(f.service.client.getSessionState().authenticated).toBe(false)
    expect(await f.vault.active()).toBeNull()
  })
})

describe('realm vault migration and refresh', () => {
  it('atomically migrates legacy accounts and the freshest active cookie only once', async () => {
    const origin = 'https://xm.solov.cc'
    const summaries = [7, 8].map((userId) => ({ id: savedAccountId(origin, userId), origin, userId,
      username: `legacy-${userId}`, updatedAt: '2026-09-01T00:00:00.000Z' }))
    const legacy = { list: vi.fn(async () => summaries),
      getSession: async (id: string) => ({ userId: id === summaries[0].id ? 7 : 8, cookies: ['old-cookie'] }),
      readActive: async () => ({ userId: 7, cookies: ['new-cookie'] }) }
    const f = fixture({ legacy })
    await f.service.migrateLegacy()
    expect((await f.vault.active())?.credential).toEqual({ kind: 'new-api', cookies: ['new-cookie'] })
    await f.service.removeSavedAccount(summaries[1].id)
    expect(await f.service.restoreActive()).toBe(true)
    await f.service.logout()
    const restarted = createRealmAccountService(f.options)
    expect(await restarted.restoreActive()).toBe(false)
    expect(await restarted.listSavedAccounts()).toEqual([])
    expect(legacy.list).toHaveBeenCalledTimes(1)
  })
  it('retries a failed migration without writing a success marker or losing legacy data', async () => {
    const f = fixture()
    f.fail(true)
    await expect(f.service.migrateLegacy()).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.content()).toBeNull()
    f.fail(false)
    await f.service.migrateLegacy()
    expect(await f.vault.hasMigratedLegacy()).toBe(true)
  })
  it('updates an inactive record in place and does not resurrect forgotten sessions', async () => {
    const f = vaultFixture()
    await f.vault.activate(saved())
    await f.vault.activate(saved('solov-api'))
    await f.vault.updateSession(saved('solov', '7', 'test-rotated'))
    expect((await f.vault.active())?.realmId).toBe('api-account')
    await f.vault.forget(saved())
    await f.vault.updateSession(saved('solov', '7', 'test-late'))
    expect(await f.vault.get(saved())).toBeNull()
    await f.vault.importLegacy([{ origin: 'https://xm.solov.cc', userId: 7, username: 'legacy', cookies: ['old'] }])
    expect(await f.vault.get(saved())).toBeNull()
  })
  it('does not let a queued expiration for the old owner sign out the newly committed owner', async () => {
    const f = vaultFixture()
    await f.vault.activate(saved())
    await Promise.all([f.vault.activate(saved('solov-api')), f.vault.signOut(saved())])
    expect((await f.vault.active())?.realmId).toBe('api-account')
    expect(await f.vault.get(saved())).toBeNull()
  })
})


describe('automatic account discovery', () => {
  const automatic = { username: login.username, password: login.password }
  it('uses the primary account on first login without probing or provisioning the other account', async () => {
    const f = fixture()
    const result = await f.service.login(automatic)
    expect(result.siteId).toBe('solov')
    expect(f.clients.map((entry) => entry.siteId)).toEqual(['solov', 'solov'])
    expect(await f.vault.preferredLoginSite(automatic.username)).toBe('solov')
  })
  it('tries the second account system only after definitive password rejection', async () => {
    const f = fixture()
    f.authenticationPolicy((siteId) => { if (siteId === 'solov') throw new NewApiLoginRejectedError() })
    expect((await f.service.login(automatic)).siteId).toBe('solov-api')
    expect(f.clients.map((entry) => entry.siteId)).toEqual(['solov', 'solov', 'solov-api'])
    expect(f.clients[1].client.logout).toHaveBeenCalled()
    expect(await f.vault.preferredLoginSite(automatic.username)).toBe('solov-api')
  })
  it('keeps the remembered account preferred even when the same email and password work on both', async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: 'solov-api' })
    await f.service.logout()
    const restarted = createRealmAccountService(f.options)
    const before = f.clients.length
    expect((await restarted.login(automatic)).siteId).toBe('solov-api')
    expect(f.clients.slice(before).map((entry) => entry.siteId)).toEqual(['solov-api'])
  })
  for (const code of ['NETWORK', 'TIMEOUT', 'TWO_FACTOR_REQUIRED', 'PROTOCOL', 'UNAUTHORIZED'] as const) {
    it(`does not interpret ${code} as a password rejection or replace the current account`, async () => {
      const f = fixture()
      await f.service.login(login)
      const original = f.content()
      f.authenticationPolicy(() => { throw new RealmAccountError(code) })
      const before = f.clients.length
      await expect(f.service.login(automatic)).rejects.toMatchObject({ code })
      expect(f.clients.length - before).toBe(1)
      expect(f.content()).toBe(original)
      expect(f.service.client.getSessionState().authenticated).toBe(true)
    })
  }
  it('does not fall back after a successful login whose vault commit failed', async () => {
    const f = fixture()
    f.fail(true)
    await expect(f.service.login(automatic)).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.clients.every((entry) => entry.siteId === 'solov')).toBe(true)
    expect(f.service.client.getSessionState().authenticated).toBe(false)
    expect(f.content()).toBeNull()
  })
  it('does not send a non-email username to the email-only backend', async () => {
    const f = fixture()
    f.authenticationPolicy(() => { throw new NewApiLoginRejectedError() })
    await expect(f.service.login({ ...automatic, username: 'short-user' })).rejects.toMatchObject({ code: 'LOGIN_REJECTED' })
    expect(f.clients.map((entry) => entry.siteId)).toEqual(['solov', 'solov'])
  })
  it('leaves both the active account and its last successful binding unchanged when both reject credentials', async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: 'solov-api' })
    const original = f.content()
    f.authenticationPolicy((siteId) => { throw siteId === 'solov' ? new NewApiLoginRejectedError() : new RealmAccountError('LOGIN_REJECTED') })
    await expect(f.service.login(automatic)).rejects.toMatchObject({ code: 'LOGIN_REJECTED' })
    expect(f.content()).toBe(original)
    expect(f.service.getSiteId()).toBe('solov-api')
  })
})

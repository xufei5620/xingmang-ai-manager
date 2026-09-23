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
  let backup: string | null = null
  let fail = false
  let available = true
  // Crypto correctness is covered by realm-account-vault.test.ts; this
  // fixture exposes the durable document so failure atomicity is observable.
  const storage: RealmVaultStorage = {
    isEncryptionAvailable: () => available, encryptString: (text) => Buffer.from(text),
    decryptString: (value) => {
      const plaintext = Buffer.from(value).toString('utf8')
      if (plaintext === 'test-unreadable-ciphertext') throw new Error('authentication tag mismatch')
      return plaintext
    }, read: async () => content,
    writeAtomic: async (value) => { if (fail) throw new Error('disk failure'); content = value },
    recoverAtomic: async (expected, replacement) => {
      if (fail || content !== expected) throw new Error('recovery failed')
      backup = content
      content = replacement
    },
  }
  return { vault: createRealmAccountVault(storage), content: () => content, backup: () => backup,
    corrupt: () => { content = Buffer.from('test-unreadable-ciphertext').toString('base64') },
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
  let restoredIdentity: (siteId: RealmAccountSiteId, value: RealmSavedAccount) => RealmSavedAccount
    = (siteId, value) => saved(siteId, value.userId, 'test-rotated-once')
  const clients: Array<{
    siteId: RealmAccountSiteId
    client: RelayBackendClient
    restore: ReturnType<typeof vi.fn>
    emit(value: RealmSavedAccount | null): void
    failLogin: boolean
    restoreError: Error | null
    restoreValid: boolean
    balance: () => Promise<unknown>
  }> = []
  const createClient: RealmAccountServiceOptions['createClient'] = (siteId, callback) => {
    let current: RealmSavedAccount | null = null
    const state = (): NewApiSessionState => ({ authenticated: current !== null,
      account: current ? { userId: Number(current.userId), username: current.username, group: null, role: null, quota: 100, usedQuota: 0 } : null })
    const emit = (value: RealmSavedAccount | null) => { current = value; callback(value) }
    const client = {
      capabilities, getSessionState: state, getBalance: () => item.balance(),
      getStatus: vi.fn(async () => ({ siteId })), register: vi.fn(async () => undefined),
      sendPasswordResetEmail: vi.fn(async () => { if (siteId === 'solov-api') throw new RealmAccountError('UNSUPPORTED') }),
      resetPassword: vi.fn(async () => { if (siteId === 'solov-api') throw new RealmAccountError('UNSUPPORTED'); return { newPassword: 'test-new-password' } }),
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
      emit(restoredIdentity(siteId, value))
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
    authenticationPolicy: (policy: typeof authenticationPolicy) => { authenticationPolicy = policy },
    restoredIdentity: (policy: typeof restoredIdentity) => { restoredIdentity = policy } }
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
  for (const siteId of ['solov', 'solov-api'] as const) it(`never falls back after explicit ${siteId} password rejection`, async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: siteId === 'solov' ? 'solov-api' : 'solov' })
    const original = f.content()
    const before = f.clients.length
    f.authenticationPolicy(() => { throw new NewApiLoginRejectedError() })
    await expect(f.service.login({ ...login, siteId })).rejects.toBeInstanceOf(NewApiLoginRejectedError)
    expect(f.clients.slice(before).map((entry) => entry.siteId)).toEqual([siteId])
    expect(f.content()).toBe(original)
  })
  it('keeps an existing login during an explicitly selected account 2FA challenge', async () => {
    const f = fixture()
    await f.service.login(login)
    const original = f.content()
    f.authenticationPolicy(() => { throw new RealmAccountError('TWO_FACTOR_REQUIRED') })
    await expect(f.service.login({ ...login, siteId: 'solov-api' })).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED' })
    expect(f.content()).toBe(original)
    expect(f.service.getSiteId()).toBe('solov')
    expect(f.clients[1].client.logout).not.toHaveBeenCalled()
    expect(f.clients[2].client.logout).toHaveBeenCalledOnce()
  })
  it('does not silently route historical account recovery to the primary account', async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: 'solov-api' })
    const original = f.content()
    const before = f.clients.length
    await expect(f.service.client.sendPasswordResetEmail(login.username)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(f.service.client.resetPassword({ email: login.username, token: 'test-reset' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(f.clients).toHaveLength(before)
    expect(f.content()).toBe(original)
    await expect(f.service.getPublicClient('solov').sendPasswordResetEmail(login.username)).resolves.toBeUndefined()
    expect(f.clients.at(-1)!.siteId).toBe('solov')
    expect(f.service.getSiteId()).toBe('solov-api')
    expect(f.content()).toBe(original)
  })
  it('waits for real quiescence and rejects new business or concurrent transitions', async () => {
    const gate = deferred<void>()
    const f = fixture({ quiesce: () => gate.promise })
    const pending = f.service.login(login)
    expect(() => f.service.assertReady()).toThrow(RealmAccountError)
    await expect(f.service.client.getBalance()).rejects.toMatchObject({ code: 'BUSY' })
    await expect(f.service.logout()).rejects.toMatchObject({ code: 'BUSY' })
    await expect(f.service.login({ ...login, siteId: 'solov-api' })).rejects.toMatchObject({ code: 'BUSY' })
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
  it('names the account being restored only while the startup restore is in flight', async () => {
    const f = fixture()
    await f.vault.activate(saved('solov-api', '42'))
    const gate = deferred<void>()
    const restarted = createRealmAccountService({ ...f.options, createClient: (siteId, callback) => {
      const result = f.options.createClient(siteId, callback)
      return { ...result, restore: async (value) => { await gate.promise; return result.restore(value) } }
    } })
    expect(restarted.restoringAccount()).toBeNull()
    const restoring = restarted.restoreActive()
    await vi.waitFor(() => expect(restarted.restoringAccount()).toEqual({ siteId: 'solov-api', userId: 42 }))
    expect(restarted.client.getSessionState().authenticated).toBe(false)
    gate.resolve()
    await expect(restoring).resolves.toBe(true)
    expect(restarted.restoringAccount()).toBeNull()
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
  it('keeps an unreachable login as retrying and settles it on the next restore', async () => {
    for (const outcome of ['restored', 'expired'] as const) {
      const f = fixture()
      await f.vault.activate(saved('solov-api', '42'))
      const onChanged = vi.fn()
      let restoreError: Error | null = new RealmAccountError('UNAVAILABLE')
      let restoreValid = true
      const restarted = createRealmAccountService({ ...f.options, onChanged, createClient: (siteId, callback) => {
        const result = f.options.createClient(siteId, callback)
        Object.assign(f.clients[f.clients.length - 1], { restoreError, restoreValid })
        return result
      } })
      await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      expect(restarted.stalledAccount()).toEqual({ siteId: 'solov-api', userId: 42 })
      expect(restarted.client.getSessionState()).toMatchObject({
        authenticated: false, restoring: { account: { siteId: 'solov-api', userId: 42 }, retrying: true },
      })
      expect(onChanged).toHaveBeenCalledTimes(1)
      expect((await f.vault.active())?.realmId).toBe('api-account')
      // A second unreachable attempt changes nothing the interface shows.
      await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      expect(onChanged).toHaveBeenCalledTimes(1)
      restoreError = null
      restoreValid = outcome === 'restored'
      await expect(restarted.restoreActive()).resolves.toBe(outcome === 'restored')
      expect(restarted.stalledAccount()).toBeNull()
      expect(restarted.client.getSessionState()).not.toHaveProperty('restoring')
      expect(onChanged).toHaveBeenCalledTimes(2)
      expect(onChanged.mock.lastCall?.[1]).toMatchObject({ authenticated: outcome === 'restored' })
      if (outcome === 'expired') expect(await f.vault.active()).toBeNull()
    }
  })
  // 全面检测 Q9：等重试的那段网络请求不占账号锁，工具页的读取、打开、保存照常。
  for (const interrupt of ['none', 'login'] as const) {
    it(`keeps tool work running while a stalled login retries (${interrupt})`, async () => {
      const f = fixture()
      await f.vault.activate(saved('solov-api', '42'))
      let fail = true
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const restarted = createRealmAccountService({ ...f.options, createClient: (siteId, callback) => {
        const result = f.options.createClient(siteId, callback)
        const item = f.clients[f.clients.length - 1]
        if (fail) item.restoreError = new RealmAccountError('UNAVAILABLE')
        else {
          const original = item.restore.getMockImplementation() as (value: RealmSavedAccount) => Promise<boolean>
          item.restore.mockImplementationOnce(async (value: RealmSavedAccount) => { await gate; return original(value) })
        }
        return result
      } })
      await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      fail = false
      const revision = restarted.client.getSessionRevision!()
      const before = f.clients.length
      const retry = restarted.restoreActive()
      await vi.waitFor(() => expect(f.clients.length).toBeGreaterThan(before))
      await vi.waitFor(() => expect(f.clients.at(-1)!.restore).toHaveBeenCalled())
      expect(() => restarted.assertReady()).not.toThrow()
      expect(restarted.client.getSessionRevision!()).toBe(revision)
      if (interrupt === 'login') {
        // 用户在等的时候自己登录了：那一次说了算，重试不再改动当前身份。
        await restarted.login(login)
        release()
        await expect(retry).resolves.toBe(false)
        expect(restarted.getSiteId()).toBe('solov')
        expect(restarted.client.getSessionState().account?.userId).toBe(7)
        return
      }
      release()
      await expect(retry).resolves.toBe(true)
      expect(restarted.stalledAccount()).toBeNull()
      expect(restarted.client.getSessionState()).toMatchObject({ authenticated: true })
      expect(restarted.getSiteId()).toBe('solov-api')
    })
  }
  it('does not put the retrying mark back when the user signed in or out while a retry was failing', async () => {
    for (const action of ['login', 'logout'] as const) {
      const f = fixture()
      await f.vault.activate(saved('solov-api', '42'))
      let hold = false
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const restarted = createRealmAccountService({ ...f.options, createClient: (siteId, callback) => {
        const result = f.options.createClient(siteId, callback)
        const item = f.clients[f.clients.length - 1]
        item.restoreError = new RealmAccountError('UNAVAILABLE')
        if (hold) {
          const original = item.restore.getMockImplementation() as (value: RealmSavedAccount) => Promise<boolean>
          item.restore.mockImplementationOnce(async (value: RealmSavedAccount) => { await gate; return original(value) })
        }
        return result
      } })
      await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      hold = true
      const before = f.clients.length
      const retry = restarted.restoreActive()
      await vi.waitFor(() => expect(f.clients.length).toBeGreaterThan(before))
      await vi.waitFor(() => expect(f.clients.at(-1)!.restore).toHaveBeenCalled())
      hold = false
      if (action === 'login') await restarted.login(login)
      else await restarted.logout()
      release()
      await expect(retry).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      expect(restarted.stalledAccount()).toBeNull()
      expect(restarted.client.getSessionState()).not.toHaveProperty('restoring')
    }
  })
  it('writes a rotated credential back when a background retry cannot take over', async () => {
    const f = fixture()
    await f.vault.activate(saved('solov-api', '42'))
    let fail = true
    let quiesceFails = false
    const restarted = createRealmAccountService({ ...f.options,
      quiesce: async () => { if (quiesceFails) throw new RealmAccountError('BUSY') },
      createClient: (siteId, callback) => {
        const result = f.options.createClient(siteId, callback)
        if (fail) f.clients[f.clients.length - 1].restoreError = new RealmAccountError('UNAVAILABLE')
        return result
      } })
    await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    fail = false
    quiesceFails = true
    await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'BUSY' })
    // 服务端已经换过一次凭据；不写回的话，下一次重试拿的是已经作废的那份。
    expect(await f.vault.get({ realmId: 'api-account', userId: '42' })).toEqual(saved('solov-api', '42', 'test-rotated-once'))
    expect(restarted.stalledAccount()).not.toBeNull()
    quiesceFails = false
    await expect(restarted.restoreActive()).resolves.toBe(true)
  })
  it('does not promise a retry when the saved record itself cannot be used', async () => {
    const f = fixture()
    await f.vault.activate(saved('solov-api', '42'))
    const restarted = createRealmAccountService({ ...f.options, createClient: (siteId, callback) => {
      const result = f.options.createClient(siteId, callback)
      f.clients[f.clients.length - 1].restoreError = new RealmAccountError('PROTOCOL')
      return result
    } })
    await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(restarted.stalledAccount()).toBeNull()
    expect((await f.vault.active())?.realmId).toBe('api-account')
  })
  it('drops the retrying mark when the user signs in or out on their own', async () => {
    for (const action of ['login', 'logout'] as const) {
      const f = fixture()
      await f.vault.activate(saved('solov-api', '42'))
      const restarted = createRealmAccountService({ ...f.options, createClient: (siteId, callback) => {
        const result = f.options.createClient(siteId, callback)
        f.clients[f.clients.length - 1].restoreError = new RealmAccountError('NETWORK')
        return result
      } })
      await expect(restarted.restoreActive()).rejects.toMatchObject({ code: 'NETWORK' })
      expect(restarted.stalledAccount()).not.toBeNull()
      if (action === 'login') await restarted.login(login)
      else await restarted.logout()
      expect(restarted.stalledAccount()).toBeNull()
      expect(restarted.client.getSessionState()).not.toHaveProperty('restoring')
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

describe('explicit login vault recovery', () => {
  it('preserves an unreadable vault on startup and recovers before migration on explicit login', async () => {
    const legacy = { list: vi.fn(async () => []), getSession: vi.fn(async () => null), readActive: vi.fn(async () => null) }
    const f = fixture({ legacy })
    f.corrupt()
    const unreadable = f.content()
    await expect(f.service.restoreActive()).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.content()).toBe(unreadable)
    expect(f.backup()).toBeNull()
    expect(f.service.client.getSessionState().authenticated).toBe(false)

    await expect(f.service.login(login)).resolves.toMatchObject({ siteId: 'solov' })
    expect(f.backup()).toBe(unreadable)
    expect(f.content()).not.toBe(unreadable)
    expect((await f.vault.active())?.userId).toBe('7')
    expect(await f.vault.hasMigratedLegacy()).toBe(true)
    expect(legacy.list).not.toHaveBeenCalled()
    expect(legacy.readActive).not.toHaveBeenCalled()
    expect(f.service.client.getSessionState().authenticated).toBe(true)
  })
  it('rechecks the persisted migration marker after recovery and never imports old sessions again', async () => {
    const origin = 'https://xm.solov.cc'
    const legacy = { list: vi.fn(async () => [{ id: savedAccountId(origin, 8), origin, userId: 8,
      username: 'legacy-8', updatedAt: '' }]), getSession: vi.fn(async () => ({ userId: 8, cookies: ['old-cookie'] })),
      readActive: vi.fn(async () => null) }
    const f = fixture({ legacy })
    await f.service.migrateLegacy()
    expect(legacy.list).toHaveBeenCalledOnce()
    f.corrupt()
    const hasMigratedLegacy = vi.fn(() => f.vault.hasMigratedLegacy())
    f.options.vault = { ...f.vault, hasMigratedLegacy }

    await f.service.login(login)
    expect(hasMigratedLegacy).toHaveBeenCalledOnce()
    expect(legacy.list).toHaveBeenCalledOnce()
    expect(await f.vault.get(saved('solov', '8'))).toBeNull()
    const restarted = createRealmAccountService(f.options)
    expect(await restarted.restoreActive()).toBe(true)
    expect(legacy.list).toHaveBeenCalledOnce()
  })
  it('does not reset unreadable storage during reads, logout or saved-account switching', async () => {
    const f = fixture()
    f.corrupt()
    const unreadable = f.content()
    const recoverUnreadable = vi.fn(() => f.vault.recoverUnreadable())
    f.options.vault = { ...f.vault, recoverUnreadable }
    await expect(f.service.listSavedAccounts()).rejects.toMatchObject({ code: 'STORAGE' })
    await expect(f.service.latestLoginHint()).rejects.toMatchObject({ code: 'STORAGE' })
    await expect(f.service.logout()).rejects.toMatchObject({ code: 'STORAGE' })
    await expect(f.service.switchSavedAccount(savedAccountId('https://xm.solov.cc', 7))).rejects.toMatchObject({ code: 'STORAGE' })
    expect(recoverUnreadable).not.toHaveBeenCalled()
    expect(f.content()).toBe(unreadable)
    expect(f.backup()).toBeNull()
  })
  it('keeps an authenticated identity and unreadable bytes intact when another login is attempted', async () => {
    const f = fixture()
    await f.service.login(login)
    f.corrupt()
    const unreadable = f.content()
    const recoverUnreadable = vi.fn(() => f.vault.recoverUnreadable())
    f.options.vault = { ...f.vault, recoverUnreadable }
    await expect(f.service.login({ ...login, siteId: 'solov-api' })).rejects.toMatchObject({ code: 'STORAGE' })
    expect(recoverUnreadable).not.toHaveBeenCalled()
    expect(f.content()).toBe(unreadable)
    expect(f.backup()).toBeNull()
    expect(f.service.getSiteId()).toBe('solov')
    expect(f.service.client.getSessionState().authenticated).toBe(true)
    expect(f.clients[1].client.logout).not.toHaveBeenCalled()
  })
  it('refuses recovery while the active handle still owns saved credentials', async () => {
    const f = fixture()
    await f.service.login(login)
    f.clients[1].client.getSessionState = () => ({ authenticated: false, account: null })
    f.corrupt()
    const recoverUnreadable = vi.fn(() => f.vault.recoverUnreadable())
    f.options.vault = { ...f.vault, recoverUnreadable }
    await expect(f.service.login(login)).rejects.toMatchObject({ code: 'STORAGE' })
    expect(recoverUnreadable).not.toHaveBeenCalled()
    expect(f.backup()).toBeNull()
  })
  it('does not authenticate or replace the original when the backup and replacement fail', async () => {
    const f = fixture()
    f.corrupt()
    const unreadable = f.content()
    f.fail(true)
    await expect(f.service.login(login)).rejects.toMatchObject({ code: 'STORAGE' })
    expect(f.content()).toBe(unreadable)
    expect(f.backup()).toBeNull()
    expect(f.clients).toHaveLength(1)
    expect(f.service.client.getSessionState().authenticated).toBe(false)
    f.fail(false)
    await expect(f.service.login(login)).resolves.toMatchObject({ siteId: 'solov' })
  })
  it('holds the transition lock while recovery is pending', async () => {
    const f = fixture()
    f.corrupt()
    const gate = deferred<void>()
    const recoverUnreadable = vi.fn(async () => { await gate.promise; return f.vault.recoverUnreadable() })
    f.options.vault = { ...f.vault, recoverUnreadable }
    const pending = f.service.login(login)
    await expect(f.service.login(login)).rejects.toMatchObject({ code: 'BUSY' })
    await expect(f.service.logout()).rejects.toMatchObject({ code: 'BUSY' })
    expect(f.clients).toHaveLength(1)
    expect(recoverUnreadable).toHaveBeenCalledOnce()
    gate.resolve()
    await expect(pending).resolves.toMatchObject({ siteId: 'solov' })
    expect(recoverUnreadable).toHaveBeenCalledOnce()
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
  it('never offers the password to the other account system after a definitive rejection', async () => {
    const f = fixture()
    f.authenticationPolicy((siteId) => { if (siteId === 'solov') throw new NewApiLoginRejectedError() })
    await expect(f.service.login(automatic)).rejects.toBeInstanceOf(NewApiLoginRejectedError)
    expect(f.clients.map((entry) => entry.siteId)).toEqual(['solov', 'solov'])
    expect(f.clients[1].client.logout).toHaveBeenCalled()
    expect(await f.vault.preferredLoginSite(automatic.username)).toBeNull()
  })
  it('never offers the password to the other account system after a RealmAccountError rejection', async () => {
    const f = fixture()
    const attempted: RealmAccountSiteId[] = []
    f.authenticationPolicy((siteId) => { attempted.push(siteId); throw new RealmAccountError('LOGIN_REJECTED') })
    await expect(f.service.login(automatic)).rejects.toMatchObject({ code: 'LOGIN_REJECTED' })
    expect(attempted).toEqual(['solov'])
  })
  it('sends an email identifier only to the site this machine already recorded for it', async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: 'solov-api' })
    await f.service.logout()
    const attempted: RealmAccountSiteId[] = []
    f.authenticationPolicy((siteId) => { attempted.push(siteId); throw new NewApiLoginRejectedError() })
    await expect(f.service.login(automatic)).rejects.toBeInstanceOf(NewApiLoginRejectedError)
    expect(attempted).toEqual(['solov-api'])
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
    await expect(f.service.login({ ...automatic, username: 'short-user' })).rejects.toBeInstanceOf(NewApiLoginRejectedError)
    expect(f.clients.map((entry) => entry.siteId)).toEqual(['solov', 'solov'])
  })
  it('leaves the active account and its last successful binding unchanged when the credentials are rejected', async () => {
    const f = fixture()
    await f.service.login({ ...login, siteId: 'solov-api' })
    const original = f.content()
    f.authenticationPolicy((siteId) => { throw siteId === 'solov' ? new NewApiLoginRejectedError() : new RealmAccountError('LOGIN_REJECTED') })
    await expect(f.service.login(automatic)).rejects.toMatchObject({ code: 'LOGIN_REJECTED' })
    expect(f.content()).toBe(original)
    expect(f.service.getSiteId()).toBe('solov-api')
  })
})

describe('realm switch guards on the shipped path', () => {
  it('keeps both accounts and restores the selected one after a restart', async () => {
    const f = fixture()
    await f.service.login(login)
    await f.service.login({ ...login, siteId: 'solov-api' })
    const summaries = await f.service.listSavedAccounts()
    await f.service.switchSavedAccount(summaries[0].id)
    expect(f.service.getSiteId()).toBe('solov')
    const restarted = createRealmAccountService(f.options)
    expect(await restarted.restoreActive()).toBe(true)
    expect(restarted.getSiteId()).toBe('solov')
    expect(restarted.client.getSessionState().account?.userId).toBe(7)
    expect(await restarted.listSavedAccounts()).toHaveLength(2)
  })
  it('does not start authentication when quiescence rejects a running CLI', async () => {
    const f = fixture({ quiesce: async () => { throw new RealmAccountError('BUSY') } })
    await expect(f.service.login(login)).rejects.toMatchObject({ code: 'BUSY' })
    expect(f.clients).toHaveLength(1)
    expect(f.clients[0].client.login).not.toHaveBeenCalled()
    expect(await f.vault.list()).toEqual([])
    expect(f.service.client.getSessionState().authenticated).toBe(false)
  })
  it('rejects a restored identity that does not match the requested account before persisting it', async () => {
    const f = fixture()
    await f.service.login(login)
    await f.service.login({ ...login, siteId: 'solov-api' })
    const summaries = await f.service.listSavedAccounts()
    const original = f.content()
    f.restoredIdentity((siteId) => saved(siteId, '8', 'test-rotated-once'))
    await expect(f.service.switchSavedAccount(summaries[0].id)).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(f.content()).toBe(original)
    expect(f.service.getSiteId()).toBe('solov-api')
    expect(f.clients.at(-1)!.client.logout).toHaveBeenCalledTimes(1)
  })
  it('says the saved account expired, not the current one, when switching to a dead saved login', async () => {
    for (const failure of ['invalid', 'unauthorized'] as const) {
      const f = fixture()
      await f.service.login(login)
      await f.service.login({ ...login, siteId: 'solov-api' })
      const summaries = await f.service.listSavedAccounts()
      const createClient = f.options.createClient
      f.options.createClient = (siteId, callback) => {
        const created = createClient(siteId, callback)
        if (failure === 'invalid') f.clients.at(-1)!.restoreValid = false
        else f.clients.at(-1)!.restoreError = new RealmAccountError('UNAUTHORIZED')
        return created
      }
      await expect(f.service.switchSavedAccount(summaries[0].id)).rejects.toMatchObject({ code: 'SAVED_EXPIRED' })
      // 当前账号原样留着，过期的那条也还在列表里，等用户重新登录它。
      expect(f.service.getSiteId()).toBe('solov-api')
      expect(f.service.client.getSessionState().authenticated).toBe(true)
      expect(await f.service.listSavedAccounts()).toHaveLength(2)
    }
  })
  it('rejects forgetting the current account through the inactive-account action', async () => {
    const f = fixture()
    await f.service.login(login)
    await f.service.login({ ...login, siteId: 'solov-api' })
    const summaries = await f.service.listSavedAccounts()
    await expect(f.service.removeSavedAccount(summaries[1].id)).rejects.toMatchObject({ code: 'BUSY' })
    expect((await f.service.listSavedAccounts()).map((entry) => entry.id)).toEqual(summaries.map((entry) => entry.id))
    expect(f.service.getSiteId()).toBe('solov-api')
    await f.service.removeSavedAccount(summaries[0].id)
    expect((await f.service.listSavedAccounts()).map((entry) => entry.id)).toEqual([summaries[1].id])
    await f.service.logout()
    expect(await f.service.listSavedAccounts()).toEqual([])
  })
})

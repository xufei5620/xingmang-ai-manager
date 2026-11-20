import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRealmSavedAccount, type RealmSavedAccount } from '../realm-account'
import { createRealmAccountService } from '../realm-account-service'
import { createSessionRealmAccountVault, type RealmAccountVault } from '../realm-account-vault'
import type { RuntimeLogStore } from '../runtime-log'
import { createAccountClientFactory, createAccountStorage, type AccountClientFactoryOptions } from './accounts'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('encryption is unavailable in tests') },
    decryptString: () => { throw new Error('encryption is unavailable in tests') },
  },
}))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function runtimeLog() {
  return { log: vi.fn(), exception: vi.fn() }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('account storage', () => {
  function create() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-account-storage-'))
    directories.push(root)
    const log = runtimeLog()
    const storage = createAccountStorage({
      managerDataDirectory: root,
      runtimeLog: log as unknown as RuntimeLogStore,
      linuxPasswordStore: null,
      mainWindow: () => null,
    })
    return { root, log, storage }
  }

  it('says in the log that the computer cannot keep logins safely', () => {
    const { log } = create()
    expect(log.log).toHaveBeenCalledWith('warn', 'account', 'session.persist.unavailable', expect.any(String), expect.objectContaining({ backend: 'unavailable' }))
  })

  it.runIf(process.platform === 'linux')('keeps logins for this run only on Linux and writes no account files', () => {
    const { root, storage } = create()
    expect(storage.credentialPersistence).toBe('session-only')
    expect(fs.readdirSync(root)).toEqual([])
  })

  it.runIf(process.platform !== 'linux')('still refuses to keep logins in memory only on Windows and macOS', () => {
    const { storage } = create()
    expect(storage.credentialPersistence).toBe('durable')
  })
})

describe('account clients', () => {
  // Building a client must not send anything: these throw if anything tries.
  function create() {
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline in tests') })
    const routes = {
      relayRouting: {},
      proxyBypass: {},
      routedAccountRelayFetch: fetchImpl,
      routedAccountFetch: fetchImpl,
    } as unknown as AccountClientFactoryOptions['routes']
    const createClient = createAccountClientFactory({
      vault: {} as RealmAccountVault,
      routes,
      runtimeLog: runtimeLog() as unknown as RuntimeLogStore,
    })
    return { createClient, fetchImpl }
  }

  it('builds a client per site without sending a request', () => {
    const { createClient, fetchImpl } = create()
    const solov = createClient('solov', vi.fn())
    const history = createClient('solov-api', vi.fn())
    expect(solov.client).not.toBe(history.client)
    expect(solov.getSavedAccount()).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('will not restore or end a history-account login on the 星芒 account client', async () => {
    const { createClient, fetchImpl } = create()
    const record = { realmId: 'api-account', userId: '7' } as unknown as RealmSavedAccount
    const solov = createClient('solov', vi.fn())
    await expect(solov.restore(record)).rejects.toThrow('账号凭据与当前账号不匹配')
    await expect(solov.endSavedSession?.(record)).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('writes why the 星芒 account login ended to the runtime log, with the site', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const pathname = new URL(String(url)).pathname
      if (pathname === '/api/user/login') {
        return json({ success: true, message: '', data: { access_token: 'fixture-access', access_expires_at: null,
          user: { id: 7, username: 'fixture', group: 'default', role: 1, quota: 0, used_quota: 0 } } }, 200,
        { 'set-cookie': 'refresh_token=fixture-cookie; Path=/; HttpOnly' })
      }
      if (pathname === '/api/status') return json({ success: true, message: '', data: { quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 1 } })
      if (pathname === '/api/user/self') return json({ success: false, code: 'AUTH_TOKEN_EXPIRED', message: 'Unauthorized' }, 401)
      if (pathname === '/api/user/auth/refresh') return json({ success: false, code: 'AUTH_SESSION_REVOKED', message: 'Unauthorized' }, 401)
      throw new TypeError(`unexpected request in tests: ${pathname}`)
    })
    const log = runtimeLog()
    const createClient = createAccountClientFactory({
      vault: {} as RealmAccountVault,
      routes: { relayRouting: {}, proxyBypass: {}, routedAccountRelayFetch: fetchImpl, routedAccountFetch: fetchImpl } as unknown as AccountClientFactoryOptions['routes'],
      runtimeLog: log as unknown as RuntimeLogStore,
    })
    const solov = createClient('solov', vi.fn())
    await solov.client.login({ username: 'fixture', password: 'fixture-password' })

    await expect(solov.client.getBalance()).rejects.toThrow()

    expect(solov.client.getSessionState().authenticated).toBe(false)
    expect(log.log).toHaveBeenCalledWith('warn', 'account', 'session.ended', expect.any(String), expect.objectContaining({
      siteId: 'solov',
      refusedBy: '登录状态续期',
      code: 'AUTH_SESSION_REVOKED',
    }))
  })
})

// 0.2.25 总单第 19 项（11-18 复核 O08）：开机恢复联不上、等自动重试的时候，客户自己又登了同一个号。
// 重试那次续期晚回来，换来的是旧登录的凭据；它以前不看本机记录是不是还是自己出发时那份，直接写回，
// 把刚登的盖掉，重启后拿旧凭据恢复就被退出来。这里用真的账号客户端和账号库走一遍，只把网络换成假的。
describe('a late startup retry against a fresh login of the same account', () => {
  function start(fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>) {
    const vault = createSessionRealmAccountVault()
    const log = runtimeLog()
    const createClient = createAccountClientFactory({
      vault,
      routes: { relayRouting: {}, proxyBypass: {}, routedAccountRelayFetch: fetchImpl, routedAccountFetch: fetchImpl } as unknown as AccountClientFactoryOptions['routes'],
      runtimeLog: log as unknown as RuntimeLogStore,
    })
    const service = () => createRealmAccountService({ vault, createClient, quiesce: async () => undefined, startupRetryDelayMs: 0 })
    return { vault, log, service }
  }

  it('keeps the fresh 星芒 login on this computer and restores it after a restart', async () => {
    const user = { id: 7, username: 'fixture', group: 'default', role: 1, quota: 0, used_quota: 0 }
    let maintenance = true
    const late = deferred()
    const oldRefreshes: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname
      const cookie = new Headers(init?.headers).get('cookie')
      if (pathname === '/api/user/auth/refresh') {
        if (cookie === 'refresh_token=old-1') {
          oldRefreshes.push(maintenance ? 'maintenance' : 'held')
          if (maintenance) return json({ success: false, message: '系统维护中' }, 503)
          await late.promise
          return json({ success: true, message: '', data: { access_token: 'old-access-2' } }, 200,
            { 'set-cookie': 'refresh_token=old-2; Path=/; HttpOnly' })
        }
        if (cookie === 'refresh_token=fresh-1') {
          return json({ success: true, message: '', data: { access_token: 'fresh-access-2' } }, 200,
            { 'set-cookie': 'refresh_token=fresh-2; Path=/; HttpOnly' })
        }
        // 新登录时本机把旧登录在服务端注销了：旧凭据再拿来续期就不认。
        return json({ success: false, code: 'AUTH_SESSION_REVOKED', message: 'Unauthorized' }, 401)
      }
      if (pathname === '/api/user/self') return json({ success: true, message: '', data: user })
      if (pathname === '/api/user/login') {
        return json({ success: true, message: '', data: { access_token: 'fresh-access', access_expires_at: null, user } }, 200,
          { 'set-cookie': 'refresh_token=fresh-1; Path=/; HttpOnly' })
      }
      if (pathname === '/api/user/auth/logout') return json({ success: true, message: '' })
      if (pathname === '/api/status') return json({ success: true, message: '', data: { quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 1 } })
      throw new TypeError(`unexpected request in tests: ${pathname}`)
    })
    const { vault, log, service } = start(fetchImpl)
    const owner = { realmId: 'xm-account' as const, userId: '7' }
    await vault.activate(parseRealmSavedAccount({ version: 2, realmId: 'xm-account', origin: 'https://xm.solov.cc', userId: '7',
      username: 'fixture', credential: { kind: 'new-api', cookies: ['refresh_token=old-1'] } }))
    const accounts = service()
    await expect(accounts.restoreActive()).rejects.toThrow()
    expect(accounts.stalledAccount()).toEqual({ siteId: 'solov', userId: 7 })

    maintenance = false
    const retry = accounts.restoreActive()
    await vi.waitFor(() => expect(oldRefreshes).toEqual(['maintenance', 'held']))
    await accounts.login({ username: 'fixture', password: 'fixture-password', siteId: 'solov' })
    late.resolve()
    await expect(retry).resolves.toBe(false)

    expect((await vault.get(owner))?.credential).toEqual({ kind: 'new-api', cookies: ['refresh_token=fresh-1'] })
    expect(accounts.client.getSessionState()).toMatchObject({ authenticated: true, account: { userId: 7 } })
    expect(log.log).toHaveBeenCalledWith('info', 'account', 'session.rotation.superseded', expect.any(String), { siteId: 'solov' })

    const restarted = service()
    await expect(restarted.restoreActive()).resolves.toBe(true)
    expect(restarted.client.getSessionState()).toMatchObject({ authenticated: true, account: { userId: 7 } })
  })

  it('keeps the fresh history-account login on this computer and restores it after a restart', async () => {
    const user = { id: 42, username: 'history', email: 'history@example.test', balance: 1, status: 'active' }
    let maintenance = true
    const late = deferred()
    const oldRefreshes: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname
      const token = new Headers(init?.headers).get('authorization')
      const ok = (data: unknown) => json({ code: 0, message: 'success', data })
      if (pathname === '/api/v1/auth/me' || pathname === '/api/v1/user/profile') {
        if (token === 'Bearer old-access' && maintenance) return json({ code: 503, message: '系统维护中' }, 503)
        if (token === 'Bearer old-access-2' || token === 'Bearer fresh-access') return ok(user)
        return json({ code: 401, message: 'Unauthorized' }, 401)
      }
      if (pathname === '/api/v1/auth/refresh') {
        const body = JSON.parse(String(init?.body)) as { refresh_token: string }
        if (body.refresh_token !== 'old-refresh') return json({ code: 401, message: 'Unauthorized' }, 401)
        oldRefreshes.push('held')
        await late.promise
        return ok({ access_token: 'old-access-2', refresh_token: 'old-refresh-2', token_type: 'Bearer' })
      }
      if (pathname === '/api/v1/auth/login') {
        return ok({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'Bearer', user })
      }
      throw new TypeError(`unexpected request in tests: ${pathname}`)
    })
    const { vault, log, service } = start(fetchImpl)
    const owner = { realmId: 'api-account' as const, userId: '42' }
    await vault.activate(parseRealmSavedAccount({ version: 2, realmId: 'api-account', origin: 'https://api.solov.cc', userId: '42',
      username: 'history', credential: { kind: 'sub2api', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: null } }))
    const accounts = service()
    await expect(accounts.restoreActive()).rejects.toThrow()
    expect(accounts.stalledAccount()).toEqual({ siteId: 'solov-api', userId: 42 })

    maintenance = false
    const retry = accounts.restoreActive()
    await vi.waitFor(() => expect(oldRefreshes).toEqual(['held']))
    await accounts.login({ username: 'history@example.test', password: 'fixture-password', siteId: 'solov-api' })
    late.resolve()
    await expect(retry).resolves.toBe(false)

    expect((await vault.get(owner))?.credential).toEqual({ kind: 'sub2api', accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: null })
    expect(accounts.client.getSessionState()).toMatchObject({ authenticated: true, account: { userId: 42 } })
    expect(log.log).toHaveBeenCalledWith('info', 'account', 'session.rotation.superseded', expect.any(String), { siteId: 'solov-api' })

    const restarted = service()
    await expect(restarted.restoreActive()).resolves.toBe(true)
    expect((await vault.get(owner))?.credential).toMatchObject({ accessToken: 'fresh-access' })
  })
})

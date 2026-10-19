import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RealmSavedAccount } from '../realm-account'
import type { RealmAccountVault } from '../realm-account-vault'
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
})

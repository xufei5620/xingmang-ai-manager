import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AccountSessionStore,
  decodePersistedAccountSession,
  encodePersistedAccountSession,
  isPersistedAccountSession,
  restoreAccountSessionOnStartup,
  type PersistedAccountSession,
  type RestoreAccountSessionDeps,
  type RuntimeLogLike,
  type SafeStorageLike,
} from './account-session-store'
import type { NewApiClientService } from './new-api-client'

const temporaryDirectories: string[] = []

function temporaryFilePath(name = 'account-session.dat'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-account-session-test-'))
  temporaryDirectories.push(directory)
  return path.join(directory, name)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

// A deterministic, reversible stand-in for Electron's real safeStorage (DPAPI
// / Keychain / libsecret) -- unit tests must never depend on, or be gated by,
// what the host OS's credential store happens to support (and must never
// touch the network either, which this whole module has no way to do
// regardless). "corrupted" ciphertext (any buffer not produced by
// encryptString) makes decryptString throw, exercising the same failure path
// a real safeStorage takes on a blob written by a different OS user/profile.
function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc1:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('enc1:')) throw new Error('ciphertext not recognized')
      return text.slice('enc1:'.length)
    },
    ...overrides,
  }
}

function session(overrides: Partial<PersistedAccountSession> = {}): PersistedAccountSession {
  return { version: 1, userId: 42, cookies: ['refresh_token=abc123'], ...overrides }
}

function runtimeLogStub(): RuntimeLogLike & { calls: Array<{ level: string; event: string; message: string }> } {
  const calls: Array<{ level: string; event: string; message: string }> = []
  return {
    calls,
    log: vi.fn((level, _source, event, message) => {
      calls.push({ level, event, message })
    }),
  }
}

describe('isPersistedAccountSession', () => {
  it('accepts a well-formed v1 record', () => {
    expect(isPersistedAccountSession(session())).toBe(true)
  })

  it('rejects a non-object, a wrong version, and a missing/invalid userId', () => {
    expect(isPersistedAccountSession(null)).toBe(false)
    expect(isPersistedAccountSession('nope')).toBe(false)
    expect(isPersistedAccountSession({ ...session(), version: 2 })).toBe(false)
    expect(isPersistedAccountSession({ ...session(), userId: 0 })).toBe(false)
    expect(isPersistedAccountSession({ ...session(), userId: 1.5 })).toBe(false)
    expect(isPersistedAccountSession({ ...session(), userId: 'x' })).toBe(false)
  })

  it('rejects empty or non-string cookie entries', () => {
    expect(isPersistedAccountSession({ ...session(), cookies: [] })).toBe(false)
    expect(isPersistedAccountSession({ ...session(), cookies: [''] })).toBe(false)
    expect(isPersistedAccountSession({ ...session(), cookies: [1] })).toBe(false)
  })
})

describe('encodePersistedAccountSession / decodePersistedAccountSession', () => {
  it('round-trips through the injected storage', () => {
    const storage = fakeSafeStorage()
    const encoded = encodePersistedAccountSession(session(), storage)
    expect(decodePersistedAccountSession(encoded, storage)).toEqual(session())
  })

  it('never stores the cookie value as plaintext in the encoded output', () => {
    const storage = fakeSafeStorage()
    const encoded = encodePersistedAccountSession(session(), storage)
    expect(encoded).not.toContain('refresh_token=abc123')
  })

  it('returns null instead of throwing on unparseable base64, wrong-key ciphertext, or malformed JSON', () => {
    const storage = fakeSafeStorage()
    expect(decodePersistedAccountSession('not-valid-base64!!!', storage)).toBeNull()
    expect(decodePersistedAccountSession(Buffer.from('garbage').toString('base64'), storage)).toBeNull()
    const notJson = Buffer.from('enc1:{not json', 'utf8').toString('base64')
    expect(decodePersistedAccountSession(notJson, storage)).toBeNull()
    const wrongShape = Buffer.from(`enc1:${JSON.stringify({ hello: 'world' })}`, 'utf8').toString('base64')
    expect(decodePersistedAccountSession(wrongShape, storage)).toBeNull()
  })
})

describe('AccountSessionStore', () => {
  it('returns null when no file has ever been written', async () => {
    const store = new AccountSessionStore(temporaryFilePath(), fakeSafeStorage())
    await expect(store.read()).resolves.toBeNull()
  })

  it('round-trips save -> read, including creating a not-yet-existing parent directory', async () => {
    const filePath = path.join(path.dirname(temporaryFilePath()), 'nested', 'account-session.dat')
    const store = new AccountSessionStore(filePath, fakeSafeStorage())

    await store.save({ userId: 7, cookies: ['refresh_token=xyz'] })

    await expect(store.read()).resolves.toEqual({ version: 1, userId: 7, cookies: ['refresh_token=xyz'] })
  })

  it('writes ciphertext, never the plaintext cookie, to disk', async () => {
    const filePath = temporaryFilePath()
    const store = new AccountSessionStore(filePath, fakeSafeStorage())

    await store.save({ userId: 42, cookies: ['refresh_token=super-secret-value'] })

    const onDisk = fs.readFileSync(filePath, 'utf8')
    expect(onDisk).not.toContain('super-secret-value')
  })

  it('clear() removes the file so a later read() reports null again', async () => {
    const filePath = temporaryFilePath()
    const store = new AccountSessionStore(filePath, fakeSafeStorage())
    await store.save({ userId: 42, cookies: ['refresh_token=abc'] })
    expect(fs.existsSync(filePath)).toBe(true)

    await store.clear()

    expect(fs.existsSync(filePath)).toBe(false)
    await expect(store.read()).resolves.toBeNull()
  })

  it('clear() on an already-absent file is a harmless no-op', async () => {
    const store = new AccountSessionStore(temporaryFilePath(), fakeSafeStorage())
    await expect(store.clear()).resolves.toBeUndefined()
  })

  it('never persists, and read() reports null, when encryption is unavailable -- no plaintext fallback', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage({ isEncryptionAvailable: () => false })
    const store = new AccountSessionStore(filePath, storage)

    await store.save({ userId: 42, cookies: ['refresh_token=abc'] })

    expect(fs.existsSync(filePath)).toBe(false)
    await expect(store.read()).resolves.toBeNull()
  })

  it('read() degrades to null (not a throw) when the file is corrupted', async () => {
    const filePath = temporaryFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'not even base64 ciphertext', { encoding: 'utf8', mode: 0o600 })
    const store = new AccountSessionStore(filePath, fakeSafeStorage())

    await expect(store.read()).resolves.toBeNull()
  })

  it('serializes a save() and a clear() fired back-to-back, so they apply in call order instead of whichever disk I/O happens to finish first', async () => {
    const filePath = temporaryFilePath()
    const store = new AccountSessionStore(filePath, fakeSafeStorage())

    // Neither promise is awaited before the next call starts -- simulates a
    // save (e.g. a silent refresh landing) immediately followed by a logout
    // in the real app. Without the private write queue, clear()'s unlink
    // could run concurrently with save()'s temp-file-then-rename and the two
    // filesystem operations could interleave in either order.
    const savePromise = store.save({ userId: 1, cookies: ['refresh_token=a'] })
    const clearPromise = store.clear()
    await Promise.all([savePromise, clearPromise])

    // clear() was *called* after save(), so the queue guarantees it also
    // *applies* after save(): a logout must never be able to leave a
    // credential sitting on disk just because its own write happened to
    // reach the filesystem first.
    await expect(store.read()).resolves.toBeNull()
  })
})

function restoreDeps(overrides: Partial<RestoreAccountSessionDeps> = {}): RestoreAccountSessionDeps & {
  accountService: { restoreSession: ReturnType<typeof vi.fn> }
  store: { read: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }
  runtimeLog: ReturnType<typeof runtimeLogStub>
} {
  return {
    accountService: { restoreSession: vi.fn(async () => true) } as unknown as Pick<NewApiClientService, 'restoreSession'> as never,
    store: { read: vi.fn(async () => null), clear: vi.fn(async () => undefined) } as never,
    runtimeLog: runtimeLogStub(),
    ...overrides,
  } as never
}

describe('restoreAccountSessionOnStartup', () => {
  it('does nothing (and never calls accountService) when there is no persisted session', async () => {
    const deps = restoreDeps()

    await restoreAccountSessionOnStartup(deps)

    expect(deps.accountService.restoreSession).not.toHaveBeenCalled()
    expect(deps.store.clear).not.toHaveBeenCalled()
    expect(deps.runtimeLog.calls).toEqual([])
  })

  it('logs success and leaves the file alone when restoreSession succeeds', async () => {
    const persisted = session()
    const deps = restoreDeps({
      store: { read: vi.fn(async () => persisted), clear: vi.fn(async () => undefined) } as never,
    })

    await restoreAccountSessionOnStartup(deps)

    expect(deps.accountService.restoreSession).toHaveBeenCalledWith(persisted)
    expect(deps.store.clear).not.toHaveBeenCalled()
    expect(deps.runtimeLog.calls).toEqual([
      { level: 'info', event: 'session.restored', message: '已恢复登录状态' },
    ])
  })

  it('clears the persisted file when the credential is definitively invalid', async () => {
    const deps = restoreDeps({
      accountService: { restoreSession: vi.fn(async () => false) } as never,
      store: { read: vi.fn(async () => session()), clear: vi.fn(async () => undefined) } as never,
    })

    await restoreAccountSessionOnStartup(deps)

    expect(deps.store.clear).toHaveBeenCalledTimes(1)
    expect(deps.runtimeLog.calls).toEqual([
      { level: 'info', event: 'session.restore.invalid', message: '登录状态已失效，需重新登录' },
    ])
  })

  it('leaves the persisted file alone (does not clear it) on a network/timeout failure', async () => {
    const deps = restoreDeps({
      accountService: { restoreSession: vi.fn(async () => { throw new Error('请求超时') }) } as never,
      store: { read: vi.fn(async () => session()), clear: vi.fn(async () => undefined) } as never,
    })

    await restoreAccountSessionOnStartup(deps)

    expect(deps.store.clear).not.toHaveBeenCalled()
    expect(deps.runtimeLog.calls).toEqual([
      { level: 'warn', event: 'session.restore.failed', message: '登录状态恢复失败（可能是网络问题），本次以未登录启动' },
    ])
  })

  it('never throws even if store.read() itself rejects', async () => {
    const deps = restoreDeps({
      store: { read: vi.fn(async () => { throw new Error('disk error') }), clear: vi.fn(async () => undefined) } as never,
    })

    await expect(restoreAccountSessionOnStartup(deps)).resolves.toBeUndefined()
    expect(deps.accountService.restoreSession).not.toHaveBeenCalled()
  })

  it('never throws even if the clear() following an invalid credential itself rejects', async () => {
    const deps = restoreDeps({
      accountService: { restoreSession: vi.fn(async () => false) } as never,
      store: {
        read: vi.fn(async () => session()),
        clear: vi.fn(async () => { throw new Error('disk error') }),
      } as never,
    })

    await expect(restoreAccountSessionOnStartup(deps)).resolves.toBeUndefined()
    expect(deps.runtimeLog.calls.some((entry) => entry.event === 'session.clear.failed')).toBe(true)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AccountCredentialStore,
  decodePersistedAccountCredentials,
  encodePersistedAccountCredentials,
  isPersistedAccountCredentials,
  type PersistedAccountCredentials,
} from './account-credential-store'
import type { SafeStorageLike } from './account-session-store'

function fakeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`enc:${plainText}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this fake')
      return text.slice(4)
    },
    ...overrides,
  }
}

const record: PersistedAccountCredentials = {
  version: 1,
  identifier: 'boss@qq.com',
  password: 'hunter2!',
}

const tempDirs: string[] = []

function tempFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-credential-store-'))
  tempDirs.push(dir)
  return path.join(dir, 'account-credentials.dat')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('isPersistedAccountCredentials', () => {
  it('accepts a well-formed record', () => {
    expect(isPersistedAccountCredentials(record)).toBe(true)
  })

  it('rejects wrong versions, empty fields, and non-objects', () => {
    expect(isPersistedAccountCredentials({ ...record, version: 2 })).toBe(false)
    expect(isPersistedAccountCredentials({ ...record, identifier: '' })).toBe(false)
    expect(isPersistedAccountCredentials({ ...record, password: '' })).toBe(false)
    expect(isPersistedAccountCredentials({ ...record, password: 42 })).toBe(false)
    expect(isPersistedAccountCredentials(null)).toBe(false)
    expect(isPersistedAccountCredentials([record])).toBe(false)
  })
})

describe('encode/decode roundtrip', () => {
  it('roundtrips through the storage encryption', () => {
    const storage = fakeStorage()
    const encoded = encodePersistedAccountCredentials(record, storage)
    expect(decodePersistedAccountCredentials(encoded, storage)).toEqual(record)
  })

  it('collapses garbage, foreign ciphertext, and invalid payloads to null instead of throwing', () => {
    const storage = fakeStorage()
    expect(decodePersistedAccountCredentials('not-base64-ciphertext', storage)).toBeNull()
    const wrongShape = encodePersistedAccountCredentials(
      { version: 1, identifier: '', password: 'x' } as PersistedAccountCredentials,
      storage,
    )
    expect(decodePersistedAccountCredentials(wrongShape, storage)).toBeNull()
  })
})

describe('AccountCredentialStore', () => {
  it('saves, reads back, and clears the remembered credential', async () => {
    const store = new AccountCredentialStore(tempFilePath(), fakeStorage())
    await store.save(record.identifier, record.password)
    await expect(store.read()).resolves.toEqual(record)
    await store.clear()
    await expect(store.read()).resolves.toBeNull()
  })

  it('degrades to "nothing remembered" when encryption is unavailable, and never writes plaintext', async () => {
    const filePath = tempFilePath()
    const unavailable = fakeStorage({ isEncryptionAvailable: () => false })
    const store = new AccountCredentialStore(filePath, unavailable)
    await store.save(record.identifier, record.password)
    expect(fs.existsSync(filePath)).toBe(false)
    await expect(store.read()).resolves.toBeNull()
  })

  it('reads null from a file another OS profile encrypted (decrypt failure degrades, not throws)', async () => {
    const filePath = tempFilePath()
    const store = new AccountCredentialStore(filePath, fakeStorage())
    await store.save(record.identifier, record.password)
    const foreign = new AccountCredentialStore(filePath, fakeStorage({
      decryptString: () => { throw new Error('DPAPI key mismatch') },
    }))
    await expect(foreign.read()).resolves.toBeNull()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { managedCliKeyProfiles, providerIds, type ProviderId } from './catalog'
import {
  ManagedCliKeyStore,
  decodePersistedManagedCliKeys,
  encodePersistedManagedCliKeys,
  isPersistedManagedCliKeys,
  type PersistedManagedCliKeys,
  type StoredManagedCliKey,
} from './managed-cli-key-store'
import type { SafeStorageLike } from './account-session-store'

const temporaryDirectories: string[] = []

function temporaryFilePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-cli-key-store-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'nested', 'managed-cli-keys.dat')
}

function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`managed-key-v1:${plainText}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('managed-key-v1:')) throw new Error('ciphertext not recognized')
      return text.slice('managed-key-v1:'.length)
    },
    ...overrides,
  }
}

function managedKey(provider: ProviderId, suffix = provider): StoredManagedCliKey {
  const profile = managedCliKeyProfiles[provider]
  return {
    id: providerIds.indexOf(provider) + 1,
    provider,
    group: profile.group,
    name: profile.keyName,
    key: `sk-${suffix}-managed-secret-123456`,
  }
}

function persistedRecord(userId = 42): PersistedManagedCliKeys {
  return {
    version: 2,
    accounts: [{
      userId,
      updatedAt: '2026-08-11T00:00:00.000Z',
      keys: providerIds.map((provider) => managedKey(provider)),
    }],
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('managed CLI key safeStorage codec', () => {
  it('round-trips all provider keys through safeStorage encryption', () => {
    const storage = fakeSafeStorage()
    const record = persistedRecord()

    const encoded = encodePersistedManagedCliKeys(record, storage)

    expect(decodePersistedManagedCliKeys(encoded, storage)).toEqual(record)
    for (const account of record.accounts) {
      for (const entry of account.keys) expect(encoded).not.toContain(entry.key)
    }
  })

  it('rejects records with duplicate providers or a provider/group mismatch', () => {
    const record = persistedRecord()
    const account = record.accounts[0]
    expect(isPersistedManagedCliKeys(record)).toBe(true)
    expect(isPersistedManagedCliKeys({
      ...record,
      accounts: [{ ...account, keys: [account.keys[0], { ...account.keys[0] }] }],
    })).toBe(false)
    expect(isPersistedManagedCliKeys({
      ...record,
      accounts: [{ ...account, keys: [{ ...account.keys[0], group: 'wrong-group' }] }],
    })).toBe(false)
  })

  it('migrates the original single-account payload without contacting the server', () => {
    const storage = fakeSafeStorage()
    const legacy = {
      version: 1,
      userId: 42,
      updatedAt: '2026-08-11T00:00:00.000Z',
      keys: providerIds.map((provider) => managedKey(provider)),
    }

    const encoded = storage.encryptString(JSON.stringify(legacy)).toString('base64')

    expect(decodePersistedManagedCliKeys(encoded, storage)).toEqual({
      version: 2,
      accounts: [{
        userId: legacy.userId,
        updatedAt: legacy.updatedAt,
        keys: legacy.keys,
      }],
    })
  })

  it('degrades corrupted, foreign, and malformed ciphertext to null', () => {
    const storage = fakeSafeStorage()
    expect(decodePersistedManagedCliKeys('not-valid-ciphertext', storage)).toBeNull()
    expect(decodePersistedManagedCliKeys(
      Buffer.from('foreign-ciphertext', 'utf8').toString('base64'),
      storage,
    )).toBeNull()
    const malformed = storage.encryptString('{not-json').toString('base64')
    expect(decodePersistedManagedCliKeys(malformed, storage)).toBeNull()
  })
})

describe('ManagedCliKeyStore', () => {
  it('persists ciphertext and only returns keys for the matching userId', async () => {
    const filePath = temporaryFilePath()
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage())
    const keys = providerIds.map((provider) => managedKey(provider))

    await store.save(42, keys)

    expect(fs.existsSync(filePath)).toBe(true)
    const onDisk = fs.readFileSync(filePath, 'utf8')
    for (const entry of keys) expect(onDisk).not.toContain(entry.key)
    await expect(store.read(42)).resolves.toEqual(keys)
    await expect(store.read(99)).resolves.toEqual([])
  })

  it('keeps independent encrypted caches when users switch accounts', async () => {
    const filePath = temporaryFilePath()
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage())
    const firstUserKeys = providerIds.map((provider) => managedKey(provider))
    const secondUserKeys = providerIds.map((provider) => ({
      ...managedKey(provider),
      id: managedKey(provider).id + 100,
      key: `sk-${provider}-second-user-secret-123456`,
    }))

    await store.save(42, firstUserKeys)
    await store.save(99, secondUserKeys)

    await expect(store.read(42)).resolves.toEqual(firstUserKeys)
    await expect(store.read(99)).resolves.toEqual(secondUserKeys)
    const onDisk = fs.readFileSync(filePath, 'utf8')
    for (const entry of [...firstUserKeys, ...secondUserKeys]) expect(onDisk).not.toContain(entry.key)
  })

  it('rejects a corrupted cache instead of silently treating it as a server miss', async () => {
    const filePath = temporaryFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'broken encrypted payload', 'utf8')
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage())

    await expect(store.read(42)).rejects.toThrow('本地托管 API Key 配置已损坏或无法解密')
  })

  it('quarantines a corrupted cache and rebuilds it on the next save', async () => {
    const filePath = temporaryFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'broken encrypted payload', 'utf8')
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage())

    await expect(store.save(42, [managedKey('codex')])).resolves.toBe(true)

    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readdirSync(path.dirname(filePath)).some((name) => name.startsWith('managed-cli-keys.dat.corrupt-'))).toBe(true)
    await expect(store.read(42)).resolves.toEqual([managedKey('codex')])
  })

  it('removes a key only from the matching user record', async () => {
    const store = new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage())
    const keys = providerIds.map((provider) => managedKey(provider))
    await store.save(42, keys)

    await store.remove(99, managedKey('codex').id)
    await expect(store.read(42)).resolves.toEqual(keys)

    await store.remove(42, managedKey('codex').id)
    await expect(store.read(42)).resolves.toEqual(
      keys.filter((entry) => entry.provider !== 'codex'),
    )
  })

  it('fails explicitly without reading the server when OS encryption is unavailable', async () => {
    const filePath = temporaryFilePath()
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage({
      isEncryptionAvailable: () => false,
    }))

    await expect(store.save(42, [managedKey('codex')]))
      .rejects.toThrow('系统安全存储不可用，无法持久化托管 API Key')

    expect(fs.existsSync(filePath)).toBe(false)
    await expect(store.read(42)).rejects.toThrow('系统安全存储不可用，无法持久化托管 API Key')
  })
})

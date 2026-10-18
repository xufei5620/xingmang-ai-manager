import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { managedCliKeyProfiles, sub2ApiManagedCliKeyProfiles, providerIds, type ProviderId } from './catalog'
import {
  ManagedCliKeyStore,
  decodePersistedManagedCliKeys,
  encodePersistedManagedCliKeys,
  isPersistedManagedCliKeys,
  isReplacedManagedKey,
  managedKeyDigest,
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

  it('rejects duplicate providers and keeps old unscoped records on their original group names', () => {
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

  it('accepts safe renamed groups only with an explicit matching site', () => {
    const record = persistedRecord()
    record.siteId = 'solov'
    record.accounts[0].keys[1].group = 'Codex-Professional-Relay'

    expect(isPersistedManagedCliKeys(record, 'solov')).toBe(true)
    expect(isPersistedManagedCliKeys(record, 'solov-api')).toBe(false)
    expect(isPersistedManagedCliKeys({ ...record, siteId: undefined }, 'solov')).toBe(false)
    expect(isPersistedManagedCliKeys({ ...record, siteId: 'unknown' }, 'solov')).toBe(false)
  })

  it('rejects unsafe dynamic groups without weakening the other key fields', () => {
    const record = persistedRecord()
    record.siteId = 'solov'
    const original = record.accounts[0].keys[1]
    for (const group of ['', ' Codex 专用', 'x'.repeat(129), 'Codex\u0000专用', 'Codex\u007f专用']) {
      expect(isPersistedManagedCliKeys({
        ...record,
        accounts: [{ ...record.accounts[0], keys: [{ ...original, group }] }],
      })).toBe(false)
    }
    expect(isPersistedManagedCliKeys({
      ...record,
      accounts: [{ ...record.accounts[0], keys: [{ ...original, id: 0 }] }],
    })).toBe(false)
    expect(isPersistedManagedCliKeys({
      ...record,
      accounts: [{ ...record.accounts[0], keys: [{ ...original, key: 'not-a-key' }] }],
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

  it('rethrows a non-decrypt read failure instead of discarding every cached account', async () => {
    const filePath = temporaryFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage())
    await store.save(42, providerIds.map((provider) => managedKey(provider)))
    const intact = fs.readFileSync(filePath, 'utf8')
    // A file larger than the read limit is rejected before any decryption is
    // attempted -- the same class as an nlink !== 1 or mid-read change that an
    // antivirus scanner or a sync client can produce at any moment.
    fs.appendFileSync(filePath, 'x'.repeat(64 * 1024))

    await expect(store.save(99, [managedKey('codex')])).rejects.toThrow('超过 64 KB 安全上限')

    expect(fs.readFileSync(filePath, 'utf8').startsWith(intact)).toBe(true)
    expect(fs.readdirSync(path.dirname(filePath)).some((name) => name.includes('.corrupt-'))).toBe(false)
  })

  it('keeps at most three quarantined copies of a damaged cache', async () => {
    const filePath = temporaryFilePath()
    const directory = path.dirname(filePath)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(filePath, 'broken encrypted payload', 'utf8')
    for (const stamp of [1, 2, 3, 4, 5]) {
      fs.writeFileSync(`${filePath}.corrupt-${stamp}`, 'older damaged payload', 'utf8')
    }
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage())

    await expect(store.save(42, [managedKey('codex')])).resolves.toBe(true)

    const quarantined = fs.readdirSync(directory).filter((name) => name.includes('.corrupt-'))
    expect(quarantined).toHaveLength(3)
    expect(quarantined.some((name) => name.endsWith('.corrupt-1'))).toBe(false)
    expect(quarantined.some((name) => name.endsWith('.corrupt-5'))).toBe(true)
  })

  it('refuses to persist through safeStorage\'s plaintext backend', async () => {
    const filePath = temporaryFilePath()
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage({
      getSelectedStorageBackend: () => 'basic_text',
    }))

    await expect(store.save(42, [managedKey('codex')])).rejects.toThrow('已拒绝写入托管 API Key')
    await expect(store.read(42)).rejects.toThrow('已拒绝写入托管 API Key')
    expect(fs.existsSync(filePath)).toBe(false)
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


describe('managed key realm validation', () => {
  it('persists dynamic groups only in the explicitly selected realm store', async () => {
    const file = temporaryFilePath()
    const cipher = fakeSafeStorage()
    const apiKeys = providerIds.map((provider) => ({
      ...managedKey(provider),
      group: provider === 'codex' ? 'Codex-Professional-Relay' : sub2ApiManagedCliKeyProfiles[provider].group,
    }))
    const api = new ManagedCliKeyStore(file, cipher, 'solov-api')
    await expect(api.save(7, apiKeys)).resolves.toBe(true)
    expect(await new ManagedCliKeyStore(file, cipher, 'solov-api').read(7)).toEqual(apiKeys)
    await expect(new ManagedCliKeyStore(file, cipher).read(7)).rejects.toThrow('已损坏或无法解密')
    expect(await api.read(7)).toEqual(apiKeys)
  })
})

describe('ManagedCliKeyStore session-only mode (Linux without a keyring)', () => {
  it('keeps keys for this run without a usable keyring and never creates the file', async () => {
    const filePath = temporaryFilePath()
    const store = new ManagedCliKeyStore(filePath, fakeSafeStorage({
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'basic_text',
    }), 'solov', 'session-only')

    await expect(store.save(42, [managedKey('codex'), managedKey('claude')])).resolves.toBe(true)
    await expect(store.read(42)).resolves.toEqual([managedKey('codex'), managedKey('claude')])
    await store.remove(42, managedKey('codex').id)
    await expect(store.read(42)).resolves.toEqual([managedKey('claude')])
    await expect(store.read(7)).resolves.toEqual([])
    expect(fs.existsSync(path.dirname(filePath))).toBe(false)
  })

  it('rejects a stale save the same way the file cache does', async () => {
    const store = new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage(), 'solov', 'session-only')
    const revision = store.captureRevision()
    await store.save(42, [managedKey('codex')])
    await expect(store.save(42, [managedKey('gemini')], revision)).resolves.toBe(false)
    await expect(store.read(42)).resolves.toEqual([managedKey('codex')])
  })

  it('hands out copies, so a caller cannot edit the cached record', async () => {
    const store = new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage(), 'solov', 'session-only')
    await store.save(42, [managedKey('codex')])
    const [entry] = await store.read(42)
    entry.key = 'sk-tampered-value-123456'
    await expect(store.read(42)).resolves.toEqual([managedKey('codex')])
  })

  it('keeps refusing in the default durable mode', async () => {
    const store = new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage({ isEncryptionAvailable: () => false }))
    await expect(store.read(42)).rejects.toThrow('系统安全存储不可用')
  })
})

// xm 站 2026-10-16 删掉的老分组名，按 catalog.ts 逐字抄写。
const retiredXmGroups: Record<ProviderId, string> = {
  claude: 'Claude-MAX订阅',
  codex: 'GPT-中转/订阅',
  grok: 'Grok-中转/订阅',
  gemini: 'Gemini-中转/订阅',
}

function writeRecord(filePath: string, record: PersistedManagedCliKeys, storage: SafeStorageLike): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, encodePersistedManagedCliKeys(record, storage))
}

describe('group names the xm site retired', () => {
  it('still reads a cache an old version wrote before it recorded the site, under the current names', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    const record = persistedRecord()
    record.accounts[0].keys = record.accounts[0].keys.map((entry) => ({ ...entry, group: retiredXmGroups[entry.provider] }))
    writeRecord(filePath, record, storage)

    expect(isPersistedManagedCliKeys(record, 'solov')).toBe(true)
    // 历史账号那套后端从没用过这些名字。
    expect(isPersistedManagedCliKeys(record, 'solov-api')).toBe(false)
    expect(await new ManagedCliKeyStore(filePath, storage).read(42)).toEqual(providerIds.map((provider) => managedKey(provider)))
  })

  it('hands out the current name for a key a later version cached under the old one', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    const record = persistedRecord()
    record.siteId = 'solov'
    record.accounts[0].keys = record.accounts[0].keys.map((entry) => (
      entry.provider === 'codex' ? { ...entry, group: retiredXmGroups.codex } : entry.provider === 'claude' ? { ...entry, group: 'Claude AWS-B' } : entry
    ))
    writeRecord(filePath, record, storage)

    const keys = await new ManagedCliKeyStore(filePath, storage, 'solov').read(42)
    expect(keys.find((entry) => entry.provider === 'codex')?.group).toBe('GPT')
    // 用户自己挑的、不是老名字的分组不动。
    expect(keys.find((entry) => entry.provider === 'claude')?.group).toBe('Claude AWS-B')
  })

  it('leaves the history account cache alone', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    const keys = providerIds.map((provider) => ({ ...managedKey(provider), group: provider === 'codex' ? retiredXmGroups.codex : sub2ApiManagedCliKeyProfiles[provider].group }))
    const store = new ManagedCliKeyStore(filePath, storage, 'solov-api')
    await store.save(7, keys)
    expect(await store.read(7)).toEqual(keys)
  })
})

// #1153：开机补写只认「缓存以前给这家、后来换掉的那把」，客户自己选的那把要认得出不是。
describe('keys the cache replaced', () => {
  const replacement = (provider: ProviderId, suffix: string): StoredManagedCliKey => ({
    ...managedKey(provider), id: 100 + suffix.length, key: `sk-${provider}-${suffix}-secret-123456`,
  })

  it('remembers which key each tool had before, newest first and at most three', async () => {
    const store = new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage())
    const others = providerIds.filter((provider) => provider !== 'claude').map((provider) => managedKey(provider))
    const sequence = ['first', 'second', 'third', 'fourth', 'fifth'].map((suffix) => replacement('claude', suffix))
    for (const entry of sequence) await store.save(42, [entry, ...others])

    const keys = await store.read(42)
    expect(keys.find((entry) => entry.provider === 'claude')?.replacedKeyDigests)
      .toEqual(['fourth', 'third', 'second'].map((suffix) => managedKeyDigest(replacement('claude', suffix).key)))
    // 没换过的那几家什么也不附。
    for (const provider of providerIds.filter((entry) => entry !== 'claude')) {
      expect(keys.find((entry) => entry.provider === provider)).toEqual(managedKey(provider))
    }
  })

  it('keeps the history out of the saved entries and never stores an old key itself', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    const store = new ManagedCliKeyStore(filePath, storage)
    await store.save(42, [managedKey('codex')])
    const [current] = await store.read(42)
    await store.save(42, [{ ...current, key: replacement('codex', 'new').key, replacedKeyDigests: ['0'.repeat(64)] }])

    const record = decodePersistedManagedCliKeys(fs.readFileSync(filePath, 'utf8'), storage)
    expect(record?.accounts[0].keys[0]).not.toHaveProperty('replacedKeyDigests')
    expect(record?.accounts[0].replacedKeys).toEqual({ codex: [managedKeyDigest(managedKey('codex').key)] })
    expect(JSON.stringify(record)).not.toContain(managedKey('codex').key)
  })

  it('still remembers a key it dropped before the next one was issued', async () => {
    const store = new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage())
    await store.save(42, [managedKey('codex'), managedKey('claude')])
    // 分组被删：旧那把先从缓存里拿掉，下一轮才签出新的。
    await store.save(42, [managedKey('claude')])
    await store.save(42, [replacement('codex', 'new'), managedKey('claude')])
    expect((await store.read(42)).find((entry) => entry.provider === 'codex')?.replacedKeyDigests)
      .toEqual([managedKeyDigest(managedKey('codex').key)])

    // 失效重签：先 remove 再存新的。
    await store.remove(42, managedKey('claude').id)
    await store.save(42, [replacement('codex', 'new'), replacement('claude', 'new')])
    expect((await store.read(42)).find((entry) => entry.provider === 'claude')?.replacedKeyDigests)
      .toEqual([managedKeyDigest(managedKey('claude').key)])
  })

  it('does not count the key a tool is using now, even if it was replaced before', async () => {
    const store = new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage())
    await store.save(42, [managedKey('codex')])
    await store.save(42, [replacement('codex', 'new')])
    await store.save(42, [managedKey('codex')])
    expect((await store.read(42))[0].replacedKeyDigests).toEqual([managedKeyDigest(replacement('codex', 'new').key)])
    // 同一把 Key 只是改了分组名，不算换掉。
    await store.save(42, [{ ...managedKey('codex'), group: 'GPT' }])
    expect((await store.read(42))[0].replacedKeyDigests).toEqual([managedKeyDigest(replacement('codex', 'new').key)])
  })

  it('reads a cache whose history it cannot make sense of instead of discarding every key', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    const record = persistedRecord()
    record.siteId = 'solov'
    // 别的版本或损坏写下的形状，类型上本来就不该写得出来。
    const account = record.accounts[0] as unknown as Record<string, unknown>
    account.replacedKeys = { codex: ['not-a-digest', 42], claude: 'nope', unknown: [managedKeyDigest('sk-x')] }
    writeRecord(filePath, record, storage)
    expect(await new ManagedCliKeyStore(filePath, storage, 'solov').read(42)).toEqual(providerIds.map((provider) => managedKey(provider)))

    account.replacedKeys = ['codex']
    expect(isPersistedManagedCliKeys(record, 'solov')).toBe(false)
  })

  it('recognises only a replaced key of the same tool that is not the current one', () => {
    const old = managedKey('codex').key
    const cached = [{ ...replacement('codex', 'new'), replacedKeyDigests: [managedKeyDigest(old)] }]
    expect(isReplacedManagedKey('codex', old, cached)).toBe(true)
    expect(isReplacedManagedKey('codex', 'sk-customer-chosen-secret-123456', cached)).toBe(false)
    expect(isReplacedManagedKey('codex', cached[0].key, cached)).toBe(false)
    expect(isReplacedManagedKey('claude', old, cached)).toBe(false)
    expect(isReplacedManagedKey('codex', old, [])).toBe(false)
    expect(isReplacedManagedKey('codex', '', cached)).toBe(false)
  })
})

describe('the cached group check (#1157 item 8)', () => {
  const check = { at: Date.parse('2026-10-18T02:00:00.000Z'), succeeded: true, hints: managedKeyDigest('hints') }

  it('remembers the last group check across a restart without bumping the key revision', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    const keys = providerIds.map((provider) => managedKey(provider))
    const store = new ManagedCliKeyStore(filePath, storage)
    await store.save(42, keys)
    await store.read(42)
    const revision = store.captureRevision()

    await store.saveGroupCheck(42, check)

    expect(store.captureRevision()).toBe(revision)
    await expect(new ManagedCliKeyStore(filePath, storage).readGroupCheck(42)).resolves.toEqual(check)
    // 同步那一轮记下查过以后再存换好的 Key，不能被当成「缓存被别的操作改过」。
    await expect(store.save(42, [{ ...managedKey('codex'), id: 500, key: 'sk-codex-replacement-secret-123456' }], revision)).resolves.toBe(true)
    await expect(store.readGroupCheck(42)).resolves.toEqual(check)
    await store.remove(42, 500)
    await expect(store.readGroupCheck(42)).resolves.toEqual(check)
  })

  it('records nothing for an account without cached keys and keeps checks apart per account', async () => {
    const store = new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage())
    await store.saveGroupCheck(42, check)
    await expect(store.readGroupCheck(42)).resolves.toBeUndefined()

    await store.save(42, [managedKey('codex')])
    await store.save(7, [managedKey('claude')])
    await store.saveGroupCheck(42, check)
    await expect(store.readGroupCheck(42)).resolves.toEqual(check)
    await expect(store.readGroupCheck(7)).resolves.toBeUndefined()
  })

  it('reads a check it cannot make sense of as never checked, keeping every key', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    for (const groupCheck of [
      'yesterday',
      { ...check, at: -1 },
      { ...check, at: 1.5 },
      { ...check, succeeded: 'yes' },
      { ...check, hints: '[["GPT"]]' },
    ]) {
      const record = persistedRecord()
      ;(record.accounts[0] as unknown as Record<string, unknown>).groupCheck = groupCheck
      writeRecord(filePath, record, storage)
      const store = new ManagedCliKeyStore(filePath, storage)
      await expect(store.read(42)).resolves.toEqual(providerIds.map((provider) => managedKey(provider)))
      await expect(store.readGroupCheck(42)).resolves.toBeUndefined()
    }
    // 没对照时指纹是空串。
    const record = persistedRecord()
    record.accounts[0].groupCheck = { ...check, hints: '' }
    writeRecord(filePath, record, storage)
    await expect(new ManagedCliKeyStore(filePath, storage).readGroupCheck(42)).resolves.toEqual({ ...check, hints: '' })
  })

  it('answers never checked when the cache cannot be read', async () => {
    const filePath = temporaryFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'not ciphertext')
    await expect(new ManagedCliKeyStore(filePath, fakeSafeStorage()).readGroupCheck(42)).resolves.toBeUndefined()
    await expect(new ManagedCliKeyStore(temporaryFilePath(), fakeSafeStorage({ isEncryptionAvailable: () => false })).readGroupCheck(42))
      .resolves.toBeUndefined()
  })
})

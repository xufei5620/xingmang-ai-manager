import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatKeyQuotaExhaustedMessage } from './account-key-quota'
import type { SafeStorageLike } from './account-session-store'
import { createChatCredentialCoordinator } from './chat-credential-coordinator'
import {
  ChatKeyStore,
  decodePersistedChatKeys,
  encodePersistedChatKeys,
  isPersistedChatKeys,
  pruneChatKeys,
  renameRetiredChatKeyGroups,
  type PersistedChatKeys,
  type StoredChatKey,
} from './chat-key-store'

const temporaryDirectories: string[] = []

function temporaryFilePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-chat-key-store-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'nested', 'chat-keys.dat')
}

function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`chat-key-v1:${plainText}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('chat-key-v1:')) throw new Error('ciphertext not recognized')
      return text.slice('chat-key-v1:'.length)
    },
    ...overrides,
  }
}

// Stands in for the cipher the cache was written with before the OS key behind
// safeStorage changed: an administrator reset the Windows password, the macOS
// "Safe Storage" keychain item was deleted, or the data folder moved machines.
function previousOsKeyStorage(): SafeStorageLike {
  return fakeSafeStorage({
    encryptString: (plainText) => Buffer.from(`chat-key-old:${plainText}`, 'utf8'),
  })
}

function quarantinedCopies(filePath: string): string[] {
  const prefix = `${path.basename(filePath)}.corrupt-`
  return fs.readdirSync(path.dirname(filePath)).filter((name) => name.startsWith(prefix))
}

function chatKey(userId: number, group: string, keyId = 1): StoredChatKey {
  return {
    userId,
    group,
    keyId,
    keyName: `chat-key-${keyId}`,
    key: `sk-${userId}-${keyId}-chat-secret-value`,
  }
}

// Writes a cache file the way the store would have left it, in one write instead of one
// durable atomic write per entry.
function seedStore(filePath: string, storage: SafeStorageLike, keys: StoredChatKey[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, encodePersistedChatKeys({ version: 1, keys }, storage), 'utf8')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('chat key safeStorage codec', () => {
  it('round-trips dynamic groups without exposing plaintext keys', () => {
    const storage = fakeSafeStorage()
    const record: PersistedChatKeys = {
      version: 1,
      keys: [
        chatKey(42, 'codex-pro', 1),
        chatKey(42, 'Claude-MAX(不限制客户端)-5m', 2),
        chatKey(42, '生图分组', 3),
      ],
    }

    const encoded = encodePersistedChatKeys(record, storage)

    expect(decodePersistedChatKeys(encoded, storage)).toEqual(record)
    for (const entry of record.keys) expect(encoded).not.toContain(entry.key)
  })

  it('rejects duplicate user/group pairs, duplicate key ids, and invalid fields', () => {
    const first = chatKey(42, 'codex-pro', 1)
    expect(isPersistedChatKeys({ version: 1, keys: [first] })).toBe(true)
    expect(isPersistedChatKeys({ version: 1, keys: [first, { ...first, keyId: 2 }] })).toBe(false)
    expect(isPersistedChatKeys({ version: 1, keys: [first, { ...first, group: 'Gemini' }] })).toBe(false)
    expect(isPersistedChatKeys({ version: 1, keys: [{ ...first, group: `bad\ngroup` }] })).toBe(false)
    expect(isPersistedChatKeys({ version: 1, keys: [{ ...first, key: 'not-a-relay-key' }] })).toBe(false)
    expect(isPersistedChatKeys({ version: 1, keys: [{ ...first, key: 'sk-secret with-space' }] })).toBe(false)
  })

  it('degrades corrupted, foreign, and malformed ciphertext to null', () => {
    const storage = fakeSafeStorage()
    expect(decodePersistedChatKeys('not-valid-ciphertext', storage)).toBeNull()
    expect(decodePersistedChatKeys(
      Buffer.from('foreign-ciphertext', 'utf8').toString('base64'),
      storage,
    )).toBeNull()
    expect(decodePersistedChatKeys(
      storage.encryptString('{not-json').toString('base64'),
      storage,
    )).toBeNull()
  })
})

describe('pruneChatKeys', () => {
  it('keeps the 32 newest groups of an account and drops the rest', () => {
    const newestFirst = Array.from({ length: 40 }, (_, index) => chatKey(42, `group-${40 - index}`, 40 - index))
    const kept = pruneChatKeys(newestFirst)
    expect(kept.map((entry) => entry.group)).toEqual(newestFirst.slice(0, 32).map((entry) => entry.group))
  })

  it('keeps the 16 most recently used accounts and every group they own', () => {
    const newestFirst = Array.from({ length: 20 }, (_, index) => [
      chatKey(20 - index, 'codex-pro', (20 - index) * 10),
      chatKey(20 - index, 'claude-pro', (20 - index) * 10 + 1),
    ]).flat()
    const kept = pruneChatKeys(newestFirst)
    expect([...new Set(kept.map((entry) => entry.userId))]).toEqual(Array.from({ length: 16 }, (_, index) => 20 - index))
    expect(kept).toHaveLength(32)
  })

  it('caps the whole cache at 128 keys even when every account is within its own bound', () => {
    const newestFirst = Array.from({ length: 16 }, (_, account) =>
      Array.from({ length: 10 }, (_, group) => chatKey(account + 1, `group-${group}`, account * 100 + group + 1))).flat()
    const kept = pruneChatKeys(newestFirst)
    expect(kept).toHaveLength(128)
    expect(kept).toEqual(newestFirst.slice(0, 128))
  })

  it('returns copies, so trimming never aliases the caller\'s entries', () => {
    const entry = chatKey(42, 'codex-pro')
    const [kept] = pruneChatKeys([entry])
    expect(kept).toEqual(entry)
    expect(kept).not.toBe(entry)
  })
})

describe('ChatKeyStore', () => {
  it('persists ciphertext and isolates records by account', async () => {
    const filePath = temporaryFilePath()
    const store = new ChatKeyStore(filePath, fakeSafeStorage())
    const first = chatKey(42, 'codex-pro', 1)
    const second = chatKey(99, 'codex-pro', 2)

    await store.upsert(first)
    await store.upsert(second)

    await expect(store.read(42)).resolves.toEqual([first])
    await expect(store.read(99)).resolves.toEqual([second])
    const onDisk = fs.readFileSync(filePath, 'utf8')
    expect(onDisk).not.toContain(first.key)
    expect(onDisk).not.toContain(second.key)
  })

  it('replaces the matching group and cannot retain one server key id under two groups', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage())
    await store.upsert(chatKey(42, 'codex-pro', 1))
    const replacement = { ...chatKey(42, 'codex-pro', 2), keyName: 'replacement' }
    await store.upsert(replacement)
    await expect(store.read(42)).resolves.toEqual([replacement])

    const moved = { ...replacement, group: 'Gemini', keyName: 'moved' }
    await store.upsert(moved)
    await expect(store.read(42)).resolves.toEqual([moved])
  })

  // Both bounds used to be reached by upserting one entry at a time, 33 and 17 durable atomic
  // writes in a row, and on a busy Windows runner the 33 took longer than the 15s this case had
  // been widened to (#511). The trimming is proven on the pure function below; here the file is
  // seeded at the bound in one write, so a single upsert shows the store really applies it.
  it('drops the least recently upserted group once an account holds 32', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    const newestFirst = Array.from({ length: 32 }, (_, index) => chatKey(42, `dynamic-group-${32 - index}`, 32 - index))
    seedStore(filePath, storage, newestFirst)
    const store = new ChatKeyStore(filePath, storage)

    await store.upsert(chatKey(42, 'dynamic-group-33', 33))

    const keys = await store.read(42)
    expect(keys).toHaveLength(32)
    expect(keys[0].group).toBe('dynamic-group-33')
    expect(keys.some((entry) => entry.group === 'dynamic-group-1')).toBe(false)
  })

  it('drops the least recently used account once the cache holds 16', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    seedStore(filePath, storage, Array.from({ length: 16 }, (_, index) => chatKey(16 - index, 'codex-pro', 16 - index)))
    const store = new ChatKeyStore(filePath, storage)

    await store.upsert(chatKey(17, 'codex-pro', 17))

    await expect(store.read(1)).resolves.toEqual([])
    await expect(store.read(2)).resolves.toEqual([chatKey(2, 'codex-pro', 2)])
    await expect(store.read(17)).resolves.toEqual([chatKey(17, 'codex-pro', 17)])
  })

  it('removes only the requested account', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage())
    const first = chatKey(42, '生图分组', 1)
    const second = chatKey(99, 'Gemini', 2)
    await store.upsert(first)
    await store.upsert(second)

    await store.removeAccount(42)

    await expect(store.read(42)).resolves.toEqual([])
    await expect(store.read(99)).resolves.toEqual([second])
  })

  it('removes a group or a revoked server key without touching other cached keys', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage())
    const first = chatKey(42, 'codex-pro', 1)
    const second = chatKey(42, 'Gemini', 2)
    await expect(store.upsert(first)).resolves.toBe(true)
    await expect(store.upsert(second)).resolves.toBe(true)

    await store.remove(42, 'codex-pro')
    await expect(store.read(42)).resolves.toEqual([second])

    await store.removeByKeyId(42, 2)
    await expect(store.read(42)).resolves.toEqual([])
  })

  it('rejects an in-flight stale upsert after a key invalidation revision changes', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage())
    const revision = store.captureRevision()

    await store.removeByKeyId(42, 7)
    await expect(store.upsert(chatKey(42, 'codex-pro', 7), revision)).resolves.toBe(false)
    await expect(store.read(42)).resolves.toEqual([])

    const currentRevision = store.captureRevision()
    await expect(store.upsert(chatKey(42, 'codex-pro', 8), currentRevision)).resolves.toBe(true)
    await expect(store.read(42)).resolves.toEqual([chatKey(42, 'codex-pro', 8)])
  })

  it('reads a cache the current OS key cannot decrypt as empty and never rewrites it from a read or removal', async () => {
    const filePath = temporaryFilePath()
    seedStore(filePath, previousOsKeyStorage(), [chatKey(42, 'codex-pro', 1)])
    const damaged = fs.readFileSync(filePath, 'utf8')
    const store = new ChatKeyStore(filePath, fakeSafeStorage())

    await expect(store.read(42)).resolves.toEqual([])
    await expect(store.remove(42, 'codex-pro')).resolves.toBeUndefined()
    await expect(store.removeByKeyId(42, 1)).resolves.toBeUndefined()
    await expect(store.removeAccount(42)).resolves.toBeUndefined()

    expect(fs.readFileSync(filePath, 'utf8')).toBe(damaged)
    expect(quarantinedCopies(filePath)).toEqual([])
  })

  it('moves an undecryptable cache aside and stores the freshly signed key on the next upsert', async () => {
    const filePath = temporaryFilePath()
    seedStore(filePath, previousOsKeyStorage(), [chatKey(42, 'codex-pro', 1), chatKey(99, 'GPT', 2)])
    const damaged = fs.readFileSync(filePath, 'utf8')
    const store = new ChatKeyStore(filePath, fakeSafeStorage())

    await expect(store.upsert(chatKey(42, 'codex-pro', 3))).resolves.toBe(true)

    await expect(store.read(42)).resolves.toEqual([chatKey(42, 'codex-pro', 3)])
    await expect(store.read(99)).resolves.toEqual([])
    const copies = quarantinedCopies(filePath)
    expect(copies).toHaveLength(1)
    expect(fs.readFileSync(path.join(path.dirname(filePath), copies[0]), 'utf8')).toBe(damaged)
  })

  it('treats malformed ciphertext like an undecryptable cache', async () => {
    const filePath = temporaryFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'broken encrypted payload', 'utf8')
    const store = new ChatKeyStore(filePath, fakeSafeStorage())

    await expect(store.read(42)).resolves.toEqual([])
    await expect(store.upsert(chatKey(42, 'codex-pro', 1))).resolves.toBe(true)

    await expect(store.read(42)).resolves.toEqual([chatKey(42, 'codex-pro', 1)])
    expect(quarantinedCopies(filePath)).toHaveLength(1)
  })

  it('leaves the cache in place when the OS cipher cannot round-trip a probe either', async () => {
    const filePath = temporaryFilePath()
    seedStore(filePath, fakeSafeStorage(), [chatKey(42, 'codex-pro', 1)])
    const intact = fs.readFileSync(filePath, 'utf8')
    // A keyring that answers but cannot decrypt anything right now says
    // nothing about the file, which may read fine once the keyring recovers.
    const store = new ChatKeyStore(filePath, fakeSafeStorage({
      decryptString: () => { throw new Error('keyring locked') },
    }))

    await expect(store.read(42)).resolves.toEqual([])
    await expect(store.upsert(chatKey(42, 'codex-pro', 3)))
      .rejects.toThrow('本地 AI 聊天分组 API Key 配置已损坏或无法解密')

    expect(fs.readFileSync(filePath, 'utf8')).toBe(intact)
    expect(quarantinedCopies(filePath)).toEqual([])
    await expect(new ChatKeyStore(filePath, fakeSafeStorage()).read(42)).resolves.toEqual([chatKey(42, 'codex-pro', 1)])
  })

  it('rethrows a non-decrypt read failure instead of discarding the cache', async () => {
    const filePath = temporaryFilePath()
    seedStore(filePath, fakeSafeStorage(), [chatKey(42, 'codex-pro', 1)])
    const intact = fs.readFileSync(filePath, 'utf8')
    // A file over the read limit is rejected before any decryption is
    // attempted -- the same class as an nlink !== 1 or mid-read change that an
    // antivirus scanner or a sync client can produce at any moment.
    fs.appendFileSync(filePath, 'x'.repeat(256 * 1024))
    const store = new ChatKeyStore(filePath, fakeSafeStorage())

    await expect(store.read(42)).rejects.toThrow('超过 256 KB 安全上限')
    await expect(store.upsert(chatKey(42, 'codex-pro', 3))).rejects.toThrow('超过 256 KB 安全上限')
    await expect(store.removeAccount(42)).rejects.toThrow('超过 256 KB 安全上限')

    expect(fs.readFileSync(filePath, 'utf8').startsWith(intact)).toBe(true)
    expect(quarantinedCopies(filePath)).toEqual([])
  })

  it('keeps at most three quarantined copies of a damaged cache', async () => {
    const filePath = temporaryFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'broken encrypted payload', 'utf8')
    for (const stamp of [1, 2, 3, 4, 5]) {
      fs.writeFileSync(`${filePath}.corrupt-${stamp}`, 'older damaged payload', 'utf8')
    }
    const store = new ChatKeyStore(filePath, fakeSafeStorage())

    await expect(store.upsert(chatKey(42, 'codex-pro', 1))).resolves.toBe(true)

    const copies = quarantinedCopies(filePath)
    expect(copies).toHaveLength(3)
    expect(copies.some((name) => name.endsWith('.corrupt-1'))).toBe(false)
    expect(copies.some((name) => name.endsWith('.corrupt-5'))).toBe(true)
    expect(copies.some((name) => name.endsWith('.corrupt-3'))).toBe(false)
  })

  it('gets AI chat working again after the OS key changed and reuses the replacement key afterwards', async () => {
    const filePath = temporaryFilePath()
    seedStore(filePath, previousOsKeyStorage(), [{ ...chatKey(7, 'GPT', 3), keyName: 'xingmang-chat-1' }])
    const provisionCliKey = vi.fn(async () => ({ id: 10, name: 'xingmang-chat-2', key: 'sk-7-10-replacement-chat-key' }))
    const coordinator = createChatCredentialCoordinator({
      accountService: {
        getSessionState: () => ({ authenticated: true, account: { userId: 7 } }),
        getSessionRevision: () => 0,
        getActiveSiteId: () => 'solov',
        listUsableGroups: async () => [{ name: 'GPT', description: '', ratio: 1 }],
        provisionCliKey,
        listKeys: async () => ({ page: 1, pageSize: 100, total: 0, keys: [] }),
      } as unknown as Parameters<typeof createChatCredentialCoordinator>[0]['accountService'],
      keyStore: new ChatKeyStore(filePath, fakeSafeStorage()),
      modelService: { fetchAvailableModels: async () => ['gpt-5.5'] },
    })

    const first = await coordinator.resolveCredential('GPT')
    expect(first).toMatchObject({ keyCreated: true, apiKey: 'sk-7-10-replacement-chat-key', keyId: 10 })
    expect(first.storageWarning).toBeUndefined()
    expect(quarantinedCopies(filePath)).toHaveLength(1)

    await expect(coordinator.resolveCredential('GPT'))
      .resolves.toMatchObject({ keyCreated: false, apiKey: 'sk-7-10-replacement-chat-key', keyId: 10 })
    expect(provisionCliKey).toHaveBeenCalledTimes(1)
  })

  it('stops hiding a group once its failed removal is over, instead of re-signing forever', async () => {
    const filePath = temporaryFilePath()
    const entry = chatKey(42, 'codex-pro', 1)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      encodePersistedChatKeys({ version: 1, keys: [entry] }, fakeSafeStorage()),
      'utf8',
    )
    const store = new ChatKeyStore(filePath, fakeSafeStorage({
      encryptString: () => { throw new Error('OS 密钥不可用') },
    }))

    await expect(store.remove(42, 'codex-pro')).rejects.toThrow('OS 密钥不可用')

    // A permanent marker would make every later visit to this group sign a new
    // server-side token; the cached key must become visible again instead.
    await expect(store.read(42)).resolves.toEqual([entry])
  })

  it('refuses to persist through safeStorage\'s plaintext backend', async () => {
    const filePath = temporaryFilePath()
    const store = new ChatKeyStore(filePath, fakeSafeStorage({
      getSelectedStorageBackend: () => 'basic_text',
    }))

    await expect(store.read(42)).rejects.toThrow('已拒绝写入AI 聊天分组 API Key')
    await expect(store.upsert(chatKey(42, 'codex-pro', 1))).rejects.toThrow('已拒绝写入AI 聊天分组 API Key')
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('fails explicitly when OS encryption is unavailable', async () => {
    const filePath = temporaryFilePath()
    const store = new ChatKeyStore(filePath, fakeSafeStorage({
      isEncryptionAvailable: () => false,
    }))

    await expect(store.read(42)).rejects.toThrow('系统安全存储不可用')
    await expect(store.upsert(chatKey(42, 'codex-pro', 1))).rejects.toThrow('系统安全存储不可用')
    await expect(store.removeAccount(42)).rejects.toThrow('系统安全存储不可用')
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('serializes concurrent upserts without losing either group', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage())

    await Promise.all([
      store.upsert(chatKey(42, 'codex-pro', 1)),
      store.upsert(chatKey(42, 'Gemini', 2)),
    ])

    await expect(store.read(42)).resolves.toEqual([
      chatKey(42, 'Gemini', 2),
      chatKey(42, 'codex-pro', 1),
    ])
  })
})

describe('ChatKeyStore session-only mode (Linux without a keyring)', () => {
  it('caches chat keys for this run without a usable keyring and never creates the file', async () => {
    const filePath = temporaryFilePath()
    const store = new ChatKeyStore(filePath, fakeSafeStorage({
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'basic_text',
    }), 'session-only')

    await expect(store.upsert(chatKey(42, 'codex-pro', 1))).resolves.toBe(true)
    await expect(store.upsert(chatKey(42, 'Gemini', 2))).resolves.toBe(true)
    await expect(store.read(42)).resolves.toEqual([chatKey(42, 'Gemini', 2), chatKey(42, 'codex-pro', 1)])
    await store.remove(42, 'Gemini')
    await expect(store.read(42)).resolves.toEqual([chatKey(42, 'codex-pro', 1)])
    await store.removeAccount(42)
    await expect(store.read(42)).resolves.toEqual([])
    expect(fs.existsSync(path.dirname(filePath))).toBe(false)
  })

  it('still rejects an upsert that raced a key invalidation', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage(), 'session-only')
    const revision = store.captureRevision()
    await store.removeByKeyId(42, 7)
    await expect(store.upsert(chatKey(42, 'codex-pro', 7), revision)).resolves.toBe(false)
    await expect(store.read(42)).resolves.toEqual([])
  })

  it('keeps refusing in the default durable mode', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage({ isEncryptionAvailable: () => false }))
    await expect(store.read(42)).rejects.toThrow('系统安全存储不可用')
  })
})

describe('group names the xm site retired', () => {
  it('reads a key cached under a retired group name under its current name', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    seedStore(filePath, storage, [chatKey(42, 'GPT-中转/订阅', 1), chatKey(42, '生图分组', 2)])
    const store = new ChatKeyStore(filePath, storage)

    await expect(store.read(42)).resolves.toEqual([
      { ...chatKey(42, 'GPT-中转/订阅', 1), group: 'GPT' },
      chatKey(42, '生图分组', 2),
    ])
  })

  it('keeps the newer key when an account cached both names and rewrites the file under the current one', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    seedStore(filePath, storage, [
      chatKey(42, 'GPT', 3),
      chatKey(42, 'GPT-中转/订阅', 1),
      chatKey(42, '图片模型-中转/订阅', 2),
    ])
    const store = new ChatKeyStore(filePath, storage)
    const image = { ...chatKey(42, '图片模型-中转/订阅', 2), group: '图片模型' }

    await expect(store.read(42)).resolves.toEqual([chatKey(42, 'GPT', 3), image])
    await store.remove(42, 'GPT')
    await expect(store.read(42)).resolves.toEqual([image])
    expect(decodePersistedChatKeys(fs.readFileSync(filePath, 'utf8'), storage)?.keys).toEqual([image])
  })

  it('leaves group names alone for the legacy relay account', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    seedStore(filePath, storage, [chatKey(42, 'GPT-中转/订阅', 1)])
    const store = new ChatKeyStore(filePath, storage, 'durable', 'solov-api')

    await expect(store.read(42)).resolves.toEqual([chatKey(42, 'GPT-中转/订阅', 1)])
  })

  it('renames per account without merging two accounts', () => {
    expect(renameRetiredChatKeyGroups([chatKey(42, 'GPT-中转/订阅', 1), chatKey(99, 'GPT', 2)]))
      .toEqual([{ ...chatKey(42, 'GPT-中转/订阅', 1), group: 'GPT' }, chatKey(99, 'GPT', 2)])
  })

  it('stops at the used-up cap of a chat key cached under a retired name instead of signing around it', async () => {
    const filePath = temporaryFilePath()
    const storage = fakeSafeStorage()
    seedStore(filePath, storage, [{ ...chatKey(7, 'GPT-中转/订阅', 3), keyName: 'xingmang-chat-1' }])
    const provisionCliKey = vi.fn(async () => ({ id: 10, name: 'xingmang-chat-2', key: 'sk-7-10-unlimited-replacement' }))
    const coordinator = createChatCredentialCoordinator({
      accountService: {
        getSessionState: () => ({ authenticated: true, account: { userId: 7 } }),
        getSessionRevision: () => 0,
        getActiveSiteId: () => 'solov',
        listUsableGroups: async () => [{ name: 'GPT', description: '', ratio: 1 }],
        provisionCliKey,
        listKeys: async () => ({ page: 1, pageSize: 100, total: 0, keys: [] }),
      } as unknown as Parameters<typeof createChatCredentialCoordinator>[0]['accountService'],
      keyStore: new ChatKeyStore(filePath, storage),
      modelService: { fetchAvailableModels: async () => { throw new Error('服务返回 429：API key 额度已用完') } },
    })

    await expect(coordinator.resolveCredential('GPT')).rejects.toThrow(chatKeyQuotaExhaustedMessage)
    expect(provisionCliKey).not.toHaveBeenCalled()
  })
})

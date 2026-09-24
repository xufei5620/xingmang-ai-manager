import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SafeStorageLike } from './account-session-store'
import {
  ChatKeyStore,
  decodePersistedChatKeys,
  encodePersistedChatKeys,
  isPersistedChatKeys,
  pruneChatKeys,
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

  it('fails closed on corruption and never overwrites the damaged file', async () => {
    const filePath = temporaryFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'broken encrypted payload', 'utf8')
    const store = new ChatKeyStore(filePath, fakeSafeStorage())

    await expect(store.read(42)).rejects.toThrow('本地 AI 聊天分组 API Key 配置已损坏或无法解密')
    await expect(store.upsert(chatKey(42, 'codex-pro', 1)))
      .rejects.toThrow('本地 AI 聊天分组 API Key 配置已损坏或无法解密')
    await expect(store.removeAccount(42))
      .rejects.toThrow('本地 AI 聊天分组 API Key 配置已损坏或无法解密')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('broken encrypted payload')
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

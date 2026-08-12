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

  it('bounds each account to its 32 most recently upserted groups', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage())
    for (let index = 1; index <= 33; index += 1) {
      await store.upsert(chatKey(42, `dynamic-group-${index}`, index))
    }

    const keys = await store.read(42)
    expect(keys).toHaveLength(32)
    expect(keys[0].group).toBe('dynamic-group-33')
    expect(keys.some((entry) => entry.group === 'dynamic-group-1')).toBe(false)
  }, 15_000) // 33 durable atomic writes can exceed Vitest's 5 s default under the full Windows suite.

  it('bounds the cache to the 16 most recently used accounts', async () => {
    const store = new ChatKeyStore(temporaryFilePath(), fakeSafeStorage())
    for (let userId = 1; userId <= 17; userId += 1) {
      await store.upsert(chatKey(userId, 'codex-pro', userId))
    }

    await expect(store.read(1)).resolves.toEqual([])
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

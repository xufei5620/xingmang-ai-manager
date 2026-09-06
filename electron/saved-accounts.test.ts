import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SafeStorageLike } from './account-session-store'
import { SavedAccountsStore, savedAccountId, type SavedAccountInput } from './saved-accounts'

const directories: string[] = []
function tempFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-saved-accounts-'))
  directories.push(directory)
  return path.join(directory, 'saved-accounts.dat')
}
function safeStorage(): SafeStorageLike {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    encryptString: vi.fn((plaintext: string) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    }),
    decryptString: vi.fn((encrypted: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
      decipher.setAuthTag(encrypted.subarray(12, 28))
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8')
    }),
  }
}
const input = (overrides: Partial<SavedAccountInput> = {}): SavedAccountInput => ({ origin: 'https://xm.example.com', userId: 42, username: 'tester', cookies: ['refresh_token=private-cookie-value'], ...overrides })
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('SavedAccountsStore', () => {
  it('returns an empty list before the first encrypted write', async () => {
    await expect(new SavedAccountsStore(tempFile(), safeStorage()).list()).resolves.toEqual([])
  })

  it('round-trips credentials only through encryption and exposes no secret in the public summary', async () => {
    const file = tempFile()
    const storage = safeStorage()
    const store = new SavedAccountsStore(file, storage)
    const account = await store.upsert(input())
    expect(storage.encryptString).toHaveBeenCalledTimes(1)
    expect(Object.keys(account).sort()).toEqual(['id', 'origin', 'updatedAt', 'userId', 'username'])
    expect(JSON.stringify(await store.list())).not.toContain('private-cookie-value')
    const content = fs.readFileSync(file, 'utf8')
    expect(content).not.toContain('private-cookie-value')
    expect(Buffer.from(content, 'base64').toString('utf8')).not.toContain('private-cookie-value')
    expect(await store.getSession(account.id, account.origin)).toEqual({ userId: 42, cookies: input().cookies })
  })

  it('normalizes the actual HTTPS origin and does not duplicate a path or default-port alias', async () => {
    const store = new SavedAccountsStore(tempFile(), safeStorage())
    const first = await store.upsert(input({ origin: 'https://XM.EXAMPLE.COM:443/account' }))
    const second = await store.upsert(input({ origin: 'https://xm.example.com/', username: 'renamed' }))
    expect(first.id).toBe(second.id)
    expect(await store.list()).toEqual([expect.objectContaining({ origin: 'https://xm.example.com', username: 'renamed' })])
  })

  it('separates identities by both origin and user ID and refuses credentials for another origin', async () => {
    const store = new SavedAccountsStore(tempFile(), safeStorage())
    const a = await store.upsert(input())
    const b = await store.upsert(input({ userId: 43 }))
    const c = await store.upsert(input({ origin: 'https://other.example.com' }))
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
    expect(await store.getSession(c.id, a.origin)).toBeNull()
    await store.remove(a.id)
    expect((await store.list()).map((entry) => entry.id).sort()).toEqual([b.id, c.id].sort())
  })

  it('captures input before queueing and returns detached credential arrays', async () => {
    const store = new SavedAccountsStore(tempFile(), safeStorage())
    const supplied = input()
    const write = store.upsert(supplied)
    supplied.cookies[0] = 'refresh_token=mutated'
    const account = await write
    const restored = await store.getSession(account.id, account.origin)
    expect(restored?.cookies).toEqual(input().cookies)
    restored!.cookies.length = 0
    expect((await store.getSession(account.id, account.origin))?.cookies).toEqual(input().cookies)
  })

  it('serializes login save followed immediately by logout removal', async () => {
    const store = new SavedAccountsStore(tempFile(), safeStorage())
    const save = store.upsert(input())
    const remove = store.remove(savedAccountId(input().origin, input().userId))
    await Promise.all([save, remove])
    expect(await store.list()).toEqual([])
  })

  it('bounds saved accounts at 16 without silently evicting an existing account', async () => {
    const store = new SavedAccountsStore(tempFile(), safeStorage())
    await Promise.all(Array.from({ length: 16 }, (_, index) => store.upsert(input({ userId: index + 1 }))))
    await expect(store.upsert(input({ userId: 17 }))).rejects.toThrow('最多保存 16 个账号')
    await store.upsert(input({ userId: 1, username: 'updated' }))
    expect(await store.list()).toHaveLength(16)
  })

  it('never falls back to plaintext when the operating-system encryption service is unavailable', async () => {
    const file = tempFile()
    const storage = safeStorage()
    storage.isEncryptionAvailable = () => false
    const store = new SavedAccountsStore(file, storage)
    await expect(store.upsert(input())).rejects.toThrow('加密服务不可用')
    await expect(store.list()).rejects.toThrow('加密服务不可用')
    expect(fs.existsSync(file)).toBe(false)
    expect(storage.encryptString).not.toHaveBeenCalled()
  })

  it('preserves an unreadable existing index instead of replacing it with one account', async () => {
    const file = tempFile()
    fs.writeFileSync(file, 'corrupted-index', 'utf8')
    const store = new SavedAccountsStore(file, safeStorage())
    await expect(store.list()).rejects.toThrow('无法读取')
    await expect(store.upsert(input())).rejects.toThrow('无法读取')
    await expect(store.remove(savedAccountId(input().origin, 42))).rejects.toThrow('无法读取')
    expect(fs.readFileSync(file, 'utf8')).toBe('corrupted-index')
  })

  it('does not overwrite ciphertext encrypted for another OS profile', async () => {
    const file = tempFile()
    await new SavedAccountsStore(file, safeStorage()).upsert(input())
    const before = fs.readFileSync(file, 'utf8')
    const store = new SavedAccountsStore(file, safeStorage())
    await expect(store.upsert(input({ userId: 43 }))).rejects.toThrow('无法读取')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('rejects unknown schemas and oversized files without touching them', async () => {
    const file = tempFile()
    const storage = safeStorage()
    const encrypted = storage.encryptString(JSON.stringify({ version: 2, accounts: [] })).toString('base64')
    fs.writeFileSync(file, encrypted, 'utf8')
    const store = new SavedAccountsStore(file, storage)
    await expect(store.upsert(input())).rejects.toThrow('无法读取')
    expect(fs.readFileSync(file, 'utf8')).toBe(encrypted)
    fs.writeFileSync(file, Buffer.alloc(512 * 1024 + 1, 65))
    await expect(store.list()).rejects.toThrow()
    expect(fs.statSync(file).size).toBe(512 * 1024 + 1)
  })

  it('keeps the original ciphertext on atomic rename failure and accepts a later retry', async () => {
    const file = tempFile()
    const store = new SavedAccountsStore(file, safeStorage())
    await store.upsert(input())
    const before = fs.readFileSync(file, 'utf8')
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    await expect(store.upsert(input({ username: 'new-name' }))).rejects.toThrow('写入被系统占用')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['saved-accounts.dat'])
    rename.mockRestore()
    await store.upsert(input({ username: 'retry' }))
    expect((await store.list())[0].username).toBe('retry')
  })

  it('fails closed on a hard-linked index and leaves both names intact', async () => {
    const file = tempFile()
    const store = new SavedAccountsStore(file, safeStorage())
    await store.upsert(input())
    const linked = path.join(path.dirname(file), 'linked.dat')
    fs.linkSync(file, linked)
    const before = fs.readFileSync(file, 'utf8')
    await expect(store.upsert(input({ username: 'blocked' }))).rejects.toThrow()
    expect(fs.readFileSync(linked, 'utf8')).toBe(before)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it.each([
    { origin: 'http://xm.example.com' },
    { origin: 'https://user:private-cookie-value@xm.example.com' },
    { userId: Number.MAX_SAFE_INTEGER + 1 },
    { userId: 0 },
    { username: '\ninvalid' },
    { cookies: ['refresh_token=value\r\nInjected: true'] },
    { cookies: [] },
    { cookies: ['a'.repeat(4097)] },
  ])('rejects malformed stored credentials without writing: %j', async (override) => {
    const file = tempFile()
    const store = new SavedAccountsStore(file, safeStorage())
    await expect(store.upsert(input(override))).rejects.toThrow()
    expect(fs.existsSync(file)).toBe(false)
  })
})

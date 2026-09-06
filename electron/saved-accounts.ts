import { createHash } from 'node:crypto'
import path from 'node:path'
import type { SafeStorageLike } from './account-session-store'
import type { NewApiPersistableSession } from './new-api-client'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

const FILE_LABEL = '已保存账号'
const MAX_ACCOUNTS = 16
const MAX_FILE_BYTES = 512 * 1024
const MAX_PLAINTEXT_BYTES = 320 * 1024

export interface SavedAccountSummary {
  id: string
  origin: string
  userId: number
  username: string
  updatedAt: string
}

export interface SavedAccountInput extends NewApiPersistableSession {
  origin: string
  username: string
}

interface SavedAccountRecord extends SavedAccountSummary {
  cookies: string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function savedAccountOrigin(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('账号服务地址无效')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('账号服务地址无效') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('账号服务地址必须是不含凭据的 HTTPS 地址')
  return parsed.origin
}

export function savedAccountId(origin: string, userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('账号身份无效')
  return createHash('sha256').update(`${savedAccountOrigin(origin)}\n${userId}`, 'utf8').digest('hex')
}

function validCookies(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 16
    && value.every((cookie) => typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 4096 && !/[\r\n\u0000]/.test(cookie))
    && Buffer.byteLength(value.join('; '), 'utf8') <= 16 * 1024
}

function normalizeInput(value: SavedAccountInput): SavedAccountInput {
  if (!record(value) || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 256 || /[\u0000-\u001f\u007f]/.test(value.username) || !validCookies(value.cookies)) throw new Error('已保存账号数据无效')
  const origin = savedAccountOrigin(value.origin)
  savedAccountId(origin, value.userId)
  return { origin, userId: value.userId, username: value.username.trim(), cookies: [...value.cookies] }
}

function summary(account: SavedAccountRecord): SavedAccountSummary {
  return { id: account.id, origin: account.origin, userId: account.userId, username: account.username, updatedAt: account.updatedAt }
}

function decode(content: string, storage: SafeStorageLike): SavedAccountRecord[] {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content) || !content) throw new Error()
    const plaintext = storage.decryptString(Buffer.from(content, 'base64'))
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error()
    const data: unknown = JSON.parse(plaintext)
    if (!record(data) || data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > MAX_ACCOUNTS) throw new Error()
    const ids = new Set<string>()
    return data.accounts.map((entry: unknown) => {
      if (!record(entry)) throw new Error()
      const input = normalizeInput(entry as unknown as SavedAccountInput)
      const id = savedAccountId(input.origin, input.userId)
      if (entry.id !== id || entry.origin !== input.origin || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt)) || entry.updatedAt.length > 32 || ids.has(id)) throw new Error()
      ids.add(id)
      return { ...input, id, updatedAt: entry.updatedAt }
    })
  } catch {
    throw new Error('已保存账号无法读取，请检查系统加密服务或恢复备份')
  }
}

export class SavedAccountsStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string, private readonly storage: SafeStorageLike) {}

  list(): Promise<SavedAccountSummary[]> {
    return this.enqueue(async () => (await this.read()).map(summary).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)))
  }

  upsert(input: SavedAccountInput): Promise<SavedAccountSummary> {
    let captured: SavedAccountInput
    try { captured = normalizeInput(input) } catch (error) { return Promise.reject(error) }
    return this.enqueue(async () => {
      const accounts = await this.read()
      const id = savedAccountId(captured.origin, captured.userId)
      const index = accounts.findIndex((account) => account.id === id)
      if (index < 0 && accounts.length >= MAX_ACCOUNTS) throw new Error('最多保存 16 个账号，请先移除不再使用的账号')
      const next = { ...captured, id, updatedAt: new Date().toISOString() }
      if (index < 0) accounts.push(next)
      else accounts[index] = next
      await this.write(accounts)
      return summary(next)
    })
  }

  getSession(id: string, expectedOrigin: string): Promise<NewApiPersistableSession | null> {
    return this.enqueue(async () => {
      const origin = savedAccountOrigin(expectedOrigin)
      const account = (await this.read()).find((entry) => entry.id === id && entry.origin === origin)
      return account ? { userId: account.userId, cookies: [...account.cookies] } : null
    })
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const accounts = await this.read()
      const remaining = accounts.filter((entry) => entry.id !== id)
      if (remaining.length !== accounts.length) await this.write(remaining)
    })
  }

  private assertEncryption(): void {
    if (!this.storage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法保存或切换账号')
  }

  private async read(): Promise<SavedAccountRecord[]> {
    this.assertEncryption()
    const content = await readSafeUtf8File(this.filePath, FILE_LABEL, MAX_FILE_BYTES)
    return content === null ? [] : decode(content, this.storage)
  }

  private async write(accounts: SavedAccountRecord[]): Promise<void> {
    this.assertEncryption()
    const plaintext = JSON.stringify({ version: 1, accounts })
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error('已保存账号数据超出上限')
    let encrypted: string
    try { encrypted = this.storage.encryptString(plaintext).toString('base64') } catch { throw new Error('账号加密失败，原有记录未修改') }
    if (!encrypted || Buffer.byteLength(encrypted, 'utf8') > MAX_FILE_BYTES) throw new Error('已保存账号密文超出上限')
    ensureSafeDataDirectory(path.dirname(this.filePath), FILE_LABEL)
    await writeAtomicSafeUtf8File(this.filePath, encrypted, FILE_LABEL)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}

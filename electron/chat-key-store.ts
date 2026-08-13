import path from 'node:path'
import type { SafeStorageLike } from './account-session-store'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const CURRENT_VERSION = 1
const MAX_FILE_BYTES = 256 * 1024
const MAX_CACHED_ACCOUNTS = 16
const MAX_KEYS_PER_ACCOUNT = 32
const MAX_CACHED_KEYS = 128
const MAX_GROUP_LENGTH = 128
const MAX_KEY_NAME_LENGTH = 50
const MAX_KEY_LENGTH = 512
const FILE_LABEL = 'AI 聊天分组 API Key'

export interface StoredChatKey {
  userId: number
  group: string
  keyId: number
  keyName: string
  key: string
}

export interface PersistedChatKeys {
  version: 1
  /**
   * Most-recently upserted records come first. This gives pruning a stable,
   * persisted order without adding another field to the credential record.
   */
  keys: StoredChatKey[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value.trim() === value
    && !/[\x00-\x1F\x7F]/.test(value)
}

function isStoredChatKey(value: unknown): value is StoredChatKey {
  if (!isRecord(value)) return false
  return typeof value.userId === 'number'
    && Number.isInteger(value.userId)
    && value.userId > 0
    && isBoundedString(value.group, MAX_GROUP_LENGTH)
    && typeof value.keyId === 'number'
    && Number.isInteger(value.keyId)
    && value.keyId > 0
    && isBoundedString(value.keyName, MAX_KEY_NAME_LENGTH)
    && isBoundedString(value.key, MAX_KEY_LENGTH)
    && /^sk-\S{8,509}$/.test(value.key)
}

export function isPersistedChatKeys(value: unknown): value is PersistedChatKeys {
  if (!isRecord(value) || value.version !== CURRENT_VERSION || !Array.isArray(value.keys)) return false
  if (value.keys.length > MAX_CACHED_KEYS || !value.keys.every(isStoredChatKey)) return false

  const accountIds = new Set<number>()
  const groupsByAccount = new Map<number, Set<string>>()
  const keyIdsByAccount = new Map<number, Set<number>>()
  for (const entry of value.keys) {
    accountIds.add(entry.userId)
    const groups = groupsByAccount.get(entry.userId) ?? new Set<string>()
    const keyIds = keyIdsByAccount.get(entry.userId) ?? new Set<number>()
    if (groups.has(entry.group) || keyIds.has(entry.keyId)) return false
    groups.add(entry.group)
    keyIds.add(entry.keyId)
    groupsByAccount.set(entry.userId, groups)
    keyIdsByAccount.set(entry.userId, keyIds)
  }

  return accountIds.size <= MAX_CACHED_ACCOUNTS
    && [...groupsByAccount.values()].every((groups) => groups.size <= MAX_KEYS_PER_ACCOUNT)
}

export function encodePersistedChatKeys(
  data: PersistedChatKeys,
  storage: Pick<SafeStorageLike, 'encryptString'>,
): string {
  if (!isPersistedChatKeys(data)) throw new Error('AI 聊天分组 API Key 格式错误')
  return storage.encryptString(JSON.stringify(data)).toString('base64')
}

export function decodePersistedChatKeys(
  content: string,
  storage: Pick<SafeStorageLike, 'decryptString'>,
): PersistedChatKeys | null {
  try {
    const plainText = storage.decryptString(Buffer.from(content, 'base64'))
    const parsed = JSON.parse(plainText) as unknown
    return isPersistedChatKeys(parsed) ? parsed : null
  } catch {
    return null
  }
}

function pruneKeys(keys: readonly StoredChatKey[]): StoredChatKey[] {
  const retainedAccounts = new Set<number>()
  const accountCounts = new Map<number, number>()
  const retained: StoredChatKey[] = []

  for (const entry of keys) {
    if (!retainedAccounts.has(entry.userId)) {
      if (retainedAccounts.size >= MAX_CACHED_ACCOUNTS) continue
      retainedAccounts.add(entry.userId)
    }
    const accountCount = accountCounts.get(entry.userId) ?? 0
    if (accountCount >= MAX_KEYS_PER_ACCOUNT) continue
    retained.push({ ...entry })
    accountCounts.set(entry.userId, accountCount + 1)
    if (retained.length >= MAX_CACHED_KEYS) break
  }

  return retained
}

export class ChatKeyStore {
  private writeQueue: Promise<void> = Promise.resolve()
  private invalidationRevision = 0
  private readonly invalidatedAccounts = new Map<number, number>()
  private readonly invalidatedGroups = new Map<string, number>()
  private readonly invalidatedKeys = new Map<string, number>()

  constructor(
    private readonly filePath: string,
    private readonly storage: SafeStorageLike,
  ) {}

  async read(userId: number): Promise<StoredChatKey[]> {
    this.assertUserId(userId)
    this.assertEncryptionAvailable()
    await this.writeQueue.catch(() => undefined)
    const record = await this.readRecord()
    return record?.keys
      .filter((entry) => entry.userId === userId && this.isVisible(entry))
      .map((entry) => ({ ...entry })) ?? []
  }

  captureRevision(): number {
    return this.invalidationRevision
  }

  upsert(entry: StoredChatKey, expectedRevision = this.captureRevision()): Promise<boolean> {
    if (!isStoredChatKey(entry)) throw new Error('AI 聊天分组 API Key 格式错误')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('AI 聊天缓存版本格式错误')
    }
    return this.enqueue(async () => {
      this.assertEncryptionAvailable()
      if (this.invalidationRevision !== expectedRevision) return false
      const existing = await this.readRecord()
      const keys = pruneKeys([
        entry,
        ...(existing?.keys.filter((candidate) => this.isVisible(candidate) && !(
          candidate.userId === entry.userId
          && (candidate.group === entry.group || candidate.keyId === entry.keyId)
        )) ?? []),
      ])
      await this.writeRecord({ version: CURRENT_VERSION, keys })
      if (this.invalidationRevision !== expectedRevision) return false
      return true
    })
  }

  remove(userId: number, group: string): Promise<void> {
    this.assertUserId(userId)
    if (!isBoundedString(group, MAX_GROUP_LENGTH)) throw new Error('AI 聊天分组格式错误')
    this.invalidatedGroups.set(this.groupScope(userId, group), this.nextRevision())
    return this.enqueue(async () => {
      this.assertEncryptionAvailable()
      const existing = await this.readRecord()
      if (existing?.keys.some((entry) => entry.userId === userId && entry.group === group)) {
        const keys = existing.keys.filter((entry) => !(entry.userId === userId && entry.group === group))
        await this.writeRecord({ version: CURRENT_VERSION, keys })
      }
      this.invalidatedGroups.delete(this.groupScope(userId, group))
    })
  }

  removeByKeyId(userId: number, keyId: number): Promise<void> {
    this.assertUserId(userId)
    if (!Number.isInteger(keyId) || keyId <= 0) throw new Error('AI 聊天 Key ID 格式错误')
    this.invalidatedKeys.set(this.keyScope(userId, keyId), this.nextRevision())
    return this.enqueue(async () => {
      this.assertEncryptionAvailable()
      const existing = await this.readRecord()
      if (existing?.keys.some((entry) => entry.userId === userId && entry.keyId === keyId)) {
        const keys = existing.keys.filter((entry) => !(entry.userId === userId && entry.keyId === keyId))
        await this.writeRecord({ version: CURRENT_VERSION, keys })
      }
      this.invalidatedKeys.delete(this.keyScope(userId, keyId))
    })
  }

  removeAccount(userId: number): Promise<void> {
    this.assertUserId(userId)
    this.invalidatedAccounts.set(userId, this.nextRevision())
    return this.enqueue(async () => {
      this.assertEncryptionAvailable()
      const existing = await this.readRecord()
      if (existing?.keys.some((entry) => entry.userId === userId)) {
        const keys = existing.keys.filter((entry) => entry.userId !== userId)
        await this.writeRecord({ version: CURRENT_VERSION, keys })
      }
      this.invalidatedAccounts.delete(userId)
    })
  }

  private async readRecord(): Promise<PersistedChatKeys | null> {
    const content = await readSafeUtf8File(this.filePath, FILE_LABEL, MAX_FILE_BYTES)
    if (content === null) return null
    const record = decodePersistedChatKeys(content, this.storage)
    if (!record) throw new Error('本地 AI 聊天分组 API Key 配置已损坏或无法解密')
    return record
  }

  private assertUserId(userId: number): void {
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('AI 聊天账号标识格式错误')
  }

  private assertEncryptionAvailable(): void {
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法持久化 AI 聊天分组 API Key')
    }
  }

  private nextRevision(): number {
    this.invalidationRevision += 1
    return this.invalidationRevision
  }

  private groupScope(userId: number, group: string): string {
    return `${userId}:${group}`
  }

  private keyScope(userId: number, keyId: number): string {
    return `${userId}:${keyId}`
  }

  private isVisible(entry: StoredChatKey): boolean {
    return !this.invalidatedAccounts.has(entry.userId)
      && !this.invalidatedGroups.has(this.groupScope(entry.userId, entry.group))
      && !this.invalidatedKeys.has(this.keyScope(entry.userId, entry.keyId))
  }

  private async writeRecord(record: PersistedChatKeys): Promise<void> {
    ensureSafeDataDirectory(path.dirname(this.filePath), FILE_LABEL)
    await writeAtomicSafeUtf8File(
      this.filePath,
      encodePersistedChatKeys(record, this.storage),
      FILE_LABEL,
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(() => undefined, () => undefined)
    return next
  }
}

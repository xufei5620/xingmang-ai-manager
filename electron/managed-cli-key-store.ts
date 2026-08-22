import fs from 'node:fs'
import path from 'node:path'
import { isProviderId, managedCliKeyProfiles, type ProviderId } from './catalog'
import type { SafeStorageLike } from './account-session-store'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const CURRENT_VERSION = 2
const MAX_FILE_BYTES = 64 * 1024
const MAX_CACHED_ACCOUNTS = 16
const FILE_LABEL = '托管 CLI API Key'

export interface StoredManagedCliKey {
  id: number
  provider: ProviderId
  group: string
  name: string
  key: string
}

export interface PersistedManagedCliKeyAccount {
  userId: number
  updatedAt: string
  keys: StoredManagedCliKey[]
}

export interface PersistedManagedCliKeys {
  version: 2
  revision?: number
  accounts: PersistedManagedCliKeyAccount[]
}

interface LegacyPersistedManagedCliKeys extends PersistedManagedCliKeyAccount {
  version: 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStoredManagedCliKey(value: unknown): value is StoredManagedCliKey {
  if (!isRecord(value) || !isProviderId(value.provider)) return false
  return typeof value.id === 'number'
    && Number.isInteger(value.id)
    && value.id > 0
    && value.group === managedCliKeyProfiles[value.provider].group
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 50
    && typeof value.key === 'string'
    && /^sk-\S{8,509}$/.test(value.key)
}

function isPersistedManagedCliKeyAccount(value: unknown): value is PersistedManagedCliKeyAccount {
  if (!isRecord(value)) return false
  if (typeof value.userId !== 'number' || !Number.isInteger(value.userId) || value.userId <= 0) return false
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) return false
  if (!Array.isArray(value.keys) || value.keys.length > 4 || !value.keys.every(isStoredManagedCliKey)) return false
  return new Set(value.keys.map((entry) => entry.provider)).size === value.keys.length
}

function isLegacyPersistedManagedCliKeys(value: unknown): value is LegacyPersistedManagedCliKeys {
  return isRecord(value) && value.version === 1 && isPersistedManagedCliKeyAccount(value)
}

export function isPersistedManagedCliKeys(value: unknown): value is PersistedManagedCliKeys {
  if (!isRecord(value) || value.version !== CURRENT_VERSION) return false
  if (value.revision !== undefined && (
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
  )) return false
  if (!Array.isArray(value.accounts) || value.accounts.length > MAX_CACHED_ACCOUNTS) return false
  if (!value.accounts.every(isPersistedManagedCliKeyAccount)) return false
  return new Set(value.accounts.map((entry) => entry.userId)).size === value.accounts.length
}

export function encodePersistedManagedCliKeys(
  data: PersistedManagedCliKeys,
  storage: Pick<SafeStorageLike, 'encryptString'>,
): string {
  return storage.encryptString(JSON.stringify(data)).toString('base64')
}

export function decodePersistedManagedCliKeys(
  content: string,
  storage: Pick<SafeStorageLike, 'decryptString'>,
): PersistedManagedCliKeys | null {
  try {
    const plainText = storage.decryptString(Buffer.from(content, 'base64'))
    const parsed = JSON.parse(plainText) as unknown
    if (isPersistedManagedCliKeys(parsed)) return parsed
    if (isLegacyPersistedManagedCliKeys(parsed)) {
      const { userId, updatedAt, keys } = parsed
      return { version: CURRENT_VERSION, accounts: [{ userId, updatedAt, keys }] }
    }
    return null
  } catch {
    return null
  }
}

export class ManagedCliKeyStore {
  private writeQueue: Promise<void> = Promise.resolve()
  private revision = 0

  constructor(
    private readonly filePath: string,
    private readonly storage: SafeStorageLike,
  ) {}

  async read(userId: number): Promise<StoredManagedCliKey[]> {
    this.assertEncryptionAvailable()
    await this.writeQueue.catch(() => undefined)
    const record = await this.readRecord()
    return record?.accounts.find((entry) => entry.userId === userId)?.keys.map((entry) => ({ ...entry })) ?? []
  }

  captureRevision(): number {
    return this.revision
  }

  save(
    userId: number,
    keys: readonly StoredManagedCliKey[],
    expectedRevision?: number,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertEncryptionAvailable()
      let existing: PersistedManagedCliKeys | null = null
      try {
        existing = await this.readRecord()
      } catch {
        await this.quarantineCorruptRecord()
      }
      if (expectedRevision !== undefined && expectedRevision !== this.revision) return false
      const account: PersistedManagedCliKeyAccount = {
        userId,
        updatedAt: new Date().toISOString(),
        keys: keys.map((entry) => ({ ...entry })),
      }
      const accounts = [
        account,
        ...(existing?.accounts.filter((entry) => entry.userId !== userId) ?? []),
      ].slice(0, MAX_CACHED_ACCOUNTS)
      const record: PersistedManagedCliKeys = {
        version: CURRENT_VERSION,
        revision: this.revision + 1,
        accounts,
      }
      await this.writeRecord(record)
      this.revision = record.revision ?? this.revision + 1
      return true
    })
  }

  async remove(userId: number, keyId: number): Promise<void> {
    await this.enqueue(async () => {
      this.assertEncryptionAvailable()
      const record = await this.readRecord()
      const account = record?.accounts.find((entry) => entry.userId === userId)
      if (!record || !account?.keys.some((entry) => entry.id === keyId)) return
      const updated: PersistedManagedCliKeys = {
        version: CURRENT_VERSION,
        revision: this.revision + 1,
        accounts: record.accounts.map((entry) => entry.userId === userId
          ? {
              ...entry,
              updatedAt: new Date().toISOString(),
              keys: entry.keys.filter((key) => key.id !== keyId),
            }
          : entry),
      }
      await this.writeRecord(updated)
      this.revision = updated.revision ?? this.revision + 1
    })
  }

  private async readRecord(): Promise<PersistedManagedCliKeys | null> {
    const content = await readSafeUtf8File(this.filePath, FILE_LABEL, MAX_FILE_BYTES)
    if (content === null) return null
    const record = decodePersistedManagedCliKeys(content, this.storage)
    if (!record) throw new Error('本地托管 API Key 配置已损坏或无法解密')
    this.revision = Math.max(this.revision, record.revision ?? 0)
    return record
  }

  private async quarantineCorruptRecord(): Promise<void> {
    try {
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`
      await fs.promises.rename(this.filePath, quarantine)
    } catch {
      // A missing or locked cache is still recoverable on the next save.
    }
  }

  private assertEncryptionAvailable(): void {
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法持久化托管 API Key')
    }
  }

  private async writeRecord(record: PersistedManagedCliKeys): Promise<void> {
    if (!isPersistedManagedCliKeys(record)) throw new Error('托管 CLI API Key 格式错误')
    ensureSafeDataDirectory(path.dirname(this.filePath), FILE_LABEL)
    await writeAtomicSafeUtf8File(
      this.filePath,
      encodePersistedManagedCliKeys(record, this.storage),
      FILE_LABEL,
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(() => undefined, () => undefined)
    return next
  }
}

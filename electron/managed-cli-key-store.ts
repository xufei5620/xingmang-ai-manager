import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { currentAccountGroupName, isProviderId, providerIds, resolveManagedCliKeyProfiles, type ProviderId } from './catalog'
import { isManagedCliGroupName } from './managed-cli-groups'
import type { SafeStorageLike } from './account-session-store'
import { inspectSafeStorageBackend, safeStoragePlaintextMessage, type CredentialPersistence } from './safe-storage-backend'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  removeSafeDataFile,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const CURRENT_VERSION = 2
const MAX_FILE_BYTES = 64 * 1024
const MAX_CACHED_ACCOUNTS = 16
const FILE_LABEL = '托管 CLI API Key'
const MAX_QUARANTINED_RECORDS = 3
// 换掉的那几把记几条：连着换两次组、中间都没写进配置，也还认得出最早那把。
const MAX_REPLACED_KEYS = 3

export interface StoredManagedCliKey {
  id: number
  provider: ProviderId
  group: string
  name: string
  key: string
  /**
   * 读出来时由缓存附上：这家工具以前缓存过、后来被换掉的托管 Key 的指纹（managedKeyDigest），新的在前。
   * 存回去时不看这一项，换没换由缓存自己比出来。缺省 = 这台电脑上没换过。
   */
  replacedKeyDigests?: string[]
}

export interface PersistedManagedCliKeyAccount {
  userId: number
  updatedAt: string
  keys: StoredManagedCliKey[]
  /**
   * 每家工具被换掉、被拿掉的托管 Key 的指纹（#1153）。配置里那把正好在这里，才说明是「上一轮换了 Key
   * 没写进配置」；客户在密钥页、配置窗口自己选的那把从来不在缓存里，不会被开机补写换掉。
   * 拿掉的也记：分组被删、旧那把从缓存里去掉，下一轮才签出新的，中间隔着一次保存。
   */
  replacedKeys?: Partial<Record<ProviderId, string[]>>
}

export interface PersistedManagedCliKeys {
  version: 2
  /** Absent in older files, which still require the shipped group names. */
  siteId?: 'solov' | 'solov-api'
  revision?: number
  accounts: PersistedManagedCliKeyAccount[]
}

interface LegacyPersistedManagedCliKeys extends PersistedManagedCliKeyAccount {
  version: 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 托管 Key 的指纹：只用来认「配置里这把是不是缓存以前的那把」，缓存里不留旧 Key 本身。 */
export function managedKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * 配置里这把 Key 是不是这家工具以前缓存过、后来被换掉的托管 Key（#1153）。缓存里眼下没有这家的 Key、
 * 或者配置里就是眼下那把时不算。
 */
export function isReplacedManagedKey(provider: ProviderId, key: string, cachedKeys: readonly StoredManagedCliKey[]): boolean {
  const entry = cachedKeys.find((item) => item.provider === provider)
  if (!entry || !key || entry.key === key) return false
  return entry.replacedKeyDigests?.includes(managedKeyDigest(key)) === true
}

function replacedDigests(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((digest): digest is string => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))
}

// 这次保存以后每家工具换掉过的那几把：上一份里有、这一份里没了或换了的，排到最前面。眼下还在用的那把不记。
function nextReplacedKeys(
  previous: PersistedManagedCliKeyAccount | undefined,
  keys: readonly StoredManagedCliKey[],
): Partial<Record<ProviderId, string[]>> {
  const result: Partial<Record<ProviderId, string[]>> = {}
  for (const provider of providerIds) {
    const before = previous?.keys.find((entry) => entry.provider === provider)
    const current = keys.find((entry) => entry.provider === provider)
    const currentDigest = current ? managedKeyDigest(current.key) : null
    const history = [
      ...(before && before.key !== current?.key ? [managedKeyDigest(before.key)] : []),
      ...replacedDigests(previous?.replacedKeys?.[provider]),
    ]
    const kept = [...new Set(history)].filter((digest) => digest !== currentDigest).slice(0, MAX_REPLACED_KEYS)
    if (kept.length) result[provider] = kept
  }
  return result
}

function persistedAccount(
  userId: number,
  keys: readonly StoredManagedCliKey[],
  previous: PersistedManagedCliKeyAccount | undefined,
): PersistedManagedCliKeyAccount {
  const replacedKeys = nextReplacedKeys(previous, keys)
  return {
    userId,
    updatedAt: new Date().toISOString(),
    keys: keys.map(({ replacedKeyDigests: _replacedKeyDigests, ...entry }) => ({ ...entry })),
    ...(Object.keys(replacedKeys).length ? { replacedKeys } : {}),
  }
}

// 不分站点的老文件（0.2.12 以前写的）只认出厂的分组名。xm 站 10-16 删了老名字，出厂名换成了新名字，
// 0.2.8、0.2.10 这些老版本写下的老名字也还得认，不然整份缓存读不出来、被当成损坏挪走。
function isShippedGroup(group: unknown, provider: ProviderId, siteId: 'solov' | 'solov-api'): boolean {
  const shipped = resolveManagedCliKeyProfiles(siteId)[provider].group
  return typeof group === 'string' && (group === shipped || (siteId === 'solov' && currentAccountGroupName(group) === shipped))
}

function isStoredManagedCliKey(
  value: unknown,
  siteId: 'solov' | 'solov-api',
  scoped: boolean,
): value is StoredManagedCliKey {
  if (!isRecord(value) || !isProviderId(value.provider)) return false
  return typeof value.id === 'number'
    && Number.isInteger(value.id)
    && value.id > 0
    && (scoped ? isManagedCliGroupName(value.group) : isShippedGroup(value.group, value.provider, siteId))
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 50
    && typeof value.key === 'string'
    && /^sk-\S{8,509}$/.test(value.key)
}

function isPersistedManagedCliKeyAccount(
  value: unknown,
  siteId: 'solov' | 'solov-api',
  scoped: boolean,
): value is PersistedManagedCliKeyAccount {
  if (!isRecord(value)) return false
  if (typeof value.userId !== 'number' || !Number.isInteger(value.userId) || value.userId <= 0) return false
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) return false
  if (!Array.isArray(value.keys) || value.keys.length > 4 || !value.keys.every((entry) => isStoredManagedCliKey(entry, siteId, scoped))) return false
  // 换掉过的那几把只是线索：认不出的条目读的时候丢掉就是，不为它把整份缓存当坏的挪走、重签一遍 Key。
  if (value.replacedKeys !== undefined && !isRecord(value.replacedKeys)) return false
  return new Set(value.keys.map((entry) => entry.provider)).size === value.keys.length
}

function isLegacyPersistedManagedCliKeys(value: unknown): value is LegacyPersistedManagedCliKeys {
  return isRecord(value) && value.version === 1 && isPersistedManagedCliKeyAccount(value, 'solov', false)
}

export function isPersistedManagedCliKeys(value: unknown, siteId: 'solov' | 'solov-api' = 'solov'): value is PersistedManagedCliKeys {
  if (!isRecord(value) || value.version !== CURRENT_VERSION) return false
  if (value.siteId !== undefined && value.siteId !== siteId) return false
  if (value.revision !== undefined && (
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
  )) return false
  if (!Array.isArray(value.accounts) || value.accounts.length > MAX_CACHED_ACCOUNTS) return false
  if (!value.accounts.every((entry) => isPersistedManagedCliKeyAccount(entry, siteId, value.siteId === siteId))) return false
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
  siteId: 'solov' | 'solov-api' = 'solov',
): PersistedManagedCliKeys | null {
  try {
    const plainText = storage.decryptString(Buffer.from(content, 'base64'))
    const parsed = JSON.parse(plainText) as unknown
    if (isPersistedManagedCliKeys(parsed, siteId)) return parsed
    if (siteId === 'solov' && isLegacyPersistedManagedCliKeys(parsed)) {
      const { userId, updatedAt, keys } = parsed
      return { version: CURRENT_VERSION, accounts: [{ userId, updatedAt, keys }] }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Only a record the current cipher cannot decrypt, or one whose shape no
 * longer validates, is evidence that the cache itself is unusable. Every other
 * read failure -- a reparse component, nlink !== 1, a size overrun, a file an
 * antivirus scanner is holding -- is transient or environmental, and must not
 * quarantine a file that still holds up to 16 accounts' keys: doing so forces
 * a freshly signed token per provider on the next switch, which is exactly the
 * server-side token pile-up this cache exists to prevent.
 */
export class ManagedCliKeyCacheCorruptError extends Error {}

export class ManagedCliKeyStore {
  private writeQueue: Promise<void> = Promise.resolve()
  private revision = 0
  // Session-only: the record this store would have written, so switching
  // accounts within one run still reuses keys instead of signing new ones.
  private sessionRecord: PersistedManagedCliKeys | null = null

  constructor(
    private readonly filePath: string,
    private readonly storage: SafeStorageLike,
    private readonly siteId: 'solov' | 'solov-api' = 'solov',
    private readonly persistence: CredentialPersistence = 'durable',
  ) {}

  getSiteId(): 'solov' | 'solov-api' {
    return this.siteId
  }

  async read(userId: number): Promise<StoredManagedCliKey[]> {
    this.assertEncryptionAvailable()
    await this.writeQueue.catch(() => undefined)
    const record = await this.readRecord()
    const account = record?.accounts.find((entry) => entry.userId === userId)
    // xm 站删老分组名之前把老名字下的 Key 全挂到了新名字下（Key 不变），本机记的老名字照着换，
    // 开机时就不会因为「分组对不上」去重签一把、再重写一遍配置。文件里的老名字等下次保存时自然换掉。
    return account?.keys.map((entry) => {
      const replaced = replacedDigests(account.replacedKeys?.[entry.provider])
      return {
        ...entry,
        ...(this.siteId === 'solov' ? { group: currentAccountGroupName(entry.group) } : {}),
        ...(replaced.length ? { replacedKeyDigests: replaced } : {}),
      }
    }) ?? []
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
      } catch (error) {
        if (!(error instanceof ManagedCliKeyCacheCorruptError)) throw error
        await this.quarantineCorruptRecord()
      }
      if (expectedRevision !== undefined && expectedRevision !== this.revision) return false
      const account = persistedAccount(userId, keys, existing?.accounts.find((entry) => entry.userId === userId))
      const accounts = [
        account,
        ...(existing?.accounts.filter((entry) => entry.userId !== userId) ?? []),
      ].slice(0, MAX_CACHED_ACCOUNTS)
      const record: PersistedManagedCliKeys = {
        version: CURRENT_VERSION,
        siteId: this.siteId,
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
        siteId: this.siteId,
        revision: this.revision + 1,
        accounts: record.accounts.map((entry) => entry.userId === userId
          ? persistedAccount(userId, entry.keys.filter((key) => key.id !== keyId), entry)
          : entry),
      }
      await this.writeRecord(updated)
      this.revision = updated.revision ?? this.revision + 1
    })
  }

  private async readRecord(): Promise<PersistedManagedCliKeys | null> {
    if (this.persistence === 'session-only') return this.sessionRecord && structuredClone(this.sessionRecord)
    const content = await readSafeUtf8File(this.filePath, FILE_LABEL, MAX_FILE_BYTES)
    if (content === null) return null
    const record = decodePersistedManagedCliKeys(content, this.storage, this.siteId)
    if (!record) throw new ManagedCliKeyCacheCorruptError('本地托管 API Key 配置已损坏或无法解密')
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
    await this.pruneQuarantinedRecords()
  }

  // Quarantined copies still hold real API Keys, so they are kept for support
  // but never without a bound.
  private async pruneQuarantinedRecords(): Promise<void> {
    try {
      const directory = path.dirname(this.filePath)
      const prefix = `${path.basename(this.filePath)}.corrupt-`
      const stale = (await fs.promises.readdir(directory))
        .flatMap((name) => {
          if (!name.startsWith(prefix)) return []
          const stamp = Number(name.slice(prefix.length))
          return Number.isSafeInteger(stamp) && stamp > 0 ? [{ name, stamp }] : []
        })
        .sort((left, right) => right.stamp - left.stamp)
        .slice(MAX_QUARANTINED_RECORDS)
      // removeSafeDataFile re-validates the path, so a symlink planted under
      // the quarantine name is left in place rather than followed.
      for (const entry of stale) {
        await removeSafeDataFile(path.join(directory, entry.name), FILE_LABEL)
      }
    } catch {
      // Housekeeping never blocks the save that follows.
    }
  }

  private assertEncryptionAvailable(): void {
    if (this.persistence === 'session-only') return
    const backend = inspectSafeStorageBackend(this.storage)
    if (backend === 'unavailable') {
      throw new Error('系统安全存储不可用，无法持久化托管 API Key')
    }
    if (backend === 'plaintext') throw new Error(safeStoragePlaintextMessage('托管 API Key'))
  }

  private async writeRecord(record: PersistedManagedCliKeys): Promise<void> {
    if (!isPersistedManagedCliKeys(record, this.siteId)) throw new Error('托管 CLI API Key 格式错误')
    if (this.persistence === 'session-only') {
      this.sessionRecord = structuredClone(record)
      return
    }
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

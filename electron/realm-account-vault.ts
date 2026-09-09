import { createHash } from 'node:crypto'
import {
  isRealmRecord, parseRealmSavedAccount, realmAccountSummary, realmOwnerKey, RealmAccountError,
  type RealmAccountOwner, type RealmAccountSummary, type RealmSavedAccount,
} from './realm-account'

const maxFileBytes = 512 * 1024
const maxPlaintextBytes = 320 * 1024
const maxAccounts = 16

/** Inject safeStorage and safe-local-data here; never supply unbounded raw fs writes. */
export interface RealmVaultStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Uint8Array
  decryptString(ciphertext: Uint8Array): string
  read(): Promise<string | null>
  /** Must atomically replace the file or reject with the original file intact. */
  writeAtomic(ciphertext: string): Promise<void>
}

interface VaultDocument {
  readonly version: 2
  readonly activeId: string | null
  readonly accounts: readonly RealmSavedAccount[]
}

export interface RealmAccountVault {
  list(): Promise<RealmAccountSummary[]>
  active(): Promise<RealmSavedAccount | null>
  get(owner: RealmAccountOwner): Promise<RealmSavedAccount | null>
  activate(account: RealmSavedAccount): Promise<void>
  signOut(): Promise<void>
  forget(owner: RealmAccountOwner): Promise<void>
  importLegacy(accounts: readonly unknown[]): Promise<number>
}

/** Namespace for every new store/cache. No raw ID or origin can become a path component. */
export function realmStorageScope(owner: RealmAccountOwner): string {
  return createHash('sha256').update(realmOwnerKey(owner), 'utf8').digest('hex')
}

/** Historical records may only migrate into xm; unknown origins are never guessed. */
export function migrateLegacySavedAccount(value: unknown): RealmSavedAccount {
  if (!isRealmRecord(value) || value.origin !== 'https://xm.solov.cc'
    || !Number.isSafeInteger(value.userId) || typeof value.userId !== 'number' || value.userId <= 0) throw new RealmAccountError('INVALID')
  return parseRealmSavedAccount({ version: 2, realmId: 'xm-account', origin: value.origin,
    userId: String(value.userId), username: value.username, credential: { kind: 'new-api', cookies: value.cookies } })
}

export function createRealmAccountVault(storage: RealmVaultStorage): RealmAccountVault {
  let tail = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation, operation)
    tail = next.then(() => undefined, () => undefined)
    return next
  }

  function assertEncryption(): void {
    if (!storage.isEncryptionAvailable()) throw new RealmAccountError('STORAGE')
  }

  async function read(): Promise<VaultDocument> {
    assertEncryption()
    try {
      const ciphertext = await storage.read()
      if (ciphertext === null) return { version: 2, activeId: null, accounts: [] }
      if (!ciphertext || Buffer.byteLength(ciphertext) > maxFileBytes
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) throw new Error()
      const plaintext = storage.decryptString(Buffer.from(ciphertext, 'base64'))
      if (Buffer.byteLength(plaintext) > maxPlaintextBytes) throw new Error()
      const data: unknown = JSON.parse(plaintext)
      if (!isRealmRecord(data) || data.version !== 2 || !Array.isArray(data.accounts) || data.accounts.length > maxAccounts) throw new Error()
      const accounts = data.accounts.map(parseRealmSavedAccount)
      const ids = new Set(accounts.map(realmOwnerKey))
      if (ids.size !== accounts.length || (data.activeId !== null && (typeof data.activeId !== 'string' || !ids.has(data.activeId)))) throw new Error()
      return { version: 2, activeId: data.activeId as string | null, accounts }
    } catch { throw new RealmAccountError('STORAGE') }
  }

  async function write(document: VaultDocument): Promise<void> {
    assertEncryption()
    try {
      const plaintext = JSON.stringify(document)
      if (Buffer.byteLength(plaintext) > maxPlaintextBytes) throw new Error()
      const encrypted = storage.encryptString(plaintext)
      if (!encrypted.byteLength) throw new Error()
      const ciphertext = Buffer.from(encrypted).toString('base64')
      if (Buffer.byteLength(ciphertext) > maxFileBytes) throw new Error()
      // Recheck immediately before committing. There is no plaintext fallback.
      assertEncryption()
      await storage.writeAtomic(ciphertext)
    } catch { throw new RealmAccountError('STORAGE') }
  }

  return Object.freeze({
    list: () => enqueue(async () => (await read()).accounts.map(realmAccountSummary)),
    active: () => enqueue(async () => {
      const data = await read()
      return data.accounts.find((account) => realmOwnerKey(account) === data.activeId) ?? null
    }),
    get: (owner: RealmAccountOwner) => {
      const key = realmOwnerKey(owner)
      return enqueue(async () => (await read()).accounts.find((account) => realmOwnerKey(account) === key) ?? null)
    },
    activate: (account: RealmSavedAccount) => {
      const captured = parseRealmSavedAccount(account)
      return enqueue(async () => {
        const data = await read()
        const id = realmOwnerKey(captured)
        const accounts = data.accounts.filter((entry) => realmOwnerKey(entry) !== id)
        if (accounts.length >= maxAccounts) throw new RealmAccountError('STORAGE')
        await write({ version: 2, activeId: id, accounts: [...accounts, captured] })
      })
    },
    signOut: () => enqueue(async () => {
      const data = await read()
      await write({ version: 2, activeId: null, accounts: data.accounts.filter((entry) => realmOwnerKey(entry) !== data.activeId) })
    }),
    forget: (owner: RealmAccountOwner) => {
      const key = realmOwnerKey(owner)
      return enqueue(async () => {
        const data = await read()
        if (data.activeId === key) throw new RealmAccountError('BUSY')
        const accounts = data.accounts.filter((entry) => realmOwnerKey(entry) !== key)
        if (accounts.length !== data.accounts.length) await write({ ...data, accounts })
      })
    },
    importLegacy: (values: readonly unknown[]) => {
      if (!Array.isArray(values) || values.length > maxAccounts) throw new RealmAccountError('INVALID')
      const captured = values.map(migrateLegacySavedAccount)
      return enqueue(async () => {
        const data = await read()
        const entries = new Map(data.accounts.map((entry) => [realmOwnerKey(entry), entry]))
        const before = entries.size
        for (const entry of captured) if (!entries.has(realmOwnerKey(entry))) entries.set(realmOwnerKey(entry), entry)
        if (entries.size > maxAccounts) throw new RealmAccountError('STORAGE')
        if (entries.size !== before) await write({ ...data, accounts: [...entries.values()] })
        return entries.size - before
      })
    },
  })
}

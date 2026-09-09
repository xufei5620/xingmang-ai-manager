import { createHash } from 'node:crypto'
import {
  isRealmRecord, parseRealmSavedAccount, realmAccountSummary, realmOwnerKey, RealmAccountError,
  requireAccountRealm, requireRealmUserId,
  type AccountRealmId, type RealmAccountOwner, type RealmAccountSummary, type RealmSavedAccount,
} from './realm-account'

const maxFileBytes = 512 * 1024
const maxPlaintextBytes = 320 * 1024
const maxAccounts = 16
const maxLoginHints = 64

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
  readonly legacyMigrated?: boolean
  readonly loginHints?: readonly LoginHint[]
}

interface LoginHint extends RealmAccountOwner {
  readonly identifier: string
}
export interface RealmLoginHintSummary {
  readonly identifier: string
  readonly realmId: AccountRealmId
}

export interface RealmAccountVault {
  list(): Promise<RealmAccountSummary[]>
  active(): Promise<RealmSavedAccount | null>
  get(owner: RealmAccountOwner): Promise<RealmSavedAccount | null>
  activate(account: RealmSavedAccount, identifier?: string): Promise<void>
  /** Routing preference only; this must never restore credentials or authenticate. */
  preferredLoginSite(identifier: string): Promise<'solov' | 'solov-api' | null>
  latestLoginHint(): Promise<RealmLoginHintSummary | null>
  /** Refresh credentials in place. Never create a record or change activeId. */
  updateSession(account: RealmSavedAccount): Promise<void>
  signOut(owner?: RealmAccountOwner): Promise<void>
  forget(owner: RealmAccountOwner): Promise<void>
  importLegacy(accounts: readonly unknown[]): Promise<number>
  migrateLegacy(accounts: readonly unknown[], active?: unknown): Promise<number>
  hasMigratedLegacy(): Promise<boolean>
}

/** Namespace for every new store/cache. No raw ID or origin can become a path component. */
export function realmStorageScope(owner: RealmAccountOwner): string {
  return createHash('sha256').update(realmOwnerKey(owner), 'utf8').digest('hex')
}

/** Email login aliases are case-insensitive; ordinary usernames retain case. */
export function normalizeRealmLoginIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) throw new RealmAccountError('INVALID')
  const identifier = value.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier) ? identifier.toLowerCase() : identifier
}

function parseLoginHints(value: unknown): readonly LoginHint[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maxLoginHints) throw new RealmAccountError('INVALID')
  const hints = value.map((entry: unknown) => {
    if (!isRealmRecord(entry) || Object.keys(entry).some((key) => !['identifier', 'realmId', 'userId'].includes(key))) throw new RealmAccountError('INVALID')
    const identifier = normalizeRealmLoginIdentifier(entry.identifier)
    if (identifier !== entry.identifier) throw new RealmAccountError('INVALID')
    return Object.freeze({ identifier, realmId: requireAccountRealm(entry.realmId), userId: requireRealmUserId(entry.userId) })
  })
  if (new Set(hints.map((hint) => hint.identifier)).size !== hints.length) throw new RealmAccountError('INVALID')
  return Object.freeze(hints)
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
      if (data.legacyMigrated !== undefined && typeof data.legacyMigrated !== 'boolean') throw new Error()
      const loginHints = parseLoginHints(data.loginHints)
      return { version: 2, activeId: data.activeId as string | null, accounts,
        ...(data.legacyMigrated === undefined ? {} : { legacyMigrated: data.legacyMigrated }),
        ...(loginHints === undefined ? {} : { loginHints }) }
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

  function importLegacy(values: readonly unknown[], active?: unknown): Promise<number> {
    if (!Array.isArray(values) || values.length > maxAccounts) throw new RealmAccountError('INVALID')
    const captured = values.map(migrateLegacySavedAccount)
    const selected = active === undefined || active === null ? null : migrateLegacySavedAccount(active)
    return enqueue(async () => {
      const data = await read()
      if (data.legacyMigrated) return 0
      const entries = new Map(data.accounts.map((entry) => [realmOwnerKey(entry), entry]))
      const before = entries.size
      for (const entry of captured) if (!entries.has(realmOwnerKey(entry))) entries.set(realmOwnerKey(entry), entry)
      if (selected && !entries.has(realmOwnerKey(selected))) entries.set(realmOwnerKey(selected), selected)
      if (entries.size > maxAccounts) throw new RealmAccountError('STORAGE')
      await write({ ...data, legacyMigrated: true, accounts: [...entries.values()],
        activeId: data.activeId ?? (selected ? realmOwnerKey(selected) : null) })
      return entries.size - before
    })
  }

  return Object.freeze({
    hasMigratedLegacy: () => enqueue(async () => (await read()).legacyMigrated === true),
    preferredLoginSite: (identifier: string) => {
      const normalized = normalizeRealmLoginIdentifier(identifier)
      return enqueue(async () => {
        const data = await read()
        const hint = data.loginHints?.find((entry) => entry.identifier === normalized)
        if (hint) return hint.realmId === 'xm-account' ? 'solov' : 'solov-api'
        // Pre-hint vaults know only the authenticated profile name. Match
        // exactly within that active account, never infer from numeric IDs
        // or treat an unrelated email as a profile alias.
        const active = data.accounts.find((entry) => realmOwnerKey(entry) === data.activeId)
        return active && normalizeRealmLoginIdentifier(active.username) === normalized
          ? active.realmId === 'xm-account' ? 'solov' : 'solov-api' : null
      })
    },
    latestLoginHint: () => enqueue(async () => {
      const hint = (await read()).loginHints?.at(-1)
      return hint ? Object.freeze({ identifier: hint.identifier, realmId: hint.realmId }) : null
    }),
    list: () => enqueue(async () => (await read()).accounts.map(realmAccountSummary)),
    active: () => enqueue(async () => {
      const data = await read()
      return data.accounts.find((account) => realmOwnerKey(account) === data.activeId) ?? null
    }),
    get: (owner: RealmAccountOwner) => {
      const key = realmOwnerKey(owner)
      return enqueue(async () => (await read()).accounts.find((account) => realmOwnerKey(account) === key) ?? null)
    },
    activate: (account: RealmSavedAccount, identifier?: string) => {
      const captured = parseRealmSavedAccount(account)
      const normalized = identifier === undefined ? undefined : normalizeRealmLoginIdentifier(identifier)
      return enqueue(async () => {
        const data = await read()
        const id = realmOwnerKey(captured)
        const accounts = data.accounts.filter((entry) => realmOwnerKey(entry) !== id)
        if (accounts.length >= maxAccounts) throw new RealmAccountError('STORAGE')
        const loginHints = normalized === undefined ? data.loginHints : [
          ...(data.loginHints ?? []).filter((hint) => hint.identifier !== normalized),
          { identifier: normalized, realmId: captured.realmId, userId: captured.userId },
        ].slice(-maxLoginHints)
        // Account, active pointer and routing preference have one commit
        // point. Failed authentication or failed disk writes cannot retarget
        // the next login. Logout/forget retain only this non-secret preference.
        await write({ ...data, legacyMigrated: true, activeId: id, accounts: [...accounts, captured],
          ...(loginHints === undefined ? {} : { loginHints }) })
      })
    },
    updateSession: (account: RealmSavedAccount) => {
      const captured = parseRealmSavedAccount(account)
      return enqueue(async () => {
        const data = await read()
        const id = realmOwnerKey(captured)
        if (!data.accounts.some((entry) => realmOwnerKey(entry) === id)) return
        await write({ ...data, accounts: data.accounts.map((entry) => realmOwnerKey(entry) === id ? captured : entry) })
      })
    },
    signOut: (owner?: RealmAccountOwner) => {
      const expectedId = owner === undefined ? undefined : realmOwnerKey(owner)
      return enqueue(async () => {
        const data = await read()
        const id = expectedId ?? data.activeId
        await write({ ...data, legacyMigrated: true, activeId: data.activeId === id ? null : data.activeId,
          accounts: data.accounts.filter((entry) => realmOwnerKey(entry) !== id) })
      })
    },
    forget: (owner: RealmAccountOwner) => {
      const key = realmOwnerKey(owner)
      return enqueue(async () => {
        const data = await read()
        if (data.activeId === key) throw new RealmAccountError('BUSY')
        const accounts = data.accounts.filter((entry) => realmOwnerKey(entry) !== key)
        if (accounts.length !== data.accounts.length || !data.legacyMigrated) await write({ ...data, legacyMigrated: true, accounts })
      })
    },
    importLegacy,
    migrateLegacy: importLegacy,
  })
}

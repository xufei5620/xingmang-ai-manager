import path from 'node:path'
import type { NewApiPersistableSession } from './new-api-client'
import { isSafeStorageUsable, type SafeStorageBackendLike } from './safe-storage-backend'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  removeSafeDataFile,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

// Persists the 星芒 app's own login session -- NOT the relay API Key
// AGENTS.md's "不给 API Key 加密" rule targets (that rule is about the key
// that must live in plaintext inside a CLI's own config file; this file
// never touches a CLI config, see docs/ACCOUNT-PLAN.md decision 1). The
// access token is short-lived and deliberately excluded (see
// NewApiPersistableSession's own doc comment in new-api-client.ts) -- only
// the refresh cookie + userId are persisted, encrypted at rest, so a
// returning user does not have to log back in on every launch.
//
// Saved logins now live in the realm account vault; main.ts only reads this
// older single-account file once, through realm-account-service.ts's
// migrateLegacy(), because its refresh cookie may be newer than the one in
// the old account list.

// Mirrors the subset of Electron's `safeStorage` module this file needs, so
// tests can inject a fake implementation instead of (a) touching the real OS
// credential store (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
// Linux) or (b) being gated by whatever that store happens to support on the
// CI machine, and per this task's own requirement, without ever touching the
// network either.
export interface SafeStorageLike extends SafeStorageBackendLike {
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface RuntimeLogLike {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    source: string,
    event: string,
    message: string,
    detail?: Record<string, unknown>,
  ): void
}

const CURRENT_VERSION = 1
const MAX_FILE_BYTES = 64 * 1024
const FILE_LABEL = '账号登录凭据'

export interface PersistedAccountSession extends NewApiPersistableSession {
  version: 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isPersistedAccountSession(value: unknown): value is PersistedAccountSession {
  if (!isRecord(value)) return false
  if (value.version !== CURRENT_VERSION) return false
  if (typeof value.userId !== 'number' || !Number.isInteger(value.userId) || value.userId <= 0) return false
  if (!Array.isArray(value.cookies) || value.cookies.length === 0) return false
  return value.cookies.every((entry) => typeof entry === 'string' && entry.length > 0)
}

// Encrypted bytes go through safeStorage first, then base64 so the result is
// plain ASCII and can ride the existing UTF-8 atomic-write primitives in
// safe-local-data.ts (I8 -- assertNoReparseComponents/nlink checks/atomic
// rename) unchanged, rather than inventing a second, binary-safe file
// primitive just for this one file. safeStorage's own output is already
// opaque ciphertext (DPAPI/Keychain/libsecret-wrapped); base64 here is a
// transport encoding, not a second layer of protection.
export function encodePersistedAccountSession(
  data: PersistedAccountSession,
  storage: Pick<SafeStorageLike, 'encryptString'>,
): string {
  return storage.encryptString(JSON.stringify(data)).toString('base64')
}

// Never throws: a corrupted file, a safeStorage that can no longer decrypt a
// blob written under a different OS user/profile (or after a Windows DPAPI
// user-key reset), or a malformed payload all collapse to "nothing to
// restore" rather than blocking startup (task requirement: 恢复失败/过期一律
// 干净降级为未登录，不报错卡启动).
export function decodePersistedAccountSession(
  content: string,
  storage: Pick<SafeStorageLike, 'decryptString'>,
): PersistedAccountSession | null {
  try {
    const plainText = storage.decryptString(Buffer.from(content, 'base64'))
    const parsed = JSON.parse(plainText) as unknown
    return isPersistedAccountSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Reads/saves/clears the single encrypted session file under the app's
 * userData directory. Writes and the logout clear are serialized through a
 * private promise chain (mirrors app-settings.ts's writeQueues, minus the
 * "one failed write wedges the next" gap: here the next queued operation
 * always runs regardless of how the previous one settled) so a
 * login-triggered save can never interleave on disk with a
 * near-simultaneous logout-triggered clear and leave a logged-out user's
 * credential sitting on disk (or vice versa).
 */
export class AccountSessionStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly storage: SafeStorageLike,
  ) {}

  async read(): Promise<PersistedAccountSession | null> {
    if (!isSafeStorageUsable(this.storage)) return null
    const content = await readSafeUtf8File(this.filePath, FILE_LABEL, MAX_FILE_BYTES).catch(() => null)
    if (!content) return null
    return decodePersistedAccountSession(content, this.storage)
  }

  save(data: NewApiPersistableSession): Promise<void> {
    return this.enqueue(async () => {
      // Availability can only get worse mid-run (e.g. the platform's
      // credential store becomes unreachable), never better in a way that
      // would retroactively make an earlier skip wrong -- so this check is
      // cheap insurance, not the primary guard (the caller already logs once
      // at startup when unavailable; see main.ts).
      if (!isSafeStorageUsable(this.storage)) return
      const record: PersistedAccountSession = {
        version: CURRENT_VERSION,
        userId: data.userId,
        cookies: [...data.cookies],
      }
      ensureSafeDataDirectory(path.dirname(this.filePath), FILE_LABEL)
      await writeAtomicSafeUtf8File(
        this.filePath,
        encodePersistedAccountSession(record, this.storage),
        FILE_LABEL,
      )
    })
  }

  clear(): Promise<void> {
    return this.enqueue(() => removeSafeDataFile(this.filePath, FILE_LABEL))
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(() => undefined, () => undefined)
    return next
  }
}

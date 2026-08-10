import path from 'node:path'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  removeSafeDataFile,
  writeAtomicSafeUtf8File,
} from './safe-local-data'
import type { SafeStorageLike } from './account-session-store'

// Persists the "记住密码" login credential -- the identifier + password the
// user asked the login dialog to keep. Same posture as account-session-store:
// this is the app's OWN login credential, not the relay API Key CLAUDE.md's
// "不给 API Key 加密" rule targets, so safeStorage encryption at rest is the
// correct (and already-established) treatment. The plaintext only ever
// crosses IPC on the dedicated account:get-remembered-login channel -- the
// same "explicit reveal channel" pattern config:reveal-api-key set (I3) --
// and both channels are in ipc.ts's quiet set so neither the value nor its
// shape reaches the runtime log (I13).

const CURRENT_VERSION = 1
const MAX_FILE_BYTES = 64 * 1024
const FILE_LABEL = '记住的登录凭据'

export interface PersistedAccountCredentials {
  version: 1
  identifier: string
  password: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isPersistedAccountCredentials(value: unknown): value is PersistedAccountCredentials {
  if (!isRecord(value)) return false
  if (value.version !== CURRENT_VERSION) return false
  if (typeof value.identifier !== 'string' || value.identifier.length === 0) return false
  if (typeof value.password !== 'string' || value.password.length === 0) return false
  return true
}

export function encodePersistedAccountCredentials(
  data: PersistedAccountCredentials,
  storage: Pick<SafeStorageLike, 'encryptString'>,
): string {
  return storage.encryptString(JSON.stringify(data)).toString('base64')
}

// Never throws: a corrupted file, a safeStorage blob written under a
// different OS user/profile, or a malformed payload all collapse to "nothing
// remembered" -- the login dialog just opens empty, same degradation rule as
// the session store.
export function decodePersistedAccountCredentials(
  content: string,
  storage: Pick<SafeStorageLike, 'decryptString'>,
): PersistedAccountCredentials | null {
  try {
    const plainText = storage.decryptString(Buffer.from(content, 'base64'))
    const parsed = JSON.parse(plainText) as unknown
    return isPersistedAccountCredentials(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Reads/saves/clears the single encrypted credential file under the app's
 * userData directory. Writes and clears share one promise chain for the same
 * reason AccountSessionStore's do: a login-triggered save must never
 * interleave on disk with an "uncheck 记住密码"-triggered clear.
 */
export class AccountCredentialStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly storage: SafeStorageLike,
  ) {}

  async read(): Promise<PersistedAccountCredentials | null> {
    if (!this.storage.isEncryptionAvailable()) return null
    const content = await readSafeUtf8File(this.filePath, FILE_LABEL, MAX_FILE_BYTES).catch(() => null)
    if (!content) return null
    return decodePersistedAccountCredentials(content, this.storage)
  }

  save(identifier: string, password: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.storage.isEncryptionAvailable()) return
      const record: PersistedAccountCredentials = {
        version: CURRENT_VERSION,
        identifier,
        password,
      }
      ensureSafeDataDirectory(path.dirname(this.filePath), FILE_LABEL)
      await writeAtomicSafeUtf8File(
        this.filePath,
        encodePersistedAccountCredentials(record, this.storage),
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

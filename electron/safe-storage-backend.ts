/**
 * Electron's safeStorage.isEncryptionAvailable() answers "can encryptString be
 * called", not "is the result protected". On a desktop without a system
 * keyring Chromium falls back to the `basic_text` backend, whose key is a
 * constant compiled into every build, so the ciphertext is readable by anyone
 * who can read the file. Credential files must refuse that backend instead of
 * committing what is effectively plaintext.
 */
export interface SafeStorageBackendLike {
  isEncryptionAvailable(): boolean
  // Electron only defines this on Linux, hence the optional call everywhere.
  getSelectedStorageBackend?(): string
}

export type SafeStorageBackendStatus = 'ok' | 'unavailable' | 'plaintext'

export function inspectSafeStorageBackend(storage: SafeStorageBackendLike): SafeStorageBackendStatus {
  if (!storage.isEncryptionAvailable()) return 'unavailable'
  return storage.getSelectedStorageBackend?.() === 'basic_text' ? 'plaintext' : 'ok'
}

export function isSafeStorageUsable(storage: SafeStorageBackendLike): boolean {
  return inspectSafeStorageBackend(storage) === 'ok'
}

export function safeStoragePlaintextMessage(subject: string): string {
  return `这台电脑没法安全保存密码，已拒绝写入${subject}。`
}

export type CredentialPersistence = 'durable' | 'session-only'

/**
 * Where account credentials live for this run. A Linux desktop may simply have
 * no keyring at all (i3, a remote session, a distro that ships none), and no
 * restart fixes that; refusing to sign in there would lock a paying customer
 * out for good. Session-only keeps the login in main-process memory and writes
 * nothing, so I3 still holds: the next launch starts signed out.
 *
 * Windows and macOS keep refusing. There a failure means a denied keychain
 * prompt or a broken profile the user can recover from, and silently dropping
 * to "not remembered" would hide that.
 */
export function resolveCredentialPersistence(platform: string, backend: SafeStorageBackendStatus): CredentialPersistence {
  return platform === 'linux' && backend !== 'ok' ? 'session-only' : 'durable'
}

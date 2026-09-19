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
  return `当前系统没有可用的密钥环，安全存储只能以明文保存，已拒绝写入${subject}。请先启用系统凭据服务后重试。`
}

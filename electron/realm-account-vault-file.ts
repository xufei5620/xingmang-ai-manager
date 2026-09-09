import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'
import { createRealmAccountVault, type RealmAccountVault } from './realm-account-vault'
import { RealmAccountError } from './realm-account'

export interface RealmVaultCipher {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
  getSelectedStorageBackend?(): string
}

/**
 * New file only: old saved-accounts.dat and account-session.dat are untouched.
 * The main-process assembly supplies app.getPath('userData'), never an IPC path.
 * Keep this binding outside the pure vault so tests can inject a memory backend.
 */
export function createFileRealmAccountVault(userDataDirectory: string, cipher: RealmVaultCipher): RealmAccountVault {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) throw new RealmAccountError('INVALID')
  const label = '分站账号安全存储'
  const filePath = path.join(userDataDirectory, 'realm-accounts-v2.dat')
  return createRealmAccountVault({
    isEncryptionAvailable: () => cipher.isEncryptionAvailable()
      && cipher.getSelectedStorageBackend?.() !== 'basic_text',
    encryptString: (plaintext) => cipher.encryptString(plaintext),
    decryptString: (encrypted) => cipher.decryptString(Buffer.from(encrypted)),
    read: () => readSafeUtf8File(filePath, label, 512 * 1024),
    writeAtomic: async (encrypted) => {
      ensureSafeDataDirectory(userDataDirectory, label)
      await writeAtomicSafeUtf8File(filePath, encrypted, label)
    },
  })
}

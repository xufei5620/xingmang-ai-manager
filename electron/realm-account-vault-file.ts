import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { assertSafeDataFile, ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'
import { createRealmAccountVault, type RealmAccountVault } from './realm-account-vault'
import { RealmAccountError } from './realm-account'
import { isSafeStorageUsable, type SafeStorageBackendLike } from './safe-storage-backend'

export interface RealmVaultCipher extends SafeStorageBackendLike {
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

export interface RealmVaultFileOptions {
  onRecovered?(backupFileName: string): void
}

/**
 * New file only: old saved-accounts.dat and account-session.dat are untouched.
 * The main-process assembly supplies app.getPath('userData'), never an IPC path.
 * Keep this binding outside the pure vault so tests can inject a memory backend.
 */
export function createFileRealmAccountVault(
  userDataDirectory: string,
  cipher: RealmVaultCipher,
  options: RealmVaultFileOptions = {},
): RealmAccountVault {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) throw new RealmAccountError('INVALID')
  const label = '分站账号安全存储'
  const filePath = path.join(userDataDirectory, 'realm-accounts-v2.dat')
  const available = () => isSafeStorageUsable(cipher)
  const read = () => readSafeUtf8File(filePath, label, 512 * 1024)
  return createRealmAccountVault({
    isEncryptionAvailable: available,
    encryptString: (plaintext) => cipher.encryptString(plaintext),
    decryptString: (encrypted) => cipher.decryptString(Buffer.from(encrypted)),
    read,
    writeAtomic: async (encrypted) => {
      ensureSafeDataDirectory(userDataDirectory, label)
      await writeAtomicSafeUtf8File(filePath, encrypted, label)
    },
    recoverAtomic: async (expected, replacement) => {
      ensureSafeDataDirectory(userDataDirectory, label)
      if (await read() !== expected) throw new Error('账号文件在恢复前发生变化')
      const backupFileName = `realm-accounts-v2.dat.unreadable-${Date.now()}-${randomUUID()}.bak`
      const backupPath = path.join(userDataDirectory, backupFileName)
      // Copy first, never rename the original away: a crash or failed commit
      // must not expose a missing vault that could reimport legacy cookies.
      assertSafeDataFile(backupPath, label)
      const handle = await fs.promises.open(backupPath, 'wx', 0o600)
      try {
        await handle.writeFile(expected, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      if (await readSafeUtf8File(backupPath, label, 512 * 1024) !== expected) {
        throw new Error('账号备份验证失败')
      }
      if (await read() !== expected) throw new Error('账号文件在备份期间发生变化')
      if (!available()) throw new Error('账号加密服务不可用')
      // Catch a key change during the backup before replacing the old record.
      cipher.decryptString(Buffer.from(replacement, 'base64'))
      await writeAtomicSafeUtf8File(filePath, replacement, label)
      try { options.onRecovered?.(backupFileName) } catch { /* logging cannot undo the commit */ }
    },
  })
}

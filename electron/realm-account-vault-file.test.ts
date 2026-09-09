import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileRealmAccountVault, type RealmVaultCipher } from './realm-account-vault-file'
import { parseRealmSavedAccount, type RealmSavedAccount } from './realm-account'

const directories: string[] = []
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-realm-vault-'))
  directories.push(directory)
  const key = randomBytes(32)
  const cipher: RealmVaultCipher = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test-encrypted',
    encryptString: (plaintext) => {
      const iv = randomBytes(12)
      const encryptor = createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([encryptor.update(plaintext, 'utf8'), encryptor.final()])
      return Buffer.concat([iv, encryptor.getAuthTag(), bytes])
    },
    decryptString: (encrypted) => {
      const decryptor = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
      decryptor.setAuthTag(encrypted.subarray(12, 28))
      return Buffer.concat([decryptor.update(encrypted.subarray(28)), decryptor.final()]).toString('utf8')
    },
  }
  return { directory, cipher, file: path.join(directory, 'realm-accounts-v2.dat'), vault: createFileRealmAccountVault(directory, cipher) }
}
function account(api = false): RealmSavedAccount {
  return parseRealmSavedAccount({ version: 2, realmId: api ? 'api-account' : 'xm-account', userId: '7',
    origin: api ? 'https://api.solov.cc' : 'https://xm.solov.cc', username: 'same@example.test',
    credential: api ? { kind: 'sub2api', accessToken: 'secret-access-test', refreshToken: 'secret-refresh-test', expiresAt: null }
      : { kind: 'new-api', cookies: ['session=secret-cookie-test'] } })
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    // Only directories minted by this fixture are eligible for cleanup.
    const relative = path.relative(os.tmpdir(), directory)
    if (path.isAbsolute(relative) || relative.startsWith('..') || !path.basename(directory).startsWith('xingmang-realm-vault-')) throw new Error('invalid test cleanup path')
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('file realm account vault', () => {
  it('round-trips both domains with equal user ids through the real safe atomic file path', async () => {
    const f = fixture()
    await f.vault.activate(account())
    await f.vault.activate(account(true))
    const restored = createFileRealmAccountVault(f.directory, f.cipher)
    expect(await restored.get(account())).toEqual(account())
    expect(await restored.get(account(true))).toEqual(account(true))
    expect((await restored.active())?.realmId).toBe('api-account')
    expect(await restored.list()).toHaveLength(2)
    const ciphertext = fs.readFileSync(f.file, 'utf8')
    expect(Buffer.from(ciphertext, 'base64').toString('utf8')).not.toMatch(/secret-(access|refresh|cookie)-test/)
    expect(fs.readdirSync(f.directory)).toEqual(['realm-accounts-v2.dat'])
  })
  it('refuses Electron basic_text without writing a fallback file', async () => {
    const f = fixture()
    f.cipher.getSelectedStorageBackend = () => 'basic_text'
    await expect(f.vault.activate(account(true))).rejects.toMatchObject({ code: 'STORAGE' })
    expect(fs.readdirSync(f.directory)).toEqual([])
  })
  it('preserves the original encrypted file on rename failure and succeeds on retry', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const before = fs.readFileSync(f.file)
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    await expect(f.vault.activate(account(true))).rejects.toMatchObject({ code: 'STORAGE' })
    expect(fs.readFileSync(f.file)).toEqual(before)
    expect(fs.readdirSync(f.directory)).toEqual(['realm-accounts-v2.dat'])
    rename.mockRestore()
    expect((await f.vault.active())?.realmId).toBe('xm-account')
    await f.vault.activate(account(true))
    expect((await f.vault.active())?.realmId).toBe('api-account')
  })
  it('preserves corruption and rejects a hard-linked account file without modifying either link', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const outside = path.join(f.directory, 'other-file.dat')
    fs.linkSync(f.file, outside)
    const original = fs.readFileSync(outside)
    await expect(f.vault.activate(account(true))).rejects.toMatchObject({ code: 'STORAGE' })
    expect(fs.readFileSync(outside)).toEqual(original)
    fs.unlinkSync(outside)
    fs.writeFileSync(f.file, 'broken-account-file', 'utf8')
    await expect(f.vault.activate(account(true))).rejects.toMatchObject({ code: 'STORAGE' })
    expect(fs.readFileSync(f.file, 'utf8')).toBe('broken-account-file')
  })
  it('persists the migration marker across restart so logout cannot reimport old cookies', async () => {
    const f = fixture()
    const legacy = { origin: 'https://xm.solov.cc', userId: 7, username: 'legacy', cookies: ['secret-cookie-test'] }
    await f.vault.migrateLegacy([legacy], legacy)
    await f.vault.signOut()
    const restarted = createFileRealmAccountVault(f.directory, f.cipher)
    expect(await restarted.hasMigratedLegacy()).toBe(true)
    expect(await restarted.migrateLegacy([legacy], legacy)).toBe(0)
    expect(await restarted.active()).toBeNull()
    expect(await restarted.list()).toEqual([])
  })
  it('persists only normalized routing hints after logout and preserves them on rename failure', async () => {
    const f = fixture()
    await f.vault.activate(account(), 'Same@Example.TEST')
    const before = fs.readFileSync(f.file)
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    await expect(f.vault.activate(account(true), 'same@example.test')).rejects.toMatchObject({ code: 'STORAGE' })
    expect(fs.readFileSync(f.file)).toEqual(before)
    rename.mockRestore()
    await f.vault.activate(account(true), 'same@example.test')
    await f.vault.signOut()
    const restarted = createFileRealmAccountVault(f.directory, f.cipher)
    expect(await restarted.active()).toBeNull()
    expect(await restarted.get(account(true))).toBeNull()
    expect(await restarted.preferredLoginSite('SAME@example.test')).toBe('solov-api')
    const document = JSON.parse(f.cipher.decryptString(Buffer.from(fs.readFileSync(f.file, 'utf8'), 'base64')))
    expect(document.loginHints).toEqual([{ identifier: 'same@example.test', realmId: 'api-account', userId: '7' }])
  })
})

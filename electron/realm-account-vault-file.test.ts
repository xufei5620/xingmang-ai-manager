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
  let key = randomBytes(32)
  const onRecovered = vi.fn()
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
  return { directory, cipher, onRecovered, rotateKey: () => { key = randomBytes(32) },
    file: path.join(directory, 'realm-accounts-v2.dat'), vault: createFileRealmAccountVault(directory, cipher, { onRecovered }) }
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

  it('recovers a lost encryption key once, preserves exact ciphertext and never reimports legacy sessions', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const original = fs.readFileSync(f.file)
    f.rotateKey()
    await expect(f.vault.active()).rejects.toMatchObject({ code: 'STORAGE', stage: 'decrypt' })
    expect(await Promise.all([f.vault.recoverUnreadable(), f.vault.recoverUnreadable()])).toEqual([true, false])
    expect(f.onRecovered).toHaveBeenCalledTimes(1)
    expect(f.onRecovered.mock.calls[0][1]).toBe('decrypt')
    const backup = path.join(f.directory, f.onRecovered.mock.calls[0][0])
    expect(fs.readFileSync(backup)).toEqual(original)
    expect(await f.vault.active()).toBeNull()
    const restarted = createFileRealmAccountVault(f.directory, f.cipher)
    expect(await restarted.hasMigratedLegacy()).toBe(true)
    const legacy = { origin: 'https://xm.solov.cc', userId: 7, username: 'legacy', cookies: ['old-session'] }
    expect(await restarted.migrateLegacy([legacy], legacy)).toBe(0)
    expect(await restarted.list()).toEqual([])
    await restarted.activate(account(true))
    expect(await createFileRealmAccountVault(f.directory, f.cipher).active()).toEqual(account(true))
    expect(fs.readFileSync(backup)).toEqual(original)
  })

  it('recovers authenticated ciphertext corruption without printing or discarding the original', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const bytes = Buffer.from(fs.readFileSync(f.file, 'utf8'), 'base64')
    bytes[15] ^= 1
    fs.writeFileSync(f.file, bytes.toString('base64'), 'utf8')
    const original = fs.readFileSync(f.file)
    await expect(f.vault.recoverUnreadable()).resolves.toBe(true)
    const backup = path.join(f.directory, f.onRecovered.mock.calls[0][0])
    expect(fs.readFileSync(backup)).toEqual(original)
    expect(JSON.stringify(f.onRecovered.mock.calls)).not.toMatch(/secret-cookie-test|session=/)
  })

  it('never treats an unavailable or broken cipher as a lost key', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const original = fs.readFileSync(f.file)
    f.cipher.isEncryptionAvailable = () => false
    await expect(f.vault.recoverUnreadable()).rejects.toMatchObject({ stage: 'availability' })
    f.cipher.isEncryptionAvailable = () => true
    f.cipher.decryptString = () => { throw new Error('native error with secret-cookie-test') }
    const error = await f.vault.recoverUnreadable().catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'STORAGE', stage: 'verify' })
    expect(JSON.stringify(error)).not.toContain('secret-cookie-test')
    expect(fs.readFileSync(f.file)).toEqual(original)
    expect(fs.readdirSync(f.directory)).toEqual(['realm-accounts-v2.dat'])
  })

  it('retries old ciphertext after the probe so transient decrypt failures do not reset accounts', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const original = fs.readFileSync(f.file)
    vi.spyOn(f.cipher, 'decryptString').mockImplementationOnce(() => { throw new Error('temporary') })
    await expect(f.vault.recoverUnreadable()).resolves.toBe(false)
    expect(await f.vault.active()).toEqual(account())
    expect(fs.readFileSync(f.file)).toEqual(original)
    expect(f.onRecovered).not.toHaveBeenCalled()
  })

  it('verifies new ciphertext before a normal write can replace the last usable account', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const original = fs.readFileSync(f.file)
    f.cipher.encryptString = () => Buffer.from('unreadable-encrypted-output')
    await expect(f.vault.activate(account(true))).rejects.toMatchObject({ stage: 'verify' })
    expect(fs.readFileSync(f.file)).toEqual(original)
    expect(await f.vault.active()).toEqual(account())
  })

  // 退回旧版读到新版写的库：解得开、是 JSON，只是版本或字段认不出。清掉它，客户升回去以后账号也没了。
  it('leaves a decryptable document with an unknown schema intact', async () => {
    const f = fixture()
    for (const document of [
      { version: 3, accounts: [], activeId: null },
      { version: 2, activeId: null, accounts: [{ version: 3, realmId: 'future-account' }] },
    ]) {
      const content = f.cipher.encryptString(JSON.stringify(document)).toString('base64')
      fs.writeFileSync(f.file, content, 'utf8')
      await expect(f.vault.recoverUnreadable()).rejects.toMatchObject({ stage: 'validate' })
      expect(fs.readFileSync(f.file, 'utf8')).toBe(content)
      expect(fs.readdirSync(f.directory)).toEqual(['realm-accounts-v2.dat'])
    }
    expect(f.onRecovered).not.toHaveBeenCalled()
  })

  // DM-2：硬盘坏道、杀毒或同步盘截了文件、被别的程序改过，以前在 decode 这步就停，点多少次登录都进不去。
  it('recovers a damaged account file on explicit recovery and keeps a copy of what was read', async () => {
    type Fixture = ReturnType<typeof fixture>
    const cases: Array<[string, (f: Fixture) => Buffer, 'decode' | 'parse']> = [
      ['an empty file', () => Buffer.alloc(0), 'decode'],
      ['a file cut off mid-way', (f) => Buffer.from(fs.readFileSync(f.file, 'utf8').slice(0, -3), 'utf8'), 'decode'],
      ['text that is not ciphertext', () => Buffer.from('broken-account-file', 'utf8'), 'decode'],
      ['a run of zeroed bytes', () => Buffer.alloc(64), 'decode'],
      // 坏道读出来的乱码字节不成文字，备份里留的是读到的那份（乱码换成替换字符），这种文件本来也解不出来。
      ['bytes that are not text at all', () => Buffer.from([0xff, 0xfe, 0x80, 0x41, 0xc3]), 'decode'],
      ['ciphertext that decrypts to a cut-off document',
        (f) => Buffer.from(f.cipher.encryptString('{"version":2,"activeId":null,"acc').toString('base64'), 'utf8'), 'parse'],
      ['ciphertext that decrypts to a bare value', (f) => Buffer.from(f.cipher.encryptString('7').toString('base64'), 'utf8'), 'parse'],
    ]
    for (const [label, content, reason] of cases) {
      const f = fixture()
      await f.vault.activate(account())
      const original = content(f)
      fs.writeFileSync(f.file, original)
      await expect(f.vault.active(), label).rejects.toMatchObject({ code: 'STORAGE', stage: reason })
      expect(fs.readFileSync(f.file), label).toEqual(original)

      await expect(f.vault.recoverUnreadable(), label).resolves.toBe(true)
      expect(f.onRecovered, label).toHaveBeenCalledOnce()
      expect(f.onRecovered.mock.calls[0][1], label).toBe(reason)
      const backup = path.join(f.directory, f.onRecovered.mock.calls[0][0])
      expect(fs.readFileSync(backup), label).toEqual(Buffer.from(original.toString('utf8'), 'utf8'))
      expect(await f.vault.active(), label).toBeNull()
      expect(await f.vault.hasMigratedLegacy(), label).toBe(true)
      await f.vault.activate(account(true))
      expect(await createFileRealmAccountVault(f.directory, f.cipher).active(), label).toEqual(account(true))
    }
  })

  // 记事本这类编辑器打开再存，会在末尾补换行、在开头加 BOM。密文本身没坏，照常读出来，不用重置。
  it('reads a vault an editor saved back with surrounding whitespace or a byte-order mark', async () => {
    for (const wrap of [(text: string) => `${text}\r\n`, (text: string) => `\uFEFF${text}`, (text: string) => ` ${text}\n\n`]) {
      const f = fixture()
      await f.vault.activate(account())
      const edited = wrap(fs.readFileSync(f.file, 'utf8'))
      fs.writeFileSync(f.file, edited, 'utf8')
      expect(await f.vault.active()).toEqual(account())
      await expect(f.vault.recoverUnreadable()).resolves.toBe(false)
      expect(fs.readFileSync(f.file, 'utf8')).toBe(edited)
      expect(fs.readdirSync(f.directory)).toEqual(['realm-accounts-v2.dat'])
      expect(f.onRecovered).not.toHaveBeenCalled()
    }
  })

  it('rejects unsafe hard links and read failures without backing up or changing files', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const original = fs.readFileSync(f.file)
    const linked = path.join(f.directory, 'linked.dat')
    fs.linkSync(f.file, linked)
    await expect(f.vault.recoverUnreadable()).rejects.toMatchObject({ stage: 'read' })
    expect(fs.readFileSync(linked)).toEqual(original)
    fs.unlinkSync(linked)
    const open = vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(f.vault.recoverUnreadable()).rejects.toMatchObject({ stage: 'read' })
    open.mockRestore()
    expect(fs.readFileSync(f.file)).toEqual(original)
    expect(fs.readdirSync(f.directory)).toEqual(['realm-accounts-v2.dat'])
  })

  it('retains the original if the backup cannot be written', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const original = fs.readFileSync(f.file)
    f.rotateKey()
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file).endsWith('.bak')) throw new Error('backup denied')
      return open(file, flags, mode)
    })
    await expect(f.vault.recoverUnreadable()).rejects.toMatchObject({ stage: 'recover' })
    expect(fs.readFileSync(f.file)).toEqual(original)
    expect(fs.readdirSync(f.directory)).toEqual(['realm-accounts-v2.dat'])
    expect(f.onRecovered).not.toHaveBeenCalled()
  })

  it('keeps both original and backup when replacement fails and allows retry', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const original = fs.readFileSync(f.file)
    f.rotateKey()
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('locked'), { code: 'EBUSY' }))
    await expect(f.vault.recoverUnreadable()).rejects.toMatchObject({ stage: 'recover' })
    expect(fs.readFileSync(f.file)).toEqual(original)
    const backups = fs.readdirSync(f.directory).filter((name) => name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(f.directory, backups[0]))).toEqual(original)
    expect(f.onRecovered).not.toHaveBeenCalled()
    rename.mockRestore()
    await expect(f.vault.recoverUnreadable()).resolves.toBe(true)
    expect(await f.vault.hasMigratedLegacy()).toBe(true)
  })

  it('does not overwrite a file replaced while the backup was being created', async () => {
    const f = fixture()
    await f.vault.activate(account())
    const original = fs.readFileSync(f.file)
    f.rotateKey()
    const changed = f.cipher.encryptString(JSON.stringify({ version: 2, activeId: null, accounts: [], legacyMigrated: true })).toString('base64')
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode)
      if (String(file).endsWith('.bak') && flags === 'wx') fs.writeFileSync(f.file, changed, 'utf8')
      return handle
    })
    await expect(f.vault.recoverUnreadable()).rejects.toMatchObject({ stage: 'recover' })
    expect(fs.readFileSync(f.file, 'utf8')).toBe(changed)
    const backups = fs.readdirSync(f.directory).filter((name) => name.endsWith('.bak'))
    expect(fs.readFileSync(path.join(f.directory, backups[0]))).toEqual(original)
    expect(f.onRecovered).not.toHaveBeenCalled()
  })

  it('does not report failure after a committed recovery if diagnostics logging throws', async () => {
    const f = fixture()
    await f.vault.activate(account())
    f.rotateKey()
    f.onRecovered.mockImplementation(() => { throw new Error('logger unavailable') })
    await expect(f.vault.recoverUnreadable()).resolves.toBe(true)
    expect(await f.vault.hasMigratedLegacy()).toBe(true)
  })
})

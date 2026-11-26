import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeyDigest, classifyBackupKey, ConfigBackupStore, resolveBackupIdTime, type ConfigBackupAccountContext } from './backups'
import type { ProviderId } from './catalog'
import { providerConfigPaths } from './config-files'
import { renameWithTransientRetrySync } from './safe-local-data'
import { canCreateSymbolicLink } from './symlink-capability.test-support'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-backups-'))
  temporaryDirectories.push(root)
  const home = path.join(root, 'home')
  const userData = path.join(root, 'user-data')
  fs.mkdirSync(home, { recursive: true })
  return { root, home, userData }
}

function writeConfig(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function fixtureProviderRoots(userHome: string) {
  return { userHome, codexHome: path.join(userHome, '.codex') }
}

// What a rename reports on Windows while a scanner or the indexer holds the file.
function heldError(code: 'EPERM' | 'EBUSY'): NodeJS.ErrnoException {
  const message = code === 'EPERM'
    ? 'EPERM: operation not permitted, rename'
    : 'EBUSY: resource busy or locked, rename'
  return Object.assign(new Error(message), { code })
}

function temporaryNames(directory: string): string[] {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))
}

function writeBackupManifestFixture(
  userData: string,
  provider: ProviderId,
  file: Record<string, unknown>,
): string {
  const id = `20260803000000000-${randomUUID()}`
  const directory = path.join(userData, 'backups', id)
  const content = 'legacy-config'
  fs.mkdirSync(path.join(directory, 'files'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'files', '000-config'), content, 'utf8')
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    version: 'targetRoot' in file ? 2 : 1,
    id,
    provider,
    reason: 'manual',
    createdAt: '2026-08-03T00:00:00.000Z',
    files: [{
      ...file,
      backupRelativePath: 'files/000-config',
      existed: true,
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    }],
  }), 'utf8')
  return id
}

describe('ConfigBackupStore', () => {
  it('does not consult the OS home directory when provider roots are explicit', () => {
    const { root, home: userHome, userData } = fixture()
    const providerRoots = { userHome, codexHome: path.join(root, 'custom-codex') }
    const homedir = vi.spyOn(os, 'homedir').mockImplementation(() => {
      throw new Error('os.homedir must not be consulted')
    })
    try {
      const store = new ConfigBackupStore({ userDataDirectory: userData, providerRoots })
      const backup = store.create('codex')
      expect(backup.valid).toBe(true)
    } finally {
      homedir.mockRestore()
    }
  })

  it('creates and restores a root-relative v2 Codex backup outside userHome', () => {
    const { root, home: userHome, userData } = fixture()
    const codexHome = path.join(root, 'custom-codex')
    const providerRoots = { userHome, codexHome }
    const [configPath] = providerConfigPaths('codex', providerRoots)
    writeConfig(configPath, 'model = "original"\n')
    const store = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: userHome,
    })

    const backup = store.create('codex')
    const manifest = JSON.parse(fs.readFileSync(
      path.join(userData, 'backups', backup.id, 'manifest.json'),
      'utf8',
    )) as { version: number; files: Array<Record<string, unknown>> }
    expect(manifest.version).toBe(2)
    expect(manifest.files[0]).toMatchObject({
      targetRoot: 'codex-home',
      targetRelativePath: 'config.toml',
    })
    expect(store.inspect(backup.id).valid).toBe(true)
    expect(store.list()).toContainEqual(expect.objectContaining({ id: backup.id, valid: true }))

    writeConfig(configPath, 'model = "changed"\n')
    const restored = store.restore(backup.id)

    expect(fs.readFileSync(configPath, 'utf8')).toBe('model = "original"\n')
    expect(restored.restoredFiles).toContain(configPath)
    expect(fs.existsSync(path.join(userHome, '.codex'))).toBe(false)
  })

  it('keeps non-Codex v2 backups under userHome when Codex uses a custom root', () => {
    const { root, home: userHome, userData } = fixture()
    const providerRoots = { userHome, codexHome: path.join(root, 'custom-codex') }
    const [settingsPath] = providerConfigPaths('claude', providerRoots)
    writeConfig(settingsPath, '{"model":"original"}\n')
    const store = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: userHome,
    })

    const backup = store.create('claude')
    const manifest = JSON.parse(fs.readFileSync(
      path.join(userData, 'backups', backup.id, 'manifest.json'),
      'utf8',
    )) as { files: Array<Record<string, unknown>> }
    expect(manifest.files[0]).toMatchObject({
      targetRoot: 'user-home',
      targetRelativePath: '.claude/settings.json',
    })

    writeConfig(settingsPath, '{"model":"changed"}\n')
    store.restore(backup.id)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"model":"original"}\n')
    expect(fs.existsSync(path.join(providerRoots.codexHome, 'settings.json'))).toBe(false)
  })

  it('restores historical v1 Codex backups only at the default root', () => {
    const { root, home: userHome, userData } = fixture()
    const defaultCodexHome = path.join(userHome, '.codex')
    const configPath = path.join(defaultCodexHome, 'config.toml')
    writeConfig(configPath, 'current-config')
    const legacy = writeBackupManifestFixture(userData, 'codex', {
      targetRelativePath: '.codex/config.toml',
    })
    const defaultStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots: { userHome, codexHome: defaultCodexHome },
      homeDirectory: userHome,
    })

    expect(defaultStore.inspect(legacy).valid).toBe(true)
    defaultStore.restore(legacy)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('legacy-config')

    const customCodexHome = path.join(root, 'custom-codex')
    const customStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots: { userHome, codexHome: customCodexHome },
      homeDirectory: userHome,
    })
    expect(customStore.list().find((item) => item.id === legacy)).toMatchObject({ valid: false })
    expect(() => customStore.inspect(legacy)).toThrow('旧版 Codex 备份')
    expect(() => customStore.restore(legacy)).toThrow('旧版 Codex 备份')
    expect(fs.existsSync(path.join(customCodexHome, 'config.toml'))).toBe(false)
  })

  it('restores historical v1 non-Codex backups with a custom Codex root', () => {
    const { root, home: userHome, userData } = fixture()
    const settingsPath = path.join(userHome, '.claude', 'settings.json')
    writeConfig(settingsPath, 'current-config')
    const legacy = writeBackupManifestFixture(userData, 'claude', {
      targetRelativePath: '.claude/settings.json',
    })
    const store = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots: { userHome, codexHome: path.join(root, 'custom-codex') },
      homeDirectory: userHome,
    })

    store.restore(legacy)

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('legacy-config')
  })

  it.each([
    { targetRoot: 'codex-home', targetRelativePath: '../escape' },
    { targetRoot: 'user-home', targetRelativePath: '.codex/config.toml' },
    { targetRoot: 'codex-home', targetRelativePath: 'unlisted.toml' },
  ])('rejects a v2 target outside the exact provider allowlist', ({ targetRoot, targetRelativePath }) => {
    const { root, home: userHome, userData } = fixture()
    const codexHome = path.join(root, 'custom-codex')
    fs.mkdirSync(codexHome, { recursive: true })
    const id = writeBackupManifestFixture(userData, 'codex', { targetRoot, targetRelativePath })
    const store = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots: { userHome, codexHome },
      homeDirectory: userHome,
    })

    expect(() => store.inspect(id)).toThrow(/安全|未授权/)
    expect(fs.existsSync(path.join(root, 'escape'))).toBe(false)
  })

  it('rejects a custom Codex root redirected through a directory junction', () => {
    const { root, home: userHome, userData } = fixture()
    const outside = path.join(root, 'outside-codex')
    const codexHome = path.join(root, 'linked-codex')
    writeConfig(path.join(outside, 'config.toml'), 'outside-config')
    fs.symlinkSync(outside, codexHome, process.platform === 'win32' ? 'junction' : 'dir')
    const store = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots: { userHome, codexHome },
      homeDirectory: userHome,
    })

    expect(() => store.create('codex')).toThrow(/符号链接|目录联接/)
    expect(fs.readFileSync(path.join(outside, 'config.toml'), 'utf8')).toBe('outside-config')
    expect(store.list()).toEqual([])
  })

  it('creates a manifest backup and restores a complete provider round trip', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    const originalConfig = 'model = "gpt-5.6-sol"\nmodel_provider = "mycodex"\n'
    const originalAuth = '{"OPENAI_API_KEY":"sk-roundtrip-secret"}\n'
    writeConfig(configPath, originalConfig)
    writeConfig(authPath, originalAuth)
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })

    const backup = store.create('codex', 'manual')
    writeConfig(configPath, 'model = "changed"\n')
    writeConfig(authPath, '{"OPENAI_API_KEY":"changed"}\n')
    const restored = store.restore(backup.id)

    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig)
    expect(fs.readFileSync(authPath, 'utf8')).toBe(originalAuth)
    expect(restored.restoredBackupId).toBe(backup.id)
    expect(store.inspect(restored.preRestoreBackupId).reason).toBe('pre-restore')
    expect(store.list()).toHaveLength(2)
  })

  it('keeps an old Gemini CLI backup on disk but no longer restores it', () => {
    const { home, userData } = fixture()
    const [settingsPath] = providerConfigPaths('gemini', fixtureProviderRoots(home))
    writeConfig(settingsPath, '{"model":{"name":"gemini-3.8-flash-high"}}\n')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('gemini', 'manual')
    writeConfig(settingsPath, '{"model":{"name":"changed"}}\n')

    expect(() => store.restore(backup.id)).toThrow('未知的配置类型')
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"model":{"name":"changed"}}\n')
    expect(store.list().map((entry) => entry.id)).toEqual([backup.id])
  })

  it('records absent targets and removes files that did not exist in the snapshot', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'model = "initial"\n')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')

    writeConfig(authPath, '{"OPENAI_API_KEY":"later"}\n')
    store.restore(backup.id)
    expect(fs.existsSync(authPath)).toBe(false)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('model = "initial"\n')
  })

  it('does not expose API key content in summaries or previews', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    const secret = 'sk-summary-must-not-leak'
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    writeConfig(authPath, JSON.stringify({ OPENAI_API_KEY: secret }))
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')

    expect(JSON.stringify(store.list())).not.toContain(secret)
    expect(JSON.stringify(store.inspect(backup.id))).not.toContain(secret)
  })

  it('records whose key a backup holds and classifies it against the signed-in account', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    const secret = 'sk-account-a-managed'
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    writeConfig(authPath, JSON.stringify({ OPENAI_API_KEY: secret }))
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const accountA: ConfigBackupAccountContext = {
      accountId: '["solov",1]', accountName: 'alice', keyDigests: new Set([apiKeyDigest(secret)]),
    }
    const accountB: ConfigBackupAccountContext = {
      accountId: '["solov",2]', accountName: 'bob', keyDigests: new Set([apiKeyDigest('sk-account-b')]),
    }

    const created = store.create('codex', 'manual', undefined, accountA)
    expect(created).toMatchObject({ keyOwnership: 'current', keyAccountName: null })
    expect(store.list(accountA)[0]).toMatchObject({ keyOwnership: 'current', keyAccountName: null })
    expect(store.inspect(created.id, accountB)).toMatchObject({ keyOwnership: 'other', keyAccountName: 'alice' })
    // Signed out: still names the account the key was issued to.
    expect(store.list(null)[0]).toMatchObject({ keyOwnership: 'other', keyAccountName: 'alice' })

    const manifest = fs.readFileSync(path.join(userData, 'backups', created.id, 'manifest.json'), 'utf8')
    expect(manifest).not.toContain(secret)
    expect(JSON.stringify(store.list(accountB))).not.toContain(apiKeyDigest(secret))
  })

  it('marks a key the signed-in account did not issue without naming an account', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    writeConfig(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-typed-by-hand' }))
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const account: ConfigBackupAccountContext = {
      accountId: '["solov",1]', accountName: 'alice', keyDigests: new Set([apiKeyDigest('sk-other')]),
    }

    const created = store.create('codex', 'manual', undefined, account)
    expect(created).toMatchObject({ keyOwnership: 'other', keyAccountName: null })
    expect(store.list(null)[0]).toMatchObject({ keyOwnership: 'unknown', keyAccountName: null })
  })

  it('reports a backup without a key and leaves legacy manifests unlabelled', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const account: ConfigBackupAccountContext = { accountId: '["solov",1]', accountName: 'alice', keyDigests: new Set() }

    const created = store.create('codex', 'manual', undefined, account)
    const legacy = writeBackupManifestFixture(userData, 'claude', { targetRelativePath: '.claude/settings.json' })
    const summaries = store.list(account)
    expect(summaries.find((entry) => entry.id === created.id)).toMatchObject({ keyOwnership: 'none' })
    expect(summaries.find((entry) => entry.id === legacy)).toMatchObject({ keyOwnership: 'unknown', keyAccountName: null })
  })

  it('ignores a damaged key record instead of failing the backup', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    writeConfig(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-damaged' }))
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const created = store.create('codex')
    const manifestPath = path.join(userData, 'backups', created.id, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.key = { digest: 'not-a-digest', accountId: 1, accountName: '<script>' }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

    expect(store.list(null)[0]).toMatchObject({ valid: true, keyOwnership: 'unknown' })
    expect(store.inspect(created.id).valid).toBe(true)
  })

  it('returns the restored provider and labels the pre-restore snapshot with the account', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    writeConfig(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-before' }))
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')
    writeConfig(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-managed-now' }))
    const account: ConfigBackupAccountContext = {
      accountId: '["solov",1]', accountName: 'alice', keyDigests: new Set([apiKeyDigest('sk-managed-now')]),
    }

    const restored = store.restore(backup.id, account)
    expect(restored.provider).toBe('codex')
    expect(store.inspect(restored.preRestoreBackupId, account)).toMatchObject({ keyOwnership: 'current' })
  })

  it('does not attribute a rotated key to the same account that recorded it', () => {
    const digest = apiKeyDigest('sk-rotated')
    const record = { digest, accountId: '["solov",1]', accountName: 'alice' }
    expect(classifyBackupKey(record, { accountId: '["solov",1]', accountName: 'alice', keyDigests: new Set() }))
      .toEqual({ keyOwnership: 'other', keyAccountName: null })
    expect(classifyBackupKey(record, { accountId: '["solov",2]', accountName: 'bob', keyDigests: new Set() }))
      .toEqual({ keyOwnership: 'other', keyAccountName: 'alice' })
  })

  it('cleans an incomplete snapshot when a backup operation fails', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'config')
    writeConfig(authPath, 'auth')
    const store = new ConfigBackupStore({
      userDataDirectory: userData,
      homeDirectory: home,
      hooks: {
        beforeBackupFile: (_target, index) => {
          if (index === 1) throw new Error('injected backup failure')
        },
      },
    })

    expect(() => store.create('codex')).toThrow('injected backup failure')
    expect(store.list()).toEqual([])
    expect(fs.readFileSync(configPath, 'utf8')).toBe('config')
    expect(fs.readFileSync(authPath, 'utf8')).toBe('auth')
  })

  it('rolls back already committed targets after a restore failure', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original-config')
    writeConfig(authPath, 'original-auth')
    const initialStore = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = initialStore.create('codex')
    writeConfig(configPath, 'current-config')
    writeConfig(authPath, 'current-auth')
    const failingStore = new ConfigBackupStore({
      userDataDirectory: userData,
      homeDirectory: home,
      hooks: {
        beforeRestoreCommit: (_target, index) => {
          if (index === 1) throw new Error('injected restore failure')
        },
      },
    })

    expect(() => failingStore.restore(backup.id)).toThrow('injected restore failure')
    expect(fs.readFileSync(configPath, 'utf8')).toBe('current-config')
    expect(fs.readFileSync(authPath, 'utf8')).toBe('current-auth')
    expect(failingStore.list().some((item) => item.reason === 'pre-restore')).toBe(true)
  })

  it('rejects backup bytes changed while creating the pre-restore snapshot', () => {
    const { home, userData } = fixture()
    const providerRoots = fixtureProviderRoots(home)
    const [configPath] = providerConfigPaths('codex', providerRoots)
    writeConfig(configPath, 'original-config')
    const initialStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: home,
    })
    const backup = initialStore.create('codex')
    const backupRelativePath = initialStore.inspect(backup.id).files
      .find((file) => file.targetRelativePath.endsWith('config.toml'))?.backupRelativePath
    expect(backupRelativePath).toBeTruthy()
    const backupPath = path.join(userData, 'backups', backup.id, ...backupRelativePath!.split('/'))
    writeConfig(configPath, 'current-config')
    let tampered = false
    const tamperingStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: home,
      hooks: {
        beforeBackupFile: () => {
          if (tampered) return
          tampered = true
          fs.writeFileSync(backupPath, 'tampered-config', 'utf8')
        },
      },
    })

    expect(() => tamperingStore.restore(backup.id)).toThrow(/损坏|篡改/)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('current-config')
  })

  it('does not overwrite a target created during restore commit', () => {
    const { home, userData } = fixture()
    const providerRoots = fixtureProviderRoots(home)
    const [configPath] = providerConfigPaths('codex', providerRoots)
    writeConfig(configPath, 'original-config')
    const initialStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: home,
    })
    const backup = initialStore.create('codex')
    fs.rmSync(configPath)
    const failingStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: home,
      hooks: {
        beforeRestoreCommit: (target, index) => {
          if (index === 0) writeConfig(target, 'concurrent-config')
        },
      },
    })

    expect(() => failingStore.restore(backup.id)).toThrow(/恢复期间发生变化/)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('concurrent-config')
  })

  it('preserves a replacement target and the moved-aside current config', () => {
    const { home, userData } = fixture()
    const providerRoots = fixtureProviderRoots(home)
    const [configPath] = providerConfigPaths('codex', providerRoots)
    writeConfig(configPath, 'original-config')
    const initialStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: home,
    })
    const backup = initialStore.create('codex')
    writeConfig(configPath, 'current-config')
    const failingStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: home,
      hooks: {
        beforeRestoreCommit: (target, index) => {
          if (index === 0) writeConfig(target, 'concurrent-config')
        },
      },
    })

    expect(() => failingStore.restore(backup.id)).toThrow(/当前配置已保留在/)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('concurrent-config')
    const rollbackName = fs.readdirSync(path.dirname(configPath))
      .find((name) => name.includes('.xingmang-rollback-'))
    expect(rollbackName).toBeTruthy()
    expect(fs.readFileSync(path.join(path.dirname(configPath), rollbackName!), 'utf8')).toBe('current-config')
  })

  it.runIf(canCreateSymbolicLink)('rejects a broken symbolic link introduced during restore commit', () => {
    const { home, userData } = fixture()
    const providerRoots = fixtureProviderRoots(home)
    const [configPath] = providerConfigPaths('codex', providerRoots)
    const missingTarget = path.join(home, 'missing-config')
    writeConfig(configPath, 'original-config')
    const initialStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: home,
    })
    const backup = initialStore.create('codex')
    writeConfig(configPath, 'current-config')
    const failingStore = new ConfigBackupStore({
      userDataDirectory: userData,
      providerRoots,
      homeDirectory: home,
      hooks: {
        beforeRestoreCommit: (target, index) => {
          if (index === 0) fs.symlinkSync(missingTarget, target)
        },
      },
    })

    expect(() => failingStore.restore(backup.id)).toThrow(/符号链接|目录联接/)
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(missingTarget)).toBe(false)
    const rollbackName = fs.readdirSync(path.dirname(configPath))
      .find((name) => name.includes('.xingmang-rollback-'))
    expect(rollbackName).toBeTruthy()
    expect(fs.readFileSync(path.join(path.dirname(configPath), rollbackName!), 'utf8')).toBe('current-config')
  })

  it('keeps the current configuration when moving it aside fails during restore', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original-config')
    writeConfig(authPath, 'original-auth')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')
    writeConfig(configPath, 'current-config')
    writeConfig(authPath, 'current-auth')

    const realRename = fs.renameSync
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === configPath) throw new Error('injected rename failure')
      return realRename(from, to)
    })
    try {
      expect(() => store.restore(backup.id)).toThrow('injected rename failure')
    } finally {
      spy.mockRestore()
    }
    expect(fs.readFileSync(configPath, 'utf8')).toBe('current-config')
    expect(fs.readFileSync(authPath, 'utf8')).toBe('current-auth')
  })

  it('restores the oldest backup even when pruning runs at the retention limit', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'oldest-config')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const template = store.create('codex')
    const templateDirectory = path.join(userData, 'backups', template.id)
    const templateManifest = JSON.parse(
      fs.readFileSync(path.join(templateDirectory, 'manifest.json'), 'utf8'),
    ) as { id: string }

    // 再放 200 份时间戳更早的备份，让被恢复的那份恰好落在 prune 的删除窗口内。只有要恢复的最旧那份
    // 是整份复制的；prune 只按文件夹名数配额，其余 199 份建成空文件夹就够了。以前 200 份都整份复制
    // （连同收尾删掉，文件系统调用是现在的五倍），Windows runner 上这一段偶尔慢十几倍，11-22 撞了 30 秒（#2084）。
    const cloneIds = Array.from(
      { length: 200 },
      (_, index) => `199901010000${String(index).padStart(5, '0')}-${randomUUID()}`,
    )
    const oldestDirectory = path.join(userData, 'backups', cloneIds[0])
    fs.cpSync(templateDirectory, oldestDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(oldestDirectory, 'manifest.json'),
      JSON.stringify({ ...templateManifest, id: cloneIds[0] }),
      'utf8',
    )
    for (const cloneId of cloneIds.slice(1)) fs.mkdirSync(path.join(userData, 'backups', cloneId))

    writeConfig(configPath, 'current-config')
    const restored = store.restore(cloneIds[0])
    expect(restored.restoredBackupId).toBe(cloneIds[0])
    expect(fs.readFileSync(configPath, 'utf8')).toBe('oldest-config')
    expect(fs.existsSync(path.join(userData, 'backups', cloneIds[0]))).toBe(true)
    // 恢复前存的那份让总数到 202，比上限多两份：最旧的正被恢复、留下，第二旧的清掉。这一句
    // 证明空文件夹确实算进了配额、清理真的跑到了上限，不然上面几句不清理也照样过。
    expect(fs.existsSync(path.join(userData, 'backups', cloneIds[1]))).toBe(false)
  })

  it('preserves the rollback copy when restoring it back also fails', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original-config')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')
    writeConfig(configPath, 'current-config')

    const realRename = fs.renameSync
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === configPath) throw new Error('injected rename failure')
      return realRename(from, to)
    })
    try {
      expect(() => store.restore(backup.id)).toThrow(/当前配置已保留在/)
    } finally {
      spy.mockRestore()
    }
    const rollbackName = fs.readdirSync(path.dirname(configPath))
      .find((name) => name.includes('.xingmang-rollback-'))
    expect(rollbackName).toBeTruthy()
    expect(fs.readFileSync(path.join(path.dirname(configPath), rollbackName!), 'utf8')).toBe('current-config')
  })

  it('deletes a backup directory after path validation', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')
    expect(store.list()).toHaveLength(1)

    store.delete(backup.id)
    expect(store.list()).toEqual([])
    expect(fs.existsSync(path.join(userData, 'backups', backup.id))).toBe(false)
    expect(() => store.delete('../escape')).toThrow('备份 ID 格式错误')

    const corruptDirectory = path.join(userData, 'backups', 'corrupt-manifest')
    fs.mkdirSync(corruptDirectory, { recursive: true })
    fs.writeFileSync(path.join(corruptDirectory, 'manifest.json'), '{invalid', 'utf8')
    store.delete('corrupt-manifest')
    expect(fs.existsSync(corruptDirectory)).toBe(false)
  })

  it('keeps the newest backups the caller counts and removes the older ones of them', async () => {
    const { home, userData } = fixture()
    const [codexConfig] = providerConfigPaths('codex', fixtureProviderRoots(home))
    const [geminiSettings] = providerConfigPaths('gemini', fixtureProviderRoots(home))
    writeConfig(codexConfig, 'model = "gpt-5.6-sol"\n')
    writeConfig(geminiSettings, '{"model":{"name":"gemini-3.8-flash-high"}}\n')
    let second = 0
    const store = new ConfigBackupStore({
      userDataDirectory: userData,
      homeDirectory: home,
      now: () => new Date(Date.UTC(2026, 10, 11, 0, 0, second++)),
    })
    // The retired tool's backup is the oldest one and is not among those counted.
    const gemini = store.create('gemini', 'manual')
    const codex = Array.from({ length: 13 }, () => store.create('codex', 'pre-save'))
    const corrupt = path.join(userData, 'backups', 'corrupt-manifest')
    fs.mkdirSync(corrupt, { recursive: true })
    fs.writeFileSync(path.join(corrupt, 'manifest.json'), '{invalid', 'utf8')

    const result = await store.removeAllButNewest(10, (backup) => backup.provider === 'codex')

    expect(result).toEqual({ removed: 3, failed: 0, freedBytes: expect.any(Number) })
    expect(result.freedBytes).toBeGreaterThan(0)
    const left = store.list().map((backup) => backup.id)
    expect(left).toEqual(expect.arrayContaining([...codex.slice(3).map((backup) => backup.id), gemini.id, 'corrupt-manifest']))
    expect(left).toHaveLength(12)
    for (const removed of codex.slice(0, 3)) expect(fs.existsSync(path.join(userData, 'backups', removed.id))).toBe(false)
  })

  it('has nothing to remove when no more backups than the ones to keep are counted', async () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    store.create('codex')

    await expect(store.removeAllButNewest(10, () => true)).resolves.toEqual({ removed: 0, failed: 0, freedBytes: 0 })
    expect(store.list()).toHaveLength(1)
    expect(store.rootDirectory()).toBe(path.join(path.resolve(userData), 'backups'))
    await expect(store.removeAllButNewest(-1, () => true)).rejects.toThrow('要留下的备份份数无效')
  })

  it('removes stale temporary directories after a successful create', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original')
    const staleDirectory = path.join(userData, 'backups', '.stale.tmp')
    fs.mkdirSync(staleDirectory, { recursive: true })
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })

    const backup = store.create('codex')
    expect(fs.existsSync(staleDirectory)).toBe(false)
    expect(store.list()).toContainEqual(expect.objectContaining({ id: backup.id, valid: true }))
  })

  it('rejects a path traversal target before restoration', () => {
    const { root, home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')
    const manifestPath = path.join(userData, 'backups', backup.id, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: Array<{ targetRelativePath: string }> }
    manifest.files[0].targetRelativePath = '../outside.txt'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
    const outsidePath = path.join(root, 'outside.txt')
    writeConfig(outsidePath, 'untouched')

    expect(() => store.restore(backup.id)).toThrow(/relative|target|path|路径|目标/i)
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe('untouched')
  })

  it('rejects damaged file content and a corrupt manifest', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const damaged = store.create('codex')
    const preview = store.inspect(damaged.id)
    const backupRelativePath = preview.files.find((file) => file.existed)?.backupRelativePath
    expect(backupRelativePath).toBeTruthy()
    fs.writeFileSync(path.join(userData, 'backups', damaged.id, ...backupRelativePath!.split('/')), 'tampered', 'utf8')
    expect(() => store.restore(damaged.id)).toThrow(/损坏|篡改/)

    const corruptDirectory = path.join(userData, 'backups', 'corrupt-manifest')
    fs.mkdirSync(corruptDirectory, { recursive: true })
    fs.writeFileSync(path.join(corruptDirectory, 'manifest.json'), '{invalid', 'utf8')
    expect(store.list()).toContainEqual(expect.objectContaining({ id: 'corrupt-manifest', valid: false }))
  })

  // R2-2: a broken backup keeps a row the card can show, name and delete.
  it('keeps the tool, reason and time of a broken backup whose manifest still reads', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original')
    const store = new ConfigBackupStore({
      userDataDirectory: userData,
      homeDirectory: home,
      now: () => new Date(Date.UTC(2026, 10, 18, 6, 30, 0)),
    })
    const torn = store.create('codex', 'pre-save')
    const backupRelativePath = store.inspect(torn.id).files.find((file) => file.existed)?.backupRelativePath
    fs.rmSync(path.join(userData, 'backups', torn.id, ...backupRelativePath!.split('/')))

    expect(store.list()).toEqual([{
      id: torn.id,
      provider: 'codex',
      reason: 'pre-save',
      createdAt: '2026-11-18T06:30:00.000Z',
      fileCount: 0,
      existingFileCount: 0,
      totalSize: 0,
      valid: false,
      error: expect.any(String),
    }])
    expect(() => store.restore(torn.id)).toThrow()
    store.delete(torn.id)
    expect(store.list()).toEqual([])
  })

  it('names a broken backup of the retired tool so it stays out of the list', () => {
    const { home, userData } = fixture()
    const [settingsPath] = providerConfigPaths('gemini', fixtureProviderRoots(home))
    writeConfig(settingsPath, '{"model":{"name":"gemini-3.8-flash-high"}}\n')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const gemini = store.create('gemini', 'manual')
    const backupRelativePath = store.inspect(gemini.id).files.find((file) => file.existed)?.backupRelativePath
    fs.writeFileSync(path.join(userData, 'backups', gemini.id, ...backupRelativePath!.split('/')), 'longer than before', 'utf8')

    expect(store.list()).toEqual([expect.objectContaining({ id: gemini.id, provider: 'gemini', valid: false })])
  })

  it('dates a backup whose manifest cannot be read by the time in its folder name', () => {
    const { home, userData } = fixture()
    const id = `20261118063000123-${randomUUID()}`
    fs.mkdirSync(path.join(userData, 'backups', id), { recursive: true })
    fs.writeFileSync(path.join(userData, 'backups', id, 'manifest.json'), '{invalid', 'utf8')
    fs.mkdirSync(path.join(userData, 'backups', 'corrupt-manifest'), { recursive: true })
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })

    expect(store.list()).toEqual([
      expect.objectContaining({ id, provider: null, reason: null, createdAt: '2026-11-18T06:30:00.123Z', valid: false }),
      expect.objectContaining({ id: 'corrupt-manifest', provider: null, createdAt: null, valid: false }),
    ])
  })

  it('reads the time out of a backup id only when it is one backupId() could have made', () => {
    const uuid = randomUUID()
    expect(resolveBackupIdTime(`20261118063000123-${uuid}`)).toBe('2026-11-18T06:30:00.123Z')
    expect(resolveBackupIdTime(`20261318063000123-${uuid}`)).toBeNull()
    expect(resolveBackupIdTime(`20261131063000123-${uuid}`)).toBeNull()
    expect(resolveBackupIdTime('20261118063000123-not-a-uuid')).toBeNull()
    expect(resolveBackupIdTime('corrupt-manifest')).toBeNull()
  })

  it('rejects oversized source files and manifests before copying or hashing them', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'x'.repeat(2 * 1024 * 1024 + 1))
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })

    expect(() => store.create('codex')).toThrow('备份安全上限')
    expect(store.list()).toEqual([])

    writeConfig(configPath, 'small')
    const backup = store.create('codex')
    const manifestPath = path.join(userData, 'backups', backup.id, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: Array<{ existed: boolean; size: number }> }
    const existing = manifest.files.find((file) => file.existed)
    expect(existing).toBeTruthy()
    existing!.size = 2 * 1024 * 1024 + 1
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

    expect(store.list()).toContainEqual(expect.objectContaining({
      id: backup.id,
      valid: false,
      error: expect.stringContaining('2048 KB'),
    }))
  })

  it('rejects a backup root redirected through a directory junction', () => {
    const { home, userData } = fixture()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-backups-outside-'))
    temporaryDirectories.push(outside)
    fs.mkdirSync(userData, { recursive: true })
    fs.symlinkSync(outside, path.join(userData, 'backups'), process.platform === 'win32' ? 'junction' : 'dir')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })

    expect(() => store.create('codex')).toThrow(/符号链接|目录联接/)
    expect(() => store.list()).toThrow(/符号链接|目录联接/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('waits out a scanner briefly holding the new backup folder', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    writeConfig(authPath, '{"OPENAI_API_KEY":"sk-held-folder"}\n')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const originalRename = fs.renameSync.bind(fs)
    let held = 2
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (held > 0 && path.basename(String(from)).endsWith('.tmp')) {
        held -= 1
        throw heldError('EPERM')
      }
      originalRename(from, to)
    })

    const backup = store.create('codex')

    expect(held).toBe(0)
    expect(fs.readdirSync(path.join(userData, 'backups'))).toEqual([backup.id])
    expect(store.inspect(backup.id).valid).toBe(true)
  })

  it('keeps the original error and leaves no backup behind when the new folder stays held', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const originalRename = fs.renameSync.bind(fs)
    let attempts = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(from)).endsWith('.tmp')) {
        attempts += 1
        throw heldError('EPERM')
      }
      originalRename(from, to)
    })

    expect(() => store.create('codex')).toThrow('EPERM: operation not permitted, rename')
    expect(attempts).toBe(5)
    expect(fs.readdirSync(path.join(userData, 'backups'))).toEqual([])
    expect(fs.readFileSync(configPath, 'utf8')).toBe('model = "gpt-5.6-sol"\n')
  })

  it('checks the backup folder again before retrying a held backup', () => {
    const { root, home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'model = "gpt-5.6-sol"\n')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backupsRoot = path.join(userData, 'backups')
    const displaced = path.join(root, 'displaced-backups')
    const originalRename = fs.renameSync.bind(fs)
    let redirected = false
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!redirected && path.basename(String(from)).endsWith('.tmp')) {
        redirected = true
        // A scanner may still hold a file just written here; wait it out the same
        // way, or moving the folder could fail and hide what this test checks.
        renameWithTransientRetrySync(backupsRoot, displaced)
        fs.symlinkSync(displaced, backupsRoot, process.platform === 'win32' ? 'junction' : 'dir')
        throw heldError('EPERM')
      }
      originalRename(from, to)
    })

    expect(() => store.create('codex')).toThrow(/符号链接|目录联接/)
    expect(redirected).toBe(true)
    expect(fs.readdirSync(displaced).filter((name) => !name.endsWith('.tmp'))).toEqual([])
  })

  it('waits out a scanner briefly holding config files while restoring', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original-config')
    writeConfig(authPath, 'original-auth')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')
    writeConfig(configPath, 'current-config')
    writeConfig(authPath, 'current-auth')
    const originalRename = fs.renameSync.bind(fs)
    let movingAsideHeld = 2
    let restoringHeld = 2
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (movingAsideHeld > 0 && path.resolve(String(from)) === path.resolve(configPath)) {
        movingAsideHeld -= 1
        throw heldError('EPERM')
      }
      if (restoringHeld > 0 && path.resolve(String(to)) === path.resolve(authPath)) {
        restoringHeld -= 1
        throw heldError('EBUSY')
      }
      originalRename(from, to)
    })

    store.restore(backup.id)

    expect([movingAsideHeld, restoringHeld]).toEqual([0, 0])
    expect(fs.readFileSync(configPath, 'utf8')).toBe('original-config')
    expect(fs.readFileSync(authPath, 'utf8')).toBe('original-auth')
    expect(temporaryNames(path.dirname(configPath))).toEqual([])
  })

  it('keeps the original error and puts the current files back when a restored file stays held', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original-config')
    writeConfig(authPath, 'original-auth')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')
    writeConfig(configPath, 'current-config')
    writeConfig(authPath, 'current-auth')
    const originalRename = fs.renameSync.bind(fs)
    let attempts = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.xingmang-restore-') && path.resolve(String(to)) === path.resolve(authPath)) {
        attempts += 1
        throw heldError('EPERM')
      }
      originalRename(from, to)
    })

    expect(() => store.restore(backup.id)).toThrow('EPERM: operation not permitted, rename')
    expect(attempts).toBe(5)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('current-config')
    expect(fs.readFileSync(authPath, 'utf8')).toBe('current-auth')
    expect(temporaryNames(path.dirname(configPath))).toEqual([])
  })

  it('waits out a briefly held file while putting the current files back', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original-config')
    writeConfig(authPath, 'original-auth')
    const backup = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home }).create('codex')
    writeConfig(configPath, 'current-config')
    writeConfig(authPath, 'current-auth')
    const failingStore = new ConfigBackupStore({
      userDataDirectory: userData,
      homeDirectory: home,
      hooks: {
        beforeRestoreCommit: (_target, index) => {
          if (index === 1) throw new Error('injected restore failure')
        },
      },
    })
    const originalRename = fs.renameSync.bind(fs)
    // auth.json goes back inside its own plan, config.toml in the rollback of committed plans.
    const held = new Set([path.resolve(configPath), path.resolve(authPath)])
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.xingmang-rollback-') && held.delete(path.resolve(String(to)))) {
        throw heldError('EBUSY')
      }
      originalRename(from, to)
    })

    expect(() => failingStore.restore(backup.id)).toThrow('injected restore failure')
    expect(held.size).toBe(0)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('current-config')
    expect(fs.readFileSync(authPath, 'utf8')).toBe('current-auth')
    expect(temporaryNames(path.dirname(configPath))).toEqual([])
  })

  it('checks the current config again before retrying a held restore', () => {
    const { home, userData } = fixture()
    const [configPath] = providerConfigPaths('codex', fixtureProviderRoots(home))
    writeConfig(configPath, 'original-config')
    const store = new ConfigBackupStore({ userDataDirectory: userData, homeDirectory: home })
    const backup = store.create('codex')
    writeConfig(configPath, 'current-config')
    const originalRename = fs.renameSync.bind(fs)
    let held = false
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!held && path.resolve(String(from)) === path.resolve(configPath)) {
        held = true
        // Whoever held the file saves its own change while the restore waits.
        fs.writeFileSync(configPath, 'saved-while-held', 'utf8')
        throw heldError('EPERM')
      }
      originalRename(from, to)
    })

    expect(() => store.restore(backup.id)).toThrow('当前配置文件在恢复期间发生变化')
    expect(held).toBe(true)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('saved-while-held')
    expect(temporaryNames(path.dirname(configPath))).toEqual([])
  })
})

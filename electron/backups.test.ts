import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigBackupStore } from './backups'
import type { ProviderId } from './catalog'
import { providerConfigPaths } from './config-files'

const temporaryDirectories: string[] = []

afterEach(() => {
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

  it('rejects a broken symbolic link introduced during restore commit', () => {
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

    // 克隆出 200 份时间戳更早的备份，让被恢复的那份恰好落在 prune 的删除窗口内。
    const cloneIds: string[] = []
    for (let index = 0; index < 200; index += 1) {
      const cloneId = `199901010000${String(index).padStart(5, '0')}-${randomUUID()}`
      const cloneDirectory = path.join(userData, 'backups', cloneId)
      fs.cpSync(templateDirectory, cloneDirectory, { recursive: true })
      fs.writeFileSync(
        path.join(cloneDirectory, 'manifest.json'),
        JSON.stringify({ ...templateManifest, id: cloneId }),
        'utf8',
      )
      cloneIds.push(cloneId)
    }

    writeConfig(configPath, 'current-config')
    const restored = store.restore(cloneIds[0])
    expect(restored.restoredBackupId).toBe(cloneIds[0])
    expect(fs.readFileSync(configPath, 'utf8')).toBe('oldest-config')
    expect(fs.existsSync(path.join(userData, 'backups', cloneIds[0]))).toBe(true)
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
})

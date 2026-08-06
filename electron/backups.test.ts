import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigBackupStore } from './backups'
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

describe('ConfigBackupStore', () => {
  it('creates a manifest backup and restores a complete provider round trip', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', home)
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
    const [configPath, authPath] = providerConfigPaths('codex', home)
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
    const [configPath, authPath] = providerConfigPaths('codex', home)
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
    const [configPath, authPath] = providerConfigPaths('codex', home)
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
    const [configPath, authPath] = providerConfigPaths('codex', home)
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

  it('keeps the current configuration when moving it aside fails during restore', () => {
    const { home, userData } = fixture()
    const [configPath, authPath] = providerConfigPaths('codex', home)
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
    const [configPath] = providerConfigPaths('codex', home)
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
    const [configPath] = providerConfigPaths('codex', home)
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
    const [configPath] = providerConfigPaths('codex', home)
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
    const [configPath] = providerConfigPaths('codex', home)
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
    const [configPath] = providerConfigPaths('codex', home)
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
    const [configPath] = providerConfigPaths('codex', home)
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
    const [configPath] = providerConfigPaths('codex', home)
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

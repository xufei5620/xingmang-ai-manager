import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as configFiles from './config-files'
import {
  attachNotUtf8ConfigRewriteLog,
  executeFilePlans,
  explainConfigWriteFailure,
  fillableRecord,
  providerConfigPaths,
  readText,
  requireConfigText,
  requireRawConfigText,
  resolveConfigWriteBlocker,
  trustedFolderKey,
  type ConfigWriteBlockerProbe,
} from './config-files-context'
import { configWriteBlockerIn, configWriteBlockerMessage } from './config-write-blocker'
import { typeImportCount, valueReferences } from './type-only-imports.test-support'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-context-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  vi.restoreAllMocks()
  attachNotUtf8ConfigRewriteLog(null)
  for (const directory of temporaryDirectories.splice(0)) {
    // 只读那条用例留下的只读文件（连同它的备份）：先放开再删。
    for (const entry of fs.readdirSync(directory)) {
      const file = path.join(directory, entry)
      if (fs.lstatSync(file).isFile()) fs.chmodSync(file, 0o666)
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function errnoError(code: string, message = `${code}: permission denied, open 'settings.json'`): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

interface ProbedEntry { uid?: number; mode?: number; file?: boolean }

// 路径一律经 path.resolve 拼：Windows 上跑这些用例时，被测函数看到的也是这样拼出来的路径。
function fakeProbe(platform: NodeJS.Platform, uid: number | undefined, entries: Record<string, ProbedEntry>): ConfigWriteBlockerProbe {
  return {
    platform,
    uid,
    lstat(filePath) {
      const entry = entries[filePath]
      if (!entry) throw errnoError('ENOENT')
      return { uid: entry.uid ?? 501, mode: entry.mode ?? 0o644, isFile: () => entry.file ?? false }
    },
  }
}

const toolRoot = path.resolve('/home/me/.codex')
const toolConfig = path.join(toolRoot, 'config.toml')
const toolAuth = path.join(toolRoot, 'auth.json')

describe('config-files-context', () => {
  it('is what config-files.ts still exports under the old names', () => {
    expect(configFiles.executeFilePlans).toBe(executeFilePlans)
    expect(configFiles.providerConfigPaths).toBe(providerConfigPaths)
  })

  it('only takes types from config-files.ts so the two never require each other', () => {
    const file = path.join(__dirname, 'config-files-context.ts')
    const configFilesModule = path.join(__dirname, 'config-files.ts')
    expect(typeImportCount(file, configFilesModule)).toBeGreaterThan(0)
    expect(valueReferences(file, configFilesModule)).toEqual([])
  })

  it('reads text without the byte order mark unless asked to keep it', () => {
    const file = path.join(temporaryDirectory(), 'settings.json')
    fs.writeFileSync(file, '\uFEFF{"a":1}')
    expect(readText(file)).toBe('{"a":1}')
    expect(requireConfigText(file, '配置')).toBe('{"a":1}')
    expect(requireRawConfigText(file, '配置')).toBe('\uFEFF{"a":1}')
  })

  it('treats a hard-linked file as unreadable and refuses it on the write path', () => {
    const directory = temporaryDirectory()
    const original = path.join(directory, 'original.json')
    const linked = path.join(directory, 'settings.json')
    fs.writeFileSync(original, '{}')
    fs.linkSync(original, linked)
    expect(readText(linked)).toBeNull()
    expect(() => requireConfigText(linked, '现有配置')).toThrow()
    expect(requireConfigText(path.join(directory, 'missing.json'), '现有配置')).toBeNull()
  })

  it('names a settings folder a sudo run left to root on Mac and Linux, wherever on the way to the file it sits (D15)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolveConfigWriteBlocker([toolConfig], toolRoot, 'write', fakeProbe(platform, 501, { [toolRoot]: { uid: 0 } }))).toBe('adminOwned')
      expect(resolveConfigWriteBlocker([toolAuth], toolRoot, 'read', fakeProbe(platform, 501, { [toolRoot]: {}, [toolAuth]: { uid: 0, file: true } }))).toBe('adminOwned')
      const nested = path.join(toolRoot, 'profiles', 'work.toml')
      expect(resolveConfigWriteBlocker([nested], toolRoot, 'write', fakeProbe(platform, 501, { [toolRoot]: {}, [path.dirname(nested)]: { uid: 0 } }))).toBe('adminOwned')
    }
  })

  it('does not blame root when everything is the user own, Xingmang itself is root, or only folders above the tool are root (D15)', () => {
    expect(resolveConfigWriteBlocker([toolConfig, toolAuth], toolRoot, 'write', fakeProbe('darwin', 501, { [toolRoot]: {}, [toolConfig]: { file: true } }))).toBeNull()
    // 星芒自己就是管理员时归谁都写得进去：没权限另有原因，不说成归管理员。
    expect(resolveConfigWriteBlocker([toolConfig], toolRoot, 'write', fakeProbe('linux', 0, { [toolRoot]: { uid: 0 } }))).toBeNull()
    expect(resolveConfigWriteBlocker([toolConfig], toolRoot, 'write', fakeProbe('linux', undefined, { [toolRoot]: { uid: 0 } }))).toBeNull()
    expect(resolveConfigWriteBlocker([toolConfig], toolRoot, 'write', fakeProbe('darwin', 501, { [path.dirname(toolRoot)]: { uid: 0 }, [toolRoot]: {} }))).toBeNull()
    // 落在工具配置文件夹外面的路径不去看。
    const outside = path.resolve('/etc/hosts')
    expect(resolveConfigWriteBlocker([outside], toolRoot, 'write', fakeProbe('darwin', 501, { [toolRoot]: {}, [outside]: { uid: 0, file: true } }))).toBeNull()
  })

  it('names a read-only config file on Windows only when writing over it (D15)', () => {
    const readOnly = { [toolRoot]: { mode: 0o444 }, [toolConfig]: { mode: 0o444, file: true } }
    expect(resolveConfigWriteBlocker([toolAuth, toolConfig], toolRoot, 'write', fakeProbe('win32', undefined, readOnly))).toBe('readOnly')
    // 只读不挡读；文件夹的只读属性 Windows 不当回事；可写的文件、Mac 上的 0444 都不算。
    expect(resolveConfigWriteBlocker([toolConfig], toolRoot, 'read', fakeProbe('win32', undefined, readOnly))).toBeNull()
    expect(resolveConfigWriteBlocker([path.join(toolRoot, 'missing.toml')], toolRoot, 'write', fakeProbe('win32', undefined, readOnly))).toBeNull()
    expect(resolveConfigWriteBlocker([toolConfig], toolRoot, 'write', fakeProbe('win32', undefined, { [toolConfig]: { mode: 0o666, file: true } }))).toBeNull()
    expect(resolveConfigWriteBlocker([toolConfig], toolRoot, 'write', fakeProbe('darwin', 501, { [toolRoot]: {}, [toolConfig]: { mode: 0o444, file: true } }))).toBeNull()
  })

  it('swaps only a permission failure it can explain for the reason, keeping the code and the original as cause (D15)', () => {
    const adminProbe = fakeProbe('darwin', 501, { [toolRoot]: { uid: 0 } })
    const original = errnoError('EACCES')
    const explained = explainConfigWriteFailure(original, [toolConfig], toolRoot, 'write', adminProbe)
    expect(explained).toBeInstanceOf(Error)
    expect((explained as Error).message).toBe('这个工具的设置文件夹归电脑管理员所有（错误码 EACCES）')
    expect((explained as NodeJS.ErrnoException).code).toBe('EACCES')
    expect((explained as Error).cause).toBe(original)
    const readOnly = explainConfigWriteFailure(errnoError('EPERM'), [toolConfig], toolRoot, 'write', fakeProbe('win32', undefined, { [toolConfig]: { mode: 0o444, file: true } }))
    expect((readOnly as Error).message).toBe('这个文件被设成了只读（错误码 EPERM）')
    expect(configWriteBlockerIn((readOnly as Error).message)).toBe('readOnly')
    // 别的错、查不出是哪一种的没权限，都原样交回。
    for (const other of [errnoError('EBUSY'), errnoError('ENOSPC'), new Error('配置写入计划包含重复路径')]) {
      expect(explainConfigWriteFailure(other, [toolConfig], toolRoot, 'write', adminProbe)).toBe(other)
    }
    const unexplained = errnoError('EPERM')
    expect(explainConfigWriteFailure(unexplained, [toolConfig], toolRoot, 'write', fakeProbe('darwin', 501, { [toolRoot]: {} }))).toBe(unexplained)
  })

  it.runIf(process.platform !== 'win32')('tells a save that a root-owned settings folder refused it, and leaves the old file alone (D15)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const settings = path.join(root, 'settings.json')
    fs.writeFileSync(settings, '{"old":true}\n')
    // 测试机上建不出真归 root 的文件夹：星芒换成普通用户，这个文件夹报成 root 的，新建临时文件那一步照 sudo 留下的样子被拒。
    vi.spyOn(process, 'getuid').mockReturnValue(501)
    const lstatSync = fs.lstatSync
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const info = lstatSync(target, options)
      return info && path.resolve(String(target)) === path.resolve(root) ? Object.assign(info, { uid: 0 }) : info
    }) as typeof fs.lstatSync)
    const openSync = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
      if (flags === 'wx' && String(target).includes('.xingmang-')) throw errnoError('EACCES', `EACCES: permission denied, open '${String(target)}'`)
      return openSync(target, flags, mode)
    }) as typeof fs.openSync)
    let thrown: unknown
    try {
      executeFilePlans([{ path: settings, content: '{"new":true}\n' }], {}, root)
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toBe(configWriteBlockerMessage('adminOwned', 'EACCES'))
    expect(((thrown as Error).cause as Error).message).toContain('EACCES: permission denied')
    vi.restoreAllMocks()
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"old":true}\n')
    expect(fs.readdirSync(root)).toEqual(['settings.json'])
  })

  it.runIf(process.platform !== 'win32')('tells a save that it could not even read a root-owned config what it is (D15)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const auth = path.join(root, 'auth.json')
    fs.writeFileSync(auth, '{}')
    vi.spyOn(process, 'getuid').mockReturnValue(501)
    const lstatSync = fs.lstatSync
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const info = lstatSync(target, options)
      return info && path.resolve(String(target)) === path.resolve(auth) ? Object.assign(info, { uid: 0 }) : info
    }) as typeof fs.lstatSync)
    const openSync = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
      if (path.resolve(String(target)) === path.resolve(auth)) throw errnoError('EACCES', `EACCES: permission denied, open '${String(target)}'`)
      return openSync(target, flags, mode)
    }) as typeof fs.openSync)
    expect(() => requireConfigText(auth, '现有 Codex auth.json')).toThrow(configWriteBlockerMessage('adminOwned', 'EACCES'))
  })

  it.runIf(process.platform === 'win32')('tells a save that the config file was set read-only instead of retrying it as a locked file (D15)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const config = path.join(root, 'config.toml')
    fs.writeFileSync(config, 'model = "old"\n')
    // 右键属性里勾上「只读」：Node 在 Windows 上把它设成 FILE_ATTRIBUTE_READONLY。
    fs.chmodSync(config, 0o444)
    expect(() => executeFilePlans([{ path: config, content: 'model = "new"\n' }], {}, root)).toThrow(/^这个文件被设成了只读（错误码 E(PERM|ACCES)）$/)
    expect(fs.readFileSync(config, 'utf8')).toBe('model = "old"\n')
  })

  // {"dir":"中文"} saved by an old Notepad on Chinese Windows: GBK, not UTF-8.
  const gbkSettings = Buffer.concat([Buffer.from('{"dir":"'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('"}\n')])

  it('logs a config that was not UTF-8 once it has been written back, and writes the same content as before (D78)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const settings = path.join(root, 'settings.json')
    fs.writeFileSync(settings, gbkSettings)
    const log = vi.fn()
    attachNotUtf8ConfigRewriteLog(log)

    const saved = executeFilePlans([{ path: settings, content: '{"dir":"\uFFFD\uFFFD"}\n' }], {}, root)

    expect(fs.readFileSync(settings, 'utf8')).toBe('{"dir":"\uFFFD\uFFFD"}\n')
    expect(saved.backups).toHaveLength(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({ file: settings, backup: saved.backups[0] })
    // 客服照着日志去找的那份备份，就是写回前的原样字节。
    expect(fs.readFileSync(saved.backups[0])).toEqual(gbkSettings)
  })

  it('does not log UTF-8 configs, new files or files it removes (D78)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const chinese = path.join(root, 'settings.json')
    const marked = path.join(root, 'config.toml')
    const removed = path.join(root, 'auth.json')
    fs.writeFileSync(chinese, '{"dir":"中文"}\n', 'utf8')
    fs.writeFileSync(marked, '\uFEFFmodel = "a"\n', 'utf8')
    fs.writeFileSync(removed, gbkSettings)
    const log = vi.fn()
    attachNotUtf8ConfigRewriteLog(log)

    executeFilePlans([
      { path: chinese, content: '{"dir":"中文","new":true}\n' },
      { path: marked, content: 'model = "b"\n' },
      { path: path.join(root, 'added.json'), content: '{}\n' },
      { path: removed, remove: true },
    ], {}, root)

    expect(log).not.toHaveBeenCalled()
    expect(fs.existsSync(removed)).toBe(false)
  })

  it('keeps the backup of a config that was not UTF-8 even when the write discards backups (D78)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const settings = path.join(root, 'settings.json')
    const config = path.join(root, 'config.toml')
    fs.writeFileSync(settings, gbkSettings)
    fs.writeFileSync(config, 'model = "中文"\n', 'utf8')
    const log = vi.fn()
    attachNotUtf8ConfigRewriteLog(log)

    const saved = executeFilePlans([
      { path: settings, content: '{"dir":"\uFFFD\uFFFD"}\n' },
      { path: config, content: 'model = "b"\n' },
    ], {}, root, 'discard')

    // 原样只剩这一份，留着；UTF-8 那份照旧写成就删。
    expect(saved.backups).toHaveLength(1)
    expect(path.dirname(saved.backups[0])).toBe(root)
    expect(path.basename(saved.backups[0]).startsWith('settings.json.bak.')).toBe(true)
    expect(fs.readFileSync(saved.backups[0])).toEqual(gbkSettings)
    expect(fs.readdirSync(root).sort()).toEqual(['config.toml', path.basename(saved.backups[0]), 'settings.json'].sort())
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({ file: settings, backup: saved.backups[0] })

    // 写回的那份已经是 UTF-8：下回同样的写法照旧删，不再多留。
    log.mockClear()
    const again = executeFilePlans([{ path: settings, content: '{}\n' }], {}, root, 'discard')
    expect(again.backups).toEqual([])
    expect(fs.readdirSync(root).sort()).toEqual(['config.toml', path.basename(saved.backups[0]), 'settings.json'].sort())
    expect(log).not.toHaveBeenCalled()
  })

  it('rotates a kept not-UTF-8 backup with the backups already there instead of piling them up (D78)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const settings = path.join(root, 'settings.json')
    const older = ['20200101000000001', '20200101000000002', '20200101000000003', '20200101000000004', '20200101000000005']
      .map((suffix) => path.join(root, `settings.json.bak.${suffix}`))
    for (const backup of older) fs.writeFileSync(backup, '{}\n')
    fs.writeFileSync(settings, gbkSettings)

    const saved = executeFilePlans([{ path: settings, content: '{"dir":"\uFFFD\uFFFD"}\n' }], {}, root, 'discard')

    const backups = fs.readdirSync(root).filter((name) => name.startsWith('settings.json.bak.')).sort()
    expect(backups).toEqual([...older.slice(1).map((backup) => path.basename(backup)), path.basename(saved.backups[0])])
    expect(fs.readFileSync(saved.backups[0])).toEqual(gbkSettings)
  })

  it('logs nothing when the write back did not happen, and a failing log never fails a save (D78)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const settings = path.join(root, 'settings.json')
    fs.writeFileSync(settings, gbkSettings)
    const log = vi.fn()
    attachNotUtf8ConfigRewriteLog(log)

    expect(() => executeFilePlans([{ path: settings, content: '{}\n' }], {
      beforeReplace: () => { throw new Error('配置在保存时被别的程序改了') },
    }, root)).toThrow('配置在保存时被别的程序改了')
    expect(fs.readFileSync(settings)).toEqual(gbkSettings)
    expect(log).not.toHaveBeenCalled()

    attachNotUtf8ConfigRewriteLog(() => { throw new Error('日志写不进去') })
    expect(() => executeFilePlans([{ path: settings, content: '{}\n' }], {}, root)).not.toThrow()
    expect(fs.readFileSync(settings, 'utf8')).toBe('{}\n')
  })

  // O11：保存进行到一半，别的程序（Codex、Claude Code 自己，客户开着的编辑器）也存了同一份配置。
  const configChanged = '配置文件刚被别的程序改过，为了不盖掉它的改动，这次没有保存，再试一次就好'
  const rollbackIncomplete = '配置写入失败，且部分文件无法自动回滚；请从 .bak 备份恢复'

  function thrownBy(run: () => unknown): Error {
    try {
      run()
    } catch (error) {
      return error as Error
    }
    throw new Error('expected the save to fail')
  }

  it('does not overwrite a config another program saved while this save was under way (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const config = path.join(root, 'config.toml')
    fs.writeFileSync(config, 'model = "old"\n')

    expect(() => executeFilePlans([{ path: config, content: 'model = "manager"\n' }], {
      beforeReplace: () => fs.writeFileSync(config, 'model = "external"\n'),
    }, root)).toThrow(configChanged)

    expect(fs.readFileSync(config, 'utf8')).toBe('model = "external"\n')
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('notices a same-size rewrite that the file times alone could miss (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const config = path.join(root, 'config.toml')
    fs.writeFileSync(config, 'model = "aaa"\n')
    const before = fs.statSync(config)

    expect(() => executeFilePlans([{ path: config, content: 'model = "new"\n' }], {
      beforeReplace: () => {
        fs.writeFileSync(config, 'model = "bbb"\n')
        // 同一个时钟刻里改的：大小、修改时间都跟动手前一样，只有内容不同。
        fs.utimesSync(config, before.atime, before.mtime)
      },
    }, root)).toThrow(configChanged)

    expect(fs.readFileSync(config, 'utf8')).toBe('model = "bbb"\n')
  })

  it('still saves when another program only rewrote the very same bytes (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const config = path.join(root, 'config.toml')
    fs.writeFileSync(config, 'model = "old"\n')

    executeFilePlans([{ path: config, content: 'model = "new"\n' }], {
      // 别的程序原样重存了一遍（换了个文件、改了修改时间），没有要留的改动。
      beforeReplace: () => {
        const elsewhere = path.join(root, 'rewritten.tmp')
        fs.writeFileSync(elsewhere, 'model = "old"\n')
        fs.renameSync(elsewhere, config)
      },
    }, root)

    expect(fs.readFileSync(config, 'utf8')).toBe('model = "new"\n')
  })

  it('does not replace a file another program created where this save was adding one (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const auth = path.join(root, 'auth.json')

    expect(() => executeFilePlans([{ path: auth, content: '{"manager":true}\n' }], {
      beforeReplace: () => fs.writeFileSync(auth, '{"external":true}\n'),
    }, root)).toThrow(configChanged)

    expect(fs.readFileSync(auth, 'utf8')).toBe('{"external":true}\n')
  })

  it('does not take away a file another program saved just before it was to be removed (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const auth = path.join(root, 'auth.json')
    fs.writeFileSync(auth, '{}\n')

    expect(() => executeFilePlans([{ path: auth, remove: true }], {
      beforeReplace: () => fs.writeFileSync(auth, '{"tokens":{"id_token":"signed-in"}}\n'),
    }, root)).toThrow(configChanged)

    expect(fs.readFileSync(auth, 'utf8')).toBe('{"tokens":{"id_token":"signed-in"}}\n')
  })

  it('checks again after waiting out a held file, since the holder may just have saved (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const config = path.join(root, 'config.toml')
    fs.writeFileSync(config, 'model = "old"\n')
    const renameSync = fs.renameSync.bind(fs)
    let held = true
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (held && path.resolve(String(to)) === path.resolve(config)) {
        held = false
        // 拿着文件的那个程序存完才放手。
        fs.writeFileSync(config, 'model = "external"\n')
        throw errnoError('EBUSY', 'EBUSY: resource busy or locked, rename')
      }
      renameSync(from, to)
    })

    expect(() => executeFilePlans([{ path: config, content: 'model = "manager"\n' }], {}, root)).toThrow(configChanged)

    expect(held).toBe(false)
    expect(fs.readFileSync(config, 'utf8')).toBe('model = "external"\n')
  })

  it('still waits out a file another program holds so tightly it cannot even be read (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const config = path.join(root, 'config.toml')
    fs.writeFileSync(config, 'model = "old"\n')
    const openSync = fs.openSync
    const renameSync = fs.renameSync.bind(fs)
    let held = 0
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
      if (held > 0 && path.resolve(String(target)) === path.resolve(config)) throw errnoError('EBUSY', 'EBUSY: resource busy or locked, open')
      return openSync(target, flags, mode)
    }) as typeof fs.openSync)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (held > 0 && path.resolve(String(to)) === path.resolve(config)) {
        held -= 1
        throw errnoError('EBUSY', 'EBUSY: resource busy or locked, rename')
      }
      renameSync(from, to)
    })

    let renameAttempts = 0
    executeFilePlans([{ path: config, content: 'model = "new"\n' }], {
      // 动手前那一遍读得到；换上去的时候它被占着，头两次换都没成。
      beforeReplace: () => {
        renameAttempts += 1
        if (renameAttempts === 1) held = 2
      },
    }, root)

    expect(renameAttempts).toBe(3)
    expect(held).toBe(0)
    expect(fs.readFileSync(config, 'utf8')).toBe('model = "new"\n')
  })

  it('keeps what another program saved over an already replaced file instead of rolling it back (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const config = path.join(root, 'config.toml')
    const auth = path.join(root, 'auth.json')
    fs.writeFileSync(config, 'model = "old"\n')
    fs.writeFileSync(auth, '{"key":"old"}\n')

    const error = thrownBy(() => executeFilePlans([
      { path: config, content: 'model = "manager"\n' },
      { path: auth, content: '{"key":"manager"}\n' },
    ], {
      beforeReplace: (_targetPath, index) => {
        if (index !== 1) return
        fs.writeFileSync(config, 'model = "external"\n')
        throw new Error('injected second-file failure')
      },
    }, root))

    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toBe(rollbackIncomplete)
    expect((error as AggregateError).errors.map((inner: Error) => inner.message)).toEqual([
      'injected second-file failure',
      `配置文件换上去以后又被别的程序改过，保留了它的改动，没有回滚：${config}`,
    ])
    expect(fs.readFileSync(config, 'utf8')).toBe('model = "external"\n')
    expect(fs.readFileSync(auth, 'utf8')).toBe('{"key":"old"}\n')
    // 原来那份照旧在 .bak 里，客户要退回去还找得到。
    const backups = fs.readdirSync(root).filter((name) => name.startsWith('config.toml.bak.'))
    expect(backups.map((name) => fs.readFileSync(path.join(root, name), 'utf8'))).toEqual(['model = "old"\n'])
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('does not delete a file another program saved over one this save had just added (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const added = path.join(root, 'added.json')
    const auth = path.join(root, 'auth.json')
    fs.writeFileSync(auth, '{"key":"old"}\n')

    const error = thrownBy(() => executeFilePlans([
      { path: added, content: '{"manager":true}\n' },
      { path: auth, content: '{"key":"manager"}\n' },
    ], {
      beforeReplace: (_targetPath, index) => {
        if (index !== 1) return
        fs.writeFileSync(added, '{"external":true}\n')
        throw new Error('injected second-file failure')
      },
    }, root))

    expect(error.message).toBe(rollbackIncomplete)
    expect(fs.readFileSync(added, 'utf8')).toBe('{"external":true}\n')
    expect(fs.readFileSync(auth, 'utf8')).toBe('{"key":"old"}\n')
  })

  it('does not put back a removed file over one another program created in its place (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const auth = path.join(root, 'auth.json')
    const config = path.join(root, 'config.toml')
    fs.writeFileSync(auth, '{}\n')
    fs.writeFileSync(config, 'model = "old"\n')

    const error = thrownBy(() => executeFilePlans([
      { path: auth, remove: true },
      { path: config, content: 'model = "manager"\n' },
    ], {
      beforeReplace: (_targetPath, index) => {
        if (index !== 1) return
        fs.writeFileSync(auth, '{"tokens":{"id_token":"signed-in"}}\n')
        throw new Error('injected second-file failure')
      },
    }, root))

    expect(error.message).toBe(rollbackIncomplete)
    expect(fs.readFileSync(auth, 'utf8')).toBe('{"tokens":{"id_token":"signed-in"}}\n')
    expect(fs.readFileSync(config, 'utf8')).toBe('model = "old"\n')
  })

  it('stops waiting to roll back once another program saves over the replaced file (O11)', () => {
    const root = fs.realpathSync.native(temporaryDirectory())
    const config = path.join(root, 'config.toml')
    const auth = path.join(root, 'auth.json')
    fs.writeFileSync(config, 'model = "old"\n')
    fs.writeFileSync(auth, '{"key":"old"}\n')
    const renameSync = fs.renameSync.bind(fs)
    let held = true
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (held && path.basename(String(from)).includes('.xingmang-rollback-')) {
        held = false
        fs.writeFileSync(config, 'model = "external"\n')
        throw errnoError('EBUSY', 'EBUSY: resource busy or locked, rename')
      }
      renameSync(from, to)
    })

    expect(() => executeFilePlans([
      { path: config, content: 'model = "manager"\n' },
      { path: auth, content: '{"key":"manager"}\n' },
    ], {
      beforeReplace: (_targetPath, index) => {
        if (index === 1) throw new Error('injected second-file failure')
      },
    }, root)).toThrow(rollbackIncomplete)

    expect(held).toBe(false)
    expect(fs.readFileSync(config, 'utf8')).toBe('model = "external"\n')
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('compares a verbatim Windows path the same as the plain one', () => {
    expect(trustedFolderKey('\\\\?\\C:\\Users\\Me')).toBe(trustedFolderKey('C:\\Users\\Me'))
    expect(trustedFolderKey('\\\\?\\UNC\\server\\share')).toBe(trustedFolderKey('\\\\server\\share'))
  })

  it('creates a missing table but leaves a value that is not a table alone', () => {
    const parsed: Record<string, unknown> = { kept: 'text' }
    expect(fillableRecord(parsed, 'added')).toEqual({})
    expect(parsed.added).toEqual({})
    expect(fillableRecord(parsed, 'kept')).toBeNull()
    expect(parsed.kept).toBe('text')
  })
})

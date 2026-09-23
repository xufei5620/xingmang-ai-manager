import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isDirectoryOnPath,
  npmPrefixBinDirectory,
  npmPrefixGlobalRoot,
  parseNpmrcTopLevelString,
  resolveNpmHomeDirectory,
  resolveNpmPathConfigValue,
  resolveSameUserNpmPrefix,
  resolveUserNpmrcPath,
} from './npm-user-prefix'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('parseNpmrcTopLevelString', () => {
  it('reads a plain top-level prefix', () => {
    expect(parseNpmrcTopLevelString('prefix=D:\\npm-global\n', 'prefix')).toBe('D:\\npm-global')
  })

  it('tolerates spaces, CRLF, a UTF-8 BOM and comment lines like npm does', () => {
    const text = '\uFEFF; managed by me\r\n# another comment\r\nregistry=https://registry.npmmirror.com/\r\n  prefix  =  D:\\tools\\npm  \r\n'
    expect(parseNpmrcTopLevelString(text, 'prefix')).toBe('D:\\tools\\npm')
  })

  it('lets a later line win', () => {
    expect(parseNpmrcTopLevelString('prefix=/one\nprefix=/two\n', 'prefix')).toBe('/two')
  })

  it('ignores keys inside a section and array keys', () => {
    expect(parseNpmrcTopLevelString('[work]\nprefix=/nested\n', 'prefix')).toBeNull()
    expect(parseNpmrcTopLevelString('prefix[]=/array\n', 'prefix')).toBeNull()
    expect(parseNpmrcTopLevelString('prefix=/top\n[work]\nprefix=/nested\n', 'prefix')).toBe('/top')
  })

  it('does not treat a longer key or a prefix-less file as a match', () => {
    expect(parseNpmrcTopLevelString('prefixes=/nope\nmy-prefix=/nope\n', 'prefix')).toBeNull()
    expect(parseNpmrcTopLevelString('', 'prefix')).toBeNull()
  })

  it('strips inline comments and applies ini escapes', () => {
    expect(parseNpmrcTopLevelString('prefix=/opt/npm ; old location\n', 'prefix')).toBe('/opt/npm')
    expect(parseNpmrcTopLevelString('prefix=/opt/npm # old location\n', 'prefix')).toBe('/opt/npm')
    expect(parseNpmrcTopLevelString('prefix=/opt/a\\;b\n', 'prefix')).toBe('/opt/a;b')
    expect(parseNpmrcTopLevelString('prefix=D:\\\\npm-global\n', 'prefix')).toBe('D:\\npm-global')
  })

  it('unquotes single- and double-quoted values', () => {
    expect(parseNpmrcTopLevelString('prefix=\'D:\\npm global\'\n', 'prefix')).toBe('D:\\npm global')
    expect(parseNpmrcTopLevelString('prefix="D:\\\\npm global"\n', 'prefix')).toBe('D:\\npm global')
  })

  it('returns null for a bare key or a non-string value', () => {
    expect(parseNpmrcTopLevelString('prefix\n', 'prefix')).toBeNull()
    expect(parseNpmrcTopLevelString('prefix=\'42\'\n', 'prefix')).toBeNull()
  })
})

describe('resolveNpmPathConfigValue', () => {
  const windowsContext = {
    env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    home: 'C:\\Users\\tester',
    platform: 'win32' as const,
  }

  it('accepts drive-letter and UNC paths on Windows and normalizes them', () => {
    expect(resolveNpmPathConfigValue('D:/npm-global/', windowsContext)).toBe('D:\\npm-global')
    expect(resolveNpmPathConfigValue('\\\\server\\share\\npm', windowsContext)).toBe('\\\\server\\share\\npm')
  })

  it('expands environment variables case-insensitively on Windows and ~ against the npm home', () => {
    expect(resolveNpmPathConfigValue('${appdata}\\npm-custom', windowsContext))
      .toBe('C:\\Users\\tester\\AppData\\Roaming\\npm-custom')
    expect(resolveNpmPathConfigValue('~\\.npm-global', windowsContext)).toBe('C:\\Users\\tester\\.npm-global')
    expect(resolveNpmPathConfigValue('~/.npm-global', {
      env: {},
      home: '/home/tester',
      platform: 'linux',
    })).toBe('/home/tester/.npm-global')
  })

  it('rejects values whose meaning depends on where npm happens to start', () => {
    expect(resolveNpmPathConfigValue('npm-global', windowsContext)).toBeNull()
    expect(resolveNpmPathConfigValue('\\npm-global', windowsContext)).toBeNull()
    expect(resolveNpmPathConfigValue('D:npm-global', windowsContext)).toBeNull()
    expect(resolveNpmPathConfigValue('relative/dir', { env: {}, home: '/home/tester', platform: 'linux' })).toBeNull()
  })

  it('rejects device paths, unresolved variables, control characters and oversized values', () => {
    expect(resolveNpmPathConfigValue('\\\\?\\C:\\npm', windowsContext)).toBeNull()
    expect(resolveNpmPathConfigValue('\\\\.\\pipe\\npm', windowsContext)).toBeNull()
    expect(resolveNpmPathConfigValue('${MISSING}\\npm', windowsContext)).toBeNull()
    expect(resolveNpmPathConfigValue('D:\\npm\nglobal', windowsContext)).toBeNull()
    expect(resolveNpmPathConfigValue(`D:\\${'a'.repeat(1100)}`, windowsContext)).toBeNull()
    expect(resolveNpmPathConfigValue('   ', windowsContext)).toBeNull()
  })
})

describe('npm user config location', () => {
  it('uses HOME before the OS home directory, as npm does', () => {
    expect(resolveNpmHomeDirectory({ HOME: '/custom' }, 'linux', () => '/os-home')).toBe('/custom')
    expect(resolveNpmHomeDirectory({ home: 'D:\\gitbash-home' }, 'win32', () => 'C:\\Users\\tester')).toBe('D:\\gitbash-home')
    expect(resolveNpmHomeDirectory({}, 'win32', () => 'C:\\Users\\tester')).toBe('C:\\Users\\tester')
  })

  it('reads ~/.npmrc unless npm_config_userconfig points elsewhere', () => {
    expect(resolveUserNpmrcPath({ env: {}, home: 'C:\\Users\\tester', platform: 'win32' }))
      .toBe('C:\\Users\\tester\\.npmrc')
    expect(resolveUserNpmrcPath({
      env: { NPM_CONFIG_USERCONFIG: 'D:\\config\\npmrc' },
      home: 'C:\\Users\\tester',
      platform: 'win32',
    })).toBe('D:\\config\\npmrc')
    expect(resolveUserNpmrcPath({
      env: { npm_config_userconfig: 'relative-npmrc' },
      home: '/home/tester',
      platform: 'linux',
    })).toBeNull()
  })
})

describe('npm prefix layout', () => {
  it('maps a prefix to the directories npm writes', () => {
    expect(npmPrefixBinDirectory('D:\\npm-global', 'win32')).toBe('D:\\npm-global')
    expect(npmPrefixGlobalRoot('D:\\npm-global', 'win32')).toBe('D:\\npm-global\\node_modules')
    expect(npmPrefixBinDirectory('/opt/npm', 'linux')).toBe('/opt/npm/bin')
    expect(npmPrefixGlobalRoot('/opt/npm', 'linux')).toBe('/opt/npm/lib/node_modules')
  })

  it('matches PATH entries by normalized identity', () => {
    expect(isDirectoryOnPath('D:\\npm-global', 'C:\\Windows;"d:\\NPM-Global\\";C:\\x', 'win32')).toBe(true)
    expect(isDirectoryOnPath('D:\\npm-global', 'C:\\Windows;D:\\npm-global-old', 'win32')).toBe(false)
    expect(isDirectoryOnPath('/opt/npm/bin', '/usr/bin:/opt/npm/bin/', 'linux')).toBe(true)
    expect(isDirectoryOnPath('/opt/npm/bin', '/usr/bin:/OPT/npm/bin', 'linux')).toBe(false)
  })
})

describe('resolveSameUserNpmPrefix', () => {
  function reader(files: Record<string, string>) {
    return async (filePath: string) => {
      const text = files[filePath]
      if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return text
    }
  }

  const windowsEnv = {
    APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
    Path: 'C:\\Windows\\System32;D:\\npm-global;C:\\Program Files\\nodejs',
  }

  it('returns the prefix the user configured when its command directory is on PATH', async () => {
    await expect(resolveSameUserNpmPrefix({
      env: windowsEnv,
      platform: 'win32',
      homedir: () => 'C:\\Users\\tester',
      readFile: reader({ 'C:\\Users\\tester\\.npmrc': 'prefix=D:\\npm-global\r\n' }),
    })).resolves.toEqual({ prefix: 'D:\\npm-global', userConfigPath: 'C:\\Users\\tester\\.npmrc' })
  })

  it('keeps the old behaviour when the configured directory is not on PATH', async () => {
    await expect(resolveSameUserNpmPrefix({
      env: { Path: 'C:\\Windows\\System32' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\tester',
      readFile: reader({ 'C:\\Users\\tester\\.npmrc': 'prefix=D:\\npm-global\r\n' }),
    })).resolves.toBeNull()
  })

  it('defers to npm_config_prefix, which npm already honours over the user config', async () => {
    let read = false
    await expect(resolveSameUserNpmPrefix({
      env: { ...windowsEnv, NPM_CONFIG_PREFIX: 'E:\\other' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\tester',
      readFile: async () => {
        read = true
        return 'prefix=D:\\npm-global\n'
      },
    })).resolves.toBeNull()
    expect(read).toBe(false)
  })

  it('returns null when the user config is missing, unreadable or has no usable prefix', async () => {
    const base = { env: windowsEnv, platform: 'win32' as const, homedir: () => 'C:\\Users\\tester' }
    await expect(resolveSameUserNpmPrefix({ ...base, readFile: reader({}) })).resolves.toBeNull()
    await expect(resolveSameUserNpmPrefix({
      ...base,
      readFile: async () => { throw new Error('npm 用户配置必须是单链接普通文件') },
    })).resolves.toBeNull()
    await expect(resolveSameUserNpmPrefix({
      ...base,
      readFile: reader({ 'C:\\Users\\tester\\.npmrc': 'registry=https://registry.npmjs.org/\n' }),
    })).resolves.toBeNull()
    await expect(resolveSameUserNpmPrefix({
      ...base,
      readFile: reader({ 'C:\\Users\\tester\\.npmrc': 'prefix=npm-global\n' }),
    })).resolves.toBeNull()
  })

  it.runIf(process.platform !== 'win32')('reads the real file through the bounded reader and refuses a symlinked config', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-npm-user-prefix-')))
    temporaryDirectories.push(root)
    const home = path.join(root, 'home')
    const prefix = path.join(root, 'npm-global')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, '.npmrc'), `prefix=${prefix}\n`)
    const env = { HOME: home, PATH: `/usr/bin:${path.join(prefix, 'bin')}` }

    await expect(resolveSameUserNpmPrefix({ env, platform: process.platform }))
      .resolves.toEqual({ prefix, userConfigPath: path.join(home, '.npmrc') })

    fs.renameSync(path.join(home, '.npmrc'), path.join(root, 'real-npmrc'))
    fs.symlinkSync(path.join(root, 'real-npmrc'), path.join(home, '.npmrc'))
    await expect(resolveSameUserNpmPrefix({ env, platform: process.platform })).resolves.toBeNull()
  })
})

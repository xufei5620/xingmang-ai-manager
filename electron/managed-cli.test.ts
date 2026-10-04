import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureManagedNpmLayout, type ManagedNpmLayoutOptions } from './managed-cli'
import {
  managedCliRoot,
  managedNpmBinDirectory,
  managedNpmCacheRoot,
  managedNpmPrefix,
  managedNativeProviderRoot,
  managedNodeRuntimeBinDirectory,
  managedNodeRuntimeRoot,
  managedProductRoot,
} from './managed-cli-paths'
import type { WindowsMachinePaths } from './windows-machine-paths'
import { clearTrustedManagedWindowsRootsForTests } from './managed-path-trust'

const temporaryDirectories: string[] = []

function testMachinePaths(programData: string): WindowsMachinePaths {
  return {
    systemRoot: 'D:\\Windows',
    system32: 'D:\\Windows\\System32',
    programFiles: 'D:\\Program Files',
    programFilesX86: 'D:\\Program Files (x86)',
    programData,
  }
}

afterEach(() => {
  clearTrustedManagedWindowsRootsForTests()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

// 恢复的规矩三个平台一样，这几条在哪台 CI 上都跑：Mac、Linux 用临时主目录，Windows 照下面
// 几条用假的 ProgramData。
function layoutOptionsForThisPlatform(): ManagedNpmLayoutOptions {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-npm-recovery-')))
  temporaryDirectories.push(root)
  if (process.platform === 'win32') {
    return {
      env: { ...process.env, ProgramData: root },
      platform: 'win32',
      applyWindowsAcl: vi.fn(async () => undefined),
      machinePaths: testMachinePaths(root),
    }
  }
  return { env: { ...process.env, HOME: root, XDG_DATA_HOME: '' }, platform: process.platform }
}

describe('managed CLI paths', () => {
  it('keeps the permanent npm prefix and cache below ProgramData', () => {
    const env = { ProgramData: 'E:\\attacker' }
    const machinePaths = testMachinePaths('D:\\ProgramData')
    expect(managedProductRoot(env, 'win32', machinePaths)).toBe('D:\\ProgramData\\XingMangAI')
    expect(managedCliRoot(env, 'win32', machinePaths)).toBe('D:\\ProgramData\\XingMangAI\\Cli')
    expect(managedNpmPrefix(env, 'win32', machinePaths)).toBe('D:\\ProgramData\\XingMangAI\\Cli\\npm')
    expect(managedNpmCacheRoot(env, 'win32', machinePaths)).toBe('D:\\ProgramData\\XingMangAI\\Cli\\npm-cache')
    expect(managedNpmBinDirectory(env, 'win32', machinePaths)).toBe('D:\\ProgramData\\XingMangAI\\Cli\\npm')
    expect(managedNativeProviderRoot('grok', env, 'win32', machinePaths)).toBe(
      'D:\\ProgramData\\XingMangAI\\Cli\\native\\grok',
    )
  })

  it('keeps Darwin npm maintenance below the current user Library directory', () => {
    const env = { HOME: '/Users/isolated-test-user' }
    const productRoot = '/Users/isolated-test-user/Library/Application Support/XingMangAI'

    expect(managedProductRoot(env, 'darwin')).toBe(productRoot)
    expect(managedCliRoot(env, 'darwin')).toBe(path.posix.join(productRoot, 'Cli'))
    expect(managedNpmPrefix(env, 'darwin')).toBe(path.posix.join(productRoot, 'Cli', 'npm'))
    expect(managedNpmCacheRoot(env, 'darwin')).toBe(path.posix.join(productRoot, 'Cli', 'npm-cache'))
    expect(managedNpmBinDirectory(env, 'darwin')).toBe(path.posix.join(productRoot, 'Cli', 'npm', 'bin'))
    expect(managedNativeProviderRoot('grok', env, 'darwin')).toBe(
      path.posix.join(productRoot, 'Cli', 'native', 'grok'),
    )
  })

  it('keeps Linux npm maintenance below the current user XDG data directory', () => {
    const env = { HOME: '/home/isolated-test-user' }
    const productRoot = '/home/isolated-test-user/.local/share/XingMangAI'

    expect(managedProductRoot(env, 'linux')).toBe(productRoot)
    expect(managedCliRoot(env, 'linux')).toBe(path.posix.join(productRoot, 'Cli'))
    expect(managedNpmPrefix(env, 'linux')).toBe(path.posix.join(productRoot, 'Cli', 'npm'))
    expect(managedNpmCacheRoot(env, 'linux')).toBe(path.posix.join(productRoot, 'Cli', 'npm-cache'))
    expect(managedNpmBinDirectory(env, 'linux')).toBe(path.posix.join(productRoot, 'Cli', 'npm', 'bin'))
    expect(managedNodeRuntimeRoot(env, 'linux')).toBe(path.posix.join(productRoot, 'Runtime', 'node'))
    expect(managedNodeRuntimeBinDirectory(env, 'linux')).toBe(path.posix.join(productRoot, 'Runtime', 'node', 'bin'))
  })

  it('follows an absolute XDG_DATA_HOME on Linux and ignores a relative one', () => {
    expect(managedProductRoot({ HOME: '/home/a', XDG_DATA_HOME: '/data/a' }, 'linux')).toBe('/data/a/XingMangAI')
    expect(managedProductRoot({ HOME: '/home/a', XDG_DATA_HOME: 'relative/share' }, 'linux'))
      .toBe('/home/a/.local/share/XingMangAI')
    expect(managedProductRoot({ HOME: '/home/a', XDG_DATA_HOME: '  ' }, 'linux'))
      .toBe('/home/a/.local/share/XingMangAI')
  })

  it('treats every other POSIX platform like Linux instead of a root-owned directory', () => {
    expect(managedProductRoot({ HOME: '/home/a' }, 'freebsd')).toBe('/home/a/.local/share/XingMangAI')
  })

  it.runIf(process.platform === 'linux')('creates a private Linux npm layout for atomic maintenance', async () => {
    const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-cli-linux-'))
    temporaryDirectories.push(temporaryHome)
    const homeDirectory = fs.realpathSync(temporaryHome)
    const env = { ...process.env, HOME: homeDirectory, XDG_DATA_HOME: '' }

    const layout = await ensureManagedNpmLayout({ env, platform: 'linux' })

    const productRoot = path.join(homeDirectory, '.local', 'share', 'XingMangAI')
    expect(layout.prefix).toBe(path.join(productRoot, 'Cli', 'npm'))
    expect(layout.cacheRoot).toBe(path.join(productRoot, 'Cli', 'npm-cache'))
    expect(fs.readFileSync(layout.userConfig, 'utf8')).toBe('')
    expect(fs.statSync(productRoot).mode & 0o777).toBe(0o700)
    expect(fs.statSync(layout.prefix).mode & 0o777).toBe(0o700)
    expect(fs.statSync(layout.userConfig).mode & 0o777).toBe(0o600)
  })

  it.runIf(process.platform === 'darwin')('creates a private Darwin npm layout for atomic maintenance', async () => {
    const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-cli-darwin-'))
    temporaryDirectories.push(temporaryHome)
    const homeDirectory = fs.realpathSync(temporaryHome)
    const env = { ...process.env, HOME: homeDirectory }

    const layout = await ensureManagedNpmLayout({ env, platform: 'darwin' })

    expect(layout.prefix).toBe(path.join(
      homeDirectory,
      'Library',
      'Application Support',
      'XingMangAI',
      'Cli',
      'npm',
    ))
    expect(layout.cacheRoot).toBe(path.join(
      homeDirectory,
      'Library',
      'Application Support',
      'XingMangAI',
      'Cli',
      'npm-cache',
    ))
    expect(fs.readFileSync(layout.userConfig, 'utf8')).toBe('')
    expect(fs.statSync(layout.prefix).mode & 0o777).toBe(0o700)
    expect(fs.statSync(layout.cacheRoot).mode & 0o777).toBe(0o700)
    expect(fs.statSync(layout.userConfig).mode & 0o777).toBe(0o600)
  })

  it.runIf(process.platform === 'win32')('creates protected directories and an empty single-link npm config', async () => {
    const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-cli-'))
    temporaryDirectories.push(programData)
    const applyWindowsAcl = vi.fn(async () => undefined)
    const env = { ...process.env, ProgramData: programData }
    const machinePaths = testMachinePaths(programData)

    const layout = await ensureManagedNpmLayout({
      env,
      platform: 'win32',
      applyWindowsAcl,
      machinePaths,
    })

    expect(layout.prefix).toBe(path.join(programData, 'XingMangAI', 'Cli', 'npm'))
    expect(layout.cacheRoot).toBe(path.join(programData, 'XingMangAI', 'Cli', 'npm-cache'))
    expect(fs.readFileSync(layout.userConfig, 'utf8')).toBe('')
    expect(fs.lstatSync(layout.userConfig).nlink).toBe(1)
    expect(applyWindowsAcl).toHaveBeenCalledTimes(1)
  })

  it.runIf(process.platform === 'win32')('rejects a hard-linked npm config before replacing it', async () => {
    const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-cli-'))
    temporaryDirectories.push(programData)
    const options = {
      env: { ...process.env, ProgramData: programData },
      platform: 'win32' as const,
      applyWindowsAcl: vi.fn(async () => undefined),
      machinePaths: testMachinePaths(programData),
    }
    const layout = await ensureManagedNpmLayout(options)
    fs.linkSync(layout.userConfig, path.join(path.dirname(layout.userConfig), 'npmrc-link'))

    await expect(ensureManagedNpmLayout(options)).rejects.toThrow('单链接普通文件')
  })

  it.runIf(process.platform === 'win32')('restores the previous prefix after a crash before promotion', async () => {
    const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-cli-'))
    temporaryDirectories.push(programData)
    const options = {
      env: { ...process.env, ProgramData: programData },
      platform: 'win32' as const,
      applyWindowsAcl: vi.fn(async () => undefined),
      machinePaths: testMachinePaths(programData),
    }
    const layout = await ensureManagedNpmLayout(options)
    fs.writeFileSync(path.join(layout.prefix, 'version.txt'), 'old', 'utf8')
    const transaction = path.join(layout.cacheRoot, 'npm-transaction-crashed')
    fs.mkdirSync(transaction)
    fs.renameSync(layout.prefix, path.join(transaction, 'previous-prefix'))

    await ensureManagedNpmLayout(options)

    expect(fs.readFileSync(path.join(layout.prefix, 'version.txt'), 'utf8')).toBe('old')
    expect(fs.existsSync(transaction)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('rolls back a promoted prefix when cleanup was interrupted', async () => {
    const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-cli-'))
    temporaryDirectories.push(programData)
    const options = {
      env: { ...process.env, ProgramData: programData },
      platform: 'win32' as const,
      applyWindowsAcl: vi.fn(async () => undefined),
      machinePaths: testMachinePaths(programData),
    }
    const layout = await ensureManagedNpmLayout(options)
    fs.writeFileSync(path.join(layout.prefix, 'version.txt'), 'old', 'utf8')
    const transaction = path.join(layout.cacheRoot, 'npm-transaction-crashed')
    fs.mkdirSync(transaction)
    fs.renameSync(layout.prefix, path.join(transaction, 'previous-prefix'))
    fs.mkdirSync(layout.prefix)
    fs.writeFileSync(path.join(layout.prefix, 'version.txt'), 'new', 'utf8')

    await ensureManagedNpmLayout(options)

    expect(fs.readFileSync(path.join(layout.prefix, 'version.txt'), 'utf8')).toBe('old')
    expect(fs.existsSync(transaction)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('fails closed when more than one rollback candidate exists', async () => {
    const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-managed-cli-'))
    temporaryDirectories.push(programData)
    const options = {
      env: { ...process.env, ProgramData: programData },
      platform: 'win32' as const,
      applyWindowsAcl: vi.fn(async () => undefined),
      machinePaths: testMachinePaths(programData),
    }
    const layout = await ensureManagedNpmLayout(options)
    for (const suffix of ['first', 'second']) {
      fs.mkdirSync(path.join(layout.cacheRoot, `npm-transaction-${suffix}`, 'previous-prefix'), {
        recursive: true,
      })
    }

    await expect(ensureManagedNpmLayout(options)).rejects.toThrow('多个未完成的 npm 安装事务')
  })

  it('keeps a verified update when only its superseded copy was left behind', async () => {
    const options = layoutOptionsForThisPlatform()
    const layout = await ensureManagedNpmLayout(options)
    fs.writeFileSync(path.join(layout.prefix, 'version.txt'), 'new', 'utf8')
    const transaction = path.join(layout.cacheRoot, 'npm-transaction-Ab12Cd')
    fs.mkdirSync(path.join(transaction, 'superseded-prefix'), { recursive: true })
    fs.writeFileSync(path.join(transaction, 'superseded-prefix', 'version.txt'), 'old', 'utf8')

    await ensureManagedNpmLayout(options)

    expect(fs.readFileSync(path.join(layout.prefix, 'version.txt'), 'utf8')).toBe('new')
    // Left for the leftover sweep (install-leftovers.ts), which removes it once it is old enough.
    expect(fs.readFileSync(path.join(transaction, 'superseded-prefix', 'version.txt'), 'utf8')).toBe('old')
  })

  it('rolls back only the update that was never verified and leaves verified leftovers alone', async () => {
    const options = layoutOptionsForThisPlatform()
    const layout = await ensureManagedNpmLayout(options)
    // v1 → v2 passed its check but its cleanup was cut short; v2 → v3 was cut short before its check.
    const verified = path.join(layout.cacheRoot, 'npm-transaction-Ab12Cd')
    fs.mkdirSync(path.join(verified, 'superseded-prefix'), { recursive: true })
    fs.writeFileSync(path.join(verified, 'superseded-prefix', 'version.txt'), 'v1', 'utf8')
    fs.writeFileSync(path.join(layout.prefix, 'version.txt'), 'v2', 'utf8')
    const unverified = path.join(layout.cacheRoot, 'npm-transaction-Ef34Gh')
    fs.mkdirSync(unverified)
    fs.renameSync(layout.prefix, path.join(unverified, 'previous-prefix'))
    fs.mkdirSync(layout.prefix)
    fs.writeFileSync(path.join(layout.prefix, 'version.txt'), 'v3', 'utf8')

    await ensureManagedNpmLayout(options)

    expect(fs.readFileSync(path.join(layout.prefix, 'version.txt'), 'utf8')).toBe('v2')
    expect(fs.existsSync(unverified)).toBe(false)
    expect(fs.readFileSync(path.join(verified, 'superseded-prefix', 'version.txt'), 'utf8')).toBe('v1')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureManagedNpmLayout } from './managed-cli'
import {
  managedCliRoot,
  managedNpmBinDirectory,
  managedNpmCacheRoot,
  managedNpmPrefix,
  managedNativeProviderRoot,
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

  it('creates protected directories and an empty single-link npm config', async () => {
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

  it('rejects a hard-linked npm config before replacing it', async () => {
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

  it('restores the previous prefix after a crash before promotion', async () => {
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

  it('rolls back a promoted prefix when cleanup was interrupted', async () => {
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

  it('fails closed when more than one rollback candidate exists', async () => {
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
})

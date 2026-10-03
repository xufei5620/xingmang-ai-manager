import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildInstallLeftoverLocations,
  installLeftoverMinimumAgeMs,
  isInstallLeftoverName,
  sweepInstallLeftovers,
  trustedCacheLeftoverPrefixes,
  userTemporaryLeftoverPrefixes,
} from './install-leftovers'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-leftovers-test-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function makeDirectory(name: string, ageMs: number, contents: Record<string, number> = {}): string {
  const directory = path.join(root, name)
  fs.mkdirSync(directory, { recursive: true })
  for (const [file, size] of Object.entries(contents)) {
    const target = path.join(directory, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.alloc(size))
  }
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(directory, when, when)
  return directory
}

const old = installLeftoverMinimumAgeMs + 60_000

describe('install leftover names', () => {
  it('accepts only known prefixes followed by a mkdtemp suffix', () => {
    expect(isInstallLeftoverName('xingmang-npm-transaction-Ab12Cd', userTemporaryLeftoverPrefixes)).toBe(true)
    expect(isInstallLeftoverName('xingmang-node-runtime-zzzzzz', userTemporaryLeftoverPrefixes)).toBe(true)
    expect(isInstallLeftoverName('xingmang-npm-transaction-', userTemporaryLeftoverPrefixes)).toBe(false)
    expect(isInstallLeftoverName('xingmang-npm-transaction-Ab12Cd7', userTemporaryLeftoverPrefixes)).toBe(false)
    expect(isInstallLeftoverName('xingmang-npm-transaction-Ab.2Cd', userTemporaryLeftoverPrefixes)).toBe(false)
    expect(isInstallLeftoverName('xingmang-my-project-Ab12Cd', userTemporaryLeftoverPrefixes)).toBe(false)
    expect(isInstallLeftoverName('npm-transaction-Ab12Cd', userTemporaryLeftoverPrefixes)).toBe(false)
    expect(isInstallLeftoverName('npm-transaction-Ab12Cd', trustedCacheLeftoverPrefixes)).toBe(true)
    // Claude Desktop 官网离线安装包那一路（claude-desktop-msix-installer.ts）两种身份下建的目录。
    expect(isInstallLeftoverName('xingmang-claude-desktop-Ab12Cd', userTemporaryLeftoverPrefixes)).toBe(true)
    expect(isInstallLeftoverName('claude-desktop-Ab12Cd', trustedCacheLeftoverPrefixes)).toBe(true)
  })
})

describe('buildInstallLeftoverLocations', () => {
  it('only sweeps the protected installer cache when Windows runs as administrator', () => {
    expect(buildInstallLeftoverLocations({
      platform: 'win32',
      windowsExecutionMode: 'trusted-only',
      temporaryDirectory: 'C:\\Users\\a\\AppData\\Local\\Temp',
      trustedCacheRoot: 'C:\\ProgramData\\XingMangAI\\InstallerCache',
    })).toEqual([{ directory: 'C:\\ProgramData\\XingMangAI\\InstallerCache', prefixes: trustedCacheLeftoverPrefixes }])
  })

  it('sweeps nothing as administrator when the protected cache cannot be resolved', () => {
    expect(buildInstallLeftoverLocations({
      platform: 'win32',
      windowsExecutionMode: 'trusted-only',
      temporaryDirectory: 'C:\\Temp',
      trustedCacheRoot: null,
    })).toEqual([])
  })

  it('only sweeps the user temp directory when Windows runs as a normal user', () => {
    expect(buildInstallLeftoverLocations({
      platform: 'win32',
      windowsExecutionMode: 'same-user',
      temporaryDirectory: 'C:\\Temp',
      trustedCacheRoot: 'C:\\ProgramData\\XingMangAI\\InstallerCache',
    })).toEqual([{ directory: 'C:\\Temp', prefixes: userTemporaryLeftoverPrefixes }])
  })

  it('sweeps the temp directory and the private installer cache on macOS', () => {
    const locations = buildInstallLeftoverLocations({
      platform: 'darwin',
      windowsExecutionMode: 'trusted-only',
      temporaryDirectory: '/tmp/x',
      trustedCacheRoot: '/tmp/x/xingmang-installer-cache',
    })
    expect(locations.map((location) => location.directory)).toEqual(['/tmp/x', '/tmp/x/xingmang-installer-cache'])
    expect(locations[0].prefixes).toContain('InstallerCache-')
  })
})

describe('sweepInstallLeftovers', () => {
  it('removes old leftovers and reports their size', async () => {
    const leftover = makeDirectory('xingmang-npm-transaction-Ab12Cd', old, { 'attempt-0/cache/blob': 4096, 'pkg.tgz': 1024 })
    const result = await sweepInstallLeftovers([{ directory: root, prefixes: userTemporaryLeftoverPrefixes }])
    expect(fs.existsSync(leftover)).toBe(false)
    expect(result).toEqual({ removed: 1, freedBytes: 5120, failed: 0 })
  })

  it('keeps recent directories that an install may still be using', async () => {
    const recent = makeDirectory('xingmang-npm-transaction-Ab12Cd', 60_000, { file: 10 })
    const result = await sweepInstallLeftovers([{ directory: root, prefixes: userTemporaryLeftoverPrefixes }])
    expect(fs.existsSync(recent)).toBe(true)
    expect(result.removed).toBe(0)
  })

  it('never touches directories it did not create', async () => {
    const own = makeDirectory('xingmang-projects-Ab12Cd', old, { 'notes.txt': 10 })
    const other = makeDirectory('customer-files', old, { 'a.txt': 10 })
    const plainFile = path.join(root, 'xingmang-node-runtime-Qw12Er')
    fs.writeFileSync(plainFile, 'x')
    const when = new Date(Date.now() - old)
    fs.utimesSync(plainFile, when, when)
    const result = await sweepInstallLeftovers([{ directory: root, prefixes: userTemporaryLeftoverPrefixes }])
    expect(fs.existsSync(own)).toBe(true)
    expect(fs.existsSync(other)).toBe(true)
    expect(fs.existsSync(plainFile)).toBe(true)
    expect(result.removed).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('does not follow a leftover-named link to somewhere else', async () => {
    const target = makeDirectory('customer-folder', old, { 'keep.txt': 10 })
    const link = path.join(root, 'xingmang-git-runtime-Zx12Cv')
    fs.symlinkSync(target, link, 'dir')
    const result = await sweepInstallLeftovers([{ directory: root, prefixes: userTemporaryLeftoverPrefixes }])
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(result.removed).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('removes links inside a leftover without deleting what they point at', async () => {
    const target = makeDirectory('customer-folder', old, { 'keep.txt': 10 })
    const leftover = makeDirectory('xingmang-grok-binary-Zx12Cv', old)
    fs.symlinkSync(target, path.join(leftover, 'inner-link'), 'dir')
    const when = new Date(Date.now() - old)
    fs.utimesSync(leftover, when, when)
    const result = await sweepInstallLeftovers([{ directory: root, prefixes: userTemporaryLeftoverPrefixes }])
    expect(fs.existsSync(leftover)).toBe(false)
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true)
    expect(result.removed).toBe(1)
  })

  it('skips a missing location without failing', async () => {
    const result = await sweepInstallLeftovers([{ directory: path.join(root, 'missing'), prefixes: userTemporaryLeftoverPrefixes }])
    expect(result).toEqual({ removed: 0, freedBytes: 0, failed: 0 })
  })
})

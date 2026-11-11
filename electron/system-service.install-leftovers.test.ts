import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import type { InstallLeftoverLocation, InstallLeftoverSweepOptions, InstallLeftoverSweepResult } from './install-leftovers'
import {
  installLeftoverMinimumAgeMs,
  managedNpmTransactionLeftoverPrefixes,
  managedNpmTransactionPreservedEntries,
  trustedCacheLeftoverPrefixes,
  userTemporaryLeftoverPrefixes,
} from './install-leftovers'
import { managedNpmCacheRoot } from './managed-cli-paths'
import { clearTrustedManagedWindowsRootsForTests, registerTrustedManagedWindowsRoot } from './managed-path-trust'
import { createSystemService } from './system-service'
import { trustedInstallerCacheRoot } from './trusted-temp'
import { resolveWindowsMachinePaths } from './windows-machine-paths'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  clearTrustedManagedWindowsRootsForTests()
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

function createFixture(
  sweep?: (locations: readonly InstallLeftoverLocation[]) => Promise<InstallLeftoverSweepResult>,
  runAs: { platform: NodeJS.Platform; windowsExecutionMode: 'same-user' | 'trusted-only' } = {
    platform: 'linux',
    windowsExecutionMode: 'same-user',
  },
  measure?: (locations: readonly InstallLeftoverLocation[], options?: InstallLeftoverSweepOptions) => Promise<number>,
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-leftover-service-')))
  temporaryDirectories.push(root)
  const home = path.join(root, 'home')
  vi.stubEnv('HOME', home)
  const log = vi.fn()
  const service = createSystemService(
    new AppSettingsStore(path.join(root, 'settings.json'), root),
    {
      ...runAs,
      findExecutable: vi.fn(async () => null),
      runtimeLog: { log },
      ...(sweep ? { sweepInstallLeftovers: sweep } : {}),
      ...(measure ? { measureInstallLeftovers: measure } : {}),
    },
  )
  return { service, log, home }
}

describe('cleaning up downloads left by interrupted installs', () => {
  it('does nothing when no sweeper is wired in', async () => {
    const { service } = createFixture()
    await expect(service.cleanupInstallLeftovers()).resolves.toEqual({ removed: 0, freedBytes: 0, failed: 0 })
  })

  it('sweeps the temp directory with the install prefixes and logs what it freed', async () => {
    const sweep = vi.fn(async (_locations: readonly InstallLeftoverLocation[]) => ({ removed: 2, freedBytes: 300 * 1024 * 1024, failed: 0 }))
    const { service, log } = createFixture(sweep)

    await expect(service.cleanupInstallLeftovers()).resolves.toEqual({ removed: 2, freedBytes: 300 * 1024 * 1024, failed: 0 })

    expect(sweep.mock.calls[0]?.[0][0]).toEqual({
      directory: os.tmpdir(),
      prefixes: [...userTemporaryLeftoverPrefixes, 'InstallerCache-'],
    })
    expect(log).toHaveBeenCalledWith('info', 'install', 'install-leftovers.swept', expect.stringContaining('300 MB'), expect.objectContaining({ removed: 2 }))
  })

  // The fixture poses as Linux, whose managed directory only takes a POSIX home path.
  it.runIf(process.platform !== 'win32')('also sweeps the managed npm cache where updates of the managed CLIs leave their folders', async () => {
    const sweep = vi.fn(async (_locations: readonly InstallLeftoverLocation[]) => ({ removed: 0, freedBytes: 0, failed: 0 }))
    const { service, home } = createFixture(sweep)
    vi.stubEnv('XDG_DATA_HOME', undefined)

    await service.cleanupInstallLeftovers()

    expect(sweep.mock.calls[0]?.[0]).toContainEqual({
      directory: path.join(home, '.local', 'share', 'XingMangAI', 'Cli', 'npm-cache'),
      prefixes: managedNpmTransactionLeftoverPrefixes,
      preserveIfContains: managedNpmTransactionPreservedEntries,
    })
  })

  // Only a real Windows resolves ProgramData, and only there does the trust registry answer at all.
  it.runIf(process.platform === 'win32')('leaves the managed npm cache alone as administrator until this run has checked its ACL', async () => {
    const sweep = vi.fn(async (_locations: readonly InstallLeftoverLocation[]) => ({ removed: 0, freedBytes: 0, failed: 0 }))
    const { service } = createFixture(sweep, { platform: 'win32', windowsExecutionMode: 'trusted-only' })
    const managedNpmCache = {
      directory: managedNpmCacheRoot(process.env, 'win32'),
      prefixes: managedNpmTransactionLeftoverPrefixes,
      preserveIfContains: managedNpmTransactionPreservedEntries,
    }

    await service.cleanupInstallLeftovers()
    expect(sweep.mock.calls[0]?.[0]).not.toContainEqual(managedNpmCache)

    // Stands in for the hardening an install runs before it touches the managed directory. The real
    // root is ProgramData\XingMangAI, which a test machine does not have.
    registerTrustedManagedWindowsRoot(resolveWindowsMachinePaths().programData)
    await service.cleanupInstallLeftovers()
    expect(sweep.mock.calls[1]?.[0]).toContainEqual(managedNpmCache)
  })

  // Same as above: the installer cache sits next to the managed directory in ProgramData\XingMangAI.
  it.runIf(process.platform === 'win32')('leaves the installer cache alone as administrator until this run has checked its ACL', async () => {
    const sweep = vi.fn(async (_locations: readonly InstallLeftoverLocation[]) => ({ removed: 0, freedBytes: 0, failed: 0 }))
    const { service } = createFixture(sweep, { platform: 'win32', windowsExecutionMode: 'trusted-only' })
    const installerCache = {
      directory: trustedInstallerCacheRoot(process.env, 'win32'),
      prefixes: trustedCacheLeftoverPrefixes,
    }

    // The sweep a couple of minutes after startup runs before any install has hardened that directory.
    await service.cleanupInstallLeftovers()
    expect(sweep.mock.calls[0]?.[0]).not.toContainEqual(installerCache)

    // Stands in for the hardening an install runs before it creates its temporary directory there.
    registerTrustedManagedWindowsRoot(resolveWindowsMachinePaths().programData)
    await service.cleanupInstallLeftovers()
    expect(sweep.mock.calls[1]?.[0]).toContainEqual(installerCache)
  })

  // Off Windows the installer cache lives in this user's own temp directory, with no ACL for a run to check.
  it('keeps sweeping the installer cache when not running on Windows', async () => {
    const sweep = vi.fn(async (_locations: readonly InstallLeftoverLocation[]) => ({ removed: 0, freedBytes: 0, failed: 0 }))
    const { service } = createFixture(sweep)

    await service.cleanupInstallLeftovers()

    expect(sweep.mock.calls[0]?.[0]).toContainEqual({
      directory: trustedInstallerCacheRoot(process.env, 'linux'),
      prefixes: trustedCacheLeftoverPrefixes,
    })
  })

  it('runs in the installation queue so it never overlaps an install', async () => {
    let release!: () => void
    const sweep = vi.fn(() => new Promise<InstallLeftoverSweepResult>((resolve) => {
      release = () => resolve({ removed: 0, freedBytes: 0, failed: 0 })
    }))
    const { service } = createFixture(sweep)

    const pending = service.cleanupInstallLeftovers()
    await vi.waitFor(() => expect(sweep).toHaveBeenCalled())
    expect(service.inspectInstallationQueue().activeKey).toBe('maintenance:install-leftovers')
    release()
    await pending
    expect(service.inspectInstallationQueue().activeKey).toBeNull()
  })

  it('swallows a failing sweep and records it for next time', async () => {
    const { service, log } = createFixture(vi.fn(async () => {
      throw new Error('EBUSY')
    }))

    await expect(service.cleanupInstallLeftovers()).resolves.toEqual({ removed: 0, freedBytes: 0, failed: 0 })
    expect(log).toHaveBeenCalledWith('warn', 'install', 'install-leftovers.failed', expect.any(String), { error: 'EBUSY' })
  })

  it.runIf(process.platform !== 'win32')('does not sweep after an install that failed', async () => {
    const sweep = vi.fn(async () => ({ removed: 0, freedBytes: 0, failed: 0 }))
    const { service } = createFixture(sweep)
    const target = { isDestroyed: () => false, send: vi.fn() }

    await service.installCli('claude', target).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sweep).not.toHaveBeenCalled()
  })
})

describe('the manual clean on the storage card', () => {
  it('does not wait six hours when running with the user\'s own rights, and says so in the log', async () => {
    const sweep = vi.fn(async (_locations: readonly InstallLeftoverLocation[], _options?: InstallLeftoverSweepOptions) => ({ removed: 1, freedBytes: 80 * 1024 * 1024, failed: 1 }))
    const { service, log } = createFixture(sweep)

    await expect(service.cleanInstallLeftoversNow()).resolves.toEqual({ removed: 1, freedBytes: 80 * 1024 * 1024, failed: 1 })

    expect(sweep.mock.calls[0]?.[1]).toEqual({ minimumAgeMs: 0 })
    expect(sweep.mock.calls[0]?.[0][0]).toEqual({ directory: os.tmpdir(), prefixes: [...userTemporaryLeftoverPrefixes, 'InstallerCache-'] })
    expect(log).toHaveBeenCalledWith('warn', 'install', 'install-leftovers.manual-cleaned', expect.stringContaining('80 MB'), { removed: 1, freedBytes: 80 * 1024 * 1024, failed: 1 })
  })

  it('keeps the six hours as administrator on Windows, where every account shares the folders', async () => {
    const sweep = vi.fn(async (_locations: readonly InstallLeftoverLocation[], _options?: InstallLeftoverSweepOptions) => ({ removed: 0, freedBytes: 0, failed: 0 }))
    const measure = vi.fn(async () => 0)
    const { service } = createFixture(sweep, { platform: 'win32', windowsExecutionMode: 'trusted-only' }, measure)

    await service.cleanInstallLeftoversNow()
    await service.measureInstallLeftoversNow()

    expect(sweep.mock.calls[0]?.[1]).toEqual({ minimumAgeMs: installLeftoverMinimumAgeMs })
    expect(measure.mock.calls[0]?.[1]).toEqual({ minimumAgeMs: installLeftoverMinimumAgeMs })
  })

  it('waits in the installation queue behind an install and keeps its own place apart from the automatic sweep', async () => {
    let release!: () => void
    const sweep = vi.fn((_locations: readonly InstallLeftoverLocation[], options?: InstallLeftoverSweepOptions) => options
      ? Promise.resolve({ removed: 0, freedBytes: 0, failed: 0 })
      : new Promise<InstallLeftoverSweepResult>((resolve) => {
          release = () => resolve({ removed: 0, freedBytes: 0, failed: 0 })
        }))
    const { service } = createFixture(sweep)

    const automatic = service.cleanupInstallLeftovers()
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1))
    const manual = service.cleanInstallLeftoversNow()
    expect(service.inspectInstallationQueue()).toEqual({ activeKey: 'maintenance:install-leftovers', pendingKeys: ['maintenance:install-leftovers-manual'] })
    release()
    await Promise.all([automatic, manual])
    expect(sweep.mock.calls[1]?.[1]).toEqual({ minimumAgeMs: 0 })
  })

  it('measures with the same rule without queueing, and measures nothing when no measurer is wired in', async () => {
    const measure = vi.fn(async () => 7168)
    const { service } = createFixture(undefined, undefined, measure)
    await expect(service.measureInstallLeftoversNow()).resolves.toBe(7168)
    expect(measure.mock.calls[0]?.[1]).toEqual({ minimumAgeMs: 0 })

    const bare = createFixture()
    await expect(bare.service.measureInstallLeftoversNow()).resolves.toBe(0)
    await expect(bare.service.cleanInstallLeftoversNow()).resolves.toEqual({ removed: 0, freedBytes: 0, failed: 0 })
  })
})

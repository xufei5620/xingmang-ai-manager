import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import type { InstallLeftoverLocation, InstallLeftoverSweepResult } from './install-leftovers'
import { userTemporaryLeftoverPrefixes } from './install-leftovers'
import { createSystemService } from './system-service'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

function createFixture(
  sweep?: (locations: readonly InstallLeftoverLocation[]) => Promise<InstallLeftoverSweepResult>,
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-leftover-service-')))
  temporaryDirectories.push(root)
  vi.stubEnv('HOME', path.join(root, 'home'))
  const log = vi.fn()
  const service = createSystemService(
    new AppSettingsStore(path.join(root, 'settings.json'), root),
    {
      platform: 'linux',
      windowsExecutionMode: 'same-user',
      findExecutable: vi.fn(async () => null),
      runtimeLog: { log },
      ...(sweep ? { sweepInstallLeftovers: sweep } : {}),
    },
  )
  return { service, log }
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

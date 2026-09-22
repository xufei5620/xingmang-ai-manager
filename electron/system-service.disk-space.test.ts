import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import type { DiskSpaceReading } from './disk-space'
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

const gigabyte = 1024 ** 3

function diskWith(availableBytes: number): DiskSpaceReading {
  return { availableBytes, totalBytes: 256 * gigabyte, measuredPath: '/data', deviceId: 1 }
}

/**
 * 预检跑在安装的最前面，所以这个夹具连 npm 都不给：空间够的时候安装照样失败，
 * 但失败的理由必须是别的，这正是「没被磁盘预检拦住」的证据。
 */
function createInstallFixture(readDiskSpace: () => Promise<DiskSpaceReading | null>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-disk-space-')))
  temporaryDirectories.push(root)
  vi.stubEnv('HOME', path.join(root, 'home'))
  const target = { isDestroyed: () => false, send: vi.fn() }
  const service = createSystemService(
    new AppSettingsStore(path.join(root, 'settings.json'), root),
    {
      platform: 'linux',
      windowsExecutionMode: 'same-user',
      findExecutable: vi.fn(async () => null),
      readDiskSpace: vi.fn(readDiskSpace),
    },
  )
  return { service, target }
}

describe('checking free space before a CLI install starts', () => {
  it('refuses to start when the install disk is nearly full, in wording the renderer files under 磁盘空间不够', async () => {
    const fixture = createInstallFixture(async () => diskWith(420 * 1024 ** 2))

    const error = await fixture.service.installCli('claude', fixture.target).catch((reason: unknown) => reason)

    expect(String(error)).toContain('磁盘空间不足')
    expect(String(error)).toContain('420 MB')
    expect(fixture.target.send).not.toHaveBeenCalled()
  })

  it('starts the install when the disk has room', async () => {
    const fixture = createInstallFixture(async () => diskWith(40 * gigabyte))

    const error = await fixture.service.installCli('claude', fixture.target).catch((reason: unknown) => reason)

    // 这个夹具没给 npm，所以安装必然失败——失败在 npm 那一步，正说明磁盘预检放行了。
    expect(String(error)).toContain('未检测到 npm')
  })

  it('starts the install when the free space cannot be read, rather than blocking over a missing number', async () => {
    const fixture = createInstallFixture(async () => null)

    const error = await fixture.service.installCli('claude', fixture.target).catch((reason: unknown) => reason)

    expect(String(error)).toContain('未检测到 npm')
  })
})

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
  // Linux 上托管目录跟着 XDG_DATA_HOME 走，不清掉会写进开发机真实的数据目录。
  vi.stubEnv('XDG_DATA_HOME', undefined)
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

  // 放行之后这个夹具会一路走到「找 npm」：Windows 上找不到 npm 就会去真的装一份
  // Node.js LTS（要出网，30 秒超时根本打不住），其他平台直接以「未检测到 npm」收
  // 场。放行本身是平台无关的纯逻辑，disk-space.test.ts 里三档都钉过，所以这两条
  // 只在停得住的平台上跑。
  it.runIf(process.platform !== 'win32')('starts the install when the disk has room', async () => {
    const fixture = createInstallFixture(async () => diskWith(40 * gigabyte))

    const error = await fixture.service.installCli('claude', fixture.target).catch((reason: unknown) => reason)

    // 这个夹具没给 npm，所以安装必然失败——失败在 npm 那一步，正说明磁盘预检放行了。
    expect(String(error)).toContain('未检测到 npm')
  })

  it.runIf(process.platform !== 'win32')(
    'starts the install when the free space cannot be read, rather than blocking over a missing number',
    async () => {
      const fixture = createInstallFixture(async () => null)

      const error = await fixture.service.installCli('claude', fixture.target)
        .catch((reason: unknown) => reason)

      expect(String(error)).toContain('未检测到 npm')
    },
  )
})

describe('refusing an npm install over a CLI installed another way', () => {
  it('does not add a second npm copy next to a CLI from elsewhere', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-external-cli-')))
    temporaryDirectories.push(root)
    vi.stubEnv('HOME', path.join(root, 'home'))
    const target = { isDestroyed: () => false, send: vi.fn() }
    const readDiskSpace = vi.fn(async () => diskWith(40 * gigabyte))
    const service = createSystemService(
      new AppSettingsStore(path.join(root, 'settings.json'), root),
      {
        platform: 'linux',
        windowsExecutionMode: 'same-user',
        findExecutable: vi.fn(async () => null),
        readDiskSpace,
        resolveCliInstallation: async () => ({
          commandPath: path.join(root, 'other', 'bin', 'claude'),
          installDirectory: path.join(root, 'other'),
          packageRoot: null,
          npmPrefix: null,
          source: 'native',
        }),
      },
    )

    const error = await service.installCli('claude', target).catch((reason: unknown) => reason)

    expect(String(error)).toContain('不是通过本工具安装的，这里不会再另装一份')
    expect(target.send).not.toHaveBeenCalled()
    expect(readDiskSpace).not.toHaveBeenCalled()
  })
})

// 「换成星芒装的」先卸后装（第三十一批 B）：装不回来就不该先卸，盘不够时官方那份原样留着。
describe('checking free space before uninstalling a CLI that is about to be reinstalled', () => {
  function createNativeClaudeFixture(readDiskSpace: () => Promise<DiskSpaceReading | null>) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-switch-disk-')))
    temporaryDirectories.push(root)
    const home = path.join(root, 'home')
    const binDirectory = path.join(home, '.local', 'bin')
    const commandPath = path.join(binDirectory, 'claude')
    fs.mkdirSync(binDirectory, { recursive: true })
    fs.writeFileSync(commandPath, '#!/bin/sh\n', { mode: 0o755 })
    vi.stubEnv('HOME', home)
    vi.stubEnv('XDG_DATA_HOME', undefined)
    const probe = vi.fn(readDiskSpace)
    const service = createSystemService(
      new AppSettingsStore(path.join(root, 'settings.json'), root),
      {
        platform: 'linux',
        windowsExecutionMode: 'same-user',
        findExecutable: vi.fn(async () => null),
        readDiskSpace: probe,
        syncLinuxTerminalCommands: vi.fn(async () => ({ outcome: 'present' as const, launchers: [], skipped: [] })),
        // 同官方安装器：命令还在就认得出，卸掉以后就没有了。
        resolveCliInstallation: async () => fs.existsSync(commandPath)
          ? { commandPath, installDirectory: binDirectory, packageRoot: null, npmPrefix: null, source: 'native' as const }
          : null,
      },
    )
    return { service, commandPath, probe }
  }

  it('leaves the installed copy alone when the reinstall would not fit on the disk', async () => {
    const fixture = createNativeClaudeFixture(async () => diskWith(420 * 1024 ** 2))

    const error = await fixture.service.uninstallCli('claude', { reinstall: true }).catch((reason: unknown) => reason)

    expect(String(error)).toContain('Claude Code 安装失败')
    expect(String(error)).toContain('磁盘空间不足')
    expect(fs.existsSync(fixture.commandPath)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('uninstalls once the disk has room for the reinstall', async () => {
    const fixture = createNativeClaudeFixture(async () => diskWith(40 * gigabyte))

    await expect(fixture.service.uninstallCli('claude', { reinstall: true })).resolves.toMatchObject({ outcome: 'uninstalled' })

    expect(fixture.probe).toHaveBeenCalled()
    expect(fs.existsSync(fixture.commandPath)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('never looks at the disk for a plain uninstall, which only frees space', async () => {
    const fixture = createNativeClaudeFixture(async () => diskWith(420 * 1024 ** 2))

    await expect(fixture.service.uninstallCli('claude')).resolves.toMatchObject({ outcome: 'uninstalled' })

    expect(fixture.probe).not.toHaveBeenCalled()
    expect(fs.existsSync(fixture.commandPath)).toBe(false)
  })
})

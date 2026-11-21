import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import type { DiskSpaceReading } from './disk-space'
import { createSystemService } from './system-service'
import { UnrecognizedDarwinCliError } from './tool-installation'

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
 * 放行以后、找 npm 之前，安装会先去 npm 官方源核对版本和 SHA-512。这里替它回一份像样的
 * 元数据，不出网：原来真的去连 registry.npmjs.org，CI 的机器偶尔 10 秒等不来就报「查询超时」，
 * 跟磁盘预检无关的一条红。
 */
function officialRegistryRelease(): typeof fetch {
  return async (input) => {
    const segments = new URL(String(input)).pathname.split('/')
    const version = decodeURIComponent(segments.pop() ?? '')
    const name = decodeURIComponent(segments.pop() ?? '')
    const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`
    return new Response(JSON.stringify({ name, version: version === 'latest' ? '9.9.9' : version, dist: { integrity } }), { status: 200 })
  }
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
  // 装之前会按首页那套判定看这台电脑上是不是已经有别处装的 Claude Code，那一步照 PATH 找。
  // 不换成空目录就读到跑测试那台机器的 PATH：开发机或云端容器自带一份（/opt/node22/bin/claude）时，
  // 安装在磁盘预检之前就被拒成「不是通过本工具安装的」，这里要看的拦和放都看不到。
  const emptyBin = path.join(root, 'bin')
  fs.mkdirSync(emptyBin)
  vi.stubEnv('PATH', emptyBin)
  const target = { isDestroyed: () => false, send: vi.fn() }
  const registryFetch = vi.fn(officialRegistryRelease())
  const service = createSystemService(
    new AppSettingsStore(path.join(root, 'settings.json'), root),
    {
      platform: 'linux',
      windowsExecutionMode: 'same-user',
      findExecutable: vi.fn(async () => null),
      readDiskSpace: vi.fn(readDiskSpace),
      registryFetch,
    },
  )
  return { service, target, registryFetch }
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
    expect(fixture.registryFetch).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform !== 'win32')(
    'starts the install when the free space cannot be read, rather than blocking over a missing number',
    async () => {
      const fixture = createInstallFixture(async () => null)

      const error = await fixture.service.installCli('claude', fixture.target)
        .catch((reason: unknown) => reason)

      expect(String(error)).toContain('未检测到 npm')
      expect(fixture.registryFetch).toHaveBeenCalledOnce()
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

// Mac 验收 R1：首页对认不出来路的 Codex / Grok 给的是「使用星芒安装」，点下去不能再被「不会另装一份」拦回来。
describe('installing over a Mac CLI that cannot be recognised', () => {
  function createDarwinFixture(provider: 'codex' | 'grok', resolveCliCommand: () => Promise<never>) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-unrecognized-cli-')))
    temporaryDirectories.push(root)
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    vi.stubEnv('HOME', home)
    const target = { isDestroyed: () => false, send: vi.fn() }
    const readDiskSpace = vi.fn(async () => diskWith(420 * 1024 ** 2))
    const service = createSystemService(
      new AppSettingsStore(path.join(root, 'settings.json'), root),
      {
        platform: 'darwin',
        findExecutable: vi.fn(async () => null),
        readDiskSpace,
        resolveCliCommand,
        macosCodexAppDetector: vi.fn(async () => ({ app: null, detectionFailed: false, detectionError: null })),
        resolveCliInstallation: async (requested) => requested === provider
          ? {
              commandPath: path.join(root, 'third-party', 'bin', provider),
              installDirectory: path.join(root, 'third-party'),
              packageRoot: null,
              npmPrefix: null,
              source: 'native',
            }
          : null,
      },
    )
    return { home, readDiskSpace, service, target }
  }

  // 磁盘预检排在「不会另装一份」后面：走到磁盘那一步，说明认不出的那份没有拦住这次安装。
  it.runIf(process.platform !== 'win32')('lets the install go ahead next to an unrecognised Codex', async () => {
    const fixture = createDarwinFixture('codex', async () => {
      throw new UnrecognizedDarwinCliError(new Error('not the standalone layout'))
    })

    const error = await fixture.service.installCli('codex', fixture.target).catch((reason: unknown) => reason)

    expect(String(error)).toContain('磁盘空间不足')
    expect(String(error)).not.toContain('不会再另装一份')
    expect(fixture.readDiskSpace).toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')('lets the install go ahead when nothing occupies the Grok link', async () => {
    const fixture = createDarwinFixture('grok', async () => {
      throw new Error('Grok launch is not resolved while installing')
    })

    const error = await fixture.service.installCli('grok', fixture.target).catch((reason: unknown) => reason)

    expect(String(error)).toContain('磁盘空间不足')
    expect(fixture.readDiskSpace).toHaveBeenCalled()
  })

  // npm 的安装脚本会盖掉 ~/.grok/bin/grok：放不回去的那几种（手做的绝对链接、普通文件）一个字节都不下就停。
  it.runIf(process.platform !== 'win32')('stops before downloading when the Grok link is one the install could not put back', async () => {
    const fixture = createDarwinFixture('grok', async () => {
      throw new Error('Grok launch is not resolved while installing')
    })
    const bin = path.join(fixture.home, '.grok', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.symlinkSync(path.join(fixture.home, 'elsewhere', 'grok'), path.join(bin, 'grok'))

    const error = await fixture.service.installCli('grok', fixture.target).catch((reason: unknown) => reason)

    expect(String(error)).toContain('这台电脑上已经有一份 Grok CLI，不是用星芒装的。为了不弄坏它，已停止安装。')
    expect(String(error)).toContain('使用星芒安装')
    expect(fixture.readDiskSpace).not.toHaveBeenCalled()
    expect(fixture.target.send).not.toHaveBeenCalled()
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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliNativePackageMissingMessage } from './cli-native-package'
import {
  buildLinuxGrokRetainedFilesCommand,
  buildLinuxGrokRetainedFilesReason,
  isLinuxGrokVersionFileName,
  linuxGrokPlatformPackageName,
  resolveLinuxGrokInstalledVersion,
  runLinuxGrokPostInstallTransaction,
  uninstallVerifiedLinuxGrokInstallation,
  verifyLinuxGrokPostInstall,
  type LinuxGrokCommandRunner,
} from './linux-grok'

const temporaryRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('linuxGrokPlatformPackageName', () => {
  it('names the two Linux builds xAI publishes and nothing else', () => {
    expect(linuxGrokPlatformPackageName('x64')).toBe('@xai-official/grok-linux-x64')
    expect(linuxGrokPlatformPackageName('arm64')).toBe('@xai-official/grok-linux-arm64')
    expect(linuxGrokPlatformPackageName('riscv64')).toBeNull()
    expect(linuxGrokPlatformPackageName('ia32')).toBeNull()
  })
})

describe('isLinuxGrokVersionFileName', () => {
  it('accepts only the grok-<version> name postinstall writes', () => {
    expect(isLinuxGrokVersionFileName('grok-1.0.44')).toBe(true)
    expect(isLinuxGrokVersionFileName('grok-1.0.44-beta.2')).toBe(true)
    expect(isLinuxGrokVersionFileName('grok')).toBe(false)
    expect(isLinuxGrokVersionFileName('grok-')).toBe(false)
    expect(isLinuxGrokVersionFileName('grok-latest')).toBe(false)
    expect(isLinuxGrokVersionFileName('grok-1.0.44/../../x')).toBe(false)
    expect(isLinuxGrokVersionFileName('../downloads/grok-1.0.44')).toBe(false)
  })
})

describe('Linux Grok retained files', () => {
  it('says nothing when every program file was removed', () => {
    expect(buildLinuxGrokRetainedFilesReason([])).toBeNull()
    expect(buildLinuxGrokRetainedFilesCommand([])).toBeNull()
  })

  it('names the leftovers and gives one copyable command that survives odd characters', () => {
    const files = ['/home/a/.grok/bin/grok-1.0.44', "/home/o'brien/.grok/bin/grok-1.0.46"]
    expect(buildLinuxGrokRetainedFilesReason(files)).toBe(
      'Grok CLI 已卸载，但 ~/.grok/bin 里有 2 个程序文件没能自动删除（grok-1.0.44、grok-1.0.46）。关闭所有 Grok CLI 窗口后，可以用下方命令删除它们；你的 Grok 设置和会话记录不受影响。',
    )
    expect(buildLinuxGrokRetainedFilesCommand(files)).toBe(
      `rm -f '/home/a/.grok/bin/grok-1.0.44' '/home/o'"'"'brien/.grok/bin/grok-1.0.46'`,
    )
  })

  it('lists at most five names', () => {
    const files = Array.from({ length: 7 }, (_, index) => `/h/.grok/bin/grok-1.0.${index}`)
    const reason = buildLinuxGrokRetainedFilesReason(files)
    expect(reason).toContain('有 7 个程序文件')
    expect(reason).toContain('grok-1.0.4 等')
    expect(reason).not.toContain('grok-1.0.5')
  })
})

describe.runIf(process.platform === 'linux')('Linux Grok install verification and uninstall', () => {
  interface Fixture {
    root: string
    home: string
    bin: string
    resolution: string
    binary: Buffer
  }

  const version = '1.0.44'
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'

  function createFixture(): Fixture {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-grok-')))
    temporaryRoots.push(root)
    const home = path.join(root, 'home')
    const bin = path.join(home, '.grok', 'bin')
    const resolution = path.join(root, 'resolution')
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
    fs.mkdirSync(resolution, { recursive: true })
    // Big enough that the brotli stream arrives in more than one chunk.
    const binary = Buffer.concat([Buffer.from('\x7fELF grok '), Buffer.alloc(300_000, 0x5a), Buffer.from(version)])
    return { root, home, bin, resolution, binary }
  }

  function writePlatformPackage(fixture: Fixture, options: { version?: string; nested?: boolean; withBinary?: boolean } = {}) {
    const name = `@xai-official/grok-linux-${architecture}`
    const packageDirectory = options.nested
      ? path.join(fixture.resolution, 'node_modules', '@xai-official', 'grok', 'node_modules', '@xai-official', `grok-linux-${architecture}`)
      : path.join(fixture.resolution, 'node_modules', '@xai-official', `grok-linux-${architecture}`)
    fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name, version: options.version ?? version }))
    if (options.withBinary !== false) {
      fs.writeFileSync(path.join(packageDirectory, 'bin', 'grok.br'), zlib.brotliCompressSync(fixture.binary))
    }
  }

  /** What `node bin/postinstall.js` leaves behind on Linux. */
  function writeInstalledLayout(fixture: Fixture, installedVersion = version, contents: Buffer = fixture.binary) {
    fs.writeFileSync(path.join(fixture.bin, `grok-${installedVersion}`), contents, { mode: 0o755 })
    fs.rmSync(path.join(fixture.bin, 'grok'), { force: true })
    fs.symlinkSync(`grok-${installedVersion}`, path.join(fixture.bin, 'grok'))
  }

  function versionRunner(output = `grok ${version} (6b2c1a0)\n`) {
    return vi.fn<LinuxGrokCommandRunner>(async () => ({ stdout: output, stderr: '' }))
  }

  function verify(fixture: Fixture, runCommand: LinuxGrokCommandRunner, expectedVersion = version) {
    return verifyLinuxGrokPostInstall({
      homeDirectory: fixture.home,
      expectedVersion,
      resolutionDirectory: fixture.resolution,
      architecture,
      runCommand,
    })
  }

  it('accepts an install byte-identical to the verified package and adds the missing agent link', async () => {
    const fixture = createFixture()
    writePlatformPackage(fixture)
    writeInstalledLayout(fixture)
    const runCommand = versionRunner()

    const selection = await verify(fixture, runCommand)

    expect(selection.linkTarget).toBe(`grok-${version}`)
    expect(selection.executablePath).toBe(path.join(fixture.bin, `grok-${version}`))
    expect(runCommand).toHaveBeenCalledWith({ executable: selection.executablePath, argv: ['--version'] })
    expect(fs.readlinkSync(path.join(fixture.bin, 'agent'))).toBe(`grok-${version}`)
  })

  it('finds the platform package when npm nested it under the main package', async () => {
    const fixture = createFixture()
    writePlatformPackage(fixture, { nested: true })
    writeInstalledLayout(fixture)

    await expect(verify(fixture, versionRunner())).resolves.toMatchObject({ linkTarget: `grok-${version}` })
  })

  it('rejects an installed program whose bytes differ from the verified package', async () => {
    const fixture = createFixture()
    writePlatformPackage(fixture)
    writeInstalledLayout(fixture, version, Buffer.concat([fixture.binary, Buffer.from('tampered')]))
    const runCommand = versionRunner()

    await expect(verify(fixture, runCommand)).rejects.toThrow('Grok CLI 装好的程序文件和官方发布的不一致')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('rejects a link that does not select the version this install was for', async () => {
    const fixture = createFixture()
    writePlatformPackage(fixture)
    writeInstalledLayout(fixture, '1.0.43')

    await expect(verify(fixture, versionRunner())).rejects.toThrow('Grok CLI 装完后命令没有指向这次装的版本')
  })

  it('reports a dropped optional download the same way the other CLIs do', async () => {
    const missing = createFixture()
    writeInstalledLayout(missing)
    await expect(verify(missing, versionRunner())).rejects.toThrow(cliNativePackageMissingMessage('Grok CLI'))

    const empty = createFixture()
    writePlatformPackage(empty, { withBinary: false })
    writeInstalledLayout(empty)
    await expect(verify(empty, versionRunner())).rejects.toThrow(cliNativePackageMissingMessage('Grok CLI'))
  })

  it('rejects a platform package of another version', async () => {
    const fixture = createFixture()
    writePlatformPackage(fixture, { version: '1.0.46' })
    writeInstalledLayout(fixture)

    await expect(verify(fixture, versionRunner())).rejects.toThrow('Grok CLI 的主程序包和这次要装的版本不一致')
  })

  it('rejects a program that reports another version', async () => {
    const fixture = createFixture()
    writePlatformPackage(fixture)
    writeInstalledLayout(fixture)

    await expect(verify(fixture, versionRunner('grok 1.0.46\n'))).rejects.toThrow('Grok CLI 装好后报告的版本和这次装的不一致')
    await expect(verify(fixture, versionRunner('something else\n'))).rejects.toThrow('Grok CLI 装好后报告的版本和这次装的不一致')
  })

  it('rejects a hard-linked program file', async () => {
    const fixture = createFixture()
    writePlatformPackage(fixture)
    writeInstalledLayout(fixture)
    fs.linkSync(path.join(fixture.bin, `grok-${version}`), path.join(fixture.root, 'second-name'))

    await expect(verify(fixture, versionRunner())).rejects.toThrow('Grok CLI 程序文件不是当前用户自己的普通文件')
  })

  it('refuses chips xAI publishes no Linux build for before reading anything', async () => {
    const fixture = createFixture()
    await expect(verifyLinuxGrokPostInstall({
      homeDirectory: fixture.home,
      expectedVersion: version,
      resolutionDirectory: fixture.resolution,
      architecture: 'riscv64',
      runCommand: versionRunner(),
    })).rejects.toThrow('这台电脑的芯片类型 Grok CLI 不支持')
  })

  it('puts the previous version back when verification fails after postinstall', async () => {
    const fixture = createFixture()
    writePlatformPackage(fixture)
    writeInstalledLayout(fixture, '1.0.40')

    await expect(runLinuxGrokPostInstallTransaction({
      homeDirectory: fixture.home,
      lifecycle: async () => writeInstalledLayout(fixture, version, Buffer.from('not the verified bytes')),
      verify: () => verify(fixture, versionRunner()),
    })).rejects.toThrow('官方发布的不一致')

    expect(fs.readlinkSync(path.join(fixture.bin, 'grok'))).toBe('grok-1.0.40')
    expect(fs.existsSync(path.join(fixture.bin, 'agent'))).toBe(false)
  })

  it('stops before npm runs when a Grok it could not put back is already there', async () => {
    const fixture = createFixture()
    fs.mkdirSync(path.join(fixture.home, '.grok', 'downloads'))
    fs.writeFileSync(path.join(fixture.home, '.grok', 'downloads', 'grok-1.0.40-linux-x86_64'), 'x', { mode: 0o755 })
    fs.symlinkSync(path.join('..', 'downloads', 'grok-1.0.40-linux-x86_64'), path.join(fixture.bin, 'grok'))
    const lifecycle = vi.fn(async () => undefined)

    await expect(runLinuxGrokPostInstallTransaction({
      homeDirectory: fixture.home,
      lifecycle,
      verify: async () => undefined,
    })).rejects.toThrow('这台电脑上已经有一份 Grok CLI，不是用星芒装的')
    expect(lifecycle).not.toHaveBeenCalled()
    expect(fs.readlinkSync(path.join(fixture.bin, 'grok'))).toBe(path.join('..', 'downloads', 'grok-1.0.40-linux-x86_64'))
  })

  it('reads the installed version from the link, and only from the npm layout', () => {
    const fixture = createFixture()
    expect(resolveLinuxGrokInstalledVersion(fixture.home, path.join(fixture.bin, 'grok'))).toBeNull()

    writeInstalledLayout(fixture)
    expect(resolveLinuxGrokInstalledVersion(fixture.home, path.join(fixture.bin, 'grok'))).toBe(version)
    // Asked about some other grok on PATH, it does not vouch for it.
    const elsewhere = path.join(fixture.root, 'grok')
    fs.writeFileSync(elsewhere, 'x', { mode: 0o755 })
    expect(resolveLinuxGrokInstalledVersion(fixture.home, elsewhere)).toBeNull()

    fs.mkdirSync(path.join(fixture.home, '.grok', 'downloads'))
    fs.writeFileSync(path.join(fixture.home, '.grok', 'downloads', 'grok-1.0.44-linux-x86_64'), 'x', { mode: 0o755 })
    fs.rmSync(path.join(fixture.bin, 'grok'))
    fs.symlinkSync(path.join('..', 'downloads', 'grok-1.0.44-linux-x86_64'), path.join(fixture.bin, 'grok'))
    expect(resolveLinuxGrokInstalledVersion(fixture.home, path.join(fixture.bin, 'grok'))).toBeNull()
  })

  it('removes the command links and every program file, and keeps settings and sessions', async () => {
    const fixture = createFixture()
    writeInstalledLayout(fixture, '1.0.40')
    writeInstalledLayout(fixture)
    fs.symlinkSync(`grok-${version}`, path.join(fixture.bin, 'agent'))
    fs.writeFileSync(path.join(fixture.home, '.grok', 'config.toml'), 'model = "grok"\n')
    fs.mkdirSync(path.join(fixture.home, '.grok', 'sessions'))
    fs.writeFileSync(path.join(fixture.home, '.grok', 'sessions', 'one.jsonl'), '{}\n')
    fs.writeFileSync(path.join(fixture.bin, 'notes.txt'), 'mine')

    await expect(uninstallVerifiedLinuxGrokInstallation({ homeDirectory: fixture.home, installDirectory: fixture.bin }))
      .resolves.toEqual({ retainedFiles: [] })

    expect(fs.readdirSync(fixture.bin)).toEqual(['notes.txt'])
    expect(fs.readFileSync(path.join(fixture.home, '.grok', 'config.toml'), 'utf8')).toBe('model = "grok"\n')
    expect(fs.existsSync(path.join(fixture.home, '.grok', 'sessions', 'one.jsonl'))).toBe(true)
  })

  it('reports a program file it may not delete instead of deleting through a second name', async () => {
    const fixture = createFixture()
    writeInstalledLayout(fixture)
    writeInstalledLayout(fixture, '1.0.40')
    const outside = path.join(fixture.root, 'kept-elsewhere')
    fs.linkSync(path.join(fixture.bin, `grok-${version}`), outside)

    const result = await uninstallVerifiedLinuxGrokInstallation({ homeDirectory: fixture.home, installDirectory: fixture.bin })

    expect(result.retainedFiles).toEqual([path.join(fixture.bin, `grok-${version}`)])
    expect(fs.existsSync(path.join(fixture.bin, 'grok'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.bin, 'grok-1.0.40'))).toBe(false)
    expect(fs.readFileSync(outside)).toEqual(fixture.binary)
  })

  it('refuses a link that leaves the npm layout and touches nothing', async () => {
    const fixture = createFixture()
    writeInstalledLayout(fixture)
    const foreign = path.join(fixture.root, 'grok-1.0.44')
    fs.writeFileSync(foreign, 'someone else', { mode: 0o755 })
    fs.rmSync(path.join(fixture.bin, 'grok'))
    fs.symlinkSync(foreign, path.join(fixture.bin, 'grok'))

    await expect(uninstallVerifiedLinuxGrokInstallation({ homeDirectory: fixture.home, installDirectory: fixture.bin }))
      .rejects.toThrow('不是星芒装的那种布局')
    expect(fs.readlinkSync(path.join(fixture.bin, 'grok'))).toBe(foreign)
    expect(fs.existsSync(path.join(fixture.bin, `grok-${version}`))).toBe(true)
    expect(fs.existsSync(foreign)).toBe(true)
  })

  it('refuses a ~/.grok/bin that is itself a link', async () => {
    const fixture = createFixture()
    const realBin = path.join(fixture.root, 'real-bin')
    fs.renameSync(fixture.bin, realBin)
    fs.symlinkSync(realBin, fixture.bin)
    writeInstalledLayout({ ...fixture, bin: realBin })

    await expect(uninstallVerifiedLinuxGrokInstallation({ homeDirectory: fixture.home, installDirectory: fixture.bin }))
      .rejects.toThrow('为避免误删已停止卸载')
    expect(fs.existsSync(path.join(realBin, `grok-${version}`))).toBe(true)
    expect(fs.readlinkSync(path.join(realBin, 'grok'))).toBe(`grok-${version}`)
  })

  it('asks for a refresh when the command link is already gone', async () => {
    const fixture = createFixture()
    await expect(uninstallVerifiedLinuxGrokInstallation({ homeDirectory: fixture.home, installDirectory: fixture.bin }))
      .rejects.toThrow('Grok CLI 命令入口已不存在，请刷新后重试')
  })
})

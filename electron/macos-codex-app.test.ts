import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, type CommandErrorCode } from './command-runner'
import {
  buildMacosCodexAppLaunchPlan,
  commandTimeoutMs,
  deepVerificationTimeoutMs,
  inspectMacosCodexApp,
  resetMacosCodexAppVerificationCache,
  resolveSystemCommandTimeoutMs,
  runSystemCommand,
} from './macos-codex-app'

const temporaryDirectories: string[] = []
const fixtureExecutableModes = new Map<string, number>()

beforeEach(() => {
  if (process.platform !== 'win32') return
  const originalLstat = fs.promises.lstat
  // NTFS cannot represent POSIX execute bits. Supply only that metadata for
  // explicitly registered fixture executables; every other filesystem check
  // and all negative-mode fixtures still exercise the production detector.
  vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: Parameters<typeof originalLstat>) => {
    const stats = await originalLstat(...args)
    const mode = fixtureExecutableModes.get(String(args[0]))
    if (mode !== undefined && typeof stats.mode === 'number') stats.mode = (stats.mode & ~0o777) | mode
    return stats
  }) as typeof originalLstat)
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-codex-app-'))
  temporaryDirectories.push(directory)
  return directory
}

type FixtureArchitecture = 'arm64' | 'x86_64'

function machExecutable(architectures: readonly FixtureArchitecture[] = [process.arch === 'x64' ? 'x86_64' : 'arm64']): Buffer {
  const headers = architectures.map((architecture) => {
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0xfeedfacf, 0)
    header.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4)
    header.writeUInt32LE(2, 12)
    return header
  })
  if (headers.length === 1) return headers[0]
  const tableBytes = 8 + headers.length * 20
  const executable = Buffer.alloc(tableBytes + headers.length * 32)
  executable.writeUInt32BE(0xcafebabe, 0)
  executable.writeUInt32BE(headers.length, 4)
  headers.forEach((header, index) => {
    const entry = 8 + index * 20
    executable.writeUInt32BE(header.readUInt32LE(4), entry)
    executable.writeUInt32BE(tableBytes + index * 32, entry + 8)
    executable.writeUInt32BE(32, entry + 12)
    header.copy(executable, tableBytes + index * 32)
  })
  return executable
}

function createApp(bundlePath: string, executableMode = 0o755, architectures?: readonly FixtureArchitecture[]): string {
  const infoPath = path.join(bundlePath, 'Contents', 'Info.plist')
  fs.mkdirSync(path.dirname(infoPath), { recursive: true })
  fs.writeFileSync(infoPath, '<plist/>')
  const executablePath = path.join(bundlePath, 'Contents', 'MacOS', 'ChatGPT')
  fs.mkdirSync(path.dirname(executablePath), { recursive: true })
  fs.writeFileSync(executablePath, machExecutable(architectures), { mode: executableMode })
  fixtureExecutableModes.set(fs.realpathSync(executablePath), executableMode)
  return fs.realpathSync(infoPath)
}

// A resolving codesign stub stands for a bundle whose certificate chain satisfied the
// designated requirement. Its output is empty because no caller may read it any more.
function officialBundleCommand(executable: string, argv: readonly string[]): string | null {
  if (executable === '/usr/bin/plutil' && argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
  if (executable === '/usr/bin/codesign') return ''
  return null
}

/**
 * Builds the same shape `runCommand` throws for a given failure mode, so tests can
 * drive `inspectMacosCodexApp` through explicit command failure modes. A bundle
 * claiming the Codex identity must remain unlaunchable on every failure while
 * surfacing a detection error rather than suggesting it has not been installed.
 */
function commandRunnerError(code: CommandErrorCode, message: string): CommandRunnerError {
  return new CommandRunnerError(message, {
    code,
    executable: '/usr/bin/codesign',
    argv: [],
    exitCode: code === 'EXIT_NON_ZERO' ? 1 : null,
    signal: null,
    stdout: '',
    stderr: '',
    outputBytes: 0,
    maxOutputBytes: 65_536,
    durationMs: 0,
  })
}

afterEach(() => {
  resetMacosCodexAppVerificationCache()
  vi.restoreAllMocks()
  fixtureExecutableModes.clear()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('buildMacosCodexAppLaunchPlan', () => {
  it('opens the verified application with a workspace deep link and no CLI dependency', () => {
    const workspace = path.resolve(os.tmpdir(), 'project')
    const plan = buildMacosCodexAppLaunchPlan('/Applications/Codex.app', workspace)

    expect(plan).toEqual({
      executable: '/usr/bin/open',
      argv: ['-a', '/Applications/Codex.app', expect.any(String)],
    })
    const url = new URL(plan.argv[2])
    expect(url.protocol).toBe('codex:')
    expect(url.hostname).toBe('threads')
    expect(url.pathname).toBe('/new')
    expect(url.searchParams.get('path')).toBe(workspace)
    expect([...url.searchParams.keys()]).toEqual(['path'])
  })

  it('keeps special characters literal and forwards the selected CODEX_HOME through LaunchServices', () => {
    const appPath = "/Users/tester/Apps & Tools/Codex's Copy.app"
    const workspace = path.resolve(os.tmpdir(), "Project's $value; & #hash 中文  ")
    const codexHome = path.resolve(os.tmpdir(), "Codex's $config & 中文")
    const plan = buildMacosCodexAppLaunchPlan(appPath, workspace, codexHome)

    expect(plan.executable).toBe('/usr/bin/open')
    expect(plan.argv.slice(0, 4)).toEqual(['-a', appPath, '--env', `CODEX_HOME=${codexHome}`])
    expect(plan.argv).toHaveLength(5)
    const url = new URL(plan.argv[4])
    expect(url.searchParams.get('path')).toBe(workspace)
    expect(url.hash).toBe('')
  })

  it.each([
    '',
    'Codex.app',
    '-a Codex.app',
    'C:\\Applications\\Codex.app',
    '/Applications/Codex',
    '/Applications/Codex.app/Contents/MacOS/ChatGPT',
    '/Applications/Codex\0.app',
    `/${'x'.repeat(32_768)}.app`,
  ])('rejects invalid macOS application path %#', (appPath) => {
    expect(() => buildMacosCodexAppLaunchPlan(appPath, os.tmpdir())).toThrow('应用路径无效')
  })

  it.each(['', 'relative/project', path.resolve(os.tmpdir(), 'project\0path'), path.resolve(os.tmpdir(), 'x'.repeat(32_768))])(
    'rejects invalid workspace path %#',
    (workspace) => {
      expect(() => buildMacosCodexAppLaunchPlan('/Applications/Codex.app', workspace))
        .toThrow('工作目录无效')
    },
  )

  it.each(['', 'relative/config', path.resolve(os.tmpdir(), 'config\0path'), path.resolve(os.tmpdir(), 'x'.repeat(32_768))])(
    'rejects invalid explicit Codex home %#',
    (codexHome) => {
      expect(() => buildMacosCodexAppLaunchPlan('/Applications/Codex.app', os.tmpdir(), codexHome))
        .toThrow('配置目录无效')
    },
  )
})

// Timeout routing is pure logic; the injected detector suite below also runs
// on every platform without invoking macOS system commands.
describe('resolveSystemCommandTimeoutMs', () => {
  it('gives a codesign --deep call the wide, deep-verification budget', () => {
    expect(resolveSystemCommandTimeoutMs('/usr/bin/codesign', [
      '--verify', '--strict', '--deep', '-R=anchor apple generic', '/Applications/Codex.app',
    ])).toBe(deepVerificationTimeoutMs)
  })

  it('keeps the other bundle-inspection probes on the narrow budget', () => {
    expect(resolveSystemCommandTimeoutMs('/usr/bin/plutil', [
      '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Applications/Codex.app/Contents/Info.plist',
    ])).toBe(commandTimeoutMs)
    expect(resolveSystemCommandTimeoutMs('/usr/sbin/sysctl', [
      '-n', 'hw.optional.arm64',
    ])).toBe(commandTimeoutMs)
    expect(resolveSystemCommandTimeoutMs('/usr/bin/mdfind', [
      'kMDItemCFBundleIdentifier == "com.openai.codex"',
    ])).toBe(commandTimeoutMs)
  })

  // Routing must key off the --deep flag itself, not just the executable name:
  // a codesign call that omits --deep is exactly as cheap as plutil or sysctl,
  // so it must not inherit the budget meant only for the deep bundle walk.
  it('keeps a non-deep codesign call on the narrow budget, not the deep-verification one', () => {
    expect(resolveSystemCommandTimeoutMs('/usr/bin/codesign', [
      '--verify', '--strict', '-R=anchor apple generic', '/Applications/Codex.app',
    ])).toBe(commandTimeoutMs)
  })
})

// Commands are injected on every platform. Only the real macOS runner case
// below needs Darwin; fixture execute bits are supplied on NTFS above.
describe('inspectMacosCodexApp', () => {
  it.each(['arm64', 'x64'] as const)('detects a universal Codex on %s without lipo or developer tools', async (architecture) => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    createApp(app, 0o755, ['arm64', 'x86_64'])
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil') return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })
    await expect(inspectMacosCodexApp({ architecture, homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand }))
      .resolves.toMatchObject({ app: { path: fs.realpathSync(app) }, detectionFailed: false, detectionError: null })
    expect(runSystemCommand.mock.calls.some(([executable]) => /lipo|xcrun|sysctl|\/arch$/.test(executable))).toBe(false)
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/codesign')).toBe(true)
  })

  it('detects native Codex from an x64 toolbox under Rosetta without Codex config files', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app, 0o755, ['arm64'])
    const homeDirectory = path.join(root, 'new-user')
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/sbin/sysctl') return '1\n'
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    await expect(inspectMacosCodexApp({ architecture: 'x64', homeDirectory, systemApplicationsDirectory, runSystemCommand }))
      .resolves.toEqual({ app: { path: fs.realpathSync(app), version: '26.727.51351', running: false }, detectionFailed: false, detectionError: null })
    expect(runSystemCommand).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/codesign')).toBe(true)
    expect(fs.existsSync(homeDirectory)).toBe(false)
  })

  it.each(['invalid', 'timeout', 'non-zero'] as const)('reports an inconclusive hardware probe (%s) instead of missing Codex', async (failure) => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    createApp(path.join(systemApplicationsDirectory, 'Codex.app'), 0o755, ['arm64'])
    createApp(path.join(systemApplicationsDirectory, 'ChatGPT.app'), 0o755, ['arm64'])
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/bin/plutil') return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : 'ChatGPT\n'
      if (executable === '/usr/sbin/sysctl') {
        if (failure === 'invalid') return 'unknown\n'
        throw commandRunnerError(failure === 'timeout' ? 'TIMED_OUT' : 'EXIT_NON_ZERO', 'sysctl failed')
      }
      if (executable === '/usr/bin/mdfind') return ''
      throw new Error(`unexpected command: ${executable}`)
    })

    const result = await inspectMacosCodexApp({ architecture: 'x64', homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand })
    expect(result).toMatchObject({ app: null, detectionFailed: true, detectionError: expect.stringContaining('无法确认 Mac 是否支持 arm64') })
    expect(runSystemCommand.mock.calls.filter(([executable]) => executable === '/usr/sbin/sysctl')).toHaveLength(1)
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/codesign')).toBe(false)
  })

  it.each([true, false])('checks Rosetta for an Intel Codex bundle from an arm64 toolbox (available: %s)', async (available) => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    createApp(app, 0o755, ['x86_64'])
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/bin/plutil') {
        if (argv.includes('CFBundleIdentifier')) return 'com.openai.codex\n'
        if (argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
        return '26.727.51351\n'
      }
      if (executable === '/usr/bin/arch') {
        if (!available) throw commandRunnerError('EXIT_NON_ZERO', 'Bad CPU type in executable')
        return ''
      }
      if (executable === '/usr/bin/codesign' || executable === '/usr/bin/mdfind') return ''
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    const result = await inspectMacosCodexApp({ architecture: 'arm64', homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand })
    if (available) expect(result).toMatchObject({ app: { path: fs.realpathSync(app) }, detectionFailed: false, detectionError: null })
    else expect(result).toMatchObject({ app: null, detectionFailed: true, detectionError: expect.stringContaining('Rosetta') })
    expect(runSystemCommand).toHaveBeenCalledWith('/usr/bin/arch', ['-x86_64', '/usr/bin/true'])
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/codesign')).toBe(available)
  })

  it('keeps a later compatible signed bundle when the hardware probe fails for an earlier candidate', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const nativeApp = path.join(systemApplicationsDirectory, 'Codex.app')
    const compatibleApp = path.join(systemApplicationsDirectory, 'ChatGPT.app')
    createApp(nativeApp, 0o755, ['arm64'])
    createApp(compatibleApp, 0o755, ['x86_64'])
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/bin/plutil') {
        if (argv.includes('CFBundleIdentifier')) return 'com.openai.codex\n'
        if (argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
        return '26.727.51351\n'
      }
      if (executable === '/usr/sbin/sysctl') throw commandRunnerError('TIMED_OUT', 'sysctl failed')
      if (executable === '/usr/bin/codesign') return ''
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    await expect(inspectMacosCodexApp({ architecture: 'x64', homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand }))
      .resolves.toMatchObject({ app: { path: fs.realpathSync(compatibleApp) }, detectionFailed: false, detectionError: null })
  })

  it.each(['EACCES', 'EPERM', 'EIO'])('preserves a bundle filesystem %s failure as failed detection', async (code) => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    createApp(app)
    const originalRealpath = fs.promises.realpath
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (...args: Parameters<typeof originalRealpath>) => {
      if (String(args[0]) === app) throw Object.assign(new Error(`bundle unavailable: ${code}`), { code })
      return originalRealpath(...args)
    }) as typeof originalRealpath)

    await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand: async () => '' }))
      .resolves.toEqual({ app: null, detectionFailed: true, detectionError: `bundle unavailable: ${code}` })
  })

  it('retains metadata permission failures instead of reporting an absent bundle', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const infoPath = createApp(path.join(systemApplicationsDirectory, 'Codex.app'))
    const originalLstat = fs.promises.lstat
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: Parameters<typeof originalLstat>) => {
      if (String(args[0]) === infoPath) throw Object.assign(new Error('Info.plist access denied'), { code: 'EACCES' })
      return originalLstat(...args)
    }) as typeof originalLstat)

    await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand: async () => '' }))
      .resolves.toEqual({ app: null, detectionFailed: true, detectionError: 'Info.plist access denied' })
  })

  it.each(['system', 'user'] as const)('finds a renamed, unindexed official bundle in the %s Applications directory', async (location) => {
    const root = temporaryDirectory()
    const homeDirectory = path.join(root, 'home')
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(location === 'system' ? systemApplicationsDirectory : path.join(homeDirectory, 'Applications'), 'Codex Personal.app')
    const infoPath = createApp(app)
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/mdfind') return ''
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    await expect(inspectMacosCodexApp({ homeDirectory, systemApplicationsDirectory, runSystemCommand }))
      .resolves.toMatchObject({ app: { path: fs.realpathSync(app) }, detectionFailed: false, detectionError: null })
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/codesign')).toBe(true)
  })

  it('still checks renamed bundles when Spotlight fails', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex Renamed.app')
    createApp(app)
    const runSystemCommand = async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/mdfind') throw new Error('Spotlight unavailable')
      if (executable === '/usr/bin/plutil') return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    }

    await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand }))
      .resolves.toMatchObject({ app: { path: fs.realpathSync(app) }, detectionFailed: false, detectionError: null })
  })

  it('reports an incomplete scan when Applications exceeds the directory bound', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    fs.mkdirSync(systemApplicationsDirectory)
    for (let index = 0; index < 513; index += 1) fs.writeFileSync(path.join(systemApplicationsDirectory, `item-${index}`), '')
    await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand: async () => '' }))
      .resolves.toEqual({ app: null, detectionFailed: true, detectionError: '应用目录条目过多，Codex 检测未能完成' })
  })

  it('stops probing unrelated applications after the discovery budget instead of claiming absence', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    createApp(path.join(systemApplicationsDirectory, 'First.app'))
    createApp(path.join(systemApplicationsDirectory, 'Second.app'))
    const runSystemCommand = vi.fn(async (executable: string) => {
      if (executable === '/usr/bin/mdfind') return ''
      if (executable === '/usr/bin/plutil') {
        vi.setSystemTime(Date.now() + 3_000)
        return 'com.example.unrelated\n'
      }
      throw new Error(`unexpected command: ${executable}`)
    })
    vi.useFakeTimers()
    try {
      await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand }))
        .resolves.toEqual({ app: null, detectionFailed: true, detectionError: '应用目录扫描达到时间上限，Codex 检测未能完成' })
      expect(runSystemCommand.mock.calls.filter(([executable]) => executable === '/usr/bin/plutil')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores unreadable unrelated application metadata in the fallback directory', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Unrelated.app')
    createApp(app)
    const originalRealpath = fs.promises.realpath
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (...args: Parameters<typeof originalRealpath>) => {
      if (String(args[0]) === app) throw Object.assign(new Error('unrelated app access denied'), { code: 'EACCES' })
      return originalRealpath(...args)
    }) as typeof originalRealpath)
    await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand: async () => '' }))
      .resolves.toEqual({ app: null, detectionFailed: false, detectionError: null })
  })

  it.each(['standard', 'spotlight', 'unrelated'] as const)('retains initial bundle identity read failures only for expected candidates (%s)', async (location) => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = location === 'spotlight'
      ? path.join(root, 'Custom Location', 'Renamed.app')
      : path.join(systemApplicationsDirectory, location === 'standard' ? 'Codex.app' : 'Unrelated.app')
    createApp(app)
    const runSystemCommand = vi.fn(async (executable: string) => {
      if (executable === '/usr/bin/mdfind') return location === 'spotlight' ? `${app}\n` : ''
      if (executable === '/usr/bin/plutil') throw commandRunnerError('EXIT_NON_ZERO', 'Info.plist contents unreadable')
      throw new Error(`unexpected command: ${executable}`)
    })
    await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand }))
      .resolves.toEqual({ app: null, detectionFailed: location !== 'unrelated', detectionError: location === 'unrelated' ? null : 'Info.plist contents unreadable' })
    expect(runSystemCommand.mock.calls.filter(([executable]) => executable === '/usr/bin/plutil')).toHaveLength(1)
  })

  it.each(['metadata', 'Mach-O'])('retains a %s rejection after the bundle identifies as Codex', async (failure) => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    createApp(app)
    if (failure === 'Mach-O') fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'ChatGPT'), Buffer.from([0xcf, 0xfa]))
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/bin/plutil' && argv.includes('CFBundleIdentifier')) return 'com.openai.codex\n'
      if (failure === 'metadata' && executable === '/usr/bin/plutil') throw commandRunnerError('EXIT_NON_ZERO', 'invalid bundle metadata')
      if (executable === '/usr/bin/plutil') return 'ChatGPT\n'
      if (executable === '/usr/bin/mdfind') return ''
      throw new Error(`unexpected command: ${executable}`)
    })
    await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand }))
      .resolves.toEqual({ app: null, detectionFailed: true, detectionError: failure === 'metadata' ? 'invalid bundle metadata' : expect.stringContaining('Mach-O') })
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/codesign')).toBe(false)
  })

  it('continues to reject a bundle whose executable has no execute bit', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    createApp(path.join(systemApplicationsDirectory, 'Codex.app'), 0o644)
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/bin/plutil') return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : 'ChatGPT\n'
      if (executable === '/usr/bin/mdfind') return ''
      throw new Error(`unexpected command: ${executable}`)
    })
    await expect(inspectMacosCodexApp({ homeDirectory: path.join(root, 'home'), systemApplicationsDirectory, runSystemCommand }))
      .resolves.toEqual({ app: null, detectionFailed: true, detectionError: '已找到 Codex，但应用的可执行文件类型或权限无效' })
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/codesign')).toBe(false)
  })

  it('rejects an otherwise official bundle that cannot run on the current architecture', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app, 0o755, ['arm64'])
    const options = {
      architecture: 'x64' as const,
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand: async (executable: string, argv: readonly string[]): Promise<string> => {
        if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
          if (argv.includes('CFBundleIdentifier')) return 'com.openai.codex\n'
          if (argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
          return '26.727.51351\n'
        }
        if (executable === '/usr/sbin/sysctl') return '0\n'
        if (executable === '/usr/bin/codesign') return ''
        if (executable === '/usr/bin/mdfind') return ''
        throw new Error(`unexpected command: ${executable}`)
      },
    }

    // An identified Codex with incompatible architecture must not offer the
    // user a misleading reinstall. It also remains unavailable for launching.
    await expect(inspectMacosCodexApp(options)).resolves.toEqual({
      app: null,
      detectionFailed: true,
      detectionError: '已找到 Codex，但应用架构与此 Mac 不兼容',
    })
  })

  it('rejects a forged app that only copies the Codex bundle identifier', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app)
    const options = {
      architecture: process.arch,
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand: async (executable: string, argv: readonly string[]): Promise<string> => {
        if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
          if (argv.includes('CFBundleIdentifier')) return 'com.openai.codex\n'
          if (argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
          return '26.727.51351\n'
        }
        if (executable === '/usr/bin/codesign') {
          // The forged bundle carries a different team's certificate, so the pinned
          // OpenAI requirement is not satisfied and codesign exits non-zero — the
          // one shape a caller may treat as a conclusive rejection rather than an
          // execution failure. See macos-code-signing.ts for why nothing it prints
          // may be read instead.
          throw commandRunnerError('EXIT_NON_ZERO', 'Command exited with code 1: codesign')
        }
        if (executable === '/usr/bin/mdfind') return ''
        throw new Error(`unexpected command: ${executable}`)
      },
    }

    // A forged identity never becomes launchable, and the failed signature
    // stays visible instead of appearing to be a missing installation.
    await expect(inspectMacosCodexApp(options)).resolves.toEqual({
      app: null,
      detectionFailed: true,
      detectionError: 'Command exited with code 1: codesign',
    })
  })

  it('returns the canonical standard application without invoking Spotlight', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const canonicalApp = path.join(root, 'Canonical Codex.app')
    const standardApp = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(canonicalApp)
    fs.mkdirSync(systemApplicationsDirectory, { recursive: true })
    fs.symlinkSync(canonicalApp, standardApp, process.platform === 'win32' ? 'junction' : 'dir')
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'true\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    await expect(inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand,
    })).resolves.toEqual({
      app: {
        path: fs.realpathSync(canonicalApp),
        version: '26.727.51351',
        running: true,
      },
      detectionFailed: false,
      detectionError: null,
    })
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/mdfind')).toBe(false)
  })

  it('recognizes the reported Intel ChatGPT.app Codex without config or Apple Silicon sysctl keys', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'ChatGPT.app')
    const homeDirectory = path.join(root, 'home')
    const infoPath = createApp(app, 0o755, ['x86_64'])
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/sbin/sysctl') throw commandRunnerError('EXIT_NON_ZERO', 'sysctl: unknown oid')
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.915.31029\n'
      }
      if (executable === '/usr/bin/osascript') return 'true\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    await expect(inspectMacosCodexApp({
      architecture: 'x64',
      homeDirectory,
      systemApplicationsDirectory,
      runSystemCommand,
    })).resolves.toEqual({
      app: { path: fs.realpathSync(app), version: '26.915.31029', running: true },
      detectionFailed: false,
      detectionError: null,
    })
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/mdfind')).toBe(false)
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/sbin/sysctl' || executable === '/usr/bin/arch')).toBe(false)
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/codesign')).toBe(true)
    expect(fs.existsSync(homeDirectory)).toBe(false)
  })

  it('rejects a wrong standard bundle identity and accepts a valid Spotlight fallback', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const standardApp = path.join(systemApplicationsDirectory, 'Codex.app')
    const spotlightApp = path.join(root, 'Search Results', 'Codex.app')
    const standardInfo = createApp(standardApp)
    const spotlightInfo = createApp(spotlightApp)
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/mdfind') return `${spotlightApp}\n`
      if (executable === '/usr/bin/plutil' && argv.at(-1) === standardInfo) {
        return argv.includes('CFBundleIdentifier') ? 'com.example.other\n' : '99.0.0\n'
      }
      if (executable === '/usr/bin/plutil' && argv.at(-1) === spotlightInfo) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    await expect(inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand,
    })).resolves.toEqual({
      app: {
        path: fs.realpathSync(spotlightApp),
        version: '26.727.51351',
        running: false,
      },
      detectionFailed: false,
      detectionError: null,
    })
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/mdfind')).toBe(true)
  })

  it('inspects canonical Spotlight duplicates only once before trying later candidates', async () => {
    const root = temporaryDirectory()
    const invalidApp = path.join(root, 'Search Results', 'Other.app')
    const duplicateAlias = path.join(root, 'Search Results', 'Duplicate.app')
    const validApp = path.join(root, 'Search Results', 'Codex.app')
    const invalidInfo = createApp(invalidApp)
    const validInfo = createApp(validApp)
    fs.symlinkSync(invalidApp, duplicateAlias, process.platform === 'win32' ? 'junction' : 'dir')
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/mdfind') return `${duplicateAlias}\n${invalidApp}\n${validApp}\n`
      if (executable === '/usr/bin/plutil' && argv.at(-1) === invalidInfo) return 'com.example.other\n'
      if (executable === '/usr/bin/plutil' && argv.at(-1) === validInfo) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'true\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    await expect(inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory: path.join(root, 'Applications'),
      runSystemCommand,
    })).resolves.toMatchObject({ app: { path: fs.realpathSync(validApp) } })
    expect(runSystemCommand.mock.calls.filter(([executable, argv]) => (
      executable === '/usr/bin/plutil'
      && (argv as readonly string[]).at(-1) === invalidInfo
      && (argv as readonly string[]).includes('CFBundleIdentifier')
    ))).toHaveLength(1)
  })

  it('keeps a valid application result when its short version is invalid', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app)
    const runSystemCommand = async (executable: string, argv: readonly string[]): Promise<string> => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : 'not-a-version\n'
      }
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    }

    await expect(inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand,
    })).resolves.toEqual({
      app: {
        path: fs.realpathSync(app),
        version: null,
        running: false,
      },
      detectionFailed: false,
      detectionError: null,
    })
  })

  it('rejects uppercase and mixed-case app suffixes from Spotlight', async () => {
    const root = temporaryDirectory()
    const uppercaseApp = path.join(root, 'Search Results', 'Codex.APP')
    const mixedCaseApp = path.join(root, 'Search Results', 'Codex.App')
    createApp(uppercaseApp)
    createApp(mixedCaseApp)
    const runSystemCommand = vi.fn(async (executable: string): Promise<string> => {
      if (executable === '/usr/bin/mdfind') return `${uppercaseApp}\n${mixedCaseApp}\n`
      if (executable === '/usr/bin/plutil') return 'com.openai.codex\n'
      throw new Error(`unexpected command: ${executable}`)
    })

    await expect(inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory: path.join(root, 'Applications'),
      runSystemCommand,
    })).resolves.toEqual({ app: null, detectionFailed: false, detectionError: null })
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/plutil')).toBe(false)
  })

  it('rejects malformed candidates without executing any command', async () => {
    const root = temporaryDirectory()
    const malformedCandidate = path.join(root, 'not-an-app')
    fs.mkdirSync(malformedCandidate)

    const result = await inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory: path.join(root, 'Applications'),
      runSystemCommand: async (executable) => {
        if (executable === '/usr/bin/mdfind') {
          return `relative.app\n${malformedCandidate}\n${path.join(root, 'broken.app')}\0suffix\n`
        }
        throw new Error('no metadata command should run for malformed candidates')
      },
    })

    expect(result).toEqual({ app: null, detectionFailed: false, detectionError: null })
  })

  it('confirms not installed, without executing any command, when Spotlight succeeds but finds nothing', async () => {
    const root = temporaryDirectory()

    const result = await inspectMacosCodexApp({
      // The NUL byte makes the home-directory candidate invalid input, rejected
      // before any command runs — distinct from a command that ran and failed.
      homeDirectory: `${root}\0home`,
      systemApplicationsDirectory: path.join(root, 'Applications'),
      runSystemCommand: async (executable) => {
        if (executable === '/usr/bin/mdfind') return ''
        throw new Error('no metadata command should run for an empty search')
      },
    })

    expect(result).toEqual({ app: null, detectionFailed: false, detectionError: null })
  })

  it('surfaces detectionFailed, not a confirmed absence, when Spotlight itself cannot be queried', async () => {
    const root = temporaryDirectory()

    // Neither standard directory exists on disk, so both are conclusively
    // rejected before any command runs; Spotlight is the only remaining way to
    // find a non-standard install, and here it cannot even be queried.
    const result = await inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory: path.join(root, 'Applications'),
      runSystemCommand: async () => {
        throw new Error('mdfind unavailable')
      },
    })

    expect(result).toEqual({
      app: null,
      detectionFailed: true,
      detectionError: 'mdfind unavailable',
    })
  })

  it('treats a codesign execution failure as detectionFailed, never as a rejected signature', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app)
    const runSystemCommand = async (executable: string, argv: readonly string[]): Promise<string> => {
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        if (argv.includes('CFBundleIdentifier')) return 'com.openai.codex\n'
        if (argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
        return '26.727.51351\n'
      }
      if (executable === '/usr/bin/codesign') {
        // A timeout is not codesign telling us the signature is bad — the
        // check simply never finished.
        throw commandRunnerError('TIMED_OUT', 'Command timed out: codesign')
      }
      if (executable === '/usr/bin/mdfind') return ''
      throw new Error(`unexpected command: ${executable}`)
    }

    const result = await inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand,
    })

    expect(result).toEqual({
      app: null,
      detectionFailed: true,
      detectionError: 'Command timed out: codesign',
    })
  })

  it('does not let an execution failure on one candidate block a definitive match on a later one', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const brokenApp = path.join(systemApplicationsDirectory, 'Codex.app')
    const brokenInfo = createApp(brokenApp)
    // codesign is invoked with the realpath-canonicalized bundle directory
    // (macos-codex-app.ts resolves every candidate before acting on it), which
    // on macOS can differ textually from the literal path below /tmp — match
    // on the same canonical form the production code actually sees.
    const brokenCanonical = fs.realpathSync(brokenApp)
    const homeDirectory = path.join(root, 'home')
    const validApp = path.join(homeDirectory, 'Applications', 'Codex.app')
    const validInfo = createApp(validApp)
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/bin/codesign' && argv.at(-1) === brokenCanonical) {
        throw commandRunnerError('SPAWN_FAILED', 'Failed to start command: codesign')
      }
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil' && argv.at(-1) === brokenInfo) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '1.0.0\n'
      }
      if (executable === '/usr/bin/plutil' && argv.at(-1) === validInfo) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable} ${argv.join(' ')}`)
    })

    const result = await inspectMacosCodexApp({
      homeDirectory,
      systemApplicationsDirectory,
      runSystemCommand,
    })

    // The confirmed match from ~/Applications wins outright; the earlier
    // execution failure on /Applications/Codex.app leaves no trace.
    expect(result).toEqual({
      app: {
        path: fs.realpathSync(validApp),
        version: '26.727.51351',
        running: false,
      },
      detectionFailed: false,
      detectionError: null,
    })
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/mdfind')).toBe(false)
  })

  // The default runner is what ships; every other case here injects a stub, so
  // without this the environment fix would be untested.
  it.runIf(process.platform === 'darwin')('does not hand inherited injection variables to the inspection commands', async () => {
    const previousInsert = process.env.DYLD_INSERT_LIBRARIES
    const previousNodeOptions = process.env.NODE_OPTIONS
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/xingmang-not-a-real.dylib'
    process.env.NODE_OPTIONS = '--require /tmp/xingmang-not-a-real.js'
    process.env.XINGMANG_APP_SENTINEL = 'ordinary-value'
    try {
      const environment = await runSystemCommand('/usr/bin/env', [])

      // The variables that decide what a child loads before it runs are gone...
      expect(environment).not.toContain('DYLD_INSERT_LIBRARIES')
      expect(environment).not.toContain('xingmang-not-a-real.dylib')
      expect(environment).not.toContain('NODE_OPTIONS')
      // ...while an ordinary variable still survives, proving the environment was
      // filtered rather than simply emptied.
      expect(environment).toContain('XINGMANG_APP_SENTINEL=ordinary-value')
    } finally {
      delete process.env.XINGMANG_APP_SENTINEL
      if (previousInsert === undefined) delete process.env.DYLD_INSERT_LIBRARIES
      else process.env.DYLD_INSERT_LIBRARIES = previousInsert
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
    }
  })
  it('verifies an unchanged bundle once across repeated scans', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app)
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })
    const scan = () => inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand,
    })

    for (let round = 0; round < 5; round += 1) {
      await expect(scan()).resolves.toMatchObject({ app: { version: '26.727.51351' } })
    }

    const codesignCalls = runSystemCommand.mock.calls
      .filter(([executable]) => executable === '/usr/bin/codesign')
    // Five scans, one deep verification. The cheap probes still run every time.
    expect(codesignCalls).toHaveLength(1)
  })

  it('verifies again once the bundle changes', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app)
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })
    const scan = () => inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand,
    })

    await scan()
    // Stand in for an upgrade: the signed executable is replaced.
    const executablePath = path.join(app, 'Contents', 'MacOS', 'ChatGPT')
    fs.writeFileSync(executablePath, Buffer.concat([machExecutable(), Buffer.from('updated resources')]), { mode: 0o755 })
    fs.utimesSync(executablePath, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000))
    await scan()

    const codesignCalls = runSystemCommand.mock.calls
      .filter(([executable]) => executable === '/usr/bin/codesign')
    // A cached pass must never outlive the bytes it was granted for.
    expect(codesignCalls).toHaveLength(2)
  })

  it('verifies again once the cached pass exceeds its bounded lifetime', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app)
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      const official = officialBundleCommand(executable, argv)
      if (official !== null) return official
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        return argv.includes('CFBundleIdentifier') ? 'com.openai.codex\n' : '26.727.51351\n'
      }
      if (executable === '/usr/bin/osascript') return 'false\n'
      throw new Error(`unexpected command: ${executable}`)
    })
    const scan = () => inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand,
    })

    vi.useFakeTimers()
    try {
      await scan()
      // The bundle and its signed executable are never touched here — only the clock
      // moves. A fingerprint match alone would keep trusting this pass forever, which
      // is the exact stale-cache mistake the bounded lifetime exists to avoid (the
      // Windows programFilesAclCache lesson T5 warns against repeating): a directory's
      // mtime does not follow edits nested deep inside it, so the fingerprint by itself
      // cannot be trusted to notice every change forever.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await scan()
    } finally {
      vi.useRealTimers()
    }

    const codesignCalls = runSystemCommand.mock.calls
      .filter(([executable]) => executable === '/usr/bin/codesign')
    expect(codesignCalls).toHaveLength(2)
  })

  it('does not cache a codesign execution failure, and retries it on the next scan', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app)
    let codesignCalls = 0
    const runSystemCommand = vi.fn(async (executable: string, argv: readonly string[]) => {
      if (executable === '/usr/bin/plutil' && argv.at(-1) === infoPath) {
        if (argv.includes('CFBundleIdentifier')) return 'com.openai.codex\n'
        if (argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
        return '26.727.51351\n'
      }
      if (executable === '/usr/bin/codesign') {
        codesignCalls += 1
        // Transient the first time (58818d0's contract: only a pass may be
        // cached), a clean pass the second — simulating the same bundle
        // recovering from a one-off timeout.
        if (codesignCalls === 1) throw commandRunnerError('TIMED_OUT', 'Command timed out: codesign')
        return ''
      }
      if (executable === '/usr/bin/mdfind') return ''
      throw new Error(`unexpected command: ${executable}`)
    })
    const scan = () => inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory,
      runSystemCommand,
    })

    await expect(scan()).resolves.toEqual({
      app: null,
      detectionFailed: true,
      detectionError: 'Command timed out: codesign',
    })
    await expect(scan()).resolves.toMatchObject({ app: { version: '26.727.51351' } })

    expect(codesignCalls).toBe(2)
  })
})

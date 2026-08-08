import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRunnerError, type CommandErrorCode } from './command-runner'
import {
  commandTimeoutMs,
  deepVerificationTimeoutMs,
  inspectMacosCodexApp,
  resetMacosCodexAppVerificationCache,
  resolveSystemCommandTimeoutMs,
  runSystemCommand,
} from './macos-codex-app'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-codex-app-'))
  temporaryDirectories.push(directory)
  return directory
}

function createApp(bundlePath: string): string {
  const infoPath = path.join(bundlePath, 'Contents', 'Info.plist')
  fs.mkdirSync(path.dirname(infoPath), { recursive: true })
  fs.writeFileSync(infoPath, '<plist/>')
  const executablePath = path.join(bundlePath, 'Contents', 'MacOS', 'ChatGPT')
  fs.mkdirSync(path.dirname(executablePath), { recursive: true })
  fs.writeFileSync(executablePath, 'test executable', { mode: 0o755 })
  return fs.realpathSync(infoPath)
}

// A resolving codesign stub stands for a bundle whose certificate chain satisfied the
// designated requirement. Its output is empty because no caller may read it any more.
function officialBundleCommand(executable: string, argv: readonly string[]): string | null {
  if (executable === '/usr/bin/plutil' && argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
  if (executable === '/usr/bin/lipo') return process.arch === 'x64' ? 'x86_64\n' : 'arm64\n'
  if (executable === '/usr/bin/codesign') return ''
  return null
}

/**
 * Builds the same shape `runCommand` throws for a given failure mode, so tests can
 * drive `inspectMacosCodexApp` through its two distinct error branches: a conclusive
 * EXIT_NON_ZERO rejection (codesign ran and said "no") versus every other code, which
 * means the command never produced an answer at all. See command-runner.ts for the
 * full set of codes this can carry.
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
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

// Pure string/array logic with no filesystem or process involvement, so unlike
// the rest of this file it needs no platform gate — this is the only coverage
// of the timeout split that runs on every platform, Windows included.
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
    expect(resolveSystemCommandTimeoutMs('/usr/bin/lipo', [
      '-archs', '/Applications/Codex.app/Contents/MacOS/ChatGPT',
    ])).toBe(commandTimeoutMs)
    expect(resolveSystemCommandTimeoutMs('/usr/bin/mdfind', [
      'kMDItemCFBundleIdentifier == "com.openai.codex"',
    ])).toBe(commandTimeoutMs)
  })

  // Routing must key off the --deep flag itself, not just the executable name:
  // a codesign call that omits --deep is exactly as cheap as plutil or lipo,
  // so it must not inherit the budget meant only for the deep bundle walk.
  it('keeps a non-deep codesign call on the narrow budget, not the deep-verification one', () => {
    expect(resolveSystemCommandTimeoutMs('/usr/bin/codesign', [
      '--verify', '--strict', '-R=anchor apple generic', '/Applications/Codex.app',
    ])).toBe(commandTimeoutMs)
  })
})

// Every case drives the bundle inspection through the injected
// runSystemCommand, so no real macOS toolchain is involved and the darwin gate
// cost Linux all coverage of Codex.app identification for nothing.
//
// Windows stays out, and not because of the file name: inspectMacosCodexApp
// requires an executable bit (`mode & 0o111`, macos-codex-app.ts:235), and NTFS
// reports 0o666 for every file no matter what mode writeFileSync or chmod is
// given. The function therefore returns null for every input there, so the
// cases expecting a rejection would pass even with the identification logic
// deleted. Fake coverage is worse than none, so gate on whether POSIX
// permission bits exist, which is the thing the logic actually depends on.
describe.runIf(process.platform !== 'win32')('inspectMacosCodexApp', () => {
  it('rejects an otherwise official bundle that cannot run on the current architecture', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const app = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(app)
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
        if (executable === '/usr/bin/lipo') return 'arm64\n'
        if (executable === '/usr/bin/codesign') return ''
        if (executable === '/usr/bin/mdfind') return ''
        throw new Error(`unexpected command: ${executable}`)
      },
    }

    // An architecture mismatch is a conclusive "not this bundle" answer, not a
    // failure to obtain one: the scan completed and confidently found nothing.
    await expect(inspectMacosCodexApp(options)).resolves.toEqual({
      app: null,
      detectionFailed: false,
      detectionError: null,
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
        if (executable === '/usr/bin/lipo') return process.arch === 'x64' ? 'x86_64\n' : 'arm64\n'
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

    // A real signature rejection stays conservative, exactly as before: not
    // detectionFailed, just confidently not a match.
    await expect(inspectMacosCodexApp(options)).resolves.toEqual({
      app: null,
      detectionFailed: false,
      detectionError: null,
    })
  })

  it('returns the canonical standard application without invoking Spotlight', async () => {
    const root = temporaryDirectory()
    const systemApplicationsDirectory = path.join(root, 'Applications')
    const canonicalApp = path.join(root, 'Canonical Codex.app')
    const standardApp = path.join(systemApplicationsDirectory, 'Codex.app')
    const infoPath = createApp(canonicalApp)
    fs.mkdirSync(systemApplicationsDirectory, { recursive: true })
    fs.symlinkSync(canonicalApp, standardApp)
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
    fs.symlinkSync(invalidApp, duplicateAlias)
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
      if (executable === '/usr/bin/lipo') return process.arch === 'x64' ? 'x86_64\n' : 'arm64\n'
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
    fs.writeFileSync(executablePath, 'replaced executable', { mode: 0o755 })
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
      if (executable === '/usr/bin/lipo') return process.arch === 'x64' ? 'x86_64\n' : 'arm64\n'
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

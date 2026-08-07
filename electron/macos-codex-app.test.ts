import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectMacosCodexApp } from './macos-codex-app'

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

function officialSignatureDetails(): string {
  return [
    'Identifier=com.openai.codex',
    'Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'TeamIdentifier=2DC432GLL2',
  ].join('\n')
}

function officialBundleCommand(executable: string, argv: readonly string[]): string | null {
  if (executable === '/usr/bin/plutil' && argv.includes('CFBundleExecutable')) return 'ChatGPT\n'
  if (executable === '/usr/bin/lipo') return process.arch === 'x64' ? 'x86_64\n' : 'arm64\n'
  if (executable === '/usr/bin/codesign') return argv.includes('-dv') ? officialSignatureDetails() : ''
  return null
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('inspectMacosCodexApp', () => {
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
        if (executable === '/usr/bin/codesign') {
          return argv.includes('-dv') ? officialSignatureDetails() : ''
        }
        if (executable === '/usr/bin/mdfind') return ''
        throw new Error(`unexpected command: ${executable}`)
      },
    }

    await expect(inspectMacosCodexApp(options)).resolves.toBeNull()
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
          return argv.includes('-dv')
            ? officialSignatureDetails().replaceAll('2DC432GLL2', 'AAAAAAAAAA')
            : ''
        }
        if (executable === '/usr/bin/mdfind') return ''
        throw new Error(`unexpected command: ${executable}`)
      },
    }

    await expect(inspectMacosCodexApp(options)).resolves.toBeNull()
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
      path: fs.realpathSync(canonicalApp),
      version: '26.727.51351',
      running: true,
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
      path: fs.realpathSync(spotlightApp),
      version: '26.727.51351',
      running: false,
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
    })).resolves.toMatchObject({ path: fs.realpathSync(validApp) })
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
      path: fs.realpathSync(app),
      version: null,
      running: false,
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
    })).resolves.toBeNull()
    expect(runSystemCommand.mock.calls.some(([executable]) => executable === '/usr/bin/plutil')).toBe(false)
  })

  it('returns no false positive for malformed candidates or command failures', async () => {
    const root = temporaryDirectory()
    const malformedCandidate = path.join(root, 'not-an-app')
    fs.mkdirSync(malformedCandidate)
    const malformed = await inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory: path.join(root, 'Applications'),
      runSystemCommand: async (executable) => {
        if (executable === '/usr/bin/mdfind') {
          return `relative.app\n${malformedCandidate}\n${path.join(root, 'broken.app')}\0suffix\n`
        }
        throw new Error('no metadata command should run for malformed candidates')
      },
    })
    const commandFailure = await inspectMacosCodexApp({
      homeDirectory: path.join(root, 'home'),
      systemApplicationsDirectory: path.join(root, 'Applications'),
      runSystemCommand: async () => {
        throw new Error('mdfind unavailable')
      },
    })
    const nulDirectory = await inspectMacosCodexApp({
      homeDirectory: `${root}\0home`,
      systemApplicationsDirectory: path.join(root, 'Applications'),
      runSystemCommand: async (executable) => {
        if (executable === '/usr/bin/mdfind') return ''
        throw new Error('no metadata command should run for an empty search')
      },
    })

    expect(malformed).toBeNull()
    expect(commandFailure).toBeNull()
    expect(nulDirectory).toBeNull()
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveDarwinCodexStandaloneSelection,
  verifyDarwinCodexStandaloneInstallation,
  type DarwinCodexCommandResult,
} from './macos-codex'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-standalone-'))
  temporaryDirectories.push(directory)
  return directory
}

function write(filePath: string, content = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function standaloneFixture(overrides: Record<string, unknown> = {}) {
  const home = temporaryDirectory()
  const codexHome = path.join(home, '.codex')
  const target = process.arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'
  const version = '0.146.0'
  const releaseRoot = path.join(codexHome, 'packages', 'standalone', 'releases', `${version}-${target}`)
  const executablePath = path.join(releaseRoot, 'bin', 'codex')
  const currentLink = path.join(codexHome, 'packages', 'standalone', 'current')
  const visibleCommand = path.join(home, '.local', 'bin', 'codex')
  write(executablePath, '#!/bin/sh\n')
  fs.chmodSync(executablePath, 0o700)
  write(path.join(releaseRoot, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version,
    target,
    variant: 'codex',
    entrypoint: 'bin/codex',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path',
    ...overrides,
  }))
  fs.mkdirSync(path.dirname(currentLink), { recursive: true })
  fs.symlinkSync(path.relative(path.dirname(currentLink), releaseRoot), currentLink)
  fs.mkdirSync(path.dirname(visibleCommand), { recursive: true })
  fs.symlinkSync(path.join(currentLink, 'bin', 'codex'), visibleCommand)
  return { codexHome, executablePath, home, releaseRoot, target, version, visibleCommand }
}

function officialResult(spec: { executable: string; argv: readonly string[] }): DarwinCodexCommandResult {
  if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '-dv') {
    return {
      stdout: '',
      stderr: [
        'Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
        'Authority=Developer ID Certification Authority',
        'Authority=Apple Root CA',
        'TeamIdentifier=2DC432GLL2',
      ].join('\n'),
    }
  }
  if (spec.argv[0] === '--version') return { stdout: 'codex-cli 0.146.0\n', stderr: '' }
  return { stdout: '', stderr: '' }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe.runIf(process.platform === 'darwin')('official Darwin Codex standalone trust', () => {
  it('binds the visible command to the manifest-selected release executable', () => {
    const fixture = standaloneFixture()

    const selection = resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })

    expect(selection).toMatchObject({
      codexHome: fs.realpathSync(fixture.codexHome),
      executablePath: fs.realpathSync(fixture.executablePath),
      releaseRoot: fs.realpathSync(fixture.releaseRoot),
      target: fixture.target,
      version: fixture.version,
    })
  })

  it('verifies the strict OpenAI signature and the manifest version', async () => {
    const fixture = standaloneFixture()
    const runCommand = vi.fn(async (spec: { executable: string; argv: readonly string[] }) => officialResult(spec))

    await expect(verifyDarwinCodexStandaloneInstallation({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
      runCommand,
    })).resolves.toMatchObject({ version: fixture.version })

    const specs = runCommand.mock.calls.map(([spec]) => spec)
    const stagedExecutable = specs[0]?.argv[2]
    expect(stagedExecutable).toEqual(expect.any(String))
    expect(stagedExecutable).not.toBe(fs.realpathSync(fixture.executablePath))
    expect(specs).toEqual([
      { executable: '/usr/bin/codesign', argv: ['--verify', '--strict', stagedExecutable!] },
      { executable: '/usr/bin/codesign', argv: ['-dv', '--verbose=4', stagedExecutable!] },
      { executable: stagedExecutable!, argv: ['--version'] },
    ])
    expect(fs.existsSync(path.dirname(stagedExecutable!))).toBe(false)
  })

  it.each([
    ['target', { target: 'x86_64-unknown-linux-musl' }],
    ['entrypoint', { entrypoint: '../codex' }],
    ['variant', { variant: 'other' }],
    ['layout', { layoutVersion: 2 }],
  ])('rejects a standalone manifest with the wrong %s', (_label, overrides) => {
    const fixture = standaloneFixture(overrides)
    expect(() => resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })).toThrow(/Codex standalone/)
  })

  it('rejects a binary outside the configured standalone releases root', () => {
    const fixture = standaloneFixture()
    const outside = path.join(fixture.home, 'outside', 'codex')
    write(outside, '#!/bin/sh\n')
    fs.chmodSync(outside, 0o700)

    expect(() => resolveDarwinCodexStandaloneSelection({
      executablePath: outside,
      env: { HOME: fixture.home },
    })).toThrow(/releases/)
  })

  it('rejects a standalone releases root redirected outside CODEX_HOME', () => {
    const fixture = standaloneFixture()
    const releasesRoot = path.join(fixture.codexHome, 'packages', 'standalone', 'releases')
    const outsideReleases = path.join(fixture.home, 'outside-releases')
    fs.renameSync(releasesRoot, outsideReleases)
    fs.symlinkSync(outsideReleases, releasesRoot)

    expect(() => resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })).toThrow(/releases/)
  })

  it('rejects a non-OpenAI signature and a mismatched runtime version', async () => {
    const fixture = standaloneFixture()
    const wrongSigner = async (spec: { executable: string; argv: readonly string[] }) => {
      const result = officialResult(spec)
      return { ...result, stderr: result.stderr.replaceAll('2DC432GLL2', 'AAAAAAAAAA') }
    }
    await expect(verifyDarwinCodexStandaloneInstallation({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
      runCommand: wrongSigner,
    })).rejects.toThrow(/Team ID/)

    await expect(verifyDarwinCodexStandaloneInstallation({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
      runCommand: async (spec) => spec.argv[0] === '--version'
        ? { stdout: 'codex-cli 0.145.0\n', stderr: '' }
        : officialResult(spec),
    })).rejects.toThrow(/version/)
  })

  it('rejects a canonical link swap during signature verification', async () => {
    const fixture = standaloneFixture()
    const currentLink = path.join(fixture.codexHome, 'packages', 'standalone', 'current')
    let swapped = false

    await expect(verifyDarwinCodexStandaloneInstallation({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
      runCommand: async (spec) => {
        if (!swapped) {
          swapped = true
          fs.unlinkSync(currentLink)
          fs.symlinkSync(path.join('releases', 'missing-release'), currentLink)
        }
        return officialResult(spec)
      },
    })).rejects.toThrow(/发生变化/)
  })
})

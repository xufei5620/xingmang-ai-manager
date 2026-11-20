import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DarwinCliProvenanceError } from './macos-code-signing'
import {
  OPENAI_PROVISIONED_CODEX_LAUNCHER,
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

/**
 * OpenAI's provisioned package as Mac acceptance R1 found it: unpacked by some other tool
 * under ~/.local/share/openchatcut-codex/<version>, with ~/.local/bin/codex an absolute
 * link to its bin/codex launcher. The file list mirrors
 * codex-provisioned-package-aarch64-apple-darwin.tar.gz of rust-v0.164.0-alpha.11.1.
 */
function provisionedFixture(location: 'relocated' | 'standalone' = 'relocated') {
  const home = temporaryDirectory()
  const codexHome = path.join(home, '.codex')
  const target = process.arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin'
  const version = '0.164.0-alpha.11.1'
  const releaseRoot = location === 'relocated'
    ? path.join(home, '.local', 'share', 'openchatcut-codex', version)
    : path.join(codexHome, 'packages', 'standalone', 'releases', `${version}-${target}`)
  const launcherPath = path.join(releaseRoot, 'bin', 'codex')
  const bundlePath = path.join(releaseRoot, 'CodexCLI.app')
  const executablePath = path.join(bundlePath, 'Contents', 'MacOS', 'codex')
  const visibleCommand = path.join(home, '.local', 'bin', 'codex')
  write(launcherPath, OPENAI_PROVISIONED_CODEX_LAUNCHER)
  fs.chmodSync(launcherPath, 0o755)
  write(path.join(releaseRoot, 'bin', 'codex-code-mode-host'), 'host')
  write(path.join(releaseRoot, 'codex-path', 'rg'), 'rg')
  write(executablePath, '#!/bin/sh\n')
  fs.chmodSync(executablePath, 0o755)
  write(path.join(bundlePath, 'Contents', 'Info.plist'), '<plist/>')
  write(path.join(bundlePath, 'Contents', 'embedded.provisionprofile'), 'profile')
  write(path.join(bundlePath, 'Contents', 'CodeResources'), 'ticket')
  write(path.join(bundlePath, 'Contents', '_CodeSignature', 'CodeResources'), 'seal')
  write(path.join(releaseRoot, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version,
    target,
    variant: 'codex',
    entrypoint: 'bin/codex',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path',
  }))
  fs.mkdirSync(path.dirname(visibleCommand), { recursive: true })
  fs.symlinkSync(launcherPath, visibleCommand)
  return { bundlePath, codexHome, executablePath, home, launcherPath, releaseRoot, target, version, visibleCommand }
}

function provisionedResult(spec: { executable: string; argv: readonly string[] }): DarwinCodexCommandResult {
  if (spec.argv[0] === '--version') return { stdout: 'codex-cli 0.164.0-alpha.11.1\n', stderr: '' }
  return { stdout: '', stderr: '' }
}

// codesign reports trust through its exit status, which runCommand surfaces by
// rejecting. A stub that resolves therefore stands for a signature that satisfied the
// designated requirement, and its output stays empty on purpose: no caller may read it.
function officialResult(spec: { executable: string; argv: readonly string[] }): DarwinCodexCommandResult {
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
    const stagedExecutable = specs[0]?.argv.at(-1)
    expect(stagedExecutable).toEqual(expect.any(String))
    expect(stagedExecutable).not.toBe(fs.realpathSync(fixture.executablePath))
    // The requirement is spelled out rather than imported so that weakening it — for
    // example dropping a Developer ID marker OID, or falling back to `anchor apple` —
    // fails here instead of silently agreeing with the implementation.
    expect(specs).toEqual([
      {
        executable: '/usr/bin/codesign',
        argv: [
          '--verify',
          '--strict',
          '-R=anchor apple generic'
            + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
            + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            + ' and certificate leaf[subject.OU] = "2DC432GLL2"',
          stagedExecutable!,
        ],
      },
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
    // codesign exits non-zero when the chain does not satisfy the requirement, and
    // runCommand turns that into a rejection. An ad-hoc signer can still print any
    // prose it likes on stdout/stderr; the stub returns some to prove it is ignored.
    const rejectedSigner = async (spec: { executable: string; argv: readonly string[] }) => {
      if (spec.executable === '/usr/bin/codesign') {
        throw new Error('test-requirement: code failed to satisfy specified code requirement(s)')
      }
      return officialResult(spec)
    }
    await expect(verifyDarwinCodexStandaloneInstallation({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
      runCommand: rejectedSigner,
    })).rejects.toThrow(/Developer ID/)

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

describe.runIf(process.platform === 'darwin')('official Darwin Codex provisioned package trust', () => {
  it('recognises the provisioned package another tool unpacked outside the releases root', () => {
    const fixture = provisionedFixture()

    const selection = resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })

    expect(selection).toMatchObject({
      requestedExecutablePath: fixture.visibleCommand,
      releaseRoot: fs.realpathSync(fixture.releaseRoot),
      executablePath: fs.realpathSync(fixture.executablePath),
      bundlePath: fs.realpathSync(fixture.bundlePath),
      launcherPath: fs.realpathSync(fixture.launcherPath),
      relocated: true,
      target: fixture.target,
      version: fixture.version,
    })
  })

  it('recognises the provisioned package inside the official releases root as not relocated', () => {
    const fixture = provisionedFixture('standalone')

    const selection = resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })

    expect(selection).toMatchObject({
      executablePath: fs.realpathSync(fixture.executablePath),
      launcherPath: fs.realpathSync(fixture.launcherPath),
      version: fixture.version,
    })
    expect(selection.relocated).toBeUndefined()
  })

  it('judges the signature of a private copy of the whole bundle and never runs the launcher', async () => {
    const fixture = provisionedFixture()
    const stagedTrees: string[][] = []
    const runCommand = vi.fn(async (spec: { executable: string; argv: readonly string[] }) => {
      if (spec.executable === '/usr/bin/codesign') {
        const stagedBundle = spec.argv.at(-1)!
        stagedTrees.push(fs.readdirSync(stagedBundle, { recursive: true }).map(String).sort())
      }
      return provisionedResult(spec)
    })

    await expect(verifyDarwinCodexStandaloneInstallation({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
      runCommand,
    })).resolves.toMatchObject({ version: fixture.version, relocated: true })

    const specs = runCommand.mock.calls.map(([spec]) => spec)
    const stagedBundle = specs[0]?.argv.at(-1)
    expect(stagedBundle).toEqual(expect.any(String))
    expect(path.basename(stagedBundle!)).toBe('CodexCLI.app')
    expect(stagedBundle).not.toBe(fs.realpathSync(fixture.bundlePath))
    // Spelled out for the same reason as the canonical package's requirement above, plus
    // the signing identifier the provisioned package keeps for its keychain ACLs.
    expect(specs).toEqual([
      {
        executable: '/usr/bin/codesign',
        argv: [
          '--verify',
          '--strict',
          '-R=identifier "codex"'
            + ' and anchor apple generic'
            + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
            + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            + ' and certificate leaf[subject.OU] = "2DC432GLL2"',
          stagedBundle!,
        ],
      },
      { executable: path.join(stagedBundle!, 'Contents', 'MacOS', 'codex'), argv: ['--version'] },
    ])
    // The provisioning profile has to travel with the binary; helpers outside the bundle do not.
    expect(stagedTrees).toEqual([[
      'Contents',
      path.join('Contents', 'CodeResources'),
      path.join('Contents', 'Info.plist'),
      path.join('Contents', 'MacOS'),
      path.join('Contents', 'MacOS', 'codex'),
      path.join('Contents', '_CodeSignature'),
      path.join('Contents', '_CodeSignature', 'CodeResources'),
      path.join('Contents', 'embedded.provisionprofile'),
    ].sort()])
    expect(specs.some((spec) => spec.executable === fixture.launcherPath)).toBe(false)
    expect(fs.existsSync(path.dirname(stagedBundle!))).toBe(false)
  })

  it('rejects a provisioned bundle that is not OpenAI-signed or reports another version', async () => {
    const fixture = provisionedFixture()

    await expect(verifyDarwinCodexStandaloneInstallation({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
      runCommand: async (spec) => {
        if (spec.executable === '/usr/bin/codesign') throw new Error('test-requirement: not satisfied')
        return provisionedResult(spec)
      },
    })).rejects.toBeInstanceOf(DarwinCliProvenanceError)

    await expect(verifyDarwinCodexStandaloneInstallation({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
      runCommand: async (spec) => spec.argv[0] === '--version'
        ? { stdout: 'codex-cli 0.163.0\n', stderr: '' }
        : provisionedResult(spec),
    })).rejects.toBeInstanceOf(DarwinCliProvenanceError)
  })

  it('rejects a relocated package whose launcher differs from OpenAI\'s by one line', () => {
    const fixture = provisionedFixture()
    fs.appendFileSync(fixture.launcherPath, 'echo extra\n')

    expect(() => resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })).toThrow(/启动脚本/)
  })

  it('rejects a canonical package outside the releases root', () => {
    const fixture = provisionedFixture()
    fs.rmSync(fixture.bundlePath, { recursive: true })
    fs.writeFileSync(fixture.launcherPath, 'binary')

    expect(() => resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })).toThrow(/provisioned/)
  })

  it('rejects a provisioned executable reached through a symbolic link', () => {
    const fixture = provisionedFixture()
    const elsewhere = path.join(fixture.home, 'elsewhere-codex')
    write(elsewhere, '#!/bin/sh\n')
    fs.chmodSync(elsewhere, 0o755)
    fs.rmSync(fixture.executablePath)
    fs.symlinkSync(elsewhere, fixture.executablePath)

    expect(() => resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })).toThrow(/符号链接/)
  })

  it('rejects a relocated manifest that names another architecture', () => {
    const fixture = provisionedFixture()
    const manifestPath = path.join(fixture.releaseRoot, 'codex-package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      target: fixture.target === 'aarch64-apple-darwin' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin',
    }))

    expect(() => resolveDarwinCodexStandaloneSelection({
      executablePath: fixture.visibleCommand,
      env: { HOME: fixture.home },
    })).toThrow(/manifest/)
  })
})

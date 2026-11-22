import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseStagedDarwinCli } from './darwin-cli-staging'
import { DarwinCliProvenanceError } from './macos-code-signing'
import {
  assertDarwinGrokCanonicalLinkReplaceable,
  captureDarwinGrokAgentLink,
  captureDarwinGrokCanonicalLink,
  ensureDarwinGrokAgentLink,
  inspectDarwinGrokVerifiedSelection,
  listDarwinGrokHistoricalQuarantineFiles,
  listDarwinGrokOrphanedDownloads,
  readDarwinGrokSelectionVersion,
  resolveDarwinGrokCanonicalSelection,
  restoreDarwinGrokAgentLink,
  restoreDarwinGrokCanonicalLink,
  runDarwinGrokPostInstallTransaction,
  stageDarwinGrokCanonicalSelection,
  verifyDarwinGrokUninstallPlan,
  verifyDarwinGrokCanonicalInstallation,
} from './macos-grok'

const temporaryDirectories: string[] = []

function createFixture(version = '0.2.118') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-grok-'))
  temporaryDirectories.push(home)
  const grokRoot = path.join(home, '.grok')
  const bin = path.join(grokRoot, 'bin')
  const downloads = path.join(grokRoot, 'downloads')
  const binary = path.join(downloads, `grok-${version}-macos-aarch64`)
  const canonicalLink = path.join(bin, 'grok')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(downloads, { recursive: true })
  fs.writeFileSync(binary, 'fixture binary', { mode: 0o700 })
  fs.symlinkSync(path.join('..', 'downloads', path.basename(binary)), canonicalLink)
  const aliasDirectory = path.join(home, '.local', 'bin')
  fs.mkdirSync(aliasDirectory, { recursive: true })
  const alias = path.join(aliasDirectory, 'grok')
  fs.symlinkSync(canonicalLink, alias)
  return { home, grokRoot, bin, downloads, binary, canonicalLink, alias }
}

/**
 * What xAI's install script builds since 2026-11 (cli/install.sh: `binary_path="$DOWNLOAD_DIR/grok-$platform"`):
 * one file without a version, and both `grok` and `agent` linked to it relatively.
 */
function createUnversionedFixture(arch: 'aarch64' | 'x86_64' = 'aarch64') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-grok-unversioned-'))
  temporaryDirectories.push(home)
  const grokRoot = path.join(home, '.grok')
  const bin = path.join(grokRoot, 'bin')
  const downloads = path.join(grokRoot, 'downloads')
  const binary = path.join(downloads, `grok-macos-${arch}`)
  const linkTarget = path.join('..', 'downloads', path.basename(binary))
  const canonicalLink = path.join(bin, 'grok')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(downloads, { recursive: true })
  fs.writeFileSync(binary, 'fixture binary', { mode: 0o700 })
  fs.symlinkSync(linkTarget, canonicalLink)
  fs.symlinkSync(linkTarget, path.join(bin, 'agent'))
  return { home, grokRoot, bin, downloads, binary, linkTarget, canonicalLink }
}

function commandRunner(options: { teamId?: string; version?: string } = {}) {
  const teamId = options.teamId ?? '5Y6N3AJ54S'
  const version = options.version ?? '0.2.118'
  return async (spec: { executable: string; argv: readonly string[] }) => {
    if (
      spec.executable === '/usr/bin/codesign'
      && spec.argv[0] === '--verify'
      && spec.argv[1] === '--strict'
    ) {
      // Stands in for codesign evaluating the certificate chain. `teamId` is who
      // actually signed this binary, so the requirement is satisfied only when it
      // names that same team; anything else exits non-zero the way codesign does.
      const requirement = spec.argv.find((argument) => argument.startsWith('-R=')) ?? ''
      if (!requirement.includes(`certificate leaf[subject.OU] = "${teamId}"`)) {
        throw new Error('test-requirement: code failed to satisfy specified code requirement(s)')
      }
      return { stdout: '', stderr: '' }
    }
    if (spec.executable !== '/usr/bin/codesign' && spec.argv.length === 1 && spec.argv[0] === '--version') {
      return { stdout: `grok ${version}\n`, stderr: '' }
    }
    throw new Error(`Unexpected Grok verification command: ${spec.executable} ${spec.argv.join(' ')}`)
  }
}

function directoryIdentity(directory: string) {
  const stats = fs.lstatSync(directory)
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid }
}

function regularFileIdentity(filePath: string) {
  const stats = fs.statSync(filePath, { bigint: true })
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe.runIf(process.platform === 'darwin')('macOS Grok canonical selection', () => {
  it('uses the canonical relative link version despite stale metadata and an official alias', () => {
    const fixture = createFixture()
    fs.writeFileSync(path.join(fixture.grokRoot, 'version.json'), '{"version":"0.2.111"}\n')

    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    const alias = resolveDarwinGrokCanonicalSelection(fixture.home, fixture.alias)

    expect(canonical.version).toBe('0.2.118')
    expect(alias).toEqual(canonical)
    expect(canonical.executablePath).toBe(fs.realpathSync(fixture.binary))
  })

  it('accepts xAI npm postinstall links named only with the release version', () => {
    const fixture = createFixture()
    const npmBinary = path.join(fixture.bin, 'grok-0.2.118')
    fs.renameSync(fixture.binary, npmBinary)
    fs.unlinkSync(fixture.canonicalLink)
    fs.symlinkSync(path.basename(npmBinary), fixture.canonicalLink)

    expect(resolveDarwinGrokCanonicalSelection(fixture.home)).toMatchObject({
      linkTarget: 'grok-0.2.118',
      version: '0.2.118',
      executablePath: fs.realpathSync(npmBinary),
    })
  })

  it.each([
    ['absolute link', (fixture: ReturnType<typeof createFixture>) => fs.symlinkSync(fixture.binary, fixture.canonicalLink)],
    ['outside Grok root', (fixture: ReturnType<typeof createFixture>) => {
      const outside = path.join(fixture.home, 'outside', 'grok-0.2.118-macos-aarch64')
      fs.mkdirSync(path.dirname(outside), { recursive: true })
      fs.writeFileSync(outside, 'outside', { mode: 0o700 })
      fs.symlinkSync(path.join('..', '..', 'outside', path.basename(outside)), fixture.canonicalLink)
    }],
    ['malformed versioned target', (fixture: ReturnType<typeof createFixture>) => {
      const target = path.join(fixture.downloads, 'grok-latest-macos-aarch64')
      fs.writeFileSync(target, 'bad', { mode: 0o700 })
      fs.symlinkSync(path.join('..', 'downloads', path.basename(target)), fixture.canonicalLink)
    }],
    ['non-regular target', (fixture: ReturnType<typeof createFixture>) => {
      const target = path.join(fixture.downloads, 'grok-0.2.118-macos-aarch64')
      fs.rmSync(target)
      fs.mkdirSync(target)
      fs.symlinkSync(path.join('..', 'downloads', path.basename(target)), fixture.canonicalLink)
    }],
  ])('rejects a %s', (_name, setup) => {
    const fixture = createFixture()
    fs.unlinkSync(fixture.canonicalLink)
    setup(fixture)

    expect(() => resolveDarwinGrokCanonicalSelection(fixture.home)).toThrow()
  })

  it('accepts only the exact xAI signature and selected version', async () => {
    const fixture = createFixture()
    const calls: Array<{ executable: string; argv: readonly string[] }> = []
    const sourceExecutable = fs.realpathSync(fixture.binary)
    await expect(verifyDarwinGrokCanonicalInstallation({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: async (spec) => {
        if (spec.executable === sourceExecutable || spec.argv.includes(sourceExecutable)) {
          throw new Error('source executable poison reached command runner')
        }
        calls.push(spec)
        return commandRunner()(spec)
      },
    })).resolves.toMatchObject({ version: '0.2.118' })
    const stagedExecutable = calls[0]?.argv.at(-1)
    expect(stagedExecutable).toEqual(expect.any(String))
    // Spelled out rather than imported, so weakening the requirement fails here.
    expect(calls).toEqual([
      {
        executable: '/usr/bin/codesign',
        argv: [
          '--verify',
          '--strict',
          '-R=anchor apple generic'
            + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
            + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            + ' and certificate leaf[subject.OU] = "5Y6N3AJ54S"',
          stagedExecutable!,
        ],
      },
      { executable: stagedExecutable!, argv: ['--version'] },
    ])
    expect(calls.at(-1)).toEqual({
      executable: stagedExecutable,
      argv: ['--version'],
    })
    expect(fs.existsSync(path.dirname(stagedExecutable!))).toBe(false)

    await expect(verifyDarwinGrokCanonicalInstallation({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: commandRunner({ teamId: 'WRONGTEAM' }),
    })).rejects.toThrow('Developer ID')
    await expect(verifyDarwinGrokCanonicalInstallation({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: commandRunner({ teamId: '5Y6N3AJ54S-extra' }),
    })).rejects.toThrow('Developer ID')
    await expect(verifyDarwinGrokCanonicalInstallation({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.119',
      runCommand: commandRunner(),
    })).rejects.toThrow('link version')
    await expect(verifyDarwinGrokCanonicalInstallation({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: commandRunner({ version: '0.2.117' }),
    })).rejects.toThrow('reported a version')
  })

  it('builds an uninstall plan only from verified official Grok links', async () => {
    const fixture = createFixture()
    const agentBinary = path.join(fixture.downloads, 'grok-0.2.111-macos-aarch64')
    const agentTarget = path.join('..', 'downloads', path.basename(agentBinary))
    fs.writeFileSync(agentBinary, 'agent binary', { mode: 0o700 })
    fs.symlinkSync(agentTarget, path.join(fixture.bin, 'agent'))

    const plan = await verifyDarwinGrokUninstallPlan({
      homeDirectory: fixture.home,
      runCommand: async (spec) => {
        if (spec.argv[0] === '--version' && path.basename(spec.executable) === 'agent') {
          return { stdout: 'grok 0.2.111\n', stderr: '' }
        }
        return commandRunner()(spec)
      },
    })

    expect(plan).toMatchObject({
      rootDirectory: fs.realpathSync(fixture.grokRoot),
      rootDirectoryIdentity: directoryIdentity(fixture.grokRoot),
      directory: fs.realpathSync(fixture.bin),
      directoryIdentity: directoryIdentity(fixture.bin),
      expectedSymbolicLinks: {
        grok: path.join('..', 'downloads', path.basename(fixture.binary)),
        agent: agentTarget,
      },
      expectedSymbolicLinkIdentities: {
        grok: expect.objectContaining({ dev: expect.anything(), ino: expect.anything() }),
        agent: expect.objectContaining({ dev: expect.anything(), ino: expect.anything() }),
      },
      expectedResolvedSymbolicLinkTargets: {
        grok: {
          path: fs.realpathSync(fixture.binary),
          identity: regularFileIdentity(fixture.binary),
        },
        agent: {
          path: fs.realpathSync(agentBinary),
          identity: regularFileIdentity(agentBinary),
        },
      },
      expectedOwnerUid: process.getuid?.(),
    })

    fs.unlinkSync(path.join(fixture.bin, 'agent'))
    const outside = path.join(fixture.home, 'outside', 'grok-0.2.111-macos-aarch64')
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, 'outside', { mode: 0o700 })
    fs.symlinkSync(path.join('..', '..', 'outside', path.basename(outside)), path.join(fixture.bin, 'agent'))
    await expect(verifyDarwinGrokUninstallPlan({
      homeDirectory: fixture.home,
      runCommand: commandRunner(),
    })).rejects.toThrow(/official uninstall layout|under ~\/\.grok|remain under/)
  })

  it('fails closed before command execution when the uninstall selection is replaced', async () => {
    const fixture = createFixture()
    const originalBin = path.join(fixture.grokRoot, 'bin-original')
    const alternateBinaryName = 'grok-0.2.118'
    const alternateBinary = path.join(fixture.bin, alternateBinaryName)
    const agentLink = path.join(fixture.bin, 'agent')
    let switched = false
    let restored = false
    const readlinkSync = fs.readlinkSync.bind(fs)
    vi.spyOn(fs, 'readlinkSync').mockImplementation((filePath, options) => {
      const target = readlinkSync(filePath, options as never)
      if (!switched && String(filePath) === fixture.canonicalLink) {
        switched = true
        fs.renameSync(fixture.bin, originalBin)
        fs.mkdirSync(fixture.bin)
        fs.writeFileSync(alternateBinary, 'alternate signed binary', { mode: 0o700 })
        fs.symlinkSync(alternateBinaryName, fixture.canonicalLink)
      }
      return target as never
    })
    const lstatSync = fs.lstatSync.bind(fs)
    vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, options) => {
      if (switched && !restored && String(filePath) === agentLink) {
        restored = true
        fs.rmSync(fixture.bin, { recursive: true, force: true })
        fs.renameSync(originalBin, fixture.bin)
      }
      return lstatSync(filePath, options as never) as never
    })
    const calls: Array<{ executable: string; argv: readonly string[] }> = []

    await expect(verifyDarwinGrokUninstallPlan({
      homeDirectory: fixture.home,
      runCommand: async (spec) => {
        calls.push(spec)
        return commandRunner()(spec)
      },
    })).rejects.toThrow('发生变化')

    expect(switched).toBe(true)
    expect(calls).toEqual([])
  })

  it('rejects a contained but unknown Grok uninstall link layout', async () => {
    const fixture = createFixture()
    const customDirectory = path.join(fixture.grokRoot, 'custom')
    const customBinary = path.join(customDirectory, 'grok-0.2.118-macos-aarch64')
    fs.mkdirSync(customDirectory)
    fs.writeFileSync(customBinary, 'custom layout', { mode: 0o700 })
    fs.unlinkSync(fixture.canonicalLink)
    fs.symlinkSync(path.join('..', 'custom', path.basename(customBinary)), fixture.canonicalLink)

    await expect(verifyDarwinGrokUninstallPlan({
      homeDirectory: fixture.home,
      runCommand: commandRunner(),
    })).rejects.toThrow('official uninstall layout')
    expect(fs.readlinkSync(fixture.canonicalLink)).toContain('custom')
    expect(fs.readFileSync(customBinary, 'utf8')).toBe('custom layout')
  })

  it.each(['grok root', 'bin directory'])('rejects a symlinked %s in the uninstall layout', async (component) => {
    const fixture = createFixture()
    if (component === 'grok root') {
      const realRoot = path.join(fixture.home, '.grok-real')
      fs.renameSync(fixture.grokRoot, realRoot)
      fs.symlinkSync(path.basename(realRoot), fixture.grokRoot)
    } else {
      const realBin = path.join(fixture.grokRoot, 'bin-real')
      fs.renameSync(fixture.bin, realBin)
      fs.symlinkSync(path.basename(realBin), fixture.bin)
    }

    await expect(verifyDarwinGrokUninstallPlan({
      homeDirectory: fixture.home,
      runCommand: commandRunner(),
    })).rejects.toThrow('plain owned directory')
  })

  it('rejects a canonical link switched after codesign verification', async () => {
    const fixture = createFixture()
    const replacement = path.join(fixture.downloads, 'grok-0.2.119-macos-aarch64')
    fs.writeFileSync(replacement, 'replacement binary', { mode: 0o700 })

    await expect(verifyDarwinGrokCanonicalInstallation({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: async (spec) => {
        if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '--verify') {
          fs.unlinkSync(fixture.canonicalLink)
          fs.symlinkSync(path.join('..', 'downloads', path.basename(replacement)), fixture.canonicalLink)
        }
        return commandRunner()(spec)
      },
    })).rejects.toThrow('发生变化')
  })

  it('rejects a canonical link rebuilt with the same target during verification', async () => {
    const fixture = createFixture()
    const target = fs.readlinkSync(fixture.canonicalLink)

    await expect(verifyDarwinGrokCanonicalInstallation({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: async (spec) => {
        if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '--verify') {
          fs.unlinkSync(fixture.canonicalLink)
          fs.symlinkSync(target, fixture.canonicalLink)
        }
        return commandRunner()(spec)
      },
    })).rejects.toThrow(/link identity|链接身份|发生变化/)
  })

  it('rejects a selected executable whose file identity changes during verification', async () => {
    const fixture = createFixture()

    await expect(verifyDarwinGrokCanonicalInstallation({
      homeDirectory: fixture.home,
      expectedVersion: '0.2.118',
      runCommand: async (spec) => {
        if (spec.executable === '/usr/bin/codesign' && spec.argv[0] === '--verify') {
          const replacement = path.join(fixture.downloads, 'replacement')
          fs.writeFileSync(replacement, 'fixture binary', { mode: 0o700 })
          fs.renameSync(replacement, fixture.binary)
        }
        return commandRunner()(spec)
      },
    })).rejects.toThrow('文件身份')
  })

  it('binds final service inspection to the verified real file and rejects identity changes', async () => {
    const fixture = createFixture()
    const selection = resolveDarwinGrokCanonicalSelection(fixture.home)
    let inspectedPath = ''

    await expect(inspectDarwinGrokVerifiedSelection({
      homeDirectory: fixture.home,
      selection,
      expectedVersion: '0.2.118',
      runCommand: commandRunner(),
      inspect: async (executablePath) => {
        inspectedPath = executablePath
        const replacement = path.join(fixture.downloads, 'inspection-replacement')
        fs.writeFileSync(replacement, 'fixture binary', { mode: 0o700 })
        fs.renameSync(replacement, fixture.binary)
        return { version: '0.2.118' }
      },
    })).rejects.toThrow('文件身份')
    expect(inspectedPath).not.toBe(fs.realpathSync(fixture.binary))
    expect(fs.existsSync(path.dirname(inspectedPath))).toBe(false)
  })

  it('restores a previous relative selection after a failed update', async () => {
    const fixture = createFixture('0.2.111')
    const snapshot = captureDarwinGrokCanonicalLink(fixture.home)
    const updated = path.join(fixture.downloads, 'grok-0.2.118-macos-aarch64')
    fs.writeFileSync(updated, 'updated', { mode: 0o700 })
    fs.unlinkSync(fixture.canonicalLink)
    fs.symlinkSync(path.join('..', 'downloads', path.basename(updated)), fixture.canonicalLink)

    await restoreDarwinGrokCanonicalLink(snapshot)

    expect(fs.readlinkSync(fixture.canonicalLink)).toBe('../downloads/grok-0.2.111-macos-aarch64')
  })

  it('removes only a newly created canonical link after a failed first install', async () => {
    const fixture = createFixture()
    fs.unlinkSync(fixture.canonicalLink)
    const snapshot = captureDarwinGrokCanonicalLink(fixture.home)
    fs.symlinkSync(path.join('..', 'downloads', path.basename(fixture.binary)), fixture.canonicalLink)

    await restoreDarwinGrokCanonicalLink(snapshot)

    expect(fs.existsSync(fixture.canonicalLink)).toBe(false)
    expect(fs.existsSync(fixture.binary)).toBe(true)
  })

  it('refuses to overwrite a non-symlink during rollback', async () => {
    const fixture = createFixture()
    const snapshot = captureDarwinGrokCanonicalLink(fixture.home)
    fs.unlinkSync(fixture.canonicalLink)
    fs.writeFileSync(fixture.canonicalLink, 'unrelated file')

    await expect(restoreDarwinGrokCanonicalLink(snapshot)).rejects.toThrow('non-symlink')
  })

  it('restores the prior selection when final service verification fails after lifecycle work', async () => {
    const fixture = createFixture('0.2.111')
    const updated = path.join(fixture.downloads, 'grok-0.2.118-macos-aarch64')
    fs.writeFileSync(updated, 'updated', { mode: 0o700 })

    await expect(runDarwinGrokPostInstallTransaction({
      homeDirectory: fixture.home,
      lifecycle: async () => {
        fs.unlinkSync(fixture.canonicalLink)
        fs.symlinkSync(path.join('..', 'downloads', path.basename(updated)), fixture.canonicalLink)
      },
      verify: async () => { throw new Error('service inspection rejected canonical selection') },
    })).rejects.toThrow('service inspection')

    expect(fs.readlinkSync(fixture.canonicalLink)).toBe('../downloads/grok-0.2.111-macos-aarch64')
  })

  it('removes a failed first-install canonical link when final service verification fails', async () => {
    const fixture = createFixture()
    fs.unlinkSync(fixture.canonicalLink)

    await expect(runDarwinGrokPostInstallTransaction({
      homeDirectory: fixture.home,
      lifecycle: async () => {
        fs.symlinkSync(path.join('..', 'downloads', path.basename(fixture.binary)), fixture.canonicalLink)
      },
      verify: async () => { throw new Error('service inspection rejected canonical selection') },
    })).rejects.toThrow('service inspection')

    expect(fs.existsSync(fixture.canonicalLink)).toBe(false)
    expect(fs.existsSync(fixture.binary)).toBe(true)
  })

  // internal #23: residual gap left by internal #16/#20's agent-link fixes.
  // inspectVerifiedDarwinGrokPostInstall (cli-install-service.ts) calls
  // ensureDarwinGrokAgentLink as the first step of the verify() this
  // transaction wraps, then goes on to codesign- and version-verify the
  // canonical selection. A failure in that *later* work used to roll back
  // only the canonical grok link, leaving the agent link ensureDarwinGrokAgentLink
  // had just created dangling with no working grok counterpart.
  it('removes an agent link created during a failed postinstall verification', async () => {
    const fixture = createFixture()
    const agentLink = path.join(fixture.bin, 'agent')
    expect(fs.existsSync(agentLink)).toBe(false)

    await expect(runDarwinGrokPostInstallTransaction({
      homeDirectory: fixture.home,
      lifecycle: async () => undefined,
      verify: async () => {
        const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
        await ensureDarwinGrokAgentLink(fixture.home, canonical)
        throw new Error('service inspection rejected canonical selection')
      },
    })).rejects.toThrow('service inspection')

    expect(fs.existsSync(agentLink)).toBe(false)
  })

  it('leaves a pre-existing agent link untouched after a failed postinstall verification', async () => {
    const fixture = createFixture()
    const staleBinary = path.join(fixture.downloads, 'grok-0.2.100-macos-aarch64')
    fs.writeFileSync(staleBinary, 'stale agent binary', { mode: 0o700 })
    const staleTarget = path.join('..', 'downloads', path.basename(staleBinary))
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(staleTarget, agentLink)

    await expect(runDarwinGrokPostInstallTransaction({
      homeDirectory: fixture.home,
      lifecycle: async () => undefined,
      verify: async () => { throw new Error('service inspection rejected canonical selection') },
    })).rejects.toThrow('service inspection')

    expect(fs.readlinkSync(agentLink)).toBe(staleTarget)
  })

  // 11-18 复核 D19：更新时 ensure 把 agent 挪到了新版，后面核对没过，grok 退回旧版，agent 也要跟着回去。
  it('puts an agent link moved during a failed update verification back on its previous version', async () => {
    const fixture = createFixture('0.2.100')
    const previousTarget = path.join('..', 'downloads', path.basename(fixture.binary))
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(previousTarget, agentLink)
    const updatedBinary = path.join(fixture.downloads, 'grok-0.2.118-macos-aarch64')
    const updatedTarget = path.join('..', 'downloads', path.basename(updatedBinary))

    await expect(runDarwinGrokPostInstallTransaction({
      homeDirectory: fixture.home,
      lifecycle: async () => {
        fs.writeFileSync(updatedBinary, 'updated binary', { mode: 0o700 })
        fs.unlinkSync(fixture.canonicalLink)
        fs.symlinkSync(updatedTarget, fixture.canonicalLink)
      },
      verify: async () => {
        const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
        await ensureDarwinGrokAgentLink(fixture.home, canonical)
        expect(fs.readlinkSync(agentLink)).toBe(updatedTarget)
        throw new Error('service inspection rejected canonical selection')
      },
    })).rejects.toThrow('service inspection')

    expect(fs.readlinkSync(fixture.canonicalLink)).toBe(previousTarget)
    expect(fs.readlinkSync(agentLink)).toBe(previousTarget)
  })
})

// internal #16: real hardware testing found the npm lifecycle script this app
// drives for darwin installs only ever (re)creates the `grok` link, never
// `agent`. These cover the install-side repair — a July install's leftover
// `agent` link masked the gap until a from-scratch reinstall had no such
// leftover to fall back on.
// Mac 验收 R1：xAI 安装脚本装的 Grok，文件名里不再带版本号，以前首页读不出版本、点「打开」也打不开。
describe.runIf(process.platform === 'darwin')('macOS Grok from the unversioned xAI install script layout', () => {
  it('accepts the layout and leaves the version to the verified binary', () => {
    const fixture = createUnversionedFixture()

    expect(resolveDarwinGrokCanonicalSelection(fixture.home)).toMatchObject({
      linkTarget: fixture.linkTarget,
      version: null,
      executablePath: fs.realpathSync(fixture.binary),
    })
    expect(resolveDarwinGrokCanonicalSelection(fixture.home, fixture.canonicalLink).version).toBeNull()
    expect(resolveDarwinGrokCanonicalSelection(createUnversionedFixture('x86_64').home).version).toBeNull()
  })

  it.each([
    ['the Linux file name', path.join('..', 'downloads', 'grok-linux-x86_64')],
    ['an architecture xAI does not name that way', path.join('..', 'downloads', 'grok-macos-arm64')],
    ['a file beside the link instead of under downloads', 'grok-macos-aarch64'],
    ['another directory under ~/.grok', path.join('..', 'custom', 'grok-macos-aarch64')],
  ])('still rejects %s', (_name, target) => {
    const fixture = createUnversionedFixture()
    const binary = path.resolve(fixture.bin, target)
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.writeFileSync(binary, 'look-alike', { mode: 0o700 })
    fs.unlinkSync(fixture.canonicalLink)
    fs.symlinkSync(target, fixture.canonicalLink)

    expect(() => resolveDarwinGrokCanonicalSelection(fixture.home)).toThrow('not an official versioned macOS binary')
  })

  it('reads the version only from a verified private copy and remembers it until the file changes', async () => {
    const fixture = createUnversionedFixture()
    const sourceExecutable = fs.realpathSync(fixture.binary)
    const calls: Array<{ executable: string; argv: readonly string[] }> = []
    const runCommand = async (spec: { executable: string; argv: readonly string[] }) => {
      if (spec.executable === sourceExecutable || spec.argv.includes(sourceExecutable)) {
        throw new Error('source executable poison reached command runner')
      }
      calls.push(spec)
      return commandRunner({ version: '1.0.89' })(spec)
    }

    const selection = resolveDarwinGrokCanonicalSelection(fixture.home)
    await expect(readDarwinGrokSelectionVersion({ homeDirectory: fixture.home, selection, runCommand }))
      .resolves.toBe('1.0.89')
    const stagedExecutable = calls[0]?.argv.at(-1)
    expect(stagedExecutable).toEqual(expect.any(String))
    expect(stagedExecutable).not.toBe(sourceExecutable)
    expect(calls).toEqual([
      expect.objectContaining({ executable: '/usr/bin/codesign', argv: expect.arrayContaining(['--verify', stagedExecutable]) }),
      { executable: stagedExecutable, argv: ['--version'] },
    ])
    expect(fs.existsSync(path.dirname(stagedExecutable!))).toBe(false)

    // A second scan of the same file does not copy and run it again.
    await expect(readDarwinGrokSelectionVersion({ homeDirectory: fixture.home, selection, runCommand }))
      .resolves.toBe('1.0.89')
    expect(calls).toHaveLength(2)

    // The script overwrites the same file on update; a new identity is checked again.
    fs.writeFileSync(fixture.binary, 'updated fixture binary', { mode: 0o700 })
    const updated = resolveDarwinGrokCanonicalSelection(fixture.home)
    await expect(readDarwinGrokSelectionVersion({
      homeDirectory: fixture.home,
      selection: updated,
      runCommand: async (spec) => {
        calls.push(spec)
        return commandRunner({ version: '1.0.90' })(spec)
      },
    })).resolves.toBe('1.0.90')
    expect(calls).toHaveLength(4)
  })

  it('answers a versioned link from its name without running anything', async () => {
    const fixture = createFixture()
    const runCommand = vi.fn(commandRunner())

    await expect(readDarwinGrokSelectionVersion({
      homeDirectory: fixture.home,
      selection: resolveDarwinGrokCanonicalSelection(fixture.home),
      runCommand,
    })).resolves.toBe('0.2.118')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([
    ['a binary xAI did not sign', commandRunner({ teamId: 'WRONGTEAM0' })],
    ['a binary that does not report a release', async (spec: { executable: string; argv: readonly string[] }) => (
      spec.argv[0] === '--version' ? { stdout: 'not grok\n', stderr: '' } : commandRunner()(spec)
    )],
  ])('refuses %s as somebody else\'s build and does not remember it', async (_name, runCommand) => {
    const fixture = createUnversionedFixture()
    const selection = resolveDarwinGrokCanonicalSelection(fixture.home)

    await expect(readDarwinGrokSelectionVersion({ homeDirectory: fixture.home, selection, runCommand }))
      .rejects.toBeInstanceOf(DarwinCliProvenanceError)
    await expect(readDarwinGrokSelectionVersion({ homeDirectory: fixture.home, selection, runCommand: commandRunner({ version: '1.0.89' }) }))
      .resolves.toBe('1.0.89')
  })

  it('stages it for opening with whatever release xAI signed, but never as a pinned release', async () => {
    const fixture = createUnversionedFixture()
    const selection = resolveDarwinGrokCanonicalSelection(fixture.home)

    const executable = await stageDarwinGrokCanonicalSelection({
      homeDirectory: fixture.home,
      selection,
      expectedVersion: null,
      runCommand: commandRunner({ version: '1.0.89' }),
      retention: 'ephemeral',
    })
    try {
      expect(executable).not.toBe(fs.realpathSync(fixture.binary))
      expect(fs.readFileSync(executable, 'utf8')).toBe('fixture binary')
    } finally {
      await releaseStagedDarwinCli(executable)
    }
    await expect(stageDarwinGrokCanonicalSelection({
      homeDirectory: fixture.home,
      selection,
      expectedVersion: null,
      runCommand: commandRunner({ teamId: 'WRONGTEAM0', version: '1.0.89' }),
      retention: 'ephemeral',
    })).rejects.toBeInstanceOf(DarwinCliProvenanceError)
    // An install that pinned a release never takes this layout as having installed it.
    await expect(inspectDarwinGrokVerifiedSelection({
      homeDirectory: fixture.home,
      selection,
      expectedVersion: '1.0.89',
      runCommand: commandRunner({ version: '1.0.89' }),
      inspect: async () => undefined,
    })).rejects.toThrow('link version')
  })

  it('puts the layout back when an install over it fails verification', async () => {
    const fixture = createUnversionedFixture()
    const npmBinary = path.join(fixture.bin, 'grok-1.0.77')
    fs.writeFileSync(npmBinary, 'npm binary', { mode: 0o700 })

    expect(captureDarwinGrokCanonicalLink(fixture.home)).toEqual({
      canonicalLinkPath: fixture.canonicalLink,
      existed: true,
      linkTarget: fixture.linkTarget,
    })
    expect(() => assertDarwinGrokCanonicalLinkReplaceable(fixture.home)).not.toThrow()
    await expect(runDarwinGrokPostInstallTransaction({
      homeDirectory: fixture.home,
      lifecycle: async () => {
        fs.unlinkSync(fixture.canonicalLink)
        fs.symlinkSync(path.basename(npmBinary), fixture.canonicalLink)
      },
      verify: async () => { throw new Error('service inspection rejected canonical selection') },
    })).rejects.toThrow('service inspection')

    expect(fs.readlinkSync(fixture.canonicalLink)).toBe(fixture.linkTarget)
  })

  it('still leaves uninstalling this layout to its own installer', async () => {
    const fixture = createUnversionedFixture()

    await expect(verifyDarwinGrokUninstallPlan({
      homeDirectory: fixture.home,
      runCommand: commandRunner({ version: '1.0.89' }),
    })).rejects.toThrow('official uninstall layout')
    expect(fs.readlinkSync(fixture.canonicalLink)).toBe(fixture.linkTarget)
  })
})

describe.runIf(process.platform === 'darwin')('assertDarwinGrokCanonicalLinkReplaceable', () => {
  it('lets an install start when nothing or an official link is in the way', () => {
    const fixture = createFixture()
    expect(() => assertDarwinGrokCanonicalLinkReplaceable(fixture.home)).not.toThrow()
    fs.unlinkSync(fixture.canonicalLink)
    expect(() => assertDarwinGrokCanonicalLinkReplaceable(fixture.home)).not.toThrow()
  })

  it.each([
    ['an absolute link', (fixture: ReturnType<typeof createFixture>) => fs.symlinkSync(fixture.binary, fixture.canonicalLink)],
    ['a plain file', (fixture: ReturnType<typeof createFixture>) => fs.writeFileSync(fixture.canonicalLink, 'hand-made', { mode: 0o700 })],
  ])('stops before downloading, in words the customer can act on, when %s is in the way', (_name, setup) => {
    const fixture = createFixture()
    fs.unlinkSync(fixture.canonicalLink)
    setup(fixture)

    expect(() => assertDarwinGrokCanonicalLinkReplaceable(fixture.home)).toThrow(
      '这台电脑上已经有一份 Grok CLI，不是用星芒装的。为了不弄坏它，已停止安装。请先用你原来装它的方式卸载，再回来点「使用星芒安装」。',
    )
  })
})

describe.runIf(process.platform === 'darwin')('ensureDarwinGrokAgentLink', () => {
  it('creates a sibling agent link pointing at the exact target the canonical grok link resolved to', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    const agentLink = path.join(fixture.bin, 'agent')
    expect(fs.existsSync(agentLink)).toBe(false)

    await ensureDarwinGrokAgentLink(fixture.home, canonical)

    expect(fs.lstatSync(agentLink).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(agentLink)).toBe(canonical.linkTarget)
    expect(fs.realpathSync(agentLink)).toBe(canonical.executablePath)
  })

  // 11-18 复核 D19：星芒更新或装回旧版时 npm 只改 grok，agent 以前一直指着第一次装的那一版。
  it('moves an agent link left on an older official version onto the version grok now selects', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    const staleBinary = path.join(fixture.downloads, 'grok-0.2.100-macos-aarch64')
    fs.writeFileSync(staleBinary, 'stale agent binary', { mode: 0o700 })
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(path.join('..', 'downloads', path.basename(staleBinary)), agentLink)

    await ensureDarwinGrokAgentLink(fixture.home, canonical)

    expect(fs.lstatSync(agentLink).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(agentLink)).toBe(canonical.linkTarget)
    expect(fs.realpathSync(agentLink)).toBe(canonical.executablePath)
    expect(fs.readdirSync(fixture.bin).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('moves an agent link still on the unversioned install script file onto a versioned grok', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    fs.writeFileSync(path.join(fixture.downloads, 'grok-macos-aarch64'), 'install script binary', { mode: 0o700 })
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(path.join('..', 'downloads', 'grok-macos-aarch64'), agentLink)

    await ensureDarwinGrokAgentLink(fixture.home, canonical)

    expect(fs.readlinkSync(agentLink)).toBe(canonical.linkTarget)
  })

  it('leaves an agent link aimed outside the official layouts untouched', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    const ownProgram = path.join(fixture.home, 'my-agent')
    fs.writeFileSync(ownProgram, 'mine', { mode: 0o700 })
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(ownProgram, agentLink)

    await ensureDarwinGrokAgentLink(fixture.home, canonical)

    expect(fs.readlinkSync(agentLink)).toBe(ownProgram)
  })

  it('does not rewrite an agent link that already matches grok', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(canonical.linkTarget, agentLink)
    const before = fs.lstatSync(agentLink, { bigint: true }).ino
    const rename = vi.spyOn(fs.promises, 'rename')

    await ensureDarwinGrokAgentLink(fixture.home, canonical)

    expect(rename).not.toHaveBeenCalled()
    expect(fs.lstatSync(agentLink, { bigint: true }).ino).toBe(before)
  })

  it('leaves a non-symlink occupying the agent path untouched instead of overwriting it', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    const agentLink = path.join(fixture.bin, 'agent')
    fs.writeFileSync(agentLink, 'not a symlink')

    await ensureDarwinGrokAgentLink(fixture.home, canonical)

    expect(fs.lstatSync(agentLink).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(agentLink, 'utf8')).toBe('not a symlink')
  })

  it('tolerates a concurrent creator winning the race instead of failing the install', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    vi.spyOn(fs.promises, 'symlink').mockImplementation(async () => {
      const error = new Error('EEXIST: file already exists, symlink') as NodeJS.ErrnoException
      error.code = 'EEXIST'
      throw error
    })

    await expect(ensureDarwinGrokAgentLink(fixture.home, canonical)).resolves.toBeUndefined()
  })

  it('propagates an unexpected symlink failure instead of silently continuing', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    vi.spyOn(fs.promises, 'symlink').mockImplementation(async () => {
      const error = new Error('EACCES: permission denied, symlink') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    })

    await expect(ensureDarwinGrokAgentLink(fixture.home, canonical)).rejects.toThrow('EACCES')
  })
})

// internal #23: a residual gap left by internal #16/#20's agent-link fixes —
// ensureDarwinGrokAgentLink runs inside the same postinstall verify() that
// runDarwinGrokPostInstallTransaction wraps, so a rollback triggered by a
// *later* verification failure used to leave the freshly created agent link
// behind; only the canonical grok link was ever snapshotted and restored.
// These cover the rollback primitives directly; the end-to-end scenario is
// covered by the "removes/leaves ... agent link" tests above, next to
// runDarwinGrokPostInstallTransaction's other rollback coverage.
describe.runIf(process.platform === 'darwin')('Darwin Grok agent link rollback', () => {
  it('captures existed: false when nothing occupies the agent link path', () => {
    const fixture = createFixture()

    expect(captureDarwinGrokAgentLink(fixture.home)).toEqual({
      agentLinkPath: path.join(fixture.bin, 'agent'),
      existed: false,
    })
  })

  it('captures existed: true when a link already occupies the agent link path', () => {
    const fixture = createFixture()
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(fixture.canonicalLink, agentLink)

    expect(captureDarwinGrokAgentLink(fixture.home)).toEqual({
      agentLinkPath: agentLink,
      existed: true,
      linkTarget: fixture.canonicalLink,
    })
  })

  it('captures a null target when something other than a link occupies the agent path', () => {
    const fixture = createFixture()
    const agentLink = path.join(fixture.bin, 'agent')
    fs.writeFileSync(agentLink, 'not a symlink')

    expect(captureDarwinGrokAgentLink(fixture.home)).toEqual({
      agentLinkPath: agentLink,
      existed: true,
      linkTarget: null,
    })
  })

  it('points a moved agent link back at the target it had before the transaction', async () => {
    const fixture = createFixture()
    const agentLink = path.join(fixture.bin, 'agent')
    const previousTarget = path.join('..', 'downloads', 'grok-0.2.100-macos-aarch64')
    fs.symlinkSync(previousTarget, agentLink)
    const snapshot = captureDarwinGrokAgentLink(fixture.home)
    fs.unlinkSync(agentLink)
    fs.symlinkSync(path.join('..', 'downloads', path.basename(fixture.binary)), agentLink)

    await restoreDarwinGrokAgentLink(snapshot)
    await restoreDarwinGrokAgentLink(snapshot)

    expect(fs.readlinkSync(agentLink)).toBe(previousTarget)
    expect(fs.readdirSync(fixture.bin).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('leaves a path that held a non-symlink before the transaction alone', async () => {
    const fixture = createFixture()
    const agentLink = path.join(fixture.bin, 'agent')
    fs.writeFileSync(agentLink, 'not a symlink')
    const snapshot = captureDarwinGrokAgentLink(fixture.home)

    await restoreDarwinGrokAgentLink(snapshot)

    expect(fs.readFileSync(agentLink, 'utf8')).toBe('not a symlink')
  })

  it('removes an agent link created after the snapshot recorded absence', async () => {
    const fixture = createFixture()
    const snapshot = captureDarwinGrokAgentLink(fixture.home)
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(fixture.canonicalLink, agentLink)

    await restoreDarwinGrokAgentLink(snapshot)

    expect(fs.existsSync(agentLink)).toBe(false)
  })

  it('is a no-op when the snapshot recorded absence and nothing was ever created', async () => {
    const fixture = createFixture()
    const snapshot = captureDarwinGrokAgentLink(fixture.home)

    await expect(restoreDarwinGrokAgentLink(snapshot)).resolves.toBeUndefined()

    expect(fs.existsSync(path.join(fixture.bin, 'agent'))).toBe(false)
  })

  it('leaves an agent link that already existed before the transaction untouched', async () => {
    const fixture = createFixture()
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(fixture.canonicalLink, agentLink)
    const snapshot = captureDarwinGrokAgentLink(fixture.home)

    await restoreDarwinGrokAgentLink(snapshot)

    expect(fs.readlinkSync(agentLink)).toBe(fixture.canonicalLink)
  })

  it('leaves a non-symlink occupying the agent path untouched instead of removing it', async () => {
    const fixture = createFixture()
    const snapshot = captureDarwinGrokAgentLink(fixture.home)
    const agentLink = path.join(fixture.bin, 'agent')
    fs.writeFileSync(agentLink, 'not a symlink')

    await restoreDarwinGrokAgentLink(snapshot)

    expect(fs.lstatSync(agentLink).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(agentLink, 'utf8')).toBe('not a symlink')
  })
})

// internal #18: ~/.grok/downloads accumulates one file per version this
// machine has ever had installed; real hardware testing found a 131 MB
// previous-version binary sitting there completely unmentioned anywhere in
// the app.
describe.runIf(process.platform === 'darwin')('listDarwinGrokOrphanedDownloads', () => {
  it('lists versioned binaries under downloads/ that no linked executable path references', () => {
    const fixture = createFixture()
    const orphanBinary = path.join(fixture.downloads, 'grok-0.2.100-macos-aarch64')
    fs.writeFileSync(orphanBinary, 'x'.repeat(2048), { mode: 0o700 })
    fs.writeFileSync(path.join(fixture.downloads, 'notes.txt'), 'not a versioned binary')

    const orphans = listDarwinGrokOrphanedDownloads(fixture.home, [fs.realpathSync(fixture.binary)])

    // The function reports realpath'd paths (matching resolveDarwinGrokCanonicalSelection's
    // convention) so comparisons stay correct even when $TMPDIR sits under a
    // symlinked ancestor, as /var does on real macOS.
    expect(orphans).toEqual([{ path: fs.realpathSync(orphanBinary), size: 2048 }])
  })

  it('excludes a versioned binary that is still referenced by a linked executable path', () => {
    const fixture = createFixture()

    const orphans = listDarwinGrokOrphanedDownloads(fixture.home, [fs.realpathSync(fixture.binary)])

    expect(orphans).toEqual([])
  })

  it('returns an empty list when the downloads directory does not exist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-grok-no-downloads-'))
    temporaryDirectories.push(home)

    expect(listDarwinGrokOrphanedDownloads(home, [])).toEqual([])
  })
})

// internal #20: darwin has no inode-bound unlink, so every Grok uninstall
// leaves its own renamed grok/agent symlink behind under ~/.grok/bin
// forever (see the retainedQuarantineFiles push in native-cli-uninstall.ts).
// Until this fix only the *current* uninstall's own quarantine files were
// ever surfaced anywhere in the app, so repeated install/uninstall cycles
// silently piled up invisible `.removing` clutter — this is what makes that
// backlog visible and safely deletable.
describe.runIf(process.platform === 'darwin')('listDarwinGrokHistoricalQuarantineFiles', () => {
  it('matches both a renamed-symlink and a locked-regular-file quarantine artifact by name alone', () => {
    const fixture = createFixture()
    const realBin = fs.realpathSync(fixture.bin)
    const grokQuarantineName = `.grok-${randomUUID()}.removing`
    const agentQuarantineName = `.agent-${randomUUID()}.removing`
    // The common shape: a renamed symlink, still resolving to its old target.
    fs.symlinkSync(path.join('..', 'downloads', path.basename(fixture.binary)), path.join(fixture.bin, grokQuarantineName))
    // uninstallVerifiedNativeCliFiles' rm-then-retain fallback: a locked
    // regular file that failed its final rm. Matched by name only — the
    // function is deliberately not restricted to symlinks (see its docstring).
    fs.writeFileSync(path.join(fixture.bin, agentQuarantineName), 'locked leftover')

    const matches = listDarwinGrokHistoricalQuarantineFiles(fixture.home)

    expect([...matches].sort()).toEqual([
      path.join(realBin, agentQuarantineName),
      path.join(realBin, grokQuarantineName),
    ].sort())
  })

  it('never includes a file or directory whose name does not exactly match the quarantine pattern', () => {
    const fixture = createFixture()
    const uuid = randomUUID()
    const decoyFileNames = [
      'grok', // the live command entry itself — no dot prefix, no suffix
      `.grok-${uuid}.removing.bak`, // extra trailing suffix
      `.grok-${uuid}.removed`, // wrong terminal word
      `.grok-not-a-uuid-not-a-uuid-not-a-uuid.removing`, // not 36 hex/dash characters
      `.claude-${uuid}.removing`, // this app's own pattern, but the wrong CLI's prefix
      `grok-${uuid}.removing`, // missing the leading dot
    ]
    for (const name of decoyFileNames) {
      fs.writeFileSync(path.join(fixture.bin, name), 'not a quarantine file')
    }
    // Same rule for directories: rm -f must never be pointed at one, so a
    // directory that happens to satisfy the name pattern must be excluded too.
    fs.mkdirSync(path.join(fixture.bin, `.agent-${randomUUID()}.removing`))

    expect(listDarwinGrokHistoricalQuarantineFiles(fixture.home)).toEqual([])
  })

  it('returns an empty list when ~/.grok/bin does not exist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-grok-no-bin-'))
    temporaryDirectories.push(home)

    expect(listDarwinGrokHistoricalQuarantineFiles(home)).toEqual([])
  })
})

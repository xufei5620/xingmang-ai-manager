import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureDarwinGrokCanonicalLink,
  ensureDarwinGrokAgentLink,
  inspectDarwinGrokVerifiedSelection,
  listDarwinGrokOrphanedDownloads,
  resolveDarwinGrokCanonicalSelection,
  restoreDarwinGrokCanonicalLink,
  runDarwinGrokPostInstallTransaction,
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
      expectedVersion: selection.version,
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
})

// internal #16: real hardware testing found the npm lifecycle script this app
// drives for darwin installs only ever (re)creates the `grok` link, never
// `agent`. These cover the install-side repair — a July install's leftover
// `agent` link masked the gap until a from-scratch reinstall had no such
// leftover to fall back on.
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

  it('leaves a pre-existing agent link untouched even when it points elsewhere', async () => {
    const fixture = createFixture()
    const canonical = resolveDarwinGrokCanonicalSelection(fixture.home)
    const staleBinary = path.join(fixture.downloads, 'grok-0.2.100-macos-aarch64')
    fs.writeFileSync(staleBinary, 'stale agent binary', { mode: 0o700 })
    const staleTarget = path.join('..', 'downloads', path.basename(staleBinary))
    const agentLink = path.join(fixture.bin, 'agent')
    fs.symlinkSync(staleTarget, agentLink)

    await ensureDarwinGrokAgentLink(fixture.home, canonical)

    expect(fs.readlinkSync(agentLink)).toBe(staleTarget)
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

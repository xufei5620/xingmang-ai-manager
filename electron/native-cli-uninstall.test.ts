import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uninstallVerifiedNativeCliFiles } from './native-cli-uninstall'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix = 'xingmang-native-uninstall-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function symbolicLinkIdentity(filePath: string) {
  const stats = fs.lstatSync(filePath, { bigint: true })
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    nlink: stats.nlink,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
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

describe('verified native CLI uninstall', () => {
  it('removes only declared files and preserves unrelated directory content', async () => {
    const directory = temporaryDirectory()
    fs.writeFileSync(path.join(directory, 'grok.exe'), 'grok')
    fs.writeFileSync(path.join(directory, 'agent.exe'), 'agent')
    fs.writeFileSync(path.join(directory, 'keep.txt'), 'keep')

    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok.exe', 'agent.exe'],
      label: 'Grok CLI',
      platform: process.platform,
    })

    expect(result.removedFiles).toEqual(['grok.exe', 'agent.exe'])
    expect(result.retainedQuarantineFiles).toEqual([])
    expect(result.directoryRemoved).toBe(false)
    expect(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('removes an empty native bin directory after the primary executable', async () => {
    const directory = temporaryDirectory()
    fs.writeFileSync(path.join(directory, 'claude.exe'), 'claude')

    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['claude.exe'],
      label: 'Claude Code',
      platform: process.platform,
      removeDirectoryWhenEmpty: true,
    })

    expect(result.directoryRemoved).toBe(true)
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('rejects nonstandard, linked and hard-linked targets without deleting them', async () => {
    const expected = temporaryDirectory()
    const other = temporaryDirectory()
    fs.writeFileSync(path.join(other, 'grok.exe'), 'grok')
    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: other,
      expectedDirectory: expected,
      fileNames: ['grok.exe'],
      label: 'Grok CLI',
      platform: process.platform,
    })).rejects.toThrow('非标准 Grok CLI 安装目录')
    expect(fs.existsSync(path.join(other, 'grok.exe'))).toBe(true)

    const hardLinkDirectory = temporaryDirectory()
    const executable = path.join(hardLinkDirectory, 'grok.exe')
    const secondLink = path.join(hardLinkDirectory, 'grok-copy.exe')
    fs.writeFileSync(executable, 'grok')
    fs.linkSync(executable, secondLink)
    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: hardLinkDirectory,
      expectedDirectory: hardLinkDirectory,
      fileNames: ['grok.exe'],
      label: 'Grok CLI',
      platform: process.platform,
    })).rejects.toThrow('单链接普通文件')
    expect(fs.existsSync(executable)).toBe(true)
    expect(fs.existsSync(secondLink)).toBe(true)
  })

  it('prevalidates optional helpers before removing the primary executable', async () => {
    const directory = temporaryDirectory()
    const executable = path.join(directory, 'grok.exe')
    const helper = path.join(directory, 'agent.exe')
    const helperLink = path.join(directory, 'agent-copy.exe')
    fs.writeFileSync(executable, 'grok')
    fs.writeFileSync(helper, 'agent')
    fs.linkSync(helper, helperLink)

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok.exe', 'agent.exe'],
      label: 'Grok CLI',
      platform: process.platform,
    })).rejects.toThrow('单链接普通文件')

    expect(fs.readFileSync(executable, 'utf8')).toBe('grok')
    expect(fs.readFileSync(helper, 'utf8')).toBe('agent')
  })

  it.runIf(process.platform === 'darwin')('removes only the planned official Grok links and preserves their versioned binaries', async () => {
    const home = temporaryDirectory()
    const grokRoot = path.join(home, '.grok')
    const bin = path.join(grokRoot, 'bin')
    const downloads = path.join(grokRoot, 'downloads')
    fs.mkdirSync(bin, { recursive: true })
    fs.mkdirSync(downloads, { recursive: true })
    const grokTarget = path.join(bin, 'grok-0.2.118')
    const agentTarget = path.join(downloads, 'grok-0.2.111-macos-aarch64')
    fs.writeFileSync(grokTarget, 'grok', { mode: 0o700 })
    fs.writeFileSync(agentTarget, 'agent', { mode: 0o700 })
    const grokLinkTarget = path.basename(grokTarget)
    const agentLinkTarget = path.join('..', 'downloads', path.basename(agentTarget))
    fs.symlinkSync(grokLinkTarget, path.join(bin, 'grok'))
    fs.symlinkSync(agentLinkTarget, path.join(bin, 'agent'))
    fs.writeFileSync(path.join(bin, 'keep.txt'), 'keep')

    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: bin,
      expectedDirectory: bin,
      fileNames: ['grok', 'agent'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: {
        grok: grokLinkTarget,
        agent: agentLinkTarget,
      },
      expectedSymbolicLinkIdentities: {
        grok: symbolicLinkIdentity(path.join(bin, 'grok')),
        agent: symbolicLinkIdentity(path.join(bin, 'agent')),
      },
      expectedOwnerUid: process.getuid?.(),
    })

    expect(result.removedFiles).toEqual(['grok', 'agent'])
    expect(result.retainedQuarantineFiles).toHaveLength(2)
    expect(result.retainedQuarantineFiles.every((filePath) => (
      path.dirname(filePath) === fs.realpathSync(bin)
      && path.basename(filePath).endsWith('.removing')
      && fs.lstatSync(filePath).isSymbolicLink()
    ))).toBe(true)
    expect(fs.existsSync(path.join(bin, 'grok'))).toBe(false)
    expect(fs.existsSync(path.join(bin, 'agent'))).toBe(false)
    expect(fs.readFileSync(grokTarget, 'utf8')).toBe('grok')
    expect(fs.readFileSync(agentTarget, 'utf8')).toBe('agent')
    expect(fs.readFileSync(path.join(bin, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it.runIf(process.platform === 'darwin')('rejects a planned Grok target replaced at the same path before uninstall starts', async () => {
    const grokRoot = temporaryDirectory()
    const bin = path.join(grokRoot, 'bin')
    const downloads = path.join(grokRoot, 'downloads')
    fs.mkdirSync(bin)
    fs.mkdirSync(downloads)
    const grokTarget = path.join(downloads, 'grok-0.2.118-macos-aarch64')
    const agentTarget = path.join(downloads, 'grok-0.2.111-macos-aarch64')
    fs.writeFileSync(grokTarget, 'grok', { mode: 0o700 })
    fs.writeFileSync(agentTarget, 'agent', { mode: 0o700 })
    const grokLinkTarget = path.join('..', 'downloads', path.basename(grokTarget))
    const agentLinkTarget = path.join('..', 'downloads', path.basename(agentTarget))
    const grokLink = path.join(bin, 'grok')
    const agentLink = path.join(bin, 'agent')
    fs.symlinkSync(grokLinkTarget, grokLink)
    fs.symlinkSync(agentLinkTarget, agentLink)
    const expectedResolvedSymbolicLinkTargets = {
      grok: { path: fs.realpathSync(grokTarget), identity: regularFileIdentity(grokTarget) },
      agent: { path: fs.realpathSync(agentTarget), identity: regularFileIdentity(agentTarget) },
    }
    const expectedSymbolicLinkIdentities = {
      grok: symbolicLinkIdentity(grokLink),
      agent: symbolicLinkIdentity(agentLink),
    }
    fs.unlinkSync(agentTarget)
    fs.writeFileSync(agentTarget, 'replacement', { mode: 0o700 })

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: bin,
      expectedDirectory: bin,
      expectedDirectoryIdentity: directoryIdentity(bin),
      fileNames: ['grok', 'agent'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: grokLinkTarget, agent: agentLinkTarget },
      expectedSymbolicLinkIdentities,
      expectedSymbolicLinkRootDirectory: fs.realpathSync(grokRoot),
      expectedSymbolicLinkRootDirectoryIdentity: directoryIdentity(grokRoot),
      expectedResolvedSymbolicLinkTargets,
      expectedOwnerUid: process.getuid?.(),
      removeDirectoryWhenEmpty: false,
    })).rejects.toThrow('目标')

    expect(fs.readlinkSync(grokLink)).toBe(grokLinkTarget)
    expect(fs.readlinkSync(agentLink)).toBe(agentLinkTarget)
  })

  it.runIf(process.platform === 'darwin')('restores every moved Grok link when an earlier target changes before quarantine commit finishes', async () => {
    const grokRoot = temporaryDirectory()
    const bin = path.join(grokRoot, 'bin')
    const downloads = path.join(grokRoot, 'downloads')
    fs.mkdirSync(bin)
    fs.mkdirSync(downloads)
    const grokTarget = path.join(downloads, 'grok-0.2.118-macos-aarch64')
    const agentTarget = path.join(downloads, 'grok-0.2.111-macos-aarch64')
    fs.writeFileSync(grokTarget, 'grok', { mode: 0o700 })
    fs.writeFileSync(agentTarget, 'agent', { mode: 0o700 })
    const grokLinkTarget = path.join('..', 'downloads', path.basename(grokTarget))
    const agentLinkTarget = path.join('..', 'downloads', path.basename(agentTarget))
    const grokLink = path.join(bin, 'grok')
    const agentLink = path.join(bin, 'agent')
    fs.symlinkSync(grokLinkTarget, grokLink)
    fs.symlinkSync(agentLinkTarget, agentLink)
    const expectedResolvedSymbolicLinkTargets = {
      grok: { path: fs.realpathSync(grokTarget), identity: regularFileIdentity(grokTarget) },
      agent: { path: fs.realpathSync(agentTarget), identity: regularFileIdentity(agentTarget) },
    }
    const expectedSymbolicLinkIdentities = {
      grok: symbolicLinkIdentity(grokLink),
      agent: symbolicLinkIdentity(agentLink),
    }
    let targetReplaced = false
    const canonicalBin = fs.realpathSync(bin)
    const rename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
      await rename(oldPath, newPath)
      if (
        !targetReplaced
        && path.dirname(String(oldPath)) === canonicalBin
        && path.basename(String(oldPath)) === 'agent'
      ) {
        targetReplaced = true
        fs.unlinkSync(grokTarget)
        fs.writeFileSync(grokTarget, 'replacement', { mode: 0o700 })
      }
    })

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: bin,
      expectedDirectory: bin,
      expectedDirectoryIdentity: directoryIdentity(bin),
      fileNames: ['grok', 'agent'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: grokLinkTarget, agent: agentLinkTarget },
      expectedSymbolicLinkIdentities,
      expectedSymbolicLinkRootDirectory: fs.realpathSync(grokRoot),
      expectedSymbolicLinkRootDirectoryIdentity: directoryIdentity(grokRoot),
      expectedResolvedSymbolicLinkTargets,
      expectedOwnerUid: process.getuid?.(),
      removeDirectoryWhenEmpty: false,
    })).rejects.toThrow('目标')

    expect(targetReplaced).toBe(true)
    expect(fs.readlinkSync(grokLink)).toBe(grokLinkTarget)
    expect(fs.readlinkSync(agentLink)).toBe(agentLinkTarget)
    expect(fs.readdirSync(bin).filter((name) => name.endsWith('.removing'))).toEqual([])
  })

  it.runIf(process.platform === 'darwin')('rejects a Grok link whose target differs from the verified uninstall plan', async () => {
    const directory = temporaryDirectory()
    const plannedTarget = 'grok-0.2.118'
    const actualTarget = 'grok-0.2.119'
    fs.writeFileSync(path.join(directory, actualTarget), 'unplanned', { mode: 0o700 })
    const link = path.join(directory, 'grok')
    fs.symlinkSync(actualTarget, link)

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: plannedTarget },
      expectedSymbolicLinkIdentities: { grok: symbolicLinkIdentity(link) },
      expectedOwnerUid: process.getuid?.(),
    })).rejects.toThrow('与卸载计划不一致')

    expect(fs.readlinkSync(link)).toBe(actualTarget)
    expect(fs.readFileSync(path.join(directory, actualTarget), 'utf8')).toBe('unplanned')
  })

  it.runIf(process.platform === 'darwin')('rejects a same-owner link rebuilt with the planned target after plan creation', async () => {
    const directory = temporaryDirectory()
    const target = 'grok-0.2.118'
    fs.writeFileSync(path.join(directory, target), 'official', { mode: 0o700 })
    const link = path.join(directory, 'grok')
    fs.symlinkSync(target, link)
    const plannedIdentity = symbolicLinkIdentity(link)
    fs.unlinkSync(link)
    fs.symlinkSync(target, link)

    const options = {
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok'],
      label: 'Grok CLI',
      platform: 'darwin' as const,
      expectedSymbolicLinks: { grok: target },
      expectedSymbolicLinkIdentities: { grok: plannedIdentity },
      expectedOwnerUid: process.getuid?.(),
    }
    await expect(uninstallVerifiedNativeCliFiles(options)).rejects.toThrow('身份')

    expect(fs.readlinkSync(link)).toBe(target)
    expect(fs.readFileSync(path.join(directory, target), 'utf8')).toBe('official')
  })

  it.runIf(process.platform === 'darwin')('does not delete a replacement swapped into quarantine after commit validation', async () => {
    const directory = temporaryDirectory()
    const target = 'grok-0.2.118'
    fs.writeFileSync(path.join(directory, target), 'official', { mode: 0o700 })
    const link = path.join(directory, 'grok')
    fs.symlinkSync(target, link)
    let replacementPath: string | null = null
    let quarantineReadCount = 0
    const readlink = fs.promises.readlink.bind(fs.promises)
    vi.spyOn(fs.promises, 'readlink').mockImplementation(async (filePath, options) => {
      const linkTarget = await readlink(filePath, options as never)
      const candidate = String(filePath)
      if (candidate.endsWith('.removing')) quarantineReadCount += 1
      if (!replacementPath && quarantineReadCount === 2) {
        replacementPath = candidate
        await fs.promises.unlink(candidate)
        await fs.promises.writeFile(candidate, 'attacker replacement')
      }
      return linkTarget as never
    })

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: target },
      expectedSymbolicLinkIdentities: { grok: symbolicLinkIdentity(link) },
      expectedOwnerUid: process.getuid?.(),
      removeDirectoryWhenEmpty: false,
    })).rejects.toThrow('隔离文件')

    expect(replacementPath).not.toBeNull()
    expect(fs.readFileSync(replacementPath!, 'utf8')).toBe('attacker replacement')
    expect(fs.readFileSync(path.join(directory, target), 'utf8')).toBe('official')
  })

  it.runIf(process.platform === 'darwin')('retains a quarantine path and never deletes its post-validation replacement by pathname', async () => {
    const grokRoot = temporaryDirectory()
    const bin = path.join(grokRoot, 'bin')
    const downloads = path.join(grokRoot, 'downloads')
    fs.mkdirSync(bin)
    fs.mkdirSync(downloads)
    const target = path.join(downloads, 'grok-0.2.118-macos-aarch64')
    fs.writeFileSync(target, 'official', { mode: 0o700 })
    const linkTarget = path.join('..', 'downloads', path.basename(target))
    const link = path.join(bin, 'grok')
    fs.symlinkSync(linkTarget, link)
    let quarantinePath: string | null = null
    let replacementInstalled = false
    const installReplacement = async () => {
      if (replacementInstalled || !quarantinePath) return
      replacementInstalled = true
      await fs.promises.unlink(quarantinePath)
      await fs.promises.writeFile(quarantinePath, 'external replacement')
    }
    const rename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
      await rename(oldPath, newPath)
      if (path.basename(String(oldPath)) === 'grok') quarantinePath = String(newPath)
    })
    const rm = fs.promises.rm.bind(fs.promises)
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (filePath, options) => {
      if (String(filePath) === quarantinePath) await installReplacement()
      return rm(filePath, options as never)
    })
    const rmdir = fs.promises.rmdir.bind(fs.promises)
    vi.spyOn(fs.promises, 'rmdir').mockImplementation(async (directoryPath, options) => {
      if (String(directoryPath) === fs.realpathSync(bin)) await installReplacement()
      return rmdir(directoryPath, options as never)
    })

    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: bin,
      expectedDirectory: bin,
      expectedDirectoryIdentity: directoryIdentity(bin),
      fileNames: ['grok'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: linkTarget },
      expectedSymbolicLinkIdentities: { grok: symbolicLinkIdentity(link) },
      expectedSymbolicLinkRootDirectory: fs.realpathSync(grokRoot),
      expectedSymbolicLinkRootDirectoryIdentity: directoryIdentity(grokRoot),
      expectedResolvedSymbolicLinkTargets: {
        grok: { path: fs.realpathSync(target), identity: regularFileIdentity(target) },
      },
      expectedOwnerUid: process.getuid?.(),
    })

    expect(replacementInstalled).toBe(true)
    expect(quarantinePath).not.toBeNull()
    expect(result.retainedQuarantineFiles).toEqual([quarantinePath])
    expect(fs.readFileSync(quarantinePath!, 'utf8')).toBe('external replacement')
    expect(fs.existsSync(link)).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('rejects a same-target quarantine link replacement even when numeric stats alias', async () => {
    const directory = temporaryDirectory()
    const target = 'grok-0.2.118'
    fs.writeFileSync(path.join(directory, target), 'official', { mode: 0o700 })
    const link = path.join(directory, 'grok')
    fs.symlinkSync(target, link)
    const plannedIdentity = symbolicLinkIdentity(link)
    const originalNumericStats = fs.lstatSync(link)
    let replacementPath: string | null = null
    let replaced = false
    const lstat = fs.promises.lstat.bind(fs.promises)
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (filePath, options) => {
      const stats = await lstat(filePath, options as never)
      const numericIdentityOnly = !(options as { bigint?: boolean } | undefined)?.bigint
      if (replaced && numericIdentityOnly && String(filePath) === replacementPath) {
        return originalNumericStats as never
      }
      return stats as never
    })
    const readlink = fs.promises.readlink.bind(fs.promises)
    vi.spyOn(fs.promises, 'readlink').mockImplementation(async (filePath, options) => {
      const linkTarget = await readlink(filePath, options as never)
      const candidate = String(filePath)
      if (!replaced && candidate.endsWith('.removing')) {
        replacementPath = candidate
        await fs.promises.unlink(candidate)
        await fs.promises.symlink(linkTarget, candidate)
        replaced = true
      }
      return linkTarget as never
    })

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: target },
      expectedSymbolicLinkIdentities: { grok: plannedIdentity },
      expectedOwnerUid: process.getuid?.(),
      removeDirectoryWhenEmpty: false,
    })).rejects.toThrow('回滚不完整')

    expect(replacementPath).not.toBeNull()
    expect(fs.readlinkSync(replacementPath!)).toBe(target)
    expect(fs.existsSync(link)).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('never restores a replaced quarantine entry to the original command path', async () => {
    const directory = temporaryDirectory()
    const grokTarget = 'grok-0.2.118'
    const agentTarget = 'grok-0.2.111-macos-aarch64'
    fs.writeFileSync(path.join(directory, grokTarget), 'grok', { mode: 0o700 })
    fs.writeFileSync(path.join(directory, agentTarget), 'agent', { mode: 0o700 })
    const grokLink = path.join(directory, 'grok')
    const agentLink = path.join(directory, 'agent')
    fs.symlinkSync(grokTarget, grokLink)
    fs.symlinkSync(agentTarget, agentLink)
    const expectedSymbolicLinkIdentities = {
      grok: symbolicLinkIdentity(grokLink),
      agent: symbolicLinkIdentity(agentLink),
    }
    let replacedQuarantinePath: string | null = null
    let helperValidationFailed = false
    const readlink = fs.promises.readlink.bind(fs.promises)
    vi.spyOn(fs.promises, 'readlink').mockImplementation(async (filePath, options) => {
      const target = await readlink(filePath, options as never)
      const candidate = String(filePath)
      if (candidate.includes('.grok-') && candidate.endsWith('.removing')) {
        replacedQuarantinePath = candidate
        await fs.promises.unlink(candidate)
        await fs.promises.writeFile(candidate, 'attacker replacement')
      } else if (
        !helperValidationFailed
        && candidate.includes('.agent-')
        && candidate.endsWith('.removing')
      ) {
        helperValidationFailed = true
        throw new Error('forced helper commit validation failure')
      }
      return target as never
    })

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok', 'agent'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: grokTarget, agent: agentTarget },
      expectedSymbolicLinkIdentities,
      expectedOwnerUid: process.getuid?.(),
      removeDirectoryWhenEmpty: false,
    })).rejects.toThrow('回滚不完整')

    expect(fs.existsSync(grokLink)).toBe(false)
    expect(replacedQuarantinePath).not.toBeNull()
    expect(fs.readFileSync(replacedQuarantinePath!, 'utf8')).toBe('attacker replacement')
    expect(fs.readlinkSync(agentLink)).toBe(agentTarget)
  })

  it.runIf(process.platform === 'darwin')('does not overwrite a dangling symlink that occupies the rollback command path', async () => {
    const directory = temporaryDirectory()
    const grokTarget = 'grok-0.2.118'
    const agentTarget = 'grok-0.2.111-macos-aarch64'
    fs.writeFileSync(path.join(directory, grokTarget), 'grok', { mode: 0o700 })
    fs.writeFileSync(path.join(directory, agentTarget), 'agent', { mode: 0o700 })
    const grokLink = path.join(directory, 'grok')
    const agentLink = path.join(directory, 'agent')
    fs.symlinkSync(grokTarget, grokLink)
    fs.symlinkSync(agentTarget, agentLink)
    const expectedSymbolicLinkIdentities = {
      grok: symbolicLinkIdentity(grokLink),
      agent: symbolicLinkIdentity(agentLink),
    }
    const occupiedTarget = 'missing-unrelated-target'
    let grokQuarantinePath: string | null = null
    let helperValidationFailed = false
    const readlink = fs.promises.readlink.bind(fs.promises)
    vi.spyOn(fs.promises, 'readlink').mockImplementation(async (filePath, options) => {
      const target = await readlink(filePath, options as never)
      const candidate = String(filePath)
      if (candidate.includes('.grok-') && candidate.endsWith('.removing')) {
        grokQuarantinePath = candidate
      } else if (
        !helperValidationFailed
        && candidate.includes('.agent-')
        && candidate.endsWith('.removing')
      ) {
        helperValidationFailed = true
        await fs.promises.symlink(occupiedTarget, grokLink)
        throw new Error('forced helper commit validation failure')
      }
      return target as never
    })

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok', 'agent'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: grokTarget, agent: agentTarget },
      expectedSymbolicLinkIdentities,
      expectedOwnerUid: process.getuid?.(),
      removeDirectoryWhenEmpty: false,
    })).rejects.toThrow('回滚不完整')

    expect(fs.readlinkSync(grokLink)).toBe(occupiedTarget)
    expect(grokQuarantinePath).not.toBeNull()
    expect(fs.readlinkSync(grokQuarantinePath!)).toBe(grokTarget)
    expect(fs.readlinkSync(agentLink)).toBe(agentTarget)
  })

  it.runIf(process.platform === 'darwin')('rejects a Grok link not owned by the verified uninstall-plan user', async () => {
    const directory = temporaryDirectory()
    const target = 'grok-0.2.118'
    fs.writeFileSync(path.join(directory, target), 'official', { mode: 0o700 })
    const link = path.join(directory, 'grok')
    fs.symlinkSync(target, link)
    const currentUid = process.getuid?.()
    if (currentUid === undefined) throw new Error('Darwin test requires process.getuid')

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: directory,
      expectedDirectory: directory,
      fileNames: ['grok'],
      label: 'Grok CLI',
      platform: 'darwin',
      expectedSymbolicLinks: { grok: target },
      expectedSymbolicLinkIdentities: { grok: symbolicLinkIdentity(link) },
      expectedOwnerUid: currentUid + 1,
    })).rejects.toThrow('所有者')

    expect(fs.readlinkSync(link)).toBe(target)
    expect(fs.readFileSync(path.join(directory, target), 'utf8')).toBe('official')
  })

  it.runIf(process.platform === 'win32')('rejects a directory junction replacement', async () => {
    const parent = temporaryDirectory()
    const target = temporaryDirectory()
    const junction = path.join(parent, 'bin')
    fs.writeFileSync(path.join(target, 'grok.exe'), 'grok')
    fs.symlinkSync(target, junction, 'junction')

    await expect(uninstallVerifiedNativeCliFiles({
      actualDirectory: junction,
      expectedDirectory: junction,
      fileNames: ['grok.exe'],
      label: 'Grok CLI',
      platform: 'win32',
    })).rejects.toThrow('安装目录被链接替换')
    expect(fs.existsSync(path.join(target, 'grok.exe'))).toBe(true)
  })
})

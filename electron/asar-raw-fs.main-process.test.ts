import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claudeDesktopBuildScript,
  claudeDesktopFixtureWinChecksum,
  claudeDesktopFixtureWorkspaceSha,
  writeAsarArchive,
  writeClaudeDesktopAsar,
} from './claude-desktop-asar.test-support'
import { createClaudeDesktopCodeSeeder, readClaudeCodeBuildPin, type ClaudeDesktopCodeSeederOptions } from './claude-desktop-code-seed'
import { readClaudeDesktopComponentManifest } from './claude-desktop-component-manifest'
import { createClaudeDesktopMacCodeSeeder } from './claude-desktop-mac-code-seed'
import { createClaudeDesktopWorkspaceSeeder } from './claude-desktop-workspace-seed'
import { inspectCodexDesktopLocale } from './codex-desktop-locale'

/*
 * Every module this file loads gets a node:fs that answers for `*.asar` files the way
 * Electron's asar layer does in the main process (lib/node/asar-fs-wrapper.ts, checked
 * against Electron 45 in asar-raw-fs.test.ts): stat says the archive is the package's root
 * folder, size 0, with a timestamp that stays the same for the whole process and a new inode
 * on every call; open fails with EISDIR. asarRawFs stands for Electron's original-fs and gets
 * the untouched fs. Paths inside an archive are never needed here and fall through.
 */
vi.mock('node:fs', async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof import('node:fs') }>()).default
  const { dirname } = await import('node:path')
  const fakeTime = new Date('2026-11-27T08:00:00Z')
  let inode = 0
  function isArchive(target: unknown): target is string {
    if (typeof target !== 'string' || !/\.asar$/i.test(target)) return false
    try { return real.statSync(target).isFile() }
    catch { return false }
  }
  function folderStats(archive: string): import('node:fs').Stats {
    inode += 1
    return Object.assign(real.statSync(dirname(archive)), { size: 0, mtimeMs: fakeTime.getTime(), mtime: fakeTime, ino: inode })
  }
  function isDirectoryError(archive: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`EISDIR: illegal operation on a directory,  in ${archive}`), { code: 'EISDIR' })
  }
  const promises = {
    ...real.promises,
    stat: (...args: Parameters<typeof real.promises.stat>) => isArchive(args[0]) ? Promise.resolve(folderStats(args[0])) : real.promises.stat(...args),
    lstat: (...args: Parameters<typeof real.promises.lstat>) => isArchive(args[0]) ? Promise.resolve(folderStats(args[0])) : real.promises.lstat(...args),
    open: (...args: Parameters<typeof real.promises.open>) => isArchive(args[0]) ? Promise.reject(isDirectoryError(args[0])) : real.promises.open(...args),
  }
  const patched = {
    ...real,
    promises,
    statSync: (...args: Parameters<typeof real.statSync>) => isArchive(args[0]) ? folderStats(args[0]) : real.statSync(...args),
    lstatSync: (...args: Parameters<typeof real.lstatSync>) => isArchive(args[0]) ? folderStats(args[0]) : real.lstatSync(...args),
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (isArchive(args[0])) throw isDirectoryError(args[0])
      return real.openSync(...args)
    },
  }
  return { ...patched, default: patched }
})

vi.mock('./asar-raw-fs', async () => {
  const real = (await vi.importActual<{ default: typeof import('node:fs') }>('node:fs')).default
  return { asarRawFs: () => real }
})

const storeClaude = 'C:\\Program Files\\WindowsApps\\Claude_6.28899.6.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'
const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-asar-main-process-'))
  temporaryRoots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function claudeInstall(root: string, version = '2.1.309'): string {
  const asar = path.join(root, 'Claude', 'app', 'resources', 'app.asar')
  fs.mkdirSync(path.dirname(asar), { recursive: true })
  writeClaudeDesktopAsar(asar, claudeDesktopBuildScript(version))
  return asar
}

/** Claude updating itself in place: a new pin, and a file whose size differs so the stamp can tell. */
function updateClaude(asar: string, version: string): void {
  writeClaudeDesktopAsar(asar, `${claudeDesktopBuildScript(version)}/*${'x'.repeat(4096)}*/`)
}

function unreachable(): Promise<Response> {
  return Promise.reject(new Error('no network in this test'))
}

function fullDisk(target: string) {
  return Promise.resolve({ availableBytes: 0, totalBytes: 1e12, measuredPath: target, deviceId: null })
}

describe('reading another app\'s app.asar in the Electron main process', () => {
  it('runs against a node:fs that refuses app.asar the way Electron\'s does', async () => {
    const asar = claudeInstall(temporaryRoot())

    await expect(fs.promises.open(asar, 'r')).rejects.toMatchObject({ code: 'EISDIR' })
    const first = await fs.promises.stat(asar)
    expect(first.isDirectory()).toBe(true)
    expect(first.size).toBe(0)
    updateClaude(asar, '2.1.310')
    expect((await fs.promises.stat(asar)).mtimeMs).toBe(first.mtimeMs)
  })

  it('reads the Claude Code pin the Windows seed needs', async () => {
    const asar = claudeInstall(temporaryRoot())

    expect(await readClaudeCodeBuildPin(asar, 'win32-x64')).toMatchObject({ version: '2.1.309', checksum: claudeDesktopFixtureWinChecksum })
  })

  it('reads both component manifests the Mac and workspace seeds need', async () => {
    const asar = claudeInstall(temporaryRoot())

    const manifest = await readClaudeDesktopComponentManifest(asar)

    expect(manifest.code?.version).toBe('2.1.309')
    expect(manifest.vm?.sha).toBe(claudeDesktopFixtureWorkspaceSha)
  })

  it('lets the Windows code seed find its Claude Code and notice when Claude updates', async () => {
    const root = temporaryRoot()
    const asar = claudeInstall(root)
    const profile = path.join(root, 'Claude-3p')
    for (const version of ['2.1.309', '2.1.310']) {
      const installDirectory = path.join(profile, 'claude-code', version, claudeDesktopFixtureWinChecksum.slice(0, 12))
      fs.mkdirSync(installDirectory, { recursive: true })
      fs.writeFileSync(path.join(installDirectory, 'claude.exe'), 'MZ')
      fs.writeFileSync(path.join(installDirectory, '.verified'), claudeDesktopFixtureWinChecksum)
    }
    const log = vi.fn<NonNullable<ClaudeDesktopCodeSeederOptions['log']>>()
    const seeder = createClaudeDesktopCodeSeeder({
      platform: 'win32',
      architecture: 'x64',
      executionMode: 'same-user',
      fetch: unreachable,
      userHome: root,
      pathModule: path,
      resolveAsarPath: () => asar,
      resolveProfileDirectory: async () => profile,
      readDiskSpace: async () => null,
      log,
    })
    const client = { path: storeClaude, running: false }

    // Before the fix: { status: 'skipped', reason: 'asar-unreadable' }, cause EISDIR.
    expect(await seeder.prepare(client)).toEqual({ status: 'present', version: '2.1.309' })
    updateClaude(asar, '2.1.310')
    // The cache stamp comes from the archive's real size and time, not the asar layer's constant ones.
    expect(await seeder.prepare(client)).toEqual({ status: 'present', version: '2.1.310' })
    expect(log.mock.calls.map(([, event]) => event)).not.toContain('claude-desktop.code-seed.skipped')
  })

  it('lets the workspace seed read its manifest and read it again when Claude updates', async () => {
    const root = temporaryRoot()
    const asar = claudeInstall(root)
    const readManifest = vi.fn(readClaudeDesktopComponentManifest)
    const seeder = createClaudeDesktopWorkspaceSeeder({
      platform: 'win32',
      executionMode: 'same-user',
      fetch: unreachable,
      resolveTarget: async () => ({ profileDirectory: path.join(root, 'Claude-3p'), asarPath: asar, architecture: 'x64' }),
      stateDirectory: path.join(root, 'state'),
      userHome: root,
      readManifest,
      readDiskSpace: fullDisk,
      pathModule: path,
    })

    // Got past the manifest to the disk check; before the fix this was 'asar-unreadable'.
    expect(await seeder.seed(storeClaude)).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(await seeder.seed(storeClaude)).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(readManifest).toHaveBeenCalledTimes(1)
    updateClaude(asar, '2.1.310')
    expect(await seeder.seed(storeClaude)).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(readManifest).toHaveBeenCalledTimes(2)
  })

  it('lets the Mac code seed read its manifest and read it again when Claude updates', async () => {
    const root = temporaryRoot()
    const asar = claudeInstall(root)
    const readManifest = vi.fn(readClaudeDesktopComponentManifest)
    const seeder = createClaudeDesktopMacCodeSeeder({
      platform: 'darwin',
      fetch: unreachable,
      resolveTarget: async () => ({ profileDirectory: path.join(root, 'Claude'), asarPath: asar, architecture: 'arm64' }),
      userHome: root,
      readManifest,
      readDiskSpace: fullDisk,
    })
    const client = { path: '/Applications/Claude.app', running: false }

    expect(await seeder.prepare(client)).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(await seeder.prepare(client)).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(readManifest).toHaveBeenCalledTimes(1)
    updateClaude(asar, '2.1.310')
    expect(await seeder.prepare(client)).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(readManifest).toHaveBeenCalledTimes(2)
  })

  it('reads the Codex desktop archive index even when the asar layer reports app.asar as a folder', () => {
    const root = temporaryRoot()
    const install = path.join(root, 'ChatGPT.app')
    const archive = path.join(install, 'Contents', 'Resources', 'app.asar')
    fs.mkdirSync(path.dirname(archive), { recursive: true })
    writeAsarArchive(archive, {
      'webview/assets/zh-CN-3727db380fd4.js': 'export default {}',
      'native-menu-locales/zh-CN.json': '{}',
      'package.json': '{}',
    })

    const status = inspectCodexDesktopLocale({
      codexHome: path.join(root, '.codex'), installed: true, version: '26.1007.71326',
      installDirectory: install, running: false, platform: 'darwin',
    })

    expect(status.chineseResources).toEqual({ available: true, frontendChunk: true, menuLocale: true, pakLocale: false, resourceRoot: archive })
  })
})

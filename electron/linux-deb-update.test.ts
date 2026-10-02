import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openWithSystemInstaller,
  readLinuxPackageType,
  resolveLinuxInstallMethod,
  resolveSystemPackageOpener,
  systemInstallerEnvironment,
  systemInstallerExitError,
  systemInstallerFailureMessage,
  type OpenerFileSystem,
} from './linux-deb-update'

const packagePath = '/home/tester/.cache/xingmang-ai-manager-updater/pending/XingMang-AI-Manager-1.1.0-linux-amd64.deb'

class FakeChild extends EventEmitter {
  unref = vi.fn()
}

function fakeSpawn(child: FakeChild) {
  return vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => child as unknown as ChildProcess)
}

function regularFile(overrides: Partial<fs.Stats> = {}): fs.Stats {
  return { isFile: () => true, nlink: 1, ...overrides } as fs.Stats
}

function stats(kind: 'file' | 'directory', uid: number, mode: number) {
  return { isFile: () => kind === 'file', isDirectory: () => kind === 'directory', uid, mode }
}

function openerFileSystem(entries: Record<string, ReturnType<typeof stats>>, links: Record<string, string> = {}): OpenerFileSystem {
  return {
    realpathSync: (target) => {
      const resolved = links[target] ?? target
      if (!entries[resolved]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return resolved
    },
    statSync: (target) => {
      const entry = entries[target]
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return entry
    },
  }
}

describe('linux install method', () => {
  it('reads the package-type marker electron-builder leaves in resources', () => {
    const read = vi.fn(() => 'deb\n')
    expect(readLinuxPackageType('/opt/xingmang-ai-manager/resources', read)).toBe('deb')
    expect(read).toHaveBeenCalledWith('/opt/xingmang-ai-manager/resources/package-type', 64, '安装方式标记')
    expect(readLinuxPackageType('/opt/x/resources', () => '  ')).toBeNull()
    expect(readLinuxPackageType('/opt/x/resources', () => { throw new Error('ENOENT') })).toBeNull()
  })

  it('self-updates only a packaged deb install', () => {
    expect(resolveLinuxInstallMethod({ isPackaged: true, packageType: 'deb' })).toBe('system-installer')
    expect(resolveLinuxInstallMethod({ isPackaged: true, packageType: null })).toBe('manual')
    expect(resolveLinuxInstallMethod({ isPackaged: true, packageType: 'rpm' })).toBe('manual')
    expect(resolveLinuxInstallMethod({ isPackaged: false, packageType: null })).toBe('system-installer')
  })
})

describe('system package opener', () => {
  it('uses xdg-open only from a root-owned location nobody else can rewrite', () => {
    const trusted = openerFileSystem({
      '/usr/bin/xdg-open': stats('file', 0, 0o100755),
      '/usr/bin': stats('directory', 0, 0o40755),
    }, { '/bin/xdg-open': '/usr/bin/xdg-open' })
    expect(resolveSystemPackageOpener(trusted)).toBe('/usr/bin/xdg-open')

    const userOwned = openerFileSystem({ '/usr/bin/xdg-open': stats('file', 1000, 0o100755), '/usr/bin': stats('directory', 0, 0o40755) })
    expect(resolveSystemPackageOpener(userOwned)).toBeNull()
    const worldWritable = openerFileSystem({ '/usr/bin/xdg-open': stats('file', 0, 0o100777), '/usr/bin': stats('directory', 0, 0o40755) })
    expect(resolveSystemPackageOpener(worldWritable)).toBeNull()
    const writableDirectory = openerFileSystem({ '/usr/bin/xdg-open': stats('file', 0, 0o100755), '/usr/bin': stats('directory', 0, 0o40775) })
    expect(resolveSystemPackageOpener(writableDirectory)).toBeNull()
  })

  it('falls back to /bin and refuses a link that leaves the trusted tree', () => {
    const fallback = openerFileSystem({ '/bin/xdg-open': stats('file', 0, 0o100755), '/bin': stats('directory', 0, 0o40755) })
    expect(resolveSystemPackageOpener(fallback)).toBe('/bin/xdg-open')
    const redirected = openerFileSystem({
      '/home/tester/xdg-open': stats('file', 1000, 0o100755),
      '/home/tester': stats('directory', 1000, 0o40755),
    }, { '/usr/bin/xdg-open': '/home/tester/xdg-open' })
    expect(resolveSystemPackageOpener(redirected)).toBeNull()
    expect(resolveSystemPackageOpener(openerFileSystem({}))).toBeNull()
  })

  it('keeps the desktop session but drops variables that would rewire a Node or Electron child', () => {
    const env = systemInstallerEnvironment({
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      PATH: '/usr/bin:/bin',
      NODE_OPTIONS: '--require /tmp/x.js',
      ELECTRON_RUN_AS_NODE: '1',
      UNDEFINED: undefined,
    })
    expect(env).toEqual({
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
      PATH: '/usr/bin:/bin',
    })
  })
})

describe('opening the package with the system installer', () => {
  afterEach(() => { vi.useRealTimers() })

  it('launches the opener with the package as a single argv entry and no shell, before returning', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const opening = openWithSystemInstaller({ packagePath, opener: '/usr/bin/xdg-open', env: { DISPLAY: ':0' }, spawn, lstat: () => regularFile() })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith('/usr/bin/xdg-open', [packagePath], { detached: true, stdio: 'ignore', env: { DISPLAY: ':0' }, shell: false })
    child.emit('exit', 0, null)
    await expect(opening).resolves.toBeUndefined()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('treats an opener still running after the settle window as an installer that came up', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const opening = openWithSystemInstaller({ packagePath, opener: '/usr/bin/xdg-open', env: {}, spawn: fakeSpawn(child), lstat: () => regularFile(), settleMs: 500 })
    await vi.advanceTimersByTimeAsync(500)
    await expect(opening).resolves.toBeUndefined()
    // A late failure after the handoff is swallowed rather than crashing the process.
    expect(() => child.emit('error', new Error('late'))).not.toThrow()
  })

  it.each([
    [2, 'UPDATE_PACKAGE_PATH_MISSING'],
    [3, 'UPDATE_SYSTEM_INSTALLER_MISSING'],
    [4, 'UPDATE_SYSTEM_INSTALLER_FAILED'],
    [1, 'UPDATE_SYSTEM_INSTALLER_FAILED'],
    [null, 'UPDATE_SYSTEM_INSTALLER_FAILED'],
  ])('maps opener exit code %s to %s', async (code, expected) => {
    const child = new FakeChild()
    const opening = openWithSystemInstaller({ packagePath, opener: '/usr/bin/xdg-open', env: {}, spawn: fakeSpawn(child), lstat: () => regularFile() })
    child.emit('exit', code, null)
    await expect(opening).rejects.toMatchObject({ code: expected })
    expect(systemInstallerExitError(code).code).toBe(expected)
  })

  it('reports a spawn error as a missing installer', async () => {
    const child = new FakeChild()
    const opening = openWithSystemInstaller({ packagePath, opener: '/usr/bin/xdg-open', env: {}, spawn: fakeSpawn(child), lstat: () => regularFile() })
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    await expect(opening).rejects.toMatchObject({ code: 'UPDATE_SYSTEM_INSTALLER_MISSING' })
  })

  it('refuses to hand over anything but a single-link regular .deb at an absolute path', async () => {
    const spawn = fakeSpawn(new FakeChild())
    const open = (target: string, lstat: (file: string) => fs.Stats = () => regularFile()) =>
      openWithSystemInstaller({ packagePath: target, opener: '/usr/bin/xdg-open', env: {}, spawn, lstat })
    await expect(open('relative/x.deb')).rejects.toMatchObject({ code: 'UPDATE_SYSTEM_INSTALLER_FAILED' })
    await expect(open('/tmp/x.AppImage')).rejects.toMatchObject({ code: 'UPDATE_SYSTEM_INSTALLER_FAILED' })
    await expect(open('/tmp/x\0.deb')).rejects.toMatchObject({ code: 'UPDATE_SYSTEM_INSTALLER_FAILED' })
    await expect(open(packagePath, () => { throw new Error('ENOENT') })).rejects.toMatchObject({ code: 'UPDATE_PACKAGE_PATH_MISSING' })
    await expect(open(packagePath, () => regularFile({ isFile: () => false }))).rejects.toMatchObject({ code: 'UPDATE_PACKAGE_PATH_MISSING' })
    await expect(open(packagePath, () => regularFile({ nlink: 2 }))).rejects.toMatchObject({ code: 'UPDATE_PACKAGE_PATH_MISSING' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('says no installer was found when there is no trusted opener', async () => {
    const spawn = fakeSpawn(new FakeChild())
    await expect(openWithSystemInstaller({ packagePath, opener: null, env: {}, spawn, lstat: () => regularFile() }))
      .rejects.toMatchObject({ code: 'UPDATE_SYSTEM_INSTALLER_MISSING' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('points at the opened folder only when it was actually opened', () => {
    expect(systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_FAILED', true)).toContain('双击里面的安装包')
    expect(systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_FAILED', false)).toContain('点「重新安装」')
    expect(systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_MISSING', true)).toContain('没找到能装 .deb')
    expect(systemInstallerFailureMessage('UPDATE_PACKAGE_PATH_MISSING', true)).toContain('重新下载')
  })

  it.runIf(process.platform !== 'win32')('runs a real opener process and reads its exit status', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-deb-'))
    try {
      const deb = path.join(directory, 'XingMang-AI-Manager-1.1.0-linux-amd64.deb')
      fs.writeFileSync(deb, 'deb')
      const failing = path.join(directory, 'opener-fails')
      fs.writeFileSync(failing, '#!/bin/sh\nexit 4\n', { mode: 0o755 })
      await expect(openWithSystemInstaller({ packagePath: deb, opener: failing, env: { PATH: '/usr/bin:/bin' } }))
        .rejects.toMatchObject({ code: 'UPDATE_SYSTEM_INSTALLER_FAILED' })
      const record = path.join(directory, 'argv.txt')
      const succeeding = path.join(directory, 'opener-ok')
      fs.writeFileSync(succeeding, `#!/bin/sh\nprintf '%s' "$1" > '${record}'\nexit 0\n`, { mode: 0o755 })
      await openWithSystemInstaller({ packagePath: deb, opener: succeeding, env: { PATH: '/usr/bin:/bin' } })
      expect(fs.readFileSync(record, 'utf8')).toBe(deb)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

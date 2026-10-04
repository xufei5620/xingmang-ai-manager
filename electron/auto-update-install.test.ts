import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BACKGROUND_RELAUNCH_WINDOW_MS,
  LAUNCH_INSTALL_WINDOW_MS,
  buildAutoInstallNotice,
  canInstallUnattended,
  createPendingUpdateStore,
  decideLaunchInstall,
  decideQuitInstall,
  isRelaunchAfterBackgroundInstall,
  previousAutoInstallFailureMessage,
  resolveLaunchInstallMode,
  resolvePreviousAutoInstallFailure,
  emptyPendingUpdateRecord,
  parsePendingUpdateRecord,
  quitInstallPrompt,
  resolveDownloadedVersionToRecord,
  undoQuitInstallAttempt,
  type LaunchInstallInput,
  type LaunchInstallModeInput,
} from './auto-update-install'
import type { UpdateSnapshot } from './updater'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function snapshot(patch: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'downloaded',
    currentVersion: '0.2.11',
    availableVersion: '0.2.12',
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development: false,
    ...patch,
  }
}

function input(patch: Partial<LaunchInstallInput> = {}): LaunchInstallInput {
  return {
    autoUpdate: true,
    snapshot: snapshot(),
    recordAtLaunch: { downloadedVersion: '0.2.12', attemptedVersion: null },
    elapsedSinceLaunchMs: 5_000,
    busy: false,
    ...patch,
  }
}

describe('decideLaunchInstall', () => {
  it('installs a version that was already downloaded before this launch', () => {
    expect(decideLaunchInstall(input())).toBe('0.2.12')
  })

  it('leaves a version downloaded during this session for the quit path', () => {
    expect(decideLaunchInstall(input({ recordAtLaunch: { ...emptyPendingUpdateRecord } }))).toBeNull()
    expect(decideLaunchInstall(input({ recordAtLaunch: { downloadedVersion: '0.2.11', attemptedVersion: null } }))).toBeNull()
  })

  it('tries each version at launch only once so a broken installer cannot loop', () => {
    expect(decideLaunchInstall(input({ recordAtLaunch: { downloadedVersion: '0.2.12', attemptedVersion: '0.2.12' } }))).toBeNull()
  })

  it('does not interrupt someone who is already using the app', () => {
    expect(decideLaunchInstall(input({ elapsedSinceLaunchMs: LAUNCH_INSTALL_WINDOW_MS + 1 }))).toBeNull()
    expect(decideLaunchInstall(input({ busy: true }))).toBeNull()
  })

  it('stays out of the way when auto-update is off or the package is not ready', () => {
    expect(decideLaunchInstall(input({ autoUpdate: false }))).toBeNull()
    expect(decideLaunchInstall(input({ snapshot: snapshot({ phase: 'downloading' }) }))).toBeNull()
    expect(decideLaunchInstall(input({ snapshot: snapshot({ error: { code: 'X', message: '安装失败' } }) }))).toBeNull()
    expect(decideLaunchInstall(input({ snapshot: snapshot({ development: true }) }))).toBeNull()
  })
})

describe('resolveLaunchInstallMode', () => {
  function modeInput(patch: Partial<LaunchInstallModeInput> = {}): LaunchInstallModeInput {
    return { launchedAtLogin: true, windowShown: false, accelerationActive: false, unattended: true, ...patch }
  }

  it('keeps the announced install for a normal launch or once the window has been shown', () => {
    expect(resolveLaunchInstallMode(modeInput({ launchedAtLogin: false }))).toBe('notice')
    expect(resolveLaunchInstallMode(modeInput({ launchedAtLogin: false, accelerationActive: true, unattended: false }))).toBe('notice')
    expect(resolveLaunchInstallMode(modeInput({ windowShown: true }))).toBe('notice')
    expect(resolveLaunchInstallMode(modeInput({ windowShown: true, unattended: false }))).toBe('notice')
  })

  it('installs in the background after a login launch whose window was never opened', () => {
    expect(resolveLaunchInstallMode(modeInput())).toBe('background')
  })

  it('leaves the version for the quit when installing would pop up a prompt or cut off acceleration', () => {
    expect(resolveLaunchInstallMode(modeInput({ unattended: false }))).toBe('skip')
    expect(resolveLaunchInstallMode(modeInput({ accelerationActive: true }))).toBe('skip')
  })
})

describe('canInstallUnattended', () => {
  const bundle = '/Applications/星芒AI管理工具.app'
  function sameRealPath(target: string): string {
    return target
  }
  function writable(...targets: string[]): (target: string) => boolean {
    return (target) => targets.includes(target)
  }

  it('never counts on an unattended install on Windows or through the system installer', () => {
    expect(canInstallUnattended({ platform: 'win32', bundlePath: bundle, canWrite: () => true, realPath: sameRealPath })).toBe(false)
    expect(canInstallUnattended({ platform: 'linux', bundlePath: bundle, canWrite: () => true, realPath: sameRealPath })).toBe(false)
    expect(canInstallUnattended({ platform: 'darwin', installMethod: 'system-installer', bundlePath: bundle, canWrite: () => true, realPath: sameRealPath })).toBe(false)
  })

  it('needs the resolved bundle and its folder writable on macOS, as Squirrel.Mac checks before asking for a password', () => {
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: bundle, canWrite: writable(bundle, '/Applications'), realPath: sameRealPath })).toBe(true)
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: bundle, canWrite: writable(bundle), realPath: sameRealPath })).toBe(false)
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: bundle, canWrite: writable('/Applications'), realPath: sameRealPath })).toBe(false)
    const linked = '/Users/alex/Apps/星芒AI管理工具.app'
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: bundle, canWrite: writable(bundle, '/Applications'), realPath: () => linked })).toBe(false)
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: bundle, canWrite: writable(linked, '/Users/alex/Apps'), realPath: () => linked })).toBe(true)
  })

  it('assumes a prompt when the bundle is unknown or cannot be inspected', () => {
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: null, canWrite: () => true, realPath: sameRealPath })).toBe(false)
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: bundle, canWrite: () => true, realPath: () => { throw new Error('ENOENT') } })).toBe(false)
  })

  it('checks the real folders for the current user by default', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-unattended-install-'))
    directories.push(directory)
    const app = path.join(directory, '星芒AI管理工具.app')
    fs.mkdirSync(app)
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: app })).toBe(true)
    expect(canInstallUnattended({ platform: 'darwin', bundlePath: path.join(directory, 'missing.app') })).toBe(false)
  })

  // root writes through any mode bits, and Windows ignores them on folders.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('assumes a prompt when the current user cannot write the folder holding the bundle', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-unattended-install-'))
    directories.push(directory)
    const app = path.join(directory, '星芒AI管理工具.app')
    fs.mkdirSync(app)
    fs.chmodSync(directory, 0o555)
    try {
      expect(canInstallUnattended({ platform: 'darwin', bundlePath: app })).toBe(false)
    } finally {
      fs.chmodSync(directory, 0o755)
    }
  })
})

describe('isRelaunchAfterBackgroundInstall', () => {
  const startedAt = 1_760_000_000_000
  const record = { ...emptyPendingUpdateRecord, downloadedVersion: '0.2.12', attemptedVersion: '0.2.12', backgroundInstall: { version: '0.2.12', startedAt } }

  it('recognises the relaunch the installer starts after a background install, installed or not', () => {
    expect(isRelaunchAfterBackgroundInstall(record, startedAt + 40_000)).toBe(true)
    expect(isRelaunchAfterBackgroundInstall(record, startedAt + BACKGROUND_RELAUNCH_WINDOW_MS)).toBe(true)
  })

  it('opens the window as usual without a background install, for a much later start or after a clock jump', () => {
    expect(isRelaunchAfterBackgroundInstall({ ...record, backgroundInstall: null }, startedAt + 40_000)).toBe(false)
    expect(isRelaunchAfterBackgroundInstall(record, startedAt + BACKGROUND_RELAUNCH_WINDOW_MS + 1)).toBe(false)
    expect(isRelaunchAfterBackgroundInstall(record, startedAt - 1)).toBe(false)
  })
})

describe('resolveDownloadedVersionToRecord', () => {
  it('records a freshly downloaded version once', () => {
    expect(resolveDownloadedVersionToRecord(snapshot(), { ...emptyPendingUpdateRecord })).toBe('0.2.12')
    expect(resolveDownloadedVersionToRecord(snapshot(), { downloadedVersion: '0.2.12', attemptedVersion: null })).toBeNull()
    expect(resolveDownloadedVersionToRecord(snapshot({ phase: 'available' }), { ...emptyPendingUpdateRecord })).toBeNull()
  })
})

describe('pending update store', () => {
  function storePath(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-pending-update-'))
    directories.push(directory)
    return path.join(directory, 'pending-update.json')
  }

  it('round-trips the record and reads a missing file as empty', async () => {
    const filePath = storePath()
    const store = createPendingUpdateStore({ filePath })
    expect(store.read()).toEqual(emptyPendingUpdateRecord)
    await store.write({ downloadedVersion: '0.2.12', attemptedVersion: '0.2.12' })
    expect(store.read()).toEqual({ downloadedVersion: '0.2.12', attemptedVersion: '0.2.12', quitAttemptedVersion: null, backgroundInstall: null })
    await store.write({ downloadedVersion: '0.2.12', attemptedVersion: null, quitAttemptedVersion: '0.2.12' })
    expect(store.read()).toEqual({ downloadedVersion: '0.2.12', attemptedVersion: null, quitAttemptedVersion: '0.2.12', backgroundInstall: null })
    const backgroundInstall = { version: '0.2.12', startedAt: 1_760_000_000_000 }
    await store.write({ downloadedVersion: '0.2.12', attemptedVersion: '0.2.12', backgroundInstall })
    expect(store.read()).toEqual({ downloadedVersion: '0.2.12', attemptedVersion: '0.2.12', quitAttemptedVersion: null, backgroundInstall })
  })

  it('treats a damaged or foreign record as no record', () => {
    expect(parsePendingUpdateRecord('not json')).toEqual(emptyPendingUpdateRecord)
    expect(parsePendingUpdateRecord(JSON.stringify({ version: 2, downloadedVersion: '0.2.12' }))).toEqual(emptyPendingUpdateRecord)
    expect(parsePendingUpdateRecord(JSON.stringify({ version: 1, downloadedVersion: '../x', attemptedVersion: 3 })))
      .toEqual(emptyPendingUpdateRecord)
    for (const backgroundInstall of ['0.2.12', { version: '../x', startedAt: 1 }, { version: '0.2.12', startedAt: 0 }, { version: '0.2.12', startedAt: 1.5 }, { version: '0.2.12', startedAt: '1' }]) {
      expect(parsePendingUpdateRecord(JSON.stringify({ version: 1, downloadedVersion: '0.2.12', backgroundInstall })).backgroundInstall).toBeNull()
    }
  })

  it('refuses a relative path', () => {
    expect(() => createPendingUpdateStore({ filePath: 'pending-update.json' })).toThrow()
  })
})

describe('quit-time auto install', () => {
  const record = { downloadedVersion: '0.2.12', attemptedVersion: null }

  it('installs on quit once per version, then goes back to asking', () => {
    expect(decideQuitInstall({ autoUpdate: true, version: '0.2.12', record })).toBe('install')
    expect(decideQuitInstall({ autoUpdate: true, version: '0.2.12', record: { ...record, quitAttemptedVersion: '0.2.12' } })).toBe('ask')
    expect(decideQuitInstall({ autoUpdate: true, version: '0.2.13', record: { ...record, quitAttemptedVersion: '0.2.12' } })).toBe('install')
  })

  it('asks when auto-update is off or the version is unreadable', () => {
    expect(decideQuitInstall({ autoUpdate: false, version: '0.2.12', record })).toBe('ask')
    expect(decideQuitInstall({ autoUpdate: true, version: null, record })).toBe('ask')
    expect(decideQuitInstall({ autoUpdate: true, version: '../x', record })).toBe('ask')
  })

  it('does not retry at launch a version already tried on quit', () => {
    expect(decideLaunchInstall(input({ recordAtLaunch: { ...record, quitAttemptedVersion: '0.2.12' } }))).toBeNull()
  })

  it('neither installs nor asks while the system shuts down, leaving the version for the next launch', () => {
    expect(decideQuitInstall({ autoUpdate: true, version: '0.2.12', record, systemShuttingDown: true })).toBe('later')
    expect(decideQuitInstall({ autoUpdate: false, version: '0.2.12', record, systemShuttingDown: true })).toBe('later')
    expect(decideQuitInstall({ autoUpdate: true, version: '0.2.12', record: { ...record, quitAttemptedVersion: '0.2.12' }, systemShuttingDown: true })).toBe('later')
    expect(decideQuitInstall({ autoUpdate: true, version: '0.2.12', record, systemShuttingDown: false })).toBe('install')
    // Nothing was recorded on the way down, so the next launch installs it.
    expect(decideLaunchInstall(input({ recordAtLaunch: record }))).toBe('0.2.12')
    expect(resolvePreviousAutoInstallFailure('0.2.12', '0.2.11', record)).toBeNull()
  })

  it('takes back a quit attempt that a power-off cut short, so the next launch installs it', () => {
    const tried = { ...record, quitAttemptedVersion: '0.2.12' }
    const undone = undoQuitInstallAttempt(tried, { version: '0.2.12', previous: null })
    expect(undone).toEqual({ ...record, quitAttemptedVersion: null })
    expect(decideLaunchInstall(input({ recordAtLaunch: undone ?? tried }))).toBe('0.2.12')
    expect(undoQuitInstallAttempt({ ...record, quitAttemptedVersion: '0.2.12' }, { version: '0.2.12', previous: '0.2.11' })).toEqual({ ...record, quitAttemptedVersion: '0.2.11' })
  })

  it('leaves the record alone when this quit wrote nothing or it has changed since', () => {
    const tried = { ...record, quitAttemptedVersion: '0.2.12' }
    expect(undoQuitInstallAttempt(tried, null)).toBeNull()
    expect(undoQuitInstallAttempt(tried, { version: '0.2.13', previous: null })).toBeNull()
    expect(undoQuitInstallAttempt(record, { version: '0.2.12', previous: null })).toBeNull()
  })
})

describe('resolvePreviousAutoInstallFailure', () => {
  it('recognises a version that was auto-installed but is still pending', () => {
    expect(resolvePreviousAutoInstallFailure('0.2.12', '0.2.11', { downloadedVersion: '0.2.12', attemptedVersion: null, quitAttemptedVersion: '0.2.12' })).toBe('0.2.12')
    expect(resolvePreviousAutoInstallFailure('0.2.12', '0.2.11', { downloadedVersion: '0.2.12', attemptedVersion: '0.2.12' })).toBe('0.2.12')
  })

  it('stays quiet when nothing was tried, a different version was tried, or the install worked', () => {
    expect(resolvePreviousAutoInstallFailure('0.2.12', '0.2.11', { downloadedVersion: '0.2.12', attemptedVersion: null })).toBeNull()
    expect(resolvePreviousAutoInstallFailure('0.2.13', '0.2.11', { downloadedVersion: '0.2.12', attemptedVersion: '0.2.12' })).toBeNull()
    expect(resolvePreviousAutoInstallFailure('0.2.12', '0.2.12', { downloadedVersion: '0.2.12', attemptedVersion: '0.2.12' })).toBeNull()
    expect(resolvePreviousAutoInstallFailure('bad', '0.2.11', { downloadedVersion: null, attemptedVersion: null })).toBeNull()
  })
})

describe('auto install wording', () => {
  it('warns Windows users about the consent window before either install moment', () => {
    for (const moment of ['quit', 'launch'] as const) {
      const notice = buildAutoInstallNotice('0.2.12', moment, 'win32')
      expect(notice.body).toContain('0.2.12')
      expect(notice.body).toContain('授权窗口')
      expect(notice.body).toContain('「是」')
      expect(notice.body).toContain('自动打开')
    }
  })

  it('leaves the consent window out on macOS', () => {
    expect(buildAutoInstallNotice('0.2.12', 'quit', 'darwin').body).not.toContain('授权')
    expect(buildAutoInstallNotice('0.2.12', 'launch', 'darwin').body).toContain('先关掉')
    expect(previousAutoInstallFailureMessage('darwin')).not.toContain('授权')
  })

  it('names the retry button and the likely cause after a failed auto install', () => {
    const message = previousAutoInstallFailureMessage('win32')
    expect(message).toContain('授权窗口')
    expect(message).toContain('「重新安装」')
  })

  it('uses no technical words', () => {
    const texts = [
      ...(['quit', 'launch'] as const).flatMap((moment) => (['win32', 'darwin'] as const).map((platform) => buildAutoInstallNotice('0.2.12', moment, platform))).flatMap((notice) => [notice.title, notice.body]),
      previousAutoInstallFailureMessage('win32'),
      previousAutoInstallFailureMessage('darwin'),
    ]
    for (const text of texts) expect(text).not.toMatch(/UAC|NSIS|installer|updater|管理员权限|用户账户控制/i)
  })
})

describe('system installer channel (Linux .deb)', () => {
  const record = { downloadedVersion: '0.2.12', attemptedVersion: null }

  it('never installs on its own, at launch or at quit', () => {
    expect(decideLaunchInstall(input({ snapshot: snapshot({ installMethod: 'system-installer' }) }))).toBeNull()
    expect(decideQuitInstall({ autoUpdate: true, version: '0.2.12', record, installMethod: 'system-installer' })).toBe('ask')
    // Windows and macOS keep installing on quit.
    expect(decideQuitInstall({ autoUpdate: true, version: '0.2.12', record, installMethod: null })).toBe('install')
    expect(decideLaunchInstall(input({ snapshot: snapshot({ installMethod: null }) }))).toBe('0.2.12')
  })

  it('tells the user up front that the app closes and the system asks for the login password', () => {
    const linux = quitInstallPrompt('0.2.12', 'system-installer')
    expect(linux.message).toBe('新版本 0.2.12 已经下载好，现在装上吗？')
    expect(linux.detail).toContain('输入开机密码')
    expect(linux.detail).toContain('重新打开星芒')
    expect(linux.buttons).toEqual(['关掉并安装', '先退出，下次再装'])
    expect(quitInstallPrompt('0.2.12', undefined)).toEqual({
      message: '新版本 0.2.12 已经下载好，顺手装上吗？',
      detail: '安装很快，装完会自动打开新版本。现在不装也行，更新会一直留着，下次退出时再问你。',
      buttons: ['安装并退出', '先退出，下次再装'],
    })
    expect(quitInstallPrompt(null, 'system-installer').message).toBe('新版本已经下载好，现在装上吗？')
  })
})

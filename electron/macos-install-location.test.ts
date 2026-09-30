import { describe, expect, it } from 'vitest'
import {
  buildMacosInstallLocationNotice, buildMacosMoveFailureNotice, inspectMacosInstallLocation,
  moveMacosAppToApplications, type MacosInstallLocationInput, type MoveToApplicationsFolder,
} from './macos-install-location'

const bundleName = '星芒AI管理工具.app'

function input(overrides: Partial<MacosInstallLocationInput> = {}): MacosInstallLocationInput {
  const appPath = overrides.appPath
    ?? `/Applications/${bundleName}/Contents/Resources/app.asar`
  return {
    platform: overrides.platform ?? 'darwin',
    packaged: overrides.packaged ?? true,
    appPath,
    executablePath: overrides.executablePath
      ?? appPath.replace('/Contents/Resources/app.asar', '/Contents/MacOS/星芒AI管理工具'),
  }
}

function mountedVolumePath(volume = '星芒AI管理工具 0.2.8'): string {
  return `/Volumes/${volume}/${bundleName}/Contents/Resources/app.asar`
}

function translocatedPath(): string {
  return '/private/var/folders/qb/9m1s/T/AppTranslocation/6E8F-4A21/d/'
    + `${bundleName}/Contents/Resources/app.asar`
}

describe('inspectMacosInstallLocation', () => {
  it('reports a bundle sitting at the root of a mounted volume', () => {
    expect(inspectMacosInstallLocation(input({ appPath: mountedVolumePath() })))
      .toBe('mounted-volume')
  })

  it('reports a volume name that contains spaces and non-ascii characters', () => {
    expect(inspectMacosInstallLocation(input({ appPath: mountedVolumePath('星芒 AI Manager') })))
      .toBe('mounted-volume')
  })

  it('reports an App Translocation copy', () => {
    expect(inspectMacosInstallLocation(input({ appPath: translocatedPath() })))
      .toBe('translocated')
  })

  it('reports translocation from the executable path when the asar path looks ordinary', () => {
    expect(inspectMacosInstallLocation(input({
      appPath: `/Applications/${bundleName}/Contents/Resources/app.asar`,
      executablePath: '/private/var/folders/qb/9m1s/T/AppTranslocation/6E8F/d/'
        + `${bundleName}/Contents/MacOS/星芒AI管理工具`,
    }))).toBe('translocated')
  })

  it('accepts an installation in the Applications folder', () => {
    expect(inspectMacosInstallLocation(input())).toBeNull()
  })

  it('accepts an installation inside a folder on an external volume', () => {
    expect(inspectMacosInstallLocation(input({
      appPath: `/Volumes/Backup/Applications/${bundleName}/Contents/Resources/app.asar`,
    }))).toBeNull()
  })

  it('accepts a temporary directory that is not an App Translocation copy', () => {
    expect(inspectMacosInstallLocation(input({
      appPath: `/private/var/folders/qb/9m1s/T/xingmang-macos-launch-7f/bundle/${bundleName}`
        + '/Contents/Resources/app.asar',
    }))).toBeNull()
  })

  it('accepts a directory whose name merely starts with the volumes root', () => {
    expect(inspectMacosInstallLocation(input({
      appPath: `/VolumesBackup/${bundleName}/Contents/Resources/app.asar`,
    }))).toBeNull()
  })

  it('ignores relative and empty paths rather than guessing', () => {
    expect(inspectMacosInstallLocation(input({ appPath: '', executablePath: '' }))).toBeNull()
    expect(inspectMacosInstallLocation(input({
      appPath: 'Volumes/Installer/app.asar',
      executablePath: 'Volumes/Installer/bin',
    }))).toBeNull()
  })

  it('stays silent on other platforms', () => {
    expect(inspectMacosInstallLocation(input({
      platform: 'win32',
      appPath: mountedVolumePath(),
    }))).toBeNull()
  })

  it('stays silent in development, where the checkout is the install location', () => {
    expect(inspectMacosInstallLocation(input({
      packaged: false,
      appPath: mountedVolumePath(),
    }))).toBeNull()
  })
})

describe('buildMacosInstallLocationNotice', () => {
  it('offers moving into Applications as the default answer for both locations', () => {
    for (const location of ['mounted-volume', 'translocated'] as const) {
      const notice = buildMacosInstallLocationNotice(location)
      expect(notice.buttons).toEqual(['移到「应用程序」并重新打开', '仍要继续', '退出'])
      expect(notice.choices).toEqual(['move', 'continue', 'quit'])
      expect(notice.choices[notice.defaultId]).toBe('move')
      expect(notice.choices[notice.cancelId]).toBe('quit')
      expect(notice.detail).toContain('星芒会自己搬过去并重新打开')
    }
  })

  it('names the location the user is actually looking at', () => {
    expect(buildMacosInstallLocationNotice('mounted-volume').message).toContain('磁盘映像')
    expect(buildMacosInstallLocationNotice('translocated').message).toContain('临时副本')
  })
})

describe('moveMacosAppToApplications', () => {
  it('reports a completed move so startup can stop and let Electron relaunch', () => {
    const move: MoveToApplicationsFolder = () => true
    expect(moveMacosAppToApplications(move)).toEqual({ kind: 'moved', conflict: null })
  })

  it('keeps the default conflict behaviour and records which conflict happened', () => {
    for (const conflictType of ['exists', 'existsAndRunning'] as const) {
      let answer: boolean | undefined
      const move: MoveToApplicationsFolder = (options) => {
        answer = options.conflictHandler(conflictType)
        return true
      }
      expect(moveMacosAppToApplications(move)).toEqual({ kind: 'moved', conflict: conflictType })
      expect(answer).toBe(true)
    }
  })

  it('treats a false return as the user cancelling the password prompt', () => {
    expect(moveMacosAppToApplications(() => false)).toEqual({ kind: 'cancelled', conflict: null })
  })

  it('captures a thrown copy failure instead of letting startup crash', () => {
    const error = new Error('Failed to copy to applications directory')
    const outcome = moveMacosAppToApplications(() => {
      throw error
    })
    expect(outcome).toEqual({ kind: 'failed', conflict: null, error })
  })
})

describe('buildMacosMoveFailureNotice', () => {
  it('explains a cancelled password prompt and falls back to dragging by hand', () => {
    const notice = buildMacosMoveFailureNotice('translocated', { kind: 'cancelled', conflict: null })
    expect(notice.message).toBe('没能自动移动（输入电脑密码的窗口被取消了）。')
    expect(notice.detail).toContain('请把「星芒AI管理工具」拖到「应用程序」文件夹后再打开。')
  })

  it('never puts the English diagnostic on screen', () => {
    const outcome = { kind: 'failed', conflict: null, error: new Error('Failed to copy') } as const
    for (const location of ['mounted-volume', 'translocated'] as const) {
      const notice = buildMacosMoveFailureNotice(location, outcome)
      expect(`${notice.message}${notice.detail}`).not.toContain('Failed')
      expect(notice.message).toContain('没能自动移动')
    }
  })

  it('keeps quitting as the default and still lets the user continue', () => {
    const notice = buildMacosMoveFailureNotice('mounted-volume', { kind: 'cancelled', conflict: null })
    expect(notice.buttons).toEqual(['退出', '仍要继续'])
    expect(notice.choices).toEqual(['quit', 'continue'])
    expect(notice.choices[notice.defaultId]).toBe('quit')
    expect(notice.choices[notice.cancelId]).toBe('quit')
  })
})

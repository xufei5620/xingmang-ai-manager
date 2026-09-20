import { describe, expect, it } from 'vitest'
import {
  buildMacosInstallLocationNotice, inspectMacosInstallLocation,
  type MacosInstallLocationInput,
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
  it('offers quitting as the default answer for both locations', () => {
    for (const location of ['mounted-volume', 'translocated'] as const) {
      const notice = buildMacosInstallLocationNotice(location)
      expect(notice.buttons).toEqual(['退出', '仍要继续'])
      expect(notice.defaultId).toBe(0)
      expect(notice.cancelId).toBe(0)
      expect(notice.detail).toContain('应用程序')
    }
  })

  it('names the location the user is actually looking at', () => {
    expect(buildMacosInstallLocationNotice('mounted-volume').message).toContain('磁盘映像')
    expect(buildMacosInstallLocationNotice('translocated').message).toContain('临时副本')
  })
})

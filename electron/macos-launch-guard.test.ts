import { describe, expect, it } from 'vitest'
import { linuxLaunchRefusalNotice } from './linux-launch-guard'
import { macosLaunchRefusal } from './macos-launch-guard'

describe('macOS launch guard', () => {
  it('refuses root on macOS', () => {
    expect(macosLaunchRefusal({ platform: 'darwin', effectiveUid: 0 })).toBe('root')
  })

  it('lets the normal account through', () => {
    expect(macosLaunchRefusal({ platform: 'darwin', effectiveUid: 501 })).toBeNull()
    // Without geteuid nothing proves root, as in the Linux guard.
    expect(macosLaunchRefusal({ platform: 'darwin', effectiveUid: undefined })).toBeNull()
  })

  it('leaves every other platform to its own guard', () => {
    expect(macosLaunchRefusal({ platform: 'linux', effectiveUid: 0 })).toBeNull()
    expect(macosLaunchRefusal({ platform: 'freebsd', effectiveUid: 0 })).toBeNull()
    expect(macosLaunchRefusal({ platform: 'win32', effectiveUid: undefined })).toBeNull()
  })

  it('shows the root wording D18 approved, word for word', () => {
    expect(linuxLaunchRefusalNotice('root')).toEqual({
      title: '请用平时登录电脑的账号打开',
      message: '星芒AI管理工具不能用管理员身份打开。用管理员身份打开，装好的工具和设置会归管理员所有，之后平时的账号反而用不了。请关掉这个提示，从应用菜单里直接打开。这次什么都没有改动。',
    })
  })
})

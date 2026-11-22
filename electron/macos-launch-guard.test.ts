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
      message: '星芒AI管理工具不支持以管理员身份打开。以管理员身份打开时，安装的工具和设置将归管理员所有，日常使用的账号将无法使用。请关闭此提示，从应用菜单中直接打开。本次未作任何改动。',
    })
  })
})

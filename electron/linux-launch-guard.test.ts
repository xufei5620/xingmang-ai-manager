import { describe, expect, it } from 'vitest'
import { linuxLaunchRefusal, linuxLaunchRefusalNotice } from './linux-launch-guard'

describe('Linux launch guard', () => {
  it('refuses root on Linux, including a root launch that kept the caller in SUDO_UID', () => {
    expect(linuxLaunchRefusal({ platform: 'linux', effectiveUid: 0, env: {} })).toBe('root')
    expect(linuxLaunchRefusal({ platform: 'linux', effectiveUid: 0, env: { SUDO_UID: '1000' } })).toBe('root')
    // Every platform that is not win32 or darwin counts as Linux, as in platform-capabilities.ts.
    expect(linuxLaunchRefusal({ platform: 'freebsd', effectiveUid: 0, env: {} })).toBe('root')
  })

  it('refuses a launch made on behalf of a different account', () => {
    expect(linuxLaunchRefusal({ platform: 'linux', effectiveUid: 1001, env: { SUDO_UID: '1000' } })).toBe('other-account')
    expect(linuxLaunchRefusal({ platform: 'linux', effectiveUid: 1001, env: { PKEXEC_UID: '1000' } })).toBe('other-account')
  })

  it('lets the normal account through, even when sudo recorded that same account', () => {
    expect(linuxLaunchRefusal({ platform: 'linux', effectiveUid: 1000, env: {} })).toBeNull()
    expect(linuxLaunchRefusal({ platform: 'linux', effectiveUid: 1000, env: { SUDO_UID: '1000' } })).toBeNull()
    // Garbage is not a uid and proves nothing either way.
    expect(linuxLaunchRefusal({ platform: 'linux', effectiveUid: 1000, env: { SUDO_UID: 'root', PKEXEC_UID: '' } })).toBeNull()
  })

  it('leaves Windows and macOS launches alone whatever the uid', () => {
    expect(linuxLaunchRefusal({ platform: 'win32', effectiveUid: undefined, env: { SUDO_UID: '1' } })).toBeNull()
    expect(linuxLaunchRefusal({ platform: 'darwin', effectiveUid: 0, env: {} })).toBeNull()
    expect(linuxLaunchRefusal({ platform: 'darwin', effectiveUid: 501, env: { SUDO_UID: '502' } })).toBeNull()
    expect(linuxLaunchRefusal({ platform: 'linux', effectiveUid: undefined, env: {} })).toBeNull()
  })

  it('explains the refusal in plain Chinese without technical words', () => {
    for (const refusal of ['root', 'other-account'] as const) {
      const notice = linuxLaunchRefusalNotice(refusal)
      expect(notice.title).toBe('请用平时登录电脑的账号打开')
      expect(notice.message).toContain('从应用菜单里直接打开')
      expect(notice.message).toContain('这次什么都没有改动')
      expect(`${notice.title}${notice.message}`).not.toMatch(/root|sudo|uid|sandbox|沙箱/i)
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import { resolveCodexRemoteAvailability } from './codex-remote'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

describe('codex-remote bootstrap availability', () => {
  it('leaves macOS and Linux alone', () => {
    expect(resolveCodexRemoteAvailability('darwin', { mode: 'trusted-only' })).toBeNull()
    expect(resolveCodexRemoteAvailability('linux', { mode: 'same-user' })).toBeNull()
  })

  it('opens on Windows only once the integrity label says this is not an administrator', () => {
    expect(resolveCodexRemoteAvailability('win32', { mode: 'same-user', highIntegrity: false })).toBeNull()
    expect(resolveCodexRemoteAvailability('win32', { mode: 'same-user', highIntegrity: true })).toContain('正以管理员身份运行')
    expect(resolveCodexRemoteAvailability('win32', { mode: 'trusted-only', highIntegrity: false })).toContain('正以管理员身份运行')
    expect(resolveCodexRemoteAvailability('win32', { mode: 'trusted-only' })).toContain('正以管理员身份运行')
  })

  // #1407 P2-5: an unreadable label is not proof of an ordinary user. same-user is
  // then a fallback that keeps CLI installs working, not a verdict on elevation.
  it('stays off on Windows when it cannot tell whether this is an administrator', () => {
    expect(resolveCodexRemoteAvailability('win32', { mode: 'same-user' })).toBe(
      '没能确认星芒是不是以管理员身份运行。为了安全，这时不能打开手机遥控，请用普通方式重新打开星芒再试。',
    )
  })
})

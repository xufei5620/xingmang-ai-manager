import { describe, expect, it, vi } from 'vitest'
import { isAlwaysElevatedWindowsAccount, resolveCodexRemoteAvailability } from './codex-remote'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

describe('codex-remote bootstrap availability', () => {
  it('leaves macOS and Linux alone', () => {
    expect(resolveCodexRemoteAvailability('darwin', { mode: 'trusted-only' })).toBeNull()
    expect(resolveCodexRemoteAvailability('linux', { mode: 'same-user' })).toBeNull()
  })

  it('opens on Windows once the integrity label says this is not an administrator', () => {
    expect(resolveCodexRemoteAvailability('win32', { mode: 'same-user', highIntegrity: false })).toBeNull()
  })

  it('keeps remote control off when the customer chose "run as administrator"', () => {
    expect(resolveCodexRemoteAvailability('win32', { mode: 'trusted-only', highIntegrity: true })).toBe(
      '星芒正以管理员身份运行，为保障安全，此时无法开启遥控。请以普通方式重新打开星芒。',
    )
    expect(resolveCodexRemoteAvailability('win32', { mode: 'trusted-only', highIntegrity: false })).toContain('正以管理员身份运行')
    expect(resolveCodexRemoteAvailability('win32', { mode: 'trusted-only' })).toContain('正以管理员身份运行')
    expect(resolveCodexRemoteAvailability('win32', { mode: 'trusted-only', highIntegrity: true, probeFailure: { reason: 'timeout', detail: '' } })).toContain('正以管理员身份运行')
  })

  // yoyo typed his consent on 2026-11-20: an account that runs everything at High
  // integrity by itself (built-in Administrator, UAC off) has no elevation boundary
  // to protect, and "reopen normally" can never work there.
  it('opens on a Windows account that is an administrator by itself', () => {
    expect(resolveCodexRemoteAvailability('win32', { mode: 'same-user', highIntegrity: true })).toBeNull()
  })

  it('does not treat a failed elevation probe as an account that is an administrator by itself', () => {
    expect(resolveCodexRemoteAvailability('win32', { mode: 'same-user', highIntegrity: true, probeFailure: { reason: 'timeout', detail: '' } })).toBe(
      '无法确认星芒是否以管理员身份运行，为保障安全，此时无法开启遥控。请以普通方式重新打开星芒后重试。',
    )
  })

  // #1407 P2-5: an unreadable label is not proof of an ordinary user. same-user is
  // then a fallback that keeps CLI installs working, not a verdict on elevation.
  it('stays off on Windows when it cannot tell whether this is an administrator', () => {
    expect(resolveCodexRemoteAvailability('win32', { mode: 'same-user' })).toBe(
      '无法确认星芒是否以管理员身份运行，为保障安全，此时无法开启遥控。请以普通方式重新打开星芒后重试。',
    )
  })
})

describe('isAlwaysElevatedWindowsAccount', () => {
  it('is true only for a same-user High integrity token the probe settled', () => {
    expect(isAlwaysElevatedWindowsAccount('win32', { mode: 'same-user', highIntegrity: true })).toBe(true)
  })

  it('is false for every other startup verdict', () => {
    expect(isAlwaysElevatedWindowsAccount('win32', { mode: 'same-user', highIntegrity: false })).toBe(false)
    expect(isAlwaysElevatedWindowsAccount('win32', { mode: 'same-user' })).toBe(false)
    expect(isAlwaysElevatedWindowsAccount('win32', { mode: 'same-user', highIntegrity: true, probeFailure: { reason: 'failed', detail: '' } })).toBe(false)
    expect(isAlwaysElevatedWindowsAccount('win32', { mode: 'trusted-only', highIntegrity: true })).toBe(false)
    expect(isAlwaysElevatedWindowsAccount('darwin', { mode: 'same-user', highIntegrity: true })).toBe(false)
    expect(isAlwaysElevatedWindowsAccount('linux', { mode: 'same-user', highIntegrity: true })).toBe(false)
  })
})

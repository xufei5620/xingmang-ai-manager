import { describe, expect, it } from 'vitest'
import { checksCodexDesktopBeforeUpdate, codexDesktopRunningBeforeUpdate } from './codex-desktop-update'

describe('Codex Desktop update while it is open', () => {
  it('looks before updating an installed Codex Desktop on Windows only', () => {
    expect(checksCodexDesktopBeforeUpdate('win', true)).toBe(true)
    // 第一次装：没有东西可关。
    expect(checksCodexDesktopBeforeUpdate('win', false)).toBe(false)
    // Mac 上装好的那份星芒不碰，主进程直接说「已经装好了」。
    expect(checksCodexDesktopBeforeUpdate('mac', true)).toBe(false)
    expect(checksCodexDesktopBeforeUpdate('linux', true)).toBe(false)
  })

  it('trusts the live answer over the last scan', () => {
    expect(codexDesktopRunningBeforeUpdate({ running: true }, { running: false })).toBe(true)
    expect(codexDesktopRunningBeforeUpdate({ running: false }, { running: true })).toBe(false)
  })

  it('falls back to the last scan when the live probe failed or did not finish', () => {
    expect(codexDesktopRunningBeforeUpdate(null, { running: true })).toBe(true)
    expect(codexDesktopRunningBeforeUpdate({ running: false, detectionFailed: true }, { running: true })).toBe(true)
    // 现问那次没做完，可它还是看到了窗口：开着就是开着。
    expect(codexDesktopRunningBeforeUpdate({ running: true, detectionFailed: true }, { running: false })).toBe(true)
  })

  it('updates straight away when neither answer says it is open', () => {
    expect(codexDesktopRunningBeforeUpdate(null, { running: false })).toBe(false)
    expect(codexDesktopRunningBeforeUpdate(null, { running: false, detectionFailed: true })).toBe(false)
  })
})

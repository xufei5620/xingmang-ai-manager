import { describe, expect, it } from 'vitest'
import { uninstallHandOffMessage, uninstallHandOffNotice } from './uninstall-handoff'

describe('uninstallHandOffNotice', () => {
  it('turns a hand-off to the normal-permission window into a neutral notice', () => {
    expect(uninstallHandOffNotice({ outcome: 'delegated', previousVersion: '1.0.0' })).toBe(uninstallHandOffMessage)
  })

  it('stays out of the way for every other outcome', () => {
    expect(uninstallHandOffNotice({ outcome: 'uninstalled', previousVersion: '1.0.0' })).toBeNull()
    expect(uninstallHandOffNotice({ outcome: 'not-installed', previousVersion: null })).toBeNull()
    expect(uninstallHandOffNotice({
      outcome: 'manual-required',
      previousVersion: '1.0.0',
      error: '没卸干净',
      manualHelp: { reason: '文件被占用', manualCommand: null },
    })).toBeNull()
  })
})

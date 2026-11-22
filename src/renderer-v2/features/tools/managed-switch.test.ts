import { describe, expect, it } from 'vitest'
import { managedSwitchConfirmation, managedSwitchVersion } from './managed-switch'

describe('managed switch version', () => {
  const pinned = { recommendedVersion: '2.1.277', blockedReason: null, onRecommended: false, pinned: true, rollbackAvailable: true, recommendedIsNewer: true }

  it('installs exactly the version the button named', () => {
    expect(managedSwitchVersion({ latestVersion: '2.1.288', versionAdvice: pinned }, '2.1.280')).toBe('2.1.280')
  })

  it('lands where an unnamed install would: the pinned recommendation, otherwise the latest release', () => {
    expect(managedSwitchVersion({ latestVersion: '2.1.288', versionAdvice: pinned })).toBe('2.1.277')
    expect(managedSwitchVersion({ latestVersion: '2.1.288', versionAdvice: { ...pinned, pinned: false } })).toBe('2.1.288')
    expect(managedSwitchVersion({ latestVersion: '2.1.288', versionAdvice: null })).toBe('2.1.288')
  })

  it('falls back to the recommendation when the latest release was not read, and to nothing without either', () => {
    expect(managedSwitchVersion({ latestVersion: null, versionAdvice: { ...pinned, pinned: false } })).toBe('2.1.277')
    expect(managedSwitchVersion({ latestVersion: null, versionAdvice: null })).toBeNull()
  })
})

describe('managed switch confirmation', () => {
  it('uses the approved wording with the version filled in', () => {
    expect(managedSwitchConfirmation('2.1.277')).toEqual({
      title: '是否改用星芒安装的 Claude Code？',
      body: '本机的 Claude Code 由官方安装器安装，星芒无法直接更新。点击「改用星芒安装」后，星芒将先卸载原版本，再安装 2.1.277。工具配置、账号数据和历史记录将保留，之后可在星芒中一键更新。',
      okLabel: '改用星芒安装',
    })
  })
})

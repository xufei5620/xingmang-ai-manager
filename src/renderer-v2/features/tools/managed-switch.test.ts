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
      title: '换成星芒装的 Claude Code？',
      body: '这台电脑上的 Claude Code 是官方安装器装的，星芒没法直接更新它。点「换成星芒装的」，星芒会先把它卸掉，再装上 2.1.277。工具配置、账户数据和历史记录会保留，以后在星芒里点一下就能更新。',
      okLabel: '换成星芒装的',
    })
  })
})

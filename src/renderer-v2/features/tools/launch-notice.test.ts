import { describe, expect, it } from 'vitest'
import { launchWarning } from './launch-notice'
import type { DesktopAppStatus } from '../../../../electron/ipc-contract'

const status = { installed: true } as DesktopAppStatus

describe('launchWarning', () => {
  it('stays quiet when the launch reports nothing', () => {
    expect(launchWarning(undefined)).toBeNull()
    expect(launchWarning({})).toBeNull()
    expect(launchWarning({ restarted: false, status })).toBeNull()
    expect(launchWarning({ restarted: false, status, chineseLocale: { status: 'verified' } })).toBeNull()
  })

  it('surfaces an unconfirmed Codex Desktop Chinese locale', () => {
    expect(launchWarning({ restarted: false, status, chineseLocale: { status: 'failed', message: '中文界面没生效' } }))
      .toBe('中文界面没生效')
    expect(launchWarning({ restarted: false, status, chineseLocale: { status: 'restart-required' } }))
      .toBe('Codex 已打开，中文界面尚未确认生效，请在配置中再次启用。')
  })

  it('surfaces a workspace setting that overrides the current account', () => {
    expect(launchWarning({ configOverrideNotice: '这个项目文件夹里有自己的设置' })).toBe('这个项目文件夹里有自己的设置')
  })
})

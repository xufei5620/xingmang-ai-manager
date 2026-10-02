import { describe, expect, it } from 'vitest'
import { elevatedInstallNotice, elevatedInstallShortNotice } from './elevation-notice'

describe('elevatedInstallNotice', () => {
  it('warns before the UAC prompt on Windows', () => {
    const notice = elevatedInstallNotice('node', 'windows', 'managed')
    expect(notice).toContain('管理员授权')
    expect(notice).toContain('Node.js')
    expect(notice).toContain('普通账号')
  })

  it('names the Codex desktop app in its own notice', () => {
    expect(elevatedInstallNotice('codexDesktop', 'windows', 'managed')).toContain('Codex 桌面端')
  })

  it('never tells the user to run this app as administrator', () => {
    for (const subject of ['node', 'codexDesktop'] as const) {
      expect(elevatedInstallNotice(subject, 'windows', 'managed')).not.toContain('以管理员身份运行')
    }
  })

  it('stays silent where the app does not elevate', () => {
    expect(elevatedInstallNotice('node', 'macos', 'external')).toBeNull()
    expect(elevatedInstallNotice('codexDesktop', 'macos', 'external')).toBeNull()
    // macOS 上 Codex 桌面端是 external，Windows 上才 managed；平台与安装方式都要对。
    expect(elevatedInstallNotice('node', 'windows', 'external')).toBeNull()
    expect(elevatedInstallNotice('node', undefined, undefined)).toBeNull()
  })
})

describe('elevatedInstallShortNotice', () => {
  it('follows the long notice, one line shorter', () => {
    expect(elevatedInstallShortNotice('codexDesktop', 'windows', 'managed')).toContain('管理员授权')
    expect(elevatedInstallShortNotice('node', 'macos', 'external')).toBeNull()
  })
})

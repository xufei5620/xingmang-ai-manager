import { describe, expect, it } from 'vitest'
import { elevatedInstallNotice, elevatedInstallShortNotice, storeAppLaunchNotice, storeAppLaunchShortNotice } from './elevation-notice'

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

describe('storeAppLaunchNotice', () => {
  it('warns the built-in Administrator account before a store install', () => {
    for (const notice of [storeAppLaunchNotice('builtInAdministrator'), storeAppLaunchShortNotice('builtInAdministrator')]) {
      expect(notice).toContain('「Administrator」账户')
      expect(notice).toContain('可能打不开')
      expect(notice).toContain('普通账户')
      expect(notice).toContain('Codex 命令行版')
    }
  })

  it('names the Windows setting when the consent prompt is off', () => {
    for (const notice of [storeAppLaunchNotice('uacDisabled'), storeAppLaunchShortNotice('uacDisabled')]) {
      expect(notice).toContain('「用户账户控制」')
      expect(notice).toContain('客服')
    }
  })

  it('stays silent when nothing was detected', () => {
    for (const block of [null, undefined]) {
      expect(storeAppLaunchNotice(block)).toBeNull()
      expect(storeAppLaunchShortNotice(block)).toBeNull()
    }
  })

  it('keeps Windows internals out and never tells the user to run as administrator', () => {
    for (const block of ['builtInAdministrator', 'uacDisabled'] as const) {
      for (const notice of [storeAppLaunchNotice(block), storeAppLaunchShortNotice(block)]) {
        expect(notice).not.toMatch(/UAC|AppX|Appx|MSIX|令牌|SID|注册表|以管理员身份运行/)
      }
    }
  })
})

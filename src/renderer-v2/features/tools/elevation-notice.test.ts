import { describe, expect, it } from 'vitest'
import { elevatedInstallNotice, elevatedInstallShortNotice, homeNodeElevationNotice } from './elevation-notice'

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

  it('stays silent when the app already runs with administrator rights, because no consent window pops up', () => {
    // 已知19：自带 Administrator、关了 UAC、右键以管理员身份运行。
    for (const subject of ['node', 'codexDesktop'] as const) {
      expect(elevatedInstallNotice(subject, 'windows', 'managed', true)).toBeNull()
      expect(elevatedInstallShortNotice(subject, 'windows', 'managed', true)).toBeNull()
      expect(elevatedInstallNotice(subject, 'windows', 'managed', false)).toContain('管理员授权')
    }
    // The optional home paragraph loses only its consent half; "一般不用单独点" still answers whether to click.
    expect(homeNodeElevationNotice('windows', 'managed', true, true)).toBe('Node.js 是命令行工具需要的运行环境，装工具时会自动准备，一般不用单独点。')
    expect(homeNodeElevationNotice('windows', 'managed', false, true)).toBeNull()
    for (const optional of [true, false]) {
      expect(homeNodeElevationNotice('windows', 'managed', optional, false)).toContain('授权窗口')
      expect(homeNodeElevationNotice('macos', 'managed', optional, true)).toBeNull()
    }
  })
})

describe('elevatedInstallShortNotice', () => {
  it('follows the long notice, one line shorter', () => {
    expect(elevatedInstallShortNotice('codexDesktop', 'windows', 'managed')).toContain('管理员授权')
    expect(elevatedInstallShortNotice('node', 'macos', 'external')).toBeNull()
  })
})

describe('homeNodeElevationNotice', () => {
  it('names the step the way the home card button reads, without pointing at a button called install', () => {
    const notice = homeNodeElevationNotice('windows', 'managed', false)
    expect(notice).toBe('这一步需要管理员授权：准备 Node.js 时 Windows 会弹一次授权窗口，请选「是」，Node.js 才装得上；如果这台电脑登录的是普通账号，还要输入一个管理员账号的密码。')
    expect(notice).not.toContain('点「安装」')
  })

  it('explains Node.js is prepared on demand when no command-line tool needs it yet', () => {
    const notice = homeNodeElevationNotice('windows', 'managed', true)
    expect(notice).toBe('Node.js 是命令行工具需要的运行环境，装工具时会自动准备，一般不用单独点。准备时 Windows 会弹一次授权窗口，请选「是」；如果这台电脑登录的是普通账号，还要输入一个管理员账号的密码。')
    expect(notice).not.toContain('这一步需要')
  })

  it('keeps the maintenance page sentence as it was, because that page really has an install button', () => {
    expect(elevatedInstallNotice('node', 'windows', 'managed')).toContain('点「安装」后')
  })

  it('stays silent wherever the long notice does', () => {
    for (const optional of [true, false]) {
      expect(homeNodeElevationNotice('macos', 'managed', optional)).toBeNull()
      expect(homeNodeElevationNotice('linux', 'managed', optional)).toBeNull()
      expect(homeNodeElevationNotice('windows', 'external', optional)).toBeNull()
      expect(homeNodeElevationNotice(undefined, undefined, optional)).toBeNull()
      expect(homeNodeElevationNotice('windows', 'managed', optional)).not.toContain('以管理员身份运行')
    }
  })
})

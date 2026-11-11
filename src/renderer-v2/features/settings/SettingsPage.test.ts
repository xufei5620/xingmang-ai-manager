import { describe, expect, it } from 'vitest'
import { closeToTrayLabel, closeToTrayNote, launchAtLoginFallbackNote } from './SettingsPage'

// 决定单 D30：Mac 上没有「托盘」，同一个图标在屏幕顶部的菜单栏里；Windows、Linux 照旧。
describe('settings close and startup wording', () => {
  it('names hiding the window after the menu bar on macOS', () => {
    expect(closeToTrayLabel(true)).toBe('收到菜单栏')
    expect(closeToTrayNote(true, false)).toBe('收到菜单栏后，正在进行的安装会继续在后台运行')
    expect(closeToTrayNote(true, true)).toBe('收到菜单栏后，正在进行的安装会继续在后台运行')
    expect(launchAtLoginFallbackNote(true)).toBe('开机后在菜单栏里待命，不弹窗口；开机头几分钟不做检测和更新，不跟电脑抢资源。要用时点屏幕顶部的星芒图标。')
  })

  it('keeps the tray wording on Windows and Linux', () => {
    expect(closeToTrayLabel(false)).toBe('缩到托盘')
    expect(closeToTrayNote(false, false)).toBe('缩到托盘后，正在进行的安装会继续在后台运行')
    expect(closeToTrayNote(false, true)).toBe('缩到托盘后，加速和正在进行的安装会继续在后台运行')
    expect(launchAtLoginFallbackNote(false)).toBe('开机后在托盘里待命，不弹窗口')
  })
})

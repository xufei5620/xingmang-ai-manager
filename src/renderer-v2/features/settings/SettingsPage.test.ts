import { describe, expect, it } from 'vitest'
import {
  canOpenNotificationSettings,
  closeToTrayLabel,
  closeToTrayNote,
  launchAtLoginFallbackNote,
  notificationSettingsUnavailableText,
  openNotificationSettingsLabel,
  testNotificationHandedOffText,
} from './SettingsPage'

// 决定单 D30：Mac 上没有「托盘」，同一个图标在屏幕顶部的菜单栏里；Windows、Linux 照旧。
describe('settings close and startup wording', () => {
  it('names hiding the window after the menu bar on macOS', () => {
    expect(closeToTrayLabel(true)).toBe('收到菜单栏')
    expect(closeToTrayNote(true, false)).toBe('收到菜单栏后，正在进行的安装会继续在后台运行')
    expect(closeToTrayNote(true, true)).toBe('收到菜单栏后，正在进行的安装会继续在后台运行')
    expect(launchAtLoginFallbackNote(true)).toBe('开机后在菜单栏中待命，不弹出窗口；开机后数分钟内不进行检测和更新，以免占用系统资源。需要时请点击屏幕顶部的星芒图标。')
  })

  it('keeps the tray wording on Windows and Linux', () => {
    expect(closeToTrayLabel(false)).toBe('缩到托盘')
    expect(closeToTrayNote(false, false)).toBe('缩到托盘后，正在进行的安装会继续在后台运行')
    expect(closeToTrayNote(false, true)).toBe('缩到托盘后，加速和正在进行的安装会继续在后台运行')
    expect(launchAtLoginFallbackNote(false)).toBe('开机后在托盘中待命，不弹出窗口')
  })
})

// 决定单 D68：系统里把星芒的通知关了，测试通知照样「发得出去」，界面不能再说「已发送」。
describe('settings test notification wording', () => {
  it('says the notification was handed to the system and where to look when it does not show', () => {
    expect(testNotificationHandedOffText).toBe('测试通知已提交给系统。如未收到，请在系统通知设置中确认星芒的通知已开启。')
    expect(testNotificationHandedOffText).not.toContain('已发送')
    expect(openNotificationSettingsLabel).toBe('打开系统通知设置')
    expect(notificationSettingsUnavailableText).toBe('无法打开系统通知设置，请在系统设置中找到「通知」。')
  })

  it('offers to open the system notification settings only on Windows and macOS', () => {
    expect(canOpenNotificationSettings('windows')).toBe(true)
    expect(canOpenNotificationSettings('macos')).toBe(true)
    expect(canOpenNotificationSettings('linux')).toBe(false)
    expect(canOpenNotificationSettings('')).toBe(false)
  })
})

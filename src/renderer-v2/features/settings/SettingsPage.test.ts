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
    expect(launchAtLoginFallbackNote(true)).toBe('开机后在菜单栏里待命，不弹窗口；开机头几分钟不做检测和更新，不跟电脑抢资源。要用时点屏幕顶部的星芒图标。')
  })

  it('keeps the tray wording on Windows and Linux', () => {
    expect(closeToTrayLabel(false)).toBe('缩到托盘')
    expect(closeToTrayNote(false, false)).toBe('缩到托盘后，正在进行的安装会继续在后台运行')
    expect(closeToTrayNote(false, true)).toBe('缩到托盘后，加速和正在进行的安装会继续在后台运行')
    expect(launchAtLoginFallbackNote(false)).toBe('开机后在托盘里待命，不弹窗口')
  })
})

// 决定单 D68：系统里把星芒的通知关了，测试通知照样「发得出去」，界面不能再说「已发送」。
describe('settings test notification wording', () => {
  it('says the notification was handed to the system and where to look when it does not show', () => {
    expect(testNotificationHandedOffText).toBe('已经交给系统了。没看到通知的话，去系统的通知设置里看看星芒有没有被关掉。')
    expect(testNotificationHandedOffText).not.toContain('已发送')
    expect(openNotificationSettingsLabel).toBe('打开系统通知设置')
    expect(notificationSettingsUnavailableText).toBe('没能打开系统通知设置，请在系统设置里找「通知」。')
  })

  it('offers to open the system notification settings only on Windows and macOS', () => {
    expect(canOpenNotificationSettings('windows')).toBe(true)
    expect(canOpenNotificationSettings('macos')).toBe(true)
    expect(canOpenNotificationSettings('linux')).toBe(false)
    expect(canOpenNotificationSettings('')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { describeLoginDevice } from './login-device-label'

describe('login device label', () => {
  it('names this desktop app with its version and system', () => {
    expect(describeLoginDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) xingmang-ai-manager/0.2.10 Chrome/150.0.7871.250 Electron/43.6.0 Safari/537.36'))
      .toBe('星芒AI管理工具 0.2.10 · Windows 电脑')
    expect(describeLoginDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) xingmang-ai-manager/0.2.11-beta.1 Chrome/150.0.7871.250 Electron/43.6.0 Safari/537.36'))
      .toBe('星芒AI管理工具 0.2.11-beta.1 · Mac')
    expect(describeLoginDevice('xingmang-ai-manager')).toBe('星芒AI管理工具')
  })

  it('names common browsers without mistaking Chromium-based ones for Chrome', () => {
    expect(describeLoginDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'))
      .toBe('Chrome 浏览器 · Windows 电脑')
    expect(describeLoginDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'))
      .toBe('Edge 浏览器 · Windows 电脑')
    expect(describeLoginDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15'))
      .toBe('Safari 浏览器 · Mac')
    expect(describeLoginDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:140.0) Gecko/20100101 Firefox/140.0'))
      .toBe('Firefox 浏览器 · Mac')
    expect(describeLoginDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50'))
      .toBe('微信 · iPhone')
    expect(describeLoginDevice('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36'))
      .toBe('Chrome 浏览器 · 安卓手机')
  })

  it('falls back to a plain label for empty or unrecognised values', () => {
    expect(describeLoginDevice('')).toBe('其他设备')
    expect(describeLoginDevice('   ')).toBe('其他设备')
    expect(describeLoginDevice('curl/8.9.1')).toBe('其他设备')
    expect(describeLoginDevice('Mozilla/5.0 (compatible)')).toBe('浏览器')
  })
})

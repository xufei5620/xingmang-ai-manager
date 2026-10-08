import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLoginQuietPeriod,
  hasLoginLaunchArgument,
  loginLaunchArgument,
  resolveLoginLaunch,
  shouldRevealInitialWindow,
} from './login-launch'

describe('login launch', () => {
  it('recognizes the Windows login item argument only as an exact argv entry', () => {
    expect(hasLoginLaunchArgument(['C:/App/xingmang.exe', loginLaunchArgument])).toBe(true)
    expect(hasLoginLaunchArgument(['C:/App/xingmang.exe'])).toBe(false)
    expect(hasLoginLaunchArgument(['C:/App/xingmang.exe', `${loginLaunchArgument}=1`, 'xingmang://x'])).toBe(false)
    expect(hasLoginLaunchArgument([null, 3])).toBe(false)
  })

  it('treats a Windows start without the argument as the user opening the app', () => {
    expect(resolveLoginLaunch({
      platform: 'win32',
      argv: ['C:/App/xingmang.exe'],
      wasOpenedAtLogin: () => true,
    })).toBe(false)
    expect(resolveLoginLaunch({
      platform: 'win32',
      argv: ['C:/App/xingmang.exe', loginLaunchArgument],
      wasOpenedAtLogin: () => false,
    })).toBe(true)
  })

  it('reads the macOS login flag and falls back to a normal start when it cannot', () => {
    const argv = ['/Applications/星芒AI管理工具.app/Contents/MacOS/星芒AI管理工具']
    expect(resolveLoginLaunch({ platform: 'darwin', argv, wasOpenedAtLogin: () => true })).toBe(true)
    expect(resolveLoginLaunch({ platform: 'darwin', argv, wasOpenedAtLogin: () => false })).toBe(false)
    expect(resolveLoginLaunch({
      platform: 'darwin',
      argv,
      wasOpenedAtLogin: () => { throw new Error('login item service unavailable') },
    })).toBe(false)
  })

  it('never asks other platforms for a login flag', () => {
    expect(resolveLoginLaunch({
      platform: 'linux',
      argv: ['/opt/xingmang'],
      wasOpenedAtLogin: () => { throw new Error('should not be read') },
    })).toBe(false)
  })

  it('keeps the first window hidden only when the tray can bring it back', () => {
    expect(shouldRevealInitialWindow({ launchedAtLogin: true, trayAvailable: true })).toBe(false)
    expect(shouldRevealInitialWindow({ launchedAtLogin: true, trayAvailable: false })).toBe(true)
    expect(shouldRevealInitialWindow({ launchedAtLogin: false, trayAvailable: true })).toBe(true)
    expect(shouldRevealInitialWindow({ launchedAtLogin: false, trayAvailable: false })).toBe(true)
  })
})

describe('createLoginQuietPeriod', () => {
  afterEach(() => { vi.useRealTimers() })

  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false
    void promise.then(() => { done = true })
    await Promise.resolve()
    await Promise.resolve()
    return done
  }

  it('is already over when the app was not launched at login', async () => {
    const quiet = createLoginQuietPeriod({ active: false, durationMs: 1000 })
    expect(quiet.active()).toBe(false)
    expect(await settled(quiet.whenOver())).toBe(true)
  })

  it('holds background work until the window is first shown', async () => {
    vi.useFakeTimers()
    const ends: string[] = []
    const quiet = createLoginQuietPeriod({ active: true, durationMs: 180_000, onEnd: (reason) => ends.push(reason) })
    expect(quiet.active()).toBe(true)
    expect(await settled(quiet.whenOver())).toBe(false)
    quiet.end('window-shown')
    expect(quiet.active()).toBe(false)
    expect(await settled(quiet.whenOver())).toBe(true)
    vi.advanceTimersByTime(180_000)
    quiet.end('window-shown')
    expect(ends).toEqual(['window-shown'])
  })

  it('ends by itself once the quiet period has elapsed', async () => {
    vi.useFakeTimers()
    const ends: string[] = []
    const quiet = createLoginQuietPeriod({ active: true, durationMs: 180_000, onEnd: (reason) => ends.push(reason) })
    vi.advanceTimersByTime(179_999)
    expect(await settled(quiet.whenOver())).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await settled(quiet.whenOver())).toBe(true)
    expect(ends).toEqual(['timeout'])
  })
})

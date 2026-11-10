import { describe, expect, it, vi } from 'vitest'
import { createWindowsTaskbarThemeReader, parseWindowsTaskbarDark } from './windows-taskbar-theme'

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'

function output(value: string) {
  return `\r\n${KEY}\r\n    SystemUsesLightTheme    REG_DWORD    ${value}\r\n\r\n`
}

describe('windows taskbar theme', () => {
  it('reads a dark taskbar only from SystemUsesLightTheme being zero', () => {
    expect(parseWindowsTaskbarDark(output('0x0'))).toBe(true)
    expect(parseWindowsTaskbarDark(output('0x1'))).toBe(false)
    expect(parseWindowsTaskbarDark(output('0x10'))).toBe(false)
    // AppsUseLightTheme is the app mode; Windows 10 ships a dark taskbar with light apps.
    expect(parseWindowsTaskbarDark(`${KEY}\r\n    AppsUseLightTheme    REG_DWORD    0x0\r\n`)).toBeNull()
    expect(parseWindowsTaskbarDark('')).toBeNull()
  })

  it('queries the current user key through the System32 reg.exe with a minimal environment', async () => {
    const run = vi.fn(async () => output('0x0'))
    const resolveSystem32 = vi.fn(() => 'C:\\Windows\\System32')
    const read = createWindowsTaskbarThemeReader(resolveSystem32, run)
    await expect(read()).resolves.toBe(true)
    await expect(read()).resolves.toBe(true)
    expect(run).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\reg.exe',
      ['query', KEY, '/v', 'SystemUsesLightTheme'],
      { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32' },
    )
    expect(resolveSystem32).toHaveBeenCalledOnce()
  })

  it('answers null instead of throwing when the value or the system directory cannot be read', async () => {
    await expect(createWindowsTaskbarThemeReader(() => 'C:\\Windows\\System32', async () => { throw new Error('exit 1') })()).resolves.toBeNull()
    const unresolved = vi.fn(async () => output('0x0'))
    await expect(createWindowsTaskbarThemeReader(() => { throw new Error('no system root') }, unresolved)()).resolves.toBeNull()
    expect(unresolved).not.toHaveBeenCalled()
  })
})

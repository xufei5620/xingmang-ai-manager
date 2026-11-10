import { describe, expect, it, vi } from 'vitest'
import { parseWindowsTextScaleFactor, readWindowsTextScaleFactor } from './windows-text-scale'

const KEY = 'HKCU\\Software\\Microsoft\\Accessibility'

function output(value: string) {
  return `\r\n${KEY}\r\n    TextScaleFactor    REG_DWORD    ${value}\r\n\r\n`
}

describe('windows text scale', () => {
  it('reads the text size slider percentage from TextScaleFactor', () => {
    expect(parseWindowsTextScaleFactor(output('0x64'))).toBe(100)
    expect(parseWindowsTextScaleFactor(output('0x96'))).toBe(150)
    expect(parseWindowsTextScaleFactor(output('0xE1'))).toBe(225)
  })

  it('answers null for a missing value or one outside the slider range', () => {
    expect(parseWindowsTextScaleFactor('')).toBeNull()
    expect(parseWindowsTextScaleFactor(`${KEY}\r\n    ApplicationScalingFactor    REG_DWORD    0x96\r\n`)).toBeNull()
    expect(parseWindowsTextScaleFactor(output('0x63'))).toBeNull()
    expect(parseWindowsTextScaleFactor(output('0xE2'))).toBeNull()
    expect(parseWindowsTextScaleFactor(`${KEY}\r\n    TextScaleFactor    REG_SZ    150\r\n`)).toBeNull()
  })

  it('queries the current user key through the System32 reg.exe with a minimal environment', async () => {
    const run = vi.fn(async () => output('0x7d'))
    await expect(readWindowsTextScaleFactor(() => 'C:\\Windows\\System32', run)).resolves.toBe(125)
    expect(run).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\reg.exe',
      ['query', KEY, '/v', 'TextScaleFactor'],
      { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32' },
    )
  })

  it('answers null instead of throwing when the value or the system directory cannot be read', async () => {
    // reg.exe exits non-zero when the slider was never moved and the value does not exist.
    await expect(readWindowsTextScaleFactor(() => 'C:\\Windows\\System32', async () => { throw new Error('exit 1') })).resolves.toBeNull()
    const unresolved = vi.fn(async () => output('0x96'))
    await expect(readWindowsTextScaleFactor(() => { throw new Error('no system root') }, unresolved)).resolves.toBeNull()
    expect(unresolved).not.toHaveBeenCalled()
  })
})

import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveCliUserHomeDirectory } from './cli-user-home'

describe('resolveCliUserHomeDirectory', () => {
  it('uses the Windows profile folder even when HOME points somewhere else', () => {
    expect(resolveCliUserHomeDirectory({
      HOME: 'D:\\home',
      USERPROFILE: 'C:\\Users\\tester',
    }, 'win32')).toBe('C:\\Users\\tester')
  })

  it('falls back to the process home on Windows when the profile variable is missing or blank', () => {
    expect(resolveCliUserHomeDirectory({ HOME: 'D:\\home' }, 'win32')).toBe(os.homedir())
    expect(resolveCliUserHomeDirectory({ HOME: 'D:\\home', USERPROFILE: '  ' }, 'win32')).toBe(os.homedir())
  })

  it('uses HOME on macOS and Linux and ignores a stray USERPROFILE', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolveCliUserHomeDirectory({
        HOME: '/Users/tester',
        USERPROFILE: '/somewhere/else',
      }, platform)).toBe('/Users/tester')
      expect(resolveCliUserHomeDirectory({ HOME: ' ' }, platform)).toBe(os.homedir())
    }
  })
})
